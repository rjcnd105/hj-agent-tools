# hc-team 프리셋 조사: 운영자 워크플로와 제안 프리셋 3종

작성: 2026-11-21, opus-researcher (읽기 전용 조사, 에이전트 미실행)

## 결론

기존 시드 3종(`web-feature-squad`, `bugfix-triage`, `fullstack-delivery`)과 겹치지 않는 프리셋 3종을 제안한다. 아래 JSON은 모두 `hc-team preset validate --stdin`을 통과했다. 또 `HC_TEAM_PRESETS_DIR=<임시폴더> hc-team launch <id> --cwd <실제 프로젝트> --no-parent --with-servers --dry-run`으로 실제 프로젝트에서 실행 파일 해석까지 확인했다. dry-run은 run 폴더를 만들지 않는다.

| id | 고를 때 | 기본 역할 (harness) | 선택 역할 |
| --- | --- | --- | --- |
| `jira-ticket-delivery` | Jira 티켓(GMN-/PSR-)과 Figma를 받아 Next.js 화면과 API 연동을 PR까지 끝낼 때 | dev (pi sol), web-qa (agy Neon), reviewer (codex Astra) | spec-planner (claude Fable) |
| `godot-game-loop` | Godot 픽셀 게임의 계획된 T### 태스크를 계속 돌릴 때 | gameplay-dev (pi sol), game-qa (agy Neon), pixel-artist (claude Opus) | plan-reviewer (Fable), systems-reviewer (codex Astra) |
| `motion-interaction-lab` | 모션과 인터랙션 변형안을 만들고 녹화와 실제 제스처 재현으로 비교해 고를 때 | motion-dev (pi sol), gesture-qa (agy Neon), motion-critic (claude Fable) | perf-reviewer (codex Astra) |

## 모델 배정 근거

운영자 지시(t114)에 따라 과거 기록에 나온 모델 slug(`gpt-6.1-terra`, `gpt-6-astra`, Fable 5.1 등)는 쓰지 않았다. 이 머신의 최신 모델 중 역할에 맞는 것을 골랐다.

| 역할 유형 | 배정 | 확인한 근거 |
| --- | --- | --- |
| 계획, 기획 해석, 감각 판정, 디렉터 보조 | `claude --model claude-fable-5-2 --effort xhigh` 또는 `high` | `claude --help`: `--model`에 정식 이름 허용, `--effort`는 low~max |
| 픽셀 아트 (Aseprite 손그림) | `claude --model claude-opus-5-5 --effort high` | little-bird-village ADR-0059: 모든 픽셀 아트는 Claude가 그린다. `CLAUDE_CODE_SUBAGENT_MODEL=claude-opus-5-5` |
| 구현과 실행 | `pi --provider openai --model gpt-6.2-sol --thinking high` | `~/.pi/agent/settings.json`: `defaultProvider: openai`, `defaultModel: gpt-6.2-sol`, `enabledModels`에 포함. `pi --list-models`에 `openai gpt-6.2-sol` |
| 적대적 리뷰 (읽기 전용) | `codex -m gpt-6.2-astra -c model_reasoning_effort="xhigh" -s read-only` | `codex --help`: `-s read-only` 존재. `--no-daemon`은 launch가 붙이므로 저장하지 않는다 (schema.md) |
| 멀티모달 브라우저와 게임 화면 QA | `agy --model gemini-4-neon-high` | `agy models`에 `gemini-4-neon-high` 존재. effort가 모델 id에 들어 있어 `--effort`는 따로 주지 않았다 |

`~/.agents/pstack-models.md`는 모든 역할이 `inherit-parent`라서 특정 모델을 정하지 않는다. 대신 effort 사다리를 준다(구현 medium~high, 판단·리뷰 xhigh). 구현 역할은 `high`, 판단과 리뷰 역할은 `xhigh`로 맞췄다. 모션 크리틱은 응답 횟수가 많아서 `high`로 낮췄다.

## 프로젝트별 반복 워크플로 (근거)

Claude 세션의 사용자 프롬프트는 최근 세션 40~60개에서 키워드 빈도와 짧은 프롬프트만 표본으로 봤다. pi 세션은 첫 프롬프트와 모델만 봤다. 원문 전문은 옮기지 않았다. pi 세션 하나에 고객 개인정보가 붙여넣어져 있어 그 내용은 인용하지 않는다.

### gentle-renewal, gentle-renewal-2 (Gentle Monster 커머스, Next.js 16)

