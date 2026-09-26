// Claude-facing contract tests: run the skills' instructions the way Claude Code executes them —
// literally, with the paths/flags/cwd the SKILL.md files prescribe — against the fake Codex.
//
//   * `${CLAUDE_PROJECT_DIR}` in a SKILL.md body is substituted with the session's LAUNCH directory
//     (verified live on Claude Code 2.1.283), which need not be the git top-level (monorepos).
//   * Neither CLAUDE_PROJECT_DIR nor CLAUDE_PLUGIN_ROOT is exported to Bash-tool / `!` commands; hooks get
//     CLAUDE_PROJECT_DIR in their env. `!` commands run in the session's current shell directory.
//   * `$ARGUMENTS` is substituted raw into `!` commands; a `!` command exiting >= 2 aborts the skill.
//
// Run:  node --test tests/claude-facing.test.mjs
// Temp repos go under $COWORKER_TEST_TMP (default os.tmpdir()); XDG_CACHE_HOME / XDG_CONFIG_HOME point at
// temp dirs and CLAUDE_PROJECT_DIR is removed from the child environment. COWORKER_CODEX_BIN always points
// at a fake, so no real Codex turn is ever started.
//
// "regression:" tests document defects found while following the skills literally; all are fixed.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");
const SCRIPT = path.join(PLUGIN, "scripts", "coworker.mjs");
const BIN_DIR = path.join(PLUGIN, "bin");
const FAKE = path.join(HERE, "fixtures", "fake-codex.mjs");
const SKILLS = path.join(PLUGIN, "skills");

const TMP_BASE = process.env.COWORKER_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, "cw-claude-facing-")));
const CACHE = path.join(ROOT, "xdg-cache"); // shared: capability probes are cached per binary
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// ------------------------------------------------------------------ helpers

function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(COWORKER_|FAKE_CODEX_|XDG_|GIT_)/.test(key) || key === "CLAUDE_PROJECT_DIR" || key === "BASH_MAX_TIMEOUT_MS") continue;
    env[key] = value;
  }
  return { ...env, XDG_CACHE_HOME: CACHE, COWORKER_CODEX_BIN: FAKE, ...extra };
}

let counter = 0;
function setup(name) {
  counter += 1;
  const base = path.join(ROOT, `${String(counter).padStart(2, "0")}-${name}`);
  const repo = path.join(base, "repo");
  const config = path.join(base, "xdg-config");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: cleanEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "stats.js"), "export function avg(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n");
  fs.writeFileSync(path.join(repo, "packages", "app", "index.js"), "export const app = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  const env = (extra = {}) => cleanEnv({ XDG_CONFIG_HOME: config, ...extra });
  /** Run `coworker …` exactly as the Bash tool would (cwd = the shell's current directory). */
  const cli = (args, { cwd = repo, extra = {}, input } = {}) => run(process.execPath, [SCRIPT, ...args], { cwd, env: env(extra), input });
  const write = (rel, text, root = repo) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { base, repo, config, git, env, cli, write };
}

function run(bin, args, { cwd, env, input }) {
  const r = spawnSync(bin, args, { cwd, env, input, encoding: "utf8", timeout: 90000 });
  const stdout = r.stdout ?? "";
  const lines = stdout.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const m = /^COWORKER status=(\S+)(?: loop=(\S+))? job=(\S+) thread=(\S+) result=(.+)$/.exec(last);
  const st = m ? { status: m[1], loop: m[2] ?? null, job: m[3], thread: m[4], result: m[5] } : null;
  return {
    code: r.status,
    stdout,
    stderr: r.stderr ?? "",
    last,
    st,
    dump: () => `exit=${r.status}\n--- stdout\n${stdout.slice(-3000)}\n--- stderr\n${(r.stderr ?? "").slice(-2000)}`,
  };
}

