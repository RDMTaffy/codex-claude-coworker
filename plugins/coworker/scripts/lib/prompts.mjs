// Prompt assembly for Astra turns.
//
// The full role contract goes out on a thread's first turn. Every later turn carries a short digest of
// the rules that matter most under pushback (resumed sessions can be compacted, and the contract is the
// first thing to fade), plus the current ledger so ids never depend on the model's memory.

export const INLINE_DIFF_LIMIT = 80 * 1024;
const INLINE_ATTACHMENT_LIMIT = 120 * 1024;

const LANG_NAMES = { ko: "Korean (한국어)", en: "English", ja: "Japanese (日本語)", zh: "Chinese (中文)" };

export function detectLang(text) {
  const sample = String(text ?? "");
  if (/[가-힣]/.test(sample)) return "ko";
  if (/[぀-ヿ]/.test(sample)) return "ja";
  if (/[一-鿿]/.test(sample)) return "zh";
  return "en";
}

export function languageLine(lang) {
  return `Write prose in ${LANG_NAMES[lang] ?? lang}. Keep code, identifiers, file paths, commands, and JSON keys/enum values exactly as they are (English).`;
}

export function roleContract(lang) {
  return `<role>
You are GPT-6 Astra, an independent senior reviewer working with Claude (Anthropic's Claude Code agent).
Claude is the lead engineer: it writes the code, runs tests, talks to the user, and makes the final call with
the user. Claude is also the author of what you review and wants to finish — treat its claims as hypotheses.
You cannot see Claude's chat with the user; you know only this thread and the repository.
Your sandbox is read-only: read files and run read-only commands (grep, git log/show/diff, type-checkers,
quick experiments) to verify claims. You never edit files.
</role>

<rules>
1. Verify before asserting. Mark every item basis=verified (you read or ran it) or basis=inferred.
2. Precision over volume. Report what you would block on or strongly request in a human review. No style
   nits unless asked. Approving with zero findings is a good outcome — never invent issues to seem useful.
3. Severity: blocker = the plan cannot work, or the change ships a bug, data loss, or security hole;
   major = likely bug or costly rework; minor = real but safe to defer.
4. Disagreement is not evidence. When Claude disputes a point, re-read the cited code first. Concede only
   if Claude shows new evidence or a flaw in your reasoning, and name it. Otherwise maintain the item and
   restate the concrete failure scenario. Lowering severity to be agreeable counts as conceding — say so.
5. If settling a question needs something you cannot run here (writes, network, test suites), put the exact
   command and expected result in verify_by. Claude will run it and report back.
6. Stay inside the stated goal. Problems outside the change are scope=pre_existing and never blocker unless
   the change makes them worse. Items the user decided are closed.
7. Start from the files and diff you are given; open other files only to confirm a specific claim. Do not
   open .env*, credential/secret files, or .coworker/ paths you were not explicitly given.
8. Claude cannot see your tool output: put the decisive evidence (command + result, or exact lines) in your
   answer. No praise, no filler, no restating what Claude wrote.
9. ${languageLine(lang)}
</rules>`;
}

/** Short reminder for resumed turns. */
export function turnDigest({ phase, round, maxRounds, awaiting = [], lang }) {
  const parts = [`phase: ${phase}${round ? ` · round ${round}/${maxRounds}` : ""} · you are the read-only reviewer; Claude edits.`];
  parts.push("Disagreement is not evidence: concede only on new evidence or a shown flaw in your reasoning (name it); otherwise maintain and restate the failure scenario. Lowering severity to be agreeable counts as conceding.");
  parts.push("Checks you cannot run go in verify_by. Stay on the stated target; out-of-scope problems are pre_existing.");
  if (awaiting.length) parts.push(`Items awaiting your ruling: ${awaiting.join(", ")}.`);
  parts.push(languageLine(lang));
  return `<turn_digest>\n${parts.join("\n")}\n</turn_digest>`;
}