- 흐름: Jira `GMN-####` 링크 → Figma 노드 확인 → 브랜치(`feature/GMN-…`) → 구현 → `/ego-browser`로 국가와 로케일별 확인 → `/hj-agent-tools:simple-pr`로 `release/*` 대상 PR → `/code-review medium`. 증거: 프롬프트 "GMN-2699 release/gm-prod-v26.11.3 로 simple-pr", "코드에서도 맞춰서 작업 후에 /ego-browser 로 확인해줘", "헤더 다 문제 없이 국가별로 세팅되어 있나 확인해봐 /ego-browser".
- 검증할 것: 국가 9개와 언어 5개 조합, PC/MO 분기, 로컬은 `https://local.gentlemonster.com/`(localhost 아님, CLAUDE.md "Local Testing"). 품질 게이트는 ratchet 방식이다(`docs/quality-gates.md`). 빌드가 타입·lint 오류를 무시하므로 lint와 tsc는 기준선과 비교한다.
- 금지: `locales/**/common.json`은 직접 편집하지 않는다(Lokalise 소유).
- 모션: `motion-lab/AGENTS.md`의 변형, 녹화, 대시보드 피드백 큐("motion-lab 피드백 처리해줘") 흐름이 반복된다(키워드 54회). 피드백 예: "모션이나 크기가 조금 과하게 커졌어… 고급스러운 느낌이 안나고", "사라질때도 fade out(enter 보다 빠른)".
- 그 밖: Sentry 이슈 수정(46회), OG 이미지와 캐시 질문.

### ps-frontend-admin (Product Service Admin, Next.js 16 + MUI)

- 흐름: Jira `PSR-####` 티켓, 댓글, 기획 스펙(`iic-ps-spec`)을 읽고 구현한다. 사용자가 OpenAPI를 생성하면(`generate:api-dev`) 반영하고, ego-browser로 `https://productservice-local.systemiic.com/ko`를 확인한다(AGENTS.override.md). 다른 세션의 pi가 적대적 리뷰를 한다. merge 후 사후 검토 요청도 있었다.
- 핵심 요구: "API 연동이랑 화면 개발이랑 한 통짜로 하라니깐!!!!" (역할을 API와 UI로 나누지 말 것). "pi 섹션에게 적대적 리뷰 받아서… 오버엔지니어링, 너무 과한 예외, 에러 게이트 지양하고 명료, simplicity 하게".
- 검증: 수정한 JS/TS만 ESLint를 돌리고, 타입·라우트·스키마·API 변경 시 전체 `npm run typecheck`(AGENTS.md "Verification"). `locales/`는 직접 편집하지 않고, 생성 API 타입도 고치지 않는다.
- 하네스 사용: `hc`로 pi에게 리뷰 요청(`<hc from="t6m">적대적 코드 리뷰 요청(읽기 전용…)`), Cross-session idle notice로 Claude 세션끼리 일을 넘긴다.

### deopjib (Elixir/Phoenix/Ash + React 19 SPA, jj)

- 흐름: Claude가 PO를 맡고 pi가 개발한다("개발을 현재 세션에 떠있는 pi 한테 시킨 후 네가 검토해서 반영해. 네가 PO 역할이야"). 모바일 포커스와 스크롤 다듬기, 결제 스캔 OCR(Ollama) 모델 실험, HyperFrames 홍보 영상, dev/prod 배포 확인을 한다.
- 검증: 실제 iOS Safari는 OpenSafari MCP를 쓰고 그 전에 `mise run ios-safari-ready`를 실행한다(AGENTS.md). 클라이언트는 `bun run check`, `bun run typecheck`, `vitest`. 백엔드는 `mix test`와 `mix ash_typescript.codegen`(RPC 클라이언트 생성).
- 문서 진입점: `docs/deopjib/context-for-agents.md`, `docs/solutions/` frontmatter 검색.

### little-bird-village (Godot 4.7 픽셀 게임, jj)

- 흐름: Claude가 디렉터로 계획하고 한 번 리뷰하며 픽셀 아트를 그린다. pi 여러 개가 실행한다(ADR-0059, `.agents/team-workflow.md`). Stop hook "pi 세션들을 게임 개발의 효율을 위해 최대한으로 작업을 계속 돌려"가 반복된다. 세션 하나에 사용자 턴이 474번 있었다("pi 세션을 감시하며… 피드백을 줘").
- 문제점: 3개 pi 세션이 idle로 남는다(Stop hook 판정이 수십 번 반복). "매번 QA 해야할 것들이 계속 늘어나서 점점 효율이 떨어지는건 아냐?" 감시 비용도 크다(team-workflow: pi 세션 파일 감시가 Claude 입력 토큰의 42%).
- 검증 사다리: `python3 tools/lint.py` → `tools/test_impact.py --run` / `tools/test_parallel.py` → `mise run qa-check`. 화면은 열어 둔 `qa-live` 창 하나로만 본다("게임 창을 체크마다 새로 띄우면 사용자 화면을 방해").

### front-vibe-helper (레퍼런스 컴포넌트 카탈로그, Next.js 16, jj)

- 흐름: 계획하는 주 에이전트와 구현 서브에이전트를 나누고(AGENTS.md 표), `integrate.sh`로 통합한다. ego-browser로 사용자 관점 UI/UX와 자연스러움을 점검한다. `npm run measure`로 라우트별 First Load JS를 재고 전후를 비교한다. master push는 homelab에 배포된다(승인 필요).
- 반복 주제: 독창적인 effect 컴포넌트, 모션, 성능과 모듈 크기 예산(CONSTRAINTS.md).

### 공통 패턴 (프리셋 설계에 반영)

