#!/usr/bin/env node
// coworker — Claude Code ⇄ Codex (GPT-6 Astra) collaboration CLI.
//
// Output contract for Claude:
//   * progress lines go to stderr, the result to stdout
//   * for turn and job commands (ask/plan/review/debate/wait/cancel) the last stdout line is machine-readable:
//       COWORKER status=<state> [loop=<state>] job=<id> thread=<name> result=<path>
//   * exit codes: 0 done · 75 still running (call `coworker wait`) · 1 failed/cancelled/timeout ·
//     3 thread busy · 4 session lost · 5 could not start (binary/login) · 64 usage error
//   * we never call process.exit() after writing (macOS pipes truncate at 64 KB); we set exitCode.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeArgv, parseArgs, splitShellWords, UsageError } from "./lib/args.mjs";
import { capabilities, chooseBinary, loginStatus } from "./lib/codex.mjs";
import { findProjectRoot, globalConfigPath, loadConfig, writeConfigKey } from "./lib/config.mjs";
import { convergence, readLedger, renderLedger, tally } from "./lib/ledger.mjs";
import { cancelJob, followJob, launchJob, readStatus, reconcile, spawnSupervisor, superviseJob } from "./lib/jobs.mjs";
import {
  assertThreadName,
  ensureStateDir,
  jobPaths,
  listJobs,
  listThreads,
  readJson,
  readLock,
  readThread,
  stateDir,
  TERMINAL_STATES,
  threadPaths,
  writeJsonAtomic,
  acquireThreadLock,
  forceUnlockThread,
  releaseThreadLock,
} from "./lib/state.mjs";
import { archiveThread, finalizeTurn, startTurn, TurnError } from "./lib/turns.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
// Claude Code inlines roughly the first 30 KB of Bash output; Korean text is 3 bytes/char, so cap by bytes.
const MAX_STDOUT_BYTES = 22000;
const EXIT = { ok: 0, failed: 1, busy: 3, sessionLost: 4, startFailed: 5, usage: 64, waiting: 75 };

function out(text = "") {
  process.stdout.write(`${text}\n`);
}

function err(text = "") {
  process.stderr.write(`${text}\n`);
}

// ------------------------------------------------------------------ shared flag specs

const TURN_SPEC = {
  booleans: ["new", "detach", "deep", "extra-round", "uncommitted", "json"],
  strings: [
    "thread", "message-file", "message", "effort", "model", "lang", "wait-budget", "timeout", "project", "cwd",
    "responses", "max-rounds", "isolation", "base", "commit", "focus", "plan-file", "claude-view", "stage", "brief",
    "claude-proposal", "claude-final",
  ],
  arrays: ["attach", "paths"],
  aliases: { m: "message", t: "thread", f: "message-file", a: "attach" },
};

function context(flags) {
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  // An unsubstituted/empty --project (e.g. "${CLAUDE_PROJECT_DIR}" on an older Claude Code) means "not given".
  const given = [flags.project, process.env.CLAUDE_PROJECT_DIR].find((value) => value && !value.includes("${"));
  const projectRoot = path.resolve(given ?? findProjectRoot(cwd));
  const { config, sources } = loadConfig({ projectRoot });
  return { cwd: process.cwd(), gitCwd: flags.cwd ? cwd : projectRoot, projectRoot, config, sources };
}

function effectiveBudgetMs(flags, config) {
  let seconds = Number(flags["wait-budget"] ?? config.waitBudgetSec);
  if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`--wait-budget must be a number of seconds, got "${flags["wait-budget"]}".`);
  const bashMax = Number(process.env.BASH_MAX_TIMEOUT_MS);
  if (Number.isFinite(bashMax) && bashMax > 0) seconds = Math.min(seconds, bashMax / 1000 - 30);
  return Math.max(0, seconds) * 1000;
}

function exitFor(state) {
  if (state === "succeeded") return EXIT.ok;
  if (state === "waiting") return EXIT.waiting;
  if (state === "session_lost") return EXIT.sessionLost;
  if (state === "start_failed") return EXIT.startFailed;
  return EXIT.failed;
}

function statusLine({ state, loop, jobId, thread, result }) {
  return `COWORKER status=${state}${loop ? ` loop=${loop}` : ""} job=${jobId ?? "-"} thread=${thread ?? "-"} result=${result ?? "-"}`;
}

function progressPrinter() {
  let count = 0;
  let suppressed = 0;
  return {
    line(text) {
      if (count < 40) {
        err(`  astra ▸ ${text}`);
        count += 1;
      } else {
        suppressed += 1;
      }
    },
    done() {
      if (suppressed) err(`  astra ▸ (${suppressed} more progress lines not shown)`);
    },
  };
}