/** Execute a skill's `!` line the way Claude Code does: raw $ARGUMENTS text, plugin bin/ on PATH, bash. */
function runBang(skill, args, { cwd, env, projectDir }) {
  const body = fs.readFileSync(path.join(SKILLS, skill, "SKILL.md"), "utf8");
  const match = body.match(/^!`([^`]+)`\s*$/m);
  assert.ok(match, `${skill} has no !\`…\` line`);
  const command = match[1]
    .replaceAll("$ARGUMENTS", args)
    .replaceAll("${CLAUDE_PROJECT_DIR}", projectDir ?? cwd)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN);
  return run("/bin/bash", ["-c", command], { cwd, env: { ...env, PATH: `${BIN_DIR}:${env.PATH}` } });
}

function hook(ctx, { projectDir, prompt, sessionId = "sess-1" }) {
  // hooks.json: exec form, `node ${CLAUDE_PLUGIN_ROOT}/scripts/coworker.mjs hook prompt-submit`, env has CLAUDE_PROJECT_DIR
  return run(process.execPath, [SCRIPT, "hook", "prompt-submit"], {
    cwd: projectDir,
    env: ctx.env({ CLAUDE_PROJECT_DIR: projectDir }),
    input: JSON.stringify({ session_id: sessionId, cwd: projectDir, prompt, hook_event_name: "UserPromptSubmit" }),
  });
}

function skillText(name) {
  return fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf8");
}

// ------------------------------------------------------------------ Astra structured replies

const planItem = (over = {}) => ({
  kind: "issue", severity: "major", section: "Approach", title: "empty input divides by zero",
  problem: "avg([]) returns NaN", suggestion: "validate input", evidence: "node -e … → NaN",
  basis: "verified", confidence: "high", verify_by: "", ...over,
});
const plan = (over = {}) => JSON.stringify({
  verdict: "revise", assessment: "complete", summary: "needs one fix",
  approach: { assessment: "sound", reason: "ok", alternative: "" },
  limitations: [], prior: [], items: [], questions: [], ...over,
});
const finding = (over = {}) => ({
  severity: "major", category: "bug", scope: "introduced", file: "src/stats.js", line_start: 2, line_end: 2,
  title: "avg([]) is NaN", failure_scenario: "avg([]) → NaN → dashboard shows NaN", evidence: "line 2 divides by xs.length",
  basis: "verified", confidence: "high", recommendation: "throw on empty input", verify_by: "node -e \"…\"", ...over,
});
const review = (over = {}) => JSON.stringify({
  verdict: "request_changes", assessment: "complete", summary: "one bug",
  coverage: { reviewed: ["src/stats.js"], not_reviewed: [] },
  limitations: [], prior: [], findings: [], questions: [], ...over,
});
const ruling = (id, status = "fixed_verified") => ({ id, status, new_severity: null, reason: "checked", evidence: "src/stats.js:2" });

const P = (ctx) => ["--project", ctx.repo];

// ================================================================== 1. the task skill, literally

