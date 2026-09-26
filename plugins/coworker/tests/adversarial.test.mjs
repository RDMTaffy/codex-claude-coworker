// Adversarial runtime review: reproductions for defects found by probing races, failure paths and edge
// inputs of the coworker runtime, plus regression checks for the startup/lock fixes.
//
//   COWORKER_TEST_TMPDIR=<dir outside the plugin> node --test --test-concurrency=1 tests/adversarial.test.mjs
//
// Every test drives the real CLI (or a runtime module) against tests/fixtures/fake-codex.mjs inside its own
// temp git repo with its own XDG cache/config dirs; CLAUDE_PROJECT_DIR is always removed.
// "regression:" tests reproduce defects found by adversarial review; all are fixed and must stay green.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "coworker.mjs");
const FAKE = path.join(HERE, "fixtures", "fake-codex.mjs");
const LIB = (name) => path.join(PLUGIN_ROOT, "scripts", "lib", name);

function makeBase() {
  const requested = process.env.COWORKER_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(requested, { recursive: true });
  const real = fs.realpathSync(requested);
  for (const forbidden of [PLUGIN_ROOT, MARKETPLACE_ROOT]) {
    if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`Refusing to create test repos inside ${forbidden}; set COWORKER_TEST_TMPDIR elsewhere.`);
    }
  }
  return fs.mkdtempSync(path.join(real, "coworker-adv-"));
}

const BASE = makeBase();
const WARM_CACHE = path.join(BASE, "_warm-cache");
let counter = 0;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(COWORKER_|FAKE_CODEX_|XDG_|GIT_|NODE_TEST|NODE_OPTIONS)/.test(key) || key === "CLAUDE_PROJECT_DIR" || key === "BASH_MAX_TIMEOUT_MS") {
      delete env[key];
    }
  }
  return env;
}

