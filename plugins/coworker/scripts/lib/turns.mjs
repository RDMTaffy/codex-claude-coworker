// Turn preparation (foreground, under the thread lock) and finalization (supervisor, still under the
// lock). This is where threads, rounds, the ledger, review snapshots and transcripts come together.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgs, chooseBinary } from "./codex.mjs";
import { EFFORTS } from "./config.mjs";
import { changedFiles, diffBetween, diffStat, repoTop, resolveTarget, snapshotTree } from "./git.mjs";
import {
  addItems,
  applyAstraRulings,
  applyClaudeResponses,
  convergence,
  emptyLedger,
  pendingForAstra,
  pendingForClaude,
  readLedger,
  renderLedger,
  renderResponsesForAstra,
  writeLedger,
} from "./ledger.mjs";
import {
  buildAskPrompt,
  buildDebateCrossPrompt,
  buildDebateFinalPrompt,
  buildDebateOpenPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  detectLang,
} from "./prompts.mjs";
import { renderPlan, renderReview, renderUsage } from "./render.mjs";
import {
  acquireThreadLock,
  appendTranscript,
  assertThreadName,
  jobPaths,
  newJobId,
  readThread,
  releaseThreadLock,
  threadPaths,
  writeJsonAtomic,
  writeThread,
} from "./state.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(HERE, "..", "..");
export const SCHEMAS = {
  plan: path.join(PLUGIN_ROOT, "schemas", "plan.schema.json"),
  review: path.join(PLUGIN_ROOT, "schemas", "review.schema.json"),
};

const ATTACHMENT_MAX_BYTES = 256 * 1024;

export class TurnError extends Error {
  constructor(message, code = "USAGE") {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ inputs

/**
 * Resolve a user-supplied relative path. Skills write files under the project root, but Claude's shell
 * may have `cd`-ed elsewhere: prefer the shell cwd when the file exists there, else the project root.
 */
export function resolveInput(file, cwd, projectRoot) {
  if (path.isAbsolute(file)) return file;
  const fromCwd = path.resolve(cwd, file);
  if (fs.existsSync(fromCwd) || !projectRoot) return fromCwd;
  const fromRoot = path.resolve(projectRoot, file);
  return fs.existsSync(fromRoot) ? fromRoot : fromCwd;
}

function readText(file, label) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new TurnError(`Cannot read ${label} "${file}": ${error.code ?? error.message}`);
  }
}

export function loadMessage(flags, cwd, projectRoot) {
  if (flags["message-file"]) return readText(resolveInput(flags["message-file"], cwd, projectRoot), "--message-file");
  if (flags.message) return flags.message;
  return "";
}

export function loadAttachments(list, cwd, projectRoot) {
  return (list ?? []).map((entry) => {
    const abs = resolveInput(entry, cwd, projectRoot);
    let buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch (error) {
      throw new TurnError(`Cannot read --attach "${entry}": ${error.code ?? error.message}`);
    }
    if (buffer.subarray(0, 8192).includes(0)) throw new TurnError(`--attach "${entry}" looks binary; attach text files only.`);
    if (buffer.length > ATTACHMENT_MAX_BYTES) {
      throw new TurnError(`--attach "${entry}" is ${Math.round(buffer.length / 1024)} KB (max ${ATTACHMENT_MAX_BYTES / 1024} KB). Mention its path in the message instead — Astra can read repository files.`);
    }
    return {
      path: path.relative(projectRoot ?? cwd, abs) || abs,
      abs,
      content: buffer.toString("utf8"),
      sha256: crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16),
    };
  });
}

export function loadResponses(file, cwd, projectRoot) {
  if (!file) return null;
  const text = readText(resolveInput(file, cwd, projectRoot), "--responses");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TurnError(`--responses is not valid JSON: ${error.message}`);
  }
  const list = Array.isArray(value) ? value : value?.responses;
  if (!Array.isArray(list) || list.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new TurnError('--responses must be a JSON array (or {"responses": [...]}) of objects {id, decision, rationale, evidence?, change_ref?}.');
  }
  return list;
}

