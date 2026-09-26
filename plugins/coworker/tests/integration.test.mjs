// Integration tests: drive the real coworker CLI as a subprocess against the fake Codex
// (tests/fixtures/fake-codex.mjs). Every test gets its own temp git repo, its own XDG cache/config dirs
// and passes --project <repo>, so nothing touches the user's real state.
//
//   node --test --test-concurrency=1 tests/integration.test.mjs
//
// Temp root: $COWORKER_TEST_TMPDIR (default: os.tmpdir()). Set COWORKER_TEST_KEEP=1 to keep the dirs.
// Tests named "regression: …" pin defects this suite found (all fixed). Mark a newly found, still-open
// defect with { todo: "BUG: …" } so it runs and is reported without failing the suite.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "coworker.mjs");
const BIN = path.join(PLUGIN_ROOT, "bin", "coworker");
const FAKE = path.join(HERE, "fixtures", "fake-codex.mjs");
const MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const BIG_TEXT = "가나다라마바사아자차카타파하 ".repeat(12000);

// ------------------------------------------------------------------ temp root

function makeBase() {
  const requested = process.env.COWORKER_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(requested, { recursive: true });
  const real = fs.realpathSync(requested);
  for (const forbidden of [PLUGIN_ROOT, MARKETPLACE_ROOT]) {
    if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`Refusing to create test repos inside ${forbidden}; set COWORKER_TEST_TMPDIR elsewhere.`);
    }
  }
  return fs.mkdtempSync(path.join(real, "coworker-it-"));
}

