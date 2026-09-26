# coworker — Claude Code × GPT-6 Astra 협업 플러그인

> A Claude Code plugin where Claude stays the lead engineer and GPT-6 Astra (via the Codex CLI on your
> ChatGPT subscription — no API key) critiques plans and reviews code in multi-round dialogue, with a
> tracked issue ledger. Docs below are in Korean.

**Claude Code가 메인 작업자**로 코드를 직접 계획·구현하고, 그 과정에서 **GPT-6 Astra(Codex CLI, ChatGPT 구독)** 와
대화하며 계획을 검토받고 코드 리뷰를 주고받는 Claude Code 플러그인입니다. API 키 없이 `codex login`(ChatGPT 로그인)만으로 동작합니다.

```
사용자 ──▶ Claude Code (계획 초안 · 구현 · 테스트 · 최종 판단)
                │  ▲
     브리프/응답 │  │ 구조화된 비평 (P#/R# 이슈, 근거, verify_by)
                ▼  │
        coworker CLI ──▶ codex exec / exec resume (read-only 샌드박스) ──▶ GPT-6 Astra
```

## 무엇이 다른가

공식 [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)는 리뷰 요청과 작업 위임(Codex가 직접 작업)에 초점을 둡니다.
coworker는 **Claude가 계속 주도권을 갖고 Astra와 논점을 주고받는 대화**에 초점을 둡니다.

| | coworker |
|---|---|
| 역할 | Claude = 리드 엔지니어(수정·판단), Astra = 독립 리뷰어(읽기 전용) |
| 대화 | 스레드별로 Codex 세션을 `resume` → Astra가 이전 라운드를 기억 |
| 논점 관리 | **이슈 원장(ledger)**: 도구가 P1…/R1… ID를 부여하고, Claude의 결정(수용/부분/반박/보류/사용자결정)과 Astra의 판정(수정확인/미흡/철회/유지/하향/대체/보류수용)을 라운드마다 기록 |
| 종료 조건 | Astra의 "approve"가 아니라 **원장 기준 수렴**(blocker/major 미해결 0). 교착(같은 항목 2회 연속 반박-유지)·라운드 초과·stale·불완전 평가는 승인으로 취급하지 않음 |
| 리뷰 대상 고정 | 라운드마다 작업 트리를 git tree로 스냅샷(사용자 index 무변경). 리뷰 중 파일이 바뀌면 `stale` |
| 재리뷰 | 이전 라운드 이후 변경분(delta)만 집중 검증 → 비용 절감 |
| 앵커링 방지 | `ask`는 Claude 의견을 먼저 봉인(`--claude-view`), `debate`는 양측이 독립 제안 → 교차검증 → 봉인된 최종 입장 |

## 요구사항

- Claude Code 2.1.278+ · Node.js 18.19+
- Codex CLI + ChatGPT 로그인: `codex login`
- **gpt-6-astra는 최신 Codex CLI가 필요합니다.** Homebrew의 구버전(예: 0.144.x)은 `requires a newer version of Codex`로 실패합니다.
  coworker는 설치된 모든 codex 바이너리(PATH, Homebrew, npm, **ChatGPT.app 내장 CLI**)를 찾아 **가장 높은 버전**을 자동 선택합니다.
  (`brew upgrade codex` 또는 `npm i -g @openai/codex@latest`로 올려도 됩니다.)

## 설치

```bash
claude plugin marketplace add RDMTaffy/codex-claude-coworker
```

```bash
claude plugin install coworker@codex-claude-coworker
```

(로컬에서 개발할 때는 저장소를 클론한 뒤 `claude plugin marketplace add <클론한 경로>`로 추가해도 됩니다.)

그다음 Claude Code에서 `/reload-plugins`(또는 새 세션) 후:

```
/coworker:status --ping
```

`OK chosen: 0.158.x`, `OK login: Logged in using ChatGPT`, `OK live ping … pong`이 보이면 준비 완료입니다.

### (선택) 권한 규칙 — 라운드마다 뜨는 권한 확인 줄이기

`/coworker:status`가 빠진 규칙을 알려줍니다. `~/.claude/settings.json`의 `permissions.allow`에 추가:

```json
["Bash(coworker *)", "Edit(.coworker/**)", "Skill(coworker:task *)", "Skill(coworker:plan *)",
 "Skill(coworker:review *)", "Skill(coworker:ask *)", "Skill(coworker:debate *)"]
```

## 사용법

