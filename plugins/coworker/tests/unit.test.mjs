// Unit tests for the pure(ish) library modules of the coworker plugin.
//
// Run:  cd plugins/coworker && node --test --test-concurrency=1 tests/unit.test.mjs
//
// Isolation: everything this file touches on disk lives under one temp root
// ($COWORKER_TEST_TMP if set, else the OS temp dir). XDG_CACHE_HOME / XDG_CONFIG_HOME point into it,
// CLAUDE_PROJECT_DIR and COWORKER_* are unset, and git runs with an empty global config so the user's
// excludesFile, hooks or signing settings cannot leak in. No test writes inside the plugin directory.
//
// Defects found while writing these tests were fixed; their tests are ordinary regressions now.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { candidatePaths, compareVersions, discoverCodex, parseVersion, probeVersion } from "../scripts/lib/binary.mjs";
import { normalizeArgv, parseArgs, splitShellWords, UsageError } from "../scripts/lib/args.mjs";
import {
  addItems,
  applyAstraRulings,
  applyClaudeResponses,
  ASTRA_STATUSES,
  CLAUDE_DECISIONS,
  CLOSED,
  convergence,
  emptyLedger,
  findItem,
  ledgerPath,
  pendingForAstra,
  pendingForClaude,
  readLedger,
  renderLedger,
  renderResponsesForAstra,
  tally,
  writeLedger,
} from "../scripts/lib/ledger.mjs";
import {
  buildAskPrompt,
  buildDebateCrossPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  detectLang,
  INLINE_DIFF_LIMIT,
  languageLine,
  renderAttachments,
  reviewTargetBlock,
  roleContract,
  turnDigest,
} from "../scripts/lib/prompts.mjs";
import { classifyError, createEventFolder, extractErrorMessage, LineBuffer, parseEventLine } from "../scripts/lib/events.mjs";
import { classifyOutcome, createTail, readStatus, reconcile, writeStatus } from "../scripts/lib/jobs.mjs";
import { changedFiles, diffBetween, diffStat, EMPTY_TREE, emptyTree, resolveTarget, snapshotTree } from "../scripts/lib/git.mjs";
import {
  acquireThreadLock,
  assertThreadName,
  ensureStateDir,
  isLockStale,
  jobDir,
  jobPaths,
  listThreads,
  lockPath,
  newJobId,
  processMatches,
  readJson,
  readLock,
  readThread,
  releaseThreadLock,
  TERMINAL_STATES,
  writeJsonAtomic,
  writeThread,
} from "../scripts/lib/state.mjs";
import { DEFAULTS, EFFORTS, findProjectRoot, globalConfigPath, KINDS, loadConfig, validateConfig, writeConfigKey } from "../scripts/lib/config.mjs";

// ------------------------------------------------------------------------------------------ isolation

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, "..", "scripts", "lib");
const FAKE_CODEX = path.join(HERE, "fixtures", "fake-codex.mjs");

const TMP_BASE = process.env.COWORKER_TEST_TMP || os.tmpdir();
fs.mkdirSync(TMP_BASE, { recursive: true });
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, "coworker-unit-")));

process.env.XDG_CACHE_HOME = path.join(ROOT, "xdg-cache");
process.env.XDG_CONFIG_HOME = path.join(ROOT, "xdg-config");
delete process.env.CLAUDE_PROJECT_DIR;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("COWORKER_") && key !== "COWORKER_TEST_TMP") delete process.env[key];
  if (key.startsWith("FAKE_CODEX_")) delete process.env[key];
}
const GIT_GLOBAL = path.join(ROOT, "gitconfig-global");
fs.writeFileSync(GIT_GLOBAL, "");
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: GIT_GLOBAL,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: ROOT,
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Coworker Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Coworker Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;
function tmpDir(prefix) {
  counter += 1;
  const dir = path.join(ROOT, `${prefix}-${counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function run(cwd, cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env, ...opts });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}
const g = (cwd, ...args) => run(cwd, "git", args).trim();

function makeRepo(prefix = "repo") {
  const dir = tmpDir(prefix);
  g(dir, "init", "-q", "-b", "main");
  return dir;
}

function put(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function commitAll(dir, message) {
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "--no-verify", "-m", message);
  return g(dir, "rev-parse", "HEAD");
}

function treeFiles(dir, treeish) {
  return g(dir, "ls-tree", "-r", "--name-only", treeish).split("\n").filter(Boolean).sort();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return false;
}

/** Long-lived child whose command line contains `marker` (like a supervisor whose argv holds the job dir). */
async function spawnMarked(marker) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore" });
  assert.ok(await waitFor(() => processMatches(child.pid, marker)), "marked child did not start");
  return child;
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid;
}

// =========================================================================================== binary.mjs

describe("binary.parseVersion", () => {
  test("parses codex-cli output with a prerelease", () => {
    assert.deepEqual(parseVersion("codex-cli 0.158.0-alpha.2"), {
      major: 0,
      minor: 158,
      patch: 0,
      pre: ["alpha", 2],
      raw: "0.158.0-alpha.2",
    });
  });

  test("parses a plain release and ignores surrounding text", () => {
    assert.deepEqual(parseVersion("codex-cli 0.157.1\n"), { major: 0, minor: 157, patch: 1, pre: [], raw: "0.157.1" });
  });

  test("takes the first version in multi-line output", () => {
    assert.equal(parseVersion("codex-cli 1.2.3\nnode 25.6.1").raw, "1.2.3");
  });

  test("numeric prerelease identifiers become numbers, others stay strings", () => {
    assert.deepEqual(parseVersion("1.0.0-rc.1.x-y.007a").pre, ["rc", 1, "x-y", "007a"]);
  });

  test("returns null for unparseable input", () => {
    for (const input of ["", "codex-cli", "1.2", null, undefined, "v.x.y"]) {
      assert.equal(parseVersion(input), null, `input ${JSON.stringify(input)}`);
    }
  });
});

describe("binary.compareVersions", () => {
  test("prerelease ordering: 0.157.1 < 0.158.0-alpha.2 < 0.158.0", () => {
    assert.equal(compareVersions("0.158.0-alpha.2", "0.157.1"), 1);
    assert.equal(compareVersions("0.157.1", "0.158.0-alpha.2"), -1);
    assert.equal(compareVersions("0.158.0-alpha.2", "0.158.0"), -1);
    assert.equal(compareVersions("0.158.0", "0.158.0-alpha.2"), 1);
  });

  test("full SemVer precedence chain (spec §11 plus numeric identifiers)", () => {
    const ordered = [
      "0.99.0",
      "0.157.1",
      "0.158.0-1",
      "0.158.0-alpha",
      "0.158.0-alpha.1",
      "0.158.0-alpha.2",
      "0.158.0-alpha.10",
      "0.158.0-alpha.beta",
      "0.158.0-beta",
      "0.158.0-beta.2",
      "0.158.0-beta.11",
      "0.158.0-rc.1",
      "0.158.0",
      "0.158.1",
      "1.0.0",
    ];
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = 0; j < ordered.length; j += 1) {
        const expected = i === j ? 0 : i < j ? -1 : 1;
        assert.equal(compareVersions(ordered[i], ordered[j]), expected, `${ordered[i]} vs ${ordered[j]}`);
      }
    }
    const shuffled = [...ordered].reverse().sort(() => 0).sort(compareVersions);
    assert.deepEqual(shuffled, ordered);
  });

  test("numeric parts compare numerically, not lexically", () => {
    assert.equal(compareVersions("0.99.0", "0.158.0"), -1);
    assert.equal(compareVersions("0.158.0-alpha.9", "0.158.0-alpha.10"), -1);
  });

  test("equal versions (with surrounding text) compare as 0", () => {
    assert.equal(compareVersions("codex-cli 0.158.0", "0.158.0"), 0);
    assert.equal(compareVersions("0.158.0-alpha.2", "codex-cli 0.158.0-alpha.2"), 0);
  });

  test("accepts parsed objects as well as strings", () => {
    assert.equal(compareVersions(parseVersion("1.2.3"), "1.2.4"), -1);
    assert.equal(compareVersions(parseVersion("1.2.4"), parseVersion("1.2.3")), 1);
  });

  test("unparseable versions sort below everything", () => {
    assert.equal(compareVersions(null, null), 0);
    assert.equal(compareVersions("garbage", "0.0.1"), -1);
    assert.equal(compareVersions("0.0.1", "garbage"), 1);
  });
});

describe("binary.candidatePaths", () => {
  test("explicit paths first, then PATH entries, then well-known dirs; duplicates collapse", () => {
    const list = candidatePaths({ explicit: ["/pinned/codex", "", null], envPath: "/a:/a:/b::/a", platform: "linux" });
    assert.equal(list[0], "/pinned/codex");
    assert.equal(list[1], "/a/codex");
    assert.equal(list[2], "/b/codex");
    assert.equal(list.filter((entry) => entry === "/a/codex").length, 1);
    assert.ok(!list.includes("codex"), "empty PATH segments must not produce a relative 'codex'");
    // The first well-known dir cannot collide with the (non-existent) entries before it. Later ones may be
    // symlinks to the same binary on some machines and legitimately collapse, so only check the first.
    assert.ok(list.indexOf("/opt/homebrew/bin/codex") > 2);
    assert.equal(new Set(list).size, list.length);
  });

  test("a well-known dir that is also on PATH is listed once", () => {
    const list = candidatePaths({ envPath: "/opt/homebrew/bin:/usr/local/bin", platform: "linux" });
    assert.equal(list.filter((entry) => entry === "/opt/homebrew/bin/codex").length, 1);
    assert.ok(list.filter((entry) => entry === "/usr/local/bin/codex").length <= 1);
    assert.equal(list[0], "/opt/homebrew/bin/codex");
  });

  test("app bundle candidates only on darwin", () => {
    const darwin = candidatePaths({ envPath: "", platform: "darwin" });
    const linux = candidatePaths({ envPath: "", platform: "linux" });
    assert.ok(darwin.some((entry) => entry.includes("ChatGPT.app")));
    assert.ok(!linux.some((entry) => entry.includes(".app/")));
  });

  test("win32 looks for codex.exe", () => {
    const list = candidatePaths({ envPath: "/w", platform: "win32" });
    assert.ok(list.includes(path.join("/w", "codex.exe")));
    assert.ok(!list.some((entry) => entry.endsWith(`${path.sep}codex`)));
  });

  test("symlinks to the same binary de-duplicate by realpath (first occurrence wins)", () => {
    const dir = tmpDir("bin");
    const real = put(dir, "real/codex", "#!/bin/sh\n");
    fs.mkdirSync(path.join(dir, "link"));
    fs.symlinkSync(real, path.join(dir, "link", "codex"));
    const list = candidatePaths({ envPath: `${dir}/real:${dir}/link`, platform: "linux" });
    assert.ok(list.includes(real));
    assert.ok(!list.includes(path.join(dir, "link", "codex")));

    const pinnedFirst = candidatePaths({ explicit: [path.join(dir, "link", "codex")], envPath: `${dir}/real`, platform: "linux" });
    assert.equal(pinnedFirst[0], path.join(dir, "link", "codex"));
    assert.ok(!pinnedFirst.includes(real), "the explicit symlink shadows the real path it points to");
  });
});

describe("binary.discoverCodex", () => {
  function setup() {
    const dir = tmpDir("discover");
    const versions = new Map();
    const mk = (sub, version, mode = 0o755) => {
      const file = put(dir, `${sub}/codex`, "#!/bin/sh\necho fake\n");
      fs.chmodSync(file, mode);
      if (version) versions.set(file, version);
      return file;
    };
    const probe = (candidate) => {
      const version = versions.get(candidate);
      return version ? { ok: true, version: parseVersion(version), text: version } : { ok: false, error: "not a test binary" };
    };
    return { dir, mk, probe };
  }

  test("picks the highest working version, skipping non-executables", () => {
    const { dir, mk, probe } = setup();
    const alpha = mk("a", "codex-cli 0.158.0-alpha.2");
    const release = mk("b", "codex-cli 0.158.0");
    const old = mk("c", "codex-cli 0.157.1");
    const notExec = mk("d", "codex-cli 9.9.9", 0o644);
    const { chosen, candidates } = discoverCodex({ envPath: [dir + "/a", dir + "/b", dir + "/c", dir + "/d"].join(":"), platform: "linux", probe });
    assert.equal(chosen.path, release);
    assert.equal(chosen.version, "0.158.0");
    assert.ok(candidates.some((entry) => entry.path === alpha && entry.ok));
    assert.ok(candidates.some((entry) => entry.path === old && entry.ok));
    assert.ok(!candidates.some((entry) => entry.path === notExec));
  });

  test("an explicit binary wins even when older; a broken explicit one falls back to the highest", () => {
    const { dir, mk, probe } = setup();
    const newer = mk("a", "codex-cli 0.160.0");
    const older = mk("b", "codex-cli 0.150.0");
    const pinned = discoverCodex({ explicit: [older], envPath: `${dir}/a:${dir}/b`, platform: "linux", probe });
    assert.equal(pinned.chosen.path, older);
    assert.equal(pinned.chosen.explicit, true);

    const broken = mk("c", null);
    const fallback = discoverCodex({ explicit: [broken], envPath: `${dir}/a:${dir}/b`, platform: "linux", probe });
    assert.equal(fallback.chosen.path, newer);
    const brokenEntry = fallback.candidates.find((entry) => entry.path === broken);
    assert.equal(brokenEntry.ok, false);
    assert.equal(brokenEntry.explicit, true);
  });

  test("no working candidate → chosen is null", () => {
    const { dir, mk, probe } = setup();
    mk("a", null);
    assert.equal(discoverCodex({ envPath: `${dir}/a`, platform: "linux", probe }).chosen, null);
  });

  test("probes the real fake-codex fixture through probeVersion", () => {
    const dir = tmpDir("discover-fixture");
    const link = path.join(dir, "codex");
    fs.symlinkSync(FAKE_CODEX, link);
    // Only the fixture is really executed; any codex installed on this machine is left alone.
    const probe = (candidate) => (candidate === link ? probeVersion(candidate) : { ok: false, error: "not probed in tests" });
    const { chosen } = discoverCodex({ explicit: [link], envPath: "", platform: "linux", probe });
    assert.equal(chosen.path, link);
    assert.equal(chosen.version, "0.158.0");
    assert.equal(probeVersion(path.join(dir, "missing-codex")).ok, false);
  });
});

// ============================================================================================= args.mjs

describe("args.parseArgs", () => {
  const spec = {
    booleans: ["json", "new"],
    strings: ["thread", "message"],
    arrays: ["attach"],
    aliases: { t: "thread", m: "message", a: "attach" },
  };

  test("unknown long and short flags are UsageErrors", () => {
    assert.throws(() => parseArgs(["--nope"], spec), (error) => error instanceof UsageError && /Unknown option: --nope/.test(error.message));
    assert.throws(() => parseArgs(["-x"], spec), (error) => error instanceof UsageError && /Unknown option: -x/.test(error.message));
    assert.throws(() => parseArgs(["--nope=1"], spec), /Unknown option: --nope=1/);
  });

  test("booleans, including --flag=false|0|no|off", () => {
    assert.deepEqual(parseArgs(["--json"], spec).flags.json, true);
    for (const off of ["false", "0", "no", "OFF"]) assert.equal(parseArgs([`--json=${off}`], spec).flags.json, false, off);
    assert.equal(parseArgs(["--json=yes"], spec).flags.json, true);
    assert.equal(parseArgs([], spec).flags.json, undefined);
  });

  test("strings: separate value, --x=y, value containing '=', empty inline value, last wins", () => {
    assert.equal(parseArgs(["--thread", "feat"], spec).flags.thread, "feat");
    assert.equal(parseArgs(["--thread=feat"], spec).flags.thread, "feat");
    assert.equal(parseArgs(["--message=a=b=c"], spec).flags.message, "a=b=c");
    assert.equal(parseArgs(["--thread="], spec).flags.thread, "");
    assert.equal(parseArgs(["--thread", "a", "--thread", "b"], spec).flags.thread, "b");
  });

  test("aliases resolve for short and long spellings", () => {
    const { flags } = parseArgs(["-t", "x", "-m=hello", "--a", "f1"], spec);
    assert.equal(flags.thread, "x");
    assert.equal(flags.message, "hello");
    assert.deepEqual(flags.attach, ["f1"]);
  });

  test("arrays accumulate and default to []", () => {
    assert.deepEqual(parseArgs([], spec).flags.attach, []);
    assert.deepEqual(parseArgs(["--attach", "a", "--attach=b", "-a", "c"], spec).flags.attach, ["a", "b", "c"]);
  });

  test("missing value is a UsageError (end of argv or followed by another --flag)", () => {
    assert.throws(() => parseArgs(["--thread"], spec), (error) => error instanceof UsageError && /Missing value for --thread/.test(error.message));
    assert.throws(() => parseArgs(["--thread", "--json"], spec), /Missing value for --thread/);
    assert.throws(() => parseArgs(["--attach"], spec), /Missing value for --attach/);
  });

  test("single-dash values such as '-' or negative numbers are accepted as values", () => {
    assert.equal(parseArgs(["--thread", "-"], spec).flags.thread, "-");
    assert.equal(parseArgs(["--message", "-5"], spec).flags.message, "-5");
  });

  test("positionals, lone '-', and '--' terminator", () => {
    const { flags, positionals } = parseArgs(["show", "-", "--json", "feat", "--", "--not-a-flag", "-x"], spec);
    assert.equal(flags.json, true);
    assert.deepEqual(positionals, ["show", "-", "feat", "--not-a-flag", "-x"]);
  });
});

describe("args.splitShellWords", () => {
  test("splits on any whitespace and collapses runs", () => {
    assert.deepEqual(splitShellWords("  a \t b\n\nc  "), ["a", "b", "c"]);
    assert.deepEqual(splitShellWords(""), []);
    assert.deepEqual(splitShellWords("   "), []);
  });

  test("single and double quotes group words; empty quotes make an empty word", () => {
    assert.deepEqual(splitShellWords(`show "my thread" 'x y'`), ["show", "my thread", "x y"]);
    assert.deepEqual(splitShellWords(`a "" b ''`), ["a", "", "b", ""]);
  });

  test("adjacent quoted and bare segments concatenate", () => {
    assert.deepEqual(splitShellWords(`a"b c"'d'e`), ["ab cde"]);
    assert.deepEqual(splitShellWords(`--focus="error handling"`), ["--focus=error handling"]);
  });

  test("backslash escapes outside quotes", () => {
    assert.deepEqual(splitShellWords("a\\ b c"), ["a b", "c"]);
    assert.deepEqual(splitShellWords(`\\"x\\"`), [`"x"`]);
    assert.deepEqual(splitShellWords("\\'"), ["'"]);
  });

  test('inside double quotes only \\" \\\\ \\$ \\` are escapes', () => {
    assert.deepEqual(splitShellWords(`"a\\"b\\\\c\\$d\\\`e\\nf"`), ['a"b\\c$d`e\\nf']);
  });

  test("single quotes are fully literal", () => {
    assert.deepEqual(splitShellWords(`'a\\b "c" $HOME'`), ['a\\b "c" $HOME']);
  });

  test("no expansion of $VARS or globs; trailing backslash kept literally", () => {
    assert.deepEqual(splitShellWords("$HOME *.js ~"), ["$HOME", "*.js", "~"]);
    assert.deepEqual(splitShellWords("a\\"), ["a\\"]);
  });

  test("unterminated quotes are UsageErrors", () => {
    assert.throws(() => splitShellWords(`"abc`), (error) => error instanceof UsageError && /Unterminated quote/.test(error.message));
    assert.throws(() => splitShellWords(`it's`), UsageError);
  });
});

