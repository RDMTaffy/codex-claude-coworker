---
description: 'Code review dialogue with GPT-6 Astra (Codex, ChatGPT login) on the current changes: Astra reviews a frozen snapshot, Claude verifies every finding (reproduces, runs verify_by), fixes or disputes with evidence, and Astra re-reviews the fixes. Use when the user asks Codex/Astra/GPT to review code or wants a second-model review.'
argument-hint: '[--base <branch> | --commit <sha> | --paths <p>…] [--fix | --report-only] [--deep] [focus text]'
allowed-tools: Bash(coworker *) Bash(git status *) Bash(git diff *) Bash(git log *) Read Grep Glob Edit(.coworker/**) AskUserQuestion
---

# coworker:review — review dialogue with GPT-6 Astra

Arguments from the user (raw text — never paste it into a shell command; map recognized flags yourself):

<args>
$ARGUMENTS
</args>

Project root: `${CLAUDE_PROJECT_DIR}` — pass `--project "${CLAUDE_PROJECT_DIR}"` to every `coworker` call.
Run every `coworker` call with the Bash tool and `timeout: 600000`.

1. Read `${CLAUDE_PLUGIN_ROOT}/references/protocol.md` and follow it.
2. Target: `--base <branch>` → everything since the merge-base (commits + uncommitted + untracked);
   `--commit <sha>` → that commit; `--paths …` → those files; default → uncommitted changes.
   For the default target only, check `git status --short` first; if it is empty, say so and stop.
   (`--base`/`--commit` targets can have a clean working tree and still have changes to review.)
   Pick a slug and thread `<slug>-review` (reuse the thread if the user is continuing a review).
3. Write `.coworker/work/<slug>/review-brief.md` (protocol §2): what changed and why, tests run and
   results, what to scrutinize (include the user's focus text), what is out of scope. Announce the round, then:
   ```
   coworker review --project "${CLAUDE_PROJECT_DIR}" --thread <slug>-review --message-file .coworker/work/<slug>/review-brief.md [--base <branch> | --commit <sha> | --paths <p>…] [--deep]
   ```
   Put any focus the user gave into the brief (never onto the command line). Pass `--plan-file <file>` if a plan exists.
4. Verify every finding yourself (protocol §3): read the lines, reproduce blocker/major claims, run
   `verify_by`. Decide accept / partial / reject / defer per finding.
5. Code changes:
   - `--report-only`: do not modify code. Present findings with your verdict on each. If you reject any
     finding, you may run one more round to get Astra's ruling on your evidence (answer accepted items
     with `defer` + "user will decide").
   - `--fix`: fix accepted findings without asking.
   - neither: show a compact table (id · severity · your verdict · one-line reason), then ONE
     AskUserQuestion: "Fix the accepted findings now?" — `Fix accepted (Recommended)` / `Report only`.
6. After fixing: re-run the relevant tests, write `review-responses-r<N>.json` covering every open item,
   and run the next round with `--responses <file>` (no need to repeat the target flags). Do not edit
   while a review job runs. Loop per protocol §4.
7. Report in the user's language (protocol §6) with the transcript path. Do not commit unless asked.
