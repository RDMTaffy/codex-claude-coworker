// Project-level automatic collaboration (hooks).
//
// Levels (config `autoMode`, project file overrides the global one):
//   off     — nothing happens
//   auto    — (legacy `true`) prompts get a reminder; Claude judges whether a change is big enough
//             (~50+ lines or a design decision) to run the plan/review dialogue with Astra
//   always  — no size judgment: every request that changes code goes through the dialogue, and a Stop
//             hook refuses to end a turn whose code changes GPT-6 Astra has not reviewed yet
//
// The Stop gate attributes changes from the session transcript (what Claude itself changed this turn), not
// from working-tree diffs, so the user's own edits and other sessions do not trigger it. It asks at most
// once per distinct change set and passes once a review covering those files started after the change.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { globalConfigPath } from "./config.mjs";
import { git, isGitRepo } from "./git.mjs";
import { reconcile } from "./jobs.mjs";
import { listJobs, readJson, TERMINAL_STATES, writeJsonAtomic } from "./state.mjs";

export const LEVELS = ["off", "auto", "always"];

/** Normalize stored values: false/"off" → off, true/"on"/"auto" → auto, "always" → always. */
export function normalizeLevel(value) {
  if (value === true || value === "on" || value === "auto") return "auto";
  if (value === "always") return "always";
  return "off";
}

export function readLevel(projectDir) {
  const project = readJson(path.join(projectDir, ".coworker", "config.json"));
  if (project && !project.__corrupt && project.autoMode !== undefined) return normalizeLevel(project.autoMode);
  const global = readJson(globalConfigPath());
  return normalizeLevel(global && !global.__corrupt ? global.autoMode : false);
}

function stateFile(projectDir, sessionId) {
  const safe = String(sessionId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
  return path.join(projectDir, ".coworker", "auto", `${safe}.json`);
}

function ensureIgnored(projectDir) {
  const dir = path.join(projectDir, ".coworker");
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
}

function readState(projectDir, sessionId) {
  const value = readJson(stateFile(projectDir, sessionId));
  return value && typeof value === "object" && !Array.isArray(value) && !value.__corrupt ? value : {};
}

function writeState(projectDir, sessionId, state) {
  ensureIgnored(projectDir);
  writeJsonAtomic(stateFile(projectDir, sessionId), state);
}

const INTENT = /(구현|추가|수정|고쳐|고치|리팩|변경|만들|옮겨|개선|적용|바꿔|작성해|짜줘|fix|implement|add|refactor|migrate|build|change|update|rewrite|create)/i;

const AUTO_FIRST =
  "coworker auto mode is on for this project. In this mode, code changes of roughly 50+ lines or with a design decision go through the coworker:task skill: Claude drafts a plan, GPT-6 Astra (via Codex) critiques it, Claude implements, then Astra reviews the diff over a tracked issue ledger. Questions, small edits and trivial fixes skip the dialogue, and Claude notes the skip in one line (\"Astra 협업 생략: 소규모 변경\"). The user can turn this off with /coworker:mode off.";
const AUTO_SHORT =
  "coworker auto mode is on: if this request will change ~50+ lines or involves a design choice, it goes through the coworker:task skill (plan and review dialogue with GPT-6 Astra); otherwise it is skipped with a one-line note.";
const ALWAYS_FIRST =
  "coworker always-collaborate mode is on for this project (the user chose it). Every request that changes code goes through the full coworker:task skill — Claude drafts a plan, GPT-6 Astra (via Codex) critiques it, Claude implements, then Astra reviews the diff over a tracked issue ledger — regardless of how small the change is; there is no small-change exemption and no --quick unless the user asks for it. Requests that change no code (questions, explanations) are answered normally. If a turn ends with code changes Astra has not reviewed, a Stop hook asks for a coworker:review of exactly those files. The user can switch back with /coworker:mode on or off.";
const ALWAYS_SHORT =
  "coworker always-collaborate mode is on: if this request changes any code, run it through the coworker:task skill (plan critique → implement → Astra review) regardless of size; questions are answered normally.";

/**
 * UserPromptSubmit: returns the context text to print ("" for none). Deliberately cheap: no git work, so
 * it stays far below the 5 s prompt-hook timeout on any repository.
 */
export function onPromptSubmit(input, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!projectDir) return "";
  const level = readLevel(projectDir);
  if (level === "off") return "";
  const prompt = String(input.prompt ?? "").trim();
  if (prompt.startsWith("/") || !prompt) return "";
  const markerDir = path.join(projectDir, ".coworker", "hook-sessions");
  const marker = path.join(markerDir, `${String(input.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_")}.${level}`);
  if (!fs.existsSync(marker)) {
    ensureIgnored(projectDir);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    return level === "always" ? ALWAYS_FIRST : AUTO_FIRST;
  }
  if (level === "always") return ALWAYS_SHORT;
  return prompt.length >= 15 && INTENT.test(prompt) ? AUTO_SHORT : "";
}

