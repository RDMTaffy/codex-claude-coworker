// Render Astra's structured output (plan/review) and ledger state as Markdown.

const SEVERITY_ICON = { blocker: "🔴", major: "🟠", minor: "🟡" };

function lines(text) {
  return String(text ?? "").trim();
}

function location(finding) {
  if (!finding.file) return "";
  if (finding.line_start == null) return finding.file;
  const end = finding.line_end != null && finding.line_end !== finding.line_start ? `-${finding.line_end}` : "";
  return `${finding.file}:${finding.line_start}${end}`;
}

function renderPrior(prior, ledgerIndex) {
  if (!prior?.length) return [];
  const out = ["", "#### Earlier items"];
  for (const entry of prior) {
    const title = ledgerIndex.get(entry.id.toUpperCase())?.title ?? "";
    const sev = entry.new_severity ? ` (severity → ${entry.new_severity})` : "";
    out.push(`- **${entry.id}** ${title ? `_${title}_ ` : ""}→ \`${entry.status}\`${sev}: ${lines(entry.reason)}`);
    if (lines(entry.evidence)) out.push(`  - evidence: ${lines(entry.evidence)}`);
  }
  return out;
}

function renderQuestions(questions) {
  if (!questions?.length) return [];
  const out = ["", "#### Questions"];
  for (const question of questions) {
    out.push(`- [to ${question.to}${question.blocking ? ", blocking" : ""}] ${lines(question.text)}`);
  }
  return out;
}

function renderList(title, items) {
  if (!items?.length) return [];
  return ["", `#### ${title}`, ...items.map((item) => `- ${lines(item)}`)];
}

/**
 * @param {object} result parsed review JSON
 * @param {Array<{id:string}>} added ledger items created from result.findings (same order)
 */
export function renderReview(result, added, ledger) {
  const index = new Map(ledger.items.map((item) => [item.id.toUpperCase(), item]));
  const out = [
    `### Astra review — verdict: \`${result.verdict}\` · assessment: \`${result.assessment}\``,
    "",
    lines(result.summary),
  ];
  out.push(...renderPrior(result.prior, index));
  if (result.findings?.length) {
    out.push("", "#### New findings");
    result.findings.forEach((finding, position) => {
      const id = added[position]?.id ?? "?";
      out.push(
        "",
        `**${id}** ${SEVERITY_ICON[finding.severity] ?? ""} ${finding.severity} · ${finding.category} · ${finding.scope} — ${lines(finding.title)}`,
      );
      if (location(finding)) out.push(`- where: \`${location(finding)}\``);
      out.push(`- failure: ${lines(finding.failure_scenario)}`);
      out.push(`- evidence (${finding.basis}, confidence ${finding.confidence})${lines(finding.evidence) ? `: ${lines(finding.evidence)}` : ""}`);
      out.push(`- fix: ${lines(finding.recommendation)}`);
      if (lines(finding.verify_by)) out.push(`- verify_by: ${lines(finding.verify_by)}`);
    });
  } else {
    out.push("", "_No new findings._");
  }
  out.push(...renderQuestions(result.questions));
  out.push(...renderList("Limitations", result.limitations));
  if (result.coverage?.not_reviewed?.length) out.push(...renderList("Not reviewed", result.coverage.not_reviewed));
  return out.join("\n");
}

export function renderPlan(result, added, ledger) {
  const index = new Map(ledger.items.map((item) => [item.id.toUpperCase(), item]));
  const out = [
    `### Astra plan critique — verdict: \`${result.verdict}\` · assessment: \`${result.assessment}\``,
    "",
    lines(result.summary),
    "",
    `**Approach:** \`${result.approach?.assessment}\` — ${lines(result.approach?.reason)}`,
  ];
  if (lines(result.approach?.alternative)) out.push(`**Alternative:** ${lines(result.approach.alternative)}`);
  out.push(...renderPrior(result.prior, index));
  if (result.items?.length) {
    out.push("", "#### New items");
    result.items.forEach((item, position) => {
      const id = added[position]?.id ?? "?";
      out.push(
        "",
        `**${id}** ${SEVERITY_ICON[item.severity] ?? ""} ${item.severity} · ${item.kind}${item.section ? ` · ${item.section}` : ""} — ${lines(item.title)}`,
      );
      out.push(`- problem: ${lines(item.problem)}`);
      out.push(`- evidence (${item.basis}, confidence ${item.confidence})${lines(item.evidence) ? `: ${lines(item.evidence)}` : ""}`);
      out.push(`- suggestion: ${lines(item.suggestion)}`);
      if (lines(item.verify_by)) out.push(`- verify_by: ${lines(item.verify_by)}`);
    });
  } else {
    out.push("", "_No new items._");
  }
  out.push(...renderQuestions(result.questions));
  out.push(...renderList("Limitations", result.limitations));
  return out.join("\n");
}

export function renderUsage(usage, elapsedMs) {
  const parts = [];
  if (elapsedMs != null) parts.push(`${Math.round(elapsedMs / 1000)}s`);
  if (usage) {
    const cached = usage.cached_input_tokens ?? 0;
    const input = usage.input_tokens ?? 0;
    parts.push(`in ${input.toLocaleString("en-US")} tok (${input ? Math.round((cached / input) * 100) : 0}% cached)`);
    parts.push(`out ${(usage.output_tokens ?? 0).toLocaleString("en-US")} tok`);
  }
  return parts.join(" · ");
}