describe("coworker:task executed literally (relative .coworker/work paths, cwd = project dir)", () => {
  test("plan (2 rounds) → implement → review (2 rounds) → report, with the documented commands and exit codes", () => {
    const ctx = setup("task-flow");
    const slug = "avg-empty";
    const work = `.coworker/work/${slug}`;

    // §0.3
    let r = ctx.cli(["task-state", slug, ...P(ctx), "--phase", "planning"]);
    assert.equal(r.code, 0, r.dump());
    assert.equal(JSON.parse(r.stdout).phase, "planning");
    assert.ok(fs.existsSync(path.join(ctx.repo, work)), "task-state creates the work dir the Write tool will use");

    // §1 Claude writes plan.md + plan-brief.md (Write tool creates parents anyway)
    ctx.write(`${work}/plan.md`, "# Plan\n- make avg([]) throw RangeError\n- add tests\n");
    ctx.write(`${work}/plan-brief.md`, "## 목표 (Goal)\navg가 빈 배열에서 NaN을 반환하지 않게\n## 검토 요청\n1. 호출부가 NaN에 의존하나?\n");

    // §2 round 1
    r = ctx.cli(["plan", ...P(ctx), "--thread", `${slug}-plan`, "--message-file", `${work}/plan-brief.md`, "--attach", `${work}/plan.md`], {
      extra: { FAKE_CODEX_JSON: plan({ items: [planItem()] }) },
    });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.st.status, "succeeded");
    assert.equal(r.st.loop, "needs_reply");
    assert.match(r.stdout, /\*\*P1\*\*/);

    // protocol §3: the CLI refuses the next round until every open item has a decision
    r = ctx.cli(["plan", ...P(ctx), "--thread", `${slug}-plan`, "--attach", `${work}/plan.md`]);
    assert.equal(r.code, 64, r.dump());
    assert.equal(r.st.status, "needs_responses");

    ctx.write(`${work}/plan-responses-r1.json`, JSON.stringify([{ id: "P1", decision: "accept", rationale: "confirmed NaN", evidence: "node -e → NaN", change_ref: "plan.md step 1" }]));
    r = ctx.cli(["plan", ...P(ctx), "--thread", `${slug}-plan`, "--responses", `${work}/plan-responses-r1.json`, "--attach", `${work}/plan.md`], {
      extra: { FAKE_CODEX_JSON: plan({ verdict: "approve", prior: [ruling("P1")] }) },
    });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.st.loop, "converged");

    ctx.write(`${work}/plan.final.md`, "# Final plan\n- throw RangeError on empty input\n");
    ctx.write(`${work}/decisions.md`, "- RangeError (not NaN): callers never rely on NaN\n");
    r = ctx.cli(["task-state", slug, ...P(ctx), "--phase", "implementing", "--plan", `${work}/plan.final.md`]);
    assert.equal(r.code, 0, r.dump());

    // §3 implement
    fs.writeFileSync(path.join(ctx.repo, "src", "stats.js"), "export function avg(xs) {\n  if (!xs.length) throw new RangeError('empty');\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n");
    r = ctx.cli(["task-state", slug, ...P(ctx), "--phase", "reviewing"]);
    assert.equal(r.code, 0, r.dump());

    // §4 review round 1
    ctx.write(`${work}/review-brief.md`, "## 목표\n빈 배열 처리\n## 현재 상태\nverified: npm test 통과\n");
    const log = path.join(ctx.base, "codex.log");
    r = ctx.cli([
      "review", ...P(ctx), "--thread", `${slug}-review`, "--message-file", `${work}/review-brief.md`,
      "--plan-file", `${work}/plan.final.md`, "--attach", `${work}/decisions.md`,
    ], { extra: { FAKE_CODEX_JSON: review({ findings: [finding({ severity: "minor", title: "message should name the function" }), finding()] }), FAKE_CODEX_LOG: log } });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.st.loop, "needs_reply");
    const firstPrompt = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).stdin;
    assert.match(firstPrompt, /RangeError/, "the uncommitted diff is inlined for Astra");
    assert.match(firstPrompt, /agreed plan \/ decisions log is attached/);
    assert.doesNotMatch(firstPrompt, /\.coworker\/work\/avg-empty\/plan-brief/, ".coworker/ scratch files must not leak into the review diff");

    // fix + responses; next round with --responses only (no target flags)
    fs.writeFileSync(path.join(ctx.repo, "src", "stats.js"), "export function avg(xs) {\n  if (!xs.length) throw new RangeError('avg: empty input');\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n");
    ctx.write(`${work}/review-responses-r1.json`, JSON.stringify([
      { id: "R1", decision: "accept", rationale: "message now names avg", change_ref: "src/stats.js:2" },
      { id: "R2", decision: "reject", rationale: "empty input already throws since this change", evidence: "src/stats.js:2" },
    ]));
    r = ctx.cli(["review", ...P(ctx), "--thread", `${slug}-review`, "--responses", `${work}/review-responses-r1.json`], {
      extra: { FAKE_CODEX_JSON: review({ verdict: "approve", prior: [ruling("R1"), ruling("R2", "conceded")] }), FAKE_CODEX_LOG: log },
    });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.st.loop, "converged");
    const secondPrompt = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)).stdin;
    assert.match(secondPrompt, /Changes since your last review round/, "re-review gets the exact delta");
    assert.match(secondPrompt, /R2 .*→ \*\*reject\*\*/);

    // §5 report numbers
    r = ctx.cli(["task-state", slug, ...P(ctx), "--phase", "done"]);
    assert.equal(r.code, 0, r.dump());
    for (const thread of [`${slug}-plan`, `${slug}-review`]) {
      r = ctx.cli(["threads", "show", thread, ...P(ctx)]);
      assert.equal(r.code, 0, r.dump());
      assert.match(r.stdout, /Loop: converged/);
      assert.match(r.stdout, /turns 2 · input 2k tokens/);
      assert.match(r.stdout, /transcript: .*\.md/);
    }
  });

  test("review target on a CLEAN tree: `--base main` still has commits to review (the skill's git-status precheck would stop here)", () => {
    const ctx = setup("clean-base");
    ctx.git(["checkout", "-q", "-b", "feature"]);
    fs.writeFileSync(path.join(ctx.repo, "src", "stats.js"), "export const avg = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;\n");
    ctx.git(["commit", "-qam", "feat"]);
    assert.equal(ctx.git(["status", "--short"]), "", "git status --short is empty");
    const r = ctx.cli(["review", ...P(ctx), "--thread", "clean-review", "--base", "main", "--message", "review the feature branch"], {
      extra: { FAKE_CODEX_JSON: review({ verdict: "approve" }) },
    });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.st.loop, "converged");
  });

  test("review SKILL.md only uses `git status --short` as a precheck for the default (uncommitted) target", {
  }, () => {
    const line = skillText("review").split("\n").find((text) => text.includes("git status --short"));
    assert.match(line, /default|uncommitted|without --base/i, line);
  });

  test("task SKILL.md reads an existing task-state before overwriting its phase", {
  }, () => {
    const ctx = setup("task-resume");
    let r = ctx.cli(["task-state", "resume-me", ...P(ctx), "--phase", "reviewing"]);
    assert.equal(r.code, 0, r.dump());
    // After a compaction/interruption Claude re-runs §0.3 literally:
    const first = skillText("task").split("\n").find((line) => line.includes("coworker task-state"));
    const args = first.match(/`coworker (task-state [^`]+)`/)[1].replace("<slug>", "resume-me").replace('"${CLAUDE_PROJECT_DIR}"', ctx.repo).split(/\s+/);
    r = ctx.cli(args);
    assert.equal(r.code, 0, r.dump());
    assert.equal(JSON.parse(r.stdout).phase, "reviewing", "the resume instruction can only work if the prior phase is still visible");
  });

  test("--quick: the §4 review command minus --plan-file/decisions.md (as the skill's note says) works without a plan", () => {
    const ctx = setup("task-quick");
    const text = skillText("task");
    assert.match(text, /--quick` there is no plan: drop `--plan-file`/, "task SKILL.md must tell Claude to drop the plan flags in --quick mode");
    const work = ".coworker/work/q";
    ctx.write(`${work}/review-brief.md`, "## 목표\nquick fix\n");
    fs.appendFileSync(path.join(ctx.repo, "src", "stats.js"), "export const one = 1;\n");
    const r = ctx.cli(["review", ...P(ctx), "--thread", "q-review", "--message-file", `${work}/review-brief.md`], {
      extra: { FAKE_CODEX_JSON: review({ verdict: "approve" }) },
    });
    assert.equal(r.code, 0, r.dump());
    assert.equal(r.st.loop, "converged");
  });
});

