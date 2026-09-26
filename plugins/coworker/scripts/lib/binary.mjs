// Codex CLI binary discovery.
//
// Several Codex binaries commonly coexist on one machine (Homebrew, npm, the copy bundled inside
// ChatGPT.app / Codex.app). Newer models such as gpt-6-astra are rejected by older CLIs with
// "requires a newer version of Codex", so we probe every candidate and pick the highest version.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_BUNDLE_CANDIDATES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];

const WELL_KNOWN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".npm-global", "bin"),
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".bun", "bin"),
  path.join(os.homedir(), ".volta", "bin"),
];

/** Parse "codex-cli 0.158.0-alpha.2" → {major, minor, patch, pre: ["alpha", 2], raw}. */
export function parseVersion(text) {
  const match = String(text ?? "").match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  const pre = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre,
    raw: match[0],
  };
}

/** SemVer precedence: 1 if a > b, -1 if a < b, 0 if equal. A release outranks its prereleases. */
export function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.pre[index];
    const r = right.pre[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const lNum = typeof l === "number";
    const rNum = typeof r === "number";
    if (lNum && rNum) return l > r ? 1 : -1;
    if (lNum) return -1;
    if (rNum) return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

function isExecutableFile(candidate) {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(envPath) {
  return String(envPath ?? "")
    .split(path.delimiter)
    .filter(Boolean);
}

/** Every distinct place a codex binary might live, in priority order (explicit overrides first). */
export function candidatePaths({ explicit = [], envPath = process.env.PATH, platform = process.platform } = {}) {
  const exe = platform === "win32" ? "codex.exe" : "codex";
  const ordered = [
    ...explicit.filter(Boolean),
    ...(platform === "darwin" ? APP_BUNDLE_CANDIDATES : []),
    ...pathEntries(envPath).map((dir) => path.join(dir, exe)),
    ...WELL_KNOWN_DIRS.map((dir) => path.join(dir, exe)),
  ];
  const seen = new Set();
  const result = [];
  for (const candidate of ordered) {
    let key = candidate;
    try {
      key = fs.realpathSync(candidate);
    } catch {
      // keep the unresolved path; it is filtered out below if it does not exist
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

export function probeVersion(binary, { timeoutMs = 15000 } = {}) {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, error: result.error?.message ?? (result.stderr || "").trim() };
  }
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  const version = parseVersion(text);
  return version ? { ok: true, version, text } : { ok: false, error: `unrecognized version output: ${text}` };
}

/**
 * Probe all candidates and return {chosen, candidates}. An explicit override (config/env) wins
 * outright when it works, so users can pin a binary; otherwise the highest version wins.
 */
export function discoverCodex({ explicit = [], envPath, platform, probe = probeVersion } = {}) {
  const candidates = [];
  for (const candidate of candidatePaths({ explicit, envPath, platform })) {
    if (!isExecutableFile(candidate)) continue;
    const info = probe(candidate);
    candidates.push({
      path: candidate,
      explicit: explicit.includes(candidate),
      ok: info.ok,
      version: info.ok ? info.version.raw : null,
      parsed: info.ok ? info.version : null,
      error: info.ok ? null : info.error,
    });
  }
  const working = candidates.filter((entry) => entry.ok);
  const pinned = working.find((entry) => entry.explicit);
  let chosen = pinned ?? null;
  if (!chosen) {
    for (const entry of working) {
      if (!chosen || compareVersions(entry.parsed, chosen.parsed) > 0) chosen = entry;
    }
  }
  return { chosen, candidates };
}
