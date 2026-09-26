---
description: 'Turn coworker auto mode on or off for this project. When on, non-trivial code changes go through the plan → implement → review dialogue with GPT-6 Astra automatically.'
argument-hint: '[on | off | status] [--global]'
disable-model-invocation: true
allowed-tools: Bash(coworker *)
---

!`coworker mode --project "${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`

Confirm the result above to the user in their language. When auto mode is on: for requests that will
change roughly 50+ lines or involve a design decision, use the coworker:task skill; for questions, small
edits and trivial fixes, skip it and say so in one line ("Astra 협업 생략: 소규모 변경"). Each Astra round
uses the user's ChatGPT/Codex usage.