const BASE = makeBase();
const WARM_CACHE = path.join(BASE, "_warm-cache");
let counter = 0;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(COWORKER_|FAKE_CODEX_|XDG_|GIT_|NODE_TEST)/.test(key) || key === "CLAUDE_PROJECT_DIR" || key === "BASH_MAX_TIMEOUT_MS") {
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

before(() => {
  // Probe the Codex binaries once (fake + any real ones on this machine, read-only probes) and reuse the
  // capability cache file in every test's own XDG cache dir, so tests do not each pay for probing.
  fs.mkdirSync(WARM_CACHE, { recursive: true });
  const warmRepo = path.join(BASE, "_warm-repo");
  fs.mkdirSync(warmRepo, { recursive: true });
  const result = spawnSync(process.execPath, [CLI, "status", "--json", "--project", warmRepo], {
    cwd: warmRepo,
    env: withOverrides(cleanEnv(), { XDG_CACHE_HOME: WARM_CACHE, XDG_CONFIG_HOME: path.join(BASE, "_warm-config"), CODEX_HOME: path.join(BASE, "_warm-codex-home"), COWORKER_CODEX_BIN: FAKE }),
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, `warm-up status failed:\n${result.stdout}\n${result.stderr}`);
});

after(() => {
  if (process.env.COWORKER_TEST_KEEP !== "1") fs.rmSync(BASE, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tryJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseStatusLine(stdout) {
  const lines = String(stdout ?? "").trimEnd().split("\n");
  const raw = lines[lines.length - 1] ?? "";
  const fields = { raw };
  const match = raw.match(/^COWORKER (.*)$/);
  if (!match) return fields;
  for (const [, key, value] of match[1].matchAll(/(\w+)=(\S+)/g)) fields[key] = value;
  return fields;
}

function psLines(args) {
  const result = spawnSync("ps", args, { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function commandOf(pid) {
  return psLines(["-ww", "-o", "command=", "-p", String(pid)]).trim() || null;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  const stat = psLines(["-o", "stat=", "-p", String(pid)]).trim();
  return Boolean(stat) && !stat.startsWith("Z");
}

function ppidOf(pid) {
  return Number(psLines(["-o", "ppid=", "-p", String(pid)]).trim()) || null;
}

/** Every descendant of rootPid, found by walking PPIDs (what Claude Code does to stop a Bash task). */
function descendantsOf(rootPid) {
  const children = new Map();
  for (const line of psLines(["-A", "-o", "pid=,ppid="]).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length) {
    const pid = stack.pop();
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

function safeKill(pid, sig = "SIGKILL") {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn, { timeout = 15000, interval = 100, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    await sleep(interval);
  }
}

const coworkerDir = (repo) => path.join(repo, ".coworker");
const jobDir = (repo, jobId) => path.join(repo, ".coworker", "jobs", jobId);
const jobFile = (repo, jobId, name) => path.join(jobDir(repo, jobId), name);
const jobStatus = (repo, jobId) => tryJson(jobFile(repo, jobId, "status.json"));
const threadFile = (repo, name) => path.join(repo, ".coworker", "threads", `${name}.json`);
const threadMeta = (repo, name) => tryJson(threadFile(repo, name));
const ledgerOf = (repo, name) => tryJson(path.join(repo, ".coworker", "threads", `${name}.ledger.json`));
const lockFile = (repo, name) => path.join(repo, ".coworker", "locks", `${name}.lock`);

function listJobIds(repo) {
  try {
    return fs.readdirSync(path.join(repo, ".coworker", "jobs")).sort().reverse();
  } catch {
    return [];
  }
}

/** SIGKILL any supervisor/codex process (and its descendants) a test left behind. */
function killJobProcesses(repo) {
  for (const jobId of listJobIds(repo)) {
    const status = jobStatus(repo, jobId);
    for (const pid of [status?.codexPid, status?.supervisorPid]) {
      if (!pid || !isAlive(pid) || !(commandOf(pid) ?? "").includes(jobId)) continue;
      for (const child of descendantsOf(pid)) safeKill(child);
      safeKill(pid);
    }
  }
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

/**
 * Fresh sandbox: <BASE>/<nn-name>/{repo (git, one commit), xdg-cache, xdg-config, codex-log.jsonl}.
 */
function setup(t) {
  counter += 1;
  const dir = path.join(BASE, `${String(counter).padStart(2, "0")}-${slug(t.name)}`);
  const repo = path.join(dir, "repo");
  const cache = path.join(dir, "xdg-cache");
  const config = path.join(dir, "xdg-config");
  for (const sub of [repo, cache, config]) fs.mkdirSync(sub, { recursive: true });
  const warm = path.join(WARM_CACHE, "coworker", "codex-capabilities.json");
  if (fs.existsSync(warm)) {
    fs.mkdirSync(path.join(cache, "coworker"), { recursive: true });
    fs.copyFileSync(warm, path.join(cache, "coworker", "codex-capabilities.json"));
  }
  const gitconfig = path.join(dir, "gitconfig");
  fs.writeFileSync(gitconfig, "[user]\n\tname = Coworker Test\n\temail = coworker-test@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const log = path.join(dir, "codex-log.jsonl");
  const baseEnv = withOverrides(cleanEnv(), {
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    // Safety net: a real Codex binary (should one ever be picked by mistake) finds no credentials here.
    CODEX_HOME: path.join(dir, "codex-home"),
    COWORKER_CODEX_BIN: FAKE,
    FAKE_CODEX_LOG: log,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
  });
  const extraPids = [];

  const ctx = {
    dir,
    repo,
    cache,
    config,
    log,
    P: ["--project", repo],
    env: (extra) => withOverrides(baseEnv, extra),
    trackPid: (pid) => extraPids.push(pid),
    git(args) {
      const result = spawnSync("git", args, { cwd: repo, env: baseEnv, encoding: "utf8" });
      assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
      return result.stdout;
    },
    write(rel, content) {
      const file = path.join(repo, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    },
    /** Run the CLI synchronously. */
    cli(args, { env, input, timeout = 120000, bin = false } = {}) {
      const started = Date.now();
      const command = bin ? BIN : process.execPath;
      const argv = bin ? args : [CLI, ...args];
      const result = spawnSync(command, argv, { cwd: repo, env: withOverrides(baseEnv, env), input, encoding: "utf8", timeout });
      const out = {
        code: result.status,
        signal: result.signal,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        ms: Date.now() - started,
      };
      out.st = parseStatusLine(out.stdout);
      out.dump = () => `coworker ${args.join(" ")}\nexit=${out.code} signal=${out.signal} (${out.ms}ms)\n--- stdout\n${out.stdout.slice(-4000)}\n--- stderr\n${out.stderr.slice(-4000)}`;
      return out;
    },
    logEntries() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };

  ctx.git(["init", "-q"]);
  ctx.write("README.md", "# sandbox\n");
  ctx.git(["add", "-A"]);
  ctx.git(["commit", "-q", "-m", "init"]);

  t.after(() => {
    killJobProcesses(repo);
    for (const pid of extraPids) if (isAlive(pid)) safeKill(pid);
  });
  return ctx;
}

async function waitRunning(ctx, jobId, { needCodex = true, timeout = 15000 } = {}) {
  return waitFor(() => {
    const status = jobStatus(ctx.repo, jobId);
    return status?.state === "running" && status.supervisorPid && (!needCodex || status.codexPid) ? status : null;
  }, { timeout, what: `job ${jobId} to be running` });
}

async function waitTerminal(ctx, jobId, state, { timeout = 20000 } = {}) {
  return waitFor(() => {
    const status = jobStatus(ctx.repo, jobId);
    return status?.state === state ? status : null;
  }, { timeout, what: `job ${jobId} to reach ${state}` });
}

/**
 * Ops commands (status, threads, jobs, mode, task-state) run inside skills' `!` lines, where a non-zero exit
 * hides the output, so they report errors on stdout and exit 0. Accept that or a classic usage error.
 */
function assertRefused(r, pattern) {
  assert.ok([0, 3, 64].includes(r.code), r.dump());
  assert.match(`${r.stdout}\n${r.stderr}`, pattern, r.dump());
}

function planResult(over = {}) {
  return {
    verdict: "revise",
    assessment: "complete",
    summary: "Needs work.",
    approach: { assessment: "sound", reason: "fits the codebase", alternative: "" },
    limitations: [],
    prior: [],
    items: [],
    questions: [],
    ...over,
  };
}

function planItem(severity, title) {
  return { kind: "issue", severity, section: "Design", title, problem: `${title} problem`, suggestion: "do better", evidence: "src/x.js:1", basis: "verified", confidence: "high", verify_by: "" };
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

// ------------------------------------------------------------------ 1 ask + resume

test("1 ask succeeds, and the next turn resumes the same Codex session with a digest instead of the role", (t) => {
  const ctx = setup(t);
  const r1 = ctx.cli(["ask", "--thread", "t1", "--message", "first question about the parser", ...ctx.P]);
  assert.equal(r1.code, 0, r1.dump());
  assert.equal(r1.st.status, "succeeded", r1.dump());
  assert.equal(r1.st.thread, "t1");
  const job1 = r1.st.job;
  assert.equal(r1.st.result, jobFile(ctx.repo, job1, "result.md"));
  assert.match(r1.stdout, /fake reply \(resume=false\)/);

  // files under .coworker/
  assert.equal(fs.readFileSync(path.join(coworkerDir(ctx.repo), ".gitignore"), "utf8"), "*\n");
  for (const name of ["meta.json", "status.json", "prompt.md", "events.jsonl", "stderr.log", "last.txt", "result.md", "result.json", "supervisor.log"]) {
    assert.ok(fs.existsSync(jobFile(ctx.repo, job1, name)), `${name} missing`);
  }
  const log = ctx.logEntries();
  assert.equal(log.length, 1);
  const status1 = jobStatus(ctx.repo, job1);
  assert.equal(status1.state, "succeeded");
  assert.equal(status1.sessionId, log[0].sessionId);
  assert.ok(status1.supervisorPid && status1.codexPid && status1.finishedAt);
  const meta1 = readJson(jobFile(ctx.repo, job1, "meta.json"));
  assert.equal(meta1.kind, "ask");
  assert.equal(meta1.round, 1);
  assert.equal(meta1.initializedBefore, false);
  assert.equal(fs.readFileSync(jobFile(ctx.repo, job1, "prompt.md"), "utf8"), log[0].stdin);

  let thread = threadMeta(ctx.repo, "t1");
  assert.equal(thread.initialized, true);
  assert.equal(thread.sessionId, log[0].sessionId);
  assert.deepEqual(thread.rounds, { ask: 1 });
  assert.equal(thread.activeJobId, null);
  assert.equal(thread.turns.length, 1);
  assert.equal(thread.turns[0].state, "succeeded");
  assert.equal(thread.cwd, fs.realpathSync(ctx.repo));
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "t1")), "lock must be released");
  const transcript = fs.readFileSync(path.join(coworkerDir(ctx.repo), "threads", "t1.md"), "utf8");
  assert.match(transcript, /first question about the parser/);
  assert.match(transcript, /### Astra → Claude/);

  // first invocation: a fresh exec with the full role contract, prompt on stdin
  assert.equal(log[0].argv[0], "exec");
  assert.notEqual(log[0].argv[1], "resume");
  assert.equal(log[0].argv.at(-1), "-");
  assert.ok(log[0].argv.includes("--json"));
  const oIndex = log[0].argv.indexOf("-o");
  assert.equal(log[0].argv[oIndex + 1], jobFile(ctx.repo, job1, "last.txt"));
  assert.equal(log[0].cwd, fs.realpathSync(ctx.repo));
  assert.match(log[0].stdin, /<role>/);
  assert.doesNotMatch(log[0].stdin, /<turn_digest>/);
  assert.match(log[0].stdin, /first question about the parser/);

  // second turn resumes the session: exec resume <sessionId> -
  const r2 = ctx.cli(["ask", "--thread", "t1", "--message", "follow-up question", ...ctx.P]);
  assert.equal(r2.code, 0, r2.dump());
  assert.equal(r2.st.status, "succeeded");
  assert.notEqual(r2.st.job, job1);
  assert.match(r2.stdout, /fake reply \(resume=true\)/);
  const log2 = ctx.logEntries();
  assert.equal(log2.length, 2);
  assert.deepEqual(log2[1].argv.slice(0, 2), ["exec", "resume"]);
  assert.equal(log2[1].argv.at(-1), "-");
  assert.equal(log2[1].argv.at(-2), log[0].sessionId);
  assert.equal(log2[1].sessionId, log[0].sessionId);
  assert.match(log2[1].stdin, /<turn_digest>/);
  assert.doesNotMatch(log2[1].stdin, /<role>/);
  assert.match(log2[1].stdin, /follow-up question/);

  thread = threadMeta(ctx.repo, "t1");
  assert.equal(thread.sessionId, log[0].sessionId);
  assert.deepEqual(thread.rounds, { ask: 2 });
  assert.equal(thread.turns.length, 2);
  assert.equal(thread.usageTotals.turns, 2);
  assert.equal(readJson(jobFile(ctx.repo, r2.st.job, "meta.json")).initializedBefore, true);
});

// ------------------------------------------------------------------ 2 first-turn failure

test("2 a failed first turn leaves the thread uninitialized, records the dropped session, and the retry starts fresh", (t) => {
  const ctx = setup(t);
  const r1 = ctx.cli(["ask", "--thread", "f", "--message", "hello", ...ctx.P], { env: { FAKE_CODEX_MODE: "fail" } });
  assert.equal(r1.code, 1, r1.dump());
  assert.equal(r1.st.status, "failed");
  const status = jobStatus(ctx.repo, r1.st.job);
  assert.equal(status.state, "failed");
  assert.match(status.error, /stream disconnected before completion/);
  assert.equal(status.deliveryUnknown, true);
  assert.match(fs.readFileSync(jobFile(ctx.repo, r1.st.job, "result.md"), "utf8"), /Delivery unknown/);

  const log = ctx.logEntries();
  let thread = threadMeta(ctx.repo, "f");
  assert.equal(thread.initialized, false);
  assert.equal(thread.sessionId, null);
  assert.deepEqual(thread.droppedSessions, [log[0].sessionId]);
  assert.equal(thread.lastFailed.state, "failed");
  assert.equal(thread.lastFailed.jobId, r1.st.job);
  assert.equal(thread.activeJobId, null);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "f")));

  const r2 = ctx.cli(["ask", "--thread", "f", "--message", "hello again", ...ctx.P]);
  assert.equal(r2.code, 0, r2.dump());
  const log2 = ctx.logEntries();
  assert.equal(log2.length, 2);
  assert.notEqual(log2[1].argv[1], "resume", "must not resume a session that never initialized");
  assert.match(log2[1].stdin, /<role>/);
  assert.doesNotMatch(log2[1].stdin, /\(Retry:/);
  thread = threadMeta(ctx.repo, "f");
  assert.equal(thread.initialized, true);
  assert.equal(thread.sessionId, log2[1].sessionId);
  assert.notEqual(thread.sessionId, log[0].sessionId);
  assert.equal(thread.lastFailed, null);

  // a failure on an initialized thread makes the next message carry the retry label
  const r3 = ctx.cli(["ask", "--thread", "f", "--message", "third", ...ctx.P], { env: { FAKE_CODEX_MODE: "fail" } });
  assert.equal(r3.code, 1, r3.dump());
  assert.equal(threadMeta(ctx.repo, "f").initialized, true);
  const r4 = ctx.cli(["ask", "--thread", "f", "--message", "fourth", ...ctx.P]);
  assert.equal(r4.code, 0, r4.dump());
  const log4 = ctx.logEntries();
  assert.equal(log4[3].argv[1], "resume");
  assert.match(log4[3].stdin, /\(Retry: my previous message may not have reached you/);
});

// ------------------------------------------------------------------ 3 outdated

test("3 an outdated Codex CLI fails with errorCode codex_outdated and an upgrade hint", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "old", "--message", "hello", ...ctx.P], { env: { FAKE_CODEX_MODE: "outdated" } });
  assert.equal(r.code, 1, r.dump());
  assert.equal(r.st.status, "failed");
  const status = jobStatus(ctx.repo, r.st.job);
  assert.equal(status.state, "failed");
  assert.equal(status.errorCode, "codex_outdated");
  assert.match(status.error, /requires a newer version of Codex/);
  assert.match(status.hint, /too old for this model/);
  const result = fs.readFileSync(jobFile(ctx.repo, r.st.job, "result.md"), "utf8");
  assert.match(result, /Hint: The selected Codex CLI is too old/);
  assert.match(r.stdout, /Hint: The selected Codex CLI is too old/);
  assert.equal(readJson(jobFile(ctx.repo, r.st.job, "result.json")).state, "failed");
});

// ------------------------------------------------------------------ 4 wait budget

test("4 a slow turn past --wait-budget exits 75 (waiting) and `coworker wait` collects it", (t) => {
  const ctx = setup(t);
  const slow = { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "4000" };
  const r = ctx.cli(["ask", "--thread", "slow", "--message", "take your time", "--wait-budget", "1", ...ctx.P], { env: slow });
  assert.equal(r.code, 75, r.dump());
  assert.equal(r.st.status, "waiting");
  assert.equal(r.st.thread, "slow");
  const job = r.st.job;
  assert.match(r.stdout, new RegExp(`coworker wait ${job}`));
  assert.ok(r.ms < 4000, `returned after ${r.ms}ms`);
  const status = jobStatus(ctx.repo, job);
  assert.ok(["starting", "running"].includes(status.state));
  assert.equal(readJson(lockFile(ctx.repo, "slow")).jobId, job);
  assert.equal(threadMeta(ctx.repo, "slow").activeJobId, job);

  const w = ctx.cli(["wait", job, ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.status, "succeeded");
  assert.equal(w.st.job, job);
  assert.equal(w.st.thread, "slow");
  assert.match(w.stdout, /fake reply/);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "slow")));

  // BASH_MAX_TIMEOUT_MS caps the budget at (bash timeout - 30s): 31s → 1s
  const r2 = ctx.cli(["ask", "--thread", "slow2", "--message", "again", ...ctx.P], { env: { ...slow, FAKE_CODEX_DELAY_MS: "3000", BASH_MAX_TIMEOUT_MS: "31000" } });
  assert.equal(r2.code, 75, r2.dump());
  const w2 = ctx.cli(["wait", "--thread", "slow2", ...ctx.P]);
  assert.equal(w2.code, 0, w2.dump());
  assert.equal(w2.st.job, r2.st.job);
});

// ------------------------------------------------------------------ 5 detach

test("5 --detach returns at once and the job still completes after the launcher exits", async (t) => {
  const ctx = setup(t);
  const started = Date.now();
  const r = ctx.cli(["ask", "--thread", "bg", "--message", "background please", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500" } });
  const elapsed = Date.now() - started;
  assert.equal(r.code, 75, r.dump());
  assert.equal(r.st.status, "waiting");
  assert.ok(elapsed < 3000, `--detach took ${elapsed}ms`);
  assert.match(r.stdout, /Started job /);
  const job = r.st.job;
  const running = await waitRunning(ctx, job);
  assert.ok(isAlive(running.supervisorPid), "supervisor must be alive after the launcher exited");
  const done = await waitTerminal(ctx, job, "succeeded");
  assert.ok(done.finishedAt);
  assert.ok(fs.existsSync(jobFile(ctx.repo, job, "result.md")));
  assert.equal(threadMeta(ctx.repo, "bg").initialized, true);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "bg")));
  const w = ctx.cli(["wait", job, ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.status, "succeeded");
});

// ------------------------------------------------------------------ 6 Claude Code kills the task tree

test("6 SIGKILLing the launcher and its whole descendant tree does not stop the job (double fork)", async (t) => {
  const ctx = setup(t);
  const child = spawn(process.execPath, [CLI, "ask", "--thread", "tree", "--message", "survive the kill", "--wait-budget", "60", ...ctx.P], {
    cwd: ctx.repo,
    env: ctx.env({ FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "4000" }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => safeKill(child.pid));

  const job = await waitFor(() => {
    const [latest] = listJobIds(ctx.repo);
    return latest && jobStatus(ctx.repo, latest)?.state === "running" ? latest : null;
  }, { what: "a running job" });
  await sleep(600);
  const status = jobStatus(ctx.repo, job);
  const tree = descendantsOf(child.pid);
  assert.ok(!tree.includes(status.supervisorPid), "the supervisor must not be in the launcher's process tree");
  assert.ok(!tree.includes(status.codexPid), "codex must not be in the launcher's process tree");
  for (const pid of [child.pid, ...tree]) safeKill(pid);
  safeKill(-child.pid);
  const exit = await exited;
  assert.equal(exit.signal, "SIGKILL", output);

  assert.ok(isAlive(status.supervisorPid), "supervisor died with the launcher tree");
  const parent = ppidOf(status.supervisorPid);
  assert.ok(parent && parent !== child.pid && !tree.includes(parent), `supervisor ppid ${parent} is inside the killed tree`);
  await waitTerminal(ctx, job, "succeeded");
  assert.equal(threadMeta(ctx.repo, "tree").initialized, true);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "tree")));
  const w = ctx.cli(["wait", job, ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.status, "succeeded");
});

// ------------------------------------------------------------------ 7 cancel

test("7 cancel stops a hung Codex, releases the lock, and the thread stays usable", async (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "h", "--message", "never answers", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(r.code, 75, r.dump());
  const job = r.st.job;
  const running = await waitRunning(ctx, job);
  assert.ok(isAlive(running.codexPid));
  assert.ok(fs.existsSync(lockFile(ctx.repo, "h")));

  const c = ctx.cli(["cancel", job, ...ctx.P]);
  assert.equal(c.code, 0, c.dump());
  assert.equal(c.st.status, "cancelled", c.dump());
  assert.equal(c.st.job, job);
  assert.match(c.stdout, new RegExp(`Job ${job} → cancelled`));
  const status = jobStatus(ctx.repo, job);
  assert.equal(status.state, "cancelled");
  assert.equal(status.deliveryUnknown, true);
  assert.ok(fs.existsSync(jobFile(ctx.repo, job, "cancel.request")));
  await waitFor(() => !isAlive(running.codexPid), { timeout: 5000, what: "codex to exit" });
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "h")), "lock must be removed");
  let thread = threadMeta(ctx.repo, "h");
  assert.equal(thread.activeJobId, null);
  assert.equal(thread.turns.at(-1).state, "cancelled");
  assert.equal(thread.initialized, false);
  assert.equal(thread.droppedSessions.length, 1);

  const again = ctx.cli(["cancel", job, ...ctx.P]);
  assert.equal(again.code, 0, again.dump());
  assert.match(again.stdout, /had already finished \(cancelled\)/);

  const r2 = ctx.cli(["ask", "--thread", "h", "--message", "are you there?", ...ctx.P]);
  assert.equal(r2.code, 0, r2.dump());
  assert.equal(r2.st.status, "succeeded");
  thread = threadMeta(ctx.repo, "h");
  assert.equal(thread.initialized, true);
});

// ------------------------------------------------------------------ 8 busy

test("8 a second turn on a busy thread exits 3; other threads are unaffected", async (t) => {
  const ctx = setup(t);
  const r1 = ctx.cli(["ask", "--thread", "b", "--message", "long one", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "5000" } });
  assert.equal(r1.code, 75, r1.dump());
  const job1 = r1.st.job;

  const r2 = ctx.cli(["ask", "--thread", "b", "--message", "impatient", ...ctx.P]);
  assert.equal(r2.code, 3, r2.dump());
  assert.equal(r2.st.status, "busy");
  assert.equal(r2.st.job, job1);
  assert.match(r2.stderr, new RegExp(`busy with job ${job1}`));
  assert.deepEqual(listJobIds(ctx.repo), [job1], "a rejected turn must not create a job");

  const other = ctx.cli(["ask", "--thread", "other", "--message", "independent", ...ctx.P]);
  assert.equal(other.code, 0, other.dump());

  const w = ctx.cli(["wait", "--thread", "b", ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.job, job1);
  const r3 = ctx.cli(["ask", "--thread", "b", "--message", "now it is free", ...ctx.P]);
  assert.equal(r3.code, 0, r3.dump());
});

// ------------------------------------------------------------------ 9 supervisor killed

for (const via of ["wait", "jobs"]) {
  test(`9 a SIGKILLed supervisor is detected by \`${via}\`: job interrupted, lock released, orphaned codex killed`, async (t) => {
    const ctx = setup(t);
    const helperFile = path.join(ctx.dir, "helper.pid");
    const thread = `k-${via}`;
    const r = ctx.cli(["ask", "--thread", thread, "--message", "hang", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "hang", FAKE_CODEX_HELPER_PIDFILE: helperFile } });
    assert.equal(r.code, 75, r.dump());
    const job = r.st.job;
    // a realistic hang: the supervisor has already recorded Codex's session id when it dies
    const running = await waitFor(() => {
      const status = jobStatus(ctx.repo, job);
      return status?.state === "running" && status.codexPid && status.sessionId ? status : null;
    }, { what: "running job with a session id" });
    const helperPid = await waitFor(() => Number(tryJson(helperFile)) || null, { what: "helper pid" });
    ctx.trackPid(helperPid);

    assert.ok(safeKill(running.supervisorPid, "SIGKILL"));
    await waitFor(() => !isAlive(running.supervisorPid), { timeout: 5000, what: "supervisor to die" });
    assert.ok(isAlive(running.codexPid), "codex is orphaned but still running");
    assert.ok(fs.existsSync(lockFile(ctx.repo, thread)));

    if (via === "wait") {
      const w = ctx.cli(["wait", job, "--wait-budget", "20", ...ctx.P]);
      assert.equal(w.code, 1, w.dump());
      assert.equal(w.st.status, "interrupted");
      assert.equal(w.st.job, job);
      assert.match(w.stdout, /ended as interrupted/);
    } else {
      const j = ctx.cli(["jobs", ...ctx.P]);
      assert.equal(j.code, 0, j.dump());
      assert.match(j.stdout, new RegExp(`${job} .*→ interrupted`));
    }
    const status = jobStatus(ctx.repo, job);
    assert.equal(status.state, "interrupted");
    assert.match(status.error, /supervisor process disappeared/);
    assert.equal(status.deliveryUnknown, true);
    assert.ok(!fs.existsSync(lockFile(ctx.repo, thread)), "lock must be released");
    await waitFor(() => !isAlive(running.codexPid), { timeout: 5000, what: "orphaned codex to be killed" });
    await waitFor(() => !isAlive(helperPid), { timeout: 5000, what: "codex helper to be killed" });

    const next = ctx.cli(["ask", "--thread", thread, "--message", "after the crash", ...ctx.P]);
    assert.equal(next.code, 0, next.dump());
  });
}

// ------------------------------------------------------------------ 10 plan loop

test("10 plan loop: needs_reply → NEEDS_RESPONSES → rulings → converged → ROUND_LIMIT → --extra-round", (t) => {
  const ctx = setup(t);
  const base = ["plan", "--thread", "p", "--message", "Plan: add a cache layer in front of the parser.", ...ctx.P];
  const r1 = ctx.cli(base, { env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ items: [planItem("major", "Missing rollback"), planItem("minor", "Naming")] })) } });
  assert.equal(r1.code, 0, r1.dump());
  assert.equal(r1.st.status, "succeeded");
  assert.equal(r1.st.loop, "needs_reply");
  assert.match(r1.stdout, /\*\*P1\*\*/);
  assert.match(r1.stdout, /\*\*P2\*\*/);
  const result1 = readJson(jobFile(ctx.repo, r1.st.job, "result.json"));
  assert.deepEqual(result1.added, ["P1", "P2"]);
  assert.equal(result1.loop.state, "needs_reply");
  assert.deepEqual(result1.loop.blocking, ["P1"]);
  assert.deepEqual(result1.loop.minorOpen, ["P2"]);
  assert.equal(jobStatus(ctx.repo, r1.st.job).loop.state, "needs_reply");
  let ledger = ledgerOf(ctx.repo, "p");
  assert.deepEqual(ledger.items.map((item) => [item.id, item.severity, item.status]), [["P1", "major", "open"], ["P2", "minor", "open"]]);
  const log1 = ctx.logEntries();
  assert.ok(log1[0].argv.includes("--output-schema"));

  // round 2 without responses is refused before any Codex turn
  const noResp = ctx.cli(base);
  assert.equal(noResp.code, 64, noResp.dump());
  assert.equal(noResp.st.status, "needs_responses");
  assert.match(noResp.stderr, /P1, P2/);
  assert.equal(listJobIds(ctx.repo).length, 1);
  assert.equal(ctx.logEntries().length, 1);

  // invalid responses are refused too
  const badFile = path.join(ctx.dir, "bad-responses.json");
  fs.writeFileSync(badFile, JSON.stringify([{ id: "P9", decision: "accept", rationale: "x" }]));
  const bad = ctx.cli([...base, "--responses", badFile]);
  assert.equal(bad.code, 64, bad.dump());
  assert.equal(bad.st.status, "invalid_responses");
  assert.match(bad.stderr, /unknown id "P9"/);
  assert.equal(ctx.logEntries().length, 1);

  const responsesFile = path.join(ctx.dir, "responses.json");
  fs.writeFileSync(responsesFile, JSON.stringify([
    { id: "P1", decision: "accept", rationale: "added a rollback step", change_ref: "plan.md#rollback" },
    { id: "P2", decision: "defer", rationale: "rename in a follow-up" },
  ]));
  const r2json = planResult({
    verdict: "approve",
    prior: [
      { id: "P1", status: "fixed_verified", new_severity: null, reason: "rollback present", evidence: "plan §4" },
      { id: "P2", status: "accepted_deferral", new_severity: null, reason: "fine", evidence: "" },
    ],
  });
  const r2 = ctx.cli([...base, "--responses", responsesFile], { env: { FAKE_CODEX_JSON: JSON.stringify(r2json) } });
  assert.equal(r2.code, 0, r2.dump());
  assert.equal(r2.st.loop, "converged");
  ledger = ledgerOf(ctx.repo, "p");
  assert.deepEqual(ledger.items.map((item) => [item.id, item.status]), [["P1", "resolved"], ["P2", "deferred_ok"]]);
  assert.deepEqual(ledger.items[0].history.map((entry) => `${entry.actor}:${entry.event}`), ["astra:raised", "claude:accept", "astra:fixed_verified"]);
  assert.ok(fs.existsSync(jobFile(ctx.repo, r2.st.job, "responses.json")));
  const log2 = ctx.logEntries();
  assert.equal(log2.length, 2);
  assert.equal(log2[1].argv[1], "resume");
  assert.match(log2[1].stdin, /<claude_responses>/);
  assert.match(log2[1].stdin, /P1 .*→ \*\*accept\*\*: added a rollback step/);
  assert.match(log2[1].stdin, /Items awaiting your ruling: P1, P2\./);
  assert.match(log2[1].stdin, /<ledger /);
  assert.doesNotMatch(log2[1].stdin, /<role>/);
  assert.deepEqual(threadMeta(ctx.repo, "p").rounds, { plan: 2 });

  // round 3 exceeds maxRounds.plan (2)
  const r3 = ctx.cli(base, { env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ verdict: "approve" })) } });
  assert.equal(r3.code, 64, r3.dump());
  assert.equal(r3.st.status, "round_limit");
  assert.match(r3.stderr, /maxRounds=2/);
  assert.equal(ctx.logEntries().length, 2);

  const lateRuling = planResult({ verdict: "approve", prior: [{ id: "P1", status: "maintained", new_severity: null, reason: "late", evidence: "" }] });
  const r3x = ctx.cli([...base, "--extra-round"], { env: { FAKE_CODEX_JSON: JSON.stringify(lateRuling) } });
  assert.equal(r3x.code, 0, r3x.dump());
  assert.equal(r3x.st.loop, "converged");
  assert.equal(ledgerOf(ctx.repo, "p").items[0].status, "resolved", "a late ruling must not reopen a closed item");
  assert.match(r3x.stdout, /already-closed items: P1/);
  assert.equal(ledgerOf(ctx.repo, "p").rounds.length, 3);
  assert.deepEqual(threadMeta(ctx.repo, "p").rounds, { plan: 3 });
});

