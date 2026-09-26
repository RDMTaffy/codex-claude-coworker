// Always-collaborate mode (`coworker mode always`, config autoMode: "always").
//
// Drives the real CLI the way Claude Code does — `node scripts/coworker.mjs hook prompt-submit|stop` with the
// hook payload JSON on stdin and CLAUDE_PROJECT_DIR in the environment (hooks/hooks.json, exec form) — plus
// `coworker mode …`, and imports scripts/lib/auto.mjs directly where a tight loop is cheaper.
//
// The Stop gate (v4) attributes changes from the session TRANSCRIPT (what Claude itself did since the last real
// user prompt), so these tests write synthetic transcripts shaped like real Claude Code JSONL (queue-operation
// / user / attachment / assistant tool_use / user tool_result / system lines, uuid + parentUuid chains,
// promptId, wireToolInputs, …) and change the files on disk to match:
//   * Edit/Write/MultiEdit/NotebookEdit name their file (time = the tool_result line; FAILED edits ignored);
//   * Bash/Agent/Task/Workflow/mcp__* open a [tool_use − 2 s, tool_result + 2 s] window (failed calls keep it;
//     background launches and unfinished calls keep it open until the stop + 2 s; a Bash call that only runs
//     `coworker review|wait|…` without shell metacharacters opens none): dirty files whose mtime lies inside a
//     window count too, so tests that change files "through Bash" write them INSIDE the window (ctx.during)
//     with real clock timestamps; a turn opened by a <task-notification> adds [lastStopAt − 2 s, now + 2 s];
//   * commits during the turn (`git log --all`, per repository, nested repos/worktrees included) count when
//     they touch an edited-but-now-clean file or were made inside a tool window;
//   * every always-mode stop records state.lastStopAt; the gate asks once per change set (sha1 of the sorted
//     paths + last change second → state.gatedKeys) and at most twice per turn (state.turnBlocks[prompt
//     uuid]), names a NEW thread gate-<key8> and writes every path to .coworker/work/gate-<key8>/paths.txt;
//   * the hint is `--base <oldest sha12>^` (commits, all reachable, main repo), `--uncommitted --paths-file F`
//     (main repo, nothing committed) or `--paths-file F` (everything else);
//   * it passes once the UNION of review jobs created ≥ last change − 1 s that succeeded or are still running
//     covers every candidate (scope = the job's target-files.txt, else meta.target.files, + target.paths).
//
//   node --test tests/always.test.mjs
//
// Isolation: every test gets its own temp dir (git repo, transcripts, XDG_CONFIG_HOME, XDG_CACHE_HOME, TMPDIR,
// a private GIT_CONFIG_GLOBAL, GIT_CEILING_DIRECTORIES at the temp root); CLAUDE_PROJECT_DIR, COWORKER_* and
// GIT_* are scrubbed from the inherited environment. Temp root: $COWORKER_TEST_TMPDIR (default os.tmpdir());
// set COWORKER_TEST_KEEP=1 to keep it, COWORKER_TEST_HEAVY=1 to run the >512 MB transcript probe. A still-open
// defect is marked { todo: "BUG: …" }: it runs and is reported without failing the suite.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "coworker.mjs");
const FAKE = path.join(HERE, "fixtures", "fake-codex.mjs");

// ------------------------------------------------------------------ temp root + process isolation

function makeBase() {
  const requested = process.env.COWORKER_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(requested, { recursive: true });
  const real = fs.realpathSync(requested);
  for (const forbidden of [PLUGIN_ROOT, MARKETPLACE_ROOT]) {
    if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`Refusing to create test repos inside ${forbidden}; set COWORKER_TEST_TMPDIR elsewhere.`);
    }
  }
  return fs.realpathSync(fs.mkdtempSync(path.join(real, "coworker-always-")));
}

const BASE = makeBase();
const HEAVY = process.env.COWORKER_TEST_HEAVY === "1";
const GITCONFIG_TEXT = "[user]\n\tname = Coworker Test\n\temail = coworker-test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n";

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(COWORKER_|FAKE_CODEX_|XDG_|GIT_|NODE_TEST)/.test(key) || ["CLAUDE_PROJECT_DIR", "BASH_MAX_TIMEOUT_MS", "NODE_OPTIONS", "TMPDIR"].includes(key)) {
      delete env[key];
    }
  }
  return env;
}

function withOverrides(base, extra = {}) {
  const env = { ...base, ...extra };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
}

// The directly imported modules read process.env (global config path, git config, os.tmpdir()), so isolate
// this test process before importing them.
const PROC = path.join(BASE, "_proc");
for (const sub of ["xdg-config", "xdg-cache", "tmp"]) fs.mkdirSync(path.join(PROC, sub), { recursive: true });
fs.writeFileSync(path.join(PROC, "gitconfig"), GITCONFIG_TEXT);
const PROC_ENV = withOverrides(cleanEnv(), {
  XDG_CONFIG_HOME: path.join(PROC, "xdg-config"),
  XDG_CACHE_HOME: path.join(PROC, "xdg-cache"),
  TMPDIR: path.join(PROC, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(PROC, "gitconfig"),
  GIT_CEILING_DIRECTORIES: BASE,
});
for (const key of Object.keys(process.env)) if (!(key in PROC_ENV)) delete process.env[key];
Object.assign(process.env, PROC_ENV);

const lib = (name) => import(pathToFileURL(path.join(PLUGIN_ROOT, "scripts", "lib", name)).href);
const auto = await lib("auto.mjs");
const { loadConfig } = await lib("config.mjs");

after(() => {
  if (process.env.COWORKER_TEST_KEEP !== "1") fs.rmSync(BASE, { recursive: true, force: true });
});

// ------------------------------------------------------------------ constants mirrored from auto.mjs

const ALWAYS_FIRST = /^coworker always-collaborate mode is on for this project \(the user chose it\)/;
const ALWAYS_SHORT = /^coworker always-collaborate mode is on: if this request changes any code/;
const AUTO_FIRST = /^coworker auto mode is on for this project/;
const AUTO_SHORT = /^coworker auto mode is on: if this request/;
const REASON =
  /^coworker always-collaborate mode is on for this project: code Claude changes is reviewed by GPT-6 Astra before the turn ends\. In this turn Claude changed (\d+) file\(s\): (.*) — and no Astra review covering them has run since\. Run the coworker:review skill now with `--fix` in a NEW thread named `(gate-[0-9a-f]{8})`; (.*)\. Follow its protocol \(verify each finding, fix or dispute with evidence, re-review\), then give the user the summary in their language\. Do not skip it because the change is small; the user chose always-collaborate mode\.$/s;
const TRUNCATED = /^(.*), … \((\d+) files; full list in (.+)\)$/s;
const TERMINAL = ["succeeded", "invalid_output", "failed", "cancelled", "timed_out", "session_lost", "start_failed", "crashed", "interrupted"];

// ------------------------------------------------------------------ helpers

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const tryJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const tryText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const hex = (bytes) => crypto.randomBytes(bytes).toString("hex");
const iso = (ms) => new Date(ms).toISOString();
const sorted = (list) => [...list].sort();

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function killTree(pid) {
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).stdout ?? "";
  const children = new Map();
  for (const line of listing.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !parent) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(child);
  }
  const stack = [pid];
  while (stack.length) {
    const current = stack.pop();
    stack.push(...(children.get(current) ?? []));
    try {
      process.kill(current, "SIGKILL");
    } catch {
      // gone
    }
  }
}

function setMtime(file, ms) {
  const seconds = ms / 1000;
  fs.utimesSync(file, seconds, seconds);
}

/** The gate's change-set key: sha1(sorted project-relative paths + last change in whole seconds), 12 hex. */
function gateKey(files, lastChangeMs) {
  return crypto.createHash("sha1").update([...sorted(files), String(Math.round(lastChangeMs / 1000))].join("\n")).digest("hex").slice(0, 12);
}

/**
 * meta.target of a review as startTurn records it: paths are relative to reviewCwd, files are what
 * `git diff --name-only` listed (repo-root relative; meta keeps the first 200, fileCount has the total, the
 * full list goes to <jobDir>/target-files.txt) and repoTop is set for the git modes (they have a base/head).
 */
function reviewTarget(paths, { mode = "uncommitted", files = paths, repoTop = null } = {}) {
  return {
    mode,
    paths,
    label: `files: ${paths.join(", ")}`,
    live: mode !== "paths" && mode !== "commit",
    files: files.slice(0, 200),
    fileCount: files.length,
    repoTop: mode === "paths" ? null : repoTop,
  };
}

function gitTopOf(dir, env) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, env, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function reviewResult(over = {}) {
  return {
    verdict: "approve",
    assessment: "complete",
    summary: "Looks fine.",
    coverage: { reviewed: ["src/app.js"], not_reviewed: [] },
    limitations: [],
    prior: [],
    findings: [],
    questions: [],
    ...over,
  };
}

// ------------------------------------------------------------------ synthetic Claude Code transcripts

const CC_VERSION = "2.1.300";
const USAGE = { input_tokens: 2, cache_creation_input_tokens: 812, cache_read_input_tokens: 40211, output_tokens: 311, service_tier: "standard" };
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Appends JSONL lines shaped like a real ~/.claude/projects/<slug>/<session>.jsonl. Timestamps come from an
 * internal clock (default: two minutes ago, +400 ms per entry) so turn starts, edit times and review job
 * creation times are deterministic; pass {at} to pin one.
 */
class Transcript {
  constructor(file, { sessionId, cwd, start = Date.now() - 120_000 } = {}) {
    this.file = file;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.clock = start;
    this.parent = null;
    this.promptId = null;
    this.turn = null;
    this.lastChangeAt = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  }

  stamp(at) {
    this.clock = at ?? this.clock + 400;
    return iso(this.clock);
  }

  raw(text) {
    fs.appendFileSync(this.file, text);
  }

  append(entry) {
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    if (entry.uuid && !entry.isSidechain) this.parent = entry.uuid;
    return entry;
  }

  common(extra = {}) {
    return { parentUuid: this.parent, isSidechain: false, userType: "external", entrypoint: "cli", cwd: this.cwd, sessionId: this.sessionId, version: CC_VERSION, gitBranch: "main", ...extra };
  }

  /** A real (human) prompt: queue-operation pair, the user line, then hook/attachment/bookkeeping lines. */
  prompt(text, { at, content, extra = {} } = {}) {
    const timestamp = this.stamp(at);
    this.promptId = crypto.randomUUID();
    this.append({ type: "queue-operation", operation: "enqueue", timestamp, sessionId: this.sessionId, content: typeof text === "string" ? text : "" });
    this.append({ type: "queue-operation", operation: "dequeue", timestamp, sessionId: this.sessionId });
    const entry = this.append({
      ...this.common(),
      promptId: this.promptId,
      type: "user",
      message: { role: "user", content: content ?? text },
      uuid: crypto.randomUUID(),
      timestamp,
      permissionMode: "default",
      origin: { kind: "human" },
      promptSource: "sdk",
      turnOrigin: "human",
      ...extra,
    });
    this.attachment({ type: "hook_success", hookName: "UserPromptSubmit", hookEvent: "UserPromptSubmit", toolUseID: crypto.randomUUID(), content: "", stdout: "", stderr: "", exitCode: 0 });
    this.attachment({ type: "total_tokens_reminder", text: "<total_tokens>15000000 tokens left</total_tokens>" });
    this.append({ type: "last-prompt", lastPrompt: typeof text === "string" ? text.slice(0, 200) : "", leafUuid: entry.uuid, sessionId: this.sessionId });
    this.append({ type: "file-history-snapshot", messageId: entry.uuid, snapshot: { messageId: entry.uuid, trackedFileBackups: {}, timestamp }, isSnapshotUpdate: false });
    this.turn = entry;
    return entry;
  }

  /** Any user-type line (meta, sidechain, task notification, compact summary, …). */
  userLine(content, extra = {}, { at } = {}) {
    return this.append({ ...this.common({ isSidechain: Boolean(extra.isSidechain) }), promptId: this.promptId, type: "user", message: { role: "user", content }, uuid: crypto.randomUUID(), timestamp: this.stamp(at), ...extra });
  }

  meta(content, extra = {}) {
    return this.userLine(content, { isMeta: true, ...extra });
  }

  attachment(attachment) {
    return this.append({ ...this.common(), type: "attachment", attachment, uuid: crypto.randomUUID(), timestamp: this.stamp(this.clock + 5) });
  }

  system(subtype, extra = {}) {
    return this.append({ ...this.common(), type: "system", subtype, level: "info", uuid: crypto.randomUUID(), timestamp: this.stamp(this.clock + 5), ...extra });
  }

  assistant(content, { at, sidechain = false, extra = {} } = {}) {
    return this.append({
      ...this.common({ isSidechain: sidechain, ...(sidechain ? { agentId: `a${hex(8)}` } : {}) }),
      message: {
        model: "claude-opus-5-5",
        id: `msg_01${hex(11)}`,
        type: "message",
        role: "assistant",
        content,
        container: null,
        stop_reason: content.some((part) => part.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: USAGE,
      },
      requestId: `req_011${hex(10)}`,
      type: "assistant",
      uuid: crypto.randomUUID(),
      timestamp: this.stamp(at),
      effort: "high",
      ...extra,
    });
  }

  think(text = "Let me look at this.") {
    return this.assistant([{ type: "thinking", thinking: text, signature: hex(24) }]);
  }

  say(text) {
    return this.assistant([{ type: "text", text }]);
  }

  /** The assistant tool_use line alone; returns {id, entry, name, sidechain} for toolResult(). */
  toolUse(name, input, { at, sidechain = false } = {}) {
    const id = `toolu_01${hex(11)}`;
    const entry = this.assistant([{ type: "tool_use", id, name, input, caller: { type: "direct" } }], { at, sidechain, extra: { wireToolInputs: { [id]: input } } });
    return { id, entry, name, sidechain };
  }

  /**
   * The user tool_result line for a toolUse(). Tracks lastChangeAt = the time the gate uses for an edit tool
   * (its tool_result line; failed calls do not count).
   */
  toolResult(use, result = "ok", { at, isError = false, toolUseResult } = {}) {
    const line = this.append({
      ...this.common({ isSidechain: use.sidechain }),
      promptId: this.promptId,
      type: "user",
      message: { role: "user", content: [{ tool_use_id: use.id, type: "tool_result", content: result, ...(isError ? { is_error: true } : {}) }] },
      uuid: crypto.randomUUID(),
      timestamp: this.stamp(at ?? this.clock + 60),
      toolUseResult: toolUseResult ?? (isError ? `Error: ${result}` : { stdout: String(result), stderr: "", interrupted: false, isImage: false }),
      sourceToolAssistantUUID: use.entry.uuid,
    });
    if (EDIT_TOOLS.has(use.name) && !use.sidechain && !isError) this.lastChangeAt = Date.parse(line.timestamp);
    return line;
  }

  /** assistant tool_use line + the user tool_result line (result: null = no result line). */
  tool(name, input, { at, sidechain = false, result = "ok", isError = false, toolUseResult } = {}) {
    const use = this.toolUse(name, input, { at, sidechain });
    if (result !== null) this.toolResult(use, result, { isError, toolUseResult });
    else if (EDIT_TOOLS.has(name) && !sidechain) this.lastChangeAt = Date.parse(use.entry.timestamp);
    return use.entry;
  }

  bash(command, opts) {
    return this.tool("Bash", { command, description: "Run a command" }, opts);
  }

  read(file, opts) {
    return this.tool("Read", { file_path: file }, { result: "1\tcontent", ...opts });
  }

  /** The bookkeeping Claude Code writes when a turn ends (Stop hooks ran, turn duration). */
  endTurn(text = "Done.") {
    this.say(text);
    this.system("stop_hook_summary", { hookCount: 1, hookInfos: [{ command: "node coworker.mjs hook stop", durationMs: 80 }], hookErrors: [], preventedContinuation: false, stopReason: "", hasOutput: false });
    this.system("turn_duration", { durationMs: 4200 });
  }
}

function toolInput(tool, file, content) {
  switch (tool) {
    case "Write":
      return { file_path: file, content };
    case "MultiEdit":
      return { file_path: file, edits: [{ old_string: "a", new_string: "b", replace_all: false }, { old_string: "c", new_string: "d", replace_all: false }] };
    case "NotebookEdit":
      return { notebook_path: file, cell_id: "cell-1", new_source: "print(1)", cell_type: "code", edit_mode: "replace" };
    default:
      return { replace_all: false, file_path: file, old_string: "old", new_string: "new" };
  }
}

// ------------------------------------------------------------------ sandbox

let counter = 0;

/**
 * Fresh sandbox: <BASE>/<nn-name>/{repo, transcripts, xdg-config, xdg-cache, tmp, gitconfig}. `repo` is a git
 * repo with one commit unless {git: false} (plain dir) or {commit: false} (unborn HEAD).
 */
function sandbox(t, { git = true, commit = true } = {}) {
  counter += 1;
  const dir = path.join(BASE, `${String(counter).padStart(2, "0")}-${slug(t.name)}`);
  const repo = path.join(dir, "repo");
  const config = path.join(dir, "xdg-config");
  const cache = path.join(dir, "xdg-cache");
  const tmp = path.join(dir, "tmp");
  for (const sub of [repo, config, cache, tmp]) fs.mkdirSync(sub, { recursive: true });
  const gitconfig = path.join(dir, "gitconfig");
  fs.writeFileSync(gitconfig, GITCONFIG_TEXT);
  const baseEnv = withOverrides(cleanEnv(), {
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    TMPDIR: tmp,
    CODEX_HOME: path.join(dir, "codex-home"),
    COWORKER_CODEX_BIN: FAKE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CEILING_DIRECTORIES: BASE,
  });
  const pids = [];

  const ctx = {
    dir,
    repo,
    config,
    baseEnv,
    trackPid: (pid) => pids.push(pid),
    git(args, { cwd = repo, env } = {}) {
      const result = spawnSync("git", args, { cwd, env: withOverrides(baseEnv, env), encoding: "utf8" });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout;
    },
    write(rel, content, root = repo) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    rm(rel, root = repo) {
      fs.rmSync(path.join(root, rel), { recursive: true, force: true });
    },
    /**
     * Commit everything. Setup commits are backdated one hour so they are clearly older than any synthetic
     * turn start; pass {during: true} for a commit Claude makes inside the turn (real "now").
     */
    commitAll(message = "wip", { env, cwd = repo, during = false } = {}) {
      const past = iso(Date.now() - 3_600_000);
      const dates = during ? {} : { GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past };
      ctx.git(["add", "-A"], { cwd, env: { ...dates, ...env } });
      ctx.git(["commit", "-q", "-m", message], { cwd, env: { ...dates, ...env } });
      return ctx.git(["rev-parse", "HEAD"], { cwd }).trim();
    },
    /** Committer time of `rev` in ms (a committed file's last change is its newest commit of the turn). */
    commitTime(rev = "HEAD", { cwd = repo } = {}) {
      return Number(ctx.git(["log", "-1", "--format=%ct", rev], { cwd }).trim()) * 1000;
    },
    /** Write the project config the way `coworker mode` leaves it (.coworker/.gitignore included). */
    setLevel(value, { projectDir = repo, extra = {} } = {}) {
      const dirPath = path.join(projectDir, ".coworker");
      fs.mkdirSync(dirPath, { recursive: true });
      if (!fs.existsSync(path.join(dirPath, ".gitignore"))) fs.writeFileSync(path.join(dirPath, ".gitignore"), "*\n");
      fs.writeFileSync(path.join(dirPath, "config.json"), JSON.stringify(value === undefined ? extra : { ...extra, autoMode: value }));
    },
    setGlobalLevel(value) {
      fs.mkdirSync(path.join(config, "coworker"), { recursive: true });
      fs.writeFileSync(path.join(config, "coworker", "config.json"), JSON.stringify(value === undefined ? {} : { autoMode: value }));
    },
    projectConfig: (projectDir = repo) => path.join(projectDir, ".coworker", "config.json"),
    globalConfig: () => path.join(config, "coworker", "config.json"),
    state: (session = "sess-1", projectDir = repo) => tryJson(path.join(projectDir, ".coworker", "auto", `${session}.json`)),
    writeState: (session, value, projectDir = repo) => {
      const file = path.join(projectDir, ".coworker", "auto", `${session}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    },
    writeThread(name, meta, projectDir = repo) {
      const file = path.join(projectDir, ".coworker", "threads", `${name}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(meta));
    },
    /** A job dir as launchJob leaves it: meta.json (kind, createdAt, …) + status.json. */
    writeJob({ kind = "review", createdAt, status, meta = {}, jobId, projectDir = repo }) {
      const id = jobId ?? `20260926-100000-${kind}-${hex(4)}`;
      const dirPath = path.join(projectDir, ".coworker", "jobs", id);
      fs.mkdirSync(dirPath, { recursive: true });
      if (status !== undefined) fs.writeFileSync(path.join(dirPath, "status.json"), typeof status === "string" ? status : JSON.stringify({ jobId: id, ...status }));
      if (meta !== null) {
        const value = typeof meta === "string" ? meta : JSON.stringify({ jobId: id, jobDir: dirPath, projectRoot: projectDir, thread: `t-${kind}`, kind, ...(createdAt === undefined ? {} : { createdAt: iso(createdAt) }), ...meta });
        fs.writeFileSync(path.join(dirPath, "meta.json"), value);
      }
      return id;
    },
    /**
     * A review job shaped like a real one: meta.target covers `paths` (relative to reviewCwd = the project) and
     * `files` (what git diff listed, repo-root relative); target-files.txt holds the FULL `files` list (pass
     * {targetFiles: null} for an older job without it, or a list to make it differ from meta); repoTop defaults
     * to the project's git top level for the git modes.
     */
    writeReview({ paths, files = paths, mode = "uncommitted", createdAt, status = { state: "succeeded" }, jobId, projectDir = repo, meta = {}, repoTop, targetFiles = files }) {
      const top = repoTop !== undefined ? repoTop : mode === "paths" ? null : gitTopOf(projectDir, baseEnv);
      const id = ctx.writeJob({ kind: "review", createdAt, status, jobId, projectDir, meta: { target: reviewTarget(paths, { mode, files, repoTop: top }), reviewCwd: projectDir, ...meta } });
      if (targetFiles !== null) fs.writeFileSync(path.join(projectDir, ".coworker", "jobs", id, "target-files.txt"), `${targetFiles.join("\n")}\n`);
      return id;
    },
    jobStatus: (jobId, projectDir = repo) => tryJson(path.join(projectDir, ".coworker", "jobs", jobId, "status.json")),
    clearJobs: (projectDir = repo) => fs.rmSync(path.join(projectDir, ".coworker", "jobs"), { recursive: true, force: true }),
    transcript({ session = "sess-1", start, cwd = repo, file } = {}) {
      return new Transcript(file ?? path.join(dir, "transcripts", `${session}.jsonl`), { sessionId: session, cwd, start });
    },
    /**
     * Claude changes a file with an edit tool: the file is written on disk and the tool_use/tool_result pair is
     * appended to the transcript with the absolute path.
     */
    claude(tr, tool, rel, { content, root = repo, at, file, onDisk = true, result, isError } = {}) {
      const abs = file ?? path.join(root, rel);
      const text = content ?? `// ${tool} ${hex(6)}\n`;
      if (onDisk) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, tool === "NotebookEdit" ? JSON.stringify({ cells: [{ source: text }], nbformat: 4 }) : text);
      }
      tr.tool(tool, toolInput(tool, abs, text), { at, isError, result: result ?? (tool === "Write" ? `File created successfully at: ${abs}` : `The file ${abs} has been updated successfully.`) });
      return abs;
    },
    /**
     * A window tool (Bash, Agent, Task, Workflow, mcp__*) that changes files without naming them: the tool_use
     * line is stamped with the REAL clock, `fn` changes files on disk while the tool "runs", then the
     * tool_result line is stamped with the real clock again — so the files' mtimes fall inside the window.
     */
    during(tr, name, input, fn = () => {}, { result = "ok", isError = false, toolUseResult } = {}) {
      const use = tr.toolUse(name, typeof input === "string" ? { command: input, description: "Run a command" } : input, { at: Math.max(Date.now(), tr.clock + 1) });
      fn();
      tr.toolResult(use, result, { at: Math.max(Date.now(), tr.clock + 1), isError, toolUseResult });
      return use;
    },
    cli(args, { env, input, timeout = 120000, cwd = repo } = {}) {
      const started = Date.now();
      const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: withOverrides(baseEnv, env), input, encoding: "utf8", timeout });
      const out = { code: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - started };
      out.dump = () => `coworker ${args.join(" ")}\nexit=${out.code} signal=${out.signal} (${out.ms}ms)\n--- stdout\n${out.stdout.slice(-3000)}\n--- stderr\n${out.stderr.slice(-3000)}`;
      return out;
    },
    /** `node coworker.mjs hook <event>` exactly as hooks/hooks.json runs it. */
    hook(event, payload, { raw, env, projectDir = repo, cwd } = {}) {
      const started = Date.now();
      const result = spawnSync(process.execPath, [CLI, "hook", event], {
        cwd: cwd ?? (fs.existsSync(projectDir) ? projectDir : repo),
        env: withOverrides(baseEnv, { CLAUDE_PROJECT_DIR: projectDir, ...env }),
        input: raw ?? JSON.stringify(payload),
        encoding: "utf8",
        timeout: 30000,
      });
      const out = { code: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - started };
      out.dump = () => `hook ${event}\nexit=${out.code} signal=${out.signal} (${out.ms}ms)\n--- stdout\n${out.stdout}\n--- stderr\n${out.stderr}`;
      return out;
    },
    submit(prompt, { session = "sess-1", projectDir = repo, env, cwd } = {}) {
      return ctx.hook(
        "prompt-submit",
        { session_id: session, transcript_path: path.join(dir, "transcripts", `${session}.jsonl`), cwd: cwd ?? projectDir, permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt },
        { projectDir, env },
      );
    },
    /** The Stop hook. `transcript` (a Transcript) or `transcriptPath` (string | null to omit the field). */
    stop({ session = "sess-1", transcript, transcriptPath, active = false, projectDir = repo, env, cwd } = {}) {
      const payload = { session_id: session, cwd: cwd ?? projectDir, permission_mode: "default", hook_event_name: "Stop", stop_hook_active: active };
      const file = transcriptPath !== undefined ? transcriptPath : transcript ? transcript.file : path.join(dir, "transcripts", `${session}.jsonl`);
      if (file !== null) payload.transcript_path = file;
      const r = ctx.hook("stop", payload, { projectDir, env });
      r.decision = parseDecision(r);
      r.projectDir = projectDir;
      r.session = session;
      return r;
    },
  };

  if (git) {
    ctx.git(["init", "-q"]);
    if (commit) {
      ctx.write("README.md", "# sandbox\n");
      ctx.commitAll("init");
    }
  }

  t.after(() => {
    for (const pid of pids) if (isAlive(pid)) killTree(pid);
    const jobs = path.join(repo, ".coworker", "jobs");
    for (const jobId of fs.existsSync(jobs) ? fs.readdirSync(jobs) : []) {
      const status = tryJson(path.join(jobs, jobId, "status.json"));
      for (const pid of [status?.codexPid, status?.supervisorPid]) {
        if (!pid || !isAlive(pid)) continue;
        const command = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "";
        if (command.includes(jobId)) killTree(pid);
      }
    }
  });
  return ctx;
}