// ------------------------------------------------------------------ Stop gate (always mode)

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Tools that can change files without naming them: files modified while one of these was running count
// as this turn's changes (their tool_use → tool_result time window comes from the transcript).
const WINDOW_TOOLS = new Set(["Bash", "Agent", "Task", "Workflow"]);
const NON_HUMAN_ORIGINS = new Set(["peer", "auto-continuation", "channel", "compaction"]);
const TAIL_CHUNK = 4 * 1024 * 1024;
const TAIL_MAX = 256 * 1024 * 1024;

export function isRealUserPrompt(entry) {
  if (!entry || entry.type !== "user" || entry.isMeta || entry.isSidechain) return false;
  // Auto-compaction writes its summary as a user message; it is not a new request.
  if (entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false;
  if (entry.origin?.kind && NON_HUMAN_ORIGINS.has(entry.origin.kind)) return false;
  const content = entry.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return !content.some((part) => part?.type === "tool_result") && content.some((part) => part?.type === "text" || part?.type === "image");
}

/**
 * Read the transcript BACKWARDS in chunks until the last real user prompt, so the hook never loads a
 * multi-hundred-MB session into memory. Returns the entries of the current turn (oldest first) with the
 * prompt entry first, or null if no prompt is found within TAIL_MAX bytes or the file is unreadable.
 */
export function readCurrentTurn(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = size;
    let carry = Buffer.alloc(0);
    const newestFirst = [];
    while (pos > 0 && size - pos < TAIL_MAX) {
      const length = Math.min(TAIL_CHUNK, pos);
      pos -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, pos);
      const data = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let complete = data;
      carry = Buffer.alloc(0);
      if (pos > 0) {
        const firstNewline = data.indexOf(10);
        if (firstNewline === -1) {
          carry = data; // one line longer than the chunk: keep reading backwards
          continue;
        }
        carry = data.subarray(0, firstNewline + 1);
        complete = data.subarray(firstNewline + 1);
      }
      const lines = complete.toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // torn line while Claude Code is still writing
        }
        if (!entry || typeof entry !== "object") continue;
        newestFirst.push(entry);
        if (isRealUserPrompt(entry)) return newestFirst.reverse();
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * What Claude did in the current turn: files named by edit tools (with the time of the edit) and the
 * time windows of tools that may change files without naming them. A FAILED edit changed nothing and is
 * ignored; a failed Bash/Agent/… call may still have written files, so its window is kept. Background
 * launches keep their window open until the stop. `coworker` commands are not windows: they only read the
 * working tree (snapshots use a temporary index), so they cannot create changes of their own.
 */
export function turnActivity(transcriptPath) {
  const entries = readCurrentTurn(transcriptPath);
  if (!entries) return null;
  const start = entries[0];
  const uses = new Map(); // tool_use id → {name, file, at, background, command}
  const failed = new Set();
  const finished = new Map(); // tool_use id → time
  const launchedAsync = new Set();
  for (const entry of entries.slice(1)) {
    if (entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    const at = Date.parse(entry.timestamp ?? "") || Date.now();
    for (const part of entry.message.content) {
      if (entry.type === "assistant" && part?.type === "tool_use") {
        const file = part.input?.file_path ?? part.input?.notebook_path;
        uses.set(part.id ?? `${at}-${uses.size}`, {
          name: part.name,
          file: typeof file === "string" ? file : null,
          at,
          background: part.input?.run_in_background === true,
          command: typeof part.input?.command === "string" ? part.input.command : "",
        });
      } else if (entry.type === "user" && part?.type === "tool_result" && part.tool_use_id) {
        finished.set(part.tool_use_id, at);
        if (part.is_error) failed.add(part.tool_use_id);
        const result = entry.toolUseResult;
        if (result && typeof result === "object" && (result.status === "async_launched" || result.backgroundTaskId)) {
          launchedAsync.add(part.tool_use_id);
        }
      }
    }
  }
  const edits = new Map(); // abs path → last edit time (ms)
  const windows = [];
  const now = Date.now();
  for (const [id, use] of uses) {
    if (EDIT_TOOLS.has(use.name) && use.file) {
      if (failed.has(id)) continue;
      const file = path.resolve(use.file);
      edits.set(file, Math.max(edits.get(file) ?? 0, finished.get(id) ?? use.at));
    } else if (WINDOW_TOOLS.has(use.name) || String(use.name ?? "").startsWith("mcp__")) {
      if (use.name === "Bash" && COWORKER_ONLY.test(use.command)) continue;
      const open = use.background || launchedAsync.has(id) || !finished.has(id);
      windows.push([use.at - 2000, open ? now + 2000 : finished.get(id) + 2000]);
    }
  }
  const content = start.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "";
  return {
    turnKey: String(start.uuid ?? start.timestamp ?? "turn"),
    turnStart: Date.parse(start.timestamp ?? "") || 0,
    // A turn opened by a background-task notification: work finished in the background since the last
    // stop belongs to Claude too.
    fromNotification: /<task-notification>/.test(text) || start.origin?.kind === "task-notification",
    edits,
    windows,
  };
}

const COWORKER_ONLY = /^\s*(?:[\w./-]*\/)?coworker\s+(?:review|wait|ask|plan|debate|threads|jobs|status|task-state|cancel|mode)\b(?:[^;&|`$()<>]|"\$\{?CLAUDE_PROJECT_DIR\}?")*$/;

function inside(projectDir, file) {
  const rel = path.relative(projectDir, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.split(path.sep).includes(".coworker");
}

/** Canonical spelling (native realpath: resolves symlinks AND case on case-insensitive volumes). */
function safeRealpath(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file));
    } catch {
      return file;
    }
  }
}

const topCache = new Map();
/** Repository top for a path; never throws (walks up to the nearest existing directory first). */
function repoTopOf(dir) {
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
  if (topCache.has(probe)) return topCache.get(probe);
  let top = null;
  try {
    const result = git(probe, ["rev-parse", "--show-toplevel"], { allowFail: true });
    top = result.ok ? safeRealpath(result.stdout.trim()) : null;
  } catch {
    top = null;
  }
  topCache.set(probe, top);
  return top;
}

/** Uncommitted paths of one repository: {files: Map(abs → code), renamedFrom: Map(oldAbs → newAbs)}. */
function dirtyState(top) {
  const out = git(top, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true }).stdout;
  const files = new Map();
  const renamedFrom = new Map();
  const parts = out.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (item.length < 4) continue;
    const code = item.slice(0, 2);
    const abs = safeRealpath(path.join(top, item.slice(3)));
    files.set(abs, code);
    if (code[0] === "R" || code[0] === "C") {
      const source = parts[index + 1];
      if (source) renamedFrom.set(safeRealpath(path.join(top, source)), abs);
      index += 1;
    }
  }
  return { files, renamedFrom };
}

/** Commits on ANY branch of `top` since `since`: [{sha, time, root, files}] oldest first. */
export function commitsSince(top, since) {
  const log = git(top, ["log", "--all", `--since=${new Date(since - 1000).toISOString()}`, "--name-only", "-z", "--format=%x01%H %ct %P"], { allowFail: true }).stdout;
  const commits = [];
  for (const block of log.split("\x01").slice(1)) {
    const [header, ...rest] = block.split("\n");
    const [sha, time, ...parents] = header.replace(/\0/g, "").trim().split(" ");
    const names = rest.join("\n").split("\0").map((name) => name.replace(/^\n+/, "")).filter(Boolean);
    commits.push({ sha, time: Number(time) * 1000, root: parents.filter(Boolean).length === 0, top, files: names.map((name) => safeRealpath(path.join(top, name))) });
  }
  return commits.filter((commit) => commit.time >= since - 1000).reverse();
}

function isAncestorOfHead(top, sha) {
  return git(top, ["merge-base", "--is-ancestor", sha, "HEAD"], { allowFail: true }).ok;
}

/** Everything a review job covers, as absolute paths (+ whether it is an unscoped whole-diff review). */
function jobScope(job, projectDir) {
  const meta = job.meta;
  const target = meta?.target ?? {};
  const out = new Set();
  const reviewCwd = typeof meta?.reviewCwd === "string" ? meta.reviewCwd : projectDir;
  const top = typeof target.repoTop === "string" ? target.repoTop : null;
  let files = Array.isArray(target.files) ? target.files : [];
  try {
    const full = fs.readFileSync(path.join(job.dir ?? "", "target-files.txt"), "utf8");
    files = full.split("\n").filter(Boolean);
  } catch {
    // older job: meta list only
  }
  // target.files are repo-root relative (git diff --name-only); target.paths are relative to reviewCwd.
  for (const entry of files) if (typeof entry === "string") out.add(safeRealpath(path.resolve(top ?? reviewCwd, entry)));
  for (const entry of Array.isArray(target.paths) ? target.paths : []) {
    if (typeof entry === "string") out.add(safeRealpath(path.resolve(reviewCwd, entry)));
  }
  return out;
}

/** Union of all qualifying reviews (created ≥ since, succeeded or running) covers every file. */
function coveredByReviews(projectDir, since, files) {
  const remaining = new Set(files);
  for (const job of listJobs(projectDir)) {
    try {
      if (job.meta?.kind !== "review") continue;
      if (!(Date.parse(job.meta?.createdAt ?? "") >= since)) continue;
      const status = TERMINAL_STATES.has(job.status?.state) ? job.status : reconcile(projectDir, job.jobId);
      if (!status || (status.state !== "succeeded" && TERMINAL_STATES.has(status.state))) continue;
      const scope = [...jobScope({ ...job, dir: path.join(projectDir, ".coworker", "jobs", job.jobId) }, projectDir)];
      for (const file of [...remaining]) {
        if (scope.some((entry) => entry === file || file.startsWith(`${entry}${path.sep}`))) remaining.delete(file);
      }
      if (!remaining.size) return true;
    } catch {
      // one malformed job never disables the gate
    }
  }
  return remaining.size === 0;
}

function hashKey(parts) {
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
}

const MAX_BLOCKS_PER_TURN = 2;

/**
 * Stop: returns {decision: "block", reason} when the turn must not end yet, or null to let it end.
 *
 * Changes count only if Claude made them in THIS turn: files written by Edit/Write/MultiEdit/NotebookEdit,
 * files modified while a file-changing tool (Bash, Agent/Task, Workflow, MCP) was running, and commits
 * made during the turn. They pass once reviews created after the last change cover all of them. The gate
 * asks once per distinct change set and at most MAX_BLOCKS_PER_TURN times per turn, so it cannot loop.
 */
export function onStop(input, env = process.env) {
  const projectDir0 = env.CLAUDE_PROJECT_DIR || input.cwd;
  if (!projectDir0 || readLevel(projectDir0) !== "always") return null;
  const projectDir = safeRealpath(projectDir0);
  const activity = input.transcript_path ? turnActivity(input.transcript_path) : null;
  if (!activity) return null;
  const state = readState(projectDir, input.session_id);
  const now = Date.now();
  const lastStopAt = Number(state.lastStopAt) || 0;
  state.lastStopAt = now;
  if (activity.fromNotification && lastStopAt) activity.windows.push([lastStopAt - 2000, now + 2000]);

  const decision = evaluate(projectDir, activity, state);
  writeState(projectDir, input.session_id, state);
  return decision;
}

function evaluate(projectDir, activity, state) {
  const candidates = new Map(); // abs → last change time (ms)
  for (const [file, at] of activity.edits) {
    const real = safeRealpath(file);
    if (inside(projectDir, real)) candidates.set(real, Math.max(candidates.get(real) ?? 0, at));
  }

  const mainTop = isGitRepo(projectDir) ? repoTopOf(projectDir) : null;
  const committed = [];
  let foreignRepo = false;
  if (mainTop) {
    const states = new Map();
    const stateOf = (top) => {
      if (!states.has(top)) states.set(top, dirtyState(top));
      return states.get(top);
    };
    // Group edited files by their own repository (nested repos and worktrees included).
    const cleanByTop = new Map();
    for (const file of [...candidates.keys()]) {
      const top = repoTopOf(path.dirname(file)) ?? mainTop;
      if (top !== mainTop) foreignRepo = true;
      const { files, renamedFrom } = stateOf(top);
      if (files.has(file)) continue;
      const renamed = renamedFrom.get(file);
      if (renamed && inside(projectDir, renamed)) {
        candidates.set(renamed, candidates.get(file));
        candidates.delete(file);
        continue;
      }
      if (!cleanByTop.has(top)) cleanByTop.set(top, new Set());
      cleanByTop.get(top).add(file);
    }
    // Clean edited files were reverted or committed during the turn; commits inside a tool window
    // (e.g. `sed -i … && git commit -am …`) count as well.
    const tops = new Set([mainTop, ...cleanByTop.keys()]);
    for (const top of tops) {
      const clean = cleanByTop.get(top) ?? new Set();
      for (const commit of commitsSince(top, activity.turnStart)) {
        const inWindow = activity.windows.some(([from, to]) => commit.time >= from - 1000 && commit.time <= to + 1000);
        const touched = commit.files.filter((file) => inside(projectDir, file) && (clean.has(file) || inWindow));
        if (!touched.length) continue;
        committed.push(commit);
        if (top !== mainTop) foreignRepo = true;
        for (const file of touched) {
          candidates.set(file, Math.max(candidates.get(file) ?? 0, commit.time));
          clean.delete(file);
        }
      }
      for (const file of clean) candidates.delete(file);
    }
    if (activity.windows.length) {
      for (const [file, code] of stateOf(mainTop).files) {
        if (!inside(projectDir, file) || code.includes("D")) continue;
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue; // e.g. a nested repository's directory
        if (activity.windows.some(([from, to]) => stat.mtimeMs >= from && stat.mtimeMs <= to)) {
          candidates.set(file, Math.max(candidates.get(file) ?? 0, stat.mtimeMs));
        }
      }
    }
  } else {
    // Outside git: a file Claude wrote must still exist to need a review.
    for (const file of [...candidates.keys()]) if (!fs.existsSync(file)) candidates.delete(file);
  }
  if (!candidates.size) return null; // Claude changed no code in this turn

  const files = [...candidates.keys()];
  const rels = files.map((file) => path.relative(projectDir, file)).sort();
  const lastChange = Math.max(...candidates.values());
  if (coveredByReviews(projectDir, lastChange - 1000, files)) return null;

  const key = hashKey([...rels, String(Math.round(lastChange / 1000))]);
  const gatedKeys = Array.isArray(state.gatedKeys) ? state.gatedKeys.filter((entry) => typeof entry === "string") : [];
  if (gatedKeys.includes(key)) return null; // already asked once for exactly this change set
  const perTurn = state.turnBlocks && typeof state.turnBlocks === "object" && !Array.isArray(state.turnBlocks) ? state.turnBlocks : {};
  if ((perTurn[activity.turnKey] ?? 0) >= MAX_BLOCKS_PER_TURN) return null; // never loop within one turn
  state.gatedKeys = [...gatedKeys, key].slice(-50);
  state.turnBlocks = Object.fromEntries([...Object.entries(perTurn).slice(-20), [activity.turnKey, (perTurn[activity.turnKey] ?? 0) + 1]]);
  state.lastGateAt = new Date().toISOString();

  const thread = `gate-${key.slice(0, 8)}`;
  const workDir = path.join(projectDir, ".coworker", "work", thread);
  fs.mkdirSync(workDir, { recursive: true });
  const pathsFile = path.join(workDir, "paths.txt");
  fs.writeFileSync(pathsFile, `${rels.join("\n")}\n`);
  const pathsRel = path.relative(projectDir, pathsFile);

  let target;
  const reachable = committed.length && committed.every((commit) => commit.top === mainTop && !commit.root && isAncestorOfHead(mainTop, commit.sha));
  if (committed.length && reachable && !foreignRepo) {
    const oldest = committed.reduce((a, b) => (a.time <= b.time ? a : b));
    target = `some changes were committed during the turn — review everything since then with \`--base ${oldest.sha.slice(0, 12)}^\``;
  } else if (mainTop && !foreignRepo && !committed.length) {
    target = `review exactly these files: \`--uncommitted --paths-file ${pathsRel}\``;
  } else {
    target = `review exactly these files: \`--paths-file ${pathsRel}\``;
  }
  const listed = rels.slice(0, 15).join(", ") + (rels.length > 15 ? `, … (${rels.length} files; full list in ${pathsRel})` : "");
  return {
    decision: "block",
    reason:
      `coworker always-collaborate mode is on for this project: code Claude changes is reviewed by GPT-6 Astra before the turn ends. ` +
      `In this turn Claude changed ${rels.length} file(s): ${listed} — and no Astra review covering them has run since. ` +
      `Run the coworker:review skill now with \`--fix\` in a NEW thread named \`${thread}\`; ${target}. ` +
      "Follow its protocol (verify each finding, fix or dispute with evidence, re-review), then give the user the summary in their language. " +
      "Do not skip it because the change is small; the user chose always-collaborate mode.",
  };
}
