// Issue ledger: the canonical, script-owned record of every point raised in a thread and how each
// side answered it. IDs are assigned here (P1… for plan items, R1… for review findings), never by the
// model, so they stay stable across rounds and both sides argue about the same numbered items.
//
// Convergence is computed from the ledger, NOT from Astra's verdict: the loop is done when every
// blocker/major item has a terminal disposition (fixed and verified, conceded, superseded, deferral
// accepted, or decided by the user). That removes the incentive for Claude to "win" approval by
// accepting everything.

import path from "node:path";
import { readJson, stateDir, writeJsonAtomic } from "./state.mjs";

export const CLAUDE_DECISIONS = ["accept", "partial", "reject", "defer", "user"];
export const ASTRA_STATUSES = [
  "fixed_verified",
  "fix_incomplete",
  "conceded",
  "maintained",
  "downgraded",
  "superseded",
  "accepted_deferral",
];

const AFTER_CLAUDE = {
  accept: "addressed",
  partial: "partially_addressed",
  reject: "disputed",
  defer: "deferred",
  user: "user_decided",
};

const AFTER_ASTRA = {
  fixed_verified: "resolved",
  fix_incomplete: "open",
  conceded: "withdrawn",
  maintained: "open",
  downgraded: "open",
  superseded: "superseded",
  accepted_deferral: "deferred_ok",
};

/** Terminal statuses: nothing left for either side to do. */
export const CLOSED = new Set(["resolved", "withdrawn", "superseded", "deferred_ok", "user_decided"]);
const BLOCKING = new Set(["blocker", "major"]);

export function emptyLedger() {
  return { version: 2, counters: { P: 0, R: 0 }, items: [], rounds: [] };
}

export function ledgerPath(projectRoot, thread) {
  return path.join(stateDir(projectRoot), "threads", `${thread}.ledger.json`);
}

export function readLedger(projectRoot, thread) {
  const value = readJson(ledgerPath(projectRoot, thread));
  if (!value || value.__corrupt) return emptyLedger();
  return { ...emptyLedger(), ...value };
}

export function writeLedger(projectRoot, thread, ledger) {
  writeJsonAtomic(ledgerPath(projectRoot, thread), ledger);
}

export function findItem(ledger, id) {
  return ledger.items.find((item) => item.id.toUpperCase() === String(id).trim().toUpperCase());
}

function last(item) {
  return item.history[item.history.length - 1];
}

/** Register new plan items / review findings; returns them (same order) with assigned ids. */
export function addItems(ledger, kind, entries, round) {
  const prefix = kind === "plan" ? "P" : "R";
  const added = [];
  for (const entry of entries ?? []) {
    ledger.counters[prefix] = (ledger.counters[prefix] ?? 0) + 1;
    const where = entry.file
      ? `${entry.file}${entry.line_start != null ? `:${entry.line_start}${entry.line_end != null && entry.line_end !== entry.line_start ? `-${entry.line_end}` : ""}` : ""}`
      : entry.section ?? "";
    const item = {
      id: `${prefix}${ledger.counters[prefix]}`,
      kind,
      severity: entry.severity,
      title: entry.title ?? "",
      where,
      status: "open",
      raisedRound: round,
      maintainedStreak: 0,
      history: [{ round, actor: "astra", event: "raised", status: "open", note: "" }],
      data: entry,
    };
    ledger.items.push(item);
    added.push(item);
  }
  return added;
}

/**
 * Items Claude must answer before the next Astra turn: every non-closed item whose latest move
 * was Astra's (newly raised, maintained, fix_incomplete, downgraded).
 */
export function pendingForClaude(ledger) {
  return ledger.items.filter((item) => !CLOSED.has(item.status) && last(item)?.actor === "astra");
}

/** Items Astra must rule on in its next turn: every non-closed item Claude has answered. */
export function pendingForAstra(ledger) {
  return ledger.items.filter((item) => !CLOSED.has(item.status) && last(item)?.actor === "claude");
}

/**
 * Validate and apply Claude's decisions. Every pending item must be answered, so nothing Astra
 * raised can be silently dropped. Throws before any Codex turn is spent if the file is wrong.
 * @param {Array<{id, decision, rationale, evidence?, change_ref?}>} responses
 */
export function applyClaudeResponses(ledger, responses, round) {
  const errors = [];
  const seen = new Set();
  for (const response of responses ?? []) {
    const item = findItem(ledger, response.id);
    if (item && seen.has(item.id)) errors.push(`${item.id} is answered more than once`);
    if (!item) errors.push(`unknown id "${response.id}"`);
    else if (CLOSED.has(item.status)) errors.push(`${item.id} is already closed (${item.status})`);
    if (!CLAUDE_DECISIONS.includes(response.decision)) {
      errors.push(`invalid decision "${response.decision}" for ${response.id} (use ${CLAUDE_DECISIONS.join("|")})`);
    }
    if (!String(response.rationale ?? "").trim()) errors.push(`${response.id}: rationale is required`);
    if (item) seen.add(item.id);
  }
  const missing = pendingForClaude(ledger).filter((item) => !seen.has(item.id));
  if (missing.length) errors.push(`no decision for: ${missing.map((item) => item.id).join(", ")}`);
  if (errors.length) {
    const error = new Error(`Invalid responses — ${errors.join("; ")}`);
    error.code = "INVALID_RESPONSES";
    throw error;
  }
  for (const response of responses) {
    const item = findItem(ledger, response.id);
    const status = AFTER_CLAUDE[response.decision];
    item.status = status;
    item.history.push({
      round,
      actor: "claude",
      event: response.decision,
      status,
      note: String(response.rationale ?? "").trim(),
      evidence: String(response.evidence ?? "").trim(),
      change_ref: String(response.change_ref ?? "").trim(),
    });
  }
}