1. **계획과 판정은 Claude, 실행은 pi, 리뷰는 별도 harness.** 다섯 프로젝트 모두 같은 분업이다.
2. **브라우저 검증은 ego-browser가 기본.** 로컬 도메인이 localhost가 아니라 https 도메인이다. 그래서 web-qa 역할은 `hc-team servers --run`과 오버레이의 도메인을 쓰게 했다.
3. **리뷰는 버그와 과설계를 같은 무게로 본다.** 운영자는 과한 예외와 방어 코드를 싫어한다.
4. **idle 낭비와 감시 비용이 가장 큰 문제다.** 그래서 모든 역할 지시에 "결과를 hc-team send로 밀어 보낸다"와 "기다리는 동안 다음 작업을 한다"를 넣었다.

## 제안 프리셋

### `jira-ticket-delivery`

```json
{
  "schemaVersion": 1,
  "id": "jira-ticket-delivery",
  "name": "Jira 티켓 개발 · 브라우저 QA · 적대적 리뷰",
  "description": "언제: Jira 티켓(GMN-/PSR-)과 Figma·기획 링크를 받아 Next.js 화면과 API 연동을 한 번에 끝내고 PR까지 갈 때. 기본 구성: 개발(pi sol)이 API와 화면을 함께 구현하고, Web QA(agy Neon)가 ego-browser로 국가·로케일·PC/MO를 확인하고, 리뷰어(codex Astra)가 읽기 전용으로 적대적 리뷰를 한다. 선택: 기획 분석(Fable). 서버: npm run local.",
  "servers": [
    { "id": "web", "command": ["npm", "run", "local"], "cwd": "." }
  ],
  "roles": [
    {
      "id": "dev",
      "title": "티켓 개발 (API 연동 + 화면 한 번에)",
      "command": ["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking", "high"],
      "default": true,
      "owns": ["src/**", "app/**", "components/**", "shared/**", "hooks/**"],
      "talksTo": ["web-qa", "reviewer", "spec-planner"],
      "checkpoints": [
        "수정한 JS/TS 파일만 대상으로 ESLint exit 0",
        "타입·라우트·스키마·API 변경 시 전체 typecheck exit 0",
        "관련 단위 테스트(jest/vitest related) exit 0"
      ],
      "instructions": "티켓 범위의 API 연동과 화면을 한 작업으로 함께 구현한다. 둘로 나누지 않는다. 기획에 없는 예외 처리, 에러 게이트, 추상화를 더하지 않는다. locales/ 파일과 생성된 API 타입은 직접 고치지 않는다. 키는 Lokalise에서 등록된다고 보고 그대로 쓴다. 검사를 통과하면 확인할 라우트, 국가/언어, 뷰포트, 필요한 계정 조건을 web-qa에, base..head diff 범위와 검사 출력을 reviewer에 hc-team send --kind handoff로 보낸다. 받은 리뷰는 단순하게 고칠 수 있는 것만 반영하고, 반영하지 않은 항목은 이유를 parent에 보고한다."
    },
    {
      "id": "web-qa",
      "title": "Web QA (ego-browser, 국가·로케일·PC/MO)",
      "command": ["agy", "--model", "gemini-4-neon-high"],
      "default": true,
      "readOnly": true,
      "skills": ["ego-browser", "ego-recorder", "input-replay"],
      "talksTo": ["dev", "reviewer"],
      "checkpoints": [
        "dev가 지정한 국가/언어 조합마다 대상 화면이 열리고 콘솔 에러가 없다",
        "PC와 MO 뷰포트에서 Figma 노드와 레이아웃·문구를 비교한 결과를 남긴다",
        "실패마다 URL, 재현 단계, 스크린샷 경로를 남긴다"
      ],
      "instructions": "hc-team servers --run으로 이번 run의 로컬 URL을 찾는다. 프로젝트 오버레이에 적힌 로컬 도메인(localhost가 아닌 https 도메인)을 쓴다. ego-browser로 dev가 보낸 여정을 사용자처럼 직접 조작한다. 스와이프·휠처럼 제스처가 중요하면 input-replay를 쓴다. 파일은 수정하지 않는다. 증거는 run의 artifacts/에 두고, 통과·실패 요약을 dev에 hc-team send --kind result로 보낸다. 계정 정보나 쿠키는 기록하지 않는다."
    },
    {
      "id": "reviewer",
      "title": "적대적 코드 리뷰어 (읽기 전용)",
      "command": ["codex", "-m", "gpt-6.2-astra", "-c", "model_reasoning_effort=\"xhigh\"", "-s", "read-only"],
      "default": true,
      "readOnly": true,
      "talksTo": ["dev"],
      "checkpoints": [
        "모든 지적에 file:line과 재현 조건 또는 실패 시나리오가 있다",
        "과설계, 불필요한 예외, 프로젝트 규칙(AGENTS.md) 위반도 지적 대상에 포함한다"
      ],
      "instructions": "dev가 보낸 diff 범위를 읽기 전용으로 검토한다. 사용자가 겪을 버그, 국가별 분기 누락, RSC/클라이언트 경계, 인증·토큰 흐름, 기존 동작 회귀를 우선 찾는다. 같은 무게로 과한 예외 처리, 쓸모없는 간접 계층, 기획에 없는 방어 코드도 지적한다. 지적은 심각도순으로 5개 이내로 줄이고 hc-team send dev --kind review로 보낸다. 지적할 것이 없으면 그렇다고 한 줄로 보낸다."
    },
    {
      "id": "spec-planner",
      "title": "기획·티켓 분석가 (Jira·Figma·스펙)",
      "command": ["claude", "--model", "claude-fable-5-2", "--effort", "xhigh"],
      "default": false,
      "readOnly": true,
      "skills": ["atlassian-api-guidelines", "figma", "ego-browser"],
      "talksTo": ["dev", "web-qa"],
      "checkpoints": [
        "티켓 본문·댓글·Figma 노드·스펙 문서 각각의 근거 링크가 계획에 있다",
        "범위 밖 항목과 미결 질문을 따로 적는다"
      ],
      "instructions": "Jira 티켓 본문과 댓글, 연결된 Figma 노드, 기획 스펙을 읽고 구현 범위, API 요청/응답 필드, 화면 상태, 국가별 차이를 한 장짜리 계획으로 정리해 artifacts/plan.md에 둔다. 결정할 수 있는 것은 결정하고, 기획자에게만 물을 수 있는 질문은 parent에 hc-team send --kind ask로 보낸다. 계획 경로를 dev와 web-qa에 보낸다. 코드는 고치지 않는다."
    }
  ]
}
```