// ------------------------------------------------------------------ sealing (anti-anchoring)

function sealedDir(projectRoot, thread) {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const key = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 12);
  return path.join(base, "coworker", "sealed", key, thread);
}

/**
 * Move Claude's pre-committed text out of the repository (Astra's sandbox can read the repo), so it
 * cannot be read before it is deliberately revealed.
 */
export function seal(projectRoot, thread, source, name) {
  const dir = sealedDir(projectRoot, thread);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, name);
  // Retry after a failed turn: the source was already moved here, so reuse the sealed copy.
  if (!fs.existsSync(source) && fs.existsSync(target)) return target;
  const content = readText(source, name);
  if (!content.trim()) throw new TurnError(`${source} is empty.`);
  fs.writeFileSync(target, content, { mode: 0o600 });
  fs.rmSync(source, { force: true });
  return target;
}

// ------------------------------------------------------------------ preparation

function resolveLang(configured, message) {
  if (configured && configured !== "auto") return configured;
  return detectLang(message);
}

function pickEffort({ flags, config, kind, round }) {
  if (flags.effort) return flags.effort;
  if (flags.deep) return "xhigh";
  if (kind === "review" && round > 1) return config.effort.rereview ?? config.effort.review;
  if (kind === "debate") return config.effort.debate ?? config.effort.plan;
  return config.effort[kind];
}

function reviewTargetFromFlags(flags, previous) {
  const paths = flags.paths ?? [];
  if (flags.commit) return { mode: "commit", sha: flags.commit, paths };
  if (flags.base) return { mode: "base", ref: flags.base, paths };
  if (flags.uncommitted) return { mode: "uncommitted", paths };
  if (paths.length && !previous) return { mode: "paths", paths };
  if (previous) return { ...previous, paths: paths.length ? paths : previous.paths ?? [] };
  return { mode: "uncommitted", paths };
}

/**
 * Prepare and launch one turn. Takes the thread lock first so the thread file, ledger and round
 * counters cannot change underneath us, and hands the held lock to the job.
 * @returns {Promise<{jobId, thread, kind, round, maxRounds, effort, model, warning}>}
 */