// ------------------------------------------------------------------ 11 review

test("11 review: uncommitted + untracked in the diff, round-2 delta, and a stale round when files change mid-review", async (t) => {
  const ctx = setup(t);
  ctx.write("src/app.js", "line1\nline2\n");
  ctx.git(["add", "-A"]);
  ctx.git(["commit", "-q", "-m", "app"]);
  ctx.write("src/app.js", "line1\nline2 changed\n");
  ctx.write("src/new.js", "export const fresh = 1;\n");
  const approve = { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) };

  const r1 = ctx.cli(["review", "--thread", "rv", "--uncommitted", ...ctx.P], { env: approve });
  assert.equal(r1.code, 0, r1.dump());
  assert.equal(r1.st.status, "succeeded");
  assert.equal(r1.st.loop, "converged");
  const prompt1 = fs.readFileSync(jobFile(ctx.repo, r1.st.job, "prompt.md"), "utf8");
  for (const needle of ["src/app.js", "+line2 changed", "-line2", "src/new.js", "+export const fresh = 1;", "Target: uncommitted changes vs HEAD"]) {
    assert.ok(prompt1.includes(needle), `round-1 prompt lacks ${needle}`);
  }
  const diff1 = fs.readFileSync(jobFile(ctx.repo, r1.st.job, "diff.patch"), "utf8");
  assert.match(diff1, /\+export const fresh = 1;/);
  assert.match(diff1, /\+line2 changed/);
  assert.equal(ctx.logEntries()[0].stdin, prompt1);
  // the user's real index is untouched (new.js still untracked)
  assert.deepEqual(ctx.git(["status", "--porcelain"]).split("\n").filter(Boolean).sort(), ["?? src/new.js", " M src/app.js"].sort());
  const meta1 = readJson(jobFile(ctx.repo, r1.st.job, "meta.json"));
  assert.equal(meta1.target.live, true);
  let thread = threadMeta(ctx.repo, "rv");
  assert.equal(thread.lastReviewTree, meta1.target.head);
  assert.equal(thread.lastTarget.mode, "uncommitted");

  // round 2 after another edit: only the delta is highlighted
  ctx.write("src/app.js", "line1\nline2 changed\nline3 added\n");
  const r2 = ctx.cli(["review", "--thread", "rv", ...ctx.P], { env: approve });
  assert.equal(r2.code, 0, r2.dump());
  const prompt2 = fs.readFileSync(jobFile(ctx.repo, r2.st.job, "prompt.md"), "utf8");
  assert.match(prompt2, /Changes since your last review round/);
  assert.match(prompt2, /<turn_digest>/);
  const delta = fs.readFileSync(jobFile(ctx.repo, r2.st.job, "delta.patch"), "utf8");
  assert.match(delta, /\+line3 added/);
  assert.doesNotMatch(delta, /export const fresh/);
  assert.equal(ctx.logEntries()[1].argv[1], "resume");
  thread = threadMeta(ctx.repo, "rv");
  assert.deepEqual(thread.rounds, { review: 2 });
  assert.equal(thread.lastReviewTree, readJson(jobFile(ctx.repo, r2.st.job, "meta.json")).target.head);

  // a file changes while a slow review runs → loop=stale
  const r3 = ctx.cli(["review", "--thread", "rv-stale", "--uncommitted", "--detach", ...ctx.P], {
    env: { ...approve, FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500" },
  });
  assert.equal(r3.code, 75, r3.dump());
  await waitRunning(ctx, r3.st.job);
  ctx.write("src/app.js", "line1\nline2 changed\nline3 added\nedited during review\n");
  const w = ctx.cli(["wait", r3.st.job, ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.status, "succeeded");
  assert.equal(w.st.loop, "stale");
  assert.match(fs.readFileSync(jobFile(ctx.repo, r3.st.job, "result.md"), "utf8"), /Loop state: `stale`/);
  assert.equal(ledgerOf(ctx.repo, "rv-stale").rounds[0].loopState, "stale");
  assert.equal(threadMeta(ctx.repo, "rv-stale").lastReviewTree, undefined, "a stale snapshot must not become the delta base");

  // nothing to review on a clean tree
  ctx.git(["add", "-A"]);
  ctx.git(["commit", "-q", "-m", "all"]);
  const clean = ctx.cli(["review", "--thread", "clean", "--uncommitted", ...ctx.P], { env: approve });
  assert.equal(clean.code, 64, clean.dump());
  assert.equal(clean.st.status, "nothing_to_review");
});

// ------------------------------------------------------------------ 12 invalid structured output

test("12 unparseable structured output → invalid_output (exit 1), but the session advanced", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["plan", "--thread", "bad", "--message", "Plan: something", ...ctx.P], { env: { FAKE_CODEX_JSON: "not json" } });
  assert.equal(r.code, 1, r.dump());
  assert.equal(r.st.status, "invalid_output");
  const status = jobStatus(ctx.repo, r.st.job);
  assert.equal(status.state, "invalid_output");
  assert.match(status.error, /structured output did not parse/);
  const result = fs.readFileSync(jobFile(ctx.repo, r.st.job, "result.md"), "utf8");
  assert.match(result, /Raw output/);
  assert.match(result, /not json/);
  const log = ctx.logEntries();
  const thread = threadMeta(ctx.repo, "bad");
  assert.equal(thread.initialized, true);
  assert.equal(thread.sessionId, log[0].sessionId);
  assert.equal(ledgerOf(ctx.repo, "bad"), null, "no ledger items from unparseable output");

  const next = ctx.cli(["plan", "--thread", "bad", "--message", "Plan: something (again)", ...ctx.P], { env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ verdict: "approve" })) } });
  assert.equal(next.code, 0, next.dump());
  assert.equal(ctx.logEntries()[1].argv[1], "resume");
});