/** Print a finished job's result (capped) and the machine line; return the exit code. */
function printResult(projectRoot, jobId, status) {
  const paths = jobPaths(projectRoot, jobId);
  const meta = readJson(paths.meta) ?? {};
  let text = "";
  try {
    text = fs.readFileSync(paths.result, "utf8");
  } catch {
    const lines = [`Job ${jobId} ended as ${status.state}${status.error ? `: ${status.error}` : ""}`];
    if (status.finalizeError) lines.push(`Post-processing failed: ${status.finalizeError}`);
    if (status.hint) lines.push(`Hint: ${status.hint}`);
    if (status.deliveryUnknown) {
      lines.push("Delivery unknown: Astra's session may already contain this message. Do NOT resend blindly — rerun the same command once; the retry is labeled as such for Astra.");
    }
    if (fs.existsSync(paths.last)) lines.push(`Astra's raw final answer: ${paths.last}`);
    lines.push(`Logs: ${paths.supervisorLog} · ${paths.stderr}`);
    text = lines.join("\n");
  }
  const line = statusLine({ state: status.state, loop: status.loop?.state, jobId, thread: meta.thread, result: fs.existsSync(paths.result) ? paths.result : null });
  if (Buffer.byteLength(text) > MAX_STDOUT_BYTES) {
    const cut = Buffer.from(text).subarray(0, MAX_STDOUT_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
    text = `${cut}\n\n… [truncated — read the full result with the Read tool: ${paths.result}]`;
  }
  out(line); // also first, so it survives any truncation of long output
  out("");
  out(text.trimEnd());
  out("");
  out(`Transcript: ${threadPaths(projectRoot, meta.thread ?? "?").transcript}`);
  out(line);
  return exitFor(status.state);
}

async function follow(projectRoot, jobId, flags, config, { fromOffset = 0 } = {}) {
  const printer = progressPrinter();
  const status = await followJob(projectRoot, jobId, { budgetMs: effectiveBudgetMs(flags, config), onProgress: printer.line, fromOffset });
  printer.done();
  if (status.state === "waiting") {
    const meta = readJson(jobPaths(projectRoot, jobId).meta) ?? {};
    out(`Astra is still working on job ${jobId} (thread ${meta.thread}). The job keeps running in the background.`);
    out(`Do NOT resend the message. Collect the result with: coworker wait ${jobId}`);
    out(statusLine({ state: "waiting", jobId, thread: meta.thread }));
    return EXIT.waiting;
  }
  return printResult(projectRoot, jobId, status);
}

// ------------------------------------------------------------------ turn commands

function pruneSealed(projectRoot, config) {
  // Sealed pre-commitments (ask --claude-view, debate proposals/finals) live outside the repo. Only this
  // project's are pruned (other projects have their own retention), never a thread with a running job,
  // and never anything younger than a day.
  const key = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 12);
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(process.env.HOME ?? "", ".cache"), "coworker", "sealed", key);
  const cutoff = Date.now() - Math.max(config.jobRetentionDays, 1) * 86400000;
  let threads = [];
  try {
    threads = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const thread of threads) {
    if (readThread(projectRoot, thread)?.activeJobId) continue;
    const dir = path.join(base, thread);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function pruneJobs(projectRoot, config) {
  pruneSealed(projectRoot, config);
  const cutoff = Date.now() - config.jobRetentionDays * 86400000;
  const jobs = listJobs(projectRoot);
  jobs.slice(30).forEach((job) => {
    const status = job.status;
    if (!status || !TERMINAL_STATES.has(status.state)) return;
    const finished = Date.parse(status.finishedAt ?? status.updatedAt ?? 0);
    if (finished && finished < cutoff) fs.rmSync(jobPaths(projectRoot, job.jobId).dir, { recursive: true, force: true });
  });
}

async function cmdTurn(kind, argv) {
  const { flags } = parseArgs(argv, TURN_SPEC);
  const ctx = context(flags);
  const budgetMs = effectiveBudgetMs(flags, ctx.config); // validate before anything is launched
  ensureStateDir(ctx.projectRoot);
  try {
    pruneJobs(ctx.projectRoot, ctx.config);
  } catch {
    // housekeeping only
  }
  const started = await startTurn({
    kind,
    flags,
    config: ctx.config,
    projectRoot: ctx.projectRoot,
    cwd: ctx.cwd,
    gitCwd: ctx.gitCwd,
    launch: (spec) => launchJob({ ...spec, script: SCRIPT }),
  });
  err(`[coworker] job ${started.jobId} · thread ${started.thread} · ${kind} round ${started.round}${kind === "plan" || kind === "review" ? `/${started.maxRounds}` : ""} · ${started.model}/${started.effort} · codex ${started.binary.version}`);
  if (started.warning) err(`[coworker] ⚠ ${started.warning}`);
  if (flags.detach || budgetMs === 0) {
    out(`Started job ${started.jobId}. Collect the result with: coworker wait ${started.jobId}`);
    out(statusLine({ state: "waiting", jobId: started.jobId, thread: started.thread }));
    return EXIT.waiting;
  }
  return follow(ctx.projectRoot, started.jobId, flags, ctx.config);
}

function resolveJobId(projectRoot, positional, flags) {
  if (positional) return positional;
  if (flags.thread) {
    const thread = readThread(projectRoot, String(flags.thread).toLowerCase());
    if (thread?.activeJobId) return thread.activeJobId;
    const last = thread?.turns?.[thread.turns.length - 1];
    if (last?.jobId) return last.jobId;
    throw new UsageError(`Thread "${flags.thread}" has no jobs.`);
  }
  const latest = listJobs(projectRoot)[0];
  if (!latest) throw new UsageError("No jobs yet.");
  return latest.jobId;
}

async function cmdWait(argv) {
  const { flags, positionals } = parseArgs(argv, { strings: ["thread", "wait-budget", "budget", "project", "cwd"] });
  if (flags.budget) flags["wait-budget"] = flags.budget;
  const ctx = context(flags);
  const jobId = resolveJobId(ctx.projectRoot, positionals[0], flags);
  const status = reconcile(ctx.projectRoot, jobId);
  if (!status) throw new UsageError(`No such job: ${jobId}`);
  if (TERMINAL_STATES.has(status.state)) return printResult(ctx.projectRoot, jobId, status);
  const elapsed = status.startedAt ? Math.round((Date.now() - Date.parse(status.startedAt)) / 1000) : 0;
  err(`[coworker] job ${jobId} is ${status.state} (${elapsed}s so far); waiting…`);
  let offset = 0;
  try {
    offset = fs.statSync(jobPaths(ctx.projectRoot, jobId).events).size;
  } catch {
    offset = 0;
  }
  return follow(ctx.projectRoot, jobId, flags, ctx.config, { fromOffset: offset });
}

async function cmdCancel(argv) {
  const { flags, positionals } = parseArgs(argv, { strings: ["thread", "project", "cwd"] });
  const ctx = context(flags);
  const jobId = resolveJobId(ctx.projectRoot, positionals[0], flags);
  const result = await cancelJob(ctx.projectRoot, jobId);
  if (result.alreadyFinished) out(`Job ${jobId} had already finished (${result.status.state}).`);
  else if (result.pending) out(`Cancel requested for ${jobId}; the supervisor is still shutting Codex down. Check with: coworker jobs`);
  else out(`Job ${jobId} → ${result.status.state}.`);
  out("Note: this stops the local Codex process; a model turn already in flight may still count against usage.");
  out(statusLine({ state: result.status?.state ?? "cancelling", jobId }));
  return EXIT.ok;
}

// ------------------------------------------------------------------ status

function permissionHints(projectRoot) {
  const files = [
    path.join(process.env.HOME ?? "", ".claude", "settings.json"),
    path.join(process.env.HOME ?? "", ".claude", "settings.local.json"),
    path.join(projectRoot, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.local.json"),
  ];
  const allow = new Set();
  for (const file of files) {
    const json = readJson(file);
    for (const rule of json?.permissions?.allow ?? []) allow.add(rule);
  }
  const wanted = ["Bash(coworker *)", "Edit(.coworker/**)", "Skill(coworker:task *)", "Skill(coworker:plan *)", "Skill(coworker:review *)", "Skill(coworker:ask *)", "Skill(coworker:debate *)"];
  const has = (rule) => [...allow].some((existing) => existing === rule || existing.replace(/:\*\)$/, " *)") === rule);
  return wanted.filter((rule) => !has(rule));
}

function cmdStatus(argv) {
  const { flags } = parseArgs(argv, { booleans: ["json", "ping", "refresh"], strings: ["project", "cwd"] });
  const ctx = context(flags);
  const report = { projectRoot: ctx.projectRoot, config: ctx.config, sources: ctx.sources };
  const choice = chooseBinary({ config: ctx.config });
  if (flags.refresh) for (const candidate of choice.candidates) if (candidate.ok) capabilities(candidate.path, { refresh: true });
  report.binaries = choice.candidates.map((candidate) => ({
    path: candidate.path,
    version: candidate.version,
    usable: Boolean(candidate.caps?.usable),
    missing: candidate.caps?.missing ?? (candidate.ok ? [] : [candidate.error]),
  }));
  report.chosen = choice.chosen ? { path: choice.chosen.path, version: choice.chosen.version, reason: choice.reason } : null;
  report.login = choice.chosen ? loginStatus(choice.chosen.path) : { ok: false, text: "no usable codex binary" };
  report.threads = listThreads(ctx.projectRoot).map((thread) => ({
    name: thread.name,
    initialized: thread.initialized,
    rounds: thread.rounds,
    turns: thread.usageTotals?.turns ?? 0,
    lastState: thread.turns?.[thread.turns.length - 1]?.state ?? null,
    activeJobId: thread.activeJobId ?? null,
    binary: thread.binary?.version ?? null,
    usage: thread.usageTotals,
  }));
  report.running = listJobs(ctx.projectRoot)
    .slice(0, 50)
    .map((job) => ({ jobId: job.jobId, status: reconcile(ctx.projectRoot, job.jobId), meta: job.meta }))
    .filter((job) => job.status && !TERMINAL_STATES.has(job.status.state))
    .map((job) => ({ jobId: job.jobId, state: job.status.state, thread: job.meta?.thread, kind: job.meta?.kind }));
  report.missingPermissions = permissionHints(ctx.projectRoot);

  if (flags.ping && choice.chosen) {
    const started = Date.now();
    const lastFile = path.join(stateDir(ctx.projectRoot), `ping-${process.pid}.txt`);
    ensureStateDir(ctx.projectRoot);
    const args = ["exec", "--json", "--skip-git-repo-check", "-m", ctx.config.model, "-c", 'model_reasoning_effort="low"', "-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
    if (ctx.config.authMethod === "chatgpt") args.push("-c", 'forced_login_method="chatgpt"');
    if (ctx.config.isolation === "strict" && choice.chosen.caps?.exec?.ignoreUserConfig) args.push("--ignore-user-config");
    args.push("-o", lastFile, "-");
    const result = spawnSyncSafe(choice.chosen.path, args, "Reply with exactly: pong", 100000, ctx.projectRoot);
    const reply = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, "utf8").trim() : "";
    fs.rmSync(lastFile, { force: true });
    const failure = result.stdout.split("\n").map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .find((event) => event?.type === "turn.failed");
    const stderrTail = result.stderr
      .split("\n")
      .filter((line) => line.trim() && !/rmcp::|responses_websocket|Reading additional input from stdin/.test(line))
      .slice(-4)
      .join(" | ");
    report.ping = {
      ok: /pong/i.test(reply),
      reply,
      seconds: Math.round((Date.now() - started) / 1000),
      error: failure ? JSON.stringify(failure.error).slice(0, 300) : result.error ?? (stderrTail.slice(0, 400) || null),
    };
  }

  if (flags.json) {
    out(JSON.stringify(report, null, 2));
    return EXIT.ok;
  }
  const ok = (value) => (value ? "OK  " : "FAIL");
  const lines = ["# coworker status", "", `Project: ${ctx.projectRoot}`, ""];
  lines.push("## Codex CLI");
  for (const binary of report.binaries) {
    const mark = report.chosen?.path === binary.path ? " ← chosen" : "";
    lines.push(`- ${binary.usable ? "✓" : "✗"} ${binary.version ?? "?"}  ${binary.path}${mark}${binary.usable ? "" : `  (missing: ${binary.missing.join(", ")})`}`);
  }
  if (!report.binaries.length) lines.push("- none found. Install: `npm i -g @openai/codex` (or the ChatGPT desktop app).");
  lines.push(`${ok(report.chosen)} chosen: ${report.chosen ? `${report.chosen.version} (${report.chosen.reason})` : choice.reason}`);
  lines.push(`${ok(report.login.ok)} login: ${report.login.text}${report.login.ok && !report.login.chatgpt && ctx.config.authMethod === "chatgpt" ? "  ⚠ not a ChatGPT login; set authMethod \"any\" or run `codex login`" : ""}`);
  if (report.ping) lines.push(`${ok(report.ping.ok)} live ping (${ctx.config.model}, low effort): ${report.ping.ok ? `pong in ${report.ping.seconds}s` : `failed after ${report.ping.seconds}s ${report.ping.error ?? report.ping.reply}`}`);
  lines.push("", "## Config");
  const c = ctx.config;
  lines.push(`- model ${c.model} · effort ask=${c.effort.ask} plan=${c.effort.plan} review=${c.effort.review} rereview=${c.effort.rereview} debate=${c.effort.debate}`);
  lines.push(`- maxRounds plan=${c.maxRounds.plan} review=${c.maxRounds.review} · isolation ${c.isolation} · auth ${c.authMethod} · web search ${c.webSearch ? "on" : "off"} · lang ${c.lang}`);
  lines.push(`- wait budget ${c.waitBudgetSec}s · hard timeout ${c.timeoutSec}s · auto mode ${c.autoMode ? "ON" : "off"}`);
  lines.push(`- files: ${ctx.sources.project} · ${ctx.sources.global}`);
  lines.push("", "## Threads");
  if (!report.threads.length) lines.push("- none yet");
  for (const thread of report.threads) {
    const usage = thread.usage ? ` · ${thread.usage.turns} turns, ${Math.round((thread.usage.input ?? 0) / 1000)}k in (${thread.usage.input ? Math.round((thread.usage.cached / thread.usage.input) * 100) : 0}% cached), ${thread.usage.seconds}s` : "";
    lines.push(`- ${thread.name}: rounds ${JSON.stringify(thread.rounds ?? {})} · last ${thread.lastState ?? "-"}${thread.activeJobId ? ` · RUNNING ${thread.activeJobId}` : ""}${usage}`);
  }
  if (report.running.length) {
    lines.push("", "## Running jobs");
    for (const job of report.running) lines.push(`- ${job.jobId} (${job.kind} on ${job.thread}): ${job.state}`);
  }
  if (report.missingPermissions.length) {
    lines.push("", "## Permissions (optional, avoids prompts on every Astra round)");
    lines.push("Add to ~/.claude/settings.json → permissions.allow:");
    lines.push("```json");
    lines.push(JSON.stringify(report.missingPermissions, null, 2));
    lines.push("```");
  }
  out(lines.join("\n"));
  return EXIT.ok;
}

function spawnSyncSafe(bin, args, input, timeout, cwd) {
  const result = spawnSync(bin, args, { input, encoding: "utf8", timeout, cwd, stdio: ["pipe", "pipe", "pipe"] });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message ?? null, status: result.status };
}

