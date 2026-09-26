// Layered configuration: defaults < global file < project file < environment < CLI flags.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const KINDS = ["ask", "plan", "review", "rereview", "debate"];

// Defaults are deliberately moderate: on a ChatGPT plan every resumed turn re-sends the thread, and in
// probes xhigh/ultra found nothing that high missed on typical diffs. Raise per project when needed.
export const DEFAULTS = Object.freeze({
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

export function globalConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "coworker", "config.json");
}

export function findProjectRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return path.resolve(cwd);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

function merge(base, override) {
  if (!override || typeof override !== "object") return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object") {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function envOverrides(env) {
  const out = {};
  if (env.COWORKER_MODEL) out.model = env.COWORKER_MODEL;
  if (env.COWORKER_LANG) out.lang = env.COWORKER_LANG;
  if (env.COWORKER_CODEX_BIN) out.codexBin = env.COWORKER_CODEX_BIN;
  if (env.COWORKER_EFFORT) out.effort = Object.fromEntries(KINDS.map((kind) => [kind, env.COWORKER_EFFORT]));
  for (const kind of KINDS) {
    const value = env[`COWORKER_EFFORT_${kind.toUpperCase()}`];
    if (value) out.effort = { ...(out.effort ?? {}), [kind]: value };
  }
  if (env.COWORKER_WAIT_BUDGET) out.waitBudgetSec = Number(env.COWORKER_WAIT_BUDGET);
  if (env.COWORKER_TIMEOUT) out.timeoutSec = Number(env.COWORKER_TIMEOUT);
  if (env.COWORKER_ISOLATION) out.isolation = env.COWORKER_ISOLATION;
  if (env.COWORKER_WEB_SEARCH) out.webSearch = !/^(0|false|no|off|disabled)$/i.test(env.COWORKER_WEB_SEARCH);
  return out;
}

export function validateConfig(config) {
  if (typeof config.effort === "string") config.effort = Object.fromEntries(KINDS.map((kind) => [kind, config.effort]));
  for (const kind of KINDS) {
    if (!EFFORTS.includes(config.effort[kind])) {
      throw new Error(`Invalid effort "${config.effort[kind]}" for ${kind}. Use one of: ${EFFORTS.join(", ")}.`);
    }
  }
  if (typeof config.maxRounds === "number") config.maxRounds = { plan: config.maxRounds, review: config.maxRounds };
  for (const kind of ["plan", "review"]) {
    if (!Number.isInteger(config.maxRounds?.[kind]) || config.maxRounds[kind] < 1) {
      throw new Error(`Invalid maxRounds.${kind}: ${config.maxRounds?.[kind]}`);
    }
  }
  for (const key of ["waitBudgetSec", "timeoutSec", "jobRetentionDays"]) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      throw new Error(`Invalid ${key}: ${config[key]}`);
    }
  }
  if (!["strict", "inherit"].includes(config.isolation)) throw new Error(`Invalid isolation "${config.isolation}" (strict|inherit).`);
  if (!["chatgpt", "any"].includes(config.authMethod)) throw new Error(`Invalid authMethod "${config.authMethod}" (chatgpt|any).`);
  return config;
}

/**
 * @returns {{config: object, sources: {global: string, project: string}, projectRoot: string}}
 */
export function loadConfig({ cwd = process.cwd(), env = process.env, projectRoot } = {}) {
  const root = projectRoot ?? findProjectRoot(cwd);
  const globalFile = globalConfigPath();
  const projectFile = path.join(root, ".coworker", "config.json");
  let config = merge(structuredClone(DEFAULTS), readJsonFile(globalFile));
  config = merge(config, readJsonFile(projectFile));
  config = merge(config, envOverrides(env));
  return { config: validateConfig(config), sources: { global: globalFile, project: projectFile }, projectRoot: root };
}

export function writeConfigKey(file, key, value) {
  const current = readJsonFile(file) ?? {};
  current[key] = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(current, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return current;
}