export async function startTurn({ kind, flags, config, projectRoot, cwd, gitCwd = projectRoot, launch }) {
  const threadName = assertThreadName(String(flags.thread ?? defaultThread(kind)).toLowerCase());
  const jobId = newJobId(kind);
  acquireThreadLock(projectRoot, threadName, { jobId, launcherPid: process.pid });
  let launched = false;
  try {
    // --new only archives once every check below has passed, so a rejected turn never loses a thread.
    const existing = readThread(projectRoot, threadName);
    const archiveFirst = Boolean(flags.new && existing);
    let thread = archiveFirst ? null : existing;
    const realRoot = fs.realpathSync(projectRoot);
    if (thread?.cwd && thread.cwd !== realRoot) {
      throw new TurnError(`Thread "${threadName}" belongs to ${thread.cwd}, not ${realRoot}. Use a different --thread or --new.`);
    }

    const message = loadMessage(flags, cwd, projectRoot);
    const attachments = loadAttachments(flags.attach, cwd, projectRoot);
    const binary = chooseBinary({ config, pinned: thread?.binary });
    if (!binary.chosen) {
      throw new TurnError(`No usable Codex CLI: ${binary.reason}. Run \`coworker status\` for details.`, "START_FAILED");
    }
    const initialized = Boolean(thread?.initialized && thread?.sessionId);
    const model = flags.model ?? thread?.model ?? config.model;
    const briefText = kind === "debate" && flags.brief ? readText(resolveInput(flags.brief, cwd, projectRoot), "--brief") : "";
    const lang = thread?.lang ?? resolveLang(flags.lang ?? config.lang, message || briefText || attachments[0]?.content || "");
    const round = (thread?.rounds?.[kind] ?? 0) + 1;
    const maxRounds = Number(flags["max-rounds"] ?? config.maxRounds?.[kind] ?? 99);
    if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new TurnError(`--max-rounds must be a positive integer, got "${flags["max-rounds"]}".`);
    // Only rounds that produced a usable, non-stale verdict count against the budget.
    const budgetUsed = thread?.budgetRounds?.[kind] ?? 0;
    if ((kind === "plan" || kind === "review") && budgetUsed + 1 > maxRounds && !flags["extra-round"]) {
      throw new TurnError(
        `Round ${round} would exceed maxRounds=${maxRounds} for ${kind} on thread "${threadName}". ` +
          "Hitting the limit is NOT approval: report the open items to the user, and only continue with --extra-round if the user agrees.",
        "ROUND_LIMIT",
      );
    }
    const effort = pickEffort({ flags, config, kind, round });
    const timeoutSec = Number(flags.timeout ?? config.timeoutSec);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || timeoutSec > 86400) {
      throw new TurnError(`--timeout must be seconds in (0, 86400], got "${flags.timeout ?? config.timeoutSec}".`);
    }
    if (flags.effort && !EFFORTS.includes(flags.effort)) throw new TurnError(`--effort must be one of ${EFFORTS.join(", ")}.`);

    // Ledger and Claude's answers (plan/review only).
    const ledger = (kind === "plan" || kind === "review") && !archiveFirst ? readLedger(projectRoot, threadName) : emptyLedger();
    const responses = loadResponses(flags.responses, cwd, projectRoot);
    const preview = structuredClone(ledger);
    if (responses) {
      applyClaudeResponses(preview, responses, round);
    } else if ((kind === "plan" || kind === "review") && pendingForClaude(ledger).length) {
      const ids = pendingForClaude(ledger).map((item) => item.id);
      throw new TurnError(
        `Answer every open item before the next round: ${ids.join(", ")}. Write a responses JSON array of ` +
          '{"id","decision":"accept|partial|reject|defer|user","rationale","evidence","change_ref"} and pass --responses <file>.',
        "NEEDS_RESPONSES",
      );
    }
    const awaiting = pendingForAstra(preview).map((item) => item.id);
    const ledgerText = preview.items.length ? renderLedger(preview) : "";
    const responsesText = responses?.length ? renderResponsesForAstra(preview, responses) : "";

    const paths = jobPaths(projectRoot, jobId);
    const ensureJobDir = () => fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    const retryNote = initialized && thread?.lastFailed ? "(Retry: my previous message may not have reached you — if it did, answer this one instead.)\n\n" : "";
    const messageForAstra = retryNote + message;
    const extraMeta = {};
    let prompt;
    let schemaPath = null;

    if (kind === "ask") {
      if (!message.trim() && !attachments.length) throw new TurnError("ask needs --message-file or --message.");
      if (flags["claude-view"]) extraMeta.claudeView = seal(projectRoot, threadName, resolveInput(flags["claude-view"], cwd, projectRoot), `view-${path.basename(flags["claude-view"])}`);
      prompt = buildAskPrompt({ firstTurn: !initialized, lang, message: messageForAstra, attachments });
    } else if (kind === "plan") {
      if (!message.trim() && !attachments.length) throw new TurnError("plan needs the plan text: --message-file and/or --attach <plan.md>.");
      schemaPath = SCHEMAS.plan;
      prompt = buildPlanPrompt({ firstTurn: !initialized, lang, round, maxRounds, awaiting, message: messageForAstra, attachments, ledgerText, responsesText });
    } else if (kind === "review") {
      const targetSpec = reviewTargetFromFlags(flags, thread?.lastTarget);
      let target;
      try {
        target = resolveTarget(gitCwd, targetSpec);
      } catch (error) {
        throw new TurnError(`Review target problem: ${error.message}`);
      }
      let diff = "";
      let stat = "";
      let files = target.paths;
      if (target.base && target.head) {
        diff = diffBetween(gitCwd, target.base, target.head, target.paths);
        stat = diffStat(gitCwd, target.base, target.head, target.paths);
        files = changedFiles(gitCwd, target.base, target.head, target.paths);
        if (!diff.trim() && round === 1) throw new TurnError(`Nothing to review: ${target.label} is empty.`, "NOTHING_TO_REVIEW");
      }
      ensureJobDir();
      fs.writeFileSync(paths.diff, diff, { mode: 0o600 });
      let delta;
      if (round > 1 && target.live && thread?.lastReviewTree && target.head) {
        delta = diffBetween(gitCwd, thread.lastReviewTree, target.head, target.paths);
        fs.writeFileSync(paths.delta, delta, { mode: 0o600 });
      }
      const hasPlan = Boolean(flags["plan-file"]) || attachments.some((attachment) => /plan|decision/i.test(path.basename(attachment.path)));
      if (flags["plan-file"]) attachments.unshift(...loadAttachments([flags["plan-file"]], cwd, projectRoot));
      schemaPath = SCHEMAS.review;
      prompt = buildReviewPrompt({
        firstTurn: !initialized,
        lang,
        round,
        maxRounds,
        awaiting,
        message: messageForAstra,
        attachments,
        focus: flags.focus,
        target: { label: target.label, stat, diff, diffPath: paths.diff, delta, deltaPath: paths.delta, files },
        ledgerText,
        responsesText,
        hasPlan,
      });
      extraMeta.target = { ...targetSpec, label: target.label, base: target.base, head: target.head, live: target.live, files: files.slice(0, 200), fileCount: files.length };
      extraMeta.reviewCwd = gitCwd;
      // Full list for the always-mode Stop gate's coverage check (meta keeps only the first 200).
      extraMeta.target.repoTop = target.base || target.head ? repoTop(gitCwd) : null;
      ensureJobDir();
      fs.writeFileSync(path.join(paths.dir, "target-files.txt"), `${files.join("\n")}\n`, { mode: 0o600 });
    } else if (kind === "debate") {
      const stage = flags.stage;
      const debate = thread?.debate ?? {};
      if (stage === "open") {
        if (initialized) throw new TurnError(`Thread "${threadName}" already has history; a blind debate needs a fresh thread (use --new).`);
        if (!flags.brief || !flags["claude-proposal"]) {
          throw new TurnError("debate --stage open needs --brief <file> AND --claude-proposal <file> (write your own proposal BEFORE seeing Astra's).");
        }
        extraMeta.debate = { stage, proposal: seal(projectRoot, threadName, resolveInput(flags["claude-proposal"], cwd, projectRoot), "claude-proposal.md"), brief: briefText };
        extraMeta.transcriptClaude = `**Brief:**\n\n${briefText.trim()}\n\n_(Claude's own proposal is sealed until the cross stage.)_`;
        prompt = buildDebateOpenPrompt({ lang, brief: briefText, attachments });
      } else if (stage === "cross") {
        if (!debate.proposal || !debate.done?.includes("open")) throw new TurnError("Run --stage open first.");
        if (!message.trim()) throw new TurnError("debate --stage cross needs --message-file with YOUR steelman + critique of Astra's proposal.");
        const revealed = readText(debate.proposal, "sealed proposal");
        extraMeta.debate = { stage };
        extraMeta.transcriptClaude = `**Claude's sealed proposal (revealed now):**\n\n${revealed.trim()}\n\n**Claude's critique of Astra's proposal:**\n\n${message.trim()}`;
        prompt = buildDebateCrossPrompt({ lang, claudeProposal: revealed, claudeCritique: message });
      } else if (stage === "final") {
        if (!debate.done?.includes("cross")) throw new TurnError("Run --stage cross first.");
        if (!flags["claude-final"]) throw new TurnError("debate --stage final needs --claude-final <file> (your final position, written BEFORE reading Astra's).");
        extraMeta.debate = { stage, claudeFinal: seal(projectRoot, threadName, resolveInput(flags["claude-final"], cwd, projectRoot), "claude-final.md") };
        extraMeta.transcriptClaude = "_(Claude's final position is sealed; it appears next to Astra's below.)_";
        prompt = buildDebateFinalPrompt({ lang });
      } else {
        throw new TurnError("debate needs --stage open|cross|final.");
      }
    } else {
      throw new TurnError(`Unknown turn kind: ${kind}`);
    }

    if (responses) {
      ensureJobDir();
      writeJsonAtomic(paths.responses, responses);
    }
    const caps = binary.chosen.caps;
    const args = buildArgs({
      resumeSessionId: initialized ? thread.sessionId : null,
      model,
      effort,
      schemaPath,
      lastPath: paths.last,
      isolation: flags.isolation ?? config.isolation,
      caps,
      authMethod: config.authMethod,
      webSearch: config.webSearch,
    });

    if (archiveFirst) archiveThread(projectRoot, threadName);
    // Create/refresh the thread record while we hold the lock (single writer until launch).
    const now = new Date().toISOString();
    const record = thread ?? {
      name: threadName,
      cwd: realRoot,
      createdAt: now,
      initialized: false,
      sessionId: null,
      droppedSessions: [],
      binary: { path: binary.chosen.path, version: binary.chosen.version },
      model,
      lang,
      rounds: {},
      turns: [],
      usageTotals: { input: 0, cached: 0, output: 0, seconds: 0, turns: 0 },
    };
    if (!record.initialized) {
      record.binary = { path: binary.chosen.path, version: binary.chosen.version };
      record.model = model;
      record.lang = lang;
    }
    if (binary.warning) record.binary = { path: binary.chosen.path, version: binary.chosen.version };
    record.activeJobId = jobId;
    record.updatedAt = now;
    writeThread(projectRoot, threadName, record);

    const job = await launch({
      jobId,
      projectRoot,
      thread: threadName,
      kind,
      prompt,
      lockHeld: true,
      codex: { bin: binary.chosen.path, args, cwd: realRoot },
      timeoutSec,
      meta: {
        round,
        maxRounds,
        effort,
        model,
        lang,
        schemaPath,
        initializedBefore: initialized,
        binary: { path: binary.chosen.path, version: binary.chosen.version },
        message,
        attachments: attachments.map(({ path: p, sha256 }) => ({ path: p, sha256 })),
        hasResponses: Boolean(responses),
        ...extraMeta,
      },
    });
    launched = true;
    return { jobId: job.jobId, thread: threadName, kind, round, maxRounds, effort, model, warning: binary.warning ?? null, binary: binary.chosen };
  } finally {
    if (!launched) {
      const paths = jobPaths(projectRoot, jobId);
      // A job that never reached launchJob leaves no trace; one that failed inside it keeps its status for diagnosis.
      if (!fs.existsSync(paths.status)) fs.rmSync(paths.dir, { recursive: true, force: true });
      const current = readThread(projectRoot, threadName);
      if (current?.activeJobId === jobId) writeThread(projectRoot, threadName, { ...current, activeJobId: null });
      releaseThreadLock(projectRoot, threadName, jobId);
    }
  }
}

