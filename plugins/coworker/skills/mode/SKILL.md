---
description: 'Set how automatically Claude collaborates with GPT-6 Astra in THIS project: off, on (big changes only, Claude judges), or always (every code change, enforced by a review gate).'
argument-hint: '[off | on | always | status] [--global]'
disable-model-invocation: true
allowed-tools: Bash(coworker *)
---

!`coworker mode --project "${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`

Confirm the result above to the user in their language. The setting is per project (stored in this
project's `.coworker/config.json`); `--global` sets the default for projects without their own setting.

- `on`: for requests that will change roughly 50+ lines or involve a design decision, use the
  coworker:task skill; for questions, small edits and trivial fixes, skip it and say so in one line
  ("Astra 협업 생략: 소규모 변경").
- `always`: every request that changes code uses the full coworker:task skill, however small — no skipping.
  If a turn ends with files Claude changed that Astra has not reviewed, a Stop hook asks for a
  coworker:review of exactly those files (in a new thread) before the turn can end; follow it. Questions
  that change no code are answered normally.
- `off`: Astra is used only when the user asks.

Each Astra round uses the user's ChatGPT/Codex usage.
