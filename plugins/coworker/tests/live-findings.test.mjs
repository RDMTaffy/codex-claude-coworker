// Regression tests for defects found during the LIVE end-to-end run against the real Codex CLI
// (0.158.0-alpha.2, gpt-6-astra). Each defect is reproduced here with the fake Codex so it runs offline.
// "regression:" tests reproduce defects found in the live run against GPT-6 Astra; all are fixed.
//
// Run: COWORKER_TEST_TMPDIR=<dir outside the plugin> node --test tests/live-findings.test.mjs

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "coworker.mjs");
const FAKE = path.join(HERE, "fixtures", "fake-codex.mjs");

function makeBase() {
  const requested = process.env.COWORKER_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(requested, { recursive: true });
  const real = fs.realpathSync(requested);
  for (const forbidden of [PLUGIN_ROOT, MARKETPLACE_ROOT]) {
    if (real === forbidden || real.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(`Refusing to create test repos inside ${forbidden}; set COWORKER_TEST_TMPDIR elsewhere.`);
    }
  }
  return fs.mkdtempSync(path.join(real, "coworker-live-findings-"));
}

const BASE = makeBase();
let counter = 0;

after(() => {
  if (process.env.COWORKER_TEST_KEEP !== "1") fs.rmSync(BASE, { recursive: true, force: true });
});

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(COWORKER_|FAKE_CODEX_|XDG_|GIT_|NODE_TEST)/.test(key) || key === "CLAUDE_PROJECT_DIR" || key === "BASH_MAX_TIMEOUT_MS") delete env[key];
  }
  return env;
}

const PLAN_JSON = (prior = []) =>
  JSON.stringify({
    verdict: "revise",
    assessment: "complete",
    summary: "s",
    approach: { assessment: "sound", reason: "r", alternative: "" },
    limitations: [],
    prior,
    items: [{ severity: "major", kind: "issue", section: "x", title: "t", problem: "p", evidence: "e", basis: "verified", confidence: "high", suggestion: "s", verify_by: "" }],
    questions: [],
  });

