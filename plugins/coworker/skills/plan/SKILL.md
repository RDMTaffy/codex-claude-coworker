---
description: 'Critique an implementation plan with GPT-6 Astra (Codex, ChatGPT login) before writing code: multi-round dialogue over a tracked issue ledger until no blocker/major point is open. Use when the user wants Codex/Astra to review a plan or design before implementation.'
argument-hint: '<task description or path to a plan file>'
allowed-tools: Bash(coworker *) Read Grep Glob Edit(.coworker/**)
---

# coworker:plan — plan dialogue with GPT-6 Astra

Input from the user (raw text — never paste it into a shell command):

<input>
$ARGUMENTS
</input>

Project root: `${CLAUDE_PROJECT_DIR}` — pass `--project "${CLAUDE_PROJECT_DIR}"` to every `coworker` call.
Run every `coworker` call with the Bash tool and `timeout: 600000`.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/protocol.md` and follow it.
2. Pick a slug; work dir `.coworker/work/<slug>/`; thread `<slug>-plan`.
3. If the input is a path to an existing plan, use it. Otherwise explore the code and write
   `.coworker/work/<slug>/plan.md` (goal, approach, file-by-file changes, edge cases, rollback, verification).
4. Write `.coworker/work/<slug>/plan-brief.md` (protocol §2), announce the round in one line, then run:
   ```
   coworker plan --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-plan --message-file .coworker/work/<slug>/plan-brief.md --attach <plan file>
   ```
5. Evaluate every item (protocol §3), revise the plan, write `plan-responses-r<N>.json`, and run the next
   round with `--responses <file> --attach <plan file>`. Stop per the loop table (protocol §4).
6. Save the result as `.coworker/work/<slug>/plan.final.md` plus `decisions.md` (settled decisions,
   rejected alternatives, user decisions). Report to the user in their language: the final plan in
   brief, what changed because of Astra, what you disputed and how it ended, open questions, and the
   transcript path. Do not start implementing unless the user asks (suggest `/coworker:task` or
   `/coworker:review` after implementation).