| 명령 | 하는 일 |
|---|---|
| `/coworker:task <작업> [--quick]` | **전체 흐름**: Claude 계획 초안 → Astra 계획 비평(최대 2라운드) → Claude 구현 → Astra 코드 리뷰(최대 3라운드) → 한국어 협업 보고서 |
| `/coworker:plan <작업 또는 계획 파일>` | 계획 대화만 (구현 전 설계 검증) |
| `/coworker:review [--base main \| --commit SHA \| --paths …] [--fix \| --report-only] [--deep] [초점]` | 현재 변경사항 리뷰 대화. Claude가 각 지적을 재현·검증 후 수정하거나 근거로 반박하고, Astra가 재검증 |
| `/coworker:ask [--thread 이름] <질문>` | 두 번째 의견. 같은 스레드로 이어서 물으면 Astra가 대화를 기억 |
| `/coworker:debate <결정할 문제>` | 블라인드 토론: 독립 제안 → 교차 검토 → 봉인된 최종 입장 → 의사결정표 |
| `/coworker:status [--ping]` | 바이너리/로그인/설정/스레드/실행 중 작업/권한 점검 |
| `/coworker:threads [list \| show T \| ledger T \| reset T \| unlock T]` | 대화 스레드와 이슈 원장, 사용량 확인 (`unlock`: 비정상 종료로 남은 잠금 해제) |
| `/coworker:mode on \| off` | **자동 협업 모드**: 켜면 50줄 이상 변경/설계 결정이 있는 요청은 자동으로 `coworker:task` 흐름을 탑니다 (작은 수정·질문은 생략) |

자연어로도 됩니다: "이거 Astra랑 같이 계획 세워서 구현해줘", "Codex한테 이 설계 어떻게 생각하는지 물어봐", "Astra한테 리뷰 받아줘".

### 대화는 어디서 보나요?

- 스레드 대화록: `<프로젝트>/.coworker/threads/<스레드>.md` (Claude → Astra / Astra → Claude, 라운드별)
- 이슈 원장: `coworker threads show <스레드>`
- `.coworker/`는 자체 `.gitignore`(`*`)로 커밋되지 않습니다.

## 동작 방식 (요약)

1. 각 Astra 턴은 **백그라운드 작업(job)** 입니다. CLI는 최대 9분 기다리며 진행 상황(`astra ▸ $ git diff …`)을 보여주고,
   그 이상 걸리면 `coworker wait <job>`으로 이어받습니다. 작업은 이중 fork로 분리되어 Claude Code에서 Esc를 눌러도 죽지 않습니다.
2. Codex 실행은 항상 `sandbox_mode="read-only"`, `approval_policy="never"`, `forced_login_method="chatgpt"`이며,
   기본 격리(`isolation: strict`)에서 `--ignore-user-config` + 리뷰어에 불필요한 기능(apps, plugins, browser, computer use, hooks 등)을 끕니다.
3. 첫 턴에는 역할 계약(검증 후 주장, 반박은 증거가 아님, 동조성 양보 금지, verify_by 등)을 보내고, 이후 턴에는 요약 digest와 원장을 매번 다시 보냅니다.
4. 계획/리뷰 응답은 JSON 스키마(`schemas/*.schema.json`)로 강제되고, 스크립트가 원장·수렴 상태를 계산합니다.

## 설정

프로젝트: `<프로젝트>/.coworker/config.json` · 전역: `~/.config/coworker/config.json` · 환경변수가 우선합니다.

```json
{
  "model": "gpt-6-astra",
  "effort": { "ask": "high", "plan": "high", "review": "high", "rereview": "medium", "debate": "high" },
  "maxRounds": { "plan": 2, "review": 3 },
  "lang": "auto",
  "isolation": "strict",
  "authMethod": "chatgpt",
  "webSearch": true,
  "waitBudgetSec": 540,
  "timeoutSec": 1800,
  "codexBin": null,
  "autoMode": false
}
```

- effort: `low | medium | high | xhigh | max | ultra`. 실측상 작은 diff에서는 high 이상에서 품질 차이가 거의 없고 시간·토큰만 늘어 기본값은 high입니다. 큰 변경은 `/coworker:review --deep`(xhigh).
- `webSearch: false`로 두면 Astra의 웹 검색(`web_search="disabled"`)을 끕니다. 코드 조각이 검색 질의로 나가는 것도 막고 싶을 때 쓰세요.
- 스레드 이름은 영문·숫자·`_`·`-`만 씁니다 (점 불가).
- 환경변수: `COWORKER_MODEL`, `COWORKER_EFFORT`, `COWORKER_EFFORT_REVIEW` 등, `COWORKER_CODEX_BIN`(바이너리 고정), `COWORKER_ISOLATION`, `COWORKER_WEB_SEARCH`, `COWORKER_WAIT_BUDGET`, `COWORKER_TIMEOUT`.