function setup(codexBin = FAKE) {
  counter += 1;
  const dir = path.join(BASE, String(counter).padStart(2, "0"));
  const repo = path.join(dir, "repo");
  for (const sub of [repo, path.join(dir, "cache"), path.join(dir, "config")]) fs.mkdirSync(sub, { recursive: true });
  const gitconfig = path.join(dir, "gitconfig");
  fs.writeFileSync(gitconfig, "[user]\n\tname = T\n\temail = t@example.invalid\n[commit]\n\tgpgsign = false\n");
  const env = {
    ...cleanEnv(),
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_CONFIG_HOME: path.join(dir, "config"),
    COWORKER_CODEX_BIN: codexBin,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
  };
  const git = (...args) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const run = (args, extra = {}, cwd = repo) => {
    const result = spawnSync(process.execPath, [CLI, ...args, "--project", repo], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 60000 });
    const lines = (result.stdout ?? "").trim().split("\n");
    return { ...result, last: lines[lines.length - 1] ?? "" };
  };
  const work = (name, text) => {
    const file = path.join(repo, ".coworker", "work", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const threads = path.join(repo, ".coworker", "threads");
  return { dir, repo, env, run, work, threads };
}

/**
 * Wrapper around the fake Codex that reports usage the way Codex 0.158.0-alpha.2 does on
 * `exec resume`: turn.completed.usage is the CUMULATIVE session total, not the per-turn delta.
 * (Verified live: the rollout's total_token_usage equals the reported usage; last_token_usage is the delta.)
 */
function cumulativeFake(dir) {
  const wrapper = path.join(dir, "cumulative-codex.mjs");
  const counterFile = path.join(dir, "turns.count");
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
const argv = process.argv.slice(2);
const input = argv.includes("-") ? fs.readFileSync(0) : undefined;
const child = spawnSync(process.execPath, [${JSON.stringify(FAKE)}, ...argv], { input, encoding: "utf8", env: process.env });
let out = child.stdout ?? "";
if (argv[0] === "exec" && !argv.includes("--help")) {
  let n = 1;
  try { n = Number(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8")) + 1; } catch {}
  fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));
  out = out.split("\\n").map((line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed") {
        event.usage = { input_tokens: 1000 * n, cached_input_tokens: 500 * n, output_tokens: 40 * n, reasoning_output_tokens: 0 };
        return JSON.stringify(event);
      }
    } catch {}
    return line;
  }).join("\\n");
}
process.stdout.write(out);
process.stderr.write(child.stderr ?? "");
process.exitCode = child.status ?? 1;
`,
  );
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

// ------------------------------------------------------------------ ledger files vs thread names

test("threads list does not report <name>.ledger.json files as threads", () => {
  const s = setup();
  const planned = s.run(["plan", "--thread", "foo", "--message", "plan text"], { FAKE_CODEX_JSON: PLAN_JSON() });
  assert.equal(planned.status, 0, planned.stderr);
  const listed = s.run(["threads", "list", "--json"]);
  const names = JSON.parse(listed.stdout).map((thread) => thread.name);
  assert.deepEqual(names, ["foo"]);
});

test("a thread named '<other>.ledger' cannot clobber another thread's ledger", () => {
  const s = setup();
  assert.equal(s.run(["plan", "--thread", "foo", "--message", "plan text"], { FAKE_CODEX_JSON: PLAN_JSON() }).status, 0);
  const ledgerFile = path.join(s.threads, "foo.ledger.json");
  const before = fs.readFileSync(ledgerFile, "utf8");
  const ask = s.run(["ask", "--thread", "foo.ledger", "--message", "hello"], { FAKE_CODEX_REPLY: "hi" });
  // Acceptable fixes: reject the name (usage error) or store it elsewhere — but never touch foo's ledger.
  assert.ok(ask.status === 0 || ask.status === 64, ask.stderr);
  assert.equal(fs.readFileSync(ledgerFile, "utf8"), before, "foo's ledger was modified by a turn on thread foo.ledger");
  const responses = s.work("r.json", JSON.stringify([{ id: "P1", decision: "accept", rationale: "x" }]));
  const round2 = s.run(["plan", "--thread", "foo", "--responses", responses, "--message", "r2"], {
    FAKE_CODEX_JSON: PLAN_JSON([{ id: "P1", status: "fixed_verified", new_severity: null, reason: "ok", evidence: "" }]),
  });
  assert.equal(round2.status, 0, `${round2.stdout}\n${round2.stderr}`);
  assert.match(round2.last, /status=succeeded/);
});

test("a finalize crash tells Claude why and where Astra's answer is", () => {
  const s = setup();
  assert.equal(s.run(["plan", "--thread", "foo", "--message", "plan text"], { FAKE_CODEX_JSON: PLAN_JSON() }).status, 0);
  // Force a finalize failure the same way the live run hit it: a corrupted (object-shaped) ledger.rounds.
  const ledgerFile = path.join(s.threads, "foo.ledger.json");
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, "utf8"));
  ledger.rounds = { 0: ledger.rounds[0] };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger));
  const responses = s.work("r.json", JSON.stringify([{ id: "P1", decision: "accept", rationale: "x" }]));
  const round2 = s.run(["plan", "--thread", "foo", "--responses", responses, "--message", "r2"], {
    FAKE_CODEX_JSON: PLAN_JSON([{ id: "P1", status: "fixed_verified", new_severity: null, reason: "ok", evidence: "" }]),
  });
  assert.match(round2.last, /status=crashed/);
  assert.match(round2.stdout, /not iterable|finalize/i, "the crash reason is not shown");
  assert.match(round2.stdout, /last\.txt/, "no pointer to Astra's raw answer");
});

// ------------------------------------------------------------------ usage accounting

test("resumed turns: cumulative Codex usage is not double-counted", () => {
  const s = setup();
  const s2 = setup(cumulativeFake(s.dir));
  for (const message of ["first", "second", "third"]) {
    const result = s2.run(["ask", "--thread", "t", "--message", message], { FAKE_CODEX_REPLY: "ok" });
    assert.equal(result.status, 0, result.stderr);
  }
  const thread = JSON.parse(fs.readFileSync(path.join(s2.threads, "t.json"), "utf8"));
  // The fake session's true totals after three turns are 3000 in / 1500 cached / 120 out.
  assert.equal(thread.usageTotals.input, 3000);
  assert.equal(thread.usageTotals.output, 120);
  const lastTurn = thread.turns[thread.turns.length - 1];
  const header = fs.readFileSync(path.join(s2.repo, ".coworker", "jobs", lastTurn.jobId, "result.md"), "utf8").split("\n")[0];
  assert.match(header, /in 1,000 tok/, `turn 3 header should show its own usage: ${header}`);
});

test("threads show reports the cached share that protocol §6 tells Claude to read from it", () => {
  const s = setup();
  assert.equal(s.run(["ask", "--thread", "t", "--message", "hi"], { FAKE_CODEX_REPLY: "ok" }).status, 0);
  const shown = s.run(["threads", "show", "t"]);
  assert.match(shown.stdout, /cached/i);
});

// ------------------------------------------------------------------ debate transcript

test("debate transcript keeps the brief and Claude's proposal once revealed", () => {
  const s = setup();
  const brief = s.work("d/brief.md", "BRIEF-MARKER: choose A or B");
  const proposal = s.work("d/claude-proposal.md", "PROPOSAL-MARKER: pick A");
  const open = s.run(["debate", "--thread", "d", "--stage", "open", "--brief", brief, "--claude-proposal", proposal], { FAKE_CODEX_REPLY: "PICK: B" });
  assert.equal(open.status, 0, open.stderr);
  assert.equal(fs.existsSync(proposal), false, "proposal must be sealed out of the repo");
  const cross = s.work("d/cross.md", "CROSS-MARKER");
  assert.equal(s.run(["debate", "--thread", "d", "--stage", "cross", "--message-file", cross], { FAKE_CODEX_REPLY: "ok" }).status, 0);
  const transcript = fs.readFileSync(path.join(s.threads, "d.md"), "utf8");
  assert.match(transcript, /BRIEF-MARKER/);
  assert.match(transcript, /PROPOSAL-MARKER/);
});