describe("args.normalizeArgv", () => {
  test("a single empty or blank element means no arguments", () => {
    assert.deepEqual(normalizeArgv([""]), []);
    assert.deepEqual(normalizeArgv(["   "]), []);
    assert.deepEqual(normalizeArgv([]), []);
  });

  test("a single element containing whitespace is split shell-style", () => {
    assert.deepEqual(normalizeArgv(["show feat"]), ["show", "feat"]);
    assert.deepEqual(normalizeArgv(["--ping --json"]), ["--ping", "--json"]);
    assert.deepEqual(normalizeArgv([`show "my feat"`]), ["show", "my feat"]);
  });

  test("already-split argv and single plain tokens pass through unchanged", () => {
    const argv = ["show", "feat thread"];
    assert.equal(normalizeArgv(argv), argv);
    assert.deepEqual(normalizeArgv(["--json"]), ["--json"]);
  });

  test("joined $ARGUMENTS round-trips through parseArgs", () => {
    const { flags, positionals } = parseArgs(normalizeArgv(["--ping --json extra"]), { booleans: ["ping", "json"] });
    assert.equal(flags.ping, true);
    assert.equal(flags.json, true);
    assert.deepEqual(positionals, ["extra"]);
  });

  test("a single whitespace-padded token is normalized like the unpadded one", () => {
    assert.deepEqual(normalizeArgv(["--ping "]), ["--ping"]);
    assert.deepEqual(normalizeArgv([" --json"]), ["--json"]);
    assert.deepEqual(normalizeArgv(["\tshow feat \n"]), ["show", "feat"]);
    assert.equal(parseArgs(normalizeArgv(["--ping "]), { booleans: ["ping"] }).flags.ping, true);
  });

  test("a single token with an apostrophe but no whitespace is passed through, not shell-parsed", () => {
    assert.deepEqual(normalizeArgv(["don't"]), ["don't"]);
  });
});

// =========================================================================================== ledger.mjs

function reviewLedger(severities = ["major", "minor"]) {
  const ledger = emptyLedger();
  addItems(
    ledger,
    "review",
    severities.map((severity, index) => ({ severity, title: `finding ${index + 1}`, file: `src/f${index + 1}.js`, line_start: 10, line_end: 12 })),
    1,
  );
  return ledger;
}

const respond = (id, decision, rationale = `because ${decision}`) => ({ id, decision, rationale });
const rule = (id, status, extra = {}) => ({ id, status, reason: `ruling ${status}`, ...extra });

describe("ledger.addItems", () => {
  test("assigns P#/R# ids with independent counters that persist across calls", () => {
    const ledger = emptyLedger();
    const plan = addItems(ledger, "plan", [{ severity: "major", title: "p-a", section: "Migration" }, { severity: "minor", title: "p-b" }], 1);
    const review = addItems(ledger, "review", [{ severity: "blocker", title: "r-a" }], 1);
    const more = addItems(ledger, "plan", [{ severity: "minor", title: "p-c" }], 2);
    assert.deepEqual(plan.map((item) => item.id), ["P1", "P2"]);
    assert.deepEqual(review.map((item) => item.id), ["R1"]);
    assert.deepEqual(more.map((item) => item.id), ["P3"]);
    assert.deepEqual(ledger.counters, { P: 3, R: 1 });
    assert.equal(ledger.items.length, 4);
    assert.equal(plan[0].where, "Migration");
    assert.equal(plan[1].where, "");
    assert.equal(more[0].raisedRound, 2);
  });

  test("new items start open, raised by astra, with the original entry kept in data", () => {
    const ledger = emptyLedger();
    const entry = { severity: "major", title: "t", file: "a.js", line_start: 3, line_end: 3, recommendation: "fix" };
    const [item] = addItems(ledger, "review", [entry], 1);
    assert.equal(item.status, "open");
    assert.equal(item.kind, "review");
    assert.equal(item.maintainedStreak, 0);
    assert.deepEqual(item.history, [{ round: 1, actor: "astra", event: "raised", status: "open", note: "" }]);
    assert.deepEqual(item.data, entry);
  });

  test("where formatting: file, file:line, file:start-end", () => {
    const ledger = emptyLedger();
    const items = addItems(
      ledger,
      "review",
      [
        { severity: "minor", file: "a.js" },
        { severity: "minor", file: "a.js", line_start: 7 },
        { severity: "minor", file: "a.js", line_start: 7, line_end: 7 },
        { severity: "minor", file: "a.js", line_start: 7, line_end: 9 },
        { severity: "minor", file: "a.js", line_start: null, line_end: 9 },
      ],
      1,
    );
    assert.deepEqual(items.map((item) => item.where), ["a.js", "a.js:7", "a.js:7", "a.js:7-9", "a.js"]);
  });

  test("null/empty entries add nothing", () => {
    const ledger = emptyLedger();
    assert.deepEqual(addItems(ledger, "review", null, 1), []);
    assert.deepEqual(addItems(ledger, "review", [], 1), []);
    assert.deepEqual(ledger.counters, { P: 0, R: 0 });
  });

  test("findItem is case-insensitive and trims", () => {
    const ledger = reviewLedger();
    assert.equal(findItem(ledger, "r1").id, "R1");
    assert.equal(findItem(ledger, "  R2 ").id, "R2");
    assert.equal(findItem(ledger, "R3"), undefined);
  });
});

describe("ledger.applyClaudeResponses", () => {
  test("maps every decision to its status and records the move", () => {
    const ledger = reviewLedger(["major", "major", "major", "major", "major"]);
    applyClaudeResponses(
      ledger,
      [
        { id: "R1", decision: "accept", rationale: "  fixed it  ", evidence: " test passes ", change_ref: " abc123 " },
        respond("R2", "partial"),
        respond("R3", "reject"),
        respond("R4", "defer"),
        respond("R5", "user"),
      ],
      2,
    );
    assert.deepEqual(
      ledger.items.map((item) => item.status),
      ["addressed", "partially_addressed", "disputed", "deferred", "user_decided"],
    );
    assert.deepEqual(ledger.items[0].history.at(-1), {
      round: 2,
      actor: "claude",
      event: "accept",
      status: "addressed",
      note: "fixed it",
      evidence: "test passes",
      change_ref: "abc123",
    });
  });

  test("ids are matched case-insensitively", () => {
    const ledger = reviewLedger();
    applyClaudeResponses(ledger, [respond("r1", "accept"), respond(" R2 ", "reject")], 2);
    assert.equal(ledger.items[0].status, "addressed");
    assert.equal(ledger.items[1].status, "disputed");
  });

  function expectInvalid(ledger, responses, pattern) {
    const before = structuredClone(ledger);
    assert.throws(
      () => applyClaudeResponses(ledger, responses, 2),
      (error) => error.code === "INVALID_RESPONSES" && pattern.test(error.message),
    );
    assert.deepEqual(ledger, before, "a rejected responses file must not change the ledger");
  }

  test("missing a pending item is rejected and nothing is applied", () => {
    expectInvalid(reviewLedger(), [respond("R1", "accept")], /no decision for: R2/);
    expectInvalid(reviewLedger(), [], /no decision for: R1, R2/);
    expectInvalid(reviewLedger(), null, /no decision for: R1, R2/);
  });

  test("unknown id is rejected", () => {
    expectInvalid(reviewLedger(), [respond("R1", "accept"), respond("R2", "accept"), respond("R9", "accept")], /unknown id "R9"/);
  });

  test("answering a closed item is rejected", () => {
    const ledger = reviewLedger();
    applyClaudeResponses(ledger, [respond("R1", "accept"), respond("R2", "accept")], 2);
    applyAstraRulings(ledger, [rule("R1", "fixed_verified"), rule("R2", "maintained")], 2);
    expectInvalid(ledger, [respond("R1", "accept"), respond("R2", "reject")], /R1 is already closed \(resolved\)/);
  });

  test("invalid decision is rejected (decisions are case-sensitive)", () => {
    expectInvalid(reviewLedger(), [respond("R1", "maybe"), respond("R2", "accept")], /invalid decision "maybe" for R1/);
    expectInvalid(reviewLedger(), [respond("R1", "Accept"), respond("R2", "accept")], /invalid decision "Accept"/);
  });

  test("empty or whitespace rationale is rejected", () => {
    expectInvalid(reviewLedger(), [{ id: "R1", decision: "accept", rationale: "   " }, respond("R2", "accept")], /R1: rationale is required/);
    expectInvalid(reviewLedger(), [{ id: "R1", decision: "accept" }, respond("R2", "accept")], /R1: rationale is required/);
  });

  test("all problems are reported together", () => {
    const ledger = reviewLedger(["major", "major", "major"]);
    assert.throws(
      () => applyClaudeResponses(ledger, [respond("R9", "accept"), { id: "R1", decision: "nope", rationale: "" }], 2),
      (error) =>
        /unknown id "R9"/.test(error.message) &&
        /invalid decision "nope"/.test(error.message) &&
        /R1: rationale is required/.test(error.message) &&
        /no decision for: R2, R3/.test(error.message),
    );
  });

  test("an empty response list is fine when nothing is pending", () => {
    const ledger = emptyLedger();
    applyClaudeResponses(ledger, [], 1);
    assert.deepEqual(ledger, emptyLedger());
  });

  test("the same id answered twice is rejected", () => {
    expectInvalid(reviewLedger(), [respond("R1", "accept"), respond("r1", "reject"), respond("R2", "accept")], /R1 is answered more than once/);
  });
});