// ------------------------------------------------------------------ jobs / threads / task-state / mode

function cmdJobs(argv) {
  const { flags } = parseArgs(argv, { booleans: ["all", "prune", "json"], strings: ["keep", "project", "cwd", "thread"] });
  const ctx = context(flags);
  if (flags.prune) {
    const keep = Number(flags.keep ?? 30);
    let removed = 0;
    listJobs(ctx.projectRoot).slice(keep).forEach((job) => {
      const status = reconcile(ctx.projectRoot, job.jobId);
      if (status && TERMINAL_STATES.has(status.state)) {
        fs.rmSync(jobPaths(ctx.projectRoot, job.jobId).dir, { recursive: true, force: true });
        removed += 1;
      }
    });
    out(`Pruned ${removed} finished job(s); kept the newest ${keep}.`);
    return EXIT.ok;
  }
  let jobs = listJobs(ctx.projectRoot);
  if (flags.thread) jobs = jobs.filter((job) => job.meta?.thread === String(flags.thread).toLowerCase());
  jobs = jobs.slice(0, flags.all ? 500 : 15).map((job) => ({ ...job, status: reconcile(ctx.projectRoot, job.jobId) }));
  if (flags.json) {
    out(JSON.stringify(jobs.map((job) => ({ jobId: job.jobId, thread: job.meta?.thread, kind: job.meta?.kind, round: job.meta?.round, state: job.status?.state, elapsedMs: job.status?.elapsedMs, error: job.status?.error })), null, 2));
    return EXIT.ok;
  }
  if (!jobs.length) out("No jobs yet.");
  for (const job of jobs) {
    const secs = job.status?.elapsedMs ? `${Math.round(job.status.elapsedMs / 1000)}s` : "";
    out(`- ${job.jobId}  ${job.meta?.kind ?? "?"} r${job.meta?.round ?? "?"} on ${job.meta?.thread ?? "?"}  → ${job.status?.state ?? "?"} ${secs}${job.status?.error ? `  (${String(job.status.error).slice(0, 120)})` : ""}`);
  }
  return EXIT.ok;
}