// ------------------------------------------------------------------ 13 session lost

test("13 a resumed session Codex no longer has → exit 4 status=session_lost; --new recovers", (t) => {
  const ctx = setup(t);
  const r1 = ctx.cli(["ask", "--thread", "s", "--message", "hello", ...ctx.P]);
  assert.equal(r1.code, 0, r1.dump());
  const r2 = ctx.cli(["ask", "--thread", "s", "--message", "still there?", ...ctx.P], { env: { FAKE_CODEX_MODE: "lost" } });
  assert.equal(r2.code, 4, r2.dump());
  assert.equal(r2.st.status, "session_lost");
  assert.equal(jobStatus(ctx.repo, r2.st.job).state, "session_lost");
  assert.match(r2.stdout, /--new/);
  assert.equal(ctx.logEntries()[1].argv[1], "resume");

  const r3 = ctx.cli(["ask", "--thread", "s", "--new", "--message", "recap: we were discussing X", ...ctx.P]);
  assert.equal(r3.code, 0, r3.dump());
  const log = ctx.logEntries();
  assert.notEqual(log[2].argv[1], "resume");
  assert.match(log[2].stdin, /<role>/);
  const archived = fs.readdirSync(path.join(coworkerDir(ctx.repo), "threads")).filter((name) => name.endsWith(".bak"));
  assert.ok(archived.some((name) => name.startsWith("s.json.")), `archived: ${archived}`);
  assert.equal(threadMeta(ctx.repo, "s").sessionId, log[2].sessionId);
});

// ------------------------------------------------------------------ 14 reconnect + bigline

test("14 transient reconnect errors still succeed; a ~500 KB Korean line arrives intact", (t) => {
  const ctx = setup(t);
  const r1 = ctx.cli(["ask", "--thread", "rc", "--message", "hello", ...ctx.P], { env: { FAKE_CODEX_MODE: "reconnect" } });
  assert.equal(r1.code, 0, r1.dump());
  assert.equal(r1.st.status, "succeeded");
  assert.equal(jobStatus(ctx.repo, r1.st.job).state, "succeeded");

  const r2 = ctx.cli(["ask", "--thread", "big", "--message", "긴 답을 주세요", ...ctx.P], { env: { FAKE_CODEX_MODE: "bigline", FAKE_CODEX_BIG_FINAL: "1" } });
  assert.equal(r2.code, 0, r2.dump());
  assert.equal(r2.st.status, "succeeded");
  const result = fs.readFileSync(jobFile(ctx.repo, r2.st.job, "result.md"), "utf8");
  assert.ok(result.includes(BIG_TEXT.trim()), "result.md lost part of the Korean text");
  for (const [label, text] of [["result.md", result], ["stdout", r2.stdout], ["stderr", r2.stderr], ["events", fs.readFileSync(jobFile(ctx.repo, r2.st.job, "events.jsonl"), "utf8")]]) {
    assert.ok(!text.includes("�"), `U+FFFD in ${label}`);
  }
  // the chunked event was decoded by the follower (progress line) and parses as one JSON line
  assert.ok((r2.stderr.match(/💬 가나다라마바사아자차카타파하/g) ?? []).length >= 2, r2.stderr.slice(0, 2000));
  const bigEvent = fs.readFileSync(jobFile(ctx.repo, r2.st.job, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.item?.id === "item_big");
  assert.equal(bigEvent.item.text, BIG_TEXT);
  assert.match(r2.stdout, /\[truncated\b[^\]]*result\.md\]/, "the truncation note must point at the full result file");
  assert.equal(parseStatusLine(r2.stdout).status, "succeeded");
});

// ------------------------------------------------------------------ 15 hook

