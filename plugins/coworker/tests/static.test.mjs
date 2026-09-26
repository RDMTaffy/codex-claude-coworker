// Static checks for the coworker plugin: skill frontmatter and bodies, hooks, bin launcher, JSON schemas
// (OpenAI strict mode), manifests, and a few docs ⇄ code consistency checks.
//
// Run:  node --test tests/static.test.mjs
// Temp files (two tiny smoke runs of the ops-skill `!` lines and the hook) go under $COWORKER_TEST_TMP
// (default: os.tmpdir()), never inside the plugin. XDG_CACHE_HOME / XDG_CONFIG_HOME point at temp dirs
// and CLAUDE_PROJECT_DIR is removed from the child environment.

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MARKETPLACE_ROOT = path.resolve(ROOT, "..", "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const PROTOCOL = path.join(ROOT, "references", "protocol.md");
const CLI_SOURCE = path.join(ROOT, "scripts", "coworker.mjs");
const FAKE_CODEX = path.join(HERE, "fixtures", "fake-codex.mjs");

const OPS_SKILLS = ["status", "threads", "mode"];
const FLAGSHIP_SKILLS = ["task", "plan", "review", "ask", "debate"];

// Frontmatter keys Claude Code understands for skills. Anything else is most likely a typo.
const KNOWN_KEYS = new Set([
  "name",
  "description",
  "argument-hint",
  "allowed-tools",
  "disallowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "when_to_use",
  "license",
  "version",
  "effort",
  "paths",
  "shell",
  "arguments",
  "metadata",
  "hooks",
  "model",
  "context",
  "agent",
]);

const HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

// ------------------------------------------------------------------ helpers

/** Tiny YAML-frontmatter parser for the flat `key: value` subset the skills use. Throws on anything else. */
export function parseFrontmatter(text) {
  const source = text.replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) throw new Error("file does not start with a '---' frontmatter line");
  const close = source.indexOf("\n---\n", 3);
  const closeAtEof = source.endsWith("\n---") ? source.length - 4 : -1;
  const end = close !== -1 ? close : closeAtEof;
  if (end === -1) throw new Error("frontmatter has no closing '---' line");
  const block = source.slice(4, end);
  const body = close !== -1 ? source.slice(close + 5) : "";
  const data = {};
  const raw = {};
  block.split("\n").forEach((line, index) => {
    const where = `frontmatter line ${index + 2}`;
    if (!line.trim() || /^#/.test(line)) return;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/);
    if (!match) throw new Error(`${where}: not a flat "key: value" line: ${JSON.stringify(line)}`);
    const [, key, value = ""] = match;
    if (Object.hasOwn(data, key)) throw new Error(`${where}: duplicate key "${key}"`);
    raw[key] = value.replace(/[ \t]+$/, "");
    data[key] = parseScalar(raw[key], `${where} (${key})`);
  });
  return { data, raw, body };
}

function parseScalar(value, where) {
  if (value === "") throw new Error(`${where}: empty value`);
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error(`${where}: unterminated or badly escaped single-quoted value`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${where}: double-quoted value is not a simple escaped string`);
    }
  }
  if (/[[\]:]/.test(value)) throw new Error(`${where}: plain value contains '[', ']' or ':' — single-quote it`);
  if (/^([{}&*!|>%@`#?,]|- )/.test(value)) throw new Error(`${where}: plain value starts with a YAML indicator — quote it`);
  if (/\s#/.test(value)) throw new Error(`${where}: plain value contains ' #' (YAML comment) — quote it`);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Claude Code's allowed-tools splitter: whitespace/comma separated, parentheses protect spaces. */
function splitAllowedTools(value) {
  const out = [];
  let current = "";
  let inParens = false;
  for (const char of String(value)) {
    if (char === "(") inParens = true;
    if (char === ")") inParens = false;
    if ((char === " " || char === ",") && !inParens) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Shell commands Claude Code runs while loading a skill: fenced blocks opened with ```! and inline
 * !`cmd` spans preceded by start-of-line or whitespace (inline code spans are masked first, as Claude
 * Code does, so `…!`…` inside ordinary code does not count).
 */
function bangCommands(body) {
  const found = [];
  for (const match of body.matchAll(/```!\s*\n?([\s\S]*?)\n?```/g)) found.push({ raw: match[0], command: match[1].trim(), fenced: true });
  if (body.includes("!`")) {
    const masked = body.replace(/`[^`\n]+`/g, (span, offset) => {
      const before = body[offset - 1];
      return before === "!" || before === "`" ? span : `\`${" ".repeat(span.length - 2)}\``;
    });
    for (const match of masked.matchAll(/(?<=^|\s)!`([^`]+)`/gm)) found.push({ raw: match[0], command: match[1].trim(), fenced: false });
  }
  return found.filter((entry) => entry.command);
}

/** Split a markdown body into lines tagged with whether they sit inside a fenced code block. */
function fencedLines(body) {
  let inFence = false;
  return body.split("\n").map((line, index) => {
    const isFence = /^\s{0,6}```/.test(line);
    const entry = { line, number: index + 1, inFence: inFence || isFence };
    if (isFence) inFence = !inFence;
    return entry;
  });
}

/** Every code snippet in a markdown body: fenced block lines and inline `code` spans. */
function codeSnippets(body) {
  const snippets = [];
  for (const entry of fencedLines(body)) {
    if (entry.inFence && !/^\s*```/.test(entry.line) && entry.line.trim()) snippets.push(entry.line.trim());
  }
  const withoutFences = fencedLines(body)
    .filter((entry) => !entry.inFence)
    .map((entry) => entry.line)
    .join("\n");
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) snippets.push(match[1].trim());
  return snippets;
}

const skillCache = new Map();
function loadSkill(name) {
  if (!skillCache.has(name)) {
    const file = path.join(SKILLS_DIR, name, "SKILL.md");
    const text = fs.readFileSync(file, "utf8");
    skillCache.set(name, { file, text, ...parseFrontmatter(text) });
  }
  return skillCache.get(name);
}

function skillNames() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walkFiles(dir, predicate = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

// --- CLI source introspection (static: reads coworker.mjs as text, never runs Codex) ---

const cliSource = fs.readFileSync(CLI_SOURCE, "utf8");

function quotedStrings(text) {
  return [...text.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function functionSource(name) {
  const start = cliSource.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `function ${name} not found in coworker.mjs`);
  const rest = cliSource.slice(start + 1);
  const next = rest.search(/\n(?:async )?function |\nconst [A-Z_]+ = /);
  return cliSource.slice(start, next === -1 ? undefined : start + 1 + next);
}

function specFlags(fnName) {
  const body = functionSource(fnName);
  const call = body.match(/parseArgs\(argv, (\{[^\n]*\})\)/);
  assert.ok(call, `${fnName} has no inline parseArgs spec`);
  return new Set(quotedStrings(call[1]));
}

const TURN_FLAGS = (() => {
  const block = cliSource.match(/const TURN_SPEC = \{([\s\S]*?)\n\};/);
  assert.ok(block, "TURN_SPEC not found");
  const flags = block[1].split(/aliases:/)[0];
  return new Set(quotedStrings(flags));
})();

const SUBCOMMAND_FLAGS = {
  ask: TURN_FLAGS,
  plan: TURN_FLAGS,
  review: TURN_FLAGS,
  debate: TURN_FLAGS,
  wait: specFlags("cmdWait"),
  cancel: specFlags("cmdCancel"),
  status: specFlags("cmdStatus"),
  jobs: specFlags("cmdJobs"),
  threads: specFlags("cmdThreads"),
  "task-state": specFlags("cmdTaskState"),
  mode: specFlags("cmdMode"),
};

const CLI_COMMANDS = (() => {
  const main = functionSource("main");
  return new Set([...main.matchAll(/case "([a-z-]+)":/g)].map((match) => match[1]));
})();

// --- isolated environment for the two small smoke runs ---

let tmpRoot;
let isolatedEnv;

function makeRepo(label) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  return dir;
}

before(() => {
  const base = process.env.COWORKER_TEST_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  tmpRoot = fs.mkdtempSync(path.join(base, "coworker-static-"));
  const resolved = fs.realpathSync(tmpRoot);
  assert.ok(!resolved.startsWith(fs.realpathSync(MARKETPLACE_ROOT) + path.sep), "temp dir must live outside the repository");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("COWORKER_") || key === "CLAUDE_PROJECT_DIR") delete env[key];
  fs.mkdirSync(path.join(tmpRoot, "xdg-cache"), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, "xdg-config"), { recursive: true });
  isolatedEnv = {
    ...env,
    XDG_CACHE_HOME: path.join(tmpRoot, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(tmpRoot, "xdg-config"),
    COWORKER_CODEX_BIN: FAKE_CODEX,
    PATH: `${path.join(ROOT, "bin")}${path.delimiter}${process.env.PATH}`,
  };
});

after(() => {
  if (tmpRoot && !process.env.COWORKER_KEEP_TMP) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ================================================================== parser self-check

describe("frontmatter parser self-check", () => {
  test("accepts the flat subset and single-quote escapes", () => {
    const parsed = parseFrontmatter("---\ndescription: 'a: b [c] it''s'\nflag: true\ntools: Bash(x *) Read\n---\nbody\n");
    assert.equal(parsed.data.description, "a: b [c] it's");
    assert.equal(parsed.data.flag, true);
    assert.equal(parsed.data.tools, "Bash(x *) Read");
    assert.equal(parsed.body, "body\n");
  });

  test("rejects unquoted ':' / '[' values, bad quotes, nesting and duplicates", () => {
    assert.throws(() => parseFrontmatter("---\ndescription: a: b\n---\n"), /single-quote/);
    assert.throws(() => parseFrontmatter("---\nargument-hint: [x]\n---\n"), /single-quote/);
    assert.throws(() => parseFrontmatter("---\ndescription: 'it's'\n---\n"), /single-quoted/);
    assert.throws(() => parseFrontmatter("---\nhooks:\n  Stop: x\n---\n"), /empty value|flat/);
    assert.throws(() => parseFrontmatter("---\na: 1\na: 2\n---\n"), /duplicate/);
    assert.throws(() => parseFrontmatter("no frontmatter\n"), /---/);
  });

  test("allowed-tools splitter keeps spaces inside parentheses", () => {
    assert.deepEqual(splitAllowedTools("Bash(coworker *) Read Edit(.coworker/**)"), ["Bash(coworker *)", "Read", "Edit(.coworker/**)"]);
  });

  test("bang detection mirrors Claude Code (inline and ```! fences, not ordinary code)", () => {
    assert.deepEqual(bangCommands("!`coworker x \"$ARGUMENTS\"`\n").map((entry) => entry.command), ['coworker x "$ARGUMENTS"']);
    assert.equal(bangCommands("run `a!` then `b`\n").length, 0);
    assert.equal(bangCommands("```!\nls\n```\n").length, 1);
  });
});