/** The Stop hook's stdout is either empty (allow) or exactly one line of JSON (block). */
function parseDecision(r) {
  const text = r.stdout.trim();
  if (!text) return null;
  const lines = text.split("\n");
  assert.equal(lines.length, 1, `stop hook printed more than one line:\n${r.stdout}`);
  let parsed;
  assert.doesNotThrow(() => {
    parsed = JSON.parse(lines[0]);
  }, `stop hook output is not valid JSON:\n${r.stdout}`);
  return parsed;
}

function assertAllowed(r, why = "") {
  assert.equal(r.code, 0, r.dump());
  assert.equal(r.stdout, "", `expected the stop to be allowed${why ? ` (${why})` : ""}\n${r.dump()}`);
  assert.equal(r.stderr, "", `hooks must be silent on stderr\n${r.dump()}`);
}

/**
 * Parse a block reason: {count, listed, truncated, fullListIn, thread, hint, target, pathsFile, base, args}.
 * `target` is "committed" (`--base <oldest sha12>^`: commits of the turn, all in the main repo, non-root and
 * reachable from HEAD — covers everything since, dirty files included), "uncommitted" (`--uncommitted
 * --paths-file F`: main repo, nothing committed) or "paths" (`--paths-file F`: every other case — the files'
 * current content). `args` are the review flags that run it. The per-commit `--commit` hint no longer exists.
 */
function parseReason(reason) {
  const m = reason.match(REASON);
  assert.ok(m, `unexpected block reason:\n${reason}`);
  const [, count, listedText, thread, hint] = m;
  const cut = listedText.match(TRUNCATED);
  const out = {
    count: Number(count),
    truncated: Boolean(cut),
    fullListIn: cut ? cut[3] : null,
    listed: (cut ? cut[1] : listedText).split(", "),
    thread,
    hint,
    target: null,
    pathsFile: null,
    base: null,
    args: null,
  };
  if (cut) assert.equal(Number(cut[2]), out.count, "the truncation note repeats the file count");
  assert.doesNotMatch(hint, /--commit\b/, "v4 never asks for per-commit reviews");
  let h;
  if ((h = hint.match(/^some changes were committed during the turn — review everything since then with `--base ([0-9a-f]{12})\^`$/))) {
    out.target = "committed";
    out.base = h[1];
    out.args = ["--base", `${h[1]}^`];
  } else if ((h = hint.match(/^review exactly these files: `--uncommitted --paths-file ([^`]+)`$/))) {
    out.target = "uncommitted";
    out.pathsFile = h[1];
    out.args = ["--uncommitted", "--paths-file", h[1]];
  } else if ((h = hint.match(/^review exactly these files: `--paths-file ([^`]+)`$/))) {
    out.target = "paths";
    out.pathsFile = h[1];
    out.args = ["--paths-file", h[1]];
  } else {
    assert.fail(`unknown review target hint: ${hint}`);
  }
  return out;
}

/** The paths file the gate wrote for a thread (project relative in the reason). */
const pathsFileRel = (thread) => path.join(".coworker", "work", thread, "paths.txt");

/**
 * Asserts a block and that the reason names exactly `files` (project-relative, any order) with the given
 * target ("uncommitted" | "paths" | "committed"). Also checks the paths file lists every file (sorted, one
 * per line), the listed names are the first 15 of that sorted list, the state records the key, a turn block
 * and lastStopAt, and — given the time of the last change — that the thread is gate-<key8> of this change set.
 */
function assertBlocked(r, { files, target = "uncommitted", lastChange } = {}) {
  assert.equal(r.code, 0, `a blocking Stop hook must exit 0 with JSON\n${r.dump()}`);
  assert.equal(r.stderr, "", r.dump());
  assert.ok(r.decision, `expected a block decision\n${r.dump()}`);
  assert.deepEqual(Object.keys(r.decision).sort(), ["decision", "reason"]);
  assert.equal(r.decision.decision, "block");
  assert.ok(r.stdout.endsWith("\n"));
  const got = parseReason(r.decision.reason);
  const listFile = path.join(r.projectDir, pathsFileRel(got.thread));
  got.pathsFileContent = fs.existsSync(listFile) ? fs.readFileSync(listFile, "utf8") : null;
  assert.ok(got.pathsFileContent !== null, `the gate must write ${listFile}\n${r.decision.reason}`);
  const all = got.pathsFileContent.split("\n");
  assert.equal(all.pop(), "", "the paths file ends with a newline");
  got.all = all;
  assert.deepEqual(all, sorted(all), "the paths file is sorted");
  assert.equal(got.count, all.length, "the count matches the paths file");
  assert.deepEqual(got.listed, all.slice(0, 15), "the reason lists the first 15 paths of the (sorted) paths file");
  assert.equal(got.truncated, all.length > 15, "the list is truncated exactly when there are more than 15 files");
  if (got.truncated) assert.equal(got.fullListIn, pathsFileRel(got.thread));
  if (got.pathsFile) assert.equal(got.pathsFile, pathsFileRel(got.thread), "the --paths-file hint names the gate's paths file");
  if (files) assert.deepEqual(all, sorted(files), r.decision.reason);
  if (target) assert.equal(got.target, target, r.decision.reason);
  const state = ctxState(r);
  if (state) {
    assert.ok(state.gatedKeys?.some((key) => `gate-${key.slice(0, 8)}` === got.thread), `state.gatedKeys records ${got.thread}: ${JSON.stringify(state.gatedKeys)}`);
    assert.ok(Object.values(state.turnBlocks ?? {}).some((n) => n >= 1 && n <= 2), `state.turnBlocks counts the block: ${JSON.stringify(state.turnBlocks)}`);
    assert.ok(Number.isFinite(state.lastStopAt), `state.lastStopAt is recorded: ${JSON.stringify(state)}`);
  }
  if (lastChange !== undefined) {
    assert.equal(got.thread, `gate-${gateKey(all, lastChange).slice(0, 8)}`, `thread for change set ${JSON.stringify(all)} @ ${iso(lastChange)}`);
  }
  return got;
}

function ctxState(r) {
  if (!r.projectDir || !r.session) return null;
  const safe = String(r.session).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
  return tryJson(path.join(r.projectDir, ".coworker", "auto", `${safe}.json`));
}

/**
 * An allowed always-mode stop in a session that was never gated: the state holds ONLY lastStopAt (v4 writes
 * it on every stop) — no gatedKeys, turnBlocks or lastGateAt.
 */
function assertOnlyLastStop(ctx, { session = "sess-1", projectDir = ctx.repo, since = 0 } = {}) {
  const state = ctx.state(session, projectDir);
  assert.ok(state, `an always-mode stop records lastStopAt (session ${session})`);
  assert.deepEqual(Object.keys(state), ["lastStopAt"], `an allowed stop records no gate: ${JSON.stringify(state)}`);
  assert.equal(typeof state.lastStopAt, "number");
  assert.ok(state.lastStopAt >= since && state.lastStopAt <= Date.now(), `lastStopAt ${state.lastStopAt} is the time of the stop (ms)`);
  return state;
}

function assertSilent(r, what) {
  assert.equal(r.code, 0, `${what}\n${r.dump()}`);
  assert.equal(r.stdout, "", `${what}\n${r.dump()}`);
}

/** Split a hint's review flags out of the reason and run `coworker review --thread <gate thread> …` as written. */
function runHint(ctx, got, { args = got.args, projectDir = ctx.repo, cwd = projectDir, env = {} } = {}) {
  return ctx.cli(["review", "--thread", got.thread, ...args, "--project", projectDir], { cwd, env: { FAKE_CODEX_JSON: JSON.stringify(reviewResult()), ...env } });
}

/** meta.json of the job a CLI run started (from its machine line). */
function jobMeta(ctx, run, projectDir = ctx.repo) {
  const jobId = run.stdout.match(/job=(\S+)/)?.[1];
  assert.ok(jobId && jobId !== "-", run.dump());
  return readJson(path.join(projectDir, ".coworker", "jobs", jobId, "meta.json"));
}

/** A typical coding turn: prompt, some reading, then `edits` = [[tool, rel], …], then the turn ends. */
function codingTurn(ctx, tr, edits, { prompt = "로그인 버그 고쳐줘", at } = {}) {
  const turn = tr.prompt(prompt, { at });
  tr.think();
  tr.read(path.join(ctx.repo, "README.md"));
  for (const [tool, rel, opts] of edits) ctx.claude(tr, tool, rel, opts);
  tr.endTurn();
  return turn;
}

// ================================================================== hooks.json wiring

describe("hooks.json wiring", () => {
  test("UserPromptSubmit and Stop run `node …/coworker.mjs hook <event>` in exec form with sane timeouts", () => {
    const hooks = readJson(path.join(PLUGIN_ROOT, "hooks", "hooks.json")).hooks;
    const only = (event) => {
      assert.equal(hooks[event]?.length, 1, `${event} must have one matcher group`);
      assert.equal(hooks[event][0].hooks.length, 1);
      return hooks[event][0].hooks[0];
    };
    const submit = only("UserPromptSubmit");
    const stop = only("Stop");
    for (const [hook, event] of [[submit, "prompt-submit"], [stop, "stop"]]) {
      assert.equal(hook.type, "command");
      assert.equal(hook.command, "node");
      assert.deepEqual(hook.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/coworker.mjs", "hook", event]);
    }
    assert.ok(submit.timeout >= 2 && submit.timeout <= 10, `prompt-submit timeout ${submit.timeout}s`);
    assert.ok(stop.timeout >= 5 && stop.timeout <= 60, `stop timeout ${stop.timeout}s`);
    assert.deepEqual(Object.keys(hooks).sort(), ["Stop", "UserPromptSubmit"], "no other hook events are registered");
  });

  test("an unknown hook event is a silent no-op (exit 0)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const r = ctx.hook("session-start", { session_id: "sess-1", cwd: ctx.repo, transcript_path: tr.file });
    assertSilent(r, "unknown hook event");
    assert.equal(r.stderr, "");
  });

  test("malformed stdin exits 0 silently for both hooks, even with an unreviewed always-mode turn on disk", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    for (const raw of ["{not json", "[1,2", "{\"session_id\":", "null", "\u0000\u0001garbage", "}{", "", "   ", "\"a string\"", "42", "[]"]) {
      for (const event of ["prompt-submit", "stop"]) {
        const r = ctx.hook(event, null, { raw });
        assert.equal(r.code, 0, `${event} stdin ${JSON.stringify(raw)}\n${r.dump()}`);
        assert.equal(r.stdout, "", `${event} stdin ${JSON.stringify(raw)}\n${r.dump()}`);
        assert.equal(r.stderr, "", `${event} stdin ${JSON.stringify(raw)}\n${r.dump()}`);
      }
    }
    // payload fields of the wrong type are tolerated too
    for (const payload of [{ transcript_path: 42, session_id: {} }, { transcript_path: ["x"], stop_hook_active: "no" }, { transcript_path: tr.file, session_id: null, cwd: 7 }]) {
      const r = ctx.hook("stop", payload);
      assert.equal(r.code, 0, r.dump());
      assert.equal(r.stderr, "", r.dump());
    }
  });
});

// ================================================================== coworker mode (CLI)

describe("coworker mode", () => {
  test("off / on / always / auto / true / false write false | true | \"always\" and status reports the level from the project file", (t) => {
    const ctx = sandbox(t);
    const file = ctx.projectConfig();
    const cases = [
      ["always", "always", "always"],
      ["on", true, "on"],
      ["off", false, "off"],
      ["always", "always", "always"],
      ["auto", true, "on"],
      ["false", false, "off"],
      ["true", true, "on"],
      ["always", "always", "always"],
    ];
    for (const [arg, stored, shown] of cases) {
      const r = ctx.cli(["mode", arg, "--project", ctx.repo]);
      assert.equal(r.code, 0, r.dump());
      assert.equal(r.stderr, "", r.dump());
      assert.match(r.stdout, new RegExp(`^coworker mode → ${shown} — `), r.dump());
      assert.ok(r.stdout.includes(`Scope: this project only (${ctx.repo}) (written to ${file}). Takes effect from the next prompt.`), r.dump());
      assert.deepEqual(readJson(file), { autoMode: stored }, `mode ${arg}`);
      const s = ctx.cli(["mode", "status", "--project", ctx.repo]);
      assert.equal(s.code, 0, s.dump());
      assert.match(s.stdout, new RegExp(`^coworker mode: ${shown} — `), s.dump());
      assert.ok(s.stdout.includes(`Source: project file ${file}`), s.dump());
    }
    // no argument = status
    const bare = ctx.cli(["mode", "--project", ctx.repo]);
    assert.match(bare.stdout, /^coworker mode: always — EVERY request that changes code/);
    assert.match(bare.stdout, /Stop hook/, "the always text names the gate");
    // .coworker/ is self-ignored, so switching modes never dirties the user's repo
    assert.equal(fs.readFileSync(path.join(ctx.repo, ".coworker", ".gitignore"), "utf8"), "*\n");
    assert.equal(ctx.git(["status", "--porcelain"]), "");
  });

  test("mode keeps the other keys of the project config", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel(undefined, { extra: { effort: "low", lang: "ko" } });
    const r = ctx.cli(["mode", "always", "--project", ctx.repo]);
    assert.equal(r.code, 0, r.dump());
    assert.deepEqual(readJson(ctx.projectConfig()), { effort: "low", lang: "ko", autoMode: "always" });
  });

  test("an unknown mode is refused on stdout (exit 0, `!`-line friendly) and changes nothing", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    for (const bad of ["sometimes", "ALWAYS", "never"]) {
      const r = ctx.cli(["mode", bad, "--project", ctx.repo]);
      assert.equal(r.code, 0, r.dump());
      assert.match(r.stdout, new RegExp(`coworker mode: Unknown mode "${bad}"`), r.dump());
      assert.deepEqual(readJson(ctx.projectConfig()), { autoMode: "always" });
    }
  });

  test("--global writes the global default; a project setting overrides it; status names the source", (t) => {
    const ctx = sandbox(t);
    let s = ctx.cli(["mode", "status", "--project", ctx.repo]);
    assert.match(s.stdout, /^coworker mode: off — /);
    assert.ok(s.stdout.includes(`Source: global default ${ctx.globalConfig()} (this project has no own setting)`), s.dump());

    const g = ctx.cli(["mode", "always", "--global", "--project", ctx.repo]);
    assert.equal(g.code, 0, g.dump());
    assert.ok(g.stdout.includes(`Scope: global default for projects without their own setting (written to ${ctx.globalConfig()})`), g.dump());
    assert.deepEqual(readJson(ctx.globalConfig()), { autoMode: "always" });
    assert.ok(!fs.existsSync(ctx.projectConfig()), "--global must not create a project config");
    s = ctx.cli(["mode", "status", "--project", ctx.repo]);
    assert.match(s.stdout, /^coworker mode: always — /);
    assert.match(s.stdout, /this project has no own setting/);

    const p = ctx.cli(["mode", "off", "--project", ctx.repo]);
    assert.equal(p.code, 0, p.dump());
    s = ctx.cli(["mode", "status", "--project", ctx.repo]);
    assert.match(s.stdout, /^coworker mode: off — /);
    assert.ok(s.stdout.includes(`Source: project file ${ctx.projectConfig()}`), s.dump());
    assert.deepEqual(readJson(ctx.globalConfig()), { autoMode: "always" }, "a project write must not touch the global file");
  });
});

// ================================================================== config precedence + validation