describe("ledger.applyAstraRulings", () => {
  function answered(decision = "reject", severities = ["major"]) {
    const ledger = reviewLedger(severities);
    applyClaudeResponses(ledger, ledger.items.map((item) => respond(item.id, decision)), 2);
    return ledger;
  }

  test("every Astra status maps to the expected ledger status", () => {
    const expected = {
      fixed_verified: "resolved",
      fix_incomplete: "open",
      conceded: "withdrawn",
      maintained: "open",
      downgraded: "open",
      superseded: "superseded",
      accepted_deferral: "deferred_ok",
    };
    assert.deepEqual(Object.keys(expected).sort(), [...ASTRA_STATUSES].sort());
    for (const [astra, status] of Object.entries(expected)) {
      const ledger = answered();
      const result = applyAstraRulings(ledger, [rule("R1", astra)], 2);
      assert.equal(ledger.items[0].status, status, astra);
      assert.deepEqual(result, { unknown: [], ignored: [], skipped: [] });
      assert.deepEqual(ledger.items[0].history.at(-1), { round: 2, actor: "astra", event: astra, status, note: `ruling ${astra}`, evidence: "" });
    }
  });

  test("an unrecognized ruling status leaves the item open", () => {
    const ledger = answered();
    applyAstraRulings(ledger, [rule("R1", "whatever")], 2);
    assert.equal(ledger.items[0].status, "open");
    assert.equal(ledger.items[0].history.at(-1).event, "whatever");
  });

  test("downgraded with new_severity changes severity and logs a severity event first", () => {
    const ledger = answered("reject", ["blocker"]);
    applyAstraRulings(ledger, [rule("R1", "downgraded", { new_severity: "minor" })], 2);
    const item = ledger.items[0];
    assert.equal(item.severity, "minor");
    assert.equal(item.status, "open");
    const [severityEvent, ruling] = item.history.slice(-2);
    assert.deepEqual(severityEvent, { round: 2, actor: "astra", event: "severity", status: "disputed", note: "blocker → minor" });
    assert.equal(ruling.event, "downgraded");
    assert.equal(convergence(ledger).state, "converged", "a downgrade to minor unblocks convergence");
  });

  test("new_severity equal to the current one adds no severity event", () => {
    const ledger = answered("reject", ["major"]);
    applyAstraRulings(ledger, [rule("R1", "downgraded", { new_severity: "major" })], 2);
    assert.ok(!ledger.items[0].history.some((entry) => entry.event === "severity"));
  });

  test("unknown ids are reported and ignored; ids are case-insensitive", () => {
    const ledger = answered("accept", ["major", "major"]);
    const result = applyAstraRulings(ledger, [rule("r1", "fixed_verified"), rule("R2", "fixed_verified"), rule("R7", "maintained")], 2);
    assert.deepEqual(result, { unknown: ["R7"], ignored: [], skipped: [] });
    assert.deepEqual(ledger.items.map((item) => item.status), ["resolved", "resolved"]);
  });

  test("items Claude answered but Astra skipped are reported and NOT auto-resolved", () => {
    const ledger = answered("accept", ["major", "major", "minor"]);
    const result = applyAstraRulings(ledger, [rule("R2", "fixed_verified")], 2);
    assert.deepEqual(result.skipped, ["R1", "R3"]);
    assert.equal(ledger.items[0].status, "addressed");
    assert.deepEqual(pendingForAstra(ledger).map((item) => item.id), ["R1", "R3"]);
    assert.equal(convergence(ledger).state, "needs_reply");
  });

  test("null prior is a no-op that still reports skipped items", () => {
    const ledger = answered();
    assert.deepEqual(applyAstraRulings(ledger, null, 2), { unknown: [], ignored: [], skipped: ["R1"] });
    assert.deepEqual(applyAstraRulings(emptyLedger(), undefined, 1), { unknown: [], ignored: [], skipped: [] });
  });

  test("maintainedStreak counts only maintained-on-disputed and resets otherwise", () => {
    const ledger = answered("reject");
    applyAstraRulings(ledger, [rule("R1", "maintained")], 2);
    assert.equal(ledger.items[0].maintainedStreak, 1);
    applyClaudeResponses(ledger, [respond("R1", "accept")], 3);
    applyAstraRulings(ledger, [rule("R1", "maintained")], 3);
    assert.equal(ledger.items[0].maintainedStreak, 0, "maintained on an accepted item is not a dispute");
    applyClaudeResponses(ledger, [respond("R1", "reject")], 4);
    applyAstraRulings(ledger, [rule("R1", "fix_incomplete")], 4);
    assert.equal(ledger.items[0].maintainedStreak, 0);
  });

  test("rulings on closed items (e.g. user-decided) are ignored, not applied", () => {
    const ledger = reviewLedger(["major", "major"]);
    applyClaudeResponses(ledger, [respond("R1", "user", "the user chose to keep this behaviour"), respond("R2", "accept")], 2);
    const historyBefore = structuredClone(ledger.items[0].history);
    const result = applyAstraRulings(ledger, [rule("R1", "maintained", { new_severity: "blocker" }), rule("R2", "fixed_verified")], 2);
    assert.deepEqual(result, { unknown: [], ignored: ["R1"], skipped: [] });
    assert.equal(ledger.items[0].status, "user_decided");
    assert.equal(ledger.items[0].severity, "major", "no severity change on a closed item either");
    assert.deepEqual(ledger.items[0].history, historyBefore);
    assert.equal(convergence(ledger).state, "converged");

    // A later ruling on an item Astra already resolved is ignored the same way.
    const late = applyAstraRulings(ledger, [rule("r2", "fix_incomplete")], 3);
    assert.deepEqual(late.ignored, ["R2"]);
    assert.equal(ledger.items[1].status, "resolved");
  });
});

describe("ledger.convergence", () => {
  test("empty ledger converges", () => {
    assert.deepEqual(convergence(emptyLedger()), { state: "converged", open: [], blocking: [], deadlocked: [], minorOpen: [] });
  });

  test("only minor items open → converged, reported as minorOpen", () => {
    const ledger = reviewLedger(["minor", "minor"]);
    assert.deepEqual(convergence(ledger), { state: "converged", open: ["R1", "R2"], blocking: [], deadlocked: [], minorOpen: ["R1", "R2"] });
  });

  test("blocker/major open → needs_reply", () => {
    const ledger = reviewLedger(["blocker", "major", "minor"]);
    const conv = convergence(ledger);
    assert.equal(conv.state, "needs_reply");
    assert.deepEqual(conv.blocking, ["R1", "R2"]);
    assert.deepEqual(conv.minorOpen, ["R3"]);
  });

  test("closed statuses do not count as open", () => {
    for (const status of CLOSED) {
      const ledger = reviewLedger(["blocker"]);
      ledger.items[0].status = status;
      assert.equal(convergence(ledger).state, "converged", status);
    }
    assert.deepEqual([...CLOSED].sort(), ["deferred_ok", "resolved", "superseded", "user_decided", "withdrawn"]);
  });

  test("deadlock after two consecutive maintained-on-disputed rounds", () => {
    const ledger = reviewLedger(["major"]);
    applyClaudeResponses(ledger, [respond("R1", "reject")], 2);
    applyAstraRulings(ledger, [rule("R1", "maintained")], 2);
    assert.equal(convergence(ledger).state, "needs_reply");
    applyClaudeResponses(ledger, [respond("R1", "reject")], 3);
    applyAstraRulings(ledger, [rule("R1", "maintained")], 3);
    const conv = convergence(ledger);
    assert.equal(conv.state, "deadlock");
    assert.deepEqual(conv.deadlocked, ["R1"]);
    assert.deepEqual(conv.blocking, ["R1"]);
  });

  test("a non-dispute round in between breaks the streak", () => {
    const ledger = reviewLedger(["major"]);
    applyClaudeResponses(ledger, [respond("R1", "reject")], 2);
    applyAstraRulings(ledger, [rule("R1", "maintained")], 2);
    applyClaudeResponses(ledger, [respond("R1", "partial")], 3);
    applyAstraRulings(ledger, [rule("R1", "fix_incomplete")], 3);
    applyClaudeResponses(ledger, [respond("R1", "reject")], 4);
    applyAstraRulings(ledger, [rule("R1", "maintained")], 4);
    assert.equal(ledger.items[0].maintainedStreak, 1);
    assert.equal(convergence(ledger).state, "needs_reply");
  });

  test("deadlock takes precedence over other blocking items; a minor deadlock does not count", () => {
    const ledger = reviewLedger(["major", "blocker", "minor"]);
    ledger.items[0].maintainedStreak = 2;
    ledger.items[2].maintainedStreak = 5;
    const conv = convergence(ledger);
    assert.equal(conv.state, "deadlock");
    assert.deepEqual(conv.deadlocked, ["R1"]);
  });
});

describe("ledger.pendingForClaude / pendingForAstra", () => {
  const ids = (items) => items.map((item) => item.id);

  test("new items wait for Claude; answered items wait for Astra; closed wait for nobody", () => {
    const ledger = reviewLedger(["major", "major", "minor"]);
    assert.deepEqual(ids(pendingForClaude(ledger)), ["R1", "R2", "R3"]);
    assert.deepEqual(ids(pendingForAstra(ledger)), []);

    applyClaudeResponses(ledger, [respond("R1", "accept"), respond("R2", "user"), respond("R3", "reject")], 2);
    assert.deepEqual(ids(pendingForClaude(ledger)), []);
    assert.deepEqual(ids(pendingForAstra(ledger)), ["R1", "R3"], "user_decided is closed");

    applyAstraRulings(ledger, [rule("R1", "fixed_verified"), rule("R3", "downgraded", { new_severity: "minor" })], 2);
    assert.deepEqual(ids(pendingForClaude(ledger)), ["R3"]);
    assert.deepEqual(ids(pendingForAstra(ledger)), []);
  });

  test("items Astra skipped stay with Astra", () => {
    const ledger = reviewLedger(["major"]);
    applyClaudeResponses(ledger, [respond("R1", "defer")], 2);
    applyAstraRulings(ledger, [], 2);
    assert.deepEqual(ids(pendingForAstra(ledger)), ["R1"]);
    assert.deepEqual(ids(pendingForClaude(ledger)), []);
  });
});

describe("ledger.renderLedger / tally / renderResponsesForAstra / persistence", () => {
  const unescapedPipes = (row) => row.replace(/\\\|/g, "").split("|").length - 1;

  test("empty ledgers render placeholders", () => {
    assert.equal(renderLedger(emptyLedger()), "_(no items)_");
    const ledger = reviewLedger(["major"]);
    ledger.items[0].status = "resolved";
    assert.equal(renderLedger(ledger, { onlyOpen: true }), "_(no open items)_");
  });

  test("pipes are escaped and whitespace flattened so every row keeps 7 separators", () => {
    const ledger = emptyLedger();
    addItems(ledger, "review", [{ severity: "major", title: "a | b\nsecond line", file: "src/x|y.js", line_start: 3 }], 1);
    applyClaudeResponses(ledger, [respond("R1", "reject", "use a || b\n instead")], 2);
    const lines = renderLedger(ledger).split("\n");
    assert.equal(lines[0], "| id | sev | status | title | where | last move |");
    assert.equal(lines[1], "|---|---|---|---|---|---|");
    assert.equal(lines.length, 3);
    const row = lines[2];
    assert.equal(unescapedPipes(row), 7, row);
    assert.ok(row.includes("a \\| b second line"), row);
    assert.ok(row.includes("src/x\\|y.js:3"), row);
    assert.ok(row.includes("claude reject: use a \\|\\| b instead"), row);
    assert.ok(row.startsWith("| R1 | major | disputed |"), row);
  });

  test("long titles are truncated with an ellipsis", () => {
    const ledger = emptyLedger();
    addItems(ledger, "review", [{ severity: "minor", title: "x".repeat(200) }], 1);
    const row = renderLedger(ledger).split("\n")[2];
    const title = row.split(" | ")[3];
    assert.equal(title.length, 90);
    assert.ok(title.endsWith("…"));
  });

  test("onlyOpen hides closed rows", () => {
    const ledger = reviewLedger(["major", "major"]);
    applyClaudeResponses(ledger, [respond("R1", "accept"), respond("R2", "accept")], 2);
    applyAstraRulings(ledger, [rule("R1", "fixed_verified"), rule("R2", "maintained")], 2);
    const text = renderLedger(ledger, { onlyOpen: true });
    assert.ok(!text.includes("| R1 |"));
    assert.ok(text.includes("| R2 |"));
    assert.ok(renderLedger(ledger).includes("| R1 | major | resolved |"));
  });

  test("tally counts statuses and Claude decisions", () => {
    const ledger = reviewLedger(["major", "major", "minor"]);
    applyClaudeResponses(ledger, [respond("R1", "accept"), respond("R2", "reject"), respond("R3", "reject")], 2);
    applyAstraRulings(ledger, [rule("R1", "fixed_verified"), rule("R2", "maintained"), rule("R3", "conceded")], 2);
    assert.deepEqual(tally(ledger), {
      total: 3,
      byStatus: { resolved: 1, open: 1, withdrawn: 1 },
      claudeDecisions: { accept: 1, reject: 2 },
    });
  });

  test("renderResponsesForAstra includes decision, evidence and change lines", () => {
    const ledger = reviewLedger(["major"]);
    const text = renderResponsesForAstra(ledger, [
      { id: "r1", decision: "reject", rationale: " not reachable ", evidence: "grep shows no callers", change_ref: "" },
      { id: "R9", decision: "accept", rationale: "n/a" },
    ]);
    const lines = text.split("\n");
    assert.equal(lines[0], "- R1 (major: finding 1) → **reject**: not reachable");
    assert.equal(lines[1], "  evidence: grep shows no callers");
    assert.equal(lines[2], "- R9 (?: ) → **accept**: n/a");
    assert.equal(lines.length, 3);
  });

  test("writeLedger/readLedger round-trip; missing or corrupt files read as empty", () => {
    const project = tmpDir("ledger-proj");
    assert.deepEqual(readLedger(project, "t1"), emptyLedger());
    const ledger = reviewLedger(["major"]);
    writeLedger(project, "t1", ledger);
    assert.deepEqual(readLedger(project, "t1"), ledger);
    fs.writeFileSync(ledgerPath(project, "t1"), "{ torn");
    assert.deepEqual(readLedger(project, "t1"), emptyLedger());
  });

  test("decision and status vocabularies", () => {
    assert.deepEqual(CLAUDE_DECISIONS, ["accept", "partial", "reject", "defer", "user"]);
    assert.equal(ASTRA_STATUSES.length, 7);
  });
});