### `godot-game-loop`

```json
{
  "schemaVersion": 1,
  "id": "godot-game-loop",
  "name": "Godot 게임 개발 루프 (구현 · 플레이 QA · 픽셀 아트)",
  "description": "언제: Godot/GDScript 픽셀 게임에서 계획된 태스크(T###)를 끊김 없이 돌릴 때. 기본 구성: 게임플레이 개발(pi sol)이 GUT로 구현하고, 플레이 QA(agy Neon)가 열린 qa-live 창 하나로 화면과 입력을 확인하고, 픽셀 아티스트(Claude Opus)가 Aseprite로 아트를 그린다. 선택: 계획·리뷰(Fable), 시스템 리뷰(codex Astra). 서버 없음.",
  "roles": [
    {
      "id": "gameplay-dev",
      "title": "게임플레이 개발 (GDScript · GUT)",
      "command": [
        "pi",
        "--provider",
        "openai",
        "--model",
        "gpt-6.2-sol",
        "--thinking",
        "high"
      ],
      "default": true,
      "owns": [
        "src/** (art/ 제외)",
        "test/**",
        "tools/**"
      ],
      "talksTo": [
        "game-qa",
        "pixel-artist",
        "plan-reviewer"
      ],
      "checkpoints": [
        "python3 tools/lint.py exit 0",
        "영향받는 GUT 스크립트(tools/test_impact.py --run)가 assertion 0이 아닌 상태로 통과한다",
        "공유 상태나 세이브를 바꾸면 전체 test_parallel.py를 한 번 통과한다"
      ],
      "instructions": "docs/production/plans/<TASK>.md의 결정된 계획을 그대로 구현한다. 검증은 task.py verify로 감싸 evidence 로그를 남긴다. 게임 창은 직접 띄우지 않는다. 화면 확인이 필요하면 시나리오 이름과 기대 화면을 game-qa에 보낸다. 픽셀 아트는 만들거나 고치지 않고 pixel-artist에 필요한 스프라이트, 크기, 프레임을 보낸 뒤 결과물만 연결하고 export를 확인한다. 기다리는 동안 계획에 있는 다음 작업을 이어서 한다."
    },
    {
      "id": "game-qa",
      "title": "플레이 QA (qa-live 창 · 화면 증거)",
      "command": [
        "agy",
        "--model",
        "gemini-4-neon-high"
      ],
      "default": true,
      "readOnly": true,
      "talksTo": [
        "gameplay-dev",
        "pixel-artist"
      ],
      "checkpoints": [
        "mise run qa-live -- run <scenario>로 대상 기능의 실제 입력 경로를 끝까지 진행했다",
        "캡처한 화면 경로와 확인한 프레임, 로그 줄을 결과에 남긴다",
        "내비게이션 때문에 실패한 하네스는 한 번만 고치고, 그다음은 하네스 문제로 보고한다"
      ],
      "instructions": "사용자 작업 뒤에 열려 있는 qa-live 창 하나만 쓴다. 테스트마다 새 게임 창을 띄우지 않는다. 기능 옆 QA 시나리오에서 시작해 그 기능의 입력만 넣고, 화면 캡처로 배치, 겹침, 모션, 아트가 원래 크기에서 어떻게 보이는지 판단한다. 오래된 테스트 씬이 낡았으면 통과시키려고 고치지 말고 그대로 보고한다. 결과는 hc-team send --kind result로 보낸다. 로직 문제는 gameplay-dev에, 아트 문제는 pixel-artist에 보낸다."
    },
    {
      "id": "pixel-artist",
      "title": "픽셀 아티스트 (Aseprite)",
      "command": [
        "claude",
        "--model",
        "claude-opus-5-5",
        "--effort",
        "high"
      ],
      "default": true,
      "skills": [
        "pixel-art-direction",
        "aseprite-tools",
        "sprite-gen",
        "pixel-snapper"
      ],
      "owns": [
        "src/**/art/**",
        "docs/production/concepts/**"
      ],
      "talksTo": [
        "gameplay-dev",
        "game-qa"
      ],
      "checkpoints": [
        "pixel-art-direction 순서대로 무료 에셋 후보를 먼저 검토했다",
        "결과물을 게임 안 원래 크기로 확인하고 임시 승인(APPROVED.md) 기록을 남겼다"
      ],
      "instructions": "모든 픽셀 아트를 직접 그린다. 열려 있는 Aseprite 창에서 손으로 그리거나, 규칙으로 정해지는 프레임과 변형은 tools/art/pixelcode.py 스크립트로 굽는다. DESIGN.md와 docs/production/art-direction/ 기준을 따른다. 유료 에셋은 스타일 참고로만 쓴다. 후보는 사용자를 기다리지 않고 임시 승인으로 진행하고, 최종 선택은 리뷰 보드(mise run review)에 올린다. 완성한 파일 경로와 export 설정을 gameplay-dev에 hc-team send --kind handoff로 보낸다."
    },
    {
      "id": "plan-reviewer",
      "title": "계획·통합 리뷰어 (디렉터 보조)",
      "command": [
        "claude",
        "--model",
        "claude-fable-5-2",
        "--effort",
        "xhigh"
      ],
      "default": false,
      "readOnly": true,
      "skills": [
        "game-fun-audit"
      ],
      "talksTo": [
        "gameplay-dev",
        "game-qa"
      ],
      "checkpoints": [
        "계획에는 결정이 모두 내려져 있고, 사용자에게 남긴 질문은 open-questions.md에만 있다",
        "리뷰는 한 번에 끝내고, 반복되는 실수는 tools/lint.py 규칙 후보로 제안한다"
      ],
      "instructions": "다음 태스크 계획을 결정까지 끝낸 상태로 docs/production/plans/<TASK>.md에 쓰거나, 리뷰 준비가 된 보고서를 한 번 검토한다. ADR과 디자인 문서와 맞지 않는 부분, 재미를 떨어뜨리는 규칙, 과한 QA 단계를 찾는다. 코드는 고치지 않고 판정과 수정 지시를 gameplay-dev에 보낸다."
    },
    {
      "id": "systems-reviewer",
      "title": "시스템 적대적 리뷰 (세이브·상태)",
      "command": [
        "codex",
        "-m",
        "gpt-6.2-astra",
        "-c",
        "model_reasoning_effort=\"xhigh\"",
        "-s",
        "read-only"
      ],
      "default": false,
      "readOnly": true,
      "talksTo": [
        "gameplay-dev"
      ],
      "checkpoints": [
        "지적마다 file:line과 깨지는 게임 상태(세이브, 씬 전환, 인벤토리)를 적는다"
      ],
      "instructions": "jj diff --from main --to @ 범위를 읽기 전용으로 검토한다. 세이브 포맷과 downgrade, 씬 전환, 인벤토리, 오토로드 상태처럼 여러 시스템이 함께 걸린 결함을 찾는다. 개별 몬스터의 수치나 아트 취향은 다루지 않는다. 지적을 심각도순으로 gameplay-dev에 hc-team send --kind review로 보낸다."
    }
  ]
}
```