test("15 hook prompt-submit: silent unless auto mode; long reminder once per session, short one for coding prompts", (t) => {
  const ctx = setup(t);
  const hook = (payload, { raw, env } = {}) => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [CLI, "hook", "prompt-submit"], {
      cwd: ctx.repo,
      env: ctx.env({ CLAUDE_PROJECT_DIR: ctx.repo, ...env }),
      input: raw ?? JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10000,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started };
  };
  const base = { session_id: "sess-1", cwd: ctx.repo, hook_event_name: "UserPromptSubmit" };
  const LONG = /coworker auto mode is on for this project/;
  const SHORT = /^coworker auto mode is on: if this request/;

  let r = hook({ ...base, prompt: "로그인 기능 구현해줘 여러 파일 수정" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "auto mode off must be silent");
  assert.ok(!fs.existsSync(path.join(coworkerDir(ctx.repo), "hook-sessions")));

  fs.mkdirSync(coworkerDir(ctx.repo), { recursive: true });
  fs.writeFileSync(path.join(coworkerDir(ctx.repo), "config.json"), JSON.stringify({ autoMode: true }));

  r = hook({ ...base, prompt: "이 저장소의 전체 구조를 간단히 설명해 주세요" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, LONG);
  assert.ok(r.ms < 5000, `hook took ${r.ms}ms (hook timeout is 5s)`);
  assert.ok(fs.existsSync(path.join(coworkerDir(ctx.repo), "hook-sessions", "sess-1")));

  r = hook({ ...base, prompt: "이 함수가 어떤 역할을 하는지 설명해 주세요" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "", "second non-coding prompt must be silent");

  r = hook({ ...base, prompt: "로그인 기능 구현해줘 여러 파일 수정" });
  assert.equal(r.code, 0);
  assert.match(r.stdout, SHORT);
  assert.doesNotMatch(r.stdout, LONG);

  r = hook({ ...base, prompt: "/coworker:status" });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");

  for (const raw of ["{not json", "", "[1,2", "null"]) {
    r = hook(null, { raw });
    assert.equal(r.code, 0, `stdin ${JSON.stringify(raw)}`);
    assert.equal(r.stdout, "", `stdin ${JSON.stringify(raw)} produced output`);
  }

  // another session gets the long reminder once again
  r = hook({ ...base, session_id: "sess-2", prompt: "이 저장소의 전체 구조를 간단히 설명해 주세요" });
  assert.match(r.stdout, LONG);

  // without CLAUDE_PROJECT_DIR the payload's cwd is used
  r = hook({ ...base, session_id: "sess-3", prompt: "이 저장소의 전체 구조를 간단히 설명해 주세요" }, { env: { CLAUDE_PROJECT_DIR: undefined } });
  assert.match(r.stdout, LONG);

  // project "off" overrides a global "on"
  fs.mkdirSync(path.join(ctx.config, "coworker"), { recursive: true });
  fs.writeFileSync(path.join(ctx.config, "coworker", "config.json"), JSON.stringify({ autoMode: true }));
  fs.writeFileSync(path.join(coworkerDir(ctx.repo), "config.json"), JSON.stringify({ autoMode: false }));
  r = hook({ ...base, session_id: "sess-4", prompt: "로그인 기능 구현해줘 여러 파일 수정" });
  assert.equal(r.stdout, "");
});

// ------------------------------------------------------------------ 16 status / threads / jobs

test("16 status, jobs and threads list/show/reset (reset refuses while a job runs)", async (t) => {
  const ctx = setup(t);
  const s = ctx.cli(["status", ...ctx.P], { bin: true });
  assert.equal(s.code, 0, s.dump());
  assert.match(s.stdout, /^# coworker status/m);
  assert.match(s.stdout, /## Codex CLI/);
  assert.ok(s.stdout.includes(`${FAKE} ← chosen`), s.stdout);
  assert.match(s.stdout, /OK\s+chosen: 0\.158\.0 \(explicit override\)/);
  assert.match(s.stdout, /OK\s+login: Logged in using ChatGPT/);
  assert.match(s.stdout, /## Threads\n- none yet/);

  const sj = ctx.cli(["status", "--json", "--ping", ...ctx.P]);
  assert.equal(sj.code, 0, sj.dump());
  const report = JSON.parse(sj.stdout);
  assert.equal(report.chosen.path, FAKE);
  assert.equal(report.login.ok, true);
  assert.equal(report.ping.ok, true, JSON.stringify(report.ping));
  assert.deepEqual(report.threads, []);
  assert.ok(!fs.readdirSync(coworkerDir(ctx.repo)).some((name) => name.startsWith("ping-")), "ping scratch file left behind");

  const a = ctx.cli(["ask", "--thread", "alpha", "--message", "hi", ...ctx.P]);
  assert.equal(a.code, 0, a.dump());
  const sessionId = threadMeta(ctx.repo, "alpha").sessionId;

  let l = ctx.cli(["threads", ...ctx.P]);
  assert.equal(l.code, 0, l.dump());
  assert.match(l.stdout, /^- alpha {2}rounds=\{"ask":1\} {2}turns=1/m);
  const lj = ctx.cli(["threads", "list", "--json", ...ctx.P]);
  assert.equal(JSON.parse(lj.stdout)[0].name, "alpha");
  const show = ctx.cli(["threads", "show", "alpha", ...ctx.P]);
  assert.equal(show.code, 0, show.dump());
  assert.match(show.stdout, /^# Thread alpha/m);
  assert.ok(show.stdout.includes(`session ${sessionId}`));
  assert.ok(show.stdout.includes(path.join(coworkerDir(ctx.repo), "threads", "alpha.md")));
  const missing = ctx.cli(["threads", "show", "nosuch", ...ctx.P]);
  assert.equal(missing.code, 0);
  assert.match(missing.stdout, /No thread "nosuch"/);

  const jobs = ctx.cli(["jobs", "--json", ...ctx.P]);
  assert.equal(jobs.code, 0, jobs.dump());
  assert.deepEqual(JSON.parse(jobs.stdout).map((job) => [job.jobId, job.thread, job.state]), [[a.st.job, "alpha", "succeeded"]]);

  // reset while a job runs → busy
  const h = ctx.cli(["ask", "--thread", "alpha", "--message", "hang", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(h.code, 75, h.dump());
  await waitRunning(ctx, h.st.job);
  const sRun = ctx.cli(["status", ...ctx.P]);
  assert.match(sRun.stdout, /## Running jobs/);
  assert.ok(sRun.stdout.includes(`RUNNING ${h.st.job}`));
  const busy = ctx.cli(["threads", "reset", "alpha", ...ctx.P]);
  assertRefused(busy, /Cannot reset "alpha": .*busy/);
  assert.ok(fs.existsSync(threadFile(ctx.repo, "alpha")), "thread must survive a refused reset");
  assert.equal(readJson(lockFile(ctx.repo, "alpha")).jobId, h.st.job, "refused reset must not touch the job's lock");

  const c = ctx.cli(["cancel", "--thread", "alpha", ...ctx.P]);
  assert.equal(c.code, 0, c.dump());
  assert.equal(c.st.status, "cancelled");

  const reset = ctx.cli(["threads", "reset", "alpha", ...ctx.P]);
  assert.equal(reset.code, 0, reset.dump());
  assert.match(reset.stdout, /Archived thread "alpha"/);
  assert.ok(!fs.existsSync(threadFile(ctx.repo, "alpha")));
  const archived = fs.readdirSync(path.join(coworkerDir(ctx.repo), "threads"));
  assert.ok(archived.some((name) => /^alpha\.json\..*\.bak$/.test(name)), archived.join(","));
  assert.ok(archived.some((name) => /^alpha\.md\..*\.bak$/.test(name)), archived.join(","));
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "alpha")));
  l = ctx.cli(["threads", "list", ...ctx.P]);
  assert.match(l.stdout, /No threads yet\./);
  const again = ctx.cli(["threads", "reset", "alpha", ...ctx.P]);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /No thread "alpha"/);

  assertRefused(ctx.cli(["threads", "bogus", "alpha", ...ctx.P]), /Unknown threads subcommand "bogus"/);
  assertRefused(ctx.cli(["threads", "reset", ...ctx.P]), /threads reset needs a thread name/);
});

// ------------------------------------------------------------------ extra coverage

test("17 cancel escalates to SIGKILL when Codex ignores SIGINT, and kills helpers in their own process groups", async (t) => {
  const ctx = setup(t);
  const helperFile = path.join(ctx.dir, "helper.pid");
  const r = ctx.cli(["ask", "--thread", "stubborn", "--message", "ignore ctrl-c", "--detach", ...ctx.P], {
    env: { FAKE_CODEX_MODE: "hang", FAKE_CODEX_IGNORE_SIGINT: "1", FAKE_CODEX_HELPER_PIDFILE: helperFile },
  });
  assert.equal(r.code, 75, r.dump());
  const running = await waitRunning(ctx, r.st.job);
  const helperPid = await waitFor(() => Number(tryJson(helperFile)) || null, { what: "helper pid" });
  ctx.trackPid(helperPid);
  assert.ok(isAlive(helperPid));
  const c = ctx.cli(["cancel", r.st.job, ...ctx.P], { timeout: 60000 });
  assert.equal(c.code, 0, c.dump());
  assert.equal(c.st.status, "cancelled", c.dump());
  assert.ok(c.ms >= 9000, `cancel returned after ${c.ms}ms, before the SIGINT grace period`);
  await waitFor(() => !isAlive(running.codexPid), { timeout: 5000, what: "codex SIGKILLed" });
  await waitFor(() => !isAlive(helperPid), { timeout: 5000, what: "helper SIGKILLed" });
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "stubborn")));
});

/**
 * Write a job directory exactly as launchJob does (meta, prompt, empty logs, status "created", the thread
 * record and its lock), so the real double fork (`_spawn`) can run it with settings the CLI would refuse.
 */
function craftJob(ctx, { thread, timeoutSec }) {
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  const jobId = `${stamp}-ask-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;
  const dir = jobDir(ctx.repo, jobId);
  const now = new Date().toISOString();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["events.jsonl", "stderr.log", "supervisor.log"]) fs.writeFileSync(path.join(dir, name), "");
  fs.writeFileSync(path.join(dir, "prompt.md"), "hang please\n");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({
    jobId, jobDir: dir, projectRoot: ctx.repo, thread, kind: "ask", createdAt: now,
    codex: { bin: FAKE, args: ["exec", "--json", "--skip-git-repo-check", "-o", path.join(dir, "last.txt"), "-"], cwd: fs.realpathSync(ctx.repo) },
    timeoutSec, round: 1, maxRounds: 99, effort: "high", model: "gpt-6-astra", lang: "en", schemaPath: null,
    initializedBefore: false, message: "hang please", attachments: [], hasResponses: false,
  }));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "created", launcherPid: process.pid, updatedAt: now }));
  fs.mkdirSync(path.join(coworkerDir(ctx.repo), "threads"), { recursive: true });
  fs.writeFileSync(threadFile(ctx.repo, thread), JSON.stringify({ name: thread, cwd: fs.realpathSync(ctx.repo), createdAt: now, initialized: false, sessionId: null, droppedSessions: [], rounds: {}, turns: [], usageTotals: { input: 0, cached: 0, output: 0, seconds: 0, turns: 0 }, activeJobId: jobId, updatedAt: now }));
  fs.mkdirSync(path.join(coworkerDir(ctx.repo), "locks"), { recursive: true });
  fs.writeFileSync(lockFile(ctx.repo, thread), JSON.stringify({ jobId, launcherPid: process.pid, createdAt: now }));
  return { jobId, dir };
}

test("18 the supervisor's hard timeout stops a hung turn: timed_out, exit 1, delivery unknown", async (t) => {
  // The CLI refuses --timeout < 30s, so drive the real double fork with a crafted 1-second job.
  const ctx = setup(t);
  const { jobId, dir } = craftJob(ctx, { thread: "to", timeoutSec: 1 });
  const spawned = spawnSync(process.execPath, [CLI, "_spawn", dir], { cwd: ctx.repo, env: ctx.env({ FAKE_CODEX_MODE: "hang" }), encoding: "utf8", timeout: 20000 });
  assert.equal(spawned.status, 0, spawned.stderr);
  const w = ctx.cli(["wait", jobId, ...ctx.P]);
  assert.equal(w.code, 1, w.dump());
  assert.equal(w.st.status, "timed_out");
  const status = jobStatus(ctx.repo, jobId);
  assert.equal(status.state, "timed_out");
  assert.equal(status.deliveryUnknown, true);
  assert.match(w.stdout, /Delivery unknown/);
  await waitFor(() => !isAlive(status.codexPid), { timeout: 5000, what: "codex to exit" });
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "to")));
  const thread = threadMeta(ctx.repo, "to");
  assert.equal(thread.activeJobId, null);
  assert.equal(thread.lastFailed.state, "timed_out");
  assert.equal(ctx.logEntries().length, 1);
});

test("19 mode on/off/status, task-state, help and usage errors", (t) => {
  const ctx = setup(t);
  let r = ctx.cli(["mode", "status", ...ctx.P]);
  assert.equal(r.code, 0, r.dump());
  assert.match(r.stdout, /auto mode: off/);
  r = ctx.cli(["mode", "on", ...ctx.P]);
  assert.equal(r.code, 0, r.dump());
  assert.equal(readJson(path.join(coworkerDir(ctx.repo), "config.json")).autoMode, true);
  assert.equal(fs.readFileSync(path.join(coworkerDir(ctx.repo), ".gitignore"), "utf8"), "*\n");
  r = ctx.cli(["mode", "status", ...ctx.P]);
  assert.match(r.stdout, /auto mode: ON/);
  r = ctx.cli(["mode", "off", ...ctx.P]);
  assert.equal(readJson(path.join(coworkerDir(ctx.repo), "config.json")).autoMode, false);
  assertRefused(ctx.cli(["mode", "sideways", ...ctx.P]), /Unknown mode "sideways"/);

  r = ctx.cli(["task-state", "login-fix", "--phase", "plan", "--note", "started", "--set", "owner=claude", ...ctx.P]);
  assert.equal(r.code, 0, r.dump());
  const state = JSON.parse(r.stdout);
  assert.equal(state.phase, "plan");
  assert.equal(state.owner, "claude");
  assert.equal(state.notes[0].text, "started");
  assert.ok(fs.existsSync(path.join(coworkerDir(ctx.repo), "work", "login-fix", "task.json")));
  assertRefused(ctx.cli(["task-state", "../escape", ...ctx.P]), /task-state needs a task slug/);
  assert.ok(!fs.existsSync(path.join(coworkerDir(ctx.repo), "escape")));

  r = ctx.cli(["wait", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());
  assert.match(r.stderr, /No jobs yet/);
  r = ctx.cli(["cancel", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());

  r = ctx.cli(["help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /coworker — Claude Code ⇄ GPT-6 Astra/);
  r = ctx.cli(["frobnicate", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());
  assert.equal(r.st.status, "usage_error");
  r = ctx.cli(["ask", "--thread", "x", "--bogus-flag", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());
  r = ctx.cli(["ask", "--thread", "x", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());
  assert.match(r.stderr, /ask needs --message-file or --message/);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "x")), "a usage error must release the lock");
  assert.equal(threadMeta(ctx.repo, "x"), null, "a usage error must not create the thread");
  // Skills pass "$ARGUMENTS" as ONE argv element
  r = ctx.cli(["ask", `--thread one --message "hello world" --project ${ctx.repo}`]);
  assert.equal(r.code, 0, r.dump());
  assert.match(ctx.logEntries().at(-1).stdin, /hello world/);
});

test("20 ask --claude-view seals the view outside the repo and reveals it only in the result", (t) => {
  const ctx = setup(t);
  const view = ctx.write(".coworker/work/view.md", "Claude thinks option B.\n");
  const r = ctx.cli(["ask", "--thread", "cv", "--message", "Which option?", "--claude-view", view, ...ctx.P]);
  assert.equal(r.code, 0, r.dump());
  assert.ok(!fs.existsSync(view), "the view file must be moved out of the repository");
  const meta = readJson(jobFile(ctx.repo, r.st.job, "meta.json"));
  assert.ok(meta.claudeView.startsWith(path.join(ctx.cache, "coworker", "sealed")), meta.claudeView);
  assert.doesNotMatch(ctx.logEntries()[0].stdin, /option B/);
  assert.match(r.stdout, /Claude's pre-registered view[\s\S]*Claude thinks option B/);
});

test("21 debate: open → cross → final with sealed proposals", (t) => {
  const ctx = setup(t);
  const brief = ctx.write(".coworker/work/brief.md", "Choose a cache: A) LRU  B) TTL\n");
  const proposal = ctx.write(".coworker/work/proposal.md", "PROPOSAL: LRU because hot keys.\n");
  let r = ctx.cli(["debate", "--thread", "d", "--stage", "cross", "--message", "x", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());
  r = ctx.cli(["debate", "--thread", "d", "--stage", "open", "--brief", brief, "--claude-proposal", proposal, ...ctx.P], { env: { FAKE_CODEX_REPLY: "Astra proposes TTL." } });
  assert.equal(r.code, 0, r.dump());
  assert.ok(!fs.existsSync(proposal));
  assert.doesNotMatch(ctx.logEntries()[0].stdin, /PROPOSAL: LRU/);
  assert.match(ctx.logEntries()[0].stdin, /Choose a cache/);
  r = ctx.cli(["debate", "--thread", "d", "--stage", "cross", "--message", "TTL misses hot keys.", ...ctx.P], { env: { FAKE_CODEX_REPLY: "Steelman..." } });
  assert.equal(r.code, 0, r.dump());
  assert.match(ctx.logEntries()[1].stdin, /PROPOSAL: LRU because hot keys/);
  assert.equal(ctx.logEntries()[1].argv[1], "resume");
  const final = ctx.write(".coworker/work/final.md", "PICK: LRU\nCONFIDENCE: high\n");
  r = ctx.cli(["debate", "--thread", "d", "--stage", "final", "--claude-final", final, ...ctx.P], { env: { FAKE_CODEX_REPLY: "PICK: lru\nCONFIDENCE: medium" } });
  assert.equal(r.code, 0, r.dump());
  assert.doesNotMatch(ctx.logEntries()[2].stdin, /PICK: LRU/);
  assert.match(r.stdout, /AGREE/);
  assert.deepEqual(readJson(jobFile(ctx.repo, r.st.job, "result.json")).picks, { claude: "LRU", astra: "lru", agree: true });
});

// ------------------------------------------------------------------ more loop states / failure modes

function reviewFinding(title, severity = "major") {
  return { severity, category: "bug", scope: "introduced", file: "src/app.js", line_start: 2, line_end: 2, title, failure_scenario: "call f(0) → NaN → wrong total", evidence: "src/app.js:2", basis: "verified", confidence: "high", recommendation: "guard zero", verify_by: "node -e 'f(0)'" };
}

test("22 review ledger: R ids, reject → maintained twice → deadlock; the round budget then stops the loop", (t) => {
  const ctx = setup(t);
  ctx.write("src/app.js", "line1\nline2\n");
  ctx.git(["add", "-A"]);
  ctx.git(["commit", "-q", "-m", "app"]);
  ctx.write("src/app.js", "line1\nline2 changed\n");
  const base = ["review", "--thread", "dl", ...ctx.P];
  const reject = path.join(ctx.dir, "reject.json");
  fs.writeFileSync(reject, JSON.stringify([{ id: "R1", decision: "reject", rationale: "f is never called with 0", evidence: "grep -n 'f(' src → only f(1)" }]));
  const maintained = JSON.stringify(reviewResult({ verdict: "request_changes", prior: [{ id: "R1", status: "maintained", new_severity: null, reason: "user input reaches f", evidence: "src/app.js:2" }] }));

  const r1 = ctx.cli([...base, "--uncommitted"], { env: { FAKE_CODEX_JSON: JSON.stringify(reviewResult({ verdict: "request_changes", findings: [reviewFinding("Division by zero")] })) } });
  assert.equal(r1.code, 0, r1.dump());
  assert.equal(r1.st.loop, "needs_reply");
  assert.match(r1.stdout, /\*\*R1\*\* .*major · bug · introduced — Division by zero/);
  assert.match(r1.stdout, /where: `src\/app\.js:2`/);
  let ledger = ledgerOf(ctx.repo, "dl");
  assert.equal(ledger.items[0].id, "R1");
  assert.equal(ledger.items[0].where, "src/app.js:2");

  const r2 = ctx.cli([...base, "--responses", reject], { env: { FAKE_CODEX_JSON: maintained } });
  assert.equal(r2.code, 0, r2.dump());
  assert.equal(r2.st.loop, "needs_reply");
  const prompt2 = fs.readFileSync(jobFile(ctx.repo, r2.st.job, "prompt.md"), "utf8");
  assert.match(prompt2, /No code changed since your last review round/);
  assert.match(prompt2, /R1 .*→ \*\*reject\*\*/);
  ledger = ledgerOf(ctx.repo, "dl");
  assert.equal(ledger.items[0].maintainedStreak, 1);

  const r3 = ctx.cli([...base, "--responses", reject], { env: { FAKE_CODEX_JSON: maintained } });
  assert.equal(r3.code, 0, r3.dump());
  assert.equal(r3.st.loop, "deadlock");
  assert.match(fs.readFileSync(jobFile(ctx.repo, r3.st.job, "result.md"), "utf8"), /- deadlocked: R1/);
  assert.equal(ledgerOf(ctx.repo, "dl").items[0].maintainedStreak, 2);

  const r4 = ctx.cli([...base, "--responses", reject], { env: { FAKE_CODEX_JSON: maintained } });
  assert.equal(r4.code, 64, r4.dump());
  assert.equal(r4.st.status, "round_limit");

  const ledgerCmd = ctx.cli(["threads", "ledger", "dl", ...ctx.P]);
  assert.equal(ledgerCmd.code, 0, ledgerCmd.dump());
  assert.match(ledgerCmd.stdout, /\| R1 \| major \| open \|/);
  assert.match(ledgerCmd.stdout, /Loop: deadlock/);
});

test("23 plan: blocking item still open at the last round → max_rounds; partial assessment → inconclusive, not converged", (t) => {
  const ctx = setup(t);
  const base = ["plan", "--thread", "mr", "--message", "Plan: migrate the store.", ...ctx.P];
  const r1 = ctx.cli(base, { env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ items: [planItem("blocker", "No rollback")] })) } });
  assert.equal(r1.code, 0, r1.dump());
  assert.equal(r1.st.loop, "needs_reply");
  const accept = path.join(ctx.dir, "accept.json");
  fs.writeFileSync(accept, JSON.stringify([{ id: "P1", decision: "accept", rationale: "added rollback" }]));
  const r2 = ctx.cli([...base, "--responses", accept], {
    env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ prior: [{ id: "P1", status: "fix_incomplete", new_severity: null, reason: "rollback skips the index", evidence: "" }] })) },
  });
  assert.equal(r2.code, 0, r2.dump());
  assert.equal(r2.st.loop, "max_rounds");
  assert.match(r2.stdout, /This is NOT approval/);

  const r3 = ctx.cli(["plan", "--thread", "partial", "--message", "Plan: y", ...ctx.P], {
    env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ verdict: "approve", assessment: "partial", limitations: ["could not open the migration files"] })) },
  });
  assert.equal(r3.code, 0, r3.dump());
  assert.equal(r3.st.loop, "inconclusive");
});

test("24 exit 5: Codex fails before starting (not logged in), or the thread's pinned Codex vanished", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "nl", "--message", "hi", ...ctx.P], { env: { FAKE_CODEX_MODE: "nologin" } });
  assert.equal(r.code, 5, r.dump());
  assert.equal(r.st.status, "start_failed");
  const status = jobStatus(ctx.repo, r.st.job);
  assert.equal(status.state, "start_failed");
  assert.equal(status.errorCode, "auth");
  assert.match(status.error, /Not logged in/);
  assert.doesNotMatch(status.error, /rmcp::/, "log noise must be filtered from the error");
  assert.match(status.hint, /codex login/);
  assert.equal(threadMeta(ctx.repo, "nl").initialized, false);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "nl")));

  // Pin a thread to a Codex copy that claims version 99, then delete the copy: no equal-or-newer binary
  // exists, so the turn must refuse to start instead of silently downgrading.
  const copy = path.join(ctx.dir, "codex-v99.mjs");
  fs.copyFileSync(FAKE, copy);
  fs.chmodSync(copy, 0o755);
  const pinned = ctx.cli(["ask", "--thread", "pin", "--message", "hi", ...ctx.P], { env: { COWORKER_CODEX_BIN: copy, FAKE_CODEX_VERSION: "codex-cli 99.0.0" } });
  assert.equal(pinned.code, 0, pinned.dump());
  assert.deepEqual(threadMeta(ctx.repo, "pin").binary, { path: copy, version: "99.0.0" });
  const probed = Object.entries(tryJson(path.join(ctx.cache, "coworker", "codex-capabilities.json")) ?? {});
  if (probed.some(([key, caps]) => !key.startsWith(fs.realpathSync(copy)) && caps.usable && Number(/^(\d+)/.exec(caps.version ?? "0")?.[1]) >= 99)) {
    t.skip("a real Codex >= 99 is installed; the no-replacement path cannot be exercised");
    return;
  }
  fs.rmSync(copy);
  const before = ctx.logEntries().length;
  const gone = ctx.cli(["ask", "--thread", "pin", "--message", "again", ...ctx.P], { env: { COWORKER_CODEX_BIN: undefined } });
  assert.equal(gone.code, 5, gone.dump());
  assert.equal(gone.st.status, "start_failed");
  assert.match(gone.stderr, /pinned binary .*unavailable/);
  assert.equal(ctx.logEntries().length, before, "no Codex may run");
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "pin")));
  assert.equal(threadMeta(ctx.repo, "pin").activeJobId, null);
});

test("25 Codex killed from outside (not by us) → crashed, delivery unknown; a completed turn without -o falls back to the last message", async (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "ext", "--message", "hang", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(r.code, 75, r.dump());
  const running = await waitFor(() => {
    const status = jobStatus(ctx.repo, r.st.job);
    return status?.state === "running" && status.codexPid && status.sessionId ? status : null;
  }, { what: "running job with a session id" });
  safeKill(running.codexPid, "SIGKILL");
  const w = ctx.cli(["wait", r.st.job, ...ctx.P]);
  assert.equal(w.code, 1, w.dump());
  assert.equal(w.st.status, "crashed");
  const status = jobStatus(ctx.repo, r.st.job);
  assert.equal(status.signal, "SIGKILL");
  assert.equal(status.deliveryUnknown, true);
  assert.match(w.stdout, /Delivery unknown/);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "ext")));
  assert.equal(threadMeta(ctx.repo, "ext").activeJobId, null);

  // Codex completed the turn but never wrote -o: the last agent message is the answer.
  const nj = ctx.cli(["ask", "--thread", "nj", "--message", "hi", ...ctx.P], { env: { FAKE_CODEX_MODE: "nojson" } });
  assert.equal(nj.code, 0, nj.dump());
  assert.equal(nj.st.status, "succeeded");
  assert.match(fs.readFileSync(jobFile(ctx.repo, nj.st.job, "result.md"), "utf8"), /fake reply \(resume=false\)/);
});

test("26 stale locks: an old lock whose job vanished is broken; a fresh one inside the start grace period is respected", (t) => {
  const ctx = setup(t);
  fs.mkdirSync(path.join(coworkerDir(ctx.repo), "locks"), { recursive: true });
  const old = { jobId: "20200101-000000-ask-deadbeef", launcherPid: 999999, createdAt: "2020-01-01T00:00:00.000Z" };
  fs.writeFileSync(lockFile(ctx.repo, "old"), JSON.stringify(old));
  const r1 = ctx.cli(["ask", "--thread", "old", "--message", "hi", ...ctx.P]);
  assert.equal(r1.code, 0, r1.dump());
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "old")));
  const leftovers = fs.readdirSync(path.join(coworkerDir(ctx.repo), "locks"));
  assert.deepEqual(leftovers, [], `lock dir leftovers: ${leftovers}`);

  const fresh = { jobId: "20200101-000000-ask-cafebabe", launcherPid: 999999, createdAt: new Date().toISOString() };
  fs.writeFileSync(lockFile(ctx.repo, "fresh"), JSON.stringify(fresh));
  const r2 = ctx.cli(["ask", "--thread", "fresh", "--message", "hi", ...ctx.P]);
  assert.equal(r2.code, 3, r2.dump());
  assert.equal(r2.st.job, fresh.jobId);
});

test("27 attachments are inlined; binary and oversized attachments are refused before any Codex turn", (t) => {
  const ctx = setup(t);
  const plan = ctx.write("docs/plan.md", "# Plan\nStep 1: cache.\n");
  const msg = ctx.write(".coworker/work/msg.md", "한국어로 검토해 주세요.\n");
  const r = ctx.cli(["ask", "--thread", "att", "--message-file", ".coworker/work/msg.md", "--attach", "docs/plan.md", ...ctx.P]);
  assert.equal(r.code, 0, r.dump());
  const stdin = ctx.logEntries()[0].stdin;
  assert.match(stdin, /<attachment path="docs\/plan\.md">/);
  assert.match(stdin, /Step 1: cache\./);
  assert.match(stdin, /한국어로 검토해 주세요/);
  assert.match(stdin, /Write prose in Korean/);
  assert.ok(fs.existsSync(msg));
  assert.ok(fs.existsSync(plan));

  const bin = path.join(ctx.dir, "blob.bin");
  fs.writeFileSync(bin, Buffer.from([1, 2, 0, 3]));
  const b = ctx.cli(["ask", "--thread", "att2", "--message", "x", "--attach", bin, ...ctx.P]);
  assert.equal(b.code, 64, b.dump());
  assert.match(b.stderr, /looks binary/);
  const big = path.join(ctx.dir, "big.txt");
  fs.writeFileSync(big, "x".repeat(300 * 1024));
  const g = ctx.cli(["ask", "--thread", "att2", "--message", "x", "--attach", big, ...ctx.P]);
  assert.equal(g.code, 64, g.dump());
  assert.match(g.stderr, /max 256 KB/);
  assert.equal(ctx.logEntries().length, 1);
  assert.equal(threadMeta(ctx.repo, "att2"), null);
});

test("28 a job the supervisor never acknowledged is settled by reconcile, and a late supervisor refuses to run Codex", (t) => {
  const ctx = setup(t);
  const jobId = "20200101-000000-ask-0badc0de";
  const dir = jobDir(ctx.repo, jobId);
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["events.jsonl", "stderr.log", "supervisor.log"]) fs.writeFileSync(path.join(dir, name), "");
  fs.writeFileSync(path.join(dir, "prompt.md"), "hi\n");
  const meta = {
    jobId, jobDir: dir, projectRoot: ctx.repo, thread: "late", kind: "ask", createdAt: old,
    codex: { bin: FAKE, args: ["exec", "--json", "--skip-git-repo-check", "-o", path.join(dir, "last.txt"), "-"], cwd: fs.realpathSync(ctx.repo) },
    timeoutSec: 60, round: 1, maxRounds: 99, effort: "high", model: "gpt-6-astra", lang: "en", schemaPath: null,
    initializedBefore: false, message: "hi", attachments: [], hasResponses: false,
  };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "created", launcherPid: 999999, updatedAt: old }));
  fs.mkdirSync(path.join(coworkerDir(ctx.repo), "threads"), { recursive: true });
  fs.writeFileSync(threadFile(ctx.repo, "late"), JSON.stringify({ name: "late", cwd: fs.realpathSync(ctx.repo), initialized: false, sessionId: null, droppedSessions: [], rounds: {}, turns: [], usageTotals: { input: 0, cached: 0, output: 0, seconds: 0, turns: 0 }, activeJobId: jobId, updatedAt: old }));
  fs.mkdirSync(path.join(coworkerDir(ctx.repo), "locks"), { recursive: true });
  fs.writeFileSync(lockFile(ctx.repo, "late"), JSON.stringify({ jobId, launcherPid: 999999, createdAt: old }));

  const j = ctx.cli(["jobs", "--json", ...ctx.P]);
  assert.equal(j.code, 0, j.dump());
  assert.equal(JSON.parse(j.stdout).find((job) => job.jobId === jobId).state, "interrupted");
  assert.match(fs.readFileSync(path.join(dir, "ack"), "utf8"), /^reconcile /);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "late")), "lock must be released");
  assert.equal(threadMeta(ctx.repo, "late").activeJobId, null);

  const late = spawnSync(process.execPath, [CLI, "_supervise", dir], { cwd: ctx.repo, env: ctx.env(), encoding: "utf8", timeout: 20000 });
  assert.equal(late.status, 0, late.stderr);
  assert.equal(ctx.logEntries().length, 0, "a late supervisor must not start Codex");
  assert.equal(jobStatus(ctx.repo, jobId).state, "interrupted");
  assert.match(fs.readFileSync(path.join(dir, "supervisor.log"), "utf8"), /abandoned/);
});

test("29 review targets: --base (commits + uncommitted + untracked), --commit (frozen, never stale), --paths outside git", (t) => {
  const ctx = setup(t);
  const approve = { FAKE_CODEX_JSON: JSON.stringify(reviewResult()) };
  ctx.git(["checkout", "-q", "-b", "feature"]);
  ctx.write("src/a.js", "export const a = 1;\n");
  ctx.git(["add", "-A"]);
  ctx.git(["commit", "-q", "-m", "a"]);
  ctx.write("src/b.js", "export const b = 2;\n");

  const base = ctx.cli(["review", "--thread", "base", "--base", "main", ...ctx.P], { env: approve });
  assert.equal(base.code, 0, base.dump());
  const basePrompt = fs.readFileSync(jobFile(ctx.repo, base.st.job, "prompt.md"), "utf8");
  assert.match(basePrompt, /Target: everything since main/);
  assert.match(basePrompt, /\+export const a = 1;/);
  assert.match(basePrompt, /\+export const b = 2;/);

  const commit = ctx.cli(["review", "--thread", "commit", "--commit", "HEAD", "--detach", ...ctx.P], { env: { ...approve, FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "1500" } });
  assert.equal(commit.code, 75, commit.dump());
  ctx.write("src/a.js", "export const a = 3; // edited during a commit review\n");
  const w = ctx.cli(["wait", commit.st.job, ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.loop, "converged", "a commit review is frozen and cannot go stale");
  const commitPrompt = fs.readFileSync(jobFile(ctx.repo, commit.st.job, "prompt.md"), "utf8");
  assert.match(commitPrompt, /Target: commit [0-9a-f]{12} vs its first parent/);
  assert.match(commitPrompt, /\+export const a = 1;/);
  assert.doesNotMatch(commitPrompt, /export const b/);
  assert.equal(readJson(jobFile(ctx.repo, commit.st.job, "meta.json")).target.live, false);

  const nogit = path.join(ctx.dir, "nogit");
  fs.mkdirSync(nogit);
  fs.writeFileSync(path.join(nogit, "f.txt"), "plain file\n");
  const paths = ctx.cli(["review", "--thread", "files", "--paths", "f.txt", "--project", nogit], { env: approve });
  assert.equal(paths.code, 0, paths.dump());
  const pathsPrompt = fs.readFileSync(path.join(nogit, ".coworker", "jobs", paths.st.job, "prompt.md"), "utf8");
  assert.match(pathsPrompt, /Target: files: f\.txt/);
  assert.match(pathsPrompt, /Review the listed files as they are now/);
});

test("30 usage: cumulative session usage reported on resumed turns is converted to per-turn deltas", (t) => {
  const ctx = setup(t);
  const first = { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 42, reasoning_output_tokens: 7 };
  const cumulative = { input_tokens: 2500, cached_input_tokens: 1200, output_tokens: 100, reasoning_output_tokens: 20 };
  const r1 = ctx.cli(["ask", "--thread", "u", "--message", "one", ...ctx.P], { env: { FAKE_CODEX_USAGE: JSON.stringify(first) } });
  assert.equal(r1.code, 0, r1.dump());
  const r2 = ctx.cli(["ask", "--thread", "u", "--message", "two", ...ctx.P], { env: { FAKE_CODEX_USAGE: JSON.stringify(cumulative) } });
  assert.equal(r2.code, 0, r2.dump());
  assert.match(r2.stdout, /in 1,500 tok/, "turn 2 must show its own 1,500 input tokens, not the session's 2,500");
  const totals = threadMeta(ctx.repo, "u").usageTotals;
  assert.equal(totals.input, 2500);
  assert.equal(totals.cached, 1200);
  assert.equal(totals.output, 100);
  assert.equal(totals.turns, 2);
});

test("31 skills' `--args \"$ARGUMENTS\"` form is expanded shell-style without evaluation", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--project", ctx.repo, "--args", `--thread argsy --message "hello 'quoted' world; $(touch pwned)"`]);
  assert.equal(r.code, 0, r.dump());
  assert.equal(r.st.thread, "argsy");
  assert.match(ctx.logEntries()[0].stdin, /hello 'quoted' world; \$\(touch pwned\)/);
  assert.ok(!fs.existsSync(path.join(ctx.repo, "pwned")), "arguments must never be evaluated");
  const empty = ctx.cli(["threads", "--project", ctx.repo, "--args", ""]);
  assert.equal(empty.code, 0, empty.dump());
  assert.match(empty.stdout, /- argsy/);
});

// ------------------------------------------------------------------ regressions for bugs found by this suite

test("regression: --new does not archive the thread when the turn is then rejected as a usage error", (t) => {
  const ctx = setup(t);
  const r1 = ctx.cli(["ask", "--thread", "keep", "--message", "hello", ...ctx.P]);
  assert.equal(r1.code, 0, r1.dump());
  const r2 = ctx.cli(["ask", "--thread", "keep", "--new", ...ctx.P]);
  assert.equal(r2.code, 64, r2.dump());
  assert.ok(fs.existsSync(threadFile(ctx.repo, "keep")), "the thread was archived although no turn started");
  assert.equal(threadMeta(ctx.repo, "keep").activeJobId, null);
});

test("regression: an interrupted job clears thread.activeJobId, so status/threads stop showing it as RUNNING", async (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "ghost", "--message", "hang", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(r.code, 75, r.dump());
  const running = await waitRunning(ctx, r.st.job);
  safeKill(running.supervisorPid, "SIGKILL");
  await waitFor(() => !isAlive(running.supervisorPid), { timeout: 5000, what: "supervisor to die" });
  const w = ctx.cli(["wait", r.st.job, ...ctx.P]);
  assert.equal(w.st.status, "interrupted", w.dump());
  const list = ctx.cli(["threads", "list", ...ctx.P]);
  assert.doesNotMatch(list.stdout, /RUNNING/, list.stdout);
  const thread = threadMeta(ctx.repo, "ghost");
  assert.equal(thread.activeJobId, null);
  assert.equal(thread.lastFailed?.state, "interrupted");
});

test("regression: with global auto mode on, the hook's .coworker/ dir is self-ignored by git", (t) => {
  const ctx = setup(t);
  fs.mkdirSync(path.join(ctx.config, "coworker"), { recursive: true });
  fs.writeFileSync(path.join(ctx.config, "coworker", "config.json"), JSON.stringify({ autoMode: true }));
  const result = spawnSync(process.execPath, [CLI, "hook", "prompt-submit"], {
    cwd: ctx.repo,
    env: ctx.env({ CLAUDE_PROJECT_DIR: ctx.repo }),
    input: JSON.stringify({ session_id: "s1", cwd: ctx.repo, prompt: "이 저장소의 전체 구조를 간단히 설명해 주세요" }),
    encoding: "utf8",
  });
  assert.match(result.stdout, /coworker auto mode is on/);
  assert.equal(ctx.git(["status", "--porcelain"]), "", "hook marker files show up as untracked files in the user's repo");
});

test("regression: an invalid --thread name is a usage error (exit 64), not status=error (exit 1)", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "bad name!", "--message", "hi", ...ctx.P]);
  assert.equal(r.code, 64, r.dump());
  assert.equal(r.st.status, "usage_error");
  assertRefused(ctx.cli(["threads", "show", "../etc", ...ctx.P]), /Invalid thread name/);
});

