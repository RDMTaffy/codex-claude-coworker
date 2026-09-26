// Codex CLI invocation: capability probing (cached per binary), binary choice, and argv building.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareVersions, discoverCodex, parseVersion } from "./binary.mjs";

// Features a read-only reviewer never needs. Each one is only disabled if the chosen binary knows it:
// `--disable <unknown>` is a hard error in Codex.
export const REVIEWER_DISABLED_FEATURES = [
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "hooks",
  "skill_mcp_dependency_install",
  "tool_suggest",
  "multi_agent",
  "goals",
];

function cacheFile() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "coworker", "codex-capabilities.json");
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // cache is an optimization only
  }
}

function run(bin, args, timeout = 20000) {
  const result = spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, windowsHide: true });
  return { ok: !result.error && result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, error: result.error };
}

function fingerprint(bin) {
  const real = fs.realpathSync(bin);
  const stat = fs.statSync(real);
  return `${real}|${stat.size}|${Math.round(stat.mtimeMs)}`;
}

/** Probe what a binary supports. Cached by realpath+size+mtime so app updates invalidate it. */
export function capabilities(bin, { refresh = false } = {}) {
  let key;
  try {
    key = fingerprint(bin);
  } catch (error) {
    return { ok: false, error: `not found: ${error.message}` };
  }
  const cache = readCache();
  if (!refresh && cache[key]) return cache[key];

  const version = run(bin, ["--version"]);
  const parsed = version.ok ? parseVersion(version.out) : null;
  const execHelp = run(bin, ["exec", "--help"]);
  const resumeHelp = run(bin, ["exec", "resume", "--help"]);
  const features = run(bin, ["features", "list"]);
  const has = (help, flag) => help.ok && help.out.includes(flag);
  const caps = {
    ok: Boolean(parsed),
    version: parsed?.raw ?? null,
    exec: {
      json: has(execHelp, "--json"),
      outputSchema: has(execHelp, "--output-schema"),
      lastMessage: has(execHelp, "--output-last-message"),
      ignoreUserConfig: has(execHelp, "--ignore-user-config"),
      disable: has(execHelp, "--disable"),
    },
    resume: {
      json: has(resumeHelp, "--json"),
      outputSchema: has(resumeHelp, "--output-schema"),
      lastMessage: has(resumeHelp, "--output-last-message"),
      ignoreUserConfig: has(resumeHelp, "--ignore-user-config"),
      disable: has(resumeHelp, "--disable"),
    },
    features: features.ok
      ? features.out.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^[a-z0-9_.]+$/.test(name))
      : [],
    probedAt: new Date().toISOString(),
  };
  caps.usable = caps.ok && caps.exec.json && caps.exec.lastMessage && caps.exec.outputSchema && caps.resume.json && caps.resume.lastMessage && caps.resume.outputSchema;
  if (!caps.usable) {
    caps.missing = [
      !caps.ok && "--version",
      !caps.exec.json && "exec --json",
      !caps.exec.lastMessage && "exec -o",
      !caps.exec.outputSchema && "exec --output-schema",
      !caps.resume.json && "exec resume --json",
      !caps.resume.lastMessage && "exec resume -o",
      !caps.resume.outputSchema && "exec resume --output-schema",
    ].filter(Boolean);
  }
  cache[key] = caps;
  writeCache(cache);
  return caps;
}

/**
 * Choose the binary for a turn.
 *   1. explicit override (COWORKER_CODEX_BIN / config codexBin) — used as-is if usable
 *   2. the binary pinned by an existing thread — never silently swapped; if it vanished we only move
 *      to a binary of equal or higher version and report the switch
 *   3. the highest-version usable candidate (new models such as gpt-6-astra need new CLIs)
 */
export function chooseBinary({ config, pinned } = {}) {
  const explicit = [process.env.COWORKER_CODEX_BIN, config?.codexBin].filter(Boolean);
  // Version probing goes through the capability cache: spawning a 200+ MB binary per call adds up.
  const cachedProbe = (bin) => {
    const caps = capabilities(bin);
    return caps.ok ? { ok: true, version: parseVersion(caps.version), text: caps.version } : { ok: false, error: caps.error ?? "unusable" };
  };
  const discovery = discoverCodex({ explicit, probe: cachedProbe });
  const usable = [];
  for (const candidate of discovery.candidates) {
    candidate.caps = candidate.ok ? capabilities(candidate.path) : null;
    if (candidate.caps?.usable) usable.push(candidate);
  }
  const explicitHit = usable.find((candidate) => candidate.explicit);
  if (explicitHit) return { chosen: explicitHit, candidates: discovery.candidates, reason: "explicit override" };

  if (pinned?.path) {
    const same = usable.find((candidate) => candidate.path === pinned.path);
    if (same) return { chosen: same, candidates: discovery.candidates, reason: "pinned by thread" };
    const upgrade = usable
      .filter((candidate) => compareVersions(candidate.version, pinned.version) >= 0)
      .sort((a, b) => compareVersions(b.version, a.version))[0];
    if (upgrade) {
      return {
        chosen: upgrade,
        candidates: discovery.candidates,
        reason: "pinned binary unavailable",
        warning: `The thread's pinned Codex (${pinned.path} ${pinned.version}) is gone; using ${upgrade.path} ${upgrade.version}.`,
      };
    }
    return { chosen: null, candidates: discovery.candidates, reason: `pinned binary ${pinned.path} (${pinned.version}) unavailable and no equal-or-newer replacement` };
  }

  const best = usable.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
  return { chosen: best, candidates: discovery.candidates, reason: best ? "highest usable version" : "no usable Codex CLI found" };
}

/**
 * Build argv for one turn. The prompt always arrives on stdin (`-`): prompts that start with "- "
 * break argv parsing, and large prompts hit ARG_MAX.
 */
export function buildArgs({ resumeSessionId, model, effort, schemaPath, lastPath, isolation, caps, authMethod, webSearch = true }) {
  const args = ["exec"];
  if (resumeSessionId) args.push("resume");
  const surface = resumeSessionId ? caps.resume : caps.exec;
  args.push("--json", "--skip-git-repo-check");
  if (isolation === "strict" && surface.ignoreUserConfig) args.push("--ignore-user-config");
  if (model) args.push("-m", model);
  args.push("-c", `model_reasoning_effort="${effort}"`);
  args.push("-c", 'sandbox_mode="read-only"');
  args.push("-c", 'approval_policy="never"');
  if (authMethod === "chatgpt") args.push("-c", 'forced_login_method="chatgpt"');
  if (webSearch === false) args.push("-c", 'web_search="disabled"');
  if (isolation === "strict" && surface.disable) {
    const known = new Set(caps.features ?? []);
    for (const feature of REVIEWER_DISABLED_FEATURES) {
      if (known.has(feature)) args.push("--disable", feature);
    }
  }
  if (schemaPath) args.push("--output-schema", schemaPath);
  args.push("-o", lastPath);
  if (resumeSessionId) args.push(resumeSessionId);
  args.push("-");
  return args;
}

export function loginStatus(bin) {
  const result = run(bin, ["login", "status"]);
  const text = result.out.trim();
  return { ok: result.ok && /logged in/i.test(text), text: text || result.error?.message || "unknown", chatgpt: /chatgpt/i.test(text) };
}