describe("config: project overrides global, invalid autoMode is rejected", () => {
  test("hooks follow the effective level: project false/true beats global always, global always applies without a project setting", (t) => {
    const ctx = sandbox(t);
    const turn = (session) => {
      const submit = ctx.submit("로그인 버그 고쳐줘, 토큰 갱신 로직", { session });
      const tr = ctx.transcript({ session });
      codingTurn(ctx, tr, [["Write", `src/${session}.js`]]);
      return { submit, stop: ctx.stop({ session, transcript: tr }) };
    };

    ctx.setGlobalLevel("always");
    let r = turn("g-always");
    assert.match(r.submit.stdout, ALWAYS_FIRST);
    assertBlocked(r.stop, { files: ["src/g-always.js"] });

    ctx.setLevel(false); // project off beats global always
    r = turn("p-off");
    assertSilent(r.submit, "project off must silence prompt-submit");
    assertAllowed(r.stop, "project off");
    assert.equal(ctx.state("p-off"), null, "nothing recorded outside always mode");

    ctx.setLevel(true); // project on (auto) beats global always
    r = turn("p-on");
    assert.match(r.submit.stdout, AUTO_FIRST);
    assertAllowed(r.stop, "project auto");

    ctx.setLevel(undefined, { extra: { effort: "low" } }); // project file without autoMode → global applies
    r = turn("p-none");
    assert.match(r.submit.stdout, ALWAYS_FIRST);
    assertBlocked(r.stop, { files: ["src/p-none.js"] });

    ctx.setGlobalLevel(false);
    ctx.setLevel("always"); // project always beats global off
    r = turn("p-always");
    assert.match(r.submit.stdout, ALWAYS_FIRST);
    assertBlocked(r.stop, { files: ["src/p-always.js"] });

    ctx.setGlobalLevel(undefined);
    ctx.rm(".coworker/config.json");
    r = turn("none");
    assertSilent(r.submit, "no config anywhere = off");
    assertAllowed(r.stop, "no config anywhere");
  });

  test("normalizeLevel / readLevel map stored values to off | auto | always", (t) => {
    const table = [
      [true, "auto"], ["on", "auto"], ["auto", "auto"], ["always", "always"],
      [false, "off"], ["off", "off"], [undefined, "off"], [null, "off"], ["ALWAYS", "off"], ["sometimes", "off"], [1, "off"],
    ];
    for (const [value, level] of table) assert.equal(auto.normalizeLevel(value), level, `normalizeLevel(${JSON.stringify(value)})`);
    assert.deepEqual(auto.LEVELS, ["off", "auto", "always"]);

    const ctx = sandbox(t);
    assert.equal(auto.readLevel(ctx.repo), "off");
    ctx.setLevel("always");
    assert.equal(auto.readLevel(ctx.repo), "always");
    fs.writeFileSync(ctx.projectConfig(), "{not json");
    assert.equal(auto.readLevel(ctx.repo), "off", "a corrupt project file falls back to the (absent) global setting");
  });

  test("loadConfig accepts false | true | \"always\" (and the on/off/auto aliases) and rejects anything else, project or global", (t) => {
    const ctx = sandbox(t);
    const load = () => loadConfig({ projectRoot: ctx.repo, env: {} });
    const globalFile = path.join(PROC, "xdg-config", "coworker", "config.json");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    try {
      for (const value of [false, true, "always", "on", "off", "auto"]) {
        ctx.setLevel(value);
        assert.equal(load().config.autoMode, value, `autoMode ${JSON.stringify(value)}`);
      }
      ctx.rm(".coworker/config.json");
      assert.equal(load().config.autoMode, false, "default is false");
      for (const value of ["sometimes", "ALWAYS", "Always", "yes", 1, 0, null, {}, [], ["always"]]) {
        ctx.setLevel(value);
        assert.throws(load, /Invalid autoMode/, `project autoMode ${JSON.stringify(value)} must be rejected`);
      }
      ctx.rm(".coworker/config.json");
      fs.writeFileSync(globalFile, JSON.stringify({ autoMode: "sometimes" }));
      assert.throws(load, /Invalid autoMode/, "global autoMode is validated too");
      ctx.setLevel("always");
      fs.writeFileSync(globalFile, JSON.stringify({ autoMode: true }));
      assert.equal(load().config.autoMode, "always", "project overrides global in loadConfig");
    } finally {
      fs.rmSync(globalFile, { force: true });
    }
  });

  test("an invalid autoMode: `mode status` answers on stdout (exit 0) and the hooks stay silent (treated as off)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("Always");
    const s = ctx.cli(["mode", "status", "--project", ctx.repo]);
    assert.equal(s.code, 0, s.dump());
    assert.equal(s.stderr, "", s.dump());
    assert.match(s.stdout, /^coworker mode: /);
    const submit = ctx.submit("버그 고쳐줘 로그인 토큰 만료 처리");
    assertSilent(submit, "invalid autoMode must not break prompt-submit");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/x.js"]]);
    assertAllowed(ctx.stop({ transcript: tr }), "invalid autoMode = off");
  });

  test("`mode status` names an invalid autoMode value that every Astra command rejects", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("Always");
    const review = ctx.cli(["review", "--uncommitted", "--project", ctx.repo]);
    assert.match(review.stdout + review.stderr, /Invalid autoMode/, "precondition: Astra commands reject the value");
    const s = ctx.cli(["mode", "status", "--project", ctx.repo]);
    assert.match(s.stdout, /Always/, `status should name the invalid value:\n${s.dump()}`);
  });

  test("`mode off` / `mode always` repair an invalid autoMode value (and keep the other keys)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("Always", { extra: { effort: "low" } });
    let r = ctx.cli(["mode", "off", "--project", ctx.repo]);
    assert.equal(r.code, 0, r.dump());
    assert.match(r.stdout, /^coworker mode → off — /, r.dump());
    assert.deepEqual(readJson(ctx.projectConfig()), { effort: "low", autoMode: false }, r.dump());
    ctx.setLevel(["always"]);
    r = ctx.cli(["mode", "always", "--project", ctx.repo]);
    assert.equal(r.code, 0, r.dump());
    assert.deepEqual(readJson(ctx.projectConfig()), { autoMode: "always" }, r.dump());
    assert.doesNotThrow(() => loadConfig({ projectRoot: ctx.repo, env: {} }));
  });
});

// ================================================================== prompt-submit

describe("hook prompt-submit", () => {
  test("always: long reminder once per session, short one on every later prompt (questions included); new session starts over", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    let r = ctx.submit("이 함수가 뭐 하는 건지 설명해줘");
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.stderr, "", r.dump());
    assert.match(r.stdout, ALWAYS_FIRST);
    assert.match(r.stdout, /no small-change exemption/);
    assert.match(r.stdout, /a Stop hook asks for a coworker:review of exactly those files/);
    assert.ok(fs.existsSync(path.join(ctx.repo, ".coworker", "hook-sessions", "sess-1.always")));

    for (const prompt of ["고마워", "이 줄 오타 하나만 고쳐줘", "what does this do?"]) {
      r = ctx.submit(prompt);
      assert.equal(r.code, 0, r.dump());
      assert.match(r.stdout, ALWAYS_SHORT, `later prompt ${JSON.stringify(prompt)}`);
      assert.doesNotMatch(r.stdout, ALWAYS_FIRST);
      assert.equal(r.stdout.trim().split("\n").length, 1);
    }
    r = ctx.submit("hello", { session: "sess-2" });
    assert.match(r.stdout, ALWAYS_FIRST, "another session gets the long reminder again");
  });

  test("auto: long reminder first, then only coding requests get the short one", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel(true);
    let r = ctx.submit("이 저장소 구조를 설명해 주세요");
    assert.match(r.stdout, AUTO_FIRST);
    assert.ok(fs.existsSync(path.join(ctx.repo, ".coworker", "hook-sessions", "sess-1.auto")));
    r = ctx.submit("이 함수가 어떤 역할을 하는지 설명해 주세요");
    assertSilent(r, "auto: a later question is silent");
    r = ctx.submit("로그인 기능 구현해줘 여러 파일 수정");
    assert.match(r.stdout, AUTO_SHORT);
    r = ctx.submit("fix it"); // coding intent but < 15 chars
    assertSilent(r, "auto: very short prompts are silent");
  });

  test("switching auto → always inside one session shows the always long reminder once", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel(true);
    assert.match(ctx.submit("이 저장소 구조를 설명해 주세요").stdout, AUTO_FIRST);
    ctx.setLevel("always");
    assert.match(ctx.submit("설명 고마워요").stdout, ALWAYS_FIRST);
    assert.match(ctx.submit("다음은?").stdout, ALWAYS_SHORT);
    ctx.setLevel(true);
    assertSilent(ctx.submit("설명 고마워요 다시"), "back in auto the auto marker still exists");
  });

  test("slash commands and blank prompts are silent and do not consume the first reminder", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    for (const prompt of ["/coworker:status --ping", "   ", "  /clear", ""]) {
      assertSilent(ctx.submit(prompt), `prompt ${JSON.stringify(prompt)}`);
    }
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker", "hook-sessions", "sess-1.always")), "a slash prompt must not consume the first reminder");
    assert.match(ctx.submit("이제 설명해줘").stdout, ALWAYS_FIRST, "the first non-slash prompt still gets the long reminder");
  });

  test("prompt-submit records no turn state and never touches git (the gate reads the transcript instead)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    ctx.write("user-wip.js", "uncommitted user work\n");
    for (const prompt of ["구현해줘", "/coworker:mode always", "다음"]) ctx.submit(prompt);
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker", "auto")), "no .coworker/auto state from prompt-submit");
    assert.equal(ctx.git(["status", "--porcelain", "--untracked-files=all"]), "?? user-wip.js\n", "index and worktree untouched");
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".git", "index.lock")));
  });

  test("a non-git project still gets the reminders", (t) => {
    const ctx = sandbox(t, { git: false });
    ctx.setLevel("always");
    const r = ctx.submit("로그인 버그 고쳐줘");
    assert.equal(r.code, 0, r.dump());
    assert.match(r.stdout, ALWAYS_FIRST);
    assert.equal(r.stderr, "");
    assert.match(ctx.submit("다음").stdout, ALWAYS_SHORT);
  });

  test("without CLAUDE_PROJECT_DIR the payload's cwd is the project (both hooks)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const r = ctx.submit("hi", { env: { CLAUDE_PROJECT_DIR: undefined } });
    assert.match(r.stdout, ALWAYS_FIRST);
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "x.js"]]);
    assertBlocked(ctx.stop({ transcript: tr, env: { CLAUDE_PROJECT_DIR: undefined } }), { files: ["x.js"] });
  });
});

// ================================================================== stop gate: which changes count

describe("hook stop: turn attribution from the transcript", () => {
  test("off and auto never block, even right after Claude edited files", (t) => {
    const ctx = sandbox(t);
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"], ["Edit", "README.md"]]);
    assertAllowed(ctx.stop({ transcript: tr }), "no config");
    for (const level of [true, false, "on", "off", "auto"]) {
      ctx.setLevel(level);
      assertAllowed(ctx.stop({ transcript: tr }), `level ${JSON.stringify(level)}`);
    }
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker", "auto")));
  });

  test("a question-only turn is allowed (reads, greps and prose, on an already dirty tree)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    ctx.write("wip.js", "the user's own uncommitted work\n");
    ctx.write("README.md", "# sandbox\nuser edit\n");
    const tr = ctx.transcript();
    tr.prompt("이 함수가 뭐 하는 건지 설명해줘");
    tr.think();
    tr.read(path.join(ctx.repo, "README.md"));
    tr.tool("Grep", { pattern: "login", path: ctx.repo, output_mode: "content" });
    tr.tool("Glob", { pattern: "**/*.js" });
    tr.endTurn("이 함수는 …");
    const before = Date.now();
    assertAllowed(ctx.stop({ transcript: tr }), "no edits in this turn");
    assertOnlyLastStop(ctx, { since: before });
  });

  test("the user's own edits before the turn, and Claude's edits in earlier turns, are never counted", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    // turn 1: Claude edits x.js (blocked once)
    codingTurn(ctx, tr, [["Write", "src/x.js"]]);
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/x.js"], lastChange: tr.lastChangeAt });
    // between turns the user edits files by hand
    ctx.write("README.md", "# sandbox\nhand edit\n");
    ctx.write("notes.txt", "user notes\n");
    // turn 2: question only → allowed although x.js, README.md and notes.txt are all dirty
    tr.prompt("x.js 설명해줘");
    tr.read(path.join(ctx.repo, "src", "x.js"));
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "nothing changed by Claude in this turn");
    // turn 3: Claude edits one file → exactly that one is named
    codingTurn(ctx, tr, [["Edit", "src/y.js"]]);
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/y.js"], lastChange: tr.lastChangeAt });
    assert.equal(got.pathsFileContent, "src/y.js\n");
  });

  test("Edit / Write / MultiEdit / NotebookEdit inside the project block with exactly those files (git repo)", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "line1\nline2\n");
    ctx.write("src/util.js", "u1\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    ctx.write("unrelated-dirty.js", "user work\n"); // dirty but not Claude's
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [
      ["Edit", "src/app.js"],
      ["Write", "src/new-file.js"],
      ["MultiEdit", "src/util.js"],
      ["NotebookEdit", "notebooks/analysis.ipynb"],
      ["Edit", "src/app.js"], // edited twice: listed once
    ]);
    const r = ctx.stop({ transcript: tr });
    const got = assertBlocked(r, { files: ["src/app.js", "src/new-file.js", "src/util.js", "notebooks/analysis.ipynb"], target: "uncommitted", lastChange: tr.lastChangeAt });
    assert.deepEqual(got.listed, ["notebooks/analysis.ipynb", "src/app.js", "src/new-file.js", "src/util.js"], "listed once each, in sorted order");
    assert.equal(got.pathsFileContent, "notebooks/analysis.ipynb\nsrc/app.js\nsrc/new-file.js\nsrc/util.js\n");
    assert.deepEqual(got.args, ["--uncommitted", "--paths-file", path.join(".coworker", "work", got.thread, "paths.txt")]);
    assert.match(r.decision.reason, /`--fix`/);
    const state = ctx.state();
    assert.deepEqual(state.gatedKeys, [gateKey(got.all, tr.lastChangeAt)]);
    assert.deepEqual(state.turnBlocks, { [tr.turn.uuid]: 1 }, "one block for this turn, keyed by the prompt's uuid");
    assert.equal(state.gatedTurns, undefined, "the v2 gatedTurns list is not written");
    assert.ok(!Number.isNaN(Date.parse(state.lastGateAt)));
    assert.equal(typeof state.lastStopAt, "number");
    assert.equal(
      ctx.git(["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean).sort().join("|"),
      [" M src/app.js", " M src/util.js", "?? notebooks/analysis.ipynb", "?? src/new-file.js", "?? unrelated-dirty.js"].sort().join("|"),
      "the gate must not stage anything or dirty the repo (.coworker/ is self-ignored)",
    );
  });

  test("Edit / Write / MultiEdit / NotebookEdit in a non-git project block with a --paths-file hint", (t) => {
    const ctx = sandbox(t, { git: false });
    ctx.setLevel("always");
    ctx.write("pre-existing.js", "the user's file\n");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Edit", "main.py"], ["Write", "lib/new.py"], ["MultiEdit", "lib/util.py"], ["NotebookEdit", "nb.ipynb"]]);
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py", "lib/new.py", "lib/util.py", "nb.ipynb"], target: "paths", lastChange: tr.lastChangeAt });
    assert.doesNotMatch(got.hint, /--uncommitted/);
    assertAllowed(ctx.stop({ transcript: tr }), "the same change set is asked about once, in a non-git project too");
  });

  test("edits outside the project, and anything under .coworker/, are ignored", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const sibling = path.join(ctx.dir, "repo-other"); // shares the "repo" prefix
    const tr = ctx.transcript();
    tr.prompt("정리해줘");
    ctx.claude(tr, "Write", "x.js", { file: path.join(sibling, "x.js") });
    ctx.claude(tr, "Write", "y.js", { file: path.join(ctx.dir, "outside", "y.js") });
    ctx.claude(tr, "Edit", "z", { file: path.join(ctx.dir, "parent-level.js") });
    ctx.claude(tr, "Write", "", { file: path.join(os.homedir(), ".claude", "plans", `never-written-${hex(4)}.md`), onDisk: false });
    ctx.claude(tr, "Write", ".coworker/work/task/review-brief.md");
    ctx.claude(tr, "Write", ".coworker/work/task/responses.json");
    ctx.claude(tr, "Edit", ".coworker/config.json", { content: JSON.stringify({ autoMode: "always" }) });
    ctx.claude(tr, "Write", "x", { file: ctx.repo, onDisk: false }); // the project dir itself
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "nothing inside the project changed");

    // mixed: only the inside file is named
    ctx.claude(tr, "Write", "src/inside.js");
    ctx.claude(tr, "Write", "w.js", { file: path.join(sibling, "w.js") });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/inside.js"] });
  });

  test("edited-then-reverted files are allowed; only still-changed files are named", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "original\n");
    ctx.write("src/keep.js", "original keep\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("실험해보고 되돌려줘");
    ctx.claude(tr, "Edit", "src/app.js", { content: "experiment\n" });
    ctx.claude(tr, "Write", "src/scratch.js", { content: "tmp\n" });
    ctx.claude(tr, "Edit", "src/app.js", { content: "original\n" }); // back to HEAD
    tr.bash("rm src/scratch.js");
    ctx.rm("src/scratch.js");
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "every edited file is back to its committed state");
    assert.equal(ctx.git(["status", "--porcelain"]), "");

    tr.prompt("이번엔 진짜로 바꿔줘");
    ctx.claude(tr, "Edit", "src/app.js", { content: "changed\n" });
    ctx.claude(tr, "Edit", "src/keep.js", { content: "tmp change\n" });
    ctx.claude(tr, "Edit", "src/keep.js", { content: "original keep\n" });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js"] });
  });

  test("a gitignored file Claude edited is not gated (a review snapshot would not contain it either)", (t) => {
    const ctx = sandbox(t);
    ctx.write(".gitignore", "dist/\n*.log\n.env.local\n");
    ctx.commitAll("ignores");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "dist/bundle.js"], ["Write", ".env.local"], ["Edit", "debug.log"]]);
    assertAllowed(ctx.stop({ transcript: tr }), "only ignored files");
  });

  test("file names with spaces and non-ASCII characters are matched and listed exactly", (t) => {
    const ctx = sandbox(t);
    ctx.write("docs/read me.md", "old\n");
    ctx.commitAll("docs");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Edit", "docs/read me.md"], ["Write", "src/한글 파일.js"], ["Write", "src/émoji-🙂.ts"]]);
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["docs/read me.md", "src/한글 파일.js", "src/émoji-🙂.ts"] });
    assert.equal(got.pathsFileContent, `${sorted(["docs/read me.md", "src/한글 파일.js", "src/émoji-🙂.ts"]).join("\n")}\n`, "names are written raw (no quoting) one per line");
  });

  test("more than 15 changed files: the count is exact, the reason lists 15 and points at the full paths file", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    // written in reverse order: the list is sorted, not in edit order
    const files = Array.from({ length: 17 }, (_, i) => `src/gen/file${String(i).padStart(2, "0")}.js`);
    codingTurn(ctx, tr, [...files].reverse().map((file) => ["Write", file]));
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files, lastChange: tr.lastChangeAt });
    assert.equal(got.count, 17);
    assert.ok(got.truncated, "says … (17 files; full list in <paths file>)");
    assert.deepEqual(got.listed, files.slice(0, 15));
    assert.ok(got.fullListIn, got.hint);
    assert.equal(got.pathsFile, got.fullListIn, "the hint's --paths-file is the same full list");
    assert.equal(fs.readFileSync(path.join(ctx.repo, got.fullListIn), "utf8"), `${files.join("\n")}\n`, "the paths file has ALL 17 files, one per line");
  });

  test("exactly 15 changed files are listed in full, without a truncation note", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const files = Array.from({ length: 15 }, (_, i) => `src/f${String(i).padStart(2, "0")}.js`);
    codingTurn(ctx, tr, files.map((file) => ["Write", file]));
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files });
    assert.equal(got.truncated, false);
    assert.doesNotMatch(got.hint + got.listed.join(), /full list in/);
  });
});

// ================================================================== stop gate: commits during the turn