// ================================================================== 2. project root consistency

describe("project root: ${CLAUDE_PROJECT_DIR} is the launch dir, the Bash cwd moves, the hook reads its env", () => {
  test("relative --message-file after Claude `cd`s into a subdirectory (skills pass .coworker/work/… relative)", {
  }, () => {
    const ctx = setup("rel-path");
    ctx.write(".coworker/work/s/q.md", "## 질문\n캐시 무효화 전략?\n");
    const r = ctx.cli(["ask", ...P(ctx), "--thread", "rel", "--message-file", ".coworker/work/s/q.md"], { cwd: path.join(ctx.repo, "src") });
    assert.equal(r.code, 0, r.dump());
  });

  test("/coworker:mode on (its `!` line) is seen by the UserPromptSubmit hook when the session was launched in a monorepo package", {
  }, () => {
    const ctx = setup("mono-mode");
    const launchDir = path.join(ctx.repo, "packages", "app"); // `claude` started here
    const m = runBang("mode", "on", { cwd: launchDir, env: ctx.env() });
    assert.equal(m.code, 0, m.dump());
    assert.match(m.stdout, /auto mode ON/);
    const h = hook(ctx, { projectDir: launchDir, prompt: "로그인 토큰 갱신 기능을 구현해줘, 여러 파일 수정 필요" });
    assert.equal(h.code, 0);
    assert.match(h.stdout, /coworker auto mode is on/, `mode wrote ${m.stdout.match(/written to (\S+)\)/)?.[1]} but the hook reads ${launchDir}/.coworker/config.json`);
  });

  test("/coworker:threads (its `!` line) lists threads the flagship skills created with --project \"${CLAUDE_PROJECT_DIR}\"", {
  }, () => {
    const ctx = setup("mono-threads");
    const launchDir = path.join(ctx.repo, "packages", "app");
    const a = ctx.cli(["ask", "--project", launchDir, "--thread", "pkg-ask", "--message", "hello"], { cwd: launchDir });
    assert.equal(a.code, 0, a.dump());
    const t = runBang("threads", "", { cwd: launchDir, env: ctx.env() });
    assert.equal(t.code, 0, t.dump());
    assert.match(t.stdout, /pkg-ask/);
  });

  test("control: at the repo root the `!` lines, the hook and --project agree", () => {
    const ctx = setup("root-ok");
    const m = runBang("mode", "on", { cwd: ctx.repo, env: ctx.env() });
    assert.equal(m.code, 0, m.dump());
    const h = hook(ctx, { projectDir: ctx.repo, prompt: "Please implement a retry wrapper for the fetch client" });
    assert.match(h.stdout, /coworker auto mode is on/);
    const again = hook(ctx, { projectDir: ctx.repo, prompt: "Please implement a retry wrapper for the fetch client" });
    assert.match(again.stdout, /if this request will change ~50\+ lines/);
    const slash = hook(ctx, { projectDir: ctx.repo, prompt: "/coworker:status --ping" });
    assert.equal(slash.stdout, "");
  });
});

