---
description: 'Blind design debate with GPT-6 Astra (Codex, ChatGPT login) for a decision with several viable options: both sides commit to proposals independently, cross-examine each other, then give sealed final positions. Use when the user wants Codex/Astra and Claude to independently weigh a design or technology choice.'
argument-hint: '<decision to make>'
allowed-tools: Bash(coworker *) Read Grep Glob Edit(.coworker/**) AskUserQuestion
---

# coworker:debate — blind proposals, cross-examination, sealed finals

Decision to make (raw text — never paste it into a shell command):

<decision>
$ARGUMENTS
</decision>

Project root: `${CLAUDE_PROJECT_DIR}` — pass `--project "${CLAUDE_PROJECT_DIR}"` to every `coworker` call.
Run every `coworker` call with the Bash tool and `timeout: 600000`.
Pick a short, new slug for this decision (e.g. `cache-strategy`); work dir `.coworker/work/<slug>/`;
thread `<slug>-debate`. Use the same slug for all three stages.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/protocol.md` (§1, §2, §5, §7 apply).
2. Explore enough code to understand the decision. Write `.coworker/work/<slug>/brief.md`: the problem,
   constraints, success criteria with weights, and candidate options **unranked** (invite others). No
   hint of your preference.
3. BEFORE asking Astra, write your own proposal to `.coworker/work/<slug>/claude-proposal.md`:
   recommendation, reasons scored against the criteria, strongest counter-argument, risks, what would
   change your mind. Then run (the tool seals your proposal outside the repo):
   ```
   coworker debate --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-debate --stage open --brief .coworker/work/<slug>/brief.md --claude-proposal .coworker/work/<slug>/claude-proposal.md
   ```
4. Read Astra's proposal. Write `.coworker/work/<slug>/cross.md`: steelman Astra's proposal (3–5
   sentences), then critique it against the criteria with concrete failure cases. Then:
   ```
   coworker debate --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-debate --stage cross --message-file .coworker/work/<slug>/cross.md
   ```
   Astra now sees your proposal, steelmans and critiques it, and answers your critique.
5. Settle factual disagreements by checking code or running experiments. Then, BEFORE seeing Astra's
   final, write `.coworker/work/<slug>/claude-final.md` starting with `PICK: <option>` and
   `CONFIDENCE: high|medium|low`, then reasons, residual risk, and what would change your mind. Run:
   ```
   coworker debate --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-debate --stage final --claude-final .coworker/work/<slug>/claude-final.md
   ```
6. Report in the user's language: a decision matrix (options × criteria, both sides' scores), both final
   picks, where each side changed its mind and why, and the transcript path. If the picks differ, ask the
   user with ONE AskUserQuestion presenting both positions neutrally, your recommendation labeled as
   Claude's. Do not force a compromise.