describe("hook stop: commits during the turn", () => {
  test("files committed during the turn are gated with a --base <first commit>^ hint", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/feature.js", "v0\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("구현하고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Edit", "src/feature.js", { content: "v1\n" });
    ctx.claude(tr, "Write", "src/helper.js", { content: "export const h = 1;\n" });
    tr.bash("git add -A && git commit -m 'feature part 1'");
    const first = ctx.commitAll("feature part 1", { during: true });
    ctx.claude(tr, "Write", "docs/feature.md", { content: "docs\n" });
    tr.bash("git add -A && git commit -m 'docs'");
    ctx.commitAll("docs", { during: true });
    tr.endTurn();
    assert.equal(ctx.git(["status", "--porcelain"]), "", "worktree is clean after the commits");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/feature.js", "src/helper.js", "docs/feature.md"], target: "committed", lastChange: ctx.commitTime() });
    assert.equal(got.base, first.slice(0, 12), "the base is the OLDEST commit of the turn");
    assert.equal(ctx.git(["rev-parse", "--verify", `${got.base}^`]).trim(), ctx.git(["rev-parse", `${first}^`]).trim(), "the hinted base resolves");
    assertAllowed(ctx.stop({ transcript: tr }), "the same change set is asked about once");
  });

  test("a mix of committed and still-dirty files uses the --base hint (it covers both)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("a는 커밋하고 b는 남겨둬", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "a.js");
    ctx.commitAll("a", { during: true });
    ctx.claude(tr, "Write", "b.js");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["a.js", "b.js"], target: "committed" });
  });

  test("a commit from before the turn does not make a reverted edit look committed", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "old\n");
    ctx.commitAll("base");
    const past = new Date(Date.now() - 600_000).toISOString();
    ctx.write("src/a.js", "committed before the turn\n");
    ctx.commitAll("earlier work", { env: { GIT_COMMITTER_DATE: past, GIT_AUTHOR_DATE: past } });
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("a.js 손봤다가 되돌려줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Edit", "src/a.js", { content: "experiment\n" });
    ctx.claude(tr, "Edit", "src/a.js", { content: "committed before the turn\n" });
    // an unrelated commit during the turn (e.g. the user in another terminal)
    ctx.write("other.txt", "x\n");
    ctx.commitAll("other", { during: true });
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "reverted, and no commit of the turn touches it");
  });

  test("a commit made during the turn on ANOTHER branch (then switched back) is still gated, with a --paths-file hint (not reachable from HEAD)", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "v0\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("브랜치 만들어서 고치고 커밋한 뒤 main으로 돌아와", { at: Date.now() - 60_000 });
    tr.bash("git checkout -b fix");
    ctx.git(["checkout", "-q", "-b", "fix"]);
    ctx.claude(tr, "Edit", "src/a.js", { content: "v1 on fix\n" });
    ctx.commitAll("fix", { during: true });
    tr.bash("git checkout main");
    ctx.git(["checkout", "-q", "main"]);
    tr.endTurn();
    assert.equal(fs.readFileSync(path.join(ctx.repo, "src", "a.js"), "utf8"), "v0\n", "precondition: the worktree is back on main");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], target: "paths", lastChange: ctx.commitTime("fix") });
    assert.doesNotMatch(got.hint, /--base|--uncommitted/, "a --base diff of HEAD's history cannot contain a commit on another branch");
  });

  test("a commit on a branch that is not checked out: the --paths-file hint, run as written, satisfies the gate", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "v0\n");
    ctx.commitAll("base");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("브랜치에서 고치고 커밋해", { at: Date.now() - 60_000 });
    ctx.git(["checkout", "-q", "-b", "fix"]);
    ctx.claude(tr, "Edit", "src/a.js", { content: "v1 on fix\n" });
    ctx.commitAll("fix", { during: true });
    ctx.git(["checkout", "-q", "main"]);
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], target: "paths" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(jobMeta(ctx, review).target.paths, ["src/a.js"], review.dump());
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "the hinted review covers the file");
  });

  test("a commit on a branch that is not checked out: the hinted review sees the committed change", { todo: "BUG: for a commit that is not reachable from HEAD the gate falls back to `--paths-file` (review the files as they are NOW), but after switching back the worktree holds the OLD content (v0), so Astra reviews code Claude did not write while the committed change (v1 on branch fix) is never shown to it — yet that review satisfies the gate" }, (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "v0\n");
    ctx.commitAll("base");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("브랜치에서 고치고 커밋해", { at: Date.now() - 60_000 });
    ctx.git(["checkout", "-q", "-b", "fix"]);
    ctx.claude(tr, "Edit", "src/a.js", { content: "v1 on fix\n" });
    ctx.commitAll("fix", { during: true });
    ctx.git(["checkout", "-q", "main"]);
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], target: null });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    const jobId = review.stdout.match(/job=(\S+)/)[1];
    const dir = path.join(ctx.repo, ".coworker", "jobs", jobId);
    const shown = ["prompt.md", "diff.patch"].map((name) => tryText(path.join(dir, name))).join("\n");
    const worktree = fs.readFileSync(path.join(ctx.repo, "src", "a.js"), "utf8");
    assert.ok(shown.includes("v1 on fix") || worktree.includes("v1 on fix"), `the review never sees the committed content (worktree: ${JSON.stringify(worktree)}; hint: ${got.hint})`);
  });

  test("a committed file whose name has non-ASCII characters and spaces is gated", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("한글 파일 만들고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "src/한글 파일.js");
    ctx.claude(tr, "Write", "docs/émoji 🙂.md");
    ctx.commitAll("i18n", { during: true });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/한글 파일.js", "docs/émoji 🙂.md"], target: "committed" });
  });

  test("a committed file whose name contains a double quote is gated", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("파일 만들고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", 'src/say "hi".js');
    ctx.claude(tr, "Write", "src/back\\slash.js");
    ctx.commitAll("quote", { during: true });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ['src/say "hi".js', "src/back\\slash.js"], target: "committed" });
  });

  test("a committed file at a repo-root path starting with '@' is gated", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("타입 정의 추가하고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "@types/env.d.ts");
    ctx.claude(tr, "Write", "src/zz-after.js"); // listed after the '@' path in the same commit
    ctx.commitAll("types", { during: true });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["@types/env.d.ts", "src/zz-after.js"], target: "committed" });
  });

  test("files changed by Bash and committed during the turn are gated", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "v0\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("sed로 바꾸고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.during(tr, "Bash", "sed -i '' s/v0/v1/ src/app.js && git commit -am bump", () => {
      ctx.write("src/app.js", "v1\n");
      ctx.commitAll("bump", { during: true });
    });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js"], target: "committed" });
  });

  test("the first commit of an unborn repository (a root commit: no parent for --base) is gated with a --paths-file hint", (t) => {
    const ctx = sandbox(t, { commit: false });
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("프로젝트 뼈대 만들고 첫 커밋 해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "main.py", { content: "print(1)\n" });
    ctx.claude(tr, "Write", "lib/util.py", { content: "X = 1\n" });
    ctx.commitAll("initial", { during: true });
    tr.endTurn();
    assert.equal(ctx.git(["status", "--porcelain"]), "", "precondition: everything is committed");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py", "lib/util.py"], target: "paths", lastChange: ctx.commitTime() });
    assert.doesNotMatch(got.hint, /--base|--uncommitted/, "a root commit has no parent to use as a base, and nothing is uncommitted");
    assert.equal(got.pathsFileContent, "lib/util.py\nmain.py\n");
  });

  test("root commit + a later commit: ONE --paths-file hint lists every file of the turn", (t) => {
    const ctx = sandbox(t, { commit: false });
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("뼈대 만들고 두 번 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "main.py");
    ctx.commitAll("initial", { during: true });
    ctx.claude(tr, "Write", "lib/util.py");
    ctx.commitAll("util", { during: true });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py", "lib/util.py"], target: "paths", lastChange: ctx.commitTime() });
  });

  test("root commit + a later commit: running the hint as written satisfies the gate (one job covers all)", (t) => {
    const ctx = sandbox(t, { commit: false });
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("뼈대 만들고 두 번 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "main.py");
    ctx.commitAll("initial", { during: true });
    ctx.claude(tr, "Write", "lib/util.py");
    ctx.commitAll("util", { during: true });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py", "lib/util.py"], target: "paths" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(jobMeta(ctx, review).target.paths, ["lib/util.py", "main.py"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "every file the hint named was reviewed");
  });

  test("root commit + a still-uncommitted file: the hint covers the uncommitted file too", (t) => {
    const ctx = sandbox(t, { commit: false });
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("뼈대 커밋하고 설정 파일도 추가해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "main.py");
    ctx.commitAll("initial", { during: true });
    ctx.claude(tr, "Write", "config.py");
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["config.py", "main.py"], target: "paths" });
    assert.equal(runHint(ctx, got).code, 0);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "config.py must be covered by what the hint asked for");
  });

  test("unborn HEAD without a commit: new files are gated with the uncommitted hint", (t) => {
    const ctx = sandbox(t, { commit: false });
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "main.py"], ["Write", "lib/util.py"]]);
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py", "lib/util.py"], target: "uncommitted" });
  });
});

// ================================================================== stop gate: tool windows (Bash, Agent, …)

describe("hook stop: files changed inside a tool window (Bash, Agent, Task, Workflow, mcp__*)", () => {
  test("a Bash window counts dirty files modified inside it; older dirty files, deletions, ignored files and .coworker/ do not", (t) => {
    const ctx = sandbox(t);
    ctx.write(".gitignore", "dist/\n");
    ctx.write("src/app.js", "v0\n");
    ctx.write("src/gone.js", "to be deleted\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const old = Date.now() - 3_600_000;
    setMtime(ctx.write("user-old.js", "user's older untracked work\n"), old);
    setMtime(ctx.write("README.md", "# sandbox\nuser's older tracked edit\n"), old);
    const tr = ctx.transcript();
    tr.prompt("코드젠 돌려줘", { at: Date.now() - 5000 });
    ctx.during(tr, "Bash", "npm run codegen && rm src/gone.js", () => {
      ctx.write("src/generated.js", "generated\n");
      ctx.write("src/app.js", "v1 from a script\n");
      ctx.rm("src/gone.js");
      ctx.write("dist/out.js", "built\n");
      ctx.write(".coworker/work/log.md", "notes\n");
    });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/generated.js", "src/app.js"] });
  });

  test("a file the user saves during the turn but OUTSIDE every Bash window is not counted", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    tr.prompt("테스트 돌려줘", { at: now - 60_000 });
    const use = tr.toolUse("Bash", { command: "npm test", description: "Run tests" }, { at: now - 50_000 });
    tr.toolResult(use, "12 passing", { at: now - 45_000 }); // window: [now-52 s, now-43 s]
    tr.say("테스트 통과");
    // the user's editor saves files while Claude is thinking, before and after the window
    setMtime(ctx.write("src/user-before.js", "saved by the user\n"), now - 55_000);
    setMtime(ctx.write("src/user-after.js", "saved by the user\n"), now - 30_000);
    ctx.write("src/user-now.js", "saved by the user just now\n");
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "no dirty file's mtime lies inside the Bash window");
    // …while a file modified inside the window counts
    setMtime(ctx.write("src/inside.js", "written by npm test\n"), now - 47_000);
    assertBlocked(ctx.stop({ transcript: tr, session: "s2" }), { files: ["src/inside.js"], lastChange: now - 47_000 });
  });

  test("the window has 2 s of slack on each side", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    tr.prompt("빌드해줘", { at: now - 60_000 });
    const use = tr.toolUse("Bash", { command: "make", description: "Build" }, { at: now - 50_000 });
    tr.toolResult(use, "ok", { at: now - 40_000 });
    tr.endTurn();
    setMtime(ctx.write("in-lead.js", "x\n"), now - 51_000);
    setMtime(ctx.write("in-tail.js", "x\n"), now - 38_500);
    setMtime(ctx.write("out-lead.js", "x\n"), now - 52_500);
    setMtime(ctx.write("out-tail.js", "x\n"), now - 37_500);
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["in-lead.js", "in-tail.js"] });
  });

  for (const [name, input] of [
    ["Agent", { description: "Implement login", prompt: "Implement the login fix in src/login.js", subagent_type: "general-purpose" }],
    ["Task", { description: "Implement login", prompt: "Implement the login fix", subagent_type: "general-purpose" }],
    ["Workflow", { script: "workflows/fix.js", args: {} }],
    ["mcp__filesystem__write_file", { path: "src/login.js", content: "x" }],
  ]) {
    test(`a file changed inside a ${name} window is counted`, (t) => {
      const ctx = sandbox(t);
      ctx.setLevel("always");
      const tr = ctx.transcript();
      tr.prompt(`${name}로 구현해줘`, { at: Date.now() - 20_000 });
      ctx.during(tr, name, input, () => ctx.write("src/login.js", `// written during ${name}\n`), { result: "Done: edited src/login.js" });
      tr.endTurn();
      assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/login.js"] });
    });
  }

  test("files a subagent (Agent tool) changed in this turn are gated (its own transcript is not needed)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("서브에이전트로 구현해줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "Agent", { description: "Implement login", prompt: "Implement the login fix in src/login.js", subagent_type: "general-purpose" }, () => {
      // what the subagent did, in its own transcript file (as Claude Code stores it)
      const sub = new Transcript(path.join(ctx.dir, "transcripts", "sess-1", "subagents", "agent-a1b2c3.jsonl"), { sessionId: "sess-1", cwd: ctx.repo, start: Date.now() });
      sub.userLine("Implement the login fix in src/login.js", { isSidechain: true, agentId: "a1b2c3" });
      ctx.claude(sub, "Write", "src/login.js");
    }, { result: "Done: edited src/login.js" });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/login.js"] });
  });

  test("an mcp__ tool from an MCP server that is not a file tool still opens a window (any mcp__ tool may write files)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("이슈 보고 고쳐줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "mcp__github__get_issue", { owner: "o", repo: "r", issue_number: 1 }, () => ctx.write("src/fix.js", "x\n"));
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/fix.js"] });
  });

  test("read-only tools (Read, Grep, Glob, WebFetch, TodoWrite, Skill) open no window", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("조사해줘", { at: Date.now() - 20_000 });
    for (const [name, input] of [["Read", { file_path: path.join(ctx.repo, "README.md") }], ["Grep", { pattern: "x" }], ["Glob", { pattern: "**" }], ["WebFetch", { url: "https://example.invalid", prompt: "x" }], ["TodoWrite", { todos: [] }], ["Skill", { skill: "coworker:review" }]]) {
      ctx.during(tr, name, input, () => ctx.write(`src/during-${name}.js`, "the user's editor\n"));
    }
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "no window tool ran");
  });

  test("a run_in_background Bash keeps its window open until the stop: what the background job writes later is counted", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    tr.prompt("watch 모드로 빌드 띄워줘", { at: now - 60_000 });
    const use = tr.toolUse("Bash", { command: "npm run build -- --watch", description: "Start watcher", run_in_background: true }, { at: now - 50_000 });
    tr.toolResult(use, "Command running in background with ID: b1x2y3", { at: now - 49_900 });
    tr.say("빌드 워처를 띄웠습니다.");
    tr.endTurn();
    // the watcher keeps writing after the tool returned…
    setMtime(ctx.write("src/built-later.js", "x\n"), now - 30_000);
    ctx.write("src/built-now.js", "x\n");
    // …but a file saved before the launch (− 2 s slack) is not its output
    setMtime(ctx.write("src/before-launch.js", "x\n"), now - 52_500);
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/built-later.js", "src/built-now.js"], lastChange: fs.statSync(path.join(ctx.repo, "src", "built-now.js")).mtimeMs });
  });

  test("a launch the tool_result reports as background (toolUseResult async_launched / backgroundTaskId) keeps its window open; a finished foreground call does not", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const cases = [
      ["Bash moved to the background", "Bash", { command: "npm test", description: "Run tests" }, { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "bash_7" }, true],
      ["async Agent", "Agent", { description: "Refactor", prompt: "Refactor src/", subagent_type: "general-purpose" }, { status: "async_launched", agentId: "a1b2c3", description: "Refactor" }, true],
      ["finished foreground Bash", "Bash", { command: "npm test", description: "Run tests" }, { stdout: "ok", stderr: "", interrupted: false, isImage: false }, false],
      ["finished Agent", "Agent", { description: "Refactor", prompt: "Refactor src/", subagent_type: "general-purpose" }, { status: "completed", content: [{ type: "text", text: "done" }] }, false],
    ];
    for (const [what, name, input, toolUseResult, open] of cases) {
      const session = slug(what);
      const tr = ctx.transcript({ session });
      const now = Date.now();
      tr.prompt("백그라운드로 돌려줘", { at: now - 60_000 });
      const use = tr.toolUse(name, input, { at: now - 50_000 });
      tr.toolResult(use, "launched", { at: now - 49_900, toolUseResult });
      tr.endTurn();
      const file = ctx.write(`src/${session}.js`, "written by the background job\n");
      setMtime(file, now - 20_000); // long after the tool returned
      const r = ctx.stop({ transcript: tr, session });
      if (open) assertBlocked(r, { files: [`src/${session}.js`] });
      else assertAllowed(r, `${what}: its window closed 2 s after the result`);
      setMtime(file, now - 3_600_000); // out of every later case's window
    }
  });

  test("a tool_use without a tool_result (still running) is an open window up to now", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("생성기 돌려줘", { at: Date.now() - 20_000 });
    tr.toolUse("Bash", { command: "node gen.js", description: "Generate" }, { at: Date.now() - 10_000 });
    ctx.write("src/generated.js", "x\n");
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/generated.js"] });
  });

  test("a window tool that fails (Bash exit ≠ 0, is_error) keeps its window: the files written in it are counted", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("코드젠 돌리고 테스트해줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "Bash", "npm run codegen && npm test", () => ctx.write("src/generated.js", "generated\n"), { result: "Exit code 1\n1 failing", isError: true });
    ctx.during(tr, "Agent", { description: "Fix", prompt: "Fix the build", subagent_type: "general-purpose" }, () => ctx.write("src/agent-fix.js", "partial\n"), { result: "Agent failed: context limit", isError: true });
    // …while a failed Edit/Write changed nothing and is ignored
    ctx.claude(tr, "Write", "src/denied.js", { onDisk: false, isError: true, result: "The user doesn't want to proceed with this tool use." });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/generated.js", "src/agent-fix.js"] });
  });

  test("a file Claude edited and then renamed with `git mv` (Bash) is gated under its new name", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/old-name.js", "export const v = 0;\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("old-name.js 고치고 new-name.js로 이름 바꿔줘", { at: Date.now() - 60_000 });
    const abs = ctx.claude(tr, "Edit", "src/old-name.js", { content: "export const v = 1;\n" });
    setMtime(abs, tr.lastChangeAt); // the file was written when the Edit ran, well before the Bash call below
    ctx.during(tr, "Bash", "git mv src/old-name.js src/new-name.js", () => ctx.git(["mv", "src/old-name.js", "src/new-name.js"]));
    tr.endTurn();
    assert.match(ctx.git(["status", "--porcelain"]), /^R[ M] src\/old-name\.js -> src\/new-name\.js$/m, "precondition: a staged rename");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/new-name.js"], target: "uncommitted", lastChange: tr.lastChangeAt });
    assert.ok(!got.all.includes("src/old-name.js"), "the rename source is followed to its destination, not listed itself");
  });

  /** Edit src/old-name.js, then `git mv` + commit it in one Bash call; returns the block for the hint. */
  const MULTILINE = (v) => `${Array.from({ length: 12 }, (_, i) => `export const line${i} = ${i};`).join("\n")}\nexport const value = ${v};\n`;
  function renameAndCommitTurn(ctx, content = MULTILINE) {
    ctx.write("src/old-name.js", content(0));
    ctx.commitAll("base");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("고치고 이름 바꿔서 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Edit", "src/old-name.js", { content: content(1) });
    ctx.during(tr, "Bash", "git mv src/old-name.js src/new-name.js && git commit -qam rename", () => {
      ctx.git(["mv", "src/old-name.js", "src/new-name.js"]);
      ctx.commitAll("rename", { during: true });
    });
    tr.endTurn();
    return { tr, got: assertBlocked(ctx.stop({ transcript: tr }), { target: "committed" }) };
  }

  test("an edited file renamed with `git mv` and committed: the --base hint, run as written, satisfies the gate", (t) => {
    const ctx = sandbox(t);
    const { tr, got } = renameAndCommitTurn(ctx);
    assert.deepEqual(got.all, ["src/new-name.js"], "git log follows the rename like the review's diff -M does");
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), `the hinted review (${got.hint}) covers ${got.all.join(", ")}`);
  });

  test("with the user's git config diff.renames=false, the --base hint for a renamed + committed file still satisfies the gate", { todo: "BUG: commitsSince() runs `git log --name-only` without an explicit -M, so with diff.renames=false in the user's git config a rename commit lists the deleted source too and the gate names src/old-name.js; the hinted `--base` review always diffs with -M (git.mjs changedFiles), so its target-files.txt holds only src/new-name.js — running exactly the hinted review never satisfies the gate (it blocks again until the per-turn cap)" }, (t) => {
    const ctx = sandbox(t);
    fs.appendFileSync(path.join(ctx.dir, "gitconfig"), "[diff]\n\trenames = false\n");
    const { tr, got } = renameAndCommitTurn(ctx);
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), `the hinted review (${got.hint}) covers ${got.all.join(", ")}; it reviewed ${JSON.stringify(jobMeta(ctx, review).target.files)}`);
  });

  test("a window from an EARLIER turn does not count in this turn", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("생성해줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "Bash", "node gen.js", () => ctx.write("src/generated.js", "x\n"));
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/generated.js"] });
    tr.prompt("방금 뭐 했어?", { at: Date.now() + 1000 });
    tr.say("생성기를 돌렸습니다.");
    assertAllowed(ctx.stop({ transcript: tr }), "a question-only turn after a Bash turn");
  });

  test("without any window tool in the turn, a freshly modified dirty file that Claude did not edit is not counted", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("설명해줘", { at: Date.now() - 5000 });
    tr.read(path.join(ctx.repo, "README.md"));
    ctx.write("editor-save.js", "the user's editor saved this during the turn\n");
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "no window tools, no edit tools");
  });

  test("Edit tools and Bash in one turn: both kinds of change are named", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("수정하고 포맷 돌려줘", { at: Date.now() - 5000 });
    ctx.claude(tr, "Write", "src/a.js");
    ctx.during(tr, "Bash", "npx prettier --write src", () => ctx.write("src/b.js", "formatted\n"));
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"] });
  });

  test("a Bash call that only runs `coworker review|wait|ask|…` opens no window; shell metacharacters or another program open one", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const noWindow = [
      "coworker review --thread gate-1234abcd --uncommitted --paths-file .coworker/work/gate-1234abcd/paths.txt",
      "  coworker wait 20260926-100000-review-abcd --timeout 600",
      "/usr/local/bin/coworker status --json",
      "./node_modules/.bin/coworker jobs",
      "coworker ask --thread q --message 'is this right?'",
      "coworker plan --thread p --message-file plan.md",
      "coworker debate --thread d --stage open --brief b.md --claude-proposal c.md",
      "coworker threads show t",
      "coworker task-state slug --phase done",
      "coworker cancel 20260926-100000-review-abcd",
      "coworker mode always",
    ];
    const window = [
      "coworker review --uncommitted && npm run build",
      "coworker review --uncommitted; sed -i '' s/a/b/ src/x.js",
      "coworker review --paths $(git diff --name-only)",
      "coworker review --paths `git diff --name-only`",
      "coworker wait job | tee review.log",
      "coworker status > status.txt",
      "coworker review --uncommitted < /dev/null",
      "coworker review --uncommitted & npm run dev",
      "npx coworker review --uncommitted",
      "coworker install",
      "git commit -qam wip && coworker review --base HEAD~1",
    ];
    for (const [command, opens] of [...noWindow.map((c) => [c, false]), ...window.map((c) => [c, true])]) {
      const session = `c-${hex(4)}`;
      const tr = ctx.transcript({ session });
      tr.prompt("리뷰 돌려줘", { at: Date.now() - 20_000 });
      const rel = `src/${session}.js`;
      const file = path.join(ctx.repo, rel);
      ctx.during(tr, "Bash", command, () => ctx.write(rel, "saved while the command ran\n"));
      tr.endTurn();
      const r = ctx.stop({ transcript: tr, session });
      if (opens) assertBlocked(r, { files: [rel] });
      else assertAllowed(r, `\`${command}\` must not open a window`);
      setMtime(file, Date.now() - 3_600_000); // out of every later window
    }
  });

  test("the skills' own `coworker review --project \"${CLAUDE_PROJECT_DIR}\" …` invocation opens no window", { }, (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("리뷰 돌려줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "Bash", 'coworker review --project "${CLAUDE_PROJECT_DIR}" --thread login-review --message-file .coworker/work/login/review-brief.md', () => ctx.write("src/user-save.js", "saved by the user's editor while Astra reviewed\n"));
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "a coworker-only command, spelled the way the skills spell it");
  });

  test("a commit made inside a tool window counts even for files no edit tool named; one made outside every window does not", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "v0\n");
    ctx.write("src/user.js", "u0\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    const dated = (ms) => ({ GIT_COMMITTER_DATE: iso(ms), GIT_AUTHOR_DATE: iso(ms) });
    tr.prompt("포맷 돌리고 커밋해줘", { at: now - 60_000 });
    const use = tr.toolUse("Bash", { command: "npx prettier --write src/app.js && git commit -qam format", description: "Format and commit" }, { at: now - 50_000 });
    ctx.write("src/app.js", "v1 formatted\n");
    const sha = ctx.commitAll("format", { env: dated(now - 47_000) });
    tr.toolResult(use, "ok", { at: now - 45_000 }); // window [now − 52 s, now − 43 s]
    tr.say("완료");
    tr.endTurn();
    // the user commits their own file from another terminal later in the turn, outside every window
    ctx.write("src/user.js", "u1\n");
    ctx.commitAll("user work", { env: dated(now - 30_000) });
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js"], target: "committed" });
    assert.equal(got.base, sha.slice(0, 12));
    assert.ok(!got.all.includes("src/user.js"));
  });

  test("an edited file whose directory was removed again does not break the gate (repoTopOf walks up to an existing directory)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("임시 디렉터리로 실험하고 지워줘");
    ctx.claude(tr, "Write", "src/tmp/deep/x.js");
    ctx.claude(tr, "Write", "src/keep.js");
    const keptAt = tr.lastChangeAt;
    tr.bash("rm -r src/tmp");
    ctx.rm("src/tmp");
    ctx.claude(tr, "Write", "", { file: path.join(ctx.repo, "never", "created", "y.js"), onDisk: false }); // a path that never existed
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/keep.js"], lastChange: keptAt });
  });

  test("a path spelled with another letter case on a case-insensitive volume resolves to the file on disk", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/App.js", "v0\n");
    ctx.commitAll("base");
    if (!fs.existsSync(path.join(ctx.repo, "SRC", "APP.JS"))) return t.skip("case-sensitive file system");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("고쳐줘");
    ctx.claude(tr, "Edit", "", { file: path.join(ctx.repo, "SRC", "APP.JS"), content: "v1\n" });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/App.js"], lastChange: tr.lastChangeAt });
    const upper = path.join(ctx.dir, "REPO");
    assertBlocked(ctx.stop({ transcript: tr, projectDir: upper, session: "upper-project" }), { files: ["src/App.js"] });
  });

  test("a Bash window's last change is the newest file mtime, so the review must come after the files were written", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    tr.prompt("스크립트로 생성해줘", { at: now - 20_000 });
    const use = tr.toolUse("Bash", { command: "node scripts/gen.js", description: "Generate" }, { at: now - 10_000 });
    tr.toolResult(use, "ok", { at: now - 9_900 }); // window ends at now - 7.9 s
    tr.endTurn();
    const file = ctx.write("src/generated.js", "generated\n");
    setMtime(file, now - 8_000); // inside the window's tail, later than every transcript timestamp of the tool
    ctx.writeReview({ paths: ["src/generated.js"], createdAt: now - 9_500 }); // after the tool_result, before mtime − 1 s
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/generated.js"], lastChange: now - 8_000 });
    ctx.writeReview({ paths: ["src/generated.js"], createdAt: now - 8_500 }); // within 1 s before the mtime
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-2" }), "a review created ≥ newest mtime − 1 s");
  });

  test("a file in a nested repository changed inside a Bash window is gated", { todo: "BUG: evaluate()'s window scan only reads `git status` of the project's own repo (stateOf(mainTop)), which lists a nested repo / linked worktree inside the project as ONE directory entry (skipped: not a file), and nested repos are only visited for files named by edit tools — so `sed -i` / codegen inside .claude/worktrees/* or a vendored repo ends the turn unreviewed" }, (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const wt = path.join(ctx.repo, ".claude", "worktrees", "feat");
    ctx.git(["worktree", "add", "-q", "-b", "feat", wt]);
    setMtime(wt, Date.now() - 3_600_000); // isolate from the directory-entry bug below
    const tr = ctx.transcript();
    tr.prompt("워크트리에서 sed로 고쳐줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "Bash", `sed -i '' s/sandbox/changed/ ${path.join(wt, "README.md")}`, () => ctx.write("README.md", "# changed\n", wt));
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: [".claude/worktrees/feat/README.md"], target: "paths" });
  });

  test("a Bash window that creates a file in a nested repository does not gate the nested repo's DIRECTORY", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const wt = path.join(ctx.repo, ".claude", "worktrees", "feat");
    ctx.git(["worktree", "add", "-q", "-b", "feat", wt]);
    setMtime(wt, Date.now() - 3_600_000);
    const tr = ctx.transcript();
    tr.prompt("워크트리에 파일 만들어줘", { at: Date.now() - 20_000 });
    ctx.during(tr, "Bash", `touch ${path.join(wt, "new.txt")}`, () => ctx.write("new.txt", "x\n", wt));
    tr.endTurn();
    assert.ok(fs.statSync(wt).mtimeMs > Date.now() - 60_000, "precondition: the nested repo's directory mtime lies inside the window");
    const r = ctx.stop({ transcript: tr });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.stderr, "", r.dump());
    if (r.decision) {
      const got = parseReason(r.decision.reason);
      assert.ok(!got.listed.includes(".claude/worktrees/feat"), `the nested repo directory was named as a changed file: ${got.listed.join(", ")} (${got.hint})`);
    }
  });
});