before(() => {
  fs.mkdirSync(WARM_CACHE, { recursive: true });
  const warmRepo = path.join(BASE, "_warm-repo");
  fs.mkdirSync(warmRepo, { recursive: true });
  const result = spawnSync(process.execPath, [CLI, "status", "--json", "--project", warmRepo], {
    cwd: warmRepo,
    env: { ...cleanEnv(), XDG_CACHE_HOME: WARM_CACHE, XDG_CONFIG_HOME: path.join(BASE, "_warm-config"), COWORKER_CODEX_BIN: FAKE },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, `warm-up failed:\n${result.stdout}\n${result.stderr}`);
});

after(() => {
  if (process.env.COWORKER_TEST_KEEP !== "1") fs.rmSync(BASE, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A fresh sandbox: temp git repo with one commit, private XDG dirs (capability cache pre-warmed). */
function sandbox(name = "repo") {
  counter += 1;
  const root = path.join(BASE, `${String(counter).padStart(2, "0")}-${name}`);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const cache = path.join(root, "cache");
  fs.mkdirSync(path.join(cache, "coworker"), { recursive: true });
  const warm = path.join(WARM_CACHE, "coworker", "codex-capabilities.json");
  if (fs.existsSync(warm)) fs.copyFileSync(warm, path.join(cache, "coworker", "codex-capabilities.json"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const baseEnv = { ...cleanEnv(), XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: path.join(root, "config"), COWORKER_CODEX_BIN: FAKE, COWORKER_WAIT_BUDGET: "60" };
  const env = (extra = {}) => {
    const merged = { ...baseEnv, ...extra };
    for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
    return merged;
  };
  const run = (args, extra = {}, { cwd = repo, timeout = 90000 } = {}) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: env(extra), encoding: "utf8", timeout });
    const lines = result.stdout.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const field = (key) => last.match(new RegExp(`${key}=(\\S+)`))?.[1];
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, last, state: field("status"), loop: field("loop"), job: field("job") };
  };
  const threadFile = (thread) => path.join(repo, ".coworker", "threads", `${thread}.json`);
  const readThread = (thread) => JSON.parse(fs.readFileSync(threadFile(thread), "utf8"));
  const status = (job) => JSON.parse(fs.readFileSync(path.join(repo, ".coworker", "jobs", job, "status.json"), "utf8"));
  const invocations = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const write = (rel, text) => {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, repo, env, run, readThread, threadFile, status, invocations, write };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 30000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

const PLAN_MAJOR = JSON.stringify({
  verdict: "revise",
  assessment: "complete",
  summary: "one major gap",
  approach: { assessment: "sound", reason: "ok", alternative: "" },
  limitations: [],
  prior: [],
  items: [{ kind: "risk", severity: "major", section: "cache", title: "no invalidation", problem: "stale reads", suggestion: "invalidate on write", evidence: "", basis: "inferred", confidence: "medium", verify_by: "" }],
  questions: [],
});

const REVIEW_APPROVE = JSON.stringify({
  verdict: "approve",
  assessment: "complete",
  summary: "looks right",
  coverage: { reviewed: ["src/x.js"], not_reviewed: [] },
  limitations: [],
  prior: [],
  findings: [],
  questions: [],
});

// ------------------------------------------------------------------ argv handling

test("regression: a single `--message=<text with spaces>` argument is split, so Astra receives only the first word", {
}, (t) => {
  const box = sandbox("argv-split");
  const log = path.join(box.root, "codex.log");
  const result = box.run(["ask", "--message=please compare approach A and approach B"], { FAKE_CODEX_LOG: log });
  assert.equal(result.code, 0, result.stderr);
  const stdin = box.invocations(log).at(-1).stdin;
  assert.match(stdin, /please compare approach A and approach B/, "the whole message must reach Astra");
});

// ------------------------------------------------------------------ on-disk layout robustness

test("a stray non-job entry in .coworker/jobs (e.g. Finder's .DS_Store) does not break `jobs`, `status` or `wait`", () => {
  const box = sandbox("ds-store");
  assert.equal(box.run(["ask", "--thread", "t", "-m", "hello there"]).code, 0);
  fs.writeFileSync(path.join(box.repo, ".coworker", "jobs", ".DS_Store"), "");
  for (const args of [["jobs"], ["status"], ["wait"]]) {
    const result = box.run(args);
    assert.equal(result.code, 0, `coworker ${args.join(" ")} → exit ${result.code}\n${result.stderr.slice(0, 300)}`);
  }
});

test("`threads list` does not report <thread>.ledger.json as a phantom thread", () => {
  const box = sandbox("phantom");
  box.write("plan.md", "Plan: add a cache\n");
  assert.equal(box.run(["plan", "--thread", "p", "--message-file", "plan.md"], { FAKE_CODEX_JSON: PLAN_MAJOR }).code, 0);
  const listed = JSON.parse(box.run(["threads", "list", "--json"]).stdout).map((thread) => thread.name);
  assert.deepEqual(listed, ["p"]);
});

test("a thread named `<x>.ledger` cannot clobber thread x's ledger (x's next plan round still succeeds)", () => {
  const box = sandbox("ledger-collision");
  box.write("plan.md", "Plan: add a cache\n");
  assert.equal(box.run(["plan", "--thread", "p", "--message-file", "plan.md"], { FAKE_CODEX_JSON: PLAN_MAJOR }).code, 0);
  box.run(["ask", "--thread", "p.ledger", "-m", "hello there friend"]);
  const responses = box.write(".coworker/work/r.json", JSON.stringify([{ id: "P1", decision: "accept", rationale: "added invalidation" }]));
  const ruling = JSON.stringify({ ...JSON.parse(PLAN_MAJOR), verdict: "approve", items: [], prior: [{ id: "P1", status: "fixed_verified", new_severity: null, reason: "ok", evidence: "" }] });
  const round2 = box.run(["plan", "--thread", "p", "--message-file", "plan.md", "--responses", responses], { FAKE_CODEX_JSON: ruling });
  assert.equal(round2.state, "succeeded", round2.last);
});

// ------------------------------------------------------------------ retries after failures

test("regression: after a failed `ask --claude-view F`, rerunning the identical command (as the result instructs) is a usage error", {
}, () => {
  const box = sandbox("claude-view-retry");
  box.write(".coworker/work/view.md", "My view: approach A\n");
  box.write(".coworker/work/q.md", "A or B?\n");
  const args = ["ask", "--thread", "v", "--message-file", ".coworker/work/q.md", "--claude-view", ".coworker/work/view.md"];
  const first = box.run(args, { FAKE_CODEX_MODE: "fail" });
  assert.equal(first.state, "failed");
  assert.match(first.stdout, /rerun the same command once/);
  const retry = box.run(args);
  assert.equal(retry.code, 0, `retry → ${retry.last}\n${retry.stderr}`);
});

test("regression: after a failed `debate --stage open`, rerunning it cannot read the (already sealed) proposal", {
}, () => {
  const box = sandbox("debate-retry");
  box.write(".coworker/work/brief.md", "Pick a database\n");
  box.write(".coworker/work/prop.md", "PICK: postgres\nbecause…\n");
  const args = ["debate", "--thread", "d", "--stage", "open", "--brief", ".coworker/work/brief.md", "--claude-proposal", ".coworker/work/prop.md"];
  assert.equal(box.run(args, { FAKE_CODEX_MODE: "fail" }).state, "failed");
  const retry = box.run(args);
  assert.equal(retry.code, 0, `retry → ${retry.last}\n${retry.stderr}`);
});

test("after an interrupted job the thread is not left RUNNING and the next turn carries the retry note", async () => {
  const box = sandbox("interrupted-retry");
  const log = path.join(box.root, "codex.log");
  assert.equal(box.run(["ask", "--thread", "k", "-m", "first message"], { FAKE_CODEX_LOG: log }).code, 0);
  const started = box.run(["ask", "--thread", "k", "-m", "second message", "--detach"], { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "20000", FAKE_CODEX_LOG: log });
  assert.equal(started.code, 75);
  assert.ok(await waitFor(() => box.status(started.job).sessionId), "session id recorded");
  process.kill(box.status(started.job).supervisorPid, "SIGKILL");
  await sleep(300);
  assert.equal(box.run(["wait", started.job]).state, "interrupted");
  assert.equal(box.run(["ask", "--thread", "k", "-m", "third message"], { FAKE_CODEX_LOG: log }).code, 0);
  const thread = box.readThread("k");
  assert.equal(thread.activeJobId, null, "activeJobId must not point at the dead job");
  assert.match(box.invocations(log).at(-1).stdin, /\(Retry:/, "the turn after an interrupted delivery must carry the retry note");
});

test("regression: a crash inside finalize leaves the thread RUNNING forever and does not record the failure", {
}, () => {
  const box = sandbox("finalize-crash");
  box.write("plan.md", "Plan: add a cache\n");
  // A non-object reply is now classified invalid_output up front…
  assert.equal(box.run(["plan", "--thread", "q", "--message-file", "plan.md"], { FAKE_CODEX_JSON: "null" }).state, "invalid_output");
  // …so crash finalize with an object whose "items" is not iterable.
  const result = box.run(["plan", "--thread", "p", "--message-file", "plan.md"], { FAKE_CODEX_JSON: '{"items": 5}' });
  assert.equal(result.state, "crashed");
  const thread = box.readThread("p");
  assert.equal(thread.activeJobId, null, "status/threads show RUNNING for a finished job");
  assert.equal(thread.lastFailed?.state, "crashed");
});

test("regression: a completed turn whose -o file is missing is reported as crashed 'before finishing the turn' and its session is dropped", {
}, () => {
  const box = sandbox("nojson");
  const result = box.run(["ask", "--thread", "n", "-m", "first message"], { FAKE_CODEX_MODE: "nojson" });
  const text = fs.readFileSync(path.join(box.repo, ".coworker", "jobs", result.job, "result.md"), "utf8");
  assert.doesNotMatch(text, /before finishing the turn/, "turn.completed was received");
  assert.ok(box.readThread("n").initialized, "the Codex session advanced and should be adopted");
});

// ------------------------------------------------------------------ rounds and numeric flags

test("regression: an unparseable Astra reply (invalid_output) consumes the round budget: the only real critique hits max_rounds", {
}, () => {
  const box = sandbox("invalid-round");
  box.write("plan.md", "Plan: add a cache\n");
  assert.equal(box.run(["plan", "--thread", "p", "--message-file", "plan.md"], { FAKE_CODEX_JSON: '{"verdict": truncated' }).state, "invalid_output");
  const real = box.run(["plan", "--thread", "p", "--message-file", "plan.md"], { FAKE_CODEX_JSON: PLAN_MAJOR });
  assert.equal(real.state, "succeeded");
  assert.equal(real.loop, "needs_reply", "one real critique round must not exhaust maxRounds=2");
});

test("regression: a --timeout above 2^31-1 ms (~24.8 days) overflows setTimeout and times the turn out after 1 ms", {
}, () => {
  const box = sandbox("timeout-overflow");
  const zero = box.run(["ask", "--thread", "z", "-m", "timeout zero", "--timeout", "0"], { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "800" });
  assert.notEqual(zero.state, "timed_out", "0 must be rejected (exit 64) or mean 'no timeout'");
  const huge = box.run(["ask", "--thread", "h", "-m", "timeout huge", "--timeout", "3000000"], { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "800" });
  assert.ok(huge.state === "succeeded" || huge.code === 64, `a 34-day timeout must not fire immediately (got ${huge.last})`);
});

test("regression: --max-rounds with a non-number yields loop=max_rounds on round 1 ('round 1/null')", {
}, () => {
  const box = sandbox("max-rounds-nan");
  box.write("plan.md", "Plan: add a cache\n");
  const result = box.run(["plan", "--thread", "p", "--message-file", "plan.md", "--max-rounds", "five"], { FAKE_CODEX_JSON: PLAN_MAJOR });
  assert.equal(result.code, 64, `expected a usage error, got ${result.last}`);
});

// ------------------------------------------------------------------ review snapshots and staleness

test("regression: snapshotTree() misses a same-second, same-size edit (racy-git protection lost when copying the index)", {
}, async () => {
  const { snapshotTree } = await import(LIB("git.mjs"));
  const box = sandbox("racy-git");
  const file = path.join(box.repo, "r.txt");
  // Start at the beginning of a wall-clock second so write → index → rewrite share one second.
  await sleep(1000 - (Date.now() % 1000) + 10);
  fs.writeFileSync(file, "hello\n");
  git(box.repo, "add", "r.txt");
  fs.writeFileSync(file, "jello\n"); // same size, same second
  const sameSecond = Math.floor(fs.statSync(file).mtimeMs / 1000) === Math.floor(fs.statSync(path.join(box.repo, ".git", "index")).mtimeMs / 1000);
  if (!sameSecond) return; // the machine was too slow to stay inside one second; nothing to assert
  await sleep(1200);
  const tree = snapshotTree(box.repo);
  assert.equal(git(box.repo, "show", `${tree}:r.txt`), "jello", "the snapshot must contain the current file content");
});

test("regression: a review scoped with --paths is marked stale by a change outside those paths", {
}, async () => {
  const box = sandbox("stale-paths");
  box.write("src/x.js", "export const x = 1;\n");
  git(box.repo, "add", "-A");
  git(box.repo, "commit", "-qm", "x");
  box.write("src/x.js", "export const x = 2;\n");
  const child = spawn(process.execPath, [CLI, "review", "--thread", "rv", "--uncommitted", "--paths", "src"], {
    cwd: box.repo,
    env: box.env({ FAKE_CODEX_JSON: REVIEW_APPROVE, FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  await sleep(1200);
  box.write("NOTES.txt", "unrelated\n"); // outside --paths src
  await exited;
  assert.match(stdout, /status=succeeded/);
  assert.doesNotMatch(stdout, /loop=stale/);
});

// ------------------------------------------------------------------ liveness checks

test("regression: when `ps` cannot be run, reconcile() declares a live supervisor dead: lock released, second turn resumes the same session", {
}, async () => {
  const box = sandbox("ps-missing");
  const log = path.join(box.root, "codex.log");
  assert.equal(box.run(["ask", "--thread", "t", "-m", "first"], { FAKE_CODEX_LOG: log }).code, 0);
  const second = box.run(["ask", "--thread", "t", "-m", "second (long)", "--detach"], { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "5000", FAKE_CODEX_LOG: log });
  assert.equal(second.code, 75);
  assert.ok(await waitFor(() => box.status(second.job).state === "running"));
  // One read-only `coworker jobs` in an environment where `ps` is not on PATH.
  spawnSync(process.execPath, [CLI, "jobs"], { cwd: box.repo, env: box.env({ PATH: "/nonexistent" }), encoding: "utf8" });
  const afterJobs = box.status(second.job).state;
  const third = box.run(["ask", "--thread", "t", "-m", "third"], { FAKE_CODEX_LOG: log });
  await waitFor(() => box.status(second.job).state === "succeeded", 15000);
  assert.equal(afterJobs, "running", "a read-only listing must not kill the bookkeeping of a live job");
  assert.equal(third.state, "busy", "the thread must stay locked while the second turn is still running");
});

test("regression: a turn in another project (jobRetentionDays: 0) deletes this project's sealed --claude-view mid-job, so finalize crashes", {
}, async () => {
  const box = sandbox("prune-sealed");
  const other = sandbox("prune-sealed-other");
  // Both projects share one XDG cache, as they do on a real machine.
  const shared = { XDG_CACHE_HOME: box.env().XDG_CACHE_HOME };
  other.write(".coworker/config.json", JSON.stringify({ jobRetentionDays: 0 }));
  box.write(".coworker/work/view.md", "My view: approach A\n");
  const started = box.run(["ask", "--thread", "v", "-m", "A or B?", "--claude-view", ".coworker/work/view.md", "--detach"], { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500" });
  assert.equal(started.code, 75);
  await sleep(400);
  assert.equal(other.run(["ask", "--thread", "o", "-m", "unrelated question"], shared).code, 0);
  await sleep(3000);
  assert.equal(box.run(["wait", started.job]).state, "succeeded");
});

// Fault injection: a preload (NODE_OPTIONS=--import) that only acts inside `coworker.mjs _supervise`.
function preload(box, name, body) {
  const file = path.join(box.root, name);
  fs.writeFileSync(file, `import fs from "node:fs";\nif (process.argv[2] === "_supervise") {\n${body}\n}\n`);
  return `--import=${file}`;
}

test("regression: a supervisor that dies inside commit() (after releasing the lock, before the terminal status) is reported interrupted although the round was fully recorded", {
}, async () => {
  const box = sandbox("commit-window");
  assert.equal(box.run(["ask", "--thread", "c", "-m", "first message"]).code, 0);
  const nodeOptions = preload(box, "die-after-release.mjs", `  const rm = fs.rmSync;
  fs.rmSync = function (target, ...rest) {
    const out = rm.call(this, target, ...rest);
    if (String(target).endsWith(".lock")) process.kill(process.pid, "SIGKILL");
    return out;
  };`);
  const started = box.run(["ask", "--thread", "c", "-m", "second message", "--detach"], { NODE_OPTIONS: nodeOptions });
  assert.equal(started.code, 75);
  await sleep(2500);
  const collected = box.run(["wait", started.job]);
  const thread = box.readThread("c");
  assert.equal(thread.turns.at(-1).state, "succeeded", "finalize did record the round");
  assert.equal(collected.state, "succeeded", `status says ${collected.state} while the thread says the round succeeded`);
});

test("regression: after an uncaught exception the supervisor publishes `crashed` and releases the lock but keeps running Codex and later finalizes", {
}, async () => {
  const box = sandbox("crash-continues");
  const log = path.join(box.root, "codex.log");
  assert.equal(box.run(["ask", "--thread", "c", "-m", "first message"], { FAKE_CODEX_LOG: log }).code, 0);
  const nodeOptions = preload(box, "throw.mjs", `  setTimeout(() => { throw new Error("simulated uncaught exception"); }, 1000);`);
  const crashed = box.run(["ask", "--thread", "c", "-m", "second message", "--detach"], { NODE_OPTIONS: nodeOptions, FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "4000", FAKE_CODEX_LOG: log });
  assert.ok(await waitFor(() => box.status(crashed.job).state === "crashed", 10000));
  // The crashed supervisor must have stopped its Codex before releasing the thread.
  const codexPid = box.status(crashed.job).codexPid;
  let codexAlive = false;
  if (codexPid) {
    try {
      process.kill(codexPid, 0);
      codexAlive = true;
    } catch {
      codexAlive = false;
    }
  }
  assert.equal(codexAlive, false, "Codex kept running behind a job declared crashed");
  const third = box.run(["ask", "--thread", "c", "-m", "third message"], { FAKE_CODEX_LOG: log });
  assert.equal(third.state, "succeeded", third.last);
  const recorded = box.readThread("c").turns.find((turn) => turn.jobId === crashed.job)?.state;
  assert.equal(recorded, "crashed", `the thread recorded the 'crashed' job as ${recorded}`);
});

// ------------------------------------------------------------------ exit-code contract

test("regression: usage-type review errors (not a git repo, unknown --base/--commit) exit 1 with a stack trace instead of 64", {
}, () => {
  const box = sandbox("usage-codes");
  const plain = path.join(box.root, "plain");
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, "f.txt"), "x\n");
  const noGit = box.run(["review", "--thread", "r", "--project", plain], {}, { cwd: plain });
  assert.equal(noGit.code, 64, noGit.last);
  assert.equal(box.run(["review", "--thread", "r2", "--base", "no-such-branch"]).code, 64);
  assert.equal(box.run(["review", "--thread", "r3", "--commit", "deadbeef"]).code, 64);
});

test("regression: `status --ping` hides why the ping failed when Codex exits with a plain stderr error", {
}, () => {
  const box = sandbox("ping-reason");
  const wrapper = path.join(box.root, "nologin-codex");
  fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "exec" ] && [ "$2" != "--help" ] && [ "$3" != "--help" ]; then echo "Error: Not logged in. Run codex login." >&2; exit 1; fi\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  const result = box.run(["status", "--ping", "--json"], { COWORKER_CODEX_BIN: wrapper });
  const ping = JSON.parse(result.stdout).ping;
  assert.equal(ping.ok, false);
  assert.match(String(ping.error ?? ""), /Not logged in/);
});

// ------------------------------------------------------------------ regression checks for startup/lock fixes

test("a lock whose launcher is still preparing (a live coworker.mjs process) is not stale after the 15 s grace", async () => {
  const { isLockStale } = await import(LIB("state.mjs"));
  const box = sandbox("launcher-alive");
  // `coworker hook prompt-submit` blocks reading stdin: a live process whose argv names coworker.mjs.
  const launcher = spawn(process.execPath, [CLI, "hook", "prompt-submit"], { stdio: ["pipe", "ignore", "ignore"], env: box.env() });
  try {
    await sleep(300);
    const lock = { jobId: "20260101-000000-ask-deadbeef", launcherPid: launcher.pid, createdAt: new Date(Date.now() - 20000).toISOString() };
    assert.equal(isLockStale(box.repo, lock), false);
    launcher.kill("SIGKILL");
    await new Promise((resolve) => launcher.on("exit", resolve));
    assert.equal(isLockStale(box.repo, lock), true);
  } finally {
    launcher.kill("SIGKILL");
  }
});

function fakeJobDir(box, jobId, { ack, statusPatch }) {
  const dir = path.join(box.repo, ".coworker", "jobs", jobId);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of ["events.jsonl", "stderr.log", "supervisor.log"]) fs.writeFileSync(path.join(dir, file), "");
  fs.writeFileSync(path.join(dir, "prompt.md"), "hi");
  const meta = { jobId, jobDir: dir, projectRoot: box.repo, thread: "late", kind: "ask", codex: { bin: FAKE, args: ["exec", "--json", "-o", path.join(dir, "last.txt"), "-"], cwd: box.repo }, timeoutSec: 60, round: 1, maxRounds: 99, model: "m", effort: "high", message: "hi" };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "created", launcherPid: 999999, updatedAt: new Date(Date.now() - 40000).toISOString(), ...statusPatch }));
  if (ack) fs.writeFileSync(path.join(dir, "ack"), ack);
  return dir;
}

test("a late supervisor whose startup was already abandoned exits without running Codex", () => {
  const box = sandbox("late-supervisor");
  fs.mkdirSync(path.join(box.repo, ".coworker", "locks"), { recursive: true });
  const log = path.join(box.root, "codex.log");
  const jobId = "20260101-000000-ask-0000beef";
  const dir = fakeJobDir(box, jobId, { ack: `launcher-gave-up 999999 ${new Date().toISOString()}\n`, statusPatch: { state: "start_failed" } });
  const result = spawnSync(process.execPath, [CLI, "_supervise", dir], { cwd: path.dirname(dir), env: box.env({ FAKE_CODEX_LOG: log }), encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0);
  assert.equal(box.invocations(log).length, 0, "Codex must not be started");
  assert.equal(box.status(jobId).state, "start_failed");
});

test("reconcile settles a job whose supervisor acknowledged startup and died before recording its pid", async () => {
  const { reconcile } = await import(LIB("jobs.mjs"));
  const box = sandbox("acked-dead");
  const jobId = "20260101-000000-ask-0000dead";
  fakeJobDir(box, jobId, { ack: `supervisor 999999 ${new Date().toISOString()}\n`, statusPatch: {} });
  assert.equal(reconcile(box.repo, jobId)?.state, "interrupted");
});
