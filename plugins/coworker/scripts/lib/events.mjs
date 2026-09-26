// Interpretation of `codex exec --json` JSONL events.

const NOISE = [
  /unrecognized configuration setting/i,
  /Skill descriptions were shortened/i,
  /Model metadata for .* not found/i,
];

/** Incremental line splitter that tolerates partial trailing lines while a file is still being written. */
export class LineBuffer {
  constructor() {
    this.pending = "";
  }

  push(chunk) {
    this.pending += chunk;
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    return parts.filter((line) => line.trim().length > 0);
  }

  flush() {
    const rest = this.pending.trim();
    this.pending = "";
    return rest ? [rest] : [];
  }
}

export function parseEventLine(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && typeof value.type === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Codex nests API errors as a JSON string inside `message`; dig out the human part. */
export function extractErrorMessage(raw) {
  const text = typeof raw === "string" ? raw : raw?.message ?? JSON.stringify(raw);
  try {
    const nested = JSON.parse(text);
    return nested?.error?.message ?? nested?.message ?? text;
  } catch {
    return text;
  }
}

export function classifyError(message) {
  const text = String(message ?? "");
  if (/requires a newer version of Codex/i.test(text)) {
    return {
      code: "codex_outdated",
      hint: "The selected Codex CLI is too old for this model. Upgrade it (`brew upgrade codex` or `npm i -g @openai/codex@latest`) or pin a newer binary with COWORKER_CODEX_BIN / config `codexBin`. Run `/coworker:status` to see every detected binary.",
    };
  }
  if (/usage limit|rate limit|too many requests|\b429\b|quota/i.test(text)) {
    return { code: "usage_limit", hint: "Codex usage limit reached on the ChatGPT plan. Wait for the window to reset or lower effort (`--effort medium`)." };
  }
  if (/not logged in|unauthori[sz]ed|\b401\b|authentication|login required|refresh token/i.test(text)) {
    return { code: "auth", hint: "Codex is not authenticated. Run `codex login` in a terminal (ChatGPT sign-in)." };
  }
  if (/model.*(not found|does not exist|not supported|unknown)|unsupported model/i.test(text)) {
    return { code: "model", hint: "The model name was rejected. Check `model` in the coworker config or pass --model." };
  }
  return { code: "codex_error", hint: null };
}

function unwrapShell(command) {
  const text = String(command ?? "");
  const match = text.match(/^\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return (match ? match[2] : text).replace(/\s+/g, " ").trim();
}

function clip(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Fold events into a summary: {sessionId, messages, usage, failed, errors, commands}.
 * Also returns human progress lines for each event via onProgress.
 */
export function createEventFolder({ onProgress = () => {} } = {}) {
  const state = {
    sessionId: null,
    messages: [],
    usage: null,
    completed: false,
    failed: false,
    failure: null,
    errors: [],
    commands: 0,
  };

  function fold(event) {
    switch (event.type) {
      case "thread.started":
        state.sessionId = event.thread_id ?? state.sessionId;
        break;
      case "turn.started":
        onProgress("Astra is thinking…");
        break;
      case "item.started":
        if (event.item?.type === "command_execution") {
          state.commands += 1;
          onProgress(`$ ${clip(unwrapShell(event.item.command), 110)}`);
        }
        break;
      case "item.completed": {
        const item = event.item ?? {};
        if (item.type === "agent_message" && item.text) {
          state.messages.push(item.text);
          // Structured (schema) answers are rendered in the result; don't echo raw JSON as progress.
          if (!/^\s*[{[]/.test(item.text)) onProgress(`💬 ${clip(item.text, 110)}`);
        } else if (item.type === "error" && item.message) {
          if (!NOISE.some((pattern) => pattern.test(item.message))) {
            state.errors.push(item.message);
            onProgress(`⚠ ${clip(item.message, 110)}`);
          }
        } else if (item.type === "web_search" && item.query) {
          onProgress(`🔎 ${clip(item.query, 160)}`);
        } else if (item.type === "file_change") {
          onProgress("✎ (attempted file change — sandbox is read-only)");
        }
        break;
      }
      case "turn.completed":
        state.completed = true;
        state.usage = event.usage ?? null;
        break;
      case "turn.failed":
        state.failed = true;
        state.failure = extractErrorMessage(event.error);
        onProgress(`✖ ${clip(state.failure, 300)}`);
        break;
      case "error":
        // Top-level errors are transient retries ("Reconnecting... 2/5"); keep them as log lines only.
        state.errors.push(extractErrorMessage(event.message ?? event));
        break;
      default:
        break;
    }
    return state;
  }

  return { state, fold };
}