function cmdThreads(argv) {
  const { flags, positionals } = parseArgs(argv, { booleans: ["json", "all"], strings: ["project", "cwd"] });
  const ctx = context(flags);
  const sub = positionals[0] ?? "list";
  const name = positionals[1] ? assertThreadName(positionals[1].toLowerCase()) : null;
  if (sub === "list") {
    const threads = listThreads(ctx.projectRoot);
    if (flags.json) {
      out(JSON.stringify(threads, null, 2));
      return EXIT.ok;
    }
    if (!threads.length) out("No threads yet.");
    for (const thread of threads) {
      out(`- ${thread.name}  rounds=${JSON.stringify(thread.rounds ?? {})}  turns=${thread.usageTotals?.turns ?? 0}  updated=${thread.updatedAt ?? "?"}${thread.activeJobId ? `  RUNNING ${thread.activeJobId}` : ""}`);
    }
    return EXIT.ok;
  }
  if (!name) throw new UsageError(`threads ${sub} needs a thread name.`);
  if (sub === "show" || sub === "ledger") {
    const thread = readThread(ctx.projectRoot, name);
    if (!thread) {
      out(`No thread "${name}".`);
      return EXIT.ok;
    }
    const ledger = readLedger(ctx.projectRoot, name);
    if (sub === "show") {
      out(`# Thread ${name}`);
      out(`- session ${thread.sessionId ?? "(not initialized)"} · codex ${thread.binary?.version ?? "?"} · ${thread.model} · lang ${thread.lang}`);
      const u = thread.usageTotals ?? {};
      const cachedPct = u.input ? Math.round(((u.cached ?? 0) / u.input) * 100) : 0;
      out(`- rounds ${JSON.stringify(thread.rounds ?? {})} · turns ${u.turns ?? 0} · input ${Math.round((u.input ?? 0) / 1000)}k tokens (${cachedPct}% cached) · output ${Math.round((u.output ?? 0) / 1000)}k tokens · ${u.seconds ?? 0}s`);
      if (thread.activeJobId) out(`- RUNNING job ${thread.activeJobId}`);
      out(`- transcript: ${threadPaths(ctx.projectRoot, name).transcript}`);
    }
    if (ledger.items.length) {
      const conv = convergence(ledger);
      const counts = tally(ledger);
      out("");
      out(renderLedger(ledger));
      out("");
      out(`Loop: ${conv.state} · blocking open: ${conv.blocking.join(", ") || "none"} · minor open: ${conv.minorOpen.join(", ") || "none"}`);
      out(`Statuses: ${JSON.stringify(counts.byStatus)} · Claude decisions: ${JSON.stringify(counts.claudeDecisions)}`);
    } else if (sub === "ledger") {
      out("(ledger empty)");
    }
    return EXIT.ok;
  }
  if (sub === "reset") {
    const lock = readLock(ctx.projectRoot, name);
    const lockOwner = `reset-${process.pid}`;
    try {
      acquireThreadLock(ctx.projectRoot, name, { jobId: lockOwner, launcherPid: process.pid }, { retryMs: 0 });
    } catch (error) {
      out(`Cannot reset "${name}": ${error.message}`);
      return EXIT.ok;
    }
    try {
      const archived = archiveThread(ctx.projectRoot, name);
      out(archived.length ? `Archived thread "${name}" (${archived.length} file(s)). The Codex session itself is kept by Codex; coworker simply stops using it.` : `No thread "${name}".`);
      if (lock) out(`(Broke a stale lock from job ${lock.jobId}.)`);
    } finally {
      releaseThreadLock(ctx.projectRoot, name, lockOwner);
    }
    return EXIT.ok;
  }
  if (sub === "unlock") {
    try {
      const removed = forceUnlockThread(ctx.projectRoot, name);
      out(removed.length ? `Cleared ${removed.join(" + ")} for thread "${name}".` : `Thread "${name}" had no lock to clear.`);
    } catch (error) {
      out(`Not unlocking "${name}": ${error.message}`);
    }
    return EXIT.ok;
  }
  throw new UsageError(`Unknown threads subcommand "${sub}" (list|show|ledger|reset|unlock).`);
}

