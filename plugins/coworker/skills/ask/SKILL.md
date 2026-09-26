---
description: 'Ask GPT-6 Astra (Codex, ChatGPT login) for a second opinion or continue a conversation with it — design questions, debugging hypotheses, API choices. Claude pre-registers its own view first to avoid anchoring, then compares. Use when the user says to ask Codex/Astra/GPT, wants a second opinion, or continues an Astra conversation.'
argument-hint: '[--thread <name>] <question>'
allowed-tools: Bash(coworker *) Read Grep Glob Edit(.coworker/**)
---

# coworker:ask — second opinion from GPT-6 Astra

The user's question (raw text — never paste it into a shell command):

<question>
$ARGUMENTS
</question>

Project root: `${CLAUDE_PROJECT_DIR}` — pass `--project "${CLAUDE_PROJECT_DIR}"` to every `coworker` call.
Run every `coworker` call with the Bash tool and `timeout: 600000`.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/protocol.md` (§1, §2, §5, §7 apply).
2. Thread: use `--thread <name>` if the user gave one or is clearly continuing an earlier Astra
   conversation (`coworker threads list --project "${CLAUDE_PROJECT_DIR}"` shows them); otherwise pick a
   short topical name. A follow-up in the same thread keeps Astra's memory of the conversation.
3. If you already have a view on the question, write 2–4 lines of it to
   `.coworker/work/ask/view.md` BEFORE asking and pass `--claude-view .coworker/work/ask/view.md`
   (the tool seals it outside the repo so Astra cannot read it; it is shown next to Astra's answer).
   Do not put your view into the question unless the user asked Astra to critique it.
4. Write the question as a brief (protocol §2, shorter is fine) to `.coworker/work/ask/<thread>-q<N>.md`, then:
   ```
   coworker ask --project "${CLAUDE_PROJECT_DIR}" --thread <thread> --message-file .coworker/work/ask/<thread>-q<N>.md [--claude-view .coworker/work/ask/view.md]
   ```
   Add `--attach <file>` for small text files Astra must see verbatim.
5. Present Astra's answer faithfully (do not water it down), then your comparison: where you agree,
   where you differ and why, what you verified. For factual disagreements, check the code or run a
   quick experiment instead of arguing. Mention the thread name so the user can continue it.