test("regression: a non-numeric --wait-budget is a usage error before anything is launched", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "nan", "--message", "hi", "--wait-budget", "abc", ...ctx.P], { env: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500" } });
  assert.equal(r.code, 64, r.dump());
  assert.equal(ctx.logEntries().length, 0);
  assert.deepEqual(listJobIds(ctx.repo), []);
});

test("regression: a turn rejected by validation leaves no job dir, so `wait` without an id still finds the real job", async (t) => {
  const ctx = setup(t);
  const ok = ctx.cli(["ask", "--thread", "a", "--message", "hi", ...ctx.P]);
  assert.equal(ok.code, 0, ok.dump());
  await sleep(1100); // the rejected turn's job id would sort after the real one
  for (const args of [["ask", "--thread", "a"], ["plan", "--thread", "pl"], ["review", "--thread", "rv", "--uncommitted"], ["debate", "--thread", "db", "--stage", "cross", "--message", "x"]]) {
    const bad = ctx.cli([...args, ...ctx.P]);
    assert.equal(bad.code, 64, bad.dump());
  }
  assert.deepEqual(listJobIds(ctx.repo), [ok.st.job], "a rejected turn left a job directory behind");
  const w = ctx.cli(["wait", ...ctx.P]);
  assert.equal(w.code, 0, w.dump());
  assert.equal(w.st.job, ok.st.job);
});