### `motion-interaction-lab`

```json
{
  "schemaVersion": 1,
  "id": "motion-interaction-lab",
  "name": "모션·인터랙션 랩 (변형 구현 · 제스처 재현 · 감각 리뷰)",
  "description": "언제: 시트·검색·캐러셀·스크롤 같은 모션과 인터랙션의 변형안을 만들고, 녹화와 실제 휠·트랙패드·터치 재현으로 비교해 고급스럽고 자연스러운 안을 고를 때. 기본 구성: 모션 개발(pi sol), 제스처 QA(agy Neon: ego-browser·input-replay·녹화), 모션 크리틱(Fable). 선택: 성능 리뷰(codex Astra). 서버: npm run dev(오버레이에서 교체).",
  "servers": [
    { "id": "web", "command": ["npm", "run", "dev"], "cwd": "." }
  ],
  "roles": [
    {
      "id": "motion-dev",
      "title": "모션 개발 (변형안 구현)",
      "command": ["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking", "high"],
      "default": true,
      "skills": ["motion", "gsap-react", "modern-web-guidance"],
      "owns": ["components/**", "src/**", "shared/motion/**"],
      "talksTo": ["gesture-qa", "motion-critic", "perf-reviewer"],
      "checkpoints": [
        "현재안을 그대로 두고 변형만 분기했다",
        "프로젝트 모션 검사(예: motion-lab check)와 수정 파일 lint exit 0",
        "모션 값은 프로젝트 토큰에서 가져오고, 새 값은 토큰 파일에 추가했다"
      ],
      "instructions": "요청받은 인터랙션의 변형안을 프로젝트 모션 규칙(오버레이 shared.md가 가리키는 문서)대로 구현한다. 시간, 곡선, 방향, 진입과 퇴장 속도 차이를 변형마다 한두 문장으로 요약한다. prefers-reduced-motion 경로를 유지한다. 구현이 끝나면 확인할 URL과 변형 id, 재현할 제스처를 gesture-qa에 보내고, 요약을 motion-critic에 보낸다. 크리틱의 피드백을 받으면 같은 변형을 덮어쓰지 않고 파생안(a-2 등)으로 만든다."
    },
    {
      "id": "gesture-qa",
      "title": "제스처·녹화 QA (ego-browser · input-replay)",
      "command": ["agy", "--model", "gemini-4-neon-high"],
      "default": true,
      "readOnly": true,
      "skills": ["ego-browser", "input-replay", "ego-recorder"],
      "talksTo": ["motion-dev", "motion-critic"],
      "checkpoints": [
        "변형마다 같은 시나리오로 데스크톱 휠/트랙패드와 모바일 터치를 재현했다",
        "재현 보고에 최종 위치나 항목, 끊긴 입력 수, 프레임 드롭 관찰이 있다",
        "녹화나 프레임 캡처 경로를 artifacts/에 남겼다"
      ],
      "instructions": "hc-team servers --run으로 URL을 찾는다. 변형마다 ego-browser로 화면을 열고, input-replay로 실제 장치 타이밍의 휠, 트랙패드 관성, 스와이프, 탭을 같은 순서로 재현한다. 시작 위치가 잘리거나 겹침, 튐, 늦은 반응, 스냅 실패를 프레임 단위로 기록한다. 파일은 수정하지 않는다. 비교표와 캡처 경로를 motion-critic과 motion-dev에 hc-team send --kind result로 보낸다."
    },
    {
      "id": "motion-critic",
      "title": "모션 크리틱 (브랜드 톤 · 감각 판정)",
      "command": ["claude", "--model", "claude-fable-5-2", "--effort", "high"],
      "default": true,
      "readOnly": true,
      "skills": ["review-animations", "interface-design", "animation-vocabulary"],
      "talksTo": ["motion-dev", "gesture-qa"],
      "checkpoints": [
        "변형마다 유지, 수정, 폐기 판정과 구체적인 값 수정안(ms, 곡선, 거리)이 있다",
        "폐기한 방향은 이유와 함께 남겨 같은 방향을 반복하지 않게 한다"
      ],
      "instructions": "gesture-qa의 캡처와 motion-dev의 요약을 보고 브랜드 톤(절제된 고급스러움, iOS 네이티브 반응성)에 맞는지 판정한다. 과한 크기나 튐, 싼 느낌의 이징, 진입보다 느린 퇴장, 처음 프레임의 잘림을 짚는다. 판정은 '퇴장은 진입보다 빠른 fade-out 180ms'처럼 바로 구현할 수 있는 값으로 쓴다. 최종 후보와 사용자가 확인할 URL을 parent에 hc-team send --kind result로 보낸다."
    },
    {
      "id": "perf-reviewer",
      "title": "모션 성능·번들 리뷰어",
      "command": ["codex", "-m", "gpt-6.2-astra", "-c", "model_reasoning_effort=\"xhigh\"", "-s", "read-only"],
      "default": false,
      "readOnly": true,
      "talksTo": ["motion-dev"],
      "checkpoints": [
        "라우트별 First Load JS 또는 번들 증가를 측정한 수치가 있다",
        "레이아웃을 일으키는 속성 애니메이션, 해제되지 않는 리스너와 타임라인, INP 위험을 file:line으로 지적한다"
      ],
      "instructions": "모션 diff를 읽기 전용으로 검토한다. transform/opacity가 아닌 속성의 애니메이션, 스크롤 핸들러의 강제 레이아웃, 언마운트 때 정리되지 않는 GSAP 타임라인이나 옵저버, 모션 라이브러리가 다른 라우트로 새는 import를 찾는다. 프로젝트에 측정 스크립트(예: npm run measure)가 있으면 그 결과를 근거로 쓴다. 지적을 motion-dev에 hc-team send --kind review로 보낸다."
    }
  ]
}
```