// ================================================================== skills

describe("skills: frontmatter", () => {
  test("the expected skills exist, each with a SKILL.md", () => {
    const names = skillNames();
    for (const name of [...OPS_SKILLS, ...FLAGSHIP_SKILLS]) assert.ok(names.includes(name), `missing skill ${name}`);
    for (const name of names) assert.ok(fs.existsSync(path.join(SKILLS_DIR, name, "SKILL.md")), `${name}/SKILL.md missing`);
  });

  for (const name of skillNames()) {
    describe(name, () => {
      test("frontmatter parses and has a description", () => {
        const skill = loadSkill(name);
        assert.equal(typeof skill.data.description, "string", "description must be a string");
        assert.ok(skill.data.description.trim().length >= 20, "description is too short to trigger reliably");
        assert.ok(skill.data.description.length <= 1024, `description is ${skill.data.description.length} chars (max 1024)`);
        assert.ok(skill.body.trim().length > 0, "empty skill body");
        if (skill.data.name !== undefined) assert.equal(skill.data.name, name, "frontmatter name must match the directory");
      });

      test("only known frontmatter keys; no model:, no context: fork", () => {
        const skill = loadSkill(name);
        for (const key of Object.keys(skill.data)) assert.ok(KNOWN_KEYS.has(key), `unknown frontmatter key "${key}"`);
        assert.ok(!Object.hasOwn(skill.data, "model"), "skills must not pin a model");
        assert.notEqual(skill.data.context, "fork", "skills must not run in a forked context");
        assert.doesNotMatch(skill.text.split("\n---\n")[0], /^context:\s*'?fork/m);
      });

      test("argument-hint (if present) is single-quoted", () => {
        const skill = loadSkill(name);
        if (skill.raw["argument-hint"] === undefined) return;
        assert.match(skill.raw["argument-hint"], /^'.*'$/, "argument-hint must be single-quoted");
      });

      test("allowed-tools entries are well-formed and include Bash(coworker *)", () => {
        const skill = loadSkill(name);
        assert.equal(typeof skill.data["allowed-tools"], "string", "allowed-tools missing");
        const tools = splitAllowedTools(skill.data["allowed-tools"]);
        for (const tool of tools) assert.match(tool, /^[A-Z][A-Za-z]*(\([^()]+\))?$/, `malformed allowed-tools entry ${tool}`);
        assert.ok(tools.includes("Bash(coworker *)"), "allowed-tools must include Bash(coworker *)");
      });

      test("body has no $N / $ARGUMENTS[N] placeholders Claude Code would silently substitute", () => {
        const skill = loadSkill(name);
        assert.doesNotMatch(skill.body, /(?<!\\)\$\d/, "a $<digit> in the body is replaced by a positional argument");
        assert.doesNotMatch(skill.body, /\$ARGUMENTS\[/, "indexed $ARGUMENTS is not used by this plugin");
      });
    });
  }
});

describe("skills: ops (status, threads, mode)", () => {
  for (const name of OPS_SKILLS) {
    describe(name, () => {
      test("disable-model-invocation: true", () => {
        assert.equal(loadSkill(name).data["disable-model-invocation"], true);
      });

      test(`its only shell injection is exactly: coworker ${name} --project "\${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`, () => {
        const skill = loadSkill(name);
        const bangs = bangCommands(skill.body);
        assert.equal(bangs.length, 1, `expected exactly one !\`…\` command, found ${bangs.length}`);
        assert.equal(bangs[0].fenced, false);
        const expected = `coworker ${name} --project "\${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`;
        assert.equal(bangs[0].command, expected);
        const lines = skill.body.split("\n").filter((line) => line.includes("!`"));
        assert.deepEqual(lines, [`!\`${expected}\``], "the !`…` line must stand alone, exactly");
        assert.equal(skill.body.split("$ARGUMENTS").length - 1, 1, "$ARGUMENTS may only appear in the !`…` line");
      });

      test("argument-hint flags and subcommands are accepted by the CLI", () => {
        const skill = loadSkill(name);
        const hint = skill.data["argument-hint"] ?? "";
        const accepted = SUBCOMMAND_FLAGS[name];
        for (const [, flag] of hint.matchAll(/--([a-z][a-z-]*)/g)) assert.ok(accepted.has(flag), `coworker ${name} does not accept --${flag}`);
        const body = functionSource(`cmd${name[0].toUpperCase()}${name.slice(1)}`);
        const words = hint.replace(/<[^>]*>/g, "").replace(/--[a-z-]+/g, "").match(/[a-z][a-z-]+/g) ?? [];
        for (const word of words) assert.ok(body.includes(`"${word}"`), `coworker ${name} has no "${word}" subcommand`);
      });
    });
  }

  test("simulated `!` injection works with empty and multi-word arguments (threads, mode)", () => {
    const repo = makeRepo("ops");
    const run = (name, args) => {
      // Claude Code substitutes $ARGUMENTS as raw text (it only defuses "!`"), then runs the line in a shell.
      const [bang] = bangCommands(loadSkill(name).body);
      const command = bang.command.replaceAll("${CLAUDE_PROJECT_DIR}", repo).replaceAll("$ARGUMENTS", args);
      return spawnSync("/bin/sh", ["-c", command], { cwd: repo, env: isolatedEnv, encoding: "utf8", timeout: 30000 });
    };
    const cases = [
      ["threads", "", /No threads yet/],
      ["threads", "list", /No threads yet/],
      ["threads", "show demo-thread", /No thread "demo-thread"/],
      ["mode", "", /auto mode: off/],
      ["mode", "on", /auto mode ON/],
      ["mode", "status", /auto mode: ON/],
      ["mode", "off", /auto mode OFF/],
    ];
    for (const [name, args, expected] of cases) {
      const result = run(name, args);
      assert.equal(result.status, 0, `coworker ${name} "${args}" exited ${result.status}: ${result.stderr}`);
      assert.match(result.stdout, expected, `coworker ${name} "${args}" → ${result.stdout}`);
    }
    assert.ok(fs.existsSync(path.join(repo, ".coworker", "config.json")), "mode on/off must write the project config inside the repo");
    assert.ok(!fs.existsSync(path.join(isolatedEnv.XDG_CONFIG_HOME, "coworker", "config.json")), "project mode must not touch the global config");
  });
});

describe("skills: flagship (task, plan, review, ask, debate)", () => {
  const protocolText = fs.readFileSync(PROTOCOL, "utf8");

  for (const name of FLAGSHIP_SKILLS) {
    describe(name, () => {
      test("$ARGUMENTS appears once, alone, inside an XML-style tag — never in a code block or !` line", () => {
        const skill = loadSkill(name);
        const lines = fencedLines(skill.body);
        const hits = lines.filter((entry) => entry.line.includes("$ARGUMENTS"));
        assert.equal(hits.length, 1, `expected one $ARGUMENTS line, found ${hits.length}`);
        for (const hit of hits) {
          assert.ok(!hit.inFence, `$ARGUMENTS inside a fenced code block (body line ${hit.number})`);
          assert.ok(!hit.line.includes("!`"), `$ARGUMENTS inside a !\` line (body line ${hit.number})`);
          assert.ok(!/`[^`]*\$ARGUMENTS[^`]*`/.test(hit.line), `$ARGUMENTS inside inline code (body line ${hit.number})`);
          assert.equal(hit.line.trim(), "$ARGUMENTS", "$ARGUMENTS must stand on its own line");
          const index = lines.indexOf(hit);
          const open = lines.slice(0, index).reverse().find((entry) => entry.line.trim());
          const close = lines.slice(index + 1).find((entry) => entry.line.trim());
          const tag = open?.line.trim().match(/^<([a-z][a-z-]*)>$/)?.[1];
          assert.ok(tag, "$ARGUMENTS must be preceded by an opening <tag> line");
          assert.equal(close?.line.trim(), `</${tag}>`, "$ARGUMENTS must be followed by the matching closing tag");
        }
      });

      test("runs no shell commands at load time (no !` lines, no ```! blocks)", () => {
        assert.deepEqual(bangCommands(loadSkill(name).body), []);
      });

      test("references ${CLAUDE_PLUGIN_ROOT}/references/protocol.md", () => {
        assert.ok(loadSkill(name).body.includes("${CLAUDE_PLUGIN_ROOT}/references/protocol.md"));
      });

      test("gives the Bash `timeout: 600000` guidance (directly or via the protocol)", () => {
        const body = loadSkill(name).body;
        const direct = body.includes("timeout: 600000");
        const viaProtocol = body.includes("references/protocol.md") && protocolText.includes("timeout: 600000");
        assert.ok(direct || viaProtocol, "no timeout: 600000 guidance");
      });

      test("every `coworker …` command uses a real subcommand, accepted flags, and --project", () => {
        const snippets = codeSnippets(loadSkill(name).body).filter((snippet) => /^coworker\s/.test(snippet));
        assert.ok(snippets.length > 0, "no coworker command found");
        for (const snippet of snippets) {
          const sub = snippet.split(/\s+/)[1];
          assert.ok(CLI_COMMANDS.has(sub), `unknown subcommand in: ${snippet}`);
          const accepted = SUBCOMMAND_FLAGS[sub];
          assert.ok(accepted, `no flag spec known for ${sub}`);
          for (const [, flag] of snippet.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) {
            assert.ok(accepted.has(flag), `coworker ${sub} does not accept --${flag}: ${snippet}`);
          }
          assert.ok(snippet.includes('--project "${CLAUDE_PROJECT_DIR}"'), `missing --project "\${CLAUDE_PROJECT_DIR}": ${snippet}`);
        }
      });

      test("protocol section references (§N) exist", () => {
        const body = loadSkill(name).body;
        for (const [, section] of body.matchAll(/§(\d+)/g)) {
          assert.match(protocolText, new RegExp(`^## ${section}\\. `, "m"), `protocol.md has no section ${section}`);
        }
      });
    });
  }

  test("protocol.md code snippets use real subcommands and accepted flags", () => {
    for (const snippet of codeSnippets(protocolText).filter((text) => /^coworker\s/.test(text))) {
      const sub = snippet.split(/\s+/)[1];
      assert.ok(CLI_COMMANDS.has(sub), `unknown subcommand in protocol: ${snippet}`);
      for (const [, flag] of snippet.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) {
        assert.ok(SUBCOMMAND_FLAGS[sub].has(flag), `coworker ${sub} does not accept --${flag}: ${snippet}`);
      }
    }
  });
});

// ================================================================== cross references

describe("cross references", () => {
  const textFiles = [
    ...walkFiles(SKILLS_DIR, (file) => file.endsWith(".md")),
    ...walkFiles(path.join(ROOT, "references")),
    ...walkFiles(path.join(ROOT, "hooks")),
    ...walkFiles(path.join(ROOT, "bin")),
    ...walkFiles(path.join(ROOT, "scripts"), (file) => file.endsWith(".mjs")),
    ...walkFiles(path.join(ROOT, "agents")),
    ...walkFiles(path.join(ROOT, "commands")),
  ];

  test("every ${CLAUDE_PLUGIN_ROOT}/… path exists", () => {
    let count = 0;
    for (const file of textFiles) {
      const text = fs.readFileSync(file, "utf8");
      for (const [, rel] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g)) {
        const clean = rel.replace(/[.,;:]+$/, "");
        count += 1;
        assert.ok(fs.existsSync(path.join(ROOT, clean)), `${path.relative(ROOT, file)} → \${CLAUDE_PLUGIN_ROOT}/${clean} does not exist`);
      }
    }
    assert.ok(count >= 6, `expected several \${CLAUDE_PLUGIN_ROOT} references, found ${count}`);
  });

  test("every coworker:<skill> / /coworker:<skill> reference names an existing skill", () => {
    const names = new Set(skillNames());
    for (const file of textFiles) {
      const text = fs.readFileSync(file, "utf8");
      for (const [, skill] of text.matchAll(/(?<![\w.-])\/?coworker:([a-z][a-z-]*)/g)) {
        assert.ok(names.has(skill), `${path.relative(ROOT, file)} references coworker:${skill}, which does not exist`);
      }
    }
  });
});

// ================================================================== hooks & bin

describe("hooks/hooks.json", () => {
  const hooksFile = path.join(ROOT, "hooks", "hooks.json");
  const config = readJson(hooksFile);
  const entries = Object.entries(config.hooks ?? {}).flatMap(([event, groups]) =>
    groups.flatMap((group) => (group.hooks ?? []).map((hook) => ({ event, hook }))),
  );

  test("has at least one hook, on known events", () => {
    assert.ok(entries.length > 0, "no hooks declared");
    for (const { event } of entries) assert.ok(HOOK_EVENTS.has(event), `unknown hook event ${event}`);
  });

  test("every command hook uses exec form (command \"node\" + args) with timeout <= 10", () => {
    for (const { event, hook } of entries) {
      assert.equal(hook.type, "command", `${event}: only command hooks expected`);
      assert.equal(hook.command, "node", `${event}: command must be exactly "node" (exec form, no shell string)`);
      assert.ok(Array.isArray(hook.args) && hook.args.length > 0, `${event}: args must be a non-empty array`);
      for (const arg of hook.args) assert.equal(typeof arg, "string");
      assert.match(hook.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\//, `${event}: script path must be rooted at \${CLAUDE_PLUGIN_ROOT}`);
      assert.ok(fs.existsSync(path.join(ROOT, hook.args[0].replace("${CLAUDE_PLUGIN_ROOT}/", ""))), `${event}: script does not exist`);
      assert.equal(typeof hook.timeout, "number", `${event}: timeout must be a number (seconds)`);
      assert.ok(hook.timeout > 0 && hook.timeout <= 10, `${event}: timeout ${hook.timeout}s must be in (0, 10]`);
    }
  });

  test("the hook entry point is silent and exits 0 fast (auto mode off, bad input)", () => {
    const repo = makeRepo("hook");
    for (const { hook } of entries) {
      const args = hook.args.map((arg) => arg.replace("${CLAUDE_PLUGIN_ROOT}", ROOT));
      const inputs = [
        JSON.stringify({ session_id: "s1", cwd: repo, prompt: "please implement the new cache layer for the API" }),
        "not json at all",
        "",
      ];
      for (const input of inputs) {
        const started = Date.now();
        const result = spawnSync(hook.command, args, { cwd: repo, env: isolatedEnv, input, encoding: "utf8", timeout: hook.timeout * 1000 });
        assert.equal(result.status, 0, `hook exited ${result.status} for ${JSON.stringify(input)}: ${result.stderr}`);
        assert.equal(result.stdout, "", "hook must print nothing while auto mode is off");
        assert.ok(Date.now() - started < hook.timeout * 1000, "hook too slow");
      }
    }
  });
});

describe("bin/coworker", () => {
  const launcher = path.join(ROOT, "bin", "coworker");

  test("is an executable POSIX sh launcher", () => {
    const stat = fs.statSync(launcher);
    assert.ok(stat.isFile());
    assert.ok((stat.mode & 0o111) === 0o111, `bin/coworker mode ${(stat.mode & 0o777).toString(8)} is not executable by all`);
    assert.match(fs.readFileSync(launcher, "utf8"), /^#!\/bin\/sh\n/);
  });

  test("runs from an unrelated cwd (resolves scripts relative to itself)", () => {
    const result = spawnSync(launcher, ["help"], { cwd: tmpRoot, env: isolatedEnv, encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^coworker — /);
  });
});

// ================================================================== schemas

/** Walk a JSON schema and collect OpenAI strict-mode violations. */
function strictViolations(schema, where = "$") {
  const problems = [];
  if (!schema || typeof schema !== "object") return [`${where}: not a schema object`];
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const isObject = types.includes("object") || schema.properties !== undefined;
  if (isObject) {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false) problems.push(`${where}: additionalProperties must be false`);
    if (!Array.isArray(schema.required)) problems.push(`${where}: required must be an array`);
    else {
      const required = [...schema.required];
      if (new Set(required).size !== required.length) problems.push(`${where}: duplicate entries in required`);
      if ([...required].sort().join(",") !== [...keys].sort().join(",")) {
        problems.push(`${where}: required [${required.join(", ")}] must list exactly the properties [${keys.join(", ")}]`);
      }
    }
    for (const key of keys) problems.push(...strictViolations(schema.properties[key], `${where}.${key}`));
  }
  if (types.includes("array")) {
    if (!schema.items || Array.isArray(schema.items)) problems.push(`${where}: arrays need a single items schema`);
    else problems.push(...strictViolations(schema.items, `${where}[]`));
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    for (const [index, sub] of (schema[keyword] ?? []).entries()) problems.push(...strictViolations(sub, `${where}.${keyword}[${index}]`));
  }
  for (const keyword of ["$defs", "definitions"]) {
    for (const [key, sub] of Object.entries(schema[keyword] ?? {})) problems.push(...strictViolations(sub, `${where}.${keyword}.${key}`));
  }
  if (!types.length && !schema.anyOf && !schema.$ref && !schema.enum) problems.push(`${where}: missing type`);
  if (schema.enum) {
    const jsonType = (value) => (value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value);
    for (const value of schema.enum) {
      const type = jsonType(value);
      const ok = types.length === 0 || types.includes(type) || (type === "integer" && types.includes("number"));
      if (!ok) problems.push(`${where}: enum value ${JSON.stringify(value)} is not of type ${types.join("|")}`);
    }
  }
  return problems;
}

describe("schemas (OpenAI strict mode)", () => {
  const files = fs.readdirSync(path.join(ROOT, "schemas")).filter((file) => file.endsWith(".json"));

  test("strict-mode checker catches a missing required key and loose objects", () => {
    const bad = { type: "object", properties: { a: { type: "string" }, b: { type: "object", properties: {} } }, required: ["a"] };
    const problems = strictViolations(bad);
    assert.ok(problems.some((problem) => problem.includes("additionalProperties")));
    assert.ok(problems.some((problem) => problem.includes("must list exactly")));
  });

  test("schemas/ has the plan and review schemas", () => {
    assert.ok(files.includes("plan.schema.json"));
    assert.ok(files.includes("review.schema.json"));
  });

  for (const file of files) {
    test(`${file}: valid JSON, top-level object, strict everywhere`, () => {
      const schema = readJson(path.join(ROOT, "schemas", file));
      assert.equal(schema.type, "object", "top-level schema must be an object");
      assert.deepEqual(strictViolations(schema), []);
    });
  }

  test("schema enums match the ledger's vocabulary", async () => {
    const { ASTRA_STATUSES } = await import("../scripts/lib/ledger.mjs");
    const plan = readJson(path.join(ROOT, "schemas", "plan.schema.json"));
    const review = readJson(path.join(ROOT, "schemas", "review.schema.json"));
    for (const [label, schema] of [["plan", plan], ["review", review]]) {
      assert.deepEqual([...schema.properties.prior.items.properties.status.enum].sort(), [...ASTRA_STATUSES].sort(), `${label}: prior.status enum`);
    }
    assert.deepEqual(plan.properties.items.items.properties.severity.enum, ["blocker", "major", "minor"]);
    assert.deepEqual(review.properties.findings.items.properties.severity.enum, ["blocker", "major", "minor"]);
  });

  test("the schema paths the turn code uses exist", async () => {
    const { SCHEMAS } = await import("../scripts/lib/turns.mjs");
    for (const [kind, file] of Object.entries(SCHEMAS)) assert.ok(fs.existsSync(file), `${kind} schema missing at ${file}`);
  });
});

// ================================================================== manifests

describe("manifests", () => {
  const pluginFile = path.join(ROOT, ".claude-plugin", "plugin.json");
  const marketFile = path.join(MARKETPLACE_ROOT, ".claude-plugin", "marketplace.json");

  test("plugin.json and marketplace.json are valid JSON; name and version match", () => {
    const plugin = readJson(pluginFile);
    const market = readJson(marketFile);
    assert.match(plugin.name, /^[a-z0-9][a-z0-9-]*$/, "plugin name must be kebab-case");
    assert.match(plugin.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, "plugin version must be semver");
    assert.ok(plugin.description, "plugin description missing");
    const entry = (market.plugins ?? []).find((candidate) => candidate.name === plugin.name);
    assert.ok(entry, `marketplace.json has no plugin named ${plugin.name}`);
    assert.equal(entry.version, plugin.version, "marketplace version must equal plugin.json version");
    assert.equal(path.resolve(MARKETPLACE_ROOT, entry.source), ROOT, "marketplace source must point at this plugin");
    assert.ok(market.name && market.owner?.name, "marketplace name/owner missing");
  });

  test("package.json version matches plugin.json", () => {
    const pkg = readJson(path.join(ROOT, "package.json"));
    assert.equal(pkg.version, readJson(pluginFile).version);
    assert.equal(pkg.type, "module");
  });

  test(
    "package.json test script works on this Node (no bare directory argument to node --test)",
    () => {
      const script = readJson(path.join(ROOT, "package.json")).scripts?.test ?? "";
      assert.match(script, /node --test/);
      const major = Number(process.versions.node.split(".")[0]);
      const targets = script
        .split(/\s+/)
        .slice(2)
        .filter((word) => word && !word.startsWith("-"))
        .map((word) => word.replace(/^["']|["']$/g, ""));
      assert.ok(targets.length > 0, "test script names no test files");
      for (const target of targets) {
        const full = path.join(ROOT, target);
        const isDir = fs.existsSync(full) && fs.statSync(full).isDirectory();
        assert.ok(!(isDir && major >= 21), `node ${process.versions.node} cannot run a directory argument (${target})`);
      }
    },
  );

  const claude = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 20000 });
  const hasClaude = claude.status === 0 && !process.env.COWORKER_SKIP_CLAUDE_VALIDATE;

  for (const [label, target, strict] of [
    ["plugin (--strict)", ROOT, true],
    ["marketplace", MARKETPLACE_ROOT, false],
  ]) {
    test(`claude plugin validate: ${label}`, { skip: hasClaude ? false : "claude CLI not available" }, () => {
      const args = ["plugin", "validate", target, "--json", ...(strict ? ["--strict"] : [])];
      const result = spawnSync("claude", args, { encoding: "utf8", timeout: 120000 });
      assert.equal(result.status, 0, `claude ${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.success, true);
      assert.deepEqual(report.manifest?.errors ?? [], []);
      assert.deepEqual(report.manifest?.warnings ?? [], []);
      for (const content of report.contents ?? []) {
        assert.deepEqual(content.errors ?? [], [], `${content.file}`);
        assert.deepEqual(content.warnings ?? [], [], `${content.file}`);
      }
    });
  }
});

// ================================================================== docs ⇄ code

describe("protocol.md ⇄ CLI", () => {
  const protocolText = fs.readFileSync(PROTOCOL, "utf8");

  test("documents every exit code the CLI uses", () => {
    const block = cliSource.match(/const EXIT = \{([^}]*)\}/);
    assert.ok(block, "EXIT map not found");
    const codes = [...block[1].matchAll(/:\s*(\d+)/g)].map((match) => match[1]);
    assert.deepEqual([...codes].sort(), ["0", "1", "3", "4", "5", "64", "75"]);
    for (const code of codes) assert.ok(protocolText.includes(`\`${code}\``), `protocol.md does not document exit code ${code}`);
  });

  test("documents the machine-readable status line the CLI prints", () => {
    assert.match(cliSource, /`COWORKER status=\$\{state\}\$\{loop \? ` loop=\$\{loop\}` : ""\} job=/);
    assert.ok(protocolText.includes("COWORKER status=<state> [loop=<state>] job=<id> thread=<name> result=<path>"));
  });

  test("the loop table covers every loop state the code can produce", async () => {
    const turns = fs.readFileSync(path.join(ROOT, "scripts", "lib", "turns.mjs"), "utf8");
    const ledger = fs.readFileSync(path.join(ROOT, "scripts", "lib", "ledger.mjs"), "utf8");
    const states = new Set([
      ...[...turns.matchAll(/loopState = "([a-z_]+)"/g)].map((match) => match[1]),
      ...[...ledger.matchAll(/state = "([a-z_]+)"/g)].map((match) => match[1]),
    ]);
    assert.ok(states.size >= 5, `found only ${[...states]}`);
    for (const state of states) assert.match(protocolText, new RegExp(`^\\| \`${state}\` \\|`, "m"), `loop table lacks ${state}`);
  });

  test("documents every Claude decision the ledger accepts", async () => {
    const { CLAUDE_DECISIONS } = await import("../scripts/lib/ledger.mjs");
    for (const decision of CLAUDE_DECISIONS) assert.ok(protocolText.includes(`\`${decision}\``), `protocol.md lacks decision ${decision}`);
  });
});