// ========================================================================================== prompts.mjs

describe("prompts.detectLang / languageLine / roleContract", () => {
  test("detectLang", () => {
    assert.equal(detectLang("이 변경을 리뷰해줘"), "ko");
    assert.equal(detectLang("Please review src/app.ts — 한글 한 글자"), "ko");
    assert.equal(detectLang("このコードをレビューしてください"), "ja");
    assert.equal(detectLang("変更を確認して"), "ja", "kanji + kana is Japanese");
    assert.equal(detectLang("请审查这个改动"), "zh");
    assert.equal(detectLang("Review this diff"), "en");
    assert.equal(detectLang(""), "en");
    assert.equal(detectLang(null), "en");
    assert.equal(detectLang(undefined), "en");
  });

  test("languageLine names known languages and passes unknown codes through", () => {
    assert.ok(languageLine("ko").startsWith("Write prose in Korean (한국어)."));
    assert.ok(languageLine("en").startsWith("Write prose in English."));
    assert.ok(languageLine("fr").startsWith("Write prose in fr."));
    assert.ok(languageLine("ja").includes("JSON keys/enum values exactly as they are (English)"));
  });

  test("roleContract embeds the language line as rule 9", () => {
    for (const lang of ["ko", "en", "ja", "zh"]) {
      const text = roleContract(lang);
      assert.ok(text.startsWith("<role>"));
      assert.ok(text.trimEnd().endsWith("</rules>"));
      assert.ok(text.includes(`9. ${languageLine(lang)}`), lang);
    }
    assert.ok(roleContract("en").includes("Your sandbox is read-only"));
  });
});

describe("prompts.turnDigest", () => {
  test("round, awaiting ids and language line", () => {
    const text = turnDigest({ phase: "code review", round: 2, maxRounds: 3, awaiting: ["R1", "R3"], lang: "ko" });
    const lines = text.split("\n");
    assert.equal(lines[0], "<turn_digest>");
    assert.equal(lines[1], "phase: code review · round 2/3 · you are the read-only reviewer; Claude edits.");
    assert.ok(lines.includes("Items awaiting your ruling: R1, R3."));
    assert.equal(lines.at(-2), languageLine("ko"));
    assert.equal(lines.at(-1), "</turn_digest>");
  });

  test("no round and no awaiting → neither line", () => {
    const text = turnDigest({ phase: "consultation", lang: "en" });
    assert.ok(text.includes("phase: consultation · you are"));
    assert.ok(!text.includes("round"));
    assert.ok(!text.includes("awaiting your ruling"));
  });
});

describe("prompts.renderAttachments (fence)", () => {
  test("no attachments → empty string", () => {
    assert.equal(renderAttachments([]), "");
    assert.equal(renderAttachments(), "");
  });

  test("plain content is fenced with three backticks; trailing newline not doubled", () => {
    const text = renderAttachments([{ path: "a.md", content: "hello\n" }]);
    assert.equal(text, '<attachments>\n<attachment path="a.md">\n```\nhello\n```\n</attachment>\n</attachments>');
  });

  test("embedded backtick fences get a longer outer fence", () => {
    const inner = "before\n```js\ncode()\n```\nafter";
    const text = renderAttachments([{ path: "x.md", content: inner }]);
    assert.ok(text.includes(`\n\`\`\`\`\n${inner}\n\`\`\`\`\n`), text);

    const five = "`````\nnested\n`````";
    const text5 = renderAttachments([{ path: "y.md", content: five }]);
    assert.ok(text5.includes(`\n\`\`\`\`\`\`\n${five}\n\`\`\`\`\`\`\n`), text5);
  });

  test("inline backticks shorter than three do not lengthen the fence", () => {
    const text = renderAttachments([{ path: "z.md", content: "use `x` and ``y``" }]);
    assert.ok(text.includes("\n```\nuse `x` and ``y``\n```\n"));
  });

  test("oversized attachments are truncated with a pointer to the file", () => {
    const big = "a".repeat(130 * 1024);
    const text = renderAttachments([{ path: "big.txt", content: big }]);
    assert.ok(text.includes("… [truncated — read the full file at big.txt]"));
    assert.ok(text.length < big.length);
  });
});

describe("prompts.reviewTargetBlock", () => {
  const base = { label: "uncommitted changes vs HEAD", diffPath: "/jobs/j1/diff.patch", deltaPath: "/jobs/j1/delta.patch" };

  test("small diff is inlined with stat and file list", () => {
    const diff = "diff --git a/a.js b/a.js\n+hello\n";
    const text = reviewTargetBlock({ ...base, stat: " a.js | 1 +\n", diff, files: ["a.js"] });
    const lines = text.split("\n");
    assert.equal(lines[0], "<review_target>");
    assert.equal(lines[1], "Target: uncommitted changes vs HEAD");
    assert.equal(lines[2], "Snapshot diff file (frozen when this round started): /jobs/j1/diff.patch");
    assert.equal(lines[3], "Changed files (1): a.js");
    assert.ok(text.includes("Stat:\n```\na.js | 1 +\n```"));
    assert.ok(text.includes(`Diff:\n\`\`\`diff\n${diff}\`\`\``));
    assert.equal(lines.at(-1), "</review_target>");
  });

  test("a diff exactly at the limit is inlined; one byte more is not", () => {
    const atLimit = "x".repeat(INLINE_DIFF_LIMIT);
    assert.ok(reviewTargetBlock({ ...base, diff: atLimit }).includes("Diff:\n```diff\n"));
    const tooBig = "x".repeat(INLINE_DIFF_LIMIT + 1);
    const text = reviewTargetBlock({ ...base, diff: tooBig });
    assert.ok(!text.includes(tooBig));
    assert.ok(text.includes("The diff is 80 KB — too large to inline. Read it from the snapshot file"));
  });

  test("delta (re-review): inlined delta replaces the full diff", () => {
    const text = reviewTargetBlock({ ...base, diff: "FULL-DIFF", delta: "DELTA-DIFF\n" });
    assert.ok(text.includes("Changes since your last review round (verify fixes here first):\n```diff\nDELTA-DIFF\n```"));
    assert.ok(text.includes("The full cumulative diff is in the snapshot file above if you need it."));
    assert.ok(!text.includes("FULL-DIFF"));
  });

  test("delta too large → pointer to the delta file", () => {
    const text = reviewTargetBlock({ ...base, diff: "FULL", delta: "d".repeat(INLINE_DIFF_LIMIT + 2048) });
    assert.ok(text.includes("Changes since your last round are 82 KB — read /jobs/j1/delta.patch."));
  });

  test("empty delta → explicit 'no code changed' line", () => {
    const text = reviewTargetBlock({ ...base, diff: "FULL", delta: "" });
    assert.ok(text.includes("No code changed since your last review round."));
  });

  test("no diff at all (paths mode) → review the files as they are", () => {
    const text = reviewTargetBlock({ ...base, diff: "", files: ["src/a.js", "src/b.js"] });
    assert.ok(text.includes("Review the listed files as they are now."));
    assert.ok(text.includes("Changed files (2): src/a.js, src/b.js"));
    assert.ok(!text.includes("Stat:"));
  });

  test("more than 60 files are elided but counted", () => {
    const files = Array.from({ length: 65 }, (_, index) => `f${index}.js`);
    const text = reviewTargetBlock({ ...base, diff: "d", files });
    assert.ok(text.includes("Changed files (65): f0.js,"));
    assert.ok(text.includes("f59.js, …"));
    assert.ok(!text.includes("f60.js"));
  });

  test("a diff containing a markdown fence is fenced longer", () => {
    const diff = "+```js\n+x\n+```\n";
    assert.ok(reviewTargetBlock({ ...base, diff }).includes(`Diff:\n\`\`\`\`diff\n${diff}\`\`\`\``));
  });
});

describe("prompts.build*Prompt", () => {
  const target = { label: "L", diff: "D", diffPath: "/p", files: [] };

  test("first turn carries the full contract; later turns the digest with awaiting ids", () => {
    const first = buildReviewPrompt({ firstTurn: true, lang: "en", round: 1, maxRounds: 3, awaiting: [], target });
    assert.ok(first.startsWith("<role>"));
    assert.ok(first.includes('"prior" must be [] on this first round.'));
    assert.ok(!first.includes("<turn_digest>"));

    const later = buildReviewPrompt({
      firstTurn: false,
      lang: "en",
      round: 2,
      maxRounds: 3,
      awaiting: ["R1"],
      target,
      ledgerText: "LEDGER-TABLE",
      responsesText: "RESPONSES",
      focus: "error paths",
      hasPlan: true,
    });
    assert.ok(later.startsWith("<turn_digest>"));
    assert.ok(later.includes("Items awaiting your ruling: R1."));
    assert.ok(later.includes("Round 2. Claude answered your findings"));
    assert.ok(later.includes("accepted_deferral Claude's deferral"));
    assert.ok(later.includes("<claude_responses>\nRESPONSES\n</claude_responses>"));
    assert.ok(later.includes("LEDGER-TABLE\n</ledger>"));
    assert.ok(later.includes("Focus requested for this review: error paths"));
    assert.ok(later.includes('category "plan_deviation"'));
    assert.ok(later.endsWith("</review_target>\n"));
  });

  test("plan prompt round 1 vs round 2", () => {
    const r1 = buildPlanPrompt({ firstTurn: true, lang: "ko", round: 1, maxRounds: 2, awaiting: [], message: "PLAN" });
    assert.ok(r1.includes("wants your critique BEFORE any code is written"));
    assert.ok(r1.includes("<claude_message>\nPLAN\n</claude_message>"));
    const r2 = buildPlanPrompt({ firstTurn: false, lang: "ko", round: 2, maxRounds: 2, awaiting: ["P1"], message: "PLAN v2" });
    assert.ok(r2.includes("Round 2. Claude revised the plan"));
    assert.ok(r2.includes("round 2/2"));
  });

  test("ask prompt drops empty message blocks", () => {
    const text = buildAskPrompt({ firstTurn: false, lang: "en", message: "   ", attachments: [] });
    assert.ok(!text.includes("<claude_message>"));
    assert.ok(!text.includes("<attachments>"));
    assert.ok(text.includes("phase: consultation"));
  });

  test("debate cross prompt omits an empty critique block", () => {
    const text = buildDebateCrossPrompt({ lang: "en", claudeProposal: "P", claudeCritique: "" });
    assert.ok(text.includes("<claude_proposal"));
    assert.ok(!text.includes("<claude_critique_of_your_proposal>"));
  });
});

// =========================================================================================== events.mjs

describe("events.LineBuffer", () => {
  test("holds partial lines until the newline arrives", () => {
    const buffer = new LineBuffer();
    assert.deepEqual(buffer.push('{"a":'), []);
    assert.deepEqual(buffer.push('1}\n{"b":2}\n{"c"'), ['{"a":1}', '{"b":2}']);
    assert.deepEqual(buffer.push(":3}\n"), ['{"c":3}']);
    assert.deepEqual(buffer.flush(), []);
  });

  test("blank lines are dropped; flush returns the trimmed remainder once", () => {
    const buffer = new LineBuffer();
    assert.deepEqual(buffer.push("\n\n  \nx\n\ny"), ["x"]);
    assert.deepEqual(buffer.flush(), ["y"]);
    assert.deepEqual(buffer.flush(), []);
  });

  test("CRLF lines keep the CR but still parse as JSON", () => {
    const buffer = new LineBuffer();
    const [line] = buffer.push('{"type":"turn.started"}\r\n');
    assert.equal(parseEventLine(line).type, "turn.started");
  });
});

describe("events.parseEventLine / extractErrorMessage", () => {
  test("parseEventLine accepts only objects with a string type", () => {
    assert.deepEqual(parseEventLine('{"type":"x","a":1}'), { type: "x", a: 1 });
    for (const bad of ["not json", '{"a":1}', '{"type":3}', "[1,2]", "null", "42", '"s"']) {
      assert.equal(parseEventLine(bad), null, bad);
    }
  });

  test("extractErrorMessage digs through nested JSON", () => {
    const nested = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "inner message" } });
    assert.equal(extractErrorMessage(nested), "inner message");
    assert.equal(extractErrorMessage({ message: nested }), "inner message");
    assert.equal(extractErrorMessage(JSON.stringify({ message: "top-level message" })), "top-level message");
    assert.equal(extractErrorMessage({ error: { message: "no top-level message" } }), "no top-level message");
    assert.equal(extractErrorMessage("plain text"), "plain text");
    assert.equal(extractErrorMessage({ message: "plain in object" }), "plain in object");
    assert.equal(extractErrorMessage("42"), "42");
  });
});

describe("events.classifyError", () => {
  const cases = [
    ["The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade.", "codex_outdated"],
    ["You've hit your usage limit. Try again later.", "usage_limit"],
    ["Rate limit reached for requests", "usage_limit"],
    ["429 Too Many Requests", "usage_limit"],
    ["quota exceeded", "usage_limit"],
    ["Not logged in", "auth"],
    ["401 Unauthorized", "auth"],
    ["request unauthorised", "auth"],
    ["Authentication failed", "auth"],
    ["refresh token expired", "auth"],
    ["model 'gpt-9' not found", "model"],
    ["The requested model does not exist", "model"],
    ["unsupported model: foo", "model"],
    ["stream disconnected before completion", "codex_error"],
    ["used 14290 tokens", "codex_error"],
    ["error 4011 happened", "codex_error"],
    ["", "codex_error"],
  ];
  for (const [message, code] of cases) {
    test(`${JSON.stringify(message)} → ${code}`, () => {
      const result = classifyError(message);
      assert.equal(result.code, code);
      if (code === "codex_error") assert.equal(result.hint, null);
      else assert.ok(typeof result.hint === "string" && result.hint.length > 20);
    });
  }

  test("null/undefined → codex_error", () => {
    assert.equal(classifyError(undefined).code, "codex_error");
    assert.equal(classifyError(null).code, "codex_error");
  });

  test("outdated wins over the generic model rule", () => {
    assert.equal(classifyError("model gpt-6-astra not supported: requires a newer version of Codex").code, "codex_outdated");
  });
});