// ================================================================== 3. `!` lines vs. user typos

describe("ops skills' `!` lines (a non-zero exit >= 2 aborts the whole skill in Claude Code)", () => {
  test("typical arguments exit 0 through the bin/ launcher", () => {
    const ctx = setup("bang-ok");
    for (const [skill, args] of [["threads", ""], ["threads", "list"], ["mode", ""], ["mode", "status"], ["status", ""], ["status", "--json"]]) {
      const r = runBang(skill, args, { cwd: ctx.repo, env: ctx.env() });
      assert.equal(r.code, 0, `${skill} "${args}": ${r.dump()}`);
    }
  });

  test("a typo such as `/coworker:threads show` or `/coworker:mode of` still reaches Claude (exit <= 1)", {
  }, () => {
    const ctx = setup("bang-typo");
    for (const [skill, args] of [["threads", "show"], ["mode", "of"], ["status", "--pign"]]) {
      const r = runBang(skill, args, { cwd: ctx.repo, env: ctx.env() });
      assert.ok(r.code <= 1, `${skill} "${args}" exited ${r.code}`);
    }
  });
});

// ================================================================== 4. retries the CLI itself asks for

describe("retry paths the result text prescribes", () => {
  test("ask --claude-view: 'rerun the same command once' after a failed turn", {
  }, () => {
    const ctx = setup("seal-ask");
    const args = ["ask", ...P(ctx), "--thread", "sealed", "--message-file", ".coworker/work/ask/sealed-q1.md", "--claude-view", ".coworker/work/ask/view.md"];
    ctx.write(".coworker/work/ask/sealed-q1.md", "## 질문\n뮤텍스 vs 큐?\n");
    ctx.write(".coworker/work/ask/view.md", "내 견해: 큐\n");
    const first = ctx.cli(args, { extra: { FAKE_CODEX_MODE: "fail" } });
    assert.equal(first.code, 1, first.dump());
    assert.match(first.stdout, /rerun the same command once/);
    const retry = ctx.cli(args);
    assert.equal(retry.code, 0, retry.dump());
    assert.match(retry.stdout, /내 견해: 큐/);
  });

  test("debate --stage open: rerun after a failed turn", {
  }, () => {
    const ctx = setup("seal-debate");
    ctx.write(".coworker/work/db/brief.md", "Pick a queue: A or B. Criteria: latency (0.6), ops cost (0.4)\n");
    ctx.write(".coworker/work/db/claude-proposal.md", "PICK: A — lower latency\n");
    const args = ["debate", ...P(ctx), "--thread", "db-debate", "--stage", "open", "--brief", ".coworker/work/db/brief.md", "--claude-proposal", ".coworker/work/db/claude-proposal.md"];
    const first = ctx.cli(args, { extra: { FAKE_CODEX_MODE: "fail" } });
    assert.equal(first.code, 1, first.dump());
    const retry = ctx.cli(args);
    assert.equal(retry.code, 0, retry.dump());
  });

  test("invalid_output on plan round 1: the rerun is still round 1 of 2", {
  }, () => {
    const ctx = setup("invalid-round");
    ctx.write(".coworker/work/p/plan.md", "# plan\n- step\n");
    const args = ["plan", ...P(ctx), "--thread", "p-plan", "--message", "## 목표\n검토", "--attach", ".coworker/work/p/plan.md"];
    const bad = ctx.cli(args, { extra: { FAKE_CODEX_JSON: "Here is my critique in prose instead of JSON." } });
    assert.equal(bad.code, 1, bad.dump());
    assert.equal(bad.st.status, "invalid_output");
    const again = ctx.cli(args, { extra: { FAKE_CODEX_JSON: plan({ items: [planItem()] }) } });
    assert.equal(again.code, 0, again.dump());
    assert.match(again.stderr, /plan round 1\/2/);
    assert.equal(again.st.loop, "needs_reply");
  });

  test("stale on the last review round: protocol §4 says 'run another review round'", {
  }, async () => {
    const ctx = setup("stale-last");
    ctx.write(".coworker/config.json", JSON.stringify({ maxRounds: { review: 1 } }));
    fs.appendFileSync(path.join(ctx.repo, "src", "stats.js"), "export const x = 1;\n");
    const started = ctx.cli(["review", ...P(ctx), "--thread", "st-review", "--message", "review", "--detach"], {
      extra: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500", FAKE_CODEX_JSON: review({ verdict: "approve" }) },
    });
    assert.equal(started.code, 75, started.dump());
    fs.appendFileSync(path.join(ctx.repo, "src", "stats.js"), "export const y = 2;\n"); // Claude edits during the review
    const waited = ctx.cli(["wait", started.st.job, ...P(ctx)]);
    assert.equal(waited.code, 0, waited.dump());
    assert.equal(waited.st.loop, "stale");
    const next = ctx.cli(["review", ...P(ctx), "--thread", "st-review"], { extra: { FAKE_CODEX_JSON: review({ verdict: "approve" }) } });
    assert.equal(next.code, 0, next.dump());
  });

  /** A review thread with an open R1 whose Codex session is gone (exit 4). */
  function lostReviewThread(name) {
    const ctx = setup(name);
    fs.appendFileSync(path.join(ctx.repo, "src", "stats.js"), "export const z = 3;\n");
    let r = ctx.cli(["review", ...P(ctx), "--thread", "l-review", "--message", "review"], { extra: { FAKE_CODEX_JSON: review({ findings: [finding()] }) } });
    assert.equal(r.code, 0, r.dump());
    ctx.write(".coworker/work/l/r1.json", JSON.stringify([{ id: "R1", decision: "accept", rationale: "fixed", change_ref: "src/stats.js:2" }]));
    r = ctx.cli(["review", ...P(ctx), "--thread", "l-review", "--responses", ".coworker/work/l/r1.json"], { extra: { FAKE_CODEX_MODE: "lost" } });
    assert.equal(r.code, 4, r.dump());
    assert.equal(r.st.status, "session_lost");
    return ctx;
  }

  test("session_lost on a review thread → `--new` + short recap (protocol §1) starts a fresh round 1", {
  }, () => {
    const ctx = lostReviewThread("lost-new");
    const r = ctx.cli(["review", ...P(ctx), "--thread", "l-review", "--new", "--message", "recap: R1 (avg([]) NaN) fixed at src/stats.js:2"], {
      extra: { FAKE_CODEX_JSON: review({ verdict: "approve" }) },
    });
    assert.equal(r.code, 0, r.dump());
    assert.match(r.stderr, /review round 1\//);
  });

  test("session_lost → `--new` with the old responses file is refused BEFORE a Codex turn is spent", {
  }, () => {
    const ctx = lostReviewThread("lost-new-resp");
    const log = path.join(ctx.base, "codex.log");
    const r = ctx.cli(["review", ...P(ctx), "--thread", "l-review", "--new", "--message", "recap: R1 fixed", "--responses", ".coworker/work/l/r1.json"], {
      extra: { FAKE_CODEX_LOG: log, FAKE_CODEX_JSON: review({ verdict: "approve", prior: [ruling("R1")] }) },
    });
    assert.equal(r.code, 64, r.dump());
    assert.ok(!fs.existsSync(log), "no Codex turn may be spent on a request that cannot be finalized");
  });
});

// ================================================================== 5. what Claude reads on each exit

describe("result text Claude acts on", () => {
  test("75 (still running) names the exact wait command; `wait` from the same cwd collects the result", () => {
    const ctx = setup("wait-hint");
    const r = ctx.cli(["ask", ...P(ctx), "--thread", "w", "--message", "slow one", "--wait-budget", "1"], {
      extra: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "2500" },
    });
    assert.equal(r.code, 75, r.dump());
    assert.match(r.stdout, /Do NOT resend the message/);
    const hint = r.stdout.match(/Collect the result with: (coworker wait \S+)/)[1];
    const w = ctx.cli([...hint.split(" ").slice(1), ...P(ctx)]);
    assert.equal(w.code, 0, w.dump());
    assert.equal(w.st.job, r.st.job);
  });

  test("exit 3 (busy) → `coworker wait --thread <name>` resolves the running job (protocol §1)", () => {
    const ctx = setup("busy");
    const first = ctx.cli(["ask", ...P(ctx), "--thread", "b", "--message", "one", "--detach"], { extra: { FAKE_CODEX_MODE: "slow", FAKE_CODEX_DELAY_MS: "5000" } });
    assert.equal(first.code, 75, first.dump());
    const second = ctx.cli(["ask", ...P(ctx), "--thread", "b", "--message", "two"]);
    assert.equal(second.code, 3, second.dump());
    assert.equal(second.st.status, "busy");
    assert.equal(second.st.job, first.st.job);
    const w = ctx.cli(["wait", "--thread", "b", ...P(ctx)]);
    assert.equal(w.code, 0, w.dump());
    assert.equal(w.st.job, first.st.job);
  });

  test("round limit is exit 64 with status=round_limit and a 'NOT approval … only with consent' message", () => {
    const ctx = setup("round-limit");
    ctx.write(".coworker/work/p/plan.md", "# plan\n");
    const base = ["plan", ...P(ctx), "--thread", "rl-plan", "--attach", ".coworker/work/p/plan.md"];
    let r = ctx.cli([...base, "--message", "brief"], { extra: { FAKE_CODEX_JSON: plan({ items: [planItem()] }) } });
    assert.equal(r.st.loop, "needs_reply", r.dump());
    ctx.write(".coworker/work/p/r1.json", JSON.stringify([{ id: "P1", decision: "reject", rationale: "unreachable", evidence: "api.js:40 validates" }]));
    r = ctx.cli([...base, "--responses", ".coworker/work/p/r1.json"], { extra: { FAKE_CODEX_JSON: plan({ prior: [ruling("P1", "maintained")] }) } });
    assert.equal(r.st.loop, "max_rounds", r.dump());
    assert.match(r.stdout, /NOT approval/);
    ctx.write(".coworker/work/p/r2.json", JSON.stringify([{ id: "P1", decision: "reject", rationale: "still unreachable", evidence: "grep" }]));
    r = ctx.cli([...base, "--responses", ".coworker/work/p/r2.json"]);
    assert.equal(r.code, 64, r.dump());
    assert.equal(r.st.status, "round_limit");
    assert.match(r.stderr, /only continue with --extra-round if the user agrees/);
  });

  test("a Korean result stays under Claude Code's ~30 KB Bash output limit, or the status line is also printed first", {
  }, () => {
    const ctx = setup("big-ko");
    const reply = "검토 결과: 경계 조건 누락. ".repeat(2500);
    const r = ctx.cli(["ask", ...P(ctx), "--thread", "ko", "--message", "안녕"], { extra: { FAKE_CODEX_REPLY: reply } });
    assert.equal(r.code, 0, r.dump());
    const total = Buffer.byteLength(r.stdout) + Buffer.byteLength(r.stderr);
    const statusInPreview = r.stdout.slice(0, 2000).includes("COWORKER status=");
    assert.ok(total < 28000 || statusInPreview, `stdout+stderr = ${total} bytes; status line only at the end`);
  });
});