검증 기록 (2026-11-21):

```text
$ hc-team preset validate --stdin < godot-game-loop.json        → Valid preset: godot-game-loop
$ hc-team preset validate --stdin < jira-ticket-delivery.json   → Valid preset: jira-ticket-delivery
$ hc-team preset validate --stdin < motion-interaction-lab.json → Valid preset: motion-interaction-lab
$ hc-team launch <id> --cwd <project> --no-parent --with-servers --dry-run --json
  jira-ticket-delivery   (ps-frontend-admin)    dev→pi, web-qa→agy, reviewer→codex, servers [web]
  godot-game-loop        (little-bird-village)  gameplay-dev→pi, game-qa→agy, pixel-artist→claude
  motion-interaction-lab (front-vibe-helper)    motion-dev→pi, gesture-qa→agy, motion-critic→claude, servers [web]
```

전역 store에 저장하려면 `hc-team preset save --file <path>`를 쓴다. 이번 작업은 제안까지만 하고 `~/.agents/presets`에는 쓰지 않았다.

## 프로젝트 오버레이 (`docs/agent-presets/<id>/`) 팁

`hc-team init-project <id> --cwd <project>`로 틀을 만든 뒤 아래만 채운다. 아래 `preset.json` 예시 6개는 contracts.md의 병합 규칙(id로 병합, 역할은 얕은 병합, 배열은 교체)을 흉내 내 기반 프리셋에 합친 뒤 `hc-team preset validate --stdin`으로 모두 통과를 확인했다. `shared.md`와 `roles/*.md`에는 기존 문서 경로만 적는다. 규칙을 복사하지 않는다.