/**
 * Apply Astra's rulings on earlier items. Items Astra skipped are NOT auto-resolved; they are
 * returned as `skipped` so the tooling can flag them.
 */
export function applyAstraRulings(ledger, prior, round) {
  const unknown = [];
  const ignored = [];
  const ruled = new Set();
  for (const entry of prior ?? []) {
    const item = findItem(ledger, entry.id);
    if (!item) {
      unknown.push(entry.id);
      continue;
    }
    // Closed items (e.g. decided by the user) are final; a late ruling must not reopen them.
    if (CLOSED.has(item.status)) {
      ignored.push(item.id);
      continue;
    }
    ruled.add(item.id);
    const wasDisputed = item.status === "disputed";
    const status = AFTER_ASTRA[entry.status] ?? "open";
    if (entry.new_severity && entry.new_severity !== item.severity) {
      item.history.push({ round, actor: "astra", event: "severity", status: item.status, note: `${item.severity} → ${entry.new_severity}` });
      item.severity = entry.new_severity;
    }
    item.maintainedStreak = entry.status === "maintained" && wasDisputed ? (item.maintainedStreak ?? 0) + 1 : 0;
    item.status = status;
    item.history.push({ round, actor: "astra", event: entry.status, status, note: String(entry.reason ?? "").trim(), evidence: String(entry.evidence ?? "").trim() });
  }
  const skipped = ledger.items.filter((item) => !CLOSED.has(item.status) && last(item)?.actor === "claude" && !ruled.has(item.id));
  return { unknown, ignored, skipped: skipped.map((item) => item.id) };
}

/**
 * Loop state after an Astra turn.
 *   converged   — no blocking item open; stop and report
 *   deadlock    — a blocking item was disputed and maintained twice in a row; escalate to the user
 *   needs_reply — blocking items still open; Claude answers (fix/dispute/defer) and runs another round
 * `max_rounds`, `stale` and `inconclusive` are layered on by the caller, which knows the round budget,
 * tree fingerprints and the assessment field.
 */
export function convergence(ledger) {
  const open = ledger.items.filter((item) => !CLOSED.has(item.status));
  const blocking = open.filter((item) => BLOCKING.has(item.severity));
  const deadlocked = blocking.filter((item) => (item.maintainedStreak ?? 0) >= 2);
  let state = "converged";
  if (deadlocked.length) state = "deadlock";
  else if (blocking.length) state = "needs_reply";
  return {
    state,
    open: open.map((item) => item.id),
    blocking: blocking.map((item) => item.id),
    deadlocked: deadlocked.map((item) => item.id),
    minorOpen: open.filter((item) => !BLOCKING.has(item.severity)).map((item) => item.id),
  };
}

export function tally(ledger) {
  const counts = {};
  for (const item of ledger.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  const decisions = {};
  for (const item of ledger.items) {
    for (const entry of item.history) {
      if (entry.actor === "claude") decisions[entry.event] = (decisions[entry.event] ?? 0) + 1;
    }
  }
  return { total: ledger.items.length, byStatus: counts, claudeDecisions: decisions };
}

function cell(text, max = 90) {
  const flat = String(text ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Compact ledger table for prompts, transcripts and stdout. */
export function renderLedger(ledger, { onlyOpen = false } = {}) {
  const rows = ledger.items.filter((item) => !onlyOpen || !CLOSED.has(item.status));
  if (!rows.length) return onlyOpen ? "_(no open items)_" : "_(no items)_";
  const out = ["| id | sev | status | title | where | last move |", "|---|---|---|---|---|---|"];
  for (const item of rows) {
    const move = last(item);
    const note = move ? `${move.actor} ${move.event}${move.note ? `: ${move.note}` : ""}` : "";
    out.push(`| ${item.id} | ${item.severity} | ${item.status} | ${cell(item.title)} | ${cell(item.where, 60)} | ${cell(note, 140)} |`);
  }
  return out.join("\n");
}

/** Claude's responses rendered for Astra's prompt. */
export function renderResponsesForAstra(ledger, responses) {
  return responses
    .map((response) => {
      const item = findItem(ledger, response.id);
      const parts = [`- ${item?.id ?? response.id} (${item?.severity ?? "?"}: ${cell(item?.title, 80)}) → **${response.decision}**: ${String(response.rationale).trim()}`];
      if (String(response.evidence ?? "").trim()) parts.push(`  evidence: ${String(response.evidence).trim()}`);
      if (String(response.change_ref ?? "").trim()) parts.push(`  change: ${String(response.change_ref).trim()}`);
      return parts.join("\n");
    })
    .join("\n");
}