// ================================================================== stop gate: once per change set, twice per turn, stop_hook_active, state

describe("hook stop: once per change set, at most twice per turn", () => {
  test("the same change set is asked about once; a new edit in the same turn after the block blocks again; the next turn is gated again", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const first = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], lastChange: tr.lastChangeAt });
    assertAllowed(ctx.stop({ transcript: tr }), "second stop, same change set");
    assertAllowed(ctx.stop({ transcript: tr }), "third stop, same change set");
    // Claude keeps working in the SAME turn (e.g. it ignored the gate) and changes another file
    ctx.claude(tr, "Write", "src/b.js", { at: tr.clock + 5000 });
    tr.endTurn();
    const second = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"], lastChange: tr.lastChangeAt });
    assert.notEqual(second.thread, first.thread, "a new change set gets a new gate thread");
    assertAllowed(ctx.stop({ transcript: tr }), "the grown change set is asked about once too");
    // next turn
    codingTurn(ctx, tr, [["Write", "src/c.js"]], { prompt: "다음 것도 해줘" });
    const third = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/c.js"], lastChange: tr.lastChangeAt });
    assert.deepEqual(ctx.state().gatedKeys.map((key) => `gate-${key.slice(0, 8)}`), [first.thread, second.thread, third.thread]);
    // gating is per session: the same transcript under another session id is asked again
    assertBlocked(ctx.stop({ transcript: tr, session: "sess-other" }), { files: ["src/c.js"] });
  });

  test("re-editing the SAME file later in the turn is a new change set (the last change moved)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("고쳐줘");
    ctx.claude(tr, "Edit", "src/a.js");
    tr.endTurn();
    const first = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], lastChange: tr.lastChangeAt });
    ctx.claude(tr, "Edit", "src/a.js", { at: tr.clock + 5000 });
    tr.endTurn();
    const second = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], lastChange: tr.lastChangeAt });
    assert.notEqual(second.thread, first.thread);
    assertAllowed(ctx.stop({ transcript: tr }), "unchanged since the second block");
  });

  test("stop_hook_active is ignored (other plugins' Stop hooks set it too): an unreviewed change set is still gated once", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    assertBlocked(ctx.stop({ transcript: tr, active: true }), { files: ["src/a.js"] });
    assert.equal(ctx.state().gatedKeys.length, 1, "recorded like any other block");
    assertAllowed(ctx.stop({ transcript: tr, active: true }), "the same change set, again with stop_hook_active");
    assertAllowed(ctx.stop({ transcript: tr, active: false }), "…and without it");
    ctx.claude(tr, "Write", "src/b.js", { at: tr.clock + 5000 });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr, active: true }), { files: ["src/a.js", "src/b.js"] });
    // a reviewed change set passes whatever stop_hook_active says
    ctx.writeReview({ paths: ["src/a.js", "src/b.js"], createdAt: tr.lastChangeAt + 1000 });
    assertAllowed(ctx.stop({ transcript: tr, active: true, session: "fresh" }), "reviewed");
  });

  /**
   * Claude runs `command` in a Bash window per cycle, a review covering public/ + src/ is created inside it,
   * and a watcher rewrites public/dev-bundle.js AFTER that job was created. Returns how many stops blocked.
   */
  function watcherLoop(ctx, tr, command, { now, cycles = 6 }) {
    const out = ctx.write("public/dev-bundle.js", "rebuilt by the watcher\n"); // not ignored, rewritten every second by `npm run dev`
    setMtime(out, now - 3_600_000);
    let blocks = 0;
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const start = now - 100_000 + cycle * 15_000;
      const use = tr.toolUse("Bash", { command, description: "Astra review" }, { at: start });
      ctx.writeReview({ paths: ["public", "src"], createdAt: start + 1000 });
      tr.toolResult(use, "COWORKER status=succeeded", { at: start + 10_000 });
      setMtime(out, start + 5000);
      tr.endTurn();
      const r = ctx.stop({ transcript: tr });
      assert.equal(r.code, 0, r.dump());
      if (!r.decision) break;
      blocks += 1;
    }
    return blocks;
  }

  test("a background writer touching a file during every Bash window cannot keep the gate blocking: at most 2 blocks per turn", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    const turn = tr.prompt("dev 서버 띄운 상태에서 컴포넌트 고쳐줘", { at: now - 120_000 });
    ctx.claude(tr, "Edit", "src/component.js", { at: now - 110_000 });
    // `npm test` after each review is a real window, so the watcher's output lands in every one of them
    const blocks = watcherLoop(ctx, tr, "coworker review --thread gate-x --uncommitted && npm test", { now });
    assert.equal(blocks, 2, "every stop is a NEW change set, but the per-turn cap stops the loop after 2 blocks");
    const state = ctx.state();
    assert.deepEqual(state.turnBlocks, { [turn.uuid]: 2 });
    assert.equal(state.gatedKeys.length, 2);
  });

  test("a plain `coworker review …` Bash call is not a window, so a watcher writing during it is never attributed to Claude", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const now = Date.now();
    tr.prompt("dev 서버 띄운 상태에서 컴포넌트 고쳐줘", { at: now - 120_000 });
    ctx.claude(tr, "Edit", "src/component.js", { at: now - 110_000 });
    assert.equal(watcherLoop(ctx, tr, "coworker review --thread gate-x --uncommitted --paths-file .coworker/work/gate-x/paths.txt", { now }), 0, "the first review covers the edit; the watcher output is not Claude's");
    assertOnlyLastStop(ctx);
  });

  test("at most 2 blocks per turn: a third new change set in the same turn passes; turnBlocks is keyed by the prompt's uuid; the next turn starts over", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const turn1 = tr.prompt("고쳐줘");
    ctx.claude(tr, "Write", "src/a.js");
    tr.endTurn();
    const first = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], lastChange: tr.lastChangeAt });
    ctx.claude(tr, "Write", "src/b.js", { at: tr.clock + 5000 });
    tr.endTurn();
    const second = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"], lastChange: tr.lastChangeAt });
    ctx.claude(tr, "Write", "src/c.js", { at: tr.clock + 5000 });
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "the third new change set of one turn passes (loop breaker)");
    let state = ctx.state();
    assert.deepEqual(state.turnBlocks, { [turn1.uuid]: 2 });
    assert.deepEqual(state.gatedKeys.map((key) => `gate-${key.slice(0, 8)}`), [first.thread, second.thread], "the capped change set is not recorded as asked");
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker", "work", `gate-${gateKey(["src/a.js", "src/b.js", "src/c.js"], tr.lastChangeAt).slice(0, 8)}`)), "no paths file for a capped stop");
    // the next turn is gated again
    const turn2 = tr.prompt("다음 것도 해줘");
    ctx.claude(tr, "Write", "src/d.js");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/d.js"], lastChange: tr.lastChangeAt });
    state = ctx.state();
    assert.deepEqual(state.turnBlocks, { [turn1.uuid]: 2, [turn2.uuid]: 1 });
  });

  test("turnBlocks from the state file: 2 for this turn passes, 1 allows one more block, a wrong shape is ignored, old turns are pruned to 20", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const env = { CLAUDE_PROJECT_DIR: ctx.repo };
    const tr = ctx.transcript();
    const turn = codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const input = (session) => ({ session_id: session, transcript_path: tr.file, cwd: ctx.repo, hook_event_name: "Stop", stop_hook_active: false });

    ctx.writeState("capped", { turnBlocks: { [turn.uuid]: 2 } });
    assert.equal(auto.onStop(input("capped"), env), null, "this turn already blocked twice");
    assert.equal(ctx.state("capped").gatedKeys, undefined, "a capped stop records no key");
    assert.deepEqual(ctx.state("capped").turnBlocks, { [turn.uuid]: 2 });

    ctx.writeState("one-left", { turnBlocks: { [turn.uuid]: 1, "other-turn": 2 } });
    assert.equal(auto.onStop(input("one-left"), env)?.decision, "block");
    assert.deepEqual(ctx.state("one-left").turnBlocks, { "other-turn": 2, [turn.uuid]: 2 });

    for (const bad of [[1, 2], "x", 7, null]) {
      ctx.writeState("bad-shape", { turnBlocks: bad });
      assert.equal(auto.onStop(input("bad-shape"), env)?.decision, "block", `turnBlocks ${JSON.stringify(bad)}`);
      assert.deepEqual(ctx.state("bad-shape").turnBlocks, { [turn.uuid]: 1 }, `turnBlocks ${JSON.stringify(bad)} is replaced`);
    }

    const old = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`turn-${String(i).padStart(2, "0")}`, 1]));
    ctx.writeState("pruned", { turnBlocks: old });
    assert.equal(auto.onStop(input("pruned"), env)?.decision, "block");
    const kept = ctx.state("pruned").turnBlocks;
    assert.deepEqual(Object.keys(kept), [...Object.keys(old).slice(-20), turn.uuid], "the 20 most recent turns + this one");
  });

  test("every always-mode stop records state.lastStopAt (ms), allowed or blocked; it moves forward on each stop", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("설명해줘");
    tr.say("설명");
    let before = Date.now();
    assertAllowed(ctx.stop({ transcript: tr }), "question only");
    const first = assertOnlyLastStop(ctx, { since: before }).lastStopAt;
    ctx.claude(tr, "Write", "src/a.js");
    tr.endTurn();
    before = Date.now();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"] });
    const second = ctx.state().lastStopAt;
    assert.ok(second >= before && second >= first, `lastStopAt moved: ${first} → ${second}`);
    before = Date.now();
    assertAllowed(ctx.stop({ transcript: tr }), "asked once");
    assert.ok(ctx.state().lastStopAt >= before);
    assert.equal(ctx.state().gatedKeys.length, 1, "an allowed stop adds no key");
    // other keys of the state survive a plain allowed stop
    ctx.writeState("keep", { other: "kept", gatedKeys: ["abc"] });
    tr.prompt("질문");
    tr.say("답");
    assertAllowed(ctx.stop({ transcript: tr, session: "keep" }));
    const kept = ctx.state("keep");
    assert.equal(kept.other, "kept");
    assert.deepEqual(kept.gatedKeys, ["abc"]);
    assert.equal(typeof kept.lastStopAt, "number");
  });

  test("gatedKeys keeps the 50 most recent keys; a remembered key passes; a corrupt state file is replaced", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const env = { CLAUDE_PROJECT_DIR: ctx.repo };
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const key = gateKey(["src/a.js"], tr.lastChangeAt);
    const input = (session, extra = {}) => ({ session_id: session, transcript_path: tr.file, cwd: ctx.repo, hook_event_name: "Stop", stop_hook_active: false, ...extra });

    const fake = Array.from({ length: 50 }, () => hex(6));
    ctx.writeState("preloaded", { gatedKeys: fake, lastGateAt: "2026-01-01T00:00:00.000Z", other: "kept" });
    const decision = auto.onStop(input("preloaded"), env);
    assert.equal(decision?.decision, "block");
    assert.ok(decision.reason.includes(`\`gate-${key.slice(0, 8)}\``), decision.reason);
    const state = ctx.state("preloaded");
    assert.deepEqual(state.gatedKeys, [...fake.slice(1), key]);
    assert.equal(state.other, "kept", "unknown state keys survive");
    assert.ok(Date.parse(state.lastGateAt) > Date.parse("2026-01-01T00:00:00.000Z"));

    ctx.writeState("remembered", { gatedKeys: [key] });
    assert.equal(auto.onStop(input("remembered"), env), null, "a change set already asked about passes");
    ctx.writeState("remembered-active", { gatedKeys: [key] });
    assert.equal(auto.onStop(input("remembered-active", { stop_hook_active: true }), env), null);

    ctx.writeState("legacy", { gatedTurns: [tr.turn.uuid] });
    assert.equal(auto.onStop(input("legacy"), env)?.decision, "block", "a v2 gatedTurns entry does not suppress the v4 gate");
    assert.deepEqual(ctx.state("legacy").gatedKeys, [key]);

    for (const bad of ["{torn", "null", "", JSON.stringify({ gatedKeys: "not an array" }), JSON.stringify({ gatedKeys: null })]) {
      ctx.writeState("corrupt", bad);
      assert.equal(auto.onStop(input("corrupt"), env)?.decision, "block", `state ${bad}`);
      assert.deepEqual(ctx.state("corrupt").gatedKeys, [key], `state ${bad}`);
      assert.equal(auto.onStop(input("corrupt"), env), null, `state ${bad}: asked once`);
    }
  });

  test("a state file holding a JSON array or scalar is replaced: no endless blocking, no silent fail-open", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    for (const bad of ["[]", JSON.stringify(["x"]), "42", "\"text\"", "true", "false", "0"]) {
      const session = `bad-${slug(bad) || "x"}-${hex(2)}`;
      ctx.writeState(session, bad);
      assertBlocked(ctx.stop({ transcript: tr, session }), { files: ["src/a.js"] });
      const state = ctx.state(session);
      assert.ok(state && typeof state === "object" && !Array.isArray(state), `state ${bad} was replaced by an object: ${JSON.stringify(state)}`);
      assertAllowed(ctx.stop({ transcript: tr, session }), `state ${bad}: the same change set must be asked about once`);
    }
  });

  test("the session id cannot steer the state file outside .coworker/auto", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    assertBlocked(ctx.stop({ transcript: tr, session: "../../escape" }), { files: ["src/a.js"] });
    assert.deepEqual(fs.readdirSync(path.join(ctx.repo, ".coworker", "auto")), ["______escape.json"]);
    assert.ok(!fs.existsSync(path.join(ctx.dir, "escape.json")) && !fs.existsSync(path.join(ctx.repo, "escape.json")));
  });
});

// ================================================================== stop gate: review jobs