export function defaultThread(kind) {
  return { ask: "ask", plan: "plan", review: "review", debate: "debate" }[kind] ?? kind;
}

export function archiveThread(projectRoot, name) {
  const paths = threadPaths(projectRoot, name);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = [];
  for (const file of [paths.meta, paths.transcript, path.join(path.dirname(paths.meta), `${name}.ledger.json`)]) {
    if (fs.existsSync(file)) {
      const target = `${file}.${stamp}.bak`;
      fs.renameSync(file, target);
      archived.push(target);
    }
  }
  return archived;
}

// ------------------------------------------------------------------ finalization (supervisor)

const SUCCESS = new Set(["succeeded", "invalid_output"]);

function header(meta, outcome) {
  const who = meta.kind === "review" ? "code review" : meta.kind === "plan" ? "plan critique" : meta.kind === "debate" ? `debate · ${meta.debate?.stage}` : "consultation";
  return `## Astra ${who} · thread \`${meta.thread}\` · round ${meta.round} · ${meta.model}/${meta.effort} · ${renderUsage(outcome.usage, outcome.elapsedMs)}`;
}

function failureText(outcome) {
  const lines = [`**Turn ${outcome.state}.** ${outcome.error ?? ""}`.trim()];
  if (outcome.hint) lines.push(`Hint: ${outcome.hint}`);
  if (outcome.deliveryUnknown) {
    lines.push("Delivery unknown: Astra's session may already contain this message. Do NOT resend blindly — rerun the same command once; the retry is labeled as such for Astra.");
  }
  if (outcome.state === "session_lost") lines.push("Start a fresh thread with --new and include a short recap (the transcript file has the history).");
  return lines.join("\n");
}