test("regression: jobs started in the same second are listed newest first (`jobs`/`wait`/`cancel` without an id)", async (t) => {
  const ctx = setup(t);
  await sleep(1000 - (Date.now() % 1000) + 30); // start at the top of a second
  const slow = { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "1500" };
  const older = ctx.cli(["plan", "--thread", "p", "--message", "Plan: x", "--detach", ...ctx.P], { env: { ...slow, FAKE_CODEX_JSON: JSON.stringify(planResult({ verdict: "approve" })) } });
  const newer = ctx.cli(["ask", "--thread", "a", "--message", "y", "--detach", ...ctx.P], { env: slow });
  assert.equal(older.code, 75, older.dump());
  assert.equal(newer.code, 75, newer.dump());
  t.after(() => {
    ctx.cli(["wait", older.st.job, ...ctx.P]);
    ctx.cli(["wait", newer.st.job, ...ctx.P]);
  });
  if (older.st.job.slice(0, 15) !== newer.st.job.slice(0, 15)) {
    t.skip("the two jobs did not start within the same second");
    return;
  }
  const jobs = JSON.parse(ctx.cli(["jobs", "--json", ...ctx.P]).stdout);
  assert.equal(jobs[0].jobId, newer.st.job, `newest job must come first: ${jobs.map((job) => job.jobId).join(", ")}`);
});

