# Final Plan (Post Fable 5.2 Review): `hc-team` 서브 세션 프리셋, 우측 패널, 서버 URL 노출

`claude-fable-5-2` 검토([fable-plan-review.md](file:///Users/hj/study/hj-agent-tools/docs/plans/fable-plan-review.md))와 머신 실측 결과를 모두 반영한 실행 계획이다.

## 1. Goal

`herdr-core`(`hc`) 기반 역할 특화 서브 세션 팀을 단일 JSON 스키마 프리셋으로 정의·편집·병렬 실행하고, Herdr 우측 사이드 패널(`hj-team`)에서 관리하며, `hj-agents`에 부모·서브세션·독립 쉘·분리(detached) 서버 URL을 트리 형태로 전부 노출한다.

## 2. Key Revisions Adopted from Fable 5.2

- **글로벌 프리셋 폴더 & nix-dots 연계**:
  - 기본 경로 `~/.agents/presets` (`HC_TEAM_PRESETS_DIR` 환경변수로 오버라이드 가능).
  - `nix-dots`의 `files/workspace/.agents/.manual-link` 폴더 링크를 통해 `~/.agents/presets -> /Users/hj/dot/nix-dots/files/workspace/.agents/presets`로 직결, `homes/workspace/home-config.nix`(`home.sessionVariables`)와 `systems/aarch64-darwin/default.nix`(`launchd.user.agents.hc-team-environment`)에 `HC_TEAM_PRESETS_DIR` 선언.
  - 핵심 목표: `claude`, `codex`, `pi`, `agy`(Antigravity) 등 에이전트 종류에 구애받지 않고 역할별 최적 에이전트·모델·도구를 한 프리셋에 자유롭게 조합.

1. **런 상태 권위 단일화 (`hc` 라벨 + append-only `events.jsonl`)**:
   - `board.json` read-modify-write 경합 제거.
   - `hc-team send`는 자기 터미널에만 `hc label <self> hc.team.last="<kind>|<to>|<summary>"`를 쓰고 `~/.local/state/hc-team/runs/<runId>/events.jsonl`에 1줄 append한 뒤 `hc send` 실행.
   - 런 디렉터리는 `~/.local/state/hc-team/runs/<runId>/` 하나로 고정(프로젝트 gitignore 오염 제거).
   - `hj-team` Runs 뷰는 `terminals()`를 `labels["hc.team.run"]`으로 직접 묶어 표시(별도 폴링/exec/타이머 0개).
2. **유니크 이름 & 브리프 파일 & `hc wait` + `hc send` 전달**:
   - 터미널 이름은 `<run6>-<role>`(≤31자), 대상 조회는 `terminal.list` 라벨 `hc.team.run=<runId>`.
   - 브리프는 `~/.local/state/hc-team/runs/<runId>/briefs/<role>.md`에 쓰고 첫 메시지는 `Read <briefPath>. Task: <task>` 1줄.
   - 부팅 후 `hc wait` → `hc send`로 안정 전달하며 역할별 `{address, sent, reason}` 반환(부분 실패 시 롤백 없음, `launch --run <id> --roles x`로 재기동/교체 지원).
   - 영구 `~/.config/herdr-core/templates/*.md` 상시 동기화 폐기(드리프트 방지).
3. **스키마 v1 축소 (소비자 없는 필드 제거)**:
   - `orchestration.*`, `agent`, `tags`, `worktree`, `tools`, `scripts`, `projectOverlay.*`, `servers[].name/readyPattern/urlHint/optional` 삭제.
   - `enabled` → `default`, `canMessage` → `talksTo`.
   - `projectOverlay` 경로는 `docs/agent-presets/<preset-id>/` 규약으로 고정, 위치는 `git rev-parse --show-toplevel` 기준.
   - `qa-probe.mjs` 래퍼 제거(원본 `ego-browser`, `ego-rec`, `input-replay` + `curl` 직접 사용, `init-project`가 `roles/web-qa.md`에 구체적 QA 섹션 스캐폴딩).
4. **서버 URL 탐지 단순화 및 정확도 극대화**:
   - `ps -axo pid=,ppid=,args=` + `lsof +c 0 -nP -iTCP -sTCP:LISTEN -F pcn` + `hc connect` `terminal.list`.
   - 노이즈 필터 2규칙: (a) 포트 `< 49152`만 유지, (b) 같은 터미널 내 조상도 리스너이면 자식 제외.
   - URL 해석: `hj.url` 라벨 → Node `tls.connect` 300ms 프로브(`getPeerCertificate().subjectaltname`의 non-localhost non-wildcard 첫 `DNS:`, `(pid, port)` 캐시) → `http://localhost:<port>`.
   - 분리(`ppid=1`) 서버는 `lsof -a -d cwd -p <pids> -Fpn` 1회 호출로 스페이스 폴더 매칭해 `detached`로 반환.
   - `hj-agents` 폴링: 12초 주기 + 상태 변화 시 최소 2초 쓰로틀, stdout 동일 시 `cx.notify()` 생략, `narrow()` 또는 `!window().active` 시 스킵, `timeout: 5000`, 실패 시 60초 백오프, 소유자당 3개 표시 + `+N` 접기.
5. **우측 패널 (`hj-team`) & `hj-tabs` 통합**:
   - `hj-tabs`: `find(root, "teams")` 존재 시 항상 `Teams` 토글 버튼 표시, `syncPanel`에 `enabled ∪ ["teams"]` 전달.
   - `hj-team`: `Presets` / `Runs` 2탭, Launch Bar에 명시적 `Parent` 선택(현재 스페이스 `program.agent` 기본, 없으면 `none`/`--no-parent`), `timeout: 180000` + 더블 클릭 가드, CRUD는 `EditorState` JSON 에디터 다이얼로그(`modal: true`)로 `hc-team preset save --json` 검증 저장, `watchFolder` 절대경로 + 에러 시 30초 폴백, `Stop` 확인 다이얼로그.

## 3. Lanes & Ownership

공통 계약은 [contracts.md](file:///Users/hj/study/hj-agent-tools/skills/hc-team/references/contracts.md)에 고정한다.

| Lane | Worker | Owned Paths | Checkpoints |
| --- | --- | --- | --- |
| Lane 1 (`lane-cli`) | `pi` (`gpt-6.2-sol`, `high`) | `skills/hc-team/scripts/hc-team.mjs`, `tests/hc-team.test.mjs`, `presets/*.json` | `node --test tests/hc-team.test.mjs`, `hc-team schema`, `hc-team servers --json` 실측, `hc-team launch --dry-run` |
| Lane 2 (`lane-servers`) | `pi` (`gpt-6.2-sol`, `high`) | `external/herdr-mods/hj-agents/*`, `tests/herdr-mods/hj-agents.test.mjs` | `node --test tests/herdr-mods/hj-agents.test.mjs`, `herdr-app check external/herdr-mods/hj-agents` |
| Lane 3 (`lane-panel`) | `pi` (`gpt-6.2-sol`, `high`) | `external/herdr-mods/hj-team/*`, `external/herdr-mods/hj-tabs/*`, `tests/herdr-mods/hj-team.test.mjs` | `node --test tests/herdr-mods/hj-team.test.mjs`, `herdr-app check` (both mods) |
| Lane 4 (`lane-skill`) | `pi` (`gpt-6.2-sol`, `high`) | `skills/hc-team/SKILL.md`, `skills/hc-team/references/schema.md` | 스킬 예제 JSON이 `hc-team preset validate` 통과 |
| PO (Integration) | Main (`t114`) | `skills/hc-team/references/contracts.md`, `skills/hc-po/SKILL.md` (1줄 연계), `justfile`, `README.md`, `~/.config/herdr-app/layouts/main-skillshare.json`, `~/.local/bin/hc-team` | 전체 테스트, `just herdr-mods`, `just link`, `herdr-app check`, `herdr-app shot`, 라이브 E2E(`launch`+`send`+`status`+`stop`) |
| Adversarial Review | `codex --no-daemon -m gpt-6.2-astra -c model_reasoning_effort="xhigh"` | Read-only → `docs/plans/codex-review.md` | 전체 diff 적대적 리뷰 → 지적사항 수정 → 전체 재검증 |