describe("hook stop: reviews started after the last change that together cover the files satisfy the gate", () => {
  test("a succeeded covering review created after the last change lets the turn end; it is not recorded as gated", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"], ["Edit", "README.md"]]);
    const at = tr.lastChangeAt + 5000;
    ctx.writeReview({ paths: ["README.md", "src/a.js"], createdAt: at, status: { state: "succeeded", updatedAt: iso(at), finishedAt: iso(at) } });
    assertAllowed(ctx.stop({ transcript: tr }), "reviewed after the last change");
    assertOnlyLastStop(ctx);
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker", "work")), "no paths file when the stop is allowed");
    // Claude edits again after that review → gated
    ctx.claude(tr, "Edit", "src/a.js", { at: at + 10_000 });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "README.md"], lastChange: tr.lastChangeAt });
  });

  test("a succeeded review of OTHER files (or of only some of them) does not satisfy the gate", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"], ["Write", "src/b.js"]]);
    const at = tr.lastChangeAt + 3000;
    const many = (n) => Array.from({ length: n }, (_, i) => `gen/x${String(i).padStart(3, "0")}.js`);
    const cases = [
      ["other files", { paths: ["src/other.js"] }],
      ["a subset", { paths: ["src/a.js"] }],
      ["a sibling prefix", { paths: ["src/a"] }],
      ["files only in target.files, other files", { paths: [], files: ["src/other.js"] }],
      ["an unscoped review listing 199 other files", { paths: [], files: many(199) }],
      // v4 has no "≥ 200 files ⇒ unscoped, covers everything" shortcut: only the listed files count
      ["an unscoped uncommitted review listing 200 other files", { paths: [], files: many(200) }],
      ["an unscoped --base review listing 250 other files", { paths: [], mode: "base", files: many(250) }],
      ["an unscoped --commit review with ≥ 200 other files", { paths: [], mode: "commit", files: many(200) }],
      ["a scoped review with ≥ 200 other files", { paths: ["gen"], files: many(200) }],
      // an older job without target-files.txt: meta keeps only the first 200 names, the rest are unknown
      ["meta truncated at 200 (fileCount 202), no target-files.txt", { paths: [], files: [...many(200), "src/a.js", "src/b.js"], targetFiles: null }],
      // target-files.txt (the full list) wins over meta.target.files
      ["meta.target.files names them but target-files.txt does not", { paths: [], files: ["src/a.js", "src/b.js"], targetFiles: ["src/other.js"] }],
    ];
    for (const [what, target] of cases) {
      ctx.clearJobs();
      ctx.writeReview({ ...target, createdAt: at });
      assertBlocked(ctx.stop({ transcript: tr, session: slug(what) }), { files: ["src/a.js", "src/b.js"] });
    }
  });

  test("coverage: exact paths, a parent directory, repo-relative target.files, the full target-files.txt list (> 200 files), paths against reviewCwd", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"], ["Write", "src/lib/b.js"]]);
    const at = tr.lastChangeAt + 3000;
    const many = Array.from({ length: 200 }, (_, i) => `gen/x${String(i).padStart(3, "0")}.js`);
    const cases = [
      ["exact paths", { paths: ["src/lib/b.js", "src/a.js"] }],
      ["parent directory", { paths: ["src"] }],
      ["paths split between paths and files", { paths: ["src/a.js"], files: ["src/lib/b.js"] }],
      ["unscoped review listing the files", { paths: [], files: ["src/a.js", "src/lib/b.js", "README.md"] }],
      // meta keeps the first 200 names only; the job's target-files.txt has all 202
      ["unscoped uncommitted review of 202 files (full list in target-files.txt)", { paths: [], files: [...many, "src/a.js", "src/lib/b.js"] }],
      ["unscoped base review of 202 files (full list in target-files.txt)", { paths: [], mode: "base", files: [...many, "src/a.js", "src/lib/b.js"] }],
      ["an older job without target-files.txt whose meta lists the files", { paths: [], files: ["src/a.js", "src/lib/b.js"], targetFiles: null }],
      ["paths-mode review (non-git style)", { paths: ["src/a.js", "src/lib/b.js"], mode: "paths" }],
      ["paths relative to a subdirectory reviewCwd", { paths: ["a.js", "lib"], files: [], meta: { reviewCwd: path.join(ctx.repo, "src") } }],
      ["no reviewCwd: paths resolve against the project", { paths: ["src/a.js", "src/lib/b.js"], mode: "paths", meta: { reviewCwd: undefined } }],
    ];
    for (const [what, target] of cases) {
      ctx.clearJobs();
      ctx.writeReview({ ...target, createdAt: at });
      assertAllowed(ctx.stop({ transcript: tr, session: slug(what) }), what);
    }
  });

  test("coverage is the UNION of qualifying reviews: two scoped reviews together cover the change set; a non-qualifying one does not help", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"], ["Write", "src/b.js"], ["Write", "lib/c.js"]]);
    const at = tr.lastChangeAt + 3000;
    const now = new Date().toISOString();
    const running = { state: "created", launcherPid: process.pid, updatedAt: now };
    const cases = [
      ["two succeeded reviews", true, [{ paths: ["src"] }, { paths: ["lib/c.js"] }]],
      ["three single-file reviews", true, [{ paths: ["src/a.js"] }, { paths: ["src/b.js"] }, { paths: ["lib/c.js"] }]],
      ["a succeeded and a running review", true, [{ paths: ["src"] }, { paths: ["lib"], status: running }]],
      ["a --paths-file review and an unscoped one listing the rest", true, [{ paths: ["src/a.js"], mode: "paths" }, { paths: [], files: ["src/b.js", "lib/c.js"] }]],
      ["a covering review plus a malformed one in between", true, [{ paths: ["src"] }, { kind: "broken" }, { paths: ["lib/c.js"] }]],
      ["one part reviewed, the other only by a FAILED review", false, [{ paths: ["src"] }, { paths: ["lib/c.js"], status: { state: "failed", error: "boom" } }]],
      ["one part reviewed, the other only BEFORE the last change", false, [{ paths: ["src"] }, { paths: ["lib/c.js"], createdAt: tr.lastChangeAt - 2000 }]],
      ["one part reviewed, the other only by an ask job", false, [{ paths: ["src"] }, { kind: "ask", paths: ["lib/c.js"] }]],
      ["two reviews that each miss src/b.js", false, [{ paths: ["src/a.js"] }, { paths: ["lib"] }]],
    ];
    for (const [what, covered, jobs] of cases) {
      ctx.clearJobs();
      for (const job of jobs) {
        if (job.kind === "broken") ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: { target: { mode: "uncommitted", paths: 5, files: { x: 1 }, repoTop: 7 }, reviewCwd: [] } });
        else if (job.kind === "ask") ctx.writeJob({ kind: "ask", createdAt: at, status: { state: "succeeded" }, meta: { target: reviewTarget(job.paths), reviewCwd: ctx.repo } });
        else ctx.writeReview({ createdAt: at, ...job });
      }
      const r = ctx.stop({ transcript: tr, session: slug(what) });
      if (covered) assertAllowed(r, what);
      else assertBlocked(r, { files: ["src/a.js", "src/b.js", "lib/c.js"] });
    }
  });

  test("a review created shortly (< 1 s) before the last edit's transcript time still counts; 2 s before does not", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const id = ctx.writeReview({ paths: ["src/a.js"], createdAt: tr.lastChangeAt - 500 });
    assertAllowed(ctx.stop({ transcript: tr }), "within the 1 s tolerance");
    ctx.clearJobs();
    ctx.writeReview({ paths: ["src/a.js"], createdAt: tr.lastChangeAt - 2000, jobId: id });
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"] });
  });

  test("the edit time is the tool_result line (the edit finished), not the tool_use line", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("구현해줘");
    const abs = path.join(ctx.repo, "src", "a.js");
    const use = tr.toolUse("Write", { file_path: abs, content: "x" });
    ctx.write("src/a.js", "x\n");
    tr.toolResult(use, `File created successfully at: ${abs}`, { at: tr.clock + 30_000 }); // permission prompt waited 30 s
    tr.endTurn();
    ctx.writeReview({ paths: ["src/a.js"], createdAt: Date.parse(use.entry.timestamp) + 5000 });
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], lastChange: tr.lastChangeAt });
  });

  test("a review created BEFORE the last change never counts, whatever its state", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("구현해줘");
    ctx.claude(tr, "Write", "src/a.js");
    const reviewAt = tr.lastChangeAt + 2000;
    ctx.writeReview({ paths: ["src/a.js", "src/b.js"], createdAt: reviewAt });
    ctx.claude(tr, "Edit", "src/b.js", { at: reviewAt + 5000 }); // fix after the review, no re-review
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"] });
  });

  test("failed, crashed and other terminal non-success reviews do not satisfy the gate", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const at = tr.lastChangeAt + 3000;
    for (const state of TERMINAL.filter((s) => s !== "succeeded")) {
      ctx.clearJobs();
      ctx.writeReview({ paths: ["src/a.js"], createdAt: at, status: { state, updatedAt: iso(at), finishedAt: iso(at), error: "boom" } });
      assertBlocked(ctx.stop({ transcript: tr, session: `s-${state}` }), { files: ["src/a.js"] });
    }
    // one failed and one succeeded review after the change: the succeeded one counts
    ctx.writeReview({ paths: ["src/a.js"], createdAt: at + 1000 });
    assertAllowed(ctx.stop({ transcript: tr, session: "s-mixed" }), "a later succeeded review");
  });

  test("a running review suppresses the gate: just created (startup grace) or under a live supervisor; a dead supervisor does not", async (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const at = tr.lastChangeAt + 3000;
    const now = new Date().toISOString();

    // 1) just launched: "created", no supervisor yet, inside the startup grace period
    ctx.writeReview({ paths: ["src/a.js"], createdAt: at, status: { state: "created", launcherPid: process.pid, updatedAt: now } });
    assertAllowed(ctx.stop({ transcript: tr }), "review just launched");
    ctx.clearJobs();

    // 2) running under a live supervisor whose argv carries the job id
    const jobId = `20260926-100001-review-${hex(4)}`;
    const supervisor = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", jobId], { stdio: "ignore" });
    ctx.trackPid(supervisor.pid);
    await sleep(150);
    ctx.writeReview({ jobId, paths: ["src/a.js"], createdAt: at, status: { state: "running", supervisorPid: supervisor.pid, startedAt: iso(at), updatedAt: iso(at) } });
    assertAllowed(ctx.stop({ transcript: tr }), "review running under a live supervisor");

    // 3) the supervisor dies: reconcile settles the job as interrupted and the gate fires
    supervisor.kill("SIGKILL");
    await sleep(150);
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"] });
    assert.equal(ctx.jobStatus(jobId).state, "interrupted");

    // 4) "created" long ago and never acknowledged: settled as interrupted, gate fires (new session)
    ctx.clearJobs();
    const old = iso(Date.now() - 10 * 60_000);
    const stale = ctx.writeReview({ paths: ["src/a.js"], createdAt: at, status: { state: "created", launcherPid: 999999, updatedAt: old } });
    assertBlocked(ctx.stop({ transcript: tr, session: "sess-2" }), { files: ["src/a.js"] });
    assert.equal(ctx.jobStatus(stale).state, "interrupted");
  });

  test("only REVIEW jobs count: ask / plan / debate jobs after the change do not satisfy the gate", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const at = tr.lastChangeAt + 3000;
    const now = new Date().toISOString();
    for (const kind of ["ask", "plan", "debate", "rereview", "Review"]) {
      ctx.clearJobs();
      ctx.writeJob({ kind, createdAt: at, status: { state: "succeeded" }, meta: { target: reviewTarget(["src/a.js"]) } });
      ctx.writeJob({ kind, createdAt: at, status: { state: "created", launcherPid: process.pid, updatedAt: now }, meta: { target: reviewTarget(["src/a.js"]) } });
      assertBlocked(ctx.stop({ transcript: tr, session: `s-${kind}` }), { files: ["src/a.js"] });
    }
  });

  test("broken review jobs are ignored: no status, corrupt status or meta, missing createdAt or target, stray files", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const at = tr.lastChangeAt + 3000;
    ctx.writeJob({ kind: "review", createdAt: at, meta: { target: reviewTarget(["src/a.js"]) } }); // no status.json
    ctx.writeReview({ paths: ["src/a.js"], createdAt: at, status: "{torn" }); // corrupt status.json
    ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: "{torn" });
    ctx.writeReview({ paths: ["src/a.js"], status: { state: "succeeded" } }); // meta without createdAt
    ctx.writeReview({ paths: ["src/a.js"], createdAt: at, meta: { createdAt: "not a date" } });
    ctx.writeReview({ paths: ["src/a.js"], createdAt: at, jobId: "bad.name" }); // not a valid job id
    ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" } }); // no target at all
    ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: { target: { mode: "uncommitted", paths: [], files: [] } } }); // empty target
    fs.writeFileSync(path.join(ctx.repo, ".coworker", "jobs", "README.txt"), "stray file\n");
    const r = ctx.stop({ transcript: tr });
    assertBlocked(r, { files: ["src/a.js"] });
  });

  test("a review job whose meta.target has the wrong shape does not disable the gate", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const at = tr.lastChangeAt + 3000;
    ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: { target: { mode: "uncommitted", paths: "src/a.js", files: 7 } } });
    ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: { target: "src/a.js", reviewCwd: 42 } });
    ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: { target: { mode: "uncommitted", paths: [null, 3, {}], files: [["src/a.js"]], repoTop: {} } } });
    const odd = ctx.writeJob({ kind: "review", createdAt: at, status: { state: "succeeded" }, meta: { target: { mode: "uncommitted", paths: [], files: [] } } });
    fs.mkdirSync(path.join(ctx.repo, ".coworker", "jobs", odd, "target-files.txt")); // unreadable full list (a directory)
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"] });
    // …and a good review next to them still counts
    ctx.writeReview({ paths: ["src/a.js"], createdAt: at });
    assertAllowed(ctx.stop({ transcript: tr, session: "with-good-review" }), "the malformed jobs are skipped, not fatal");
  });

  test("a review job that THROWS while its status is reconciled is skipped: the gate still blocks and still counts the other jobs", (t) => {
    if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"], ["Write", "lib/b.js"]]);
    const at = tr.lastChangeAt + 3000;
    // "running" under a dead supervisor: reconcile() settles it by writing status.json, which fails here
    const stuck = ctx.writeReview({ paths: ["src/a.js", "lib/b.js"], createdAt: at, status: { state: "running", supervisorPid: 999_999, startedAt: iso(at), updatedAt: iso(at) } });
    const dir = path.join(ctx.repo, ".coworker", "jobs", stuck);
    fs.chmodSync(dir, 0o500);
    try {
      const probe = spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "probe"))}, "x")`], { encoding: "utf8" });
      if (probe.status === 0) return t.skip("this filesystem ignores directory permissions");
      assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "lib/b.js"] });
      ctx.writeReview({ paths: ["src/a.js"], createdAt: at });
      ctx.writeReview({ paths: ["lib/b.js"], createdAt: at });
      assertAllowed(ctx.stop({ transcript: tr, session: "with-good-reviews" }), "the other jobs still form a covering union");
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  test("monorepo: with CLAUDE_PROJECT_DIR = packages/app, repo-root-relative target.files and project-relative target.paths both cover", (t) => {
    const ctx = sandbox(t);
    ctx.write("packages/app/src/index.js", "export const app = 1;\n");
    ctx.commitAll("monorepo");
    const app = path.join(ctx.repo, "packages", "app");
    ctx.setLevel("always", { projectDir: app });
    const tr = ctx.transcript({ cwd: app });
    tr.prompt("앱 고쳐줘", { at: Date.now() - 20_000 });
    ctx.claude(tr, "Edit", "packages/app/src/index.js", { content: "export const app = 2;\n" });
    ctx.claude(tr, "Write", "packages/app/src/new.js");
    tr.endTurn();
    const at = tr.lastChangeAt + 2000;
    const cases = [
      ["unscoped review: git diff names are repo-root relative", { paths: [], files: ["packages/app/src/index.js", "packages/app/src/new.js"] }],
      ["scoped review: paths project relative, files repo-root relative", { paths: ["src/index.js", "src/new.js"], files: ["packages/app/src/index.js", "packages/app/src/new.js"] }],
      ["paths-file review of the package dir", { paths: ["src"], files: [] }],
    ];
    for (const [what, target] of cases) {
      ctx.clearJobs(app);
      ctx.writeReview({ ...target, createdAt: at, projectDir: app });
      assertAllowed(ctx.stop({ transcript: tr, projectDir: app, session: slug(what) }), what);
    }
    const misses = [
      ["another package", { paths: [], files: ["packages/lib/src/index.js"] }],
      // without meta.target.repoTop the (repo-root relative) names resolve against reviewCwd = the package
      ["repo-root-relative files without repoTop", { paths: [], files: ["packages/app/src/index.js", "packages/app/src/new.js"], repoTop: null }],
    ];
    for (const [what, target] of misses) {
      ctx.clearJobs(app);
      ctx.writeReview({ ...target, createdAt: at, projectDir: app });
      assertBlocked(ctx.stop({ transcript: tr, projectDir: app, session: slug(what) }), { files: ["src/index.js", "src/new.js"] });
    }
  });
});

// ================================================================== stop gate: transcript robustness

describe("hook stop: transcript shapes and robustness", () => {
  test("a missing, unreadable, empty or garbled transcript lets the turn end silently (fail open)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]); // unreviewed change on disk
    const dirPath = path.join(ctx.dir, "transcripts");
    const cases = {
      "no transcript_path": null,
      "empty transcript_path": "",
      "nonexistent file": path.join(dirPath, "missing.jsonl"),
      "a directory": dirPath,
      "empty file": ctx.write("empty.jsonl", "", dirPath),
      "whitespace only": ctx.write("ws.jsonl", "\n\n   \n\t\n", dirPath),
      "binary garbage": ctx.write("garbage.jsonl", crypto.randomBytes(4096), dirPath),
      "non-object JSON lines": ctx.write("scalars.jsonl", "null\n42\n\"str\"\n[]\ntrue\n{}\n", dirPath),
      "no user prompt at all": ctx.write("noprompt.jsonl", `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path.join(ctx.repo, "src", "a.js") } }] }, timestamp: iso(Date.now()) })}\n`, dirPath),
      "user entries without message": ctx.write("nomsg.jsonl", `${JSON.stringify({ type: "user", uuid: "u1" })}\n${JSON.stringify({ type: "user", message: { content: null } })}\n`, dirPath),
    };
    for (const [what, file] of Object.entries(cases)) {
      assertAllowed(ctx.stop({ transcriptPath: file, session: slug(what) }), what);
    }
    if (process.getuid?.() !== 0) {
      const locked = ctx.write("locked.jsonl", fs.readFileSync(tr.file), dirPath);
      fs.chmodSync(locked, 0o000);
      try {
        assertAllowed(ctx.stop({ transcriptPath: locked }), "unreadable transcript");
      } finally {
        fs.chmodSync(locked, 0o644);
      }
    }
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker", "auto")), "nothing recorded when the transcript is unusable");
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"] }); // sanity: the real transcript still gates
  });

  test("a torn last line (Claude Code still writing) and a corrupt middle line are tolerated", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("구현해줘");
    ctx.claude(tr, "Write", "src/a.js");
    tr.raw('{"parentUuid":"x","type":"assistant","message":{"content":[{"type":"tool_use","na\n'); // corrupt middle line
    ctx.claude(tr, "Edit", "README.md");
    const full = JSON.stringify({ ...tr.common(), type: "assistant", uuid: crypto.randomUUID(), timestamp: iso(tr.clock + 400), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_torn", name: "Write", input: { file_path: path.join(ctx.repo, "src", "torn.js"), content: "x" } }] } });
    tr.raw(full.slice(0, Math.floor(full.length * 0.8))); // no newline, cut mid-object
    ctx.write("src/torn.js", "written by the tool whose line is still being flushed\n");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "README.md"] });
    assert.ok(!got.listed.includes("src/torn.js"));
  });

  test("CRLF line endings and a trailing line without newline are parsed", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const crlf = ctx.write("crlf.jsonl", fs.readFileSync(tr.file, "utf8").replace(/\n/g, "\r\n").replace(/\r\n$/, ""), path.join(ctx.dir, "transcripts"));
    assertBlocked(ctx.stop({ transcriptPath: crlf }), { files: ["src/a.js"] });
  });

  test("isMeta user lines, tool_result lines, attachments (incl. queued commands) and system lines are not turn boundaries", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("<command-message>coworker:task</command-message>\n<command-name>/coworker:task</command-name>\n<command-args>로그인 구현</command-args>");
    tr.meta([{ type: "text", text: "Base directory for this skill: /plugins/coworker/skills/task\n\n# coworker:task …" }], { turnCompanion: true });
    ctx.claude(tr, "Write", "src/a.js");
    tr.meta("<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>");
    tr.meta("Stop hook feedback:\n[node coworker.mjs hook stop]: please review");
    tr.bash("npm test", { result: "1 passing" });
    tr.attachment({ type: "queued_command", prompt: "그리고 테스트도 추가해줘", commandMode: "prompt" });
    tr.attachment({ type: "edited_text_file", filename: path.join(ctx.repo, "src", "a.js"), snippet: "…" });
    tr.system("informational", { content: "note" });
    tr.system("stop_hook_summary", { hookCount: 1, hookInfos: [], hookErrors: [], preventedContinuation: false, stopReason: "" });
    tr.append({ type: "custom-title", customTitle: "로그인", sessionId: tr.sessionId });
    tr.append({ type: "agent-name", agentName: "x", sessionId: tr.sessionId });
    tr.meta([{ type: "text", text: "meta text" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
    ctx.claude(tr, "Edit", "src/b.js");
    tr.say("완료");
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"], lastChange: tr.lastChangeAt });
  });

  test("a slash-command prompt, a text prompt, an image-only prompt and a task notification each start a new turn", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const kinds = [
      ["string prompt", (i) => tr.prompt(`고쳐줘 ${i}`)],
      ["text parts", (i) => tr.prompt("", { content: [{ type: "text", text: `다음 작업 ${i}` }] })],
      ["image only", () => tr.prompt("", { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }] })],
      ["slash command", () => tr.prompt("<command-message>coworker:task</command-message>\n<command-name>/coworker:task</command-name>")],
    ];
    kinds.forEach(([what, start], i) => {
      start(i);
      const file = ctx.claude(tr, "Write", `src/f${i}.js`);
      setMtime(file, tr.lastChangeAt); // on disk the edit happened when its tool_result says (minutes before the stop)
      tr.endTurn();
      assertBlocked(ctx.stop({ transcript: tr }), { files: [`src/f${i}.js`], lastChange: tr.lastChangeAt });
      assert.ok(what);
    });
    // a background-task notification starts its own turn: the previous turns' edits are not re-counted
    tr.userLine("<task-notification>\n<task-id>b1x2y3</task-id>\n<status>completed</status>\n</task-notification>", { origin: { kind: "task-notification" }, promptSource: "system", turnOrigin: "task_notification" });
    tr.say("The background build finished.");
    assertAllowed(ctx.stop({ transcript: tr }), "the notification turn changed nothing");
  });

  /** Turn 1 launches a background build and ends (allowed: nothing dirty yet); returns the recorded lastStopAt. */
  function launchBackgroundAndStop(ctx, tr, session) {
    tr.prompt("빌드 백그라운드로 돌려줘", { at: Date.now() - 30_000 });
    const use = tr.toolUse("Bash", { command: "npm run build", description: "Build", run_in_background: true }, { at: Date.now() - 20_000 });
    tr.toolResult(use, "Command running in background with ID: b1x2y3", { at: Date.now() - 19_900, toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: "b1x2y3" } });
    tr.endTurn("백그라운드에서 빌드 중입니다.");
    assertAllowed(ctx.stop({ transcript: tr, session }), "nothing written yet");
    return ctx.state(session).lastStopAt;
  }

  const NOTIFICATION = "<task-notification>\n<task-id>b1x2y3</task-id>\n<output-file>/tmp/b1x2y3.output</output-file>\n<status>completed</status>\n<summary>Background command \"npm run build\" completed (exit code 0)</summary>\n</task-notification>";

  test("a task-notification turn adds the window [lastStopAt − 2 s, now + 2 s]: what the background job wrote since the last stop is gated", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const variants = [
      ["origin task-notification", { origin: { kind: "task-notification" }, promptSource: "system", turnOrigin: "task_notification" }],
      ["notification text only", {}],
    ];
    for (const [what, extra] of variants) {
      const session = slug(what);
      const tr = ctx.transcript({ session });
      const lastStopAt = launchBackgroundAndStop(ctx, tr, session);
      // the background build writes after that stop; the user's editor saved another file well before it
      const out = ctx.write(`dist-src/${session}.js`, "built in the background\n");
      const user = ctx.write(`src/user-${session}.js`, "saved by the user\n");
      setMtime(user, lastStopAt - 10_000);
      tr.userLine(NOTIFICATION, { origin: { kind: "human" }, ...extra });
      tr.say("빌드가 끝났습니다.");
      assertBlocked(ctx.stop({ transcript: tr, session }), { files: [`dist-src/${session}.js`], lastChange: fs.statSync(out).mtimeMs });
      for (const file of [out, user]) setMtime(file, lastStopAt - 3_600_000); // out of the next variant's windows
    }
  });

  test("a task-notification turn without an earlier stop in this session (no lastStopAt) adds no window", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.userLine(NOTIFICATION, { origin: { kind: "task-notification" } });
    ctx.write("dist-src/out.js", "written just now by someone\n");
    tr.say("빌드가 끝났습니다.");
    assertAllowed(ctx.stop({ transcript: tr }), "no previous stop to measure the background work from");
    // a HUMAN prompt after a stop adds no such window either
    tr.prompt("고마워");
    ctx.write("dist-src/out2.js", "written just now by someone\n");
    tr.say("천만에요");
    assertAllowed(ctx.stop({ transcript: tr }), "only a notification turn inherits the background window");
  });

  test("a background job that COMMITS between the last stop and the notification is gated in the notification turn", { todo: "BUG: evaluate() looks for commits with commitsSince(top, activity.turnStart), and a notification turn starts when the notification arrives — a background job (run_in_background `npm run fix && git commit -am …`) that committed after the last stop but before the notification leaves its files clean, the extra [lastStopAt − 2 s, now] window only scans DIRTY files, so the committed change ends unreviewed" }, (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "v0\n");
    ctx.commitAll("base");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const lastStopAt = launchBackgroundAndStop(ctx, tr, "sess-1");
    // the background job changes and commits src/app.js after that stop…
    ctx.write("src/app.js", "v1 from the background job\n");
    ctx.commitAll("background fix", { during: true });
    assert.ok(Number(ctx.git(["log", "-1", "--format=%ct"]).trim()) * 1000 >= lastStopAt - 1000);
    // …and the notification arrives a few seconds later
    tr.userLine(NOTIFICATION, { origin: { kind: "task-notification" } }, { at: Date.now() + 3000 });
    tr.say("빌드가 끝났습니다.");
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js"], target: "committed" });
  });

  test("a whitespace-only or empty-array user line is not a turn boundary", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("구현해줘");
    ctx.claude(tr, "Write", "src/a.js");
    tr.userLine("   ");
    tr.userLine([]);
    tr.userLine([{ type: "text_delta", text: "x" }]);
    ctx.claude(tr, "Write", "src/b.js");
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"], lastChange: tr.lastChangeAt });
  });

  test("sidechain (subagent) lines in the main transcript are ignored: no turn boundary, no attributed edits", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("조사하고 고쳐줘");
    ctx.claude(tr, "Write", "src/main-thread.js");
    tr.userLine("Investigate the login flow and report back.", { isSidechain: true, agentId: "a1234" });
    tr.tool("Write", { file_path: path.join(ctx.repo, "src", "sub.js"), content: "x" }, { sidechain: true });
    tr.userLine([{ type: "text", text: "sidechain follow-up" }], { isSidechain: true });
    tr.say("완료");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/main-thread.js"], lastChange: tr.lastChangeAt });
    assert.ok(!got.listed.includes("src/sub.js"));
  });

  test("an auto-compaction in the middle of a turn (isCompactSummary / isVisibleInTranscriptOnly summary) does not start a new turn", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const turn = tr.prompt("큰 리팩터링 해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "src/early.js");
    const preserved = ctx.claude(tr, "Edit", "src/late.js");
    // auto-compact: boundary + summary appended, then the preserved tail is re-appended with its original timestamps
    tr.system("compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 1000065, postTokens: 13123 }, logicalParentUuid: tr.parent });
    tr.userLine("This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary: …", { isVisibleInTranscriptOnly: true, isCompactSummary: true });
    tr.tool("Edit", toolInput("Edit", preserved), { at: tr.lastChangeAt });
    tr.attachment({ type: "compact_file_reference", filename: preserved });
    ctx.claude(tr, "Write", "src/after.js");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/early.js", "src/late.js", "src/after.js"], lastChange: tr.lastChangeAt });
    assert.equal(auto.readCurrentTurn(tr.file)[0].uuid, turn.uuid, "the turn still starts at the human prompt");
    // each marker alone is enough, and so is an origin that is not human
    for (const extra of [{ isCompactSummary: true }, { isVisibleInTranscriptOnly: true }, { origin: { kind: "compaction" } }, { origin: { kind: "auto-continuation" } }, { origin: { kind: "peer" } }, { origin: { kind: "channel" } }]) {
      assert.equal(auto.isRealUserPrompt({ type: "user", message: { role: "user", content: "Summary: …" }, ...extra }), false, JSON.stringify(extra));
    }
    assert.equal(auto.isRealUserPrompt({ type: "user", message: { role: "user", content: "고쳐줘" }, origin: { kind: "human" } }), true);
  });

  test("a mid-turn compaction does not move turnStart past a commit made earlier in the turn", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("구현하고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Write", "src/a.js");
    ctx.commitAll("a", { during: true });
    tr.system("compact_boundary", { content: "Conversation compacted", compactMetadata: { trigger: "auto" } });
    tr.userLine("This session is being continued from a previous conversation…", { isVisibleInTranscriptOnly: true, isCompactSummary: true }, { at: Date.now() + 1000 });
    tr.say("계속합니다.");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"], target: "committed" });
  });

  test("edits from an interrupted turn (Esc — no Stop hook ran) are gated with the next turn", { todo: "BUG: Claude Code does not run Stop after a user interrupt, and the next prompt starts a new turn, so everything Claude changed before the interrupt (still dirty) is never gated" }, (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("로그인 고쳐줘");
    ctx.claude(tr, "Write", "src/login.js");
    tr.userLine([{ type: "text", text: "[Request interrupted by user for tool use]" }], { interruptedMessageId: `msg_01${hex(11)}` });
    tr.prompt("아 잠깐, 테스트도 같이 해줘");
    ctx.claude(tr, "Write", "test/login.test.js");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/login.js", "test/login.test.js"] });
  });

  test("a failed/denied Write of a file that never existed is not gated (git repo)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("파일 만들어줘");
    ctx.claude(tr, "Write", "src/denied.js", { onDisk: false, isError: true, result: "The user doesn't want to proceed with this tool use." });
    ctx.claude(tr, "Edit", "README.md", { onDisk: false, isError: true, result: "String to replace not found in file." });
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "nothing actually changed");
  });

  test("a failed Edit of a file the USER already changed (dirty) is not gated: is_error tool calls are ignored", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    ctx.write("README.md", "# sandbox\nthe user's own uncommitted edit\n");
    const tr = ctx.transcript();
    tr.prompt("README 고쳐줘");
    ctx.claude(tr, "Edit", "README.md", { onDisk: false, isError: true, result: "<tool_use_error>String to replace not found in file.</tool_use_error>" });
    ctx.claude(tr, "Write", "src/ok.js");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/ok.js"], lastChange: tr.lastChangeAt });
  });

  test("a failed/denied Write in a non-git project is not gated", (t) => {
    const ctx = sandbox(t, { git: false });
    ctx.setLevel("always");
    ctx.write("src/existing.js", "the user's file\n");
    const tr = ctx.transcript();
    tr.prompt("파일 만들어줘");
    ctx.claude(tr, "Write", "src/denied.js", { onDisk: false, isError: true, result: "The user doesn't want to proceed with this tool use." });
    ctx.claude(tr, "Edit", "src/existing.js", { onDisk: false, isError: true, result: "String to replace not found in file." });
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "every write was rejected");
  });

  test("a non-git project: a file Claude wrote and deleted again in the turn is not gated; the survivors are", (t) => {
    const ctx = sandbox(t, { git: false });
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("임시 파일로 실험하고 지워줘");
    ctx.claude(tr, "Write", "scratch/tmp.py");
    ctx.claude(tr, "Write", "scratch/tmp2.py");
    tr.bash("rm -r scratch");
    ctx.rm("scratch");
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "every file Claude wrote is gone");
    ctx.claude(tr, "Write", "main.py");
    ctx.claude(tr, "Write", "gone.py");
    ctx.rm("gone.py");
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py"], target: "paths" });
    assert.equal(got.pathsFileContent, "main.py\n");
  });
});

// ================================================================== stop gate: project paths

describe("hook stop: project paths", () => {
  test("a symlinked project path matches real transcript paths, and a symlinked transcript path matches the real project", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const alias = path.join(ctx.dir, "alias");
    fs.symlinkSync(ctx.repo, alias);

    const trReal = ctx.transcript({ session: "real-paths" });
    codingTurn(ctx, trReal, [["Write", "src/a.js"], ["Edit", "README.md"]]);
    assertBlocked(ctx.stop({ transcript: trReal, session: "real-paths", projectDir: alias }), { files: ["src/a.js", "README.md"] });

    const trAlias = ctx.transcript({ session: "alias-paths", cwd: alias });
    trAlias.prompt("고쳐줘");
    ctx.claude(trAlias, "Write", "src/b.js", { root: alias });
    ctx.claude(trAlias, "Write", "src/c.js", { root: alias });
    ctx.rm("src/c.js"); // deleted again: still resolved through the alias without throwing
    trAlias.endTurn();
    assertBlocked(ctx.stop({ transcript: trAlias, session: "alias-paths" }), { files: ["src/b.js"] });
    assertBlocked(ctx.stop({ transcript: trAlias, session: "alias-both", projectDir: alias }), { files: ["src/b.js"] });
    assert.ok(fs.existsSync(path.join(ctx.repo, ".coworker", "auto", "alias-both.json")));
  });

  test("the /tmp → /private/tmp alias on macOS", (t) => {
    const privateTmp = (() => {
      try {
        return fs.realpathSync("/tmp");
      } catch {
        return null;
      }
    })();
    if (!privateTmp || privateTmp === "/tmp" || !BASE.startsWith(`${privateTmp}/`)) return t.skip(`needs the sandbox under ${privateTmp ?? "/tmp"} (set COWORKER_TEST_TMPDIR=/tmp/…)`);
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const viaTmp = `/tmp${ctx.repo.slice(privateTmp.length)}`;
    const tr = ctx.transcript({ cwd: viaTmp });
    tr.prompt("고쳐줘");
    ctx.claude(tr, "Write", "src/a.js", { root: viaTmp });
    ctx.claude(tr, "Write", "src/b.js");
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr, projectDir: viaTmp }), { files: ["src/a.js", "src/b.js"] });
    assertBlocked(ctx.stop({ transcript: tr, session: "s2" }), { files: ["src/a.js", "src/b.js"] });
  });

  test("monorepo: CLAUDE_PROJECT_DIR = packages/app gates only that package, with package-relative paths", (t) => {
    const ctx = sandbox(t);
    ctx.write("packages/app/src/index.js", "export const app = 1;\n");
    ctx.write("packages/lib/src/index.js", "export const lib = 1;\n");
    ctx.commitAll("monorepo");
    const app = path.join(ctx.repo, "packages", "app");
    const m = ctx.cli(["mode", "always", "--project", app], { cwd: app });
    assert.equal(m.code, 0, m.dump());
    assert.ok(!fs.existsSync(path.join(ctx.repo, ".coworker")), "nothing written at the repo root");

    const tr = ctx.transcript({ cwd: app });
    tr.prompt("앱이랑 라이브러리 고쳐줘", { at: Date.now() - 5000 });
    ctx.claude(tr, "Edit", "packages/app/src/index.js", { content: "export const app = 2;\n" });
    ctx.claude(tr, "Edit", "packages/lib/src/index.js", { content: "export const lib = 2;\n" });
    ctx.during(tr, "Bash", "npm run build --workspaces", () => {
      ctx.write("packages/lib/dist/generated.js", "x\n");
      ctx.write("packages/app/src/generated.js", "y\n");
    });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr, projectDir: app, cwd: path.join(app, "src") }), { files: ["src/index.js", "src/generated.js"], target: "uncommitted" });
    assert.equal(got.pathsFileContent, "src/generated.js\nsrc/index.js\n", "paths are relative to the project (package), not the repo root");
    assert.ok(fs.existsSync(path.join(app, got.pathsFile)), "the paths file lives under the package's .coworker/");
    assert.ok(fs.existsSync(path.join(app, ".coworker", "auto", "sess-1.json")));
    assert.equal(ctx.git(["status", "--porcelain", "--", "packages/app/.coworker"]), "", "packages/app/.coworker is self-ignored");
    // the root project is not in always mode, so a session rooted there is never gated
    assertAllowed(ctx.stop({ transcript: tr, projectDir: ctx.repo, session: "root" }), "repo root is off");
  });

  test("a linked git worktree is gated on its own dirty state", (t) => {
    const ctx = sandbox(t);
    const wt = path.join(ctx.dir, "wt");
    ctx.git(["worktree", "add", "-q", "-b", "feature", wt]);
    ctx.setLevel("always", { projectDir: wt });
    const tr = ctx.transcript({ cwd: wt });
    tr.prompt("구현해줘");
    ctx.claude(tr, "Write", "feature.js", { root: wt });
    ctx.claude(tr, "Edit", "README.md", { root: ctx.repo }); // the main checkout: outside this project
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr, projectDir: wt }), { files: ["feature.js"] });
    assert.equal(ctx.git(["status", "--porcelain"], { cwd: wt }), "?? feature.js\n", "the worktree's own index is untouched");
  });

  test("an edit inside a nested linked worktree placed inside the project is gated with a --paths-file hint (no --uncommitted)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const wt = path.join(ctx.repo, ".claude", "worktrees", "feat");
    ctx.git(["worktree", "add", "-q", "-b", "feat", wt]);
    const tr = ctx.transcript();
    tr.prompt("워크트리에서 고쳐줘");
    ctx.claude(tr, "Edit", "README.md", { root: wt, content: "changed in the nested worktree\n" });
    ctx.claude(tr, "Write", "src/outer.js");
    tr.endTurn();
    assert.match(ctx.git(["status", "--porcelain", "--untracked-files=all"]), /^\?\? \.claude\/worktrees\/feat\/$/m, "precondition: the outer repo only sees the directory");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: [".claude/worktrees/feat/README.md", "src/outer.js"], target: "paths", lastChange: tr.lastChangeAt });
    assert.doesNotMatch(got.hint, /--uncommitted/, "an --uncommitted review of the outer repo cannot see the nested repo's diff");
  });

  test("an edit inside an independent nested git repository is gated; reverting it there lets the turn end", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const nested = path.join(ctx.repo, "vendor", "lib");
    fs.mkdirSync(nested, { recursive: true });
    ctx.git(["init", "-q"], { cwd: nested });
    ctx.write("index.js", "v0\n", nested);
    ctx.commitAll("nested base", { cwd: nested });
    const tr = ctx.transcript();
    tr.prompt("vendor 라이브러리 고쳐줘");
    ctx.claude(tr, "Edit", "index.js", { root: nested, content: "v1\n" });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["vendor/lib/index.js"], target: "paths" });
    // same kind of turn, but the edit was reverted in the nested repo
    tr.prompt("되돌려줘");
    ctx.claude(tr, "Edit", "index.js", { root: nested, content: "v0\n" });
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "clean in its own repository");
  });

  test("an edit in a nested worktree that is then committed THERE during the turn is gated (--paths-file hint)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const wt = path.join(ctx.repo, ".claude", "worktrees", "feat");
    ctx.git(["worktree", "add", "-q", "-b", "feat", wt]);
    const tr = ctx.transcript();
    tr.prompt("워크트리에서 고치고 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Edit", "README.md", { root: wt, content: "changed in the nested worktree\n" });
    ctx.commitAll("feat change", { cwd: wt, during: true });
    tr.endTurn();
    assert.equal(ctx.git(["status", "--porcelain"], { cwd: wt }), "", "precondition: clean in its own worktree");
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: [".claude/worktrees/feat/README.md"], target: "paths" });
    assert.doesNotMatch(got.hint, /--base/, "a --base review of the outer repo cannot contain a commit of the nested worktree");
  });

  test("an independent nested repository: a commit made there during the turn is gated; a main-repo commit in the same turn does not turn the hint into --base", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const nested = path.join(ctx.repo, "vendor", "lib");
    fs.mkdirSync(nested, { recursive: true });
    ctx.git(["init", "-q"], { cwd: nested });
    ctx.write("index.js", "v0\n", nested);
    ctx.commitAll("nested base", { cwd: nested });
    ctx.write(".gitignore", "vendor/\n");
    ctx.commitAll("ignore vendor");
    const tr = ctx.transcript();
    tr.prompt("vendor 고치고 둘 다 커밋해줘", { at: Date.now() - 60_000 });
    ctx.claude(tr, "Edit", "index.js", { root: nested, content: "v1\n" });
    ctx.commitAll("nested fix", { cwd: nested, during: true });
    ctx.claude(tr, "Write", "src/app.js");
    ctx.commitAll("app", { during: true });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["vendor/lib/index.js", "src/app.js"], target: "paths" });
    assert.doesNotMatch(got.hint, /--base|--uncommitted/);
  });

  test("the gate works while another git process holds .git/index.lock, and never removes it", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const lock = path.join(ctx.repo, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    try {
      assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js"] });
      assert.ok(fs.existsSync(lock), "the hook must not remove someone else's index.lock");
    } finally {
      fs.rmSync(lock, { force: true });
    }
  });

  test("during a merge conflict the resolved file is gated and the unmerged index survives", (t) => {
    const ctx = sandbox(t);
    ctx.write("conflict.txt", "base\n");
    ctx.commitAll("base");
    ctx.git(["checkout", "-q", "-b", "other"]);
    ctx.write("conflict.txt", "other side\n");
    ctx.commitAll("other");
    ctx.git(["checkout", "-q", "main"]);
    ctx.write("conflict.txt", "main side\n");
    ctx.commitAll("main");
    const merge = spawnSync("git", ["merge", "-q", "other"], { cwd: ctx.repo, env: ctx.baseEnv, encoding: "utf8" });
    assert.notEqual(merge.status, 0, "the merge must conflict");
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("충돌 해결해줘");
    tr.read(path.join(ctx.repo, "conflict.txt"));
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "nothing changed by Claude yet");
    ctx.claude(tr, "Write", "conflict.txt", { content: "resolved\n" });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["conflict.txt"] });
    assert.match(ctx.git(["status", "--porcelain"]), /^UU conflict\.txt$/m, "the user's unmerged index must be left alone");
  });
});

// ================================================================== latency

describe("latency", () => {
  /** ~100 MB, 20k-entry history (Read tool_use + ~9.5 KB tool_result pairs), written in chunks. */
  function bigHistory(ctx, tr, { entries = 20_000 } = {}) {
    const blob = Array.from({ length: 160 }, (_, i) => `line ${i}: const value${i} = compute(${i}); // 한글 주석 ${i}`).join("\n");
    tr.prompt("오래된 대화 시작");
    const fd = fs.openSync(tr.file, "a");
    try {
      let chunk = [];
      for (let i = 0; i < entries / 2; i += 1) {
        const id = `toolu_01${String(i).padStart(22, "0")}`;
        const aUuid = crypto.randomUUID();
        const at = iso(tr.clock + i);
        chunk.push(JSON.stringify({ ...tr.common(), message: { model: "claude-opus-5-5", id: `msg_${i}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name: i % 3 ? "Read" : "Bash", input: { file_path: path.join(ctx.repo, `f${i}.js`), command: "ls" }, caller: { type: "direct" } }], stop_reason: "tool_use", usage: USAGE }, requestId: `req_${i}`, type: "assistant", uuid: aUuid, timestamp: at }));
        chunk.push(JSON.stringify({ ...tr.common(), promptId: tr.promptId, type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: blob }] }, uuid: crypto.randomUUID(), timestamp: at, toolUseResult: { type: "text", file: { filePath: path.join(ctx.repo, `f${i}.js`), numLines: 160 } }, sourceToolAssistantUUID: aUuid }));
        if (chunk.length >= 2000) {
          fs.writeSync(fd, `${chunk.join("\n")}\n`);
          chunk = [];
        }
      }
      if (chunk.length) fs.writeSync(fd, `${chunk.join("\n")}\n`);
    } finally {
      fs.closeSync(fd);
    }
    tr.clock += entries;
    tr.endTurn();
  }

  test("a ~100 MB / 20k-entry transcript: the Stop hook decides in under 2 s (history before the turn, and a turn that spans it)", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    bigHistory(ctx, tr);
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const size = fs.statSync(tr.file).size;
    assert.ok(size > 90e6, `transcript is ${Math.round(size / 1e6)} MB`);
    const timings = [];
    const timed = (label, r) => {
      timings.push(`${label}=${r.ms}ms`);
      assert.ok(r.ms < 2000, `${label} took ${r.ms}ms (budget 2000ms); all: ${timings.join(" ")}`);
      return r;
    };
    assertBlocked(timed("stop-block", ctx.stop({ transcript: tr })), { files: ["src/a.js"], lastChange: tr.lastChangeAt });
    assertAllowed(timed("stop-gated-again", ctx.stop({ transcript: tr })), "the same change set is asked about once");
    tr.prompt("질문만");
    tr.say("답변");
    assertAllowed(timed("stop-question", ctx.stop({ transcript: tr })), "question-only turn after a huge history");

    // the whole 20k-entry history inside ONE turn (a long autonomous task), ending with an edit
    const long = ctx.transcript({ session: "long" });
    long.prompt("긴 작업");
    const fd = fs.openSync(long.file, "a");
    fs.writeSync(fd, fs.readFileSync(tr.file, "utf8").split("\n").filter((line) => line.includes('"tool_result"') || line.includes('"tool_use"')).join("\n") + "\n");
    fs.closeSync(fd);
    long.clock = Date.now() - 1000;
    ctx.claude(long, "Write", "src/b.js");
    timed("stop-long-turn", ctx.stop({ transcript: long, session: "long" }));
    t.diagnostic(`${Math.round(size / 1e6)} MB: ${timings.join(" ")}`);
  });

  test("prompt-submit stays under 1 s and the Stop hook under 2 s on a repo with 2,000 files and a 300-file Bash turn", (t) => {
    const ctx = sandbox(t);
    for (let i = 0; i < 2000; i += 1) {
      ctx.write(`src/mod${String(i % 40).padStart(2, "0")}/file${i}.js`, `export const v${i} = ${i};\n`);
    }
    ctx.commitAll("2000 files");
    ctx.setLevel("always");
    const timings = [];
    const timed = (label, r, budget) => {
      timings.push(`${label}=${r.ms}ms`);
      assert.ok(r.ms < budget, `${label} took ${r.ms}ms (budget ${budget}ms); all: ${timings.join(" ")}`);
      return r;
    };
    assert.match(timed("submit#1", ctx.submit("큰 저장소에서 구현해줘"), 1000).stdout, ALWAYS_FIRST);
    timed("submit#2", ctx.submit("다음"), 1000);
    const tr = ctx.transcript();
    tr.prompt("생성기 돌려줘", { at: Date.now() - 5000 });
    ctx.claude(tr, "Edit", "src/mod07/file7.js");
    ctx.during(tr, "Bash", "node gen.js", () => {
      for (let i = 0; i < 300; i += 1) ctx.write(`gen/out${String(i).padStart(3, "0")}.js`, `// ${i}\n`);
    });
    tr.endTurn();
    const got = assertBlocked(timed("stop-300", ctx.stop({ transcript: tr }), 2000));
    assert.equal(got.count, 301);
    assert.equal(got.all.length, 301, "the paths file lists all 301 files");
    assert.ok(got.all.includes("src/mod07/file7.js") && got.all.includes("gen/out299.js"));
    t.diagnostic(timings.join(" "));
  });

  test("a turn that edited 300 files with edit tools: the Stop hook still decides in under 5 s", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    const files = Array.from({ length: 300 }, (_, i) => `src/m${String(i % 30).padStart(2, "0")}/f${String(i).padStart(3, "0")}.js`);
    codingTurn(ctx, tr, files.map((file) => ["Write", file]));
    const r = ctx.stop({ transcript: tr });
    assertBlocked(r, { files });
    t.diagnostic(`stop with 300 edited files: ${r.ms}ms`);
    assert.ok(r.ms < 5000, `stop took ${r.ms}ms (about one git rev-parse per edited file)`);
  });

  test("a transcript larger than V8's max string length (~512 MB) still gates (read backwards in chunks)", { skip: HEAVY ? false : "set COWORKER_TEST_HEAVY=1 (writes a 540 MB sparse file)" }, (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    fs.truncateSync(tr.file, 540 * 1024 * 1024); // sparse padding: NUL bytes, no disk usage
    tr.raw("\n");
    codingTurn(ctx, tr, [["Write", "src/a.js"]]);
    const r = ctx.stop({ transcript: tr });
    assertBlocked(r, { files: ["src/a.js"], lastChange: tr.lastChangeAt });
    assert.ok(r.ms < 2000, `stop took ${r.ms}ms on a ${Math.round(fs.statSync(tr.file).size / 1e6)} MB transcript`);
  });

  test("the current turn is found by reading backwards: a 4 MB-chunk boundary inside a line and a single line longer than a chunk", (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("오래된 대화");
    tr.say("x".repeat(9 * 1024 * 1024)); // one 9 MB line (> two chunks) before the turn
    const turn = tr.prompt("구현해줘");
    tr.say("y".repeat(5 * 1024 * 1024)); // a 5 MB line inside the turn, straddling chunk boundaries
    ctx.claude(tr, "Write", "src/a.js");
    tr.say("z".repeat(3 * 1024 * 1024 + 17));
    ctx.claude(tr, "Write", "src/b.js");
    tr.endTurn();
    const entries = auto.readCurrentTurn(tr.file);
    assert.equal(entries?.[0]?.uuid, turn.uuid, "the turn starts at the last real prompt");
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/a.js", "src/b.js"], lastChange: tr.lastChangeAt });
  });

  test("a turn longer than the 256 MB backwards-read limit fails open instead of reading the whole file", { skip: HEAVY ? false : "set COWORKER_TEST_HEAVY=1 (writes a 260 MB turn)" }, (t) => {
    const ctx = sandbox(t);
    ctx.setLevel("always");
    const tr = ctx.transcript();
    tr.prompt("아주 긴 작업");
    ctx.claude(tr, "Write", "src/a.js");
    const line = `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "p".repeat(1024 * 1024) }] }, timestamp: iso(tr.clock) })}\n`;
    const fd = fs.openSync(tr.file, "a");
    for (let i = 0; i < 260; i += 1) fs.writeSync(fd, line);
    fs.closeSync(fd);
    const r = ctx.stop({ transcript: tr });
    assertAllowed(r, "no prompt within 256 MB: fail open");
    assert.ok(r.ms < 5000, `${r.ms}ms`);
  });
});

