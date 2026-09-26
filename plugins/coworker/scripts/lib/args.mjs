// Minimal, strict argv parser. Unknown flags are errors so that typos surface instead of being
// silently forwarded to Codex as part of the message.

export class UsageError extends Error {}

/**
 * @param {string[]} argv
 * @param {{booleans?: string[], strings?: string[], arrays?: string[], aliases?: Record<string,string>}} spec
 * @returns {{flags: Record<string, any>, positionals: string[]}}
 */
export function parseArgs(argv, spec = {}) {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const arrays = new Set(spec.arrays ?? []);
  const aliases = spec.aliases ?? {};
  const flags = {};
  const positionals = [];

  for (const name of arrays) flags[name] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    let name = token.replace(/^--?/, "");
    let inline;
    if (eq !== -1) {
      name = token.slice(0, eq).replace(/^--?/, "");
      inline = token.slice(eq + 1);
    }
    name = aliases[name] ?? name;

    if (booleans.has(name)) {
      if (inline !== undefined) {
        flags[name] = !/^(false|0|no|off)$/i.test(inline);
      } else {
        flags[name] = true;
      }
      continue;
    }
    if (strings.has(name) || arrays.has(name)) {
      let value = inline;
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || (value.startsWith("--") && value.length > 2)) {
          throw new UsageError(`Missing value for --${name}.`);
        }
        index += 1;
      }
      if (arrays.has(name)) {
        flags[name].push(value);
      } else {
        flags[name] = value;
      }
      continue;
    }
    throw new UsageError(`Unknown option: ${token}`);
  }
  return { flags, positionals };
}

/**
 * Claude Code passes "$ARGUMENTS" as ONE argv element. Split it shell-style (quotes respected,
 * no expansion) so `/coworker:review --base main focus text` works whether the args arrive split
 * or joined.
 */
export function splitShellWords(text) {
  const words = [];
  let current = "";
  let quote = null;
  let hasToken = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < text.length && /["\\$`]/.test(text[index + 1])) {
        current += text[index + 1];
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1];
      index += 1;
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        words.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote) throw new UsageError("Unterminated quote in arguments.");
  if (hasToken) words.push(current);
  return words;
}

/**
 * Skills inject `coworker <cmd> "$ARGUMENTS"`, so everything the user typed arrives as ONE argv element
 * ("" when nothing was typed). Expand that single element shell-style; leave already-split argv alone.
 */
export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const text = argv[0].trim();
    if (text === "") return [];
    // A single "--flag=value with spaces" token came from a real shell, not from "$ARGUMENTS".
    if (/^--[A-Za-z][\w-]*=/.test(text) && !/\s--?[A-Za-z]/.test(text)) return [text];
    return /\s/.test(text) ? splitShellWords(text) : [text];
  }
  return argv;
}
