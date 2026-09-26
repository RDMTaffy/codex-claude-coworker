---
description: 'List coworker threads (Claude ⇄ GPT-6 Astra conversations), show one thread with its issue ledger and usage, or reset (archive) a thread.'
argument-hint: '[list | show <thread> | ledger <thread> | reset <thread> | unlock <thread>]'
disable-model-invocation: true
allowed-tools: Bash(coworker *)
---

!`coworker threads --project "${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`

Present the output above to the user in their language. For `show`, point out open blocker/major
items and the transcript path. `reset` archives coworker's files for the thread (the Codex session is
left untouched); the next turn on that name starts a fresh conversation.
`unlock` clears a lock left behind by a crashed coworker process (it refuses while a live job holds it).