test("regression: --timeout is validated (abc, 0, negative) before any Codex process starts", (t) => {
  const ctx = setup(t);
  for (const value of ["abc", "0", "-5"]) {
    const r = ctx.cli(["ask", "--thread", "tmo", "--message", "hi", "--timeout", value, ...ctx.P], { env: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "1000" } });
    assert.equal(r.code, 64, `--timeout ${value}\n${r.dump()}`);
  }
  assert.equal(ctx.logEntries().length, 0, "Codex was started for an invalid --timeout");
  assert.deepEqual(listJobIds(ctx.repo), []);
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "tmo")));
});

test("regression: structured output that is valid JSON but not a proper object never strands the thread", (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["plan", "--thread", "nul", "--message", "Plan: x", ...ctx.P], { env: { FAKE_CODEX_JSON: "null" } });
  assert.equal(r.code, 1, r.dump());
  assert.equal(r.st.status, "invalid_output", r.dump());
  let thread = threadMeta(ctx.repo, "nul");
  assert.equal(thread.activeJobId, null);
  assert.equal(thread.initialized, true, "Codex's session advanced and must be recorded");
  assert.ok(fs.existsSync(jobFile(ctx.repo, r.st.job, "result.md")));

  // an object that violates the schema makes post-processing throw: the job is marked, the thread is freed
  const v = ctx.cli(["plan", "--thread", "viol", "--message", "Plan: x", ...ctx.P], { env: { FAKE_CODEX_JSON: JSON.stringify({ prior: 5, items: 7 }) } });
  assert.equal(v.code, 1, v.dump());
  assert.notEqual(v.st.status, "succeeded");
  thread = threadMeta(ctx.repo, "viol");
  assert.equal(thread.activeJobId, null, "thread still points at the finished job (shown as RUNNING)");
  assert.ok(!fs.existsSync(lockFile(ctx.repo, "viol")));
  assert.doesNotMatch(ctx.cli(["threads", "list", ...ctx.P]).stdout, /RUNNING/);
});


test("regression: a bad review target (unknown --base ref, bad --commit, non-git project) is a usage error without a stack trace", (t) => {
  const ctx = setup(t);
  ctx.write("README.md", "# changed\n");
  for (const args of [["--base", "no-such-ref"], ["--commit", "deadbeef"]]) {
    const r = ctx.cli(["review", "--thread", "bad", ...args, ...ctx.P]);
    assert.equal(r.code, 64, r.dump());
    assert.doesNotMatch(r.stderr, /\n\s+at /, "stack trace printed for a user error");
  }
  const nogit = path.join(ctx.dir, "nogit");
  fs.mkdirSync(nogit);
  const r = ctx.cli(["review", "--thread", "bad", "--project", nogit]);
  assert.equal(r.code, 64, r.dump());
});

test("regression: an invalid_output plan round does not consume the round budget or pretend to be a revision round", (t) => {
  const ctx = setup(t);
  const bad = ctx.cli(["plan", "--thread", "iv", "--message", "Plan: x", ...ctx.P], { env: { FAKE_CODEX_JSON: "{not json" } });
  assert.equal(bad.code, 1, bad.dump());
  const retry = ctx.cli(["plan", "--thread", "iv", "--message", "Plan: x", ...ctx.P], { env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ items: [planItem("major", "Race")] })) } });
  assert.equal(retry.code, 0, retry.dump());
  assert.doesNotMatch(ctx.logEntries()[1].stdin, /answered your earlier items/, "retry prompt claims a revision round");
  const again = ctx.cli(["plan", "--thread", "iv", "--message", "Plan: x v2", "--responses", (() => {
    const file = path.join(ctx.dir, "r.json");
    fs.writeFileSync(file, JSON.stringify([{ id: "P1", decision: "accept", rationale: "fixed" }]));
    return file;
  })(), ...ctx.P], { env: { FAKE_CODEX_JSON: JSON.stringify(planResult({ verdict: "approve", prior: [{ id: "P1", status: "fixed_verified", new_severity: null, reason: "ok", evidence: "" }] })) } });
  assert.equal(again.code, 0, `one real revision round should still fit in maxRounds.plan=2\n${again.dump()}`);
});

// ------------------------------------------------------------------ regressions (formerly known bugs)

test("regression: an interrupted job whose message may have reached Astra does not tell Claude 'delivery unknown'", {
}, async (t) => {
  const ctx = setup(t);
  const r = ctx.cli(["ask", "--thread", "du", "--message", "hang", "--detach", ...ctx.P], { env: { FAKE_CODEX_MODE: "hang" } });
  assert.equal(r.code, 75, r.dump());
  const running = await waitFor(() => {
    const status = jobStatus(ctx.repo, r.st.job);
    return status?.state === "running" && status.sessionId ? status : null;
  }, { what: "running job with a session id" });
  safeKill(running.supervisorPid, "SIGKILL");
  await waitFor(() => !isAlive(running.supervisorPid), { timeout: 5000, what: "supervisor to die" });
  const w = ctx.cli(["wait", r.st.job, ...ctx.P]);
  assert.equal(w.st.status, "interrupted", w.dump());
  assert.equal(jobStatus(ctx.repo, r.st.job).deliveryUnknown, true);
  assert.match(w.stdout, /[Dd]elivery unknown/, w.stdout);
});
