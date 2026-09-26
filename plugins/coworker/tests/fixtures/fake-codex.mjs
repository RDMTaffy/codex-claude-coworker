#!/usr/bin/env node
// Test double for the Codex CLI. Mimics the subset of `codex` the plugin uses:
//   codex --version
//   codex login status
//   codex exec [--json] [-o FILE] [--output-schema FILE] [-m M] [-c k=v]... [-s MODE] [--skip-git-repo-check] -
//   codex exec resume [flags…] <SESSION_ID> -
// Behaviour is steered by env vars so tests can script scenarios:
//   FAKE_CODEX_VERSION   version string (default "codex-cli 0.158.0")
//   FAKE_CODEX_LOGIN     "ok" | "no"                 (default ok)
//   FAKE_CODEX_MODE      ok | fail | outdated | slow | hang | nojson | lost | reconnect | bigline  (default ok)
//                        lost: resume prints "no rollout found" to stderr and exits 1 with no events
//                        reconnect: transient top-level errors, then success
//                        bigline: a ~300 KB Korean agent message written in small chunks
//                        nologin: exits 1 before any event with "Not logged in" on stderr (start failure)
//   FAKE_CODEX_DELAY_MS  delay before the final message in slow mode (default 1500)
//   FAKE_CODEX_REPLY     text of the final agent message (default echoes a summary)
//   FAKE_CODEX_JSON      JSON string written to -o when --output-schema is given
//   FAKE_CODEX_LOG       file to append one JSON line per invocation {argv, stdin, cwd}
//   FAKE_CODEX_BIG_FINAL      bigline mode only: "1" makes the big Korean text the FINAL message (written to -o)
//   FAKE_CODEX_IGNORE_SIGINT  "1" ignores SIGINT (forces the supervisor's SIGKILL escalation)
//   FAKE_CODEX_USAGE          JSON usage object for turn.completed (default 1000 in / 500 cached / 42 out / 7 reasoning)
//   FAKE_CODEX_HELPER_PIDFILE spawn a detached helper process (own process group, like Codex's MCP
//                             helpers) that never exits, and write its pid to this file

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

const argv = process.argv.slice(2);
const env = process.env;

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (argv[0] === "--version") {
  process.stdout.write(`${env.FAKE_CODEX_VERSION ?? "codex-cli 0.158.0"}\n`);
  process.exit(0);
}

if (argv[0] === "login" && argv[1] === "status") {
  if ((env.FAKE_CODEX_LOGIN ?? "ok") === "ok") {
    process.stdout.write("Logged in using ChatGPT\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\n");
  process.exit(1);
}

if (argv[0] === "features" && argv[1] === "list") {
  process.stdout.write("apps  stable  true\nplugins  stable  true\nhooks  stable  true\nmulti_agent  stable  true\n");
  process.exit(0);
}

if (argv[0] === "exec" && argv.includes("--help")) {
  const common = "--json --output-schema <FILE> -o, --output-last-message <FILE> --ignore-user-config --disable <FEATURE> -m, --model";
  if (env.FAKE_CODEX_CAPS === "old") {
    process.stdout.write("Usage: codex exec --json -o, --output-last-message <FILE>\n");
  } else {
    process.stdout.write(`Usage: codex exec ${argv[1] === "resume" ? "resume " : ""}[OPTIONS]\n${common}\n`);
  }
  process.exit(0);
}

if (argv[0] !== "exec") {
  process.stderr.write(`fake-codex: unsupported invocation ${argv.join(" ")}\n`);
  process.exit(2);
}

const isResume = argv[1] === "resume";
let outFile = null;
let schemaFile = null;
const positionals = [];
const valueFlags = new Set(["-o", "--output-last-message", "--output-schema", "-m", "--model", "-c", "--config", "-s", "--sandbox", "-C", "--cd", "-i", "--image", "-p", "--profile", "--disable", "--enable"]);
for (let index = isResume ? 2 : 1; index < argv.length; index += 1) {
  const token = argv[index];
  if (valueFlags.has(token)) {
    const value = argv[index + 1];
    if (token === "-o" || token === "--output-last-message") outFile = value;
    if (token === "--output-schema") schemaFile = value;
    index += 1;
    continue;
  }
  if (token.startsWith("-") && token !== "-") continue;
  positionals.push(token);
}

const stdin = positionals.includes("-") ? readStdin() : "";
const sessionId = isResume ? positionals[0] : crypto.randomUUID();

if (env.FAKE_CODEX_LOG) {
  fs.appendFileSync(env.FAKE_CODEX_LOG, `${JSON.stringify({ argv, stdin, cwd: process.cwd(), sessionId })}\n`);
}

const mode = env.FAKE_CODEX_MODE ?? "ok";

if (env.FAKE_CODEX_IGNORE_SIGINT === "1") process.on("SIGINT", () => {});
if (env.FAKE_CODEX_HELPER_PIDFILE) {
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { detached: true, stdio: "ignore" });
  helper.unref();
  fs.writeFileSync(env.FAKE_CODEX_HELPER_PIDFILE, String(helper.pid));
}