### gentle-renewal, gentle-renewal-2 → `jira-ticket-delivery`, `motion-interaction-lab`

- `jira-ticket-delivery/shared.md`: `CLAUDE.md`(i18n, 로케일 편집 금지), `docs/quality-gates.md`(ratchet), `docs/solutions/`, 로컬 URL `https://local.gentlemonster.com/<country>/<lang>/…`, 대상 브랜치 규칙(`release/*`, `simple-pr`).
- `preset.json`: dev 검사를 ratchet 기준으로 바꾼다.
  ```json
  { "roles": [ { "id": "dev", "owns": ["app/**", "components/**", "hooks/**", "shared/**"],
      "checkpoints": ["수정 파일 eslint 지적이 기준선보다 늘지 않는다", "npm run check:messages exit 0", "관련 jest 통과"] } ] }
  ```
- `roles/web-qa.md`: 확인할 국가와 언어 행렬(kr/ko, us/en, jp/ja, cn/zh-CN, int/en …), CloudFront 국가 헤더나 `?devCountry=xx` 재현법, green 확인용 헤더가 있다는 사실만(값은 적지 않는다).
- `motion-interaction-lab/preset.json`: 서버를 `npm run local:motion`으로 바꾼다. `shared.md`는 `motion-lab/AGENTS.md`, `motion-lab/vocabulary.md`, `shared/motion/tokens.ts`를 가리킨다. `roles/motion-dev.md`에는 `npm --prefix motion-lab run <new|record|check|final>` 순서를 적는다.
  ```json
  { "servers": [ { "id": "web", "command": ["npm", "run", "local:motion"], "cwd": "." } ],
    "roles": [ { "id": "motion-dev", "owns": ["components/**/__motion__/**", "motion-lab/**", "shared/motion/**"] } ] }
  ```

### ps-frontend-admin → `jira-ticket-delivery`

- `shared.md`: `AGENTS.md`(Architecture Rules, Verification), `docs/i18n-guide.md`, `docs/plans/2026-11-16_ie-ticket*.md`, `docs/solutions/README.md` 검색 절차, `scripts/sync-agents-override.sh`를 먼저 실행한다는 점.
- `preset.json`:
  ```json
  { "roles": [ { "id": "dev", "owns": ["src/features/**", "src/app/**", "src/shared/**", "src/widgets/**"],
      "checkpoints": ["수정 파일만 eslint exit 0", "npm run typecheck exit 0", "npm run test:related exit 0"] },
    { "id": "spec-planner", "default": true } ] }
  ```
  IE 티켓처럼 스펙 저장소와 Jira 댓글을 읽어야 하는 작업이 많아서 spec-planner를 기본으로 켠다.
- `roles/web-qa.md`: `https://productservice-local.systemiic.com/ko`, MFA 로그인은 테스트 계정 안내 문서 위치만 적는다.

### deopjib → 기존 `fullstack-delivery` + `motion-interaction-lab`

- `fullstack-delivery/preset.json`: Ash 백엔드와 Vite 클라이언트에 맞추고 iOS Safari QA 역할을 붙인다.
  ```json
  { "servers": [ { "id": "api", "command": ["mise", "run", "server:dev-db"], "cwd": "backend" },
                 { "id": "web", "command": ["bun", "run", "dev"], "cwd": "client" } ],
    "roles": [ { "id": "backend", "owns": ["backend/lib/**", "backend/test/**"],
                 "checkpoints": ["mix test 대상 파일 통과", "mix ash_typescript.codegen 후 client typecheck 통과"] },
               { "id": "frontend", "owns": ["client/src/**"], "checkpoints": ["bun run check exit 0", "bun run typecheck exit 0"] },
               { "id": "ios-qa", "title": "iOS Safari QA (OpenSafari)", "command": ["claude", "--model", "claude-opus-5-5", "--effort", "high"],
                 "default": false, "readOnly": true, "talksTo": ["frontend"],
                 "instructions": "mise run ios-safari-ready로 UDID를 받고 OpenSafari MCP로 실제 iOS Safari 포커스, 스크롤, 키보드 동작을 확인한다. NO_WEBKIT_CLIENT면 새 MCP 세션에서 다시 준비한다." } ] }
  ```
  `ios-qa`는 OpenSafari MCP가 설정된 Claude로 둔다(`.mcp.json`은 skillshare가 생성한다).