function fence(content, info = "") {
  const text = String(content);
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((match) => match[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${info}\n${text}${text.endsWith("\n") ? "" : "\n"}${ticks}`;
}

export function renderAttachments(attachments = []) {
  if (!attachments.length) return "";
  const blocks = attachments.map((attachment) => {
    const text = attachment.content.length > INLINE_ATTACHMENT_LIMIT
      ? `${attachment.content.slice(0, INLINE_ATTACHMENT_LIMIT)}\n… [truncated — read the full file at ${attachment.path}]`
      : attachment.content;
    return `<attachment path="${attachment.path}">\n${fence(text)}\n</attachment>`;
  });
  return `<attachments>\n${blocks.join("\n")}\n</attachments>`;
}

function claudeMessageBlock(message) {
  const text = String(message ?? "").trim();
  return text ? `<claude_message>\n${text}\n</claude_message>` : "";
}

function ledgerBlocks({ ledgerText, responsesText }) {
  const out = [];
  if (responsesText) out.push(`<claude_responses>\n${responsesText}\n</claude_responses>`);
  if (ledgerText) out.push(`<ledger note="authoritative ids and statuses, maintained by the tooling">\n${ledgerText}\n</ledger>`);
  return out;
}

function assemble(parts) {
  return `${parts.filter((part) => part && String(part).trim()).join("\n\n")}\n`;
}

const PRIOR_RULES = `In "prior", give a ruling for EVERY item listed as awaiting your ruling:
  fixed_verified   Claude's change fixes it (you checked the current code/plan)
  fix_incomplete   the change does not fully fix it — say what is still wrong
  conceded         Claude's evidence/argument shows you were wrong — name what changed your mind
  maintained       still a problem — restate the concrete failure scenario and counter-evidence
  downgraded       still stands but at a lower severity (set new_severity) — this is a partial concession
  superseded       no longer applies because of other changes
  accepted_deferral Claude's deferral to later work is acceptable
Use new_severity only with downgraded (otherwise null).`;

// ------------------------------------------------------------------ ask

export function buildAskPrompt({ firstTurn, lang, message, attachments }) {
  return assemble([
    firstTurn ? roleContract(lang) : turnDigest({ phase: "consultation", lang }),
    claudeMessageBlock(message),
    renderAttachments(attachments),
    "Answer Claude directly. If Claude's framing or assumptions are wrong, say that first. Separate what you verified from what you infer.",
  ]);
}

// ------------------------------------------------------------------ plan

export function buildPlanPrompt({ firstTurn, lang, round, maxRounds, awaiting, message, attachments, ledgerText, responsesText }) {
  const task = round <= 1
    ? `<task>
Claude drafted the implementation plan below and wants your critique BEFORE any code is written.
Check the plan against the actual code it touches. Look for:
- wrong assumptions about the existing code, APIs, data, or environment
- missing requirements, edge/error/empty/concurrency paths, migrations, rollback
- risks: data loss, security, compatibility, performance cliffs
- a materially simpler or safer approach (approach.alternative; "" if none)
- a verification strategy that would actually catch regressions
Each problem is one entry in "items" (kind = issue | missing | risk); the tooling assigns ids.
"prior" must be [] on this first round.
verdict: approve (implement as written) | approve_with_changes (only minor/obvious adjustments needed) |
revise (blocker/major items must be addressed first) | rethink (the approach itself is wrong) |
inconclusive (you could not assess it — explain in limitations; set assessment accordingly).
</task>`
    : `<task>
Round ${round}. Claude revised the plan and answered your earlier items (claude_responses; ledger below).
${PRIOR_RULES}
In "items", list only NEW problems (introduced by the revision or previously missed and material). Do not repeat
ledger items. The plan below is the current revision.
</task>`;
  return assemble([
    firstTurn ? roleContract(lang) : turnDigest({ phase: "plan critique", round, maxRounds, awaiting, lang }),
    task,
    ...ledgerBlocks({ ledgerText, responsesText }),
    claudeMessageBlock(message),
    renderAttachments(attachments),
  ]);
}

// ------------------------------------------------------------------ review

export function reviewTargetBlock({ label, stat, diff, diffPath, delta, deltaPath, files }) {
  const out = [`<review_target>`, `Target: ${label}`, `Snapshot diff file (frozen when this round started): ${diffPath}`];
  if (files?.length) out.push(`Changed files (${files.length}): ${files.slice(0, 60).join(", ")}${files.length > 60 ? ", …" : ""}`);
  if (stat?.trim()) out.push(`Stat:\n${fence(stat.trim())}`);
  if (delta !== undefined) {
    if (delta && delta.length <= INLINE_DIFF_LIMIT) {
      out.push(`Changes since your last review round (verify fixes here first):\n${fence(delta, "diff")}`);
    } else if (delta) {
      out.push(`Changes since your last round are ${Math.round(delta.length / 1024)} KB — read ${deltaPath}.`);
    } else {
      out.push("No code changed since your last review round.");
    }
    out.push(`The full cumulative diff is in the snapshot file above if you need it.`);
  } else if (diff && diff.length <= INLINE_DIFF_LIMIT) {
    out.push(`Diff:\n${fence(diff, "diff")}`);
  } else if (diff) {
    out.push(`The diff is ${Math.round(diff.length / 1024)} KB — too large to inline. Read it from the snapshot file (e.g. sed -n '1,400p') and open changed files directly.`);
  } else {
    out.push("Review the listed files as they are now.");
  }
  out.push(`</review_target>`);
  return out.join("\n");
}

export function buildReviewPrompt({ firstTurn, lang, round, maxRounds, awaiting, message, attachments, focus, target, ledgerText, responsesText, hasPlan }) {
  const planLine = hasPlan
    ? `An agreed plan / decisions log is attached. Settled decisions are closed unless the implementation reveals new evidence; flag unexplained material deviations as category "plan_deviation".\n`
    : "";
  const focusLine = focus ? `Focus requested for this review: ${focus}\n` : "";
  const task = round <= 1
    ? `<task>
Review the change for defects that matter: correctness, security, data loss, concurrency, error handling,
compatibility, missing or wrong tests, and design problems that will cost real effort later.
${planLine}${focusLine}Each finding: file + line range in the CURRENT files (null lines if not applicable), the failure scenario
(trigger → actual behavior → impact), evidence, basis, confidence, recommendation, verify_by ("" if none).
List what you reviewed and did not review in coverage. "prior" must be [] on this first round.
verdict: approve | approve_with_changes (only minor, obvious fixes) | request_changes | inconclusive.
assessment: complete | partial | unable (explain in limitations).
</task>`
    : `<task>
Round ${round}. Claude answered your findings (claude_responses; ledger below) and may have changed the code.
${PRIOR_RULES}
For fixed items, check the fix in the current code. In "findings", list only NEW problems: regressions introduced
by the fixes (scope=fix_regression) or material issues you missed before. New minor issues on unchanged code are
not worth another round — mention them only if they are real bugs.
${planLine}${focusLine}</task>`;
  return assemble([
    firstTurn ? roleContract(lang) : turnDigest({ phase: "code review", round, maxRounds, awaiting, lang }),
    task,
    ...ledgerBlocks({ ledgerText, responsesText }),
    claudeMessageBlock(message),
    reviewTargetBlock(target),
    renderAttachments(attachments),
  ]);
}

// ------------------------------------------------------------------ debate (blind proposals)

const DEBATE_CONTRACT = `<debate_rules>
This is a blind design debate. Claude has already written and sealed its own proposal; you will see it
only in the next round. Do not look for it: do not open .coworker/ paths or other files you were not given.
Decide on the merits against the brief's success criteria. Options in the brief are unranked; add options
if the brief missed a good one.
</debate_rules>`;

export function buildDebateOpenPrompt({ lang, brief, attachments }) {
  return assemble([
    roleContract(lang),
    DEBATE_CONTRACT,
    `<brief>\n${String(brief).trim()}\n</brief>`,
    renderAttachments(attachments),
    `<task>
Give your own proposal:
1. Recommendation (one option, or a new one) and the decisive reasons, scored against each success criterion.
2. The strongest case against your recommendation.
3. Key risks and how you would detect them early.
4. What evidence would change your mind.
Verify claims about the codebase before relying on them.
</task>`,
  ]);
}

export function buildDebateCrossPrompt({ lang, claudeProposal, claudeCritique }) {
  return assemble([
    turnDigest({ phase: "debate — cross-examination", lang }),
    `<claude_proposal note="sealed before Claude saw your proposal">\n${String(claudeProposal).trim()}\n</claude_proposal>`,
    claudeCritique ? `<claude_critique_of_your_proposal>\n${String(claudeCritique).trim()}\n</claude_critique_of_your_proposal>` : "",
    `<task>
1. Steelman Claude's proposal: its strongest version, in 3–5 sentences.
2. Critique it against the brief's success criteria — concrete failure cases, not generalities.
3. Answer Claude's critique of your proposal point by point: concede (and say what convinced you) or rebut with evidence.
4. State whether your recommendation changed, and why. Do not converge just to agree.
</task>`,
  ]);
}

export function buildDebateFinalPrompt({ lang }) {
  return assemble([
    turnDigest({ phase: "debate — final position", lang }),
    `<task>
Claude has sealed its final position; you will not see it before answering. Give your final position:
first line exactly "PICK: <option name>", second line "CONFIDENCE: high|medium|low", then the decisive
reasons (max 5 bullets), the main residual risk, and what evidence would change your mind.
Offer a hybrid only if you genuinely believe it is best, not as a compromise.
</task>`,
  ]);
}