function cmdTaskState(argv) {
  const { flags, positionals } = parseArgs(argv, { booleans: ["json"], strings: ["phase", "note", "project", "cwd", "plan"], arrays: ["set"] });
  const ctx = context(flags);
  const slug = positionals[0];
  if (!slug || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(slug)) throw new UsageError("task-state needs a task slug (letters, digits, . _ -).");
  ensureStateDir(ctx.projectRoot);
  const dir = path.join(stateDir(ctx.projectRoot), "work", slug);
  const file = path.join(dir, "task.json");
  const state = readJson(file) ?? { slug, createdAt: new Date().toISOString(), phase: "new", notes: [] };
  let changed = false;
  if (flags.phase) {
    state.phase = flags.phase;
    changed = true;
  }
  if (flags.plan) {
    state.plan = flags.plan;
    changed = true;
  }
  for (const pair of flags.set ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw new UsageError(`--set expects key=value, got "${pair}".`);
    state[pair.slice(0, eq)] = pair.slice(eq + 1);
    changed = true;
  }
  if (flags.note) {
    state.notes = [...(state.notes ?? []), { at: new Date().toISOString(), text: flags.note }].slice(-50);
    changed = true;
  }
  if (changed) {
    state.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, state);
  }
  out(JSON.stringify({ ...state, dir }, null, 2));
  return EXIT.ok;
}