## 비용

모든 Astra 턴은 ChatGPT 플랜의 Codex 사용량을 씁니다. 스레드를 이어갈수록(resume) 이전 대화가 다시 전송됩니다(대부분 캐시됨).
Codex는 resume 턴에서 세션 누적 사용량을 보고하므로 coworker는 직전 누적치와의 차이를 턴 사용량으로 표시합니다(근사치).
실측: 단순 턴 ~16k 입력 토큰, 작은 diff 리뷰 ~60–90k(대부분 캐시), 수십 초~수 분. `coworker threads show <스레드>`에서 누적 사용량을 볼 수 있습니다.

## 보안·개인정보

- 리뷰 대상 코드와 브리프는 Codex를 통해 OpenAI로 전송됩니다.
- Astra는 읽기 전용 샌드박스에서 실행되며 파일을 수정하지 못합니다. 모든 수정은 Claude가 하고, Claude Code의 권한 규칙을 따릅니다.
- 프로토콜상 Claude는 비밀번호·토큰·`.env` 내용을 Astra에게 보내지 않으며, Astra는 지정되지 않은 `.env*`/자격증명 파일을 열지 않도록 지시받습니다.
- ⚠ **Codex의 전역 지침 `~/.codex/AGENTS.md`는 `--ignore-user-config`로도 제외되지 않고 모든 Codex 턴에 포함됩니다.** 이 파일에 다른 프로젝트 메모나 계정 정보가 있다면 정리하는 것을 권장합니다.

## 문제 해결

| 증상 | 해결 |
|---|---|
| `requires a newer version of Codex` | `/coworker:status`로 선택된 바이너리 확인 → 최신 CLI 설치 또는 `COWORKER_CODEX_BIN` 지정 |
| `login: FAIL` | 터미널에서 `codex login` |
| `status=waiting` (exit 75) | 정상입니다. `coworker wait <job>`으로 결과 수신. **다시 보내지 마세요** |
| `status=busy` (exit 3) | 같은 스레드에서 작업 중. `coworker wait --thread <스레드>` 또는 `coworker cancel <job>` |
| `status=session_lost` (exit 4) | Codex 세션이 사라짐 → `--new`로 새 스레드 + 요약 |
| `loop=stale` | 리뷰 중 파일이 수정됨 → 편집을 멈추고 한 라운드 더 |
| 스레드가 꼬였을 때 | `/coworker:threads reset <스레드>` (파일은 `.bak`으로 보관) |
| `MUTEX_STALE` / 잠금이 안 풀림 | coworker 프로세스가 비정상 종료한 경우 → `/coworker:threads unlock <스레드>` |
| `loop=max_rounds` / `round_limit` | 라운드 예산 소진(승인 아님). 남은 쟁점을 보고받고, 계속하려면 `--extra-round`에 동의 |

## 개발

```bash
cd plugins/coworker && npm test
```

단위·통합(가짜 Codex)·정적·적대적·Claude 관점·라이브 발견 회귀 테스트 418개. 실제 GPT-6 Astra와의 계획→구현→리뷰→토론 전 과정도 검증했습니다.

```bash
claude plugin validate plugins/coworker --strict
```

구조:

```
.claude-plugin/marketplace.json          로컬 마켓플레이스
plugins/coworker/
  .claude-plugin/plugin.json
  bin/coworker                           PATH에 올라가는 런처 (Bash에서 `coworker …`)
  skills/{task,plan,review,ask,debate,status,threads,mode}/SKILL.md
  references/protocol.md                 Claude의 협업 규약 (브리프, 판정, 루프, 보고)
  hooks/hooks.json                       자동 협업 모드용 UserPromptSubmit 훅
  schemas/{plan,review}.schema.json      Astra 구조화 출력 스키마 (strict)
  scripts/coworker.mjs                   CLI 진입점
  scripts/lib/                           jobs(이중 fork·상태머신) state(락·스레드) turns ledger git codex …
  tests/                                 unit / integration(가짜 codex) / static
```