if (mode === "nologin") {
  // Fails before any event, like Codex without credentials; the first stderr line is log noise.
  process.stderr.write("2026-09-26T00:00:00.000000Z  WARN rmcp::transport::worker: transport closed\nError: Not logged in. Run `codex login` to sign in.\n");
  process.exit(1);
}

if (mode === "lost" && isResume) {
  process.stderr.write(`Error: thread/resume failed: no rollout found for thread id ${sessionId} (code -32600)\n`);
  process.exit(1);
}

emit({ type: "thread.started", thread_id: sessionId });
emit({ type: "item.completed", item: { id: "item_0", type: "error", message: "Codex is ignoring 1 unrecognized configuration setting." } });

if (mode === "outdated") {
  const message = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again." } });
  emit({ type: "turn.started" });
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

emit({ type: "turn.started" });
if (mode === "reconnect") {
  for (let attempt = 1; attempt <= 3; attempt += 1) emit({ type: "error", message: `Reconnecting... ${attempt}/5 (stream disconnected)` });
}
emit({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'git status --short'", status: "in_progress" } });
emit({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: "/bin/zsh -lc 'git status --short'", aggregated_output: "", exit_code: 0, status: "completed" } });

const BIG_TEXT = "가나다라마바사아자차카타파하 ".repeat(12000);

async function writeBigLine() {
  const text = BIG_TEXT;
  const line = `${JSON.stringify({ type: "item.completed", item: { id: "item_big", type: "agent_message", text } })}\n`;
  const bytes = Buffer.from(line);
  for (let offset = 0; offset < bytes.length; offset += 4093) {
    process.stdout.write(bytes.subarray(offset, offset + 4093));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function finish() {
  if (mode === "bigline") await writeBigLine();
  if (mode === "fail") {
    const message = "stream disconnected before completion";
    emit({ type: "turn.failed", error: { message } });
    process.exitCode = 1;
    return;
  }
  let text;
  if (schemaFile) {
    text = env.FAKE_CODEX_JSON ?? "{}";
  } else if (mode === "bigline" && env.FAKE_CODEX_BIG_FINAL === "1") {
    text = BIG_TEXT;
  } else {
    text = env.FAKE_CODEX_REPLY ?? `fake reply (resume=${isResume}) to: ${stdin.slice(0, 80).replace(/\s+/g, " ")}`;
  }
  emit({ type: "item.completed", item: { id: "item_2", type: "agent_message", text } });
  if (outFile && mode !== "nojson") fs.writeFileSync(outFile, text);
  const usage = env.FAKE_CODEX_USAGE ? JSON.parse(env.FAKE_CODEX_USAGE) : { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 42, reasoning_output_tokens: 7 };
  emit({ type: "turn.completed", usage });
  process.exitCode = 0;
}

if (mode === "hang") {
  setInterval(() => {}, 1 << 30);
} else if (mode === "slow") {
  setTimeout(finish, Number(env.FAKE_CODEX_DELAY_MS ?? 1500));
} else {
  finish();
}