function cmdMode(argv) {
  const { flags, positionals } = parseArgs(argv, { booleans: ["global"], strings: ["project", "cwd"] });
  const ctx = context(flags);
  const sub = positionals[0] ?? "status";
  const file = flags.global ? globalConfigPath() : ctx.sources.project;
  if (sub === "on" || sub === "off") {
    if (!flags.global) ensureStateDir(ctx.projectRoot);
    writeConfigKey(file, "autoMode", sub === "on");
    out(`coworker auto mode ${sub === "on" ? "ON" : "OFF"} (${flags.global ? "global default" : `project ${ctx.projectRoot}`}; written to ${file}).`);
    if (sub === "on") {
      out("From now on, non-trivial code changes in this project go through the plan → implement → review dialogue with GPT-6 Astra (coworker:task). Small edits and questions skip it.");
    }
    return EXIT.ok;
  }
  if (sub === "status") {
    const effective = loadConfig({ projectRoot: ctx.projectRoot }).config.autoMode;
    out(`coworker auto mode: ${effective ? "ON" : "off"} (project file: ${ctx.sources.project}; global: ${globalConfigPath()})`);
    return EXIT.ok;
  }
  throw new UsageError(`Unknown mode "${sub}" (on|off|status).`);
}

// ------------------------------------------------------------------ hook (must never block the prompt)