export function finalizeTurn({ meta, paths, outcome, lastText }) {
  const { projectRoot, thread: threadName, kind, round } = meta;
  const thread = readThread(projectRoot, threadName) ?? { name: threadName, rounds: {}, turns: [], usageTotals: { input: 0, cached: 0, output: 0, seconds: 0, turns: 0 }, droppedSessions: [] };
  const success = SUCCESS.has(outcome.state);
  const now = new Date().toISOString();
  const warnings = [];

  // Codex (0.158+) reports CUMULATIVE session usage on resumed turns. Convert to this turn's delta when
  // the numbers only grew since the last recorded total; otherwise treat them as per-turn (older CLIs).
  const rawUsage = outcome.usage ?? null;
  let turnUsage = rawUsage;
  const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];
  const previous = thread.lastSessionUsage;
  if (rawUsage && meta.initializedBefore && previous && outcome.sessionId && outcome.sessionId === thread.sessionId) {
    const grew = (rawUsage.input_tokens ?? 0) > (previous.input_tokens ?? 0);
    if (grew && USAGE_KEYS.every((key) => (rawUsage[key] ?? 0) >= (previous[key] ?? 0))) {
      turnUsage = Object.fromEntries(USAGE_KEYS.map((key) => [key, (rawUsage[key] ?? 0) - (previous[key] ?? 0)]));
    }
  }
  outcome.usage = turnUsage;

  if (success) {
    if (!thread.initialized) {
      thread.initialized = true;
      thread.sessionId = outcome.sessionId;
    } else if (outcome.sessionId && outcome.sessionId !== thread.sessionId) {
      warnings.push(`Codex reported session ${outcome.sessionId}, expected ${thread.sessionId}.`);
    }
    if (outcome.state === "succeeded") thread.rounds = { ...(thread.rounds ?? {}), [kind]: (thread.rounds?.[kind] ?? 0) + 1 };
    if (rawUsage) thread.lastSessionUsage = rawUsage;
    thread.lastFailed = null;
  } else {
    if (!thread.initialized && outcome.sessionId) thread.droppedSessions = [...(thread.droppedSessions ?? []), outcome.sessionId];
    thread.lastFailed = { jobId: meta.jobId, state: outcome.state, at: now };
  }
  if (outcome.usage) {
    const totals = thread.usageTotals ?? { input: 0, cached: 0, output: 0, seconds: 0, turns: 0 };
    totals.input += outcome.usage.input_tokens ?? 0;
    totals.cached += outcome.usage.cached_input_tokens ?? 0;
    totals.output += outcome.usage.output_tokens ?? 0;
    totals.seconds += Math.round((outcome.elapsedMs ?? 0) / 1000);
    totals.turns += 1;
    thread.usageTotals = totals;
  }

  let body;
  let loop = null;
  const resultJson = { kind, round, state: outcome.state, jobId: meta.jobId, thread: threadName };

  if (outcome.state === "succeeded" && (kind === "plan" || kind === "review")) {
    const parsed = JSON.parse(lastText);
    const ledger = readLedger(projectRoot, threadName);
    if (meta.hasResponses) {
      const responses = JSON.parse(fs.readFileSync(paths.responses, "utf8"));
      applyClaudeResponses(ledger, responses, round);
    }
    const { unknown, skipped, ignored } = applyAstraRulings(ledger, parsed.prior, round);
    const added = addItems(ledger, kind, kind === "plan" ? parsed.items : parsed.findings, round);
    const conv = convergence(ledger);
    let loopState = conv.state;
    let stale = false;
    let staleCheckFailed = false;
    if (kind === "review" && meta.target?.live && meta.target.head) {
      try {
        const now = snapshotTree(meta.reviewCwd ?? meta.codex.cwd);
        stale = meta.target.paths?.length
          ? changedFiles(meta.reviewCwd ?? meta.codex.cwd, meta.target.head, now, meta.target.paths).length > 0
          : now !== meta.target.head;
      } catch (error) {
        // Unknown is not "unchanged": never let a failed check turn into an approval.
        staleCheckFailed = true;
        warnings.push(`Could not re-check the working tree after the review (${String(error.message ?? error).slice(0, 200)}); treating this round as inconclusive.`);
      }
    }
    // Rounds that produced a trustworthy (non-stale) verdict consume the round budget; a stale or
    // unverifiable round must be re-run, so it does not.
    const countsTowardBudget = !stale && !staleCheckFailed;
    const budgetUsed = (thread.budgetRounds?.[kind] ?? 0) + (countsTowardBudget ? 1 : 0);
    thread.budgetRounds = { ...(thread.budgetRounds ?? {}), [kind]: budgetUsed };
    if (stale) loopState = "stale";
    else if (staleCheckFailed) loopState = "inconclusive";
    else if (parsed.assessment !== "complete" && loopState === "converged") loopState = "inconclusive";
    else if (loopState === "needs_reply" && budgetUsed >= meta.maxRounds) loopState = "max_rounds";
    if (skipped.length) warnings.push(`Astra gave no ruling for: ${skipped.join(", ")} (left open).`);
    if (unknown.length) warnings.push(`Astra referenced unknown ids: ${unknown.join(", ")} (ignored).`);
    if (ignored.length) warnings.push(`Astra ruled on already-closed items: ${ignored.join(", ")} (kept closed).`);
    ledger.rounds = [...(ledger.rounds ?? []), { round, kind, jobId: meta.jobId, verdict: parsed.verdict, assessment: parsed.assessment, loopState }];
    writeLedger(projectRoot, threadName, ledger);
    if (kind === "review") {
      if (meta.target?.live && !stale && !staleCheckFailed) thread.lastReviewTree = meta.target.head;
      thread.lastTarget = { mode: meta.target.mode, ref: meta.target.ref, sha: meta.target.sha, paths: meta.target.paths };
    }
    loop = { ...conv, state: loopState, stale, round, budgetUsed, maxRounds: meta.maxRounds };
    const rendered = kind === "plan" ? renderPlan(parsed, added, ledger) : renderReview(parsed, added, ledger);
    body = [rendered, "", "#### Ledger", renderLedger(ledger), "", loopBlock(loop, ledger)].join("\n");
    Object.assign(resultJson, { verdict: parsed.verdict, assessment: parsed.assessment, added: added.map((item) => item.id), skipped, unknown, loop, parsed });
  } else if (outcome.state === "succeeded" && kind === "debate") {
    const stage = meta.debate?.stage;
    thread.debate = { ...(thread.debate ?? {}), ...(meta.debate ?? {}), done: [...new Set([...(thread.debate?.done ?? []), stage])] };
    if (stage === "open") {
      thread.debate.brief = meta.debate.brief;
      body = `${lastText.trim()}\n\n_Your sealed proposal stays hidden from Astra until --stage cross._`;
    } else if (stage === "final") {
      const claudeFinal = fs.readFileSync(meta.debate.claudeFinal, "utf8");
      const pick = (text) => (text.match(/^\s*PICK:\s*(.+)$/im)?.[1] ?? "").trim();
      const astraPick = pick(lastText);
      const claudePick = pick(claudeFinal);
      const same = astraPick && claudePick && astraPick.toLowerCase() === claudePick.toLowerCase();
      body = [
        "### Claude's final position (sealed before Astra answered)",
        claudeFinal.trim(),
        "",
        "### Astra's final position",
        lastText.trim(),
        "",
        `**Picks:** Claude = \`${claudePick || "?"}\` · Astra = \`${astraPick || "?"}\` → ${same ? "AGREE" : "DIFFER — present both positions to the user neutrally, with Claude's recommendation labeled as Claude's."}`,
      ].join("\n");
      resultJson.picks = { claude: claudePick, astra: astraPick, agree: Boolean(same) };
    } else {
      body = lastText.trim();
    }
  } else if (outcome.state === "succeeded") {
    body = lastText.trim();
    if (meta.claudeView) {
      body = `### Claude's pre-registered view (sealed before asking)\n${fs.readFileSync(meta.claudeView, "utf8").trim()}\n\n### Astra\n${body}`;
    }
  } else if (outcome.state === "invalid_output") {
    body = `${failureText(outcome)}\n\nRaw output:\n\n${String(lastText ?? "").slice(0, 4000)}`;
  } else {
    body = failureText(outcome);
  }

  if (warnings.length) body += `\n\n> ⚠ ${warnings.join("\n> ⚠ ")}`;
  const result = `${header(meta, outcome)}\n\n${body}\n`;
  fs.writeFileSync(paths.result, result);
  writeJsonAtomic(paths.resultJson, { ...resultJson, warnings, usage: outcome.usage, elapsedMs: outcome.elapsedMs });

  const quote = (text) => text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n");
  const claudeSide = [
    meta.transcriptClaude ?? "",
    meta.message?.trim() && !meta.transcriptClaude ? quote(meta.message.trim()) : "",
    meta.hasResponses ? `Responses:\n\n${quote(fs.readFileSync(paths.responses, "utf8").trim())}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  appendTranscript(
    projectRoot,
    threadName,
    `\n---\n\n## ${kind} round ${round} · ${now} · ${meta.model}/${meta.effort} · job ${meta.jobId}\n\n### Claude → Astra\n\n${claudeSide || "_(see attachments / target)_"}\n\n### Astra → Claude\n\n${body}\n`,
  );

  thread.turns = [...(thread.turns ?? []), { jobId: meta.jobId, kind, round, state: outcome.state, effort: meta.effort, finishedAt: now, elapsedMs: outcome.elapsedMs, usage: outcome.usage ?? null }].slice(-200);
  thread.activeJobId = null;
  thread.updatedAt = now;
  writeThread(projectRoot, threadName, thread);
  return { resultPath: paths.result, loop, warnings };
}