describe("events.createEventFolder", () => {
  function fold(events) {
    const progress = [];
    const { state, fold: f } = createEventFolder({ onProgress: (line) => progress.push(line) });
    for (const event of events) f(event);
    return { state, progress };
  }

  test("happy path: session id, commands, messages, usage; config noise filtered", () => {
    const { state, progress } = fold([
      { type: "thread.started", thread_id: "sess-1" },
      { type: "item.completed", item: { type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } },
      { type: "item.completed", item: { type: "error", message: "Skill descriptions were shortened to fit" } },
      { type: "item.completed", item: { type: "error", message: "Model metadata for `gpt-6-astra` not found" } },
      { type: "turn.started" },
      { type: "item.started", item: { type: "command_execution", command: "/bin/zsh -lc 'git status --short'" } },
      { type: "item.started", item: { type: "command_execution", command: "rg foo" } },
      { type: "item.completed", item: { type: "agent_message", text: "final answer" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } },
      { type: "some.future.event" },
    ]);
    assert.equal(state.sessionId, "sess-1");
    assert.equal(state.commands, 2);
    assert.deepEqual(state.messages, ["final answer"]);
    assert.deepEqual(state.usage, { input_tokens: 10, output_tokens: 2 });
    assert.equal(state.completed, true);
    assert.equal(state.failed, false);
    assert.deepEqual(state.errors, []);
    assert.deepEqual(progress, ["Astra is thinking…", "$ git status --short", "$ rg foo", "💬 final answer"]);
  });

  test("real item errors are kept and shown; top-level errors are logged but not shown", () => {
    const { state, progress } = fold([
      { type: "item.completed", item: { type: "error", message: "sandbox denied write" } },
      { type: "error", message: "Reconnecting... 1/5 (stream disconnected)" },
      { type: "error", message: JSON.stringify({ error: { message: "nested transient" } }) },
    ]);
    assert.deepEqual(state.errors, ["sandbox denied write", "Reconnecting... 1/5 (stream disconnected)", "nested transient"]);
    assert.deepEqual(progress, ["⚠ sandbox denied write"]);
  });

  test("turn.failed records the extracted failure", () => {
    const inner = "The 'gpt-6-astra' model requires a newer version of Codex.";
    const message = JSON.stringify({ type: "error", status: 400, error: { message: inner } });
    const { state, progress } = fold([{ type: "thread.started", thread_id: "s" }, { type: "turn.failed", error: { message } }]);
    assert.equal(state.failed, true);
    assert.equal(state.failure, inner);
    assert.equal(state.completed, false);
    assert.equal(progress.at(-1), `✖ ${inner}`);
  });

  test("progress lines are clipped and other item types are summarised", () => {
    const { progress } = fold([
      { type: "item.completed", item: { type: "agent_message", text: "y".repeat(500) } },
      { type: "item.completed", item: { type: "web_search", query: "node test runner todo" } },
      { type: "item.completed", item: { type: "file_change" } },
      { type: "item.completed" },
      { type: "item.started" },
    ]);
    assert.equal(progress[0].length, "💬 ".length + 110);
    assert.ok(progress[0].endsWith("…"));
    assert.equal(progress[1], "🔎 node test runner todo");
    assert.ok(progress[2].startsWith("✎"));
    assert.equal(progress.length, 3);
  });

  test("folds the fake-codex fixture output (ok / outdated / reconnect)", () => {
    const runFake = (mode) => {
      const result = spawnSync(process.execPath, [FAKE_CODEX, "exec", "--json", "-"], {
        input: "hello astra",
        encoding: "utf8",
        env: { ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_REPLY: "REPLY" },
      });
      const { state, fold: f } = createEventFolder();
      const buffer = new LineBuffer();
      for (const line of [...buffer.push(result.stdout), ...buffer.flush()]) {
        const event = parseEventLine(line);
        if (event) f(event);
      }
      return { state, status: result.status };
    };
    const ok = runFake("ok");
    assert.equal(ok.status, 0);
    assert.ok(ok.state.sessionId);
    assert.equal(ok.state.completed, true);
    assert.deepEqual(ok.state.messages, ["REPLY"]);
    assert.deepEqual(ok.state.errors, [], "the unrecognized-config warning is noise");

    const outdated = runFake("outdated");
    assert.equal(outdated.status, 1);
    assert.equal(outdated.state.failed, true);
    assert.equal(classifyError(outdated.state.failure).code, "codex_outdated");

    const reconnect = runFake("reconnect");
    assert.equal(reconnect.state.completed, true);
    assert.equal(reconnect.state.errors.filter((line) => /Reconnecting/.test(line)).length, 3);
  });
});

// ============================================================================================= jobs.mjs

describe("jobs.classifyOutcome precedence", () => {
  const folded = (patch = {}) => ({ sessionId: "sess", completed: true, failed: false, failure: null, ...patch });
  const ok = { code: 0, signal: null };
  const classify = (patch) => classifyOutcome({ result: ok, folded: folded(), lastText: "answer", stopReason: null, stderrText: "", expectJson: false, ...patch });

  test("rule 1: completed + exit 0 + final message → succeeded", () => {
    assert.deepEqual(classify({}), { state: "succeeded" });
    assert.deepEqual(classify({ lastText: "" }), { state: "succeeded" });
    assert.deepEqual(classify({ expectJson: true, lastText: '{"verdict":"approve"}' }), { state: "succeeded" });
  });

  test("rule 1: a cancel or timeout that lands after completion still counts as succeeded", () => {
    assert.equal(classify({ stopReason: "cancel" }).state, "succeeded");
    assert.equal(classify({ stopReason: "timeout" }).state, "succeeded");
    assert.equal(classify({ stderrText: "no rollout found" }).state, "succeeded");
  });

  test("rule 2: completed but structured output does not parse → invalid_output (beats a late cancel)", () => {
    const outcome = classify({ expectJson: true, lastText: "not json {" });
    assert.equal(outcome.state, "invalid_output");
    assert.match(outcome.error, /structured output did not parse/);
    assert.equal(classify({ expectJson: true, lastText: "" }).state, "invalid_output");
    assert.equal(classify({ expectJson: true, lastText: "{", stopReason: "cancel" }).state, "invalid_output");
  });

  test("rule 3: cancelled before completion; deliveryUnknown iff a session exists", () => {
    const withSession = classify({ folded: folded({ completed: false }), result: { code: null, signal: "SIGINT" }, lastText: null, stopReason: "cancel" });
    assert.deepEqual(withSession, { state: "cancelled", deliveryUnknown: true });
    const noSession = classify({ folded: folded({ completed: false, sessionId: null }), result: { code: 1, signal: null }, lastText: null, stopReason: "cancel" });
    assert.deepEqual(noSession, { state: "cancelled", deliveryUnknown: false });
  });

  test("rule 3 beats session_lost and failed", () => {
    const outcome = classify({
      folded: folded({ completed: false, failed: true, failure: "boom" }),
      result: { code: 1, signal: null },
      lastText: null,
      stopReason: "cancel",
      stderrText: "no rollout found",
    });
    assert.equal(outcome.state, "cancelled");
  });

  test("rule 4: timed out", () => {
    const outcome = classify({ folded: folded({ completed: false }), result: { code: null, signal: "SIGKILL" }, lastText: null, stopReason: "timeout" });
    assert.deepEqual(outcome, { state: "timed_out", deliveryUnknown: true });
  });

  test("rule 5: 'no rollout found' on stderr → session_lost (case-insensitive, beats turn.failed)", () => {
    const outcome = classify({
      folded: folded({ completed: false, sessionId: null }),
      result: { code: 1, signal: null },
      lastText: null,
      stderrText: "Error: thread/resume failed: No Rollout Found for thread id abc (code -32600)",
    });
    assert.equal(outcome.state, "session_lost");
    assert.match(outcome.error, /no longer has this session/);
    const failedToo = classify({ folded: folded({ completed: false, failed: true, failure: "x" }), result: { code: 1 }, lastText: null, stderrText: "no rollout found" });
    assert.equal(failedToo.state, "session_lost");
  });

  test("rule 6: turn.failed → failed with message, error code and hint", () => {
    const outcome = classify({ folded: folded({ completed: false, failed: true, failure: "stream disconnected" }), result: { code: 1, signal: null }, lastText: null });
    assert.deepEqual(outcome, { state: "failed", error: "stream disconnected", deliveryUnknown: true, errorCode: "codex_error" });

    const outdated = classify({
      folded: folded({ completed: false, failed: true, failure: "requires a newer version of Codex" }),
      result: { code: 1, signal: null },
      lastText: null,
    });
    assert.equal(outdated.errorCode, "codex_outdated");
    assert.match(outdated.hint, /Upgrade/);

    const noMessage = classify({ folded: folded({ completed: false, failed: true, failure: null }), result: { code: 1 }, lastText: null });
    assert.equal(noMessage.error, "turn failed");
  });

  test("rule 6: turn.completed AND turn.failed with exit 0 is still a failure", () => {
    const outcome = classify({ folded: folded({ completed: true, failed: true, failure: "late failure" }) });
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.deliveryUnknown, false);
  });

  test("rule 7: no session + nonzero exit → start_failed, stderr noise filtered to the last 6 lines", () => {
    const stderrText = [
      "rmcp::transport noise",
      "responses_websocket: reconnect",
      "Reading additional input from stdin...",
      ...Array.from({ length: 8 }, (_, index) => `line ${index + 1}`),
      "",
    ].join("\n");
    const outcome = classify({ folded: folded({ completed: false, sessionId: null }), result: { code: 2, signal: null }, lastText: null, stderrText });
    assert.equal(outcome.state, "start_failed");
    assert.equal(outcome.error, ["line 3", "line 4", "line 5", "line 6", "line 7", "line 8"].join("\n"));
    assert.equal(outcome.errorCode, "codex_error");
  });

  test("rule 7: spawn error message wins; empty stderr falls back to the exit code/signal; auth hint", () => {
    const spawnError = classify({
      folded: folded({ completed: false, sessionId: null }),
      result: { code: null, signal: null, error: new Error("spawn codex ENOENT") },
      lastText: null,
      stderrText: "ignored",
    });
    assert.deepEqual([spawnError.state, spawnError.error], ["start_failed", "spawn codex ENOENT"]);
    const bare = classify({ folded: folded({ completed: false, sessionId: null }), result: { code: 3, signal: null }, lastText: null });
    assert.equal(bare.error, "codex exited with 3");
    const killed = classify({ folded: folded({ completed: false, sessionId: null }), result: { code: null, signal: "SIGKILL" }, lastText: null });
    assert.deepEqual([killed.state, killed.error], ["start_failed", "codex exited with SIGKILL"], "killed by a signal before any session counts as nonzero");
    const auth = classify({ folded: folded({ completed: false, sessionId: null }), result: { code: 1, signal: null }, lastText: null, stderrText: "Error: Not logged in" });
    assert.equal(auth.errorCode, "auth");
    assert.match(auth.hint, /codex login/);
  });

  test("rule 8: everything else → crashed", () => {
    const midTurn = classify({ folded: folded({ completed: false }), result: { code: 1, signal: null }, lastText: null });
    assert.deepEqual(midTurn, { state: "crashed", error: "codex exited with 1 before finishing the turn", deliveryUnknown: true });
    const noSessionExit0 = classify({ folded: folded({ completed: false, sessionId: null }), result: { code: 0, signal: null }, lastText: null });
    assert.equal(noSessionExit0.state, "crashed");
    const noLastMessage = classify({ lastText: null });
    assert.equal(noLastMessage.state, "crashed");
    assert.equal(noLastMessage.deliveryUnknown, false);
  });

  test("end-to-end with the fake-codex fixture", () => {
    const dir = tmpDir("fake-run");
    const runFake = ({ mode, resume = false, schema = false, json }) => {
      const last = path.join(dir, `last-${mode}-${resume}-${schema}.txt`);
      const args = resume ? ["exec", "resume", "--json", "-o", last, "SESSION-X", "-"] : ["exec", "--json", "-o", last, "-"];
      if (schema) args.splice(2, 0, "--output-schema", path.join(dir, "schema.json"));
      const env = { ...process.env, FAKE_CODEX_MODE: mode };
      if (json !== undefined) env.FAKE_CODEX_JSON = json;
      const result = spawnSync(process.execPath, [FAKE_CODEX, ...args], { input: "prompt", encoding: "utf8", env });
      const { state, fold } = createEventFolder();
      for (const line of result.stdout.split("\n")) {
        const event = parseEventLine(line);
        if (event) fold(event);
      }
      return classifyOutcome({
        result: { code: result.status, signal: result.signal },
        folded: state,
        lastText: fs.existsSync(last) ? fs.readFileSync(last, "utf8") : null,
        stopReason: null,
        stderrText: result.stderr,
        expectJson: schema,
      }).state;
    };
    assert.equal(runFake({ mode: "ok" }), "succeeded");
    assert.equal(runFake({ mode: "ok", schema: true, json: '{"verdict":"approve"}' }), "succeeded");
    assert.equal(runFake({ mode: "ok", schema: true, json: "{broken" }), "invalid_output");
    assert.equal(runFake({ mode: "fail" }), "failed");
    assert.equal(runFake({ mode: "outdated" }), "failed");
    assert.equal(runFake({ mode: "lost", resume: true }), "session_lost");
    assert.equal(runFake({ mode: "nojson" }), "crashed");
    assert.equal(runFake({ mode: "reconnect" }), "succeeded");
  });
});