// ================================================================== 6. skill text sanity from Claude's seat

describe("skill text from Claude's seat", () => {
  test("every skill that writes under .coworker/ pre-approves it (Edit rules also cover the Write tool)", () => {
    for (const name of ["task", "plan", "review", "ask", "debate"]) {
      const text = skillText(name);
      const front = text.split("---")[1];
      assert.match(front, /allowed-tools:.*Edit\(\.coworker\/\*\*\)/, name);
      assert.match(front, /allowed-tools:.*Bash\(coworker \*\)/, name);
      assert.match(front, /allowed-tools:.*\bRead\b/, `${name}: Read is needed for \${CLAUDE_PLUGIN_ROOT}/references/protocol.md outside the project`);
    }
  });

  test("review SKILL.md never puts raw user text into a shell command", {
  }, () => {
    assert.doesNotMatch(skillText("review"), /--focus "</);
  });

  test("task + protocol fit comfortably in the 5k-token re-attach budget after compaction", () => {
    const task = skillText("task");
    const protocol = fs.readFileSync(path.join(PLUGIN, "references", "protocol.md"), "utf8");
    assert.ok(task.length / 3.5 < 2000, `task SKILL.md ≈ ${Math.round(task.length / 3.5)} tokens`);
    assert.ok((task.length + protocol.length) / 3.5 < 5000, "task + protocol");
  });
});