function loopBlock(loop, ledger) {
  const meaning = {
    converged: "No blocker/major item is open. Stop the loop and report (minor open items can be fixed or listed).",
    needs_reply: "Blocker/major items are open. Verify each, fix or dispute with evidence, write responses JSON, and run the next round.",
    deadlock: "The same blocker/major item was disputed and maintained twice. Stop arguing: run a decisive experiment if possible, otherwise ask the user.",
    max_rounds: "Round budget used up with blocker/major items open. This is NOT approval: report open items and ask the user how to proceed.",
    stale: "The working tree changed while Astra was reviewing, so this round is not an approval. Stop editing during reviews and run another round.",
    inconclusive: "Astra could not fully assess the target (see limitations). Not an approval: address the limitation or tell the user what was not reviewed.",
  };
  return [
    `#### Loop state: \`${loop.state}\` (round ${loop.round} · budget ${loop.budgetUsed}/${loop.maxRounds})`,
    meaning[loop.state] ?? "",
    `- blocking open: ${loop.blocking.join(", ") || "none"}`,
    `- minor open: ${loop.minorOpen.join(", ") || "none"}`,
    loop.deadlocked.length ? `- deadlocked: ${loop.deadlocked.join(", ")}` : "",
    `- total items: ${ledger.items.length}`,
  ]
    .filter(Boolean)
    .join("\n");
}
