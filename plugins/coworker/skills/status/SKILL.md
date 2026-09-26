---
description: 'Show coworker setup: detected Codex CLI binaries and versions, ChatGPT login, config, threads, running jobs, and missing permission rules. Pass --ping for a live GPT-6 Astra round-trip.'
argument-hint: '[--ping] [--refresh] [--json]'
disable-model-invocation: true
allowed-tools: Bash(coworker *)
---

!`coworker status --project "${CLAUDE_PROJECT_DIR}" --args "$ARGUMENTS"`

Present the status above to the user in their language. If something failed:
- no usable Codex CLI or a version too old for the model → `brew upgrade codex` or `npm i -g @openai/codex@latest`,
  or point `COWORKER_CODEX_BIN` / config `codexBin` at a newer binary (the ChatGPT desktop app bundles one);
- not logged in → run `codex login` in a terminal (ChatGPT sign-in);
- missing permissions → offer to add the listed rules to `~/.claude/settings.json` (ask before editing).
Suggest `/coworker:status --ping` if no live check was run.