describe("jobs.createTail", () => {
  test("folds events incrementally, including a multibyte char split across writes", () => {
    const dir = tmpDir("tail");
    const file = path.join(dir, "events.jsonl");
    const progress = [];
    const tail = createTail(file, { onProgress: (line) => progress.push(line) });
    tail.pump(); // missing file is a no-op
    assert.equal(tail.offset, 0);

    const line = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "안녕하세요" } })}\n`;
    const bytes = Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: "T1" })}\n${line}`);
    const cut = bytes.indexOf(Buffer.from("녕")) + 1; // split inside a 3-byte UTF-8 sequence
    fs.writeFileSync(file, bytes.subarray(0, cut));
    tail.pump();
    assert.equal(tail.state.sessionId, "T1");
    assert.deepEqual(tail.state.messages, []);
    fs.appendFileSync(file, bytes.subarray(cut));
    tail.pump();
    assert.deepEqual(tail.state.messages, ["안녕하세요"]);
    assert.equal(tail.offset, bytes.length);

    fs.appendFileSync(file, JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }));
    tail.pump();
    assert.equal(tail.state.completed, false, "no newline yet");
    tail.finish();
    assert.equal(tail.state.completed, true);
    assert.deepEqual(progress, ["💬 안녕하세요"]);
  });

  test("fromOffset skips events already shown", () => {
    const dir = tmpDir("tail-offset");
    const file = path.join(dir, "events.jsonl");
    const first = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "one" } })}\n`;
    const second = `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "two" } })}\n`;
    fs.writeFileSync(file, first + second);
    const tail = createTail(file, { fromOffset: Buffer.byteLength(first) });
    tail.pump();
    assert.deepEqual(tail.state.messages, ["two"]);
  });
});

describe("jobs.writeStatus / readStatus / reconcile", () => {
  test("writeStatus merges patches and stamps updatedAt; readStatus hides corrupt files", () => {
    const project = tmpDir("status");
    const jobId = newJobId("ask");
    writeStatus(project, jobId, { state: "created", launcherPid: 1 });
    const next = writeStatus(project, jobId, { state: "running", codexPid: 2 });
    assert.equal(next.state, "running");
    assert.equal(next.launcherPid, 1);
    assert.equal(next.codexPid, 2);
    assert.ok(Date.parse(next.updatedAt));
    assert.deepEqual(readStatus(project, jobId), next);
    fs.writeFileSync(jobPaths(project, jobId).status, "{");
    assert.equal(readStatus(project, jobId), null);
    assert.equal(readStatus(project, newJobId("ask")), null);
  });

  test("a job whose supervisor vanished is marked interrupted and its lock released", async () => {
    const project = tmpDir("reconcile");
    const jobId = newJobId("review");
    writeJsonAtomic(jobPaths(project, jobId).meta, { jobId, thread: "rv" });
    acquireThreadLock(project, "rv", { jobId, launcherPid: process.pid });
    writeStatus(project, jobId, { state: "running", supervisorPid: await deadPid(), startedAt: new Date().toISOString(), sessionId: "S" });
    const status = reconcile(project, jobId);
    assert.equal(status.state, "interrupted");
    assert.equal(status.deliveryUnknown, true);
    assert.equal(readLock(project, "rv"), null);
  });

  test("live supervisors, terminal jobs and fresh 'created' jobs are left alone", async () => {
    const project = tmpDir("reconcile-live");
    const jobId = newJobId("review");
    const child = await spawnMarked(jobId);
    try {
      writeStatus(project, jobId, { state: "running", supervisorPid: child.pid, startedAt: new Date().toISOString() });
      assert.equal(reconcile(project, jobId).state, "running");
    } finally {
      await killChild(child);
    }
    const done = newJobId("ask");
    writeStatus(project, done, { state: "succeeded" });
    assert.equal(reconcile(project, done).state, "succeeded");
    const fresh = newJobId("ask");
    writeStatus(project, fresh, { state: "created", launcherPid: process.pid });
    assert.equal(reconcile(project, fresh).state, "created");
    assert.equal(reconcile(project, newJobId("ask")), null);
  });

  test("a job never acknowledged after the startup grace is interrupted unless a live supervisor claimed the ack", async () => {
    const project = tmpDir("reconcile-ack");
    const old = new Date(Date.now() - 60000).toISOString();
    const unacked = (jobId) => writeJsonAtomic(jobPaths(project, jobId).status, { state: "created", launcherPid: 999999, updatedAt: old });
    const ackFile = (jobId) => path.join(jobPaths(project, jobId).dir, "ack");

    const orphan = newJobId("ask");
    unacked(orphan);
    assert.equal(reconcile(project, orphan).state, "interrupted");
    assert.match(fs.readFileSync(ackFile(orphan), "utf8"), /^reconcile /, "reconcile claims the ack so a late supervisor cannot start");

    const acked = newJobId("ask");
    unacked(acked);
    const supervisor = await spawnMarked(acked);
    try {
      fs.writeFileSync(ackFile(acked), `supervisor ${supervisor.pid} ${old}\n`);
      assert.equal(reconcile(project, acked).state, "created", "a live supervisor won the handshake; leave the job alone");
    } finally {
      await killChild(supervisor);
    }
    assert.equal(reconcile(project, acked).state, "interrupted", "that supervisor died before recording its pid");
  });
});

// ============================================================================================== git.mjs

describe("git.snapshotTree", () => {
  test("includes untracked files, respects .gitignore, drops deleted files", () => {
    const repo = makeRepo();
    put(repo, ".gitignore", "*.log\nbuild/\n");
    put(repo, "tracked.txt", "v1\n");
    put(repo, "gone.txt", "bye\n");
    commitAll(repo, "init");
    put(repo, "tracked.txt", "v2\n");
    put(repo, "untracked.txt", "new\n");
    put(repo, "nested/deep/file.js", "x\n");
    put(repo, "debug.log", "ignored\n");
    put(repo, "build/out.js", "ignored\n");
    fs.rmSync(path.join(repo, "gone.txt"));
    const tree = snapshotTree(repo);
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.deepEqual(treeFiles(repo, tree), [".gitignore", "nested/deep/file.js", "tracked.txt", "untracked.txt"]);
    assert.equal(g(repo, "cat-file", "-p", `${tree}:tracked.txt`), "v2");
  });

  test("leaves .git/index byte-identical (and git status unchanged) with staged + unstaged + untracked changes", () => {
    const repo = makeRepo();
    put(repo, "a.txt", "a\n");
    put(repo, "b.txt", "b\n");
    commitAll(repo, "init");
    put(repo, "a.txt", "a staged\n");
    g(repo, "add", "a.txt");
    put(repo, "b.txt", "b unstaged\n");
    put(repo, "c.txt", "c untracked\n");
    const indexFile = path.join(repo, ".git", "index");
    // `git status` itself may refresh the index, so read status (without optional locks) first.
    const status = () => run(repo, "git", ["--no-optional-locks", "status", "--porcelain"]);
    const statusBefore = status();
    const before = fs.readFileSync(indexFile);
    const beforeStat = fs.statSync(indexFile);
    const tree = snapshotTree(repo);
    assert.ok(fs.readFileSync(indexFile).equals(before), "index bytes changed");
    assert.equal(fs.statSync(indexFile).mtimeMs, beforeStat.mtimeMs, "index was rewritten");
    assert.equal(fs.statSync(indexFile).ino, beforeStat.ino, "index was replaced");
    assert.equal(status(), statusBefore);
    assert.ok(statusBefore.includes("?? c.txt"));
    assert.deepEqual(treeFiles(repo, tree), ["a.txt", "b.txt", "c.txt"]);
    assert.ok(!fs.existsSync(path.join(repo, ".git", "index.lock")));
  });

  test("works in a repo with no commits and no index, without creating one", () => {
    const repo = makeRepo("empty");
    put(repo, "first.txt", "hello\n");
    const indexFile = path.join(repo, ".git", "index");
    assert.ok(!fs.existsSync(indexFile));
    const tree = snapshotTree(repo);
    assert.deepEqual(treeFiles(repo, tree), ["first.txt"]);
    assert.ok(!fs.existsSync(indexFile), "snapshot must not create the real index");
  });

  test("is deterministic, changes with content, and works from a subdirectory", () => {
    const repo = makeRepo();
    put(repo, "top.txt", "1\n");
    put(repo, "sub/inner.txt", "2\n");
    commitAll(repo, "init");
    const a = snapshotTree(repo);
    const b = snapshotTree(path.join(repo, "sub"));
    assert.equal(a, b);
    assert.equal(a, g(repo, "rev-parse", "HEAD^{tree}"), "clean tree snapshot equals HEAD's tree");
    put(repo, "top.txt", "changed\n");
    assert.notEqual(snapshotTree(repo), a);
  });

  test("cleans up its temporary index file", () => {
    const repo = makeRepo();
    put(repo, "a.txt", "a\n");
    snapshotTree(repo);
    const leftovers = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`coworker-index-${process.pid}-`));
    assert.deepEqual(leftovers, []);
  });

  test("never includes the plugin's own .coworker state directory", () => {
    const repo = makeRepo();
    put(repo, "a.txt", "a\n");
    ensureStateDir(repo);
    put(repo, ".coworker/jobs/j1/diff.patch", "secret-ish\n");
    put(repo, ".coworker/work/review/responses.json", "[]\n");
    put(repo, ".coworker/config.json", "{}\n");
    assert.deepEqual(treeFiles(repo, snapshotTree(repo)), ["a.txt"]);
  });
});

describe("git.resolveTarget / diffBetween", () => {
  function history() {
    const repo = makeRepo("hist");
    put(repo, "a.txt", "base\n");
    const c1 = commitAll(repo, "c1");
    g(repo, "checkout", "-q", "-b", "feat");
    put(repo, "a.txt", "feature\n");
    put(repo, "b.txt", "added on feat\n");
    const c2 = commitAll(repo, "c2");
    g(repo, "checkout", "-q", "main");
    put(repo, "main-only.txt", "main moved on\n");
    const c3 = commitAll(repo, "c3");
    g(repo, "checkout", "-q", "feat");
    return { repo, c1, c2, c3 };
  }

  test("uncommitted: base = HEAD, head = live snapshot incl. untracked", () => {
    const { repo, c2 } = history();
    put(repo, "a.txt", "feature + wip\n");
    put(repo, "wip.txt", "untracked\n");
    const target = resolveTarget(repo, { mode: "uncommitted" });
    assert.equal(target.mode, "uncommitted");
    assert.equal(target.base, c2);
    assert.equal(target.head, snapshotTree(repo));
    assert.equal(target.live, true);
    assert.deepEqual(target.paths, []);
    assert.match(target.label, /uncommitted changes vs HEAD/);
    const diff = diffBetween(repo, target.base, target.head);
    assert.match(diff, /\+feature \+ wip/);
    assert.match(diff, /wip\.txt/);
    assert.ok(!diff.includes("b.txt"), "committed changes are not part of the uncommitted target");
  });

  test("uncommitted in a repo with no commits diffs against the empty tree", () => {
    const repo = makeRepo("nocommit");
    put(repo, "hello.txt", "hi\n");
    const target = resolveTarget(repo, { mode: "uncommitted" });
    assert.equal(target.base, EMPTY_TREE);
    const diff = diffBetween(repo, target.base, target.head);
    assert.match(diff, /new file mode/);
    assert.match(diff, /\+hi/);
    assert.deepEqual(changedFiles(repo, target.base, target.head), ["hello.txt"]);
  });

  test("base: merge-base with the ref, includes branch commits + uncommitted, excludes the ref's own progress", () => {
    const { repo, c1 } = history();
    put(repo, "wip.txt", "uncommitted\n");
    const target = resolveTarget(repo, { mode: "base", ref: "main" });
    assert.equal(target.base, c1);
    assert.equal(target.live, true);
    assert.match(target.label, /^everything since main \(merge-base [0-9a-f]{12}\)/);
    const files = changedFiles(repo, target.base, target.head);
    assert.deepEqual(files.sort(), ["a.txt", "b.txt", "wip.txt"]);
    assert.ok(!files.includes("main-only.txt"));
  });

  test("base: unknown ref → clear error", () => {
    const { repo } = history();
    assert.throws(() => resolveTarget(repo, { mode: "base", ref: "no-such-branch" }), /Cannot find a merge-base between HEAD and "no-such-branch"/);
  });

  test("commit: diff against the first parent; root commit against the empty tree; short sha accepted", () => {
    const { repo, c1, c2 } = history();
    const target = resolveTarget(repo, { mode: "commit", sha: c2.slice(0, 8) });
    assert.equal(target.head, c2);
    assert.equal(target.base, c1);
    assert.equal(target.live, false);
    assert.equal(target.label, `commit ${c2.slice(0, 12)} vs its first parent`);
    assert.deepEqual(changedFiles(repo, target.base, target.head).sort(), ["a.txt", "b.txt"]);

    const root = resolveTarget(repo, { mode: "commit", sha: c1 });
    assert.equal(root.base, EMPTY_TREE);
    assert.deepEqual(changedFiles(repo, root.base, root.head), ["a.txt"]);
  });

  test("commit: a merge commit is compared with its first parent", () => {
    const { repo, c2 } = history();
    g(repo, "merge", "-q", "--no-ff", "--no-edit", "main");
    const merge = g(repo, "rev-parse", "HEAD");
    const target = resolveTarget(repo, { mode: "commit", sha: merge });
    assert.equal(target.base, c2);
    assert.deepEqual(changedFiles(repo, target.base, target.head), ["main-only.txt"]);
  });

  test("commit: unknown sha throws", () => {
    const { repo } = history();
    assert.throws(() => resolveTarget(repo, { mode: "commit", sha: "deadbeefdeadbeef" }), /rev-parse/);
  });

  test("paths mode needs no git; other modes outside git fail clearly", () => {
    const repo = makeRepo();
    assert.deepEqual(resolveTarget(repo, { mode: "paths", paths: ["src", "README.md"] }), {
      mode: "paths",
      label: "files: src, README.md",
      base: null,
      head: null,
      live: false,
      paths: ["src", "README.md"],
    });
    const plain = tmpDir("not-git");
    assert.equal(resolveTarget(plain, { mode: "paths", paths: ["x"] }).mode, "paths");
    assert.throws(() => resolveTarget(plain, { mode: "uncommitted" }), /Not a git repository/);
    assert.throws(() => resolveTarget(plain, { mode: "base", ref: "main" }), /Not a git repository/);
  });

  test("paths filter is carried through and restricts diffs", () => {
    const { repo } = history();
    put(repo, "a.txt", "wip a\n");
    put(repo, "other/c.txt", "wip c\n");
    const target = resolveTarget(repo, { mode: "uncommitted", paths: ["other"] });
    assert.deepEqual(target.paths, ["other"]);
    const diff = diffBetween(repo, target.base, target.head, target.paths);
    assert.match(diff, /other\/c\.txt/);
    assert.ok(!diff.includes("a.txt"));
    assert.match(diffStat(repo, target.base, target.head, target.paths), /other\/c\.txt/);
  });

  test("diffBetween: identical trees → empty; renames detected", () => {
    const repo = makeRepo();
    put(repo, "long.txt", Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") + "\n");
    const head = commitAll(repo, "init");
    assert.equal(diffBetween(repo, head, head), "");
    fs.renameSync(path.join(repo, "long.txt"), path.join(repo, "renamed.txt"));
    const target = resolveTarget(repo, { mode: "uncommitted" });
    const diff = diffBetween(repo, target.base, target.head);
    assert.match(diff, /rename from long\.txt/);
    assert.match(diff, /rename to renamed\.txt/);
  });

  test("changedFiles returns real paths for non-ASCII file names and names with spaces", () => {
    const repo = makeRepo("unicode");
    put(repo, "한글.txt", "hi\n");
    put(repo, "한글 공백/my file.txt", "hi\n");
    const target = resolveTarget(repo, { mode: "uncommitted" });
    assert.deepEqual(changedFiles(repo, target.base, target.head).sort(), ["한글 공백/my file.txt", "한글.txt"]);
    assert.match(diffBetween(repo, target.base, target.head), /b\/한글\.txt/);
  });

  test(
    "changedFiles returns real paths for names containing a double quote or backslash",
    () => {
      const repo = makeRepo("quoted");
      put(repo, 'a"b.txt', "x\n");
      put(repo, "back\\slash.txt", "x\n");
      const target = resolveTarget(repo, { mode: "uncommitted" });
      assert.deepEqual(changedFiles(repo, target.base, target.head).sort(), ['a"b.txt', "back\\slash.txt"]);
    },
  );

  test("SHA-256 repositories: empty tree, uncommitted review with no commits, root commit review", () => {
    const repo = tmpDir("sha256");
    const init = spawnSync("git", ["init", "-q", "-b", "main", "--object-format=sha256"], { cwd: repo, env: process.env });
    if (init.status !== 0) return; // git without sha256 support: nothing to test
    assert.match(emptyTree(repo), /^[0-9a-f]{64}$/);
    put(repo, "a.txt", "a\n");
    const target = resolveTarget(repo, { mode: "uncommitted" });
    assert.equal(target.base, emptyTree(repo));
    assert.match(target.head, /^[0-9a-f]{64}$/);
    assert.match(diffBetween(repo, target.base, target.head), /\+a/);
    const root = commitAll(repo, "root");
    const commit = resolveTarget(repo, { mode: "commit", sha: root });
    assert.equal(commit.base, emptyTree(repo));
    assert.deepEqual(changedFiles(repo, commit.base, commit.head), ["a.txt"]);
  });

  test("emptyTree is the well-known SHA-1 empty tree in SHA-1 repositories", () => {
    assert.equal(emptyTree(makeRepo("sha1")), EMPTY_TREE);
  });
});

// ============================================================================================ state.mjs

describe("state.assertThreadName / ids / json helpers", () => {
  test("valid names pass through", () => {
    for (const name of ["review", "feat-1_2_x", "A", "9lives", "a".repeat(64)]) assert.equal(assertThreadName(name), name);
  });

  test("dotted names are rejected (they would collide with <name>.ledger.json)", () => {
    for (const name of ["feat.ledger", "a.b", "x.json"]) assert.throws(() => assertThreadName(name), /Invalid thread name/);
  });

  test("path-like, hidden, empty, spaced and over-long names are rejected", () => {
    for (const name of ["../x", "..", ".hidden", "a/b", "a\\b", "a b", "", null, undefined, "-x", "_x", "a".repeat(65), "x\n"]) {
      assert.throws(() => assertThreadName(name), /Invalid thread name/, JSON.stringify(name));
    }
  });

  test("jobDir rejects traversal; newJobId has a sortable, safe shape", () => {
    assert.throws(() => jobDir("/p", "../escape"), /Invalid job id/);
    assert.throws(() => jobDir("/p", "a/b"), /Invalid job id/);
    const id = newJobId("review", new Date("2026-09-26T15:04:05.678Z"));
    assert.match(id, /^20260926-150405-review-[0-9a-f]{8}$/);
    assert.equal(path.basename(jobDir("/p", id)), id);
  });

  test("writeJsonAtomic / readJson: round-trip, fallback, corrupt marker, no temp files left", () => {
    const dir = tmpDir("json");
    const file = path.join(dir, "deep", "x.json");
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(readJson(file), { a: 1 });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["x.json"]);
    assert.equal(readJson(path.join(dir, "missing.json"), "fallback"), "fallback");
    fs.writeFileSync(file, "{ nope");
    assert.equal(readJson(file).__corrupt, true);
  });

  test("ensureStateDir creates the layout and a self-ignoring .gitignore", () => {
    const project = tmpDir("statedir");
    const dir = ensureStateDir(project);
    for (const sub of ["threads", "locks", "jobs", "work"]) assert.ok(fs.statSync(path.join(dir, sub)).isDirectory());
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "*\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), "custom\n");
    ensureStateDir(project);
    assert.equal(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), "custom\n", "existing .gitignore is kept");
  });

  test("writeThread/readThread round-trip; listThreads sorts by updatedAt and flags corrupt files", () => {
    const project = tmpDir("threads");
    assert.deepEqual(listThreads(project), []);
    writeThread(project, "old", { sessionId: "S1", updatedAt: "2026-01-01T00:00:00Z" });
    writeThread(project, "new", { sessionId: "S2", updatedAt: "2026-09-01T00:00:00Z" });
    assert.deepEqual(readThread(project, "old"), { sessionId: "S1", updatedAt: "2026-01-01T00:00:00Z" });
    assert.equal(readThread(project, "missing"), null);
    fs.writeFileSync(path.join(project, ".coworker", "threads", "torn.json"), "{");
    assert.equal(readThread(project, "torn"), null);
    const listed = listThreads(project);
    assert.deepEqual(listed.map((thread) => thread.name), ["new", "old", "torn"]);
    assert.equal(listed[2].corrupt, true);
  });

  test(
    "ledger files are not listed as threads",
    () => {
      const project = tmpDir("threads-ledger");
      writeThread(project, "feat", { sessionId: "S", updatedAt: "2026-09-26T00:00:00Z" });
      writeLedger(project, "feat", reviewLedger(["major"]));
      assert.deepEqual(listThreads(project).map((thread) => thread.name), ["feat"]);
    },
  );

  test(
    "a thread's metadata can never overwrite another thread's ledger",
    () => {
      const project = tmpDir("threads-collide");
      const ledger = reviewLedger(["major"]);
      writeLedger(project, "feat", ledger);
      let rejected = false;
      try {
        assertThreadName("feat.ledger");
        writeThread(project, "feat.ledger", { sessionId: "OTHER" });
      } catch {
        rejected = true;
      }
      assert.ok(rejected || JSON.stringify(readLedger(project, "feat")) === JSON.stringify(ledger), "feat's ledger was clobbered");
      assert.deepEqual(readLedger(project, "feat"), ledger);
    },
  );
});

describe("state.acquireThreadLock / releaseThreadLock", () => {
  const lockDirEntries = (project) => fs.readdirSync(path.dirname(lockPath(project, "x")));

  function writeLock(project, name, record) {
    fs.mkdirSync(path.dirname(lockPath(project, name)), { recursive: true });
    fs.writeFileSync(lockPath(project, name), JSON.stringify(record));
  }
  const ago = (ms) => new Date(Date.now() - ms).toISOString();

  test("acquire writes the owner record atomically and leaves no temp files", () => {
    const project = tmpDir("lock");
    const record = acquireThreadLock(project, "t", { jobId: "J1", launcherPid: process.pid });
    assert.equal(record.jobId, "J1");
    assert.ok(Date.parse(record.createdAt));
    assert.deepEqual(readLock(project, "t"), record);
    assert.deepEqual(lockDirEntries(project), ["t.lock"]);
  });

  test("a live (fresh, non-terminal) holder makes others THREAD_BUSY and keeps its lock", () => {
    const project = tmpDir("lock-busy");
    const first = acquireThreadLock(project, "t", { jobId: "J1", launcherPid: process.pid });
    writeStatus(project, "J1", { state: "running" });
    assert.throws(
      () => acquireThreadLock(project, "t", { jobId: "J2", launcherPid: process.pid }, { retryMs: 0 }),
      (error) => error.code === "THREAD_BUSY" && error.jobId === "J1" && /busy with job J1/.test(error.message) && /coworker wait J1/.test(error.message),
    );
    assert.deepEqual(readLock(project, "t"), first);
    assert.deepEqual(lockDirEntries(project), ["t.lock"]);
  });

  test("busy acquisition retries for about retryMs before giving up", () => {
    const project = tmpDir("lock-retry");
    acquireThreadLock(project, "t", { jobId: "J1" });
    const started = Date.now();
    assert.throws(() => acquireThreadLock(project, "t", { jobId: "J2" }, { retryMs: 400 }), { code: "THREAD_BUSY" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 350 && elapsed < 3000, `elapsed ${elapsed}ms`);
  });

  test("a lock whose job reached a terminal state is stale and gets broken", () => {
    for (const state of TERMINAL_STATES) {
      const project = tmpDir("lock-terminal");
      acquireThreadLock(project, "t", { jobId: "OLD" });
      writeStatus(project, "OLD", { state });
      const record = acquireThreadLock(project, "t", { jobId: "NEW" }, { retryMs: 0 });
      assert.equal(record.jobId, "NEW", state);
      assert.equal(readLock(project, "t").jobId, "NEW");
      assert.deepEqual(lockDirEntries(project), ["t.lock"], "no tombstones or temp files left");
    }
  });

  test("a lock without a jobId is stale", () => {
    const project = tmpDir("lock-nojob");
    writeLock(project, "t", { launcherPid: 1, createdAt: new Date().toISOString() });
    assert.equal(acquireThreadLock(project, "t", { jobId: "NEW" }, { retryMs: 0 }).jobId, "NEW");
  });

  test("past the start grace: dead processes → stale; a live supervisor (matched by identity) → busy", async () => {
    const project = tmpDir("lock-grace");
    const jobId = newJobId("review");
    writeLock(project, "t", { jobId, launcherPid: await deadPid(), createdAt: ago(60000) });
    writeStatus(project, jobId, { state: "running", supervisorPid: await deadPid() });
    assert.equal(isLockStale(project, readLock(project, "t")), true);

    const child = await spawnMarked(jobId);
    try {
      writeStatus(project, jobId, { supervisorPid: child.pid });
      assert.equal(isLockStale(project, readLock(project, "t")), false);
      assert.throws(() => acquireThreadLock(project, "t", { jobId: "NEW" }, { retryMs: 0 }), { code: "THREAD_BUSY" });
      writeStatus(project, jobId, { supervisorPid: null, codexPid: child.pid });
      assert.equal(isLockStale(project, readLock(project, "t")), false, "a live codex process also holds the lock");
    } finally {
      await killChild(child);
    }
    assert.equal(acquireThreadLock(project, "t", { jobId: "NEW" }, { retryMs: 0 }).jobId, "NEW");
  });

  test("within the start grace period a lock is never stale, even with no live process", async () => {
    const project = tmpDir("lock-fresh");
    writeLock(project, "t", { jobId: "J", launcherPid: await deadPid(), createdAt: new Date().toISOString() });
    assert.equal(isLockStale(project, readLock(project, "t")), false);
  });

  test("an alive pid whose command line does not contain the job id does not hold the lock (pid reuse)", () => {
    const project = tmpDir("lock-reuse");
    const jobId = newJobId("review");
    writeLock(project, "t", { jobId, launcherPid: 999999, createdAt: ago(60000) });
    writeStatus(project, jobId, { state: "running", supervisorPid: process.pid, codexPid: process.pid });
    assert.equal(isLockStale(project, readLock(project, "t")), true);
  });

  test("link-based exclusivity: of several racing processes exactly one wins", async () => {
    const project = tmpDir("lock-race");
    fs.mkdirSync(path.join(project, ".coworker", "locks"), { recursive: true });
    const stateUrl = pathToFileURL(path.join(LIB, "state.mjs")).href;
    const startAt = Date.now() + 700;
    const script = `
      import { acquireThreadLock } from ${JSON.stringify(stateUrl)};
      const [root, jobId, startAt] = process.argv.slice(1);
      while (Date.now() < Number(startAt)) {}
      try { acquireThreadLock(root, "race", { jobId, launcherPid: process.pid }, { retryMs: 0 }); console.log("WON " + jobId); }
      catch (error) { console.log(error.code); }
    `;
    const children = Array.from({ length: 6 }, (_, index) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, project, `RACE${index}`, String(startAt)], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      return once(child, "exit").then(() => out.trim());
    });
    const results = await Promise.all(children);
    const winners = results.filter((line) => line.startsWith("WON "));
    assert.equal(winners.length, 1, results.join(", "));
    assert.equal(results.filter((line) => line === "THREAD_BUSY").length, 5, results.join(", "));
    assert.equal(readLock(project, "race").jobId, winners[0].slice(4));
    assert.deepEqual(fs.readdirSync(path.join(project, ".coworker", "locks")), ["race.lock"]);
  });

  test("releaseThreadLock only releases the owner's lock", () => {
    const project = tmpDir("lock-release");
    acquireThreadLock(project, "t", { jobId: "J1" });
    assert.equal(releaseThreadLock(project, "t", "J2"), false);
    assert.equal(readLock(project, "t").jobId, "J1");
    assert.equal(releaseThreadLock(project, "t", "J1"), true);
    assert.equal(readLock(project, "t"), null);
    assert.equal(releaseThreadLock(project, "t", "J1"), false, "nothing to release");

    acquireThreadLock(project, "u", { jobId: "J3" });
    assert.equal(releaseThreadLock(project, "u"), true, "no jobId → unconditional release");
    assert.equal(fs.existsSync(lockPath(project, "u")), false);

    writeLock(project, "v", {});
    fs.writeFileSync(lockPath(project, "v"), "{ torn");
    assert.equal(readLock(project, "v"), null);
    assert.equal(releaseThreadLock(project, "v", "anything"), true, "a corrupt lock can be released");
    assert.deepEqual(lockDirEntries(project), [], "no mutex directories left behind");
  });

  test("a corrupt lock file does not wedge the thread", () => {
    const project = tmpDir("lock-corrupt");
    writeLock(project, "t", {});
    fs.writeFileSync(lockPath(project, "t"), "{ torn");
    assert.equal(acquireThreadLock(project, "t", { jobId: "NEW" }, { retryMs: 0 }).jobId, "NEW");
  });

  test("a lock taken by a still-running launcher (before the supervisor exists) survives the 15s grace", async () => {
    const project = tmpDir("lock-launcher");
    const jobId = newJobId("review");
    // What startTurn writes: owner {jobId, launcherPid} and no job status yet. The launcher's argv is
    // `node …/scripts/coworker.mjs review …`, which never contains the job id.
    const launcher = await spawnMarked(path.join(ROOT, "fake-plugin", "scripts", "coworker.mjs"));
    try {
      writeLock(project, "t", { jobId, launcherPid: launcher.pid, createdAt: ago(20000) });
      assert.equal(isLockStale(project, readLock(project, "t")), false);
      assert.throws(() => acquireThreadLock(project, "t", { jobId: "NEW" }, { retryMs: 0 }), { code: "THREAD_BUSY" });
    } finally {
      await killChild(launcher);
    }
    assert.equal(isLockStale(project, readLock(project, "t")), true, "once the launcher is gone the lock is stale");
    writeLock(project, "t", { jobId, launcherPid: process.pid, createdAt: ago(20000) });
    assert.equal(isLockStale(project, readLock(project, "t")), true, "a live non-coworker process at launcherPid does not hold it");
  });
});

// =========================================================================================== config.mjs

describe("config", () => {
  function project(config) {
    const root = tmpDir("cfg");
    if (config !== undefined) put(root, ".coworker/config.json", typeof config === "string" ? config : JSON.stringify(config));
    return root;
  }
  function withGlobal(config, fn) {
    const file = globalConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config));
    try {
      return fn();
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  test("globalConfigPath honours XDG_CONFIG_HOME", () => {
    assert.equal(globalConfigPath(), path.join(process.env.XDG_CONFIG_HOME, "coworker", "config.json"));
  });

  test("defaults with no config files and an empty env", () => {
    const root = project();
    const { config, sources, projectRoot } = loadConfig({ projectRoot: root, env: {} });
    assert.deepEqual(config, {
      model: "gpt-6-astra",
      effort: { ask: "high", plan: "high", review: "high", rereview: "medium", debate: "high" },
      maxRounds: { plan: 2, review: 3 },
      lang: "auto",
      isolation: "strict",
      authMethod: "chatgpt",
      webSearch: true,
      waitBudgetSec: 540,
      timeoutSec: 1800,
      jobRetentionDays: 14,
      codexBin: null,
      autoMode: false,
    });
    assert.equal(projectRoot, root);
    assert.deepEqual(sources, { global: globalConfigPath(), project: path.join(root, ".coworker", "config.json") });
    assert.ok(Object.isFrozen(DEFAULTS));
    assert.deepEqual(KINDS, ["ask", "plan", "review", "rereview", "debate"]);
    assert.ok(EFFORTS.includes("xhigh"));
  });

  test("loadConfig never mutates DEFAULTS", () => {
    const snapshot = structuredClone(DEFAULTS);
    loadConfig({ projectRoot: project({ maxRounds: 5, effort: { ask: "low" } }), env: { COWORKER_EFFORT: "max" } });
    assert.deepEqual(structuredClone(DEFAULTS), snapshot);
  });

  test("environment overrides", () => {
    const { config } = loadConfig({
      projectRoot: project(),
      env: {
        COWORKER_MODEL: "gpt-x",
        COWORKER_LANG: "ko",
        COWORKER_CODEX_BIN: "/opt/codex",
        COWORKER_EFFORT: "medium",
        COWORKER_EFFORT_REVIEW: "max",
        COWORKER_WAIT_BUDGET: "0",
        COWORKER_TIMEOUT: "60",
        COWORKER_ISOLATION: "inherit",
      },
    });
    assert.equal(config.model, "gpt-x");
    assert.equal(config.lang, "ko");
    assert.equal(config.codexBin, "/opt/codex");
    assert.deepEqual(config.effort, { ask: "medium", plan: "medium", review: "max", rereview: "medium", debate: "medium" });
    assert.equal(config.waitBudgetSec, 0);
    assert.equal(config.timeoutSec, 60);
    assert.equal(config.isolation, "inherit");
  });

  test("per-kind env effort without the global one", () => {
    const { config } = loadConfig({ projectRoot: project(), env: { COWORKER_EFFORT_REREVIEW: "low" } });
    assert.deepEqual(config.effort, { ...DEFAULTS.effort, rereview: "low" });
  });

  test("layering: defaults < global < project < env", () => {
    withGlobal({ model: "from-global", effort: { ask: "low" }, timeoutSec: 99 }, () => {
      const root = project({ model: "from-project", effort: { plan: "xhigh" } });
      const layered = loadConfig({ projectRoot: root, env: {} }).config;
      assert.equal(layered.model, "from-project");
      assert.equal(layered.timeoutSec, 99);
      assert.deepEqual(layered.effort, { ...DEFAULTS.effort, ask: "low", plan: "xhigh" });
      assert.equal(loadConfig({ projectRoot: root, env: { COWORKER_MODEL: "from-env" } }).config.model, "from-env");
    });
  });

  test("invalid efforts throw (env, per-kind env, project file)", () => {
    assert.throws(() => loadConfig({ projectRoot: project(), env: { COWORKER_EFFORT: "turbo" } }), /Invalid effort "turbo" for ask/);
    assert.throws(() => loadConfig({ projectRoot: project(), env: { COWORKER_EFFORT_DEBATE: "HIGH" } }), /Invalid effort "HIGH" for debate/);
    assert.throws(() => loadConfig({ projectRoot: project({ effort: { review: "extreme" } }), env: {} }), /Invalid effort "extreme" for review/);
  });

  test("numeric maxRounds is normalized to {plan, review}; partial objects merge with defaults", () => {
    assert.deepEqual(loadConfig({ projectRoot: project({ maxRounds: 4 }), env: {} }).config.maxRounds, { plan: 4, review: 4 });
    assert.deepEqual(loadConfig({ projectRoot: project({ maxRounds: { review: 5 } }), env: {} }).config.maxRounds, { plan: 2, review: 5 });
    assert.deepEqual(validateConfig({ ...structuredClone(DEFAULTS), maxRounds: 1 }).maxRounds, { plan: 1, review: 1 });
  });

  test("invalid maxRounds values throw", () => {
    for (const maxRounds of [0, -1, 2.5, "3", { plan: 0 }]) {
      assert.throws(() => loadConfig({ projectRoot: project({ maxRounds }), env: {} }), /Invalid maxRounds\./, JSON.stringify(maxRounds));
    }
  });

  test("invalid numbers, isolation and authMethod throw", () => {
    assert.throws(() => loadConfig({ projectRoot: project(), env: { COWORKER_WAIT_BUDGET: "soon" } }), /Invalid waitBudgetSec/);
    assert.throws(() => loadConfig({ projectRoot: project(), env: { COWORKER_TIMEOUT: "-5" } }), /Invalid timeoutSec/);
    assert.throws(() => loadConfig({ projectRoot: project({ jobRetentionDays: -1 }), env: {} }), /Invalid jobRetentionDays/);
    assert.throws(() => loadConfig({ projectRoot: project(), env: { COWORKER_ISOLATION: "none" } }), /Invalid isolation "none"/);
    assert.throws(() => loadConfig({ projectRoot: project({ authMethod: "apikey" }), env: {} }), /Invalid authMethod "apikey"/);
  });

  test("invalid JSON in a config file is reported with the file path", () => {
    const root = project("{ nope");
    assert.throws(() => loadConfig({ projectRoot: root, env: {} }), (error) => /Invalid JSON in /.test(error.message) && error.message.includes(root));
  });

  test("writeConfigKey creates the file, merges keys and leaves no temp file", () => {
    const dir = tmpDir("cfg-write");
    const file = path.join(dir, "nested", "config.json");
    assert.deepEqual(writeConfigKey(file, "autoMode", true), { autoMode: true });
    assert.deepEqual(writeConfigKey(file, "model", "m"), { autoMode: true, model: "m" });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { autoMode: true, model: "m" });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["config.json"]);
    const root = project({ autoMode: true });
    assert.equal(loadConfig({ projectRoot: root, env: {} }).config.autoMode, true);
  });

  test("findProjectRoot: git top-level from a subdirectory, else the resolved cwd", () => {
    const repo = makeRepo("root");
    fs.mkdirSync(path.join(repo, "a", "b"), { recursive: true });
    assert.equal(findProjectRoot(path.join(repo, "a", "b")), repo);
    const plain = tmpDir("plain");
    assert.equal(findProjectRoot(plain), plain);
    assert.equal(loadConfig({ cwd: path.join(repo, "a"), env: {} }).projectRoot, repo);
  });
});

// ------------------------------------------------------------------ Astra self-review round 3 regressions (R1, R6, R7)

describe("self-review regressions", () => {
  const stateMod = () => import(pathToFileURL(path.join(LIB, "state.mjs")).href);
  const jobsMod = () => import(pathToFileURL(path.join(LIB, "jobs.mjs")).href);

  test("R1: a mutex left by a dead holder is reported (never auto-reclaimed) and `unlock` clears it", async () => {
    const { acquireThreadLock, forceUnlockThread, lockPath } = await stateMod();
    const project = tmpDir("r1-mutex");
    fs.mkdirSync(path.join(project, ".coworker", "locks"), { recursive: true });
    const mutex = `${lockPath(project, "t")}.mutex`;
    fs.mkdirSync(mutex);
    fs.writeFileSync(path.join(mutex, "owner"), JSON.stringify({ pid: await deadPid(), marker: "coworker.mjs", at: "2000-01-01T00:00:00Z" }));
    fs.writeFileSync(lockPath(project, "t"), JSON.stringify({ jobId: "OLD", launcherPid: await deadPid(), createdAt: "2000-01-01T00:00:00Z" }));
    assert.throws(() => acquireThreadLock(project, "t", { jobId: "NEW", launcherPid: process.pid }, { retryMs: 0 }), (error) => error.code === "MUTEX_STALE");
    assert.ok(fs.existsSync(mutex), "the dead mutex must not be removed automatically");
    assert.deepEqual(forceUnlockThread(project, "t").sort(), ["lock", "mutex"]);
    acquireThreadLock(project, "t", { jobId: "NEW", launcherPid: process.pid }, { retryMs: 0 });
  });

  test("R1: `unlock` refuses while a live job holds the thread", async () => {
    const { acquireThreadLock, forceUnlockThread } = await stateMod();
    const project = tmpDir("r1-unlock-live");
    acquireThreadLock(project, "t", { jobId: "LIVE", launcherPid: process.pid });
    assert.throws(() => forceUnlockThread(project, "t"), /held by a live job/);
  });

  test("R6: an empty or garbled ack is not evidence that its owner died", async () => {
    const { reconcile: rec, readAck } = await jobsMod();
    const project = tmpDir("r6-ack");
    const jobId = newJobId("ask");
    const dir = path.join(project, ".coworker", "jobs", jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId, thread: "t" }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "created", updatedAt: "2000-01-01T00:00:00Z" }));
    fs.writeFileSync(path.join(dir, "ack"), "");
    assert.equal(readAck(dir), null);
    assert.equal(rec(project, jobId).state, "created", "an unreadable ack must not settle the job");
  });

  test("R6: claimAck publishes a complete record atomically and only once", async () => {
    const { claimAck, readAck } = await jobsMod();
    const dir = tmpDir("r6-claim");
    assert.equal(claimAck(dir, "supervisor"), true);
    assert.equal(claimAck(dir, "launcher-gave-up"), false);
    assert.deepEqual(readAck(dir), { who: "supervisor", pid: process.pid });
    assert.deepEqual(fs.readdirSync(dir), ["ack"], "no temp files left behind");
  });

  test("R7: recovering a dead old job never overwrites the thread while a newer job holds it", async () => {
    const { acquireThreadLock, readThread, writeThread } = await stateMod();
    const { reconcile: rec } = await jobsMod();
    const project = tmpDir("r7-recover");
    const oldJob = newJobId("review");
    const dir = path.join(project, ".coworker", "jobs", oldJob);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId: oldJob, thread: "t" }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running", supervisorPid: await deadPid(), startedAt: "2000-01-01T00:00:00Z" }));
    // A newer turn already holds the thread and has written its own state.
    acquireThreadLock(project, "t", { jobId: "NEWER", launcherPid: process.pid });
    writeThread(project, "t", { name: "t", activeJobId: "NEWER", rounds: { review: 2 }, turns: [{ jobId: "NEWER" }] });
    assert.equal(rec(project, oldJob).state, "interrupted");
    const thread = readThread(project, "t");
    assert.equal(thread.activeJobId, "NEWER");
    assert.deepEqual(thread.rounds, { review: 2 });
    assert.deepEqual(thread.turns.map((turn) => turn.jobId), ["NEWER"]);
  });

  test("R7: recovering a dead job that still owns the thread clears activeJobId and records the turn", async () => {
    const { readThread, writeThread, lockPath } = await stateMod();
    const { reconcile: rec } = await jobsMod();
    const project = tmpDir("r7-own");
    const oldJob = newJobId("review");
    const dir = path.join(project, ".coworker", "jobs", oldJob);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ jobId: oldJob, thread: "t", kind: "review", round: 1 }));
    fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "running", supervisorPid: await deadPid(), startedAt: "2000-01-01T00:00:00Z" }));
    fs.mkdirSync(path.dirname(lockPath(project, "t")), { recursive: true });
    fs.writeFileSync(lockPath(project, "t"), JSON.stringify({ jobId: oldJob, launcherPid: await deadPid(), createdAt: "2000-01-01T00:00:00Z" }));
    writeThread(project, "t", { name: "t", activeJobId: oldJob, turns: [] });
    assert.equal(rec(project, oldJob).state, "interrupted");
    const thread = readThread(project, "t");
    assert.equal(thread.activeJobId, null);
    assert.equal(thread.turns.at(-1).state, "interrupted");
    assert.equal(fs.existsSync(lockPath(project, "t")), false, "the dead job's lock is released");
  });
});