const INTENT = /(구현|추가|수정|고쳐|고치|리팩|변경|만들|옮겨|개선|적용|바꿔|작성해|짜줘|fix|implement|add|refactor|migrate|build|change|update|rewrite|create)/i;

function cmdHook(argv) {
  try {
    if (argv[0] !== "prompt-submit") return;
    let raw = "";
    try {
      raw = fs.readFileSync(0, "utf8");
    } catch {
      return;
    }
    const input = JSON.parse(raw || "{}");
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
    if (!projectDir) return;
    const project = readJson(path.join(projectDir, ".coworker", "config.json"));
    const globalConfig = readJson(globalConfigPath());
    const autoMode = project && !project.__corrupt && project.autoMode !== undefined ? project.autoMode : globalConfig?.autoMode;
    if (!autoMode) return;
    const prompt = String(input.prompt ?? "").trim();
    if (prompt.startsWith("/") || prompt.length < 15) return;
    const markerDir = path.join(projectDir, ".coworker", "hook-sessions");
    const marker = path.join(markerDir, String(input.session_id ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_"));
    const first = !fs.existsSync(marker);
    if (first) {
      fs.mkdirSync(markerDir, { recursive: true });
      const ignore = path.join(projectDir, ".coworker", ".gitignore");
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
      fs.writeFileSync(marker, new Date().toISOString());
      out(
        "coworker auto mode is on for this project. In this mode, code changes of roughly 50+ lines or with a design decision go through the coworker:task skill: Claude drafts a plan, GPT-6 Astra (via Codex) critiques it, Claude implements, then Astra reviews the diff over a tracked issue ledger. Questions, small edits and trivial fixes skip the dialogue, and Claude notes the skip in one line (\"Astra 협업 생략: 소규모 변경\"). The user can turn this off with /coworker:mode off.",
      );
    } else if (INTENT.test(prompt)) {
      out("coworker auto mode is on: if this request will change ~50+ lines or involves a design choice, it goes through the coworker:task skill (plan and review dialogue with GPT-6 Astra); otherwise it is skipped with a one-line note.");
    }
  } catch {
    // never block or break the user's prompt
  }
}

// ------------------------------------------------------------------ help

const HELP = `coworker — Claude Code ⇄ GPT-6 Astra (Codex CLI) collaboration

Turns (each is a background job; the CLI waits up to --wait-budget, default 540s):
  coworker ask    --thread T --message-file F [--attach F]… [--claude-view F] [--new]
  coworker plan   --thread T --message-file F [--attach plan.md]… [--responses R.json] [--new]
  coworker review --thread T [--uncommitted | --base REF | --commit SHA] [--paths P]… [--focus TEXT]
                  [--message-file F] [--plan-file F] [--responses R.json] [--deep] [--new]
  coworker debate --thread T --stage open  --brief F --claude-proposal F
  coworker debate --thread T --stage cross --message-file F
  coworker debate --thread T --stage final --claude-final F
  common: --effort low|medium|high|xhigh|max|ultra  --model M  --lang ko|en|auto  --timeout S
          --wait-budget S (0 = start and return)  --detach  --extra-round  --isolation strict|inherit
          --project DIR (state location; default $CLAUDE_PROJECT_DIR or git root)  --cwd DIR (git target)

Jobs:     coworker wait [JOB | --thread T]   coworker cancel [JOB | --thread T]   coworker jobs [--prune]
Threads:  coworker threads [list | show T | ledger T | reset T | unlock T]
Task:     coworker task-state SLUG [--phase P] [--plan PATH] [--set k=v]… [--note TEXT]
Setup:    coworker status [--ping] [--json] [--refresh]    coworker mode [on|off|status] [--global]

responses JSON (for plan/review rounds ≥ 2) — one entry per open item:
  [{"id":"R1","decision":"accept|partial|reject|defer|user","rationale":"…","evidence":"…","change_ref":"…"}]
`;

// ------------------------------------------------------------------ main

async function main() {
  const raw = process.argv.slice(2);
  const command = raw[0];
  let rest = normalizeArgv(raw.slice(1));
  // Skills inject `coworker <cmd> --project "${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`: expand the
  // user's raw text shell-style (quotes respected, never evaluated).
  const argsAt = rest.indexOf("--args");
  if (argsAt !== -1) {
    const words = splitShellWords(String(rest[argsAt + 1] ?? ""));
    rest = [...rest.slice(0, argsAt), ...words, ...rest.slice(argsAt + 2)];
  }

  if (command === "_spawn") {
    spawnSupervisor(SCRIPT, raw[1]);
    return EXIT.ok;
  }
  if (command === "_supervise") {
    await superviseJob(raw[1], { finalize: finalizeTurn });
    return EXIT.ok;
  }
  if (command === "hook") {
    cmdHook(rest);
    return EXIT.ok;
  }

  try {
    switch (command) {
      case "ask":
      case "plan":
      case "review":
      case "debate":
        return await cmdTurn(command, rest);
      case "wait":
        return await cmdWait(rest);
      case "cancel":
        return await cmdCancel(rest);
      case "status":
        return cmdStatus(rest);
      case "jobs":
        return cmdJobs(rest);
      case "threads":
        return cmdThreads(rest);
      case "task-state":
        return cmdTaskState(rest);
      case "mode":
        return cmdMode(rest);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        out(HELP);
        return EXIT.ok;
      default:
        throw new UsageError(`Unknown command "${command}". Run \`coworker help\`.`);
    }
  } catch (error) {
    // Ops commands run inside skills' `!` lines, where any non-zero exit discards the whole skill and the
    // user never sees why. Report their errors on stdout and exit 0.
    if (["status", "threads", "jobs", "mode", "task-state"].includes(command)) {
      out(`coworker ${command}: ${error.message}`);
      out(`Run \`coworker help\` for usage.`);
      return EXIT.ok;
    }
    if (error instanceof UsageError || error.code === "USAGE") {
      err(`coworker: ${error.message}`);
      out(statusLine({ state: "usage_error" }));
      return EXIT.usage;
    }
    if (error.code === "MUTEX_STALE") {
      err(`coworker: ${error.message}`);
      out(statusLine({ state: "busy" }));
      return EXIT.busy;
    }
    if (error.code === "THREAD_BUSY") {
      err(`coworker: ${error.message}`);
      out(statusLine({ state: "busy", jobId: error.jobId }));
      return EXIT.busy;
    }
    if (error instanceof TurnError || ["NEEDS_RESPONSES", "ROUND_LIMIT", "NOTHING_TO_REVIEW", "INVALID_RESPONSES"].includes(error.code)) {
      err(`coworker: ${error.message}`);
      out(statusLine({ state: String(error.code ?? "error").toLowerCase() }));
      return error.code === "START_FAILED" ? EXIT.startFailed : EXIT.usage;
    }
    if (error.code === "START_FAILED") {
      err(`coworker: ${error.message}`);
      out(statusLine({ state: "start_failed" }));
      return EXIT.startFailed;
    }
    err(`coworker: ${error.stack ?? error.message}`);
    out(statusLine({ state: "error" }));
    return EXIT.failed;
  }
}

main().then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (error) => {
    err(`coworker: ${error.stack ?? error}`);
    process.exitCode = 1;
  },
);
