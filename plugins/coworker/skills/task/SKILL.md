---
description: 'Do a coding task together with GPT-6 Astra (Codex, ChatGPT login): Claude plans, Astra critiques the plan, Claude implements, Astra reviews the diff over a tracked issue ledger. Use when the user asks to work with Codex/Astra/GPT on a task, or when coworker auto mode is on and a change is non-trivial (~50+ lines or a design decision).'
argument-hint: '<task description> [--quick]'
allowed-tools: Bash(coworker *) Read Grep Glob Edit(.coworker/**)
---

# coworker:task — plan → implement → review with GPT-6 Astra

User's task (raw text — never paste it into a shell command; write it into a file instead):

<task>
$ARGUMENTS
</task>

Project root: `${CLAUDE_PROJECT_DIR}` — pass `--project "${CLAUDE_PROJECT_DIR}"` to every `coworker` call.
Run every `coworker` call with the Bash tool and `timeout: 600000`.

## 0. Setup
1. Read `${CLAUDE_PLUGIN_ROOT}/references/protocol.md` now and follow it throughout.
2. Pick a short slug for the task (e.g. `auth-refresh`). Work dir: `.coworker/work/<slug>/`.
   Threads: `<slug>-plan` and `<slug>-review` (separate on purpose: fresh eyes for the review).
3. Record progress so the task survives interruptions and context compaction. First read the state
   (no flags = read only): `coworker task-state <slug> --project "${CLAUDE_PROJECT_DIR}"`.
   If its `phase` is past `new`, resume from that phase instead of restarting. Otherwise start:
   `coworker task-state <slug> --project "${CLAUDE_PROJECT_DIR}" --phase planning`
4. `--quick` in the task text (or a clearly small change): skip §1–§2 and do one review round (§4).

## 1. Draft the plan (Claude)
Explore the code first. Write `.coworker/work/<slug>/plan.md`: goal, approach, file-by-file changes,
edge cases, migration/rollback if relevant, and how you will verify (tests/commands).
Then write the brief `.coworker/work/<slug>/plan-brief.md` using the template in protocol §2.

## 2. Plan dialogue
Tell the user one line ("Astra 계획 검토 1라운드 시작 …"), then:
```
coworker plan --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-plan --message-file .coworker/work/<slug>/plan-brief.md --attach .coworker/work/<slug>/plan.md
```
For each item: evaluate per protocol §3, revise `plan.md`, write `.coworker/work/<slug>/plan-responses-r<N>.json`,
and run the next round with `--responses <file> --attach .coworker/work/<slug>/plan.md` (add a short
`--message-file` only if you have context to add). Follow the loop table in protocol §4.
When done, save the agreed plan as `plan.final.md` and create `decisions.md` listing settled decisions
(with reasons), rejected alternatives, and anything the user decided. Then:
`coworker task-state <slug> --project "${CLAUDE_PROJECT_DIR}" --phase implementing --plan .coworker/work/<slug>/plan.final.md`
Give the user a 3–5 line summary of the agreed plan (what changed because of Astra). Proceed unless the
user must decide something (protocol §5).

## 3. Implement (Claude)
Implement the plan. Run the tests/verification from the plan. If you deviate from the plan, append the
deviation and its reason to `decisions.md` (Astra flags unexplained deviations).
`coworker task-state <slug> --project "${CLAUDE_PROJECT_DIR}" --phase reviewing`

## 4. Review dialogue
Write `.coworker/work/<slug>/review-brief.md` (goal, what changed and why, tests you ran with results,
what to scrutinize). Then:
```
coworker review --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-review --message-file .coworker/work/<slug>/review-brief.md --plan-file .coworker/work/<slug>/plan.final.md --attach .coworker/work/<slug>/decisions.md
```
(Add `--base <branch>` if the work is already committed on a branch; default is uncommitted changes.
With `--quick` there is no plan: drop `--plan-file` and the `decisions.md` attachment.)
For each finding: reproduce/verify, fix accepted ones, re-run tests, write
`review-responses-r<N>.json`, then the next round:
`coworker review --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-review --responses .coworker/work/<slug>/review-responses-r<N>.json`
Do not edit files while a review job runs. Loop per protocol §4.

## 5. Report
`coworker task-state <slug> --project "${CLAUDE_PROJECT_DIR}" --phase done`
Get the numbers with `coworker threads show <slug>-plan --project "${CLAUDE_PROJECT_DIR}"` and
`... <slug>-review ...`, then report to the user with the template in protocol §6 (Korean for a Korean
user), including both transcript paths. Do not commit unless the user asks.