- `shared.md`: `docs/deopjib/context-for-agents.md`, `architecture-map.md`, `tasks/todo.md`, `docs/solutions/`.
- `motion-interaction-lab`: 서버를 `bun run dev`(`cwd: client`)로 바꾼다. payer chip 스크롤 같은 터치 인터랙션은 gesture-qa의 input-replay Android/모바일 경로로 확인한다.

### little-bird-village → `godot-game-loop`

- `shared.md`: `AGENTS.md`, `.agents/team-workflow.md`, `.agents/verification.md`, `docs/production/development-loop.md`, `DESIGN.md`.
- `roles/gameplay-dev.md`: `task.py verify <TASK>-<ROLE>-<CHECK>` 형식과 evidence 경로 `docs/production/evidence/t###/`, 착지는 `python3 tools/jj_land.py`.
- `roles/game-qa.md`: `mise run qa-live -- run <scenario>`, 시나리오 목록은 `tools/qa/README.md`. headless 캡처로는 렌더 증거가 안 된다는 점(verification.md).
- ADR-0059는 실행자를 Claude와 pi로만 정한다. 아래 "확인된 불일치" 1번을 결정한 뒤 game-qa를 pi나 Claude로 돌리려면 다음 overlay를 쓴다.
  ```json
  { "roles": [ { "id": "game-qa", "command": ["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking", "medium"] } ] }
  ```
- pi에는 `.pi/extensions/goal-notice.ts` 같은 프로젝트 로컬 확장이 있다. 신뢰 프롬프트가 뜨면 overlay에서 dev command에 `--approve`를 추가하는 것을 검토한다.

### front-vibe-helper → `motion-interaction-lab`

- `preset.json`: 서버 `npm run dev`(포트 4040, `predev`가 catalog를 생성)는 기본값 그대로 둔다. perf-reviewer는 기본으로 켠다. 성능과 모듈 크기가 기능과 같은 완료 조건이기 때문이다(AGENTS.md).
  ```json
  { "roles": [ { "id": "perf-reviewer", "default": true },
               { "id": "motion-dev", "owns": ["src/features/**", "src/components/**"],
                 "checkpoints": ["npm run test:contracts exit 0", "npm run check:components exit 0", "npm run measure 전후 값 보고"] },
               { "id": "motion-critic", "skills": ["review-animations", "interface-design", "transitions-dev"] } ] }
  ```
  기본 역할이 4개가 된다. 토큰을 아끼려면 motion-critic을 `default: false`로 돌린다.
- `shared.md`: `CONSTRAINTS.md`, `DESIGN.md`, `docs/design/pressable-feedback.md`, `src/features/catalog/review-feedback.json` 처리 규칙.

## 확인된 불일치와 주의점

1. **little-bird-village의 조정 채널이 둘이 된다.** 프로젝트는 `tools/handoff.py post/wait`와 `pi-intercom send`로 Claude와 pi를 잇는다(`.agents/team-workflow.md` Handoff). `godot-game-loop`는 `hc-team send`를 쓴다. 두 채널을 같이 쓰면 대기와 보고가 갈라진다. 이 프로젝트에서는 어느 쪽을 정본으로 할지 정해야 한다. 가장 작은 조정은 overlay `shared.md`에 "이 run 안에서는 hc-team send만 쓴다"를 적는 것이다. ADR-0059도 QA 실행자를 Claude와 pi로만 정한다. 그래서 game-qa의 agy 배정은 프로젝트 규칙과 다르다.
2. **agy의 ego-browser 발견 여부를 확인하지 못했다.** `~/.gemini/skills`에는 `ego-recorder`, `input-replay`, `hc-team`, `hc-po`, `simple-pr` 링크만 있고 `ego-browser`가 없다(`~/.agents/skills/ego-browser`는 있음). agy가 `~/.agents/skills`를 읽지 않으면 web-qa와 gesture-qa가 ego-browser를 못 쓴다. 다음 확인: `ln -s ~/.agents/skills/ego-browser ~/.gemini/skills/ego-browser` 후 agy 세션에서 스킬 목록을 본다. 이 확인은 이번 범위(에이전트 미실행) 밖이라 하지 않았다.
3. **`agy --model gemini-4-neon-high`는 dry-run으로 경로만 확인했다.** 실제 기동으로 모델 id를 확인하지는 않았다. `agy models` 목록에는 있다.
4. **codex 대화형 세션은 처음 여는 폴더에서 신뢰 프롬프트에 멈출 수 있다** (`skills/hc-po/SKILL.md` 54행). 운영자가 이미 쓰던 폴더에서 launch한다.
5. **문서와 코드가 다른 곳:** `contracts.md` §1 예시와 seed `fullstack-delivery.json`은 codex command에 `--no-daemon`을 직접 넣는다. `schema.md`는 launch가 붙이므로 저장하지 말라고 한다. 코드(`hc-team.mjs` 392행)는 이미 있으면 다시 붙이지 않으므로 둘 다 동작한다. 제안 프리셋은 `schema.md`를 따랐다. 또 seed 3종의 `description`은 영어다. 10개 이상을 고르는 스위처에서 훑어보려면 seed도 "언제 / 기본 구성 / 선택 / 서버" 형식의 한국어로 맞추는 것이 좋다.