// ================================================================== end to end with the fake Codex

describe("end to end: a real `coworker review` (fake Codex) satisfies the gate", () => {
  test("a completed review started after Claude's edits lets the turn end; a later edit in the same turn is gated", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "line1\nline2\n");
    ctx.commitAll("app");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    ctx.submit("app.js 한 줄 고쳐줘");
    const tr = ctx.transcript();
    tr.prompt("app.js 한 줄 고쳐줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Edit", "src/app.js", { content: "line1\nline2 fixed\n" });
    ctx.claude(tr, "Write", "src/helper.js", { content: "export const h = 1;\n" });

    const review = ctx.cli(["review", "--thread", "rv", "--uncommitted", "--project", ctx.repo], { env: { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) } });
    assert.equal(review.code, 0, review.dump());
    assert.match(review.stdout, /COWORKER status=succeeded/);
    tr.bash(`coworker review --thread rv --uncommitted --project ${ctx.repo}`, { result: review.stdout.slice(-500) });
    tr.endTurn();
    assertAllowed(ctx.stop({ transcript: tr }), "Astra reviewed after the last edit");
    assertOnlyLastStop(ctx); // allowed because reviewed, not because gated before
    const meta = jobMeta(ctx, review);
    assert.equal(meta.target.repoTop, ctx.repo, "a real review records the repository top for its repo-relative file list");
    assert.equal(meta.target.fileCount, 2);
    const jobId = review.stdout.match(/job=(\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(ctx.repo, ".coworker", "jobs", jobId, "target-files.txt"), "utf8"), "src/app.js\nsrc/helper.js\n", "…and the full list in target-files.txt");

    ctx.claude(tr, "Edit", "src/app.js", { content: "line1\nline2 fixed again\n", at: Date.now() + 5000 });
    tr.endTurn();
    assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js", "src/helper.js"] });
  });

  test("the gate's single-file --paths-file hint, run as written, starts a review that satisfies the gate", (t) => {
    const ctx = sandbox(t);
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("helper 만들어줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Write", "src/helper.js", { content: "export const h = 1;\n" });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/helper.js"] });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    const meta = jobMeta(ctx, review);
    assert.equal(meta.thread, got.thread);
    assert.equal(meta.target?.mode, "uncommitted");
    assert.deepEqual(meta.target?.paths, ["src/helper.js"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("the gate's multi-file --paths-file hint, run as written, reviews every listed file and satisfies the gate", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "line1\n");
    ctx.commitAll("app");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    ctx.write("user-wip.js", "the user's own uncommitted work\n"); // not part of the gated change set
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Edit", "src/app.js"], ["Write", "src/helper.js"], ["Write", "src/third.js"]], { at: Date.now() - 30_000 });
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js", "src/helper.js", "src/third.js"] });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    const meta = jobMeta(ctx, review);
    assert.deepEqual(meta.target?.paths, got.all, `review target paths: ${JSON.stringify(meta.target?.paths)}`);
    assert.deepEqual(sorted(meta.target?.files ?? []), sorted(got.all), "exactly the listed files were diffed (not the user's WIP)");
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("more than 15 files: the --paths-file hint, run as written, reviews all of them and satisfies the gate", (t) => {
    const ctx = sandbox(t);
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    const files = Array.from({ length: 23 }, (_, i) => `src/gen/file${String(i).padStart(2, "0")}.js`);
    codingTurn(ctx, tr, files.map((file) => ["Write", file]), { at: Date.now() - 30_000 });
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files });
    assert.ok(got.truncated);
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(jobMeta(ctx, review).target?.paths, files, "all 23 paths reach the review, not just the 15 listed");
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("a review run with --paths-file from a subdirectory (Claude's shell cwd) resolves the project-relative file and satisfies the gate", (t) => {
    const ctx = sandbox(t);
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "src/deep/a.js"], ["Write", "src/b.js"]], { at: Date.now() - 30_000 });
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/deep/a.js", "src/b.js"] });
    const review = runHint(ctx, got, { cwd: path.join(ctx.repo, "src", "deep") });
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(jobMeta(ctx, review).target?.paths, ["src/b.js", "src/deep/a.js"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("non-git project: the --paths-file hint, run as written, satisfies the gate", (t) => {
    const ctx = sandbox(t, { git: false });
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    codingTurn(ctx, tr, [["Write", "main.py"], ["Write", "lib/util.py"]], { at: Date.now() - 30_000 });
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py", "lib/util.py"], target: "paths" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(jobMeta(ctx, review).target?.paths, ["lib/util.py", "main.py"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("nested worktree: the --paths-file hint, run as written, satisfies the gate", (t) => {
    const ctx = sandbox(t);
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const wt = path.join(ctx.repo, ".claude", "worktrees", "feat");
    ctx.git(["worktree", "add", "-q", "-b", "feat", wt]);
    const tr = ctx.transcript();
    tr.prompt("워크트리에서 고쳐줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Edit", "README.md", { root: wt, content: "changed in the nested worktree\n" });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: [".claude/worktrees/feat/README.md"], target: "paths" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(jobMeta(ctx, review).target?.paths, [".claude/worktrees/feat/README.md"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("monorepo package project: the --paths-file hint, run as written from the package, satisfies the gate", (t) => {
    const ctx = sandbox(t);
    ctx.write("packages/app/src/index.js", "export const app = 1;\n");
    ctx.write("packages/lib/src/index.js", "export const lib = 1;\n");
    ctx.commitAll("monorepo");
    const app = path.join(ctx.repo, "packages", "app");
    assert.equal(ctx.cli(["mode", "always", "--project", app], { cwd: app }).code, 0);
    ctx.write("packages/lib/src/index.js", "export const lib = 'user wip';\n"); // outside the project
    const tr = ctx.transcript({ cwd: app });
    tr.prompt("앱 고쳐줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Edit", "packages/app/src/index.js", { content: "export const app = 2;\n" });
    ctx.claude(tr, "Write", "packages/app/src/new.js");
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr, projectDir: app }), { files: ["src/index.js", "src/new.js"], target: "uncommitted" });
    const review = runHint(ctx, got, { projectDir: app });
    assert.equal(review.code, 0, review.dump());
    const meta = jobMeta(ctx, review, app);
    assert.deepEqual(meta.target?.paths, ["src/index.js", "src/new.js"], "project-relative paths");
    assert.deepEqual(sorted(meta.target?.files ?? []), ["packages/app/src/index.js", "packages/app/src/new.js"], "git diff names are repo-root relative");
    assertAllowed(ctx.stop({ transcript: tr, projectDir: app, session: "sess-after-review" }), "reviewed");
  });

  test("the root-commit --paths-file hint, run as written, starts a review that satisfies the gate", (t) => {
    const ctx = sandbox(t, { commit: false });
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("뼈대 만들고 첫 커밋 해줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Write", "main.py", { content: "print(1)\n" });
    ctx.commitAll("initial", { during: true });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["main.py"], target: "paths" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.match(review.stdout, /COWORKER status=succeeded/);
    const meta = jobMeta(ctx, review);
    assert.equal(meta.target?.mode, "paths");
    assert.deepEqual(meta.target?.files, ["main.py"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("committed + still-dirty files: the --base hint, run as written, reviews both and satisfies the gate", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "v0\n");
    ctx.commitAll("base");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("app은 커밋하고 helper는 남겨둬", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Edit", "src/app.js", { content: "v1\n" });
    ctx.commitAll("fix", { during: true });
    ctx.claude(tr, "Write", "src/helper.js", { content: "export const h = 1;\n" });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js", "src/helper.js"], target: "committed" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.deepEqual(sorted(jobMeta(ctx, review).target?.files ?? []), ["src/app.js", "src/helper.js"], "the commit AND the dirty file");
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("the committed-turn --base hint, run as written, starts a review", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/app.js", "v0\n");
    ctx.commitAll("base");
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("고치고 커밋해줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Edit", "src/app.js", { content: "v1\n" });
    ctx.commitAll("fix", { during: true });
    tr.endTurn();
    const got = assertBlocked(ctx.stop({ transcript: tr }), { files: ["src/app.js"], target: "committed" });
    const review = runHint(ctx, got);
    assert.equal(review.code, 0, review.dump());
    assert.match(review.stdout, /COWORKER status=succeeded/);
    assert.deepEqual(jobMeta(ctx, review).target?.files, ["src/app.js"]);
    assertAllowed(ctx.stop({ transcript: tr, session: "sess-after-review" }), "reviewed");
  });

  test("while a detached review is running the gate stays quiet; after it succeeds the turn may end", async (t) => {
    const ctx = sandbox(t);
    assert.equal(ctx.cli(["mode", "always", "--project", ctx.repo]).code, 0);
    const tr = ctx.transcript();
    tr.prompt("구현해줘", { at: Date.now() - 30_000 });
    ctx.claude(tr, "Write", "src/app.js", { content: "export const x = 1;\n" });

    const review = ctx.cli(["review", "--thread", "slow", "--uncommitted", "--detach", "--project", ctx.repo], {
      env: { FAKE_CODEX_JSON: JSON.stringify(reviewResult()), FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "4000" },
    });
    assert.equal(review.code, 75, review.dump());
    const jobId = review.stdout.match(/job=(\S+)/)?.[1];
    assert.ok(jobId, review.dump());
    tr.endTurn();

    const r = ctx.stop({ transcript: tr });
    const status = ctx.jobStatus(jobId);
    assert.ok(status && !TERMINAL.includes(status.state), `job should still be running, got ${status?.state}`);
    assertAllowed(r, "review in progress");

    const w = ctx.cli(["wait", jobId, "--project", ctx.repo]);
    assert.equal(w.code, 0, w.dump());
    assert.match(w.stdout, /COWORKER status=succeeded/);
    assertAllowed(ctx.stop({ transcript: tr }), "reviewed after the wait");
    assertOnlyLastStop(ctx);
  });
});

// ================================================================== CLI: stray positionals and --paths-file

describe("CLI: every turn value must belong to a flag; --paths-file feeds --paths", () => {
  test("a stray positional in ask / plan / review / debate is a usage error (exit 64) and starts nothing", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "a\n");
    ctx.write("src/b.js", "b\n");
    ctx.write("plan.md", "# plan\n");
    const env = { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) };
    const cases = [
      [["review", "--thread", "t1", "--uncommitted", "--paths", "src/a.js", "src/b.js"], ["src/b.js"]],
      [["review", "stray", "--thread", "t2", "--uncommitted"], ["stray"]],
      [["review", "--thread", "t3", "--uncommitted", "--", "src/a.js"], ["src/a.js"]],
      [["ask", "--thread", "t4", "--message", "hi", "extra", "words"], ["extra", "words"]],
      [["plan", "--thread", "t5", "--message-file", "plan.md", "plan.md"], ["plan.md"]],
      [["debate", "--thread", "t6", "--stage", "open", "oops"], ["oops"]],
      // the skills pass the user's text as ONE --args value: it is split shell-style and checked the same way
      [["review", "--project", ctx.repo, "--args", "--thread t7 --uncommitted --paths src/a.js src/b.js"], ["src/b.js"]],
    ];
    for (const [args, stray] of cases) {
      const r = ctx.cli([...args, ...(args.includes("--project") ? [] : ["--project", ctx.repo])], { env });
      assert.equal(r.code, 64, r.dump());
      assert.match(r.stdout, /^COWORKER status=usage_error job=- thread=- result=-$/m, r.dump());
      assert.ok(r.stderr.includes(`Unexpected argument(s): ${stray.map((word) => JSON.stringify(word)).join(" ")}`), r.dump());
      assert.match(r.stderr, /--paths-file <file>/, "the error names the fix");
    }
    const jobs = path.join(ctx.repo, ".coworker", "jobs");
    assert.deepEqual(fs.existsSync(jobs) ? fs.readdirSync(jobs) : [], [], "no job was started");
    const threads = path.join(ctx.repo, ".coworker", "threads");
    assert.deepEqual(fs.existsSync(threads) ? fs.readdirSync(threads).filter((name) => name.endsWith(".json")) : [], [], "no thread was created");
  });

  test("--paths-file appends its lines to --paths (blank lines, CRLF and surrounding spaces dropped)", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "a0\n");
    ctx.write("src/b.js", "b0\n");
    ctx.write("src/c d.js", "c0\n");
    ctx.write("src/not-listed.js", "n0\n");
    ctx.commitAll("base");
    for (const name of ["a.js", "b.js", "c d.js", "not-listed.js"]) ctx.write(`src/${name}`, "changed\n");
    ctx.write("lists/review.txt", "src/b.js\r\n\n   src/c d.js  \n\n");
    const r = ctx.cli(["review", "--thread", "pf", "--uncommitted", "--paths", "src/a.js", "--paths-file", "lists/review.txt", "--project", ctx.repo], { env: { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) } });
    assert.equal(r.code, 0, r.dump());
    const meta = jobMeta(ctx, r);
    assert.deepEqual(meta.target.paths, ["src/a.js", "src/b.js", "src/c d.js"]);
    assert.deepEqual(sorted(meta.target.files), ["src/a.js", "src/b.js", "src/c d.js"], "src/not-listed.js is not reviewed");
  });

  test("--paths-file resolves relative to the cwd first, then to the project root; absolute paths work", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "a0\n");
    ctx.write("src/b.js", "b0\n");
    ctx.commitAll("base");
    ctx.write("src/a.js", "a1\n");
    ctx.write("src/b.js", "b1\n");
    const env = { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) };
    ctx.write("list.txt", "src/a.js\n"); // at the project root
    ctx.write("src/list.txt", "src/b.js\n"); // next to the cwd below
    const fromCwd = ctx.cli(["review", "--thread", "r1", "--uncommitted", "--paths-file", "list.txt", "--project", ctx.repo], { cwd: path.join(ctx.repo, "src"), env });
    assert.equal(fromCwd.code, 0, fromCwd.dump());
    assert.deepEqual(jobMeta(ctx, fromCwd).target.paths, ["src/b.js"], "src/list.txt next to the cwd wins");
    fs.mkdirSync(path.join(ctx.repo, "docs"));
    const cwdMissing = ctx.cli(["review", "--thread", "r2", "--uncommitted", "--paths-file", "list.txt", "--project", ctx.repo], { cwd: path.join(ctx.repo, "docs"), env });
    assert.equal(cwdMissing.code, 0, cwdMissing.dump());
    assert.deepEqual(jobMeta(ctx, cwdMissing).target.paths, ["src/a.js"], "falls back to the project root");
    const absolute = ctx.cli(["review", "--thread", "r3", "--uncommitted", "--paths-file", path.join(ctx.repo, "src", "list.txt"), "--project", ctx.repo], { cwd: ctx.dir, env });
    assert.equal(absolute.code, 0, absolute.dump());
    assert.deepEqual(jobMeta(ctx, absolute).target.paths, ["src/b.js"]);
  });

  test("a missing or unreadable --paths-file, or one without a value, is a usage error (exit 64) and starts nothing", (t) => {
    const ctx = sandbox(t);
    ctx.write("src/a.js", "a\n");
    const env = { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) };
    const cases = [
      [["--uncommitted", "--paths-file", ".coworker/work/gate-deadbeef/paths.txt"], /Cannot read --paths-file "\.coworker\/work\/gate-deadbeef\/paths\.txt": ENOENT/],
      [["--uncommitted", "--paths-file", "src"], /Cannot read --paths-file "src": EISDIR/],
      [["--uncommitted", "--paths-file"], /Missing value for --paths-file/],
      [["--paths-file", "--uncommitted"], /Missing value for --paths-file/],
    ];
    for (const [flags, message] of cases) {
      const r = ctx.cli(["review", "--thread", "pf", ...flags, "--project", ctx.repo], { env });
      assert.equal(r.code, 64, r.dump());
      assert.match(r.stderr, message, r.dump());
      assert.match(r.stdout, /COWORKER status=usage_error/, r.dump());
    }
    const jobs = path.join(ctx.repo, ".coworker", "jobs");
    assert.deepEqual(fs.existsSync(jobs) ? fs.readdirSync(jobs) : [], [], "no job was started");
  });
});
