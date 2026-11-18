# Advice: 모델 라우팅, 서버 블록, 프리셋 셀렉터

검토자: `plan-advisor` (claude-fable-5-2), 2026-11-21. 읽기 전용. 현재 구현(`presets/*.json` 3개, `hc-team.mjs`, `hj-team`, `hj-agents`)을 읽고 썼다.

## 결론

1. **모델 라우팅**: 프리셋의 역할이 모델 argv 대신 "필요"의 이름(`route`)을 가리키게 하고, 이름 → argv 표를 파일 하나(`_routes.json`)에 둔다. 새 모델이 나오면 그 파일의 한 줄만 고친다. 모델 강약점은 구조화하지 말고 산문 파일 하나(`_models.md`)에 날짜와 함께 적는다.
2. **Servers 블록**: 찬성. 새 mod가 아니라 `hj-agents`의 두 번째 복사본(`props: { view: "servers" }`)으로 만든다.
3. **프리셋 셀렉터**: 칩을 2줄짜리 세로 목록 하나로 바꾼다. 개수에 따라 모드를 바꾸지 않는다.

---

## 1. 모델 라우팅

### 현재 상태

역할 11개가 모두 `command`에 모델을 직접 적고 있다: `pi … gpt-6.2-sol`이 6개, `codex … gpt-6.2-astra`가 2개, `claude --model opus`가 2개, 모델 지정 없는 `agy`가 2개. 프리셋이 10개를 넘으면 모델 교체 한 번에 40곳 안팎을 고쳐야 하고, 프로젝트 저장소의 오버레이(`docs/agent-presets/*/preset.json`)는 놓치기 쉽다.

### 데이터 형태

**`<presetsDir>/_routes.json`** (기본 `~/.agents/presets/_routes.json`). 프리셋 폴더 안에 두면 기존 `watchFolder`, `HC_TEAM_PRESETS_DIR`, nix-dots 링크가 그대로 적용된다. `_`로 시작해서 프리셋 id 정규식(`^[a-z0-9]…`)에 걸리지 않으므로 목록 코드(`hc-team.mjs:298`)는 고칠 필요가 없다.

```json
{
  "schemaVersion": 1,
  "reviewed": "2026-11-21",
  "routes": {
    "implement":   { "command": ["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking", "high"], "why": "…" },
    "deep-review": { "command": ["codex", "-m", "gpt-6.2-astra", "-c", "model_reasoning_effort=\"xhigh\""], "why": "고복잡도 심층 처리와 리뷰에 강함. 계획 수립에는 쓰지 않음" },
    "plan":        { "command": ["…"], "why": "…" },
    "investigate": { "command": ["…"], "why": "…" },
    "browser-qa":  { "command": ["…"], "why": "…" },
    "design-review": { "command": ["…"], "why": "…" }
  }
}
```

**역할**은 `route`와 `command` 중 정확히 하나를 가진다.

```json
{ "id": "reviewer", "title": "Adversarial Reviewer", "route": "deep-review", "readOnly": true, "instructions": "…" }
```

규칙은 네 가지다.

- **이름은 모델이 아니라 필요를 가리킨다.** `review-astra`나 `sol-high`가 생기면 설계가 틀어진 것이다. 커뮤니티 평가가 바뀔 때 움직이는 단위는 "리뷰는 이제 누가 잘하나"이지 "astra를 쓰던 곳"이 아니다.
- **값은 argv 전체다.** 하네스, 모델, effort를 따로 필드로 나누지 않는다. 네 CLI의 플래그가 전부 다르다(`claude --model/--effort`, `codex -m/-c model_reasoning_effort=`, `pi --provider/--model/--thinking`, `agy --model/--effort`, 로컬 `--help`로 확인). 필드로 나누면 `hc-team` 안에 하네스 어댑터 4개가 생기고 새 하네스마다 코드가 늘어난다.
- **route는 현재 프리셋이 실제로 쓰는 것만 만든다.** 지금 역할로 보면 5~6개다. 8개를 넘기 시작하면 역할별 매핑을 다시 만든 것이다.
- **리터럴 `command`는 탈출구로 남긴다.** 특수 플래그가 필요한 역할은 그대로 쓴다. `schemaVersion`은 1로 유지되고 기존 프리셋도 유효하다.

### 해석 시점과 계약 변경

| 위치 | 변경 |
| --- | --- |
| 스키마 §1 | 역할에 `route`(문자열) 추가. `command`와 `route`는 oneOf |
| `preset save` / `validate` | 모르는 route는 `/roles/2/route` 경로와 사용 가능한 이름 목록으로 오류 |
| 오버레이 병합 | 오버레이가 `command`를 주면 `route`를 지우고, `route`를 주면 `command`를 지운다. 프로젝트별 모델 교체는 이것으로 충분하다 |
| `preset list/get --merged --json` | 역할마다 해석된 `command`를 채우고 `route` 이름은 유지. 패널의 `describeRoleCommand`는 고칠 필요가 없다 |
| `launch` | 해석된 `command`를 런 스냅샷(`runs/<id>/preset.json`)에 저장. 실행 중인 런은 이후 route 변경의 영향을 받지 않는다. 모르는 route는 그 역할만 `reason: "unknown route: x"`로 실패(기존 무롤백 정책 그대로) |
| CLI 추가 | `hc-team routes [--json]`: 표와 함께 **route별로 어느 프리셋의 어느 역할이 쓰는지**, 리터럴 `command`를 쓰는 역할 목록을 출력. `hc-team routes save (--json\|--file\|--stdin)`: 검증 후 원자적 쓰기. 이 둘이면 된다 |
| `seed` | 저장소의 `presets/_routes.json`을 없을 때만 복사. 저장소 프리셋은 route만 참조하므로 모델이 바뀌어도 저장소를 고칠 일이 없다 |
| 패널 | 헤더에 `Models` 버튼 하나. 기존 JSON 에디터 다이얼로그를 `_routes.json`에 재사용. 역할 행에 `route` 배지와 해석된 모델 표시, 미해석이면 빨간색. `reviewed` 날짜를 흐리게 표시 |
| `hc-po` | 한 줄 추가: 레인을 직접 띄울 때도 `hc-team routes`에서 argv를 가져온다. 계획 문서의 레인 표에 모델을 적지 않게 된다 |

### 모델 프로파일: `<presetsDir>/_models.md`

이 파일을 읽는 것은 코드가 아니라 `hc-team` 스킬을 실행하는 LLM과 사람이다. 그래서 산문이 맞는 형식이다. 개인 경험과 빠르게 변하는 평가가 들어가므로 저장소의 스킬이 아니라 사용자 데이터(nix-dots)에 둔다. 스킬은 경로만 가리킨다.

```markdown
## gpt-6.2-astra  (codex -m gpt-6.2-astra)        확인: 2026-11-21
- 강점: 고복잡도 심층 처리, 적대적 리뷰  [커뮤니티 + 로컬]
- 약점: 계획 수립  [로컬]
- 쓰는 route: deep-review

## 관찰 로그
- 2026-11-21 deep-review: <무슨 일이 있었나, 한 줄>
```

모델마다 강점, 약점, 호출 방법, 근거 출처(커뮤니티/로컬), 확인 날짜를 적는다. 맨 아래 관찰 로그에는 PO나 사용자가 한 줄씩 덧붙인다. 변경 이력은 nix-dots의 git이 남긴다.

**이 문서의 예시 중 사실로 적은 것은 operator가 말한 astra 한 줄뿐이다.** 나머지 모델의 강약점은 내 기억으로 채우지 않았다. 초기 `_models.md`는 아래 갱신 절차로 채워야 한다.

### 갱신 절차 (스킬에 10줄짜리 섹션으로)

트리거: "새 모델 나왔어", "모델 라우팅 갱신해줘".

1. **쓸 수 있는 모델을 로컬에서 확인한다. 기억으로 적지 않는다.** `pi --list-models`, 각 하네스의 `--help`와 설정을 읽는다.
2. 웹 검색으로 최근 평가를 날짜와 함께 모으고 `_models.md`의 관찰 로그와 합친다.
3. `_models.md`의 해당 항목과 확인 날짜를 고친다.
4. route 변경안을 표로 제안한다(`route: 이전 → 이후`, 영향받는 역할은 `hc-team routes` 출력). 사용자 승인을 받는다.
5. `hc-team routes save`로 저장하고 `reviewed`를 오늘로 바꾼다.
6. 프리셋 하나를 `hc-team launch <id> --dry-run`으로 확인한다.

### 현재 프리셋에서 바로 볼 것

- `claude --model opus`는 별칭이라 최신 Opus를 따라가지만 Fable 계열은 가리키지 않는다. `claude-opus-5-5`와 `claude-fable-5-2`를 구분해 쓰려면 route에 ID를 명시한다(두 ID는 이 세션 환경에 표시된 값이다).
- `agy --effort …`에는 `--model`이 없어 Antigravity 기본값이 쓰인다. `gemini-4-neon`을 의도한다면 `agy`의 모델 목록을 확인한 뒤 명시한다.
- `~/.agents/presets/`에 이미 시드된 3개는 `seed`가 덮어쓰지 않는다. route 전환 때 직접 갱신해야 한다.

### 트레이드오프

- 프리셋 파일만 읽어서는 모델을 알 수 없다. `preset get --merged`와 패널이 해석 결과를 보여 주는 것으로 보완한다.
- 한 줄 수정이 10개 넘는 프리셋에 동시에 적용된다. 목적이 그것이지만 영향 범위가 크다. `hc-team routes`의 사용처 목록, 런 스냅샷, nix-dots git 되돌리기로 감당한다.
- route를 얼마나 잘게 나눌지는 판단이 필요하다. 너무 적으면 역할이 맞지 않는 모델에 묶인다. 리터럴 `command`와 오버레이가 탈출구다.
- 모델 ID 오타는 launch 후 터미널에서야 드러난다. 받아들인다.

### 만들지 말 것

- 능력 점수표나 자동 배정기. 아무도 측정하지 않는 숫자를 유지해야 하고, 산문 + LLM + 사용자 승인이 같은 일을 더 잘한다.
- 하네스별 `model`/`effort` 필드와 어댑터.
- CLI의 모델 ID 검증. 하네스마다 방법이 달라 어댑터가 다시 생긴다.
- 폴백 체인, route 상속, 인자 덧붙이기(`args`), 프로젝트별 routes 파일.
- 주기적 자동 갱신과 스크래핑.
- routes 전용 폼 UI. JSON 에디터로 충분하다.
- `hc` 템플릿을 route로 쓰는 것. `templates.list`는 이름과 설명만 돌려줘서 패널이 모델을 표시할 수 없고, `hc-team`이 하는 실행 파일 절대경로 해석(`spawn_failed` 방지)과 `--no-daemon` 주입을 적용할 수 없다.
- 모델 ID 일괄 치환 명령(`retarget --from … --to …`). 새 개념은 없지만 기준 축이 틀렸고(평가 변화는 모델이 아니라 작업 단위로 온다) 매번 파일 10여 개를 건드린다.

---

## 2. Servers 블록을 Agents 목록 밖으로

**찬성.** 에이전트가 아닌 행이 Agents 목록에 있으면 우선순위 정렬, 섹션 카운트, `setAgentOrder`의 의미가 흐려진다. 지금 `shell-servers` 그룹은 `members: []`인 특수 그룹으로 끼워져 있다(`hj-agents/main.js:503-515`).

- **범위**: Shell Servers와 Detached만 옮긴다. 에이전트와 서브 세션이 소유한 서버는 지금처럼 그 행 아래에 둔다("이 URL을 누가 띄웠나"가 맥락이다). 새 블록에 전체 URL을 중복해서 보여 주지 않는다.
- **같은 mod의 두 번째 복사본으로 만든다.** 레이아웃 `sidebar-lists`에 `{ "id": "servers", "type": "block", "hidden": true, "size": { "px": 30 }, "content": { "mod": "hj-agents", "props": { "view": "servers" } } }`를 추가한다. 모듈 스코프의 `snapshot`과 폴러를 그대로 공유하므로 스캔은 여전히 한 번이다. 별도 mod(`hj-servers`)로 만들면 폴러가 둘이 되거나 `setShared`로 스냅샷을 넘겨야 하는데, `setShared`는 호출할 때마다 모든 mod를 다시 그린다.
- **블록의 표시와 크기는 Agents 복사본이 맡는다.** 숨겨진 블록의 복사본은 한 번도 보인 적이 없으면 시작되지 않아서 스스로 나타날 수 없다. `hj-tabs`가 `hj-subtabs`를 다루는 것과 같은 구조다. 서버가 0개이거나 레일(`narrow()`)이면 `layout.hide`, 있으면 `layout.show`와 `layout.resize { id: "servers", px }`를 호출한다. `px`는 접혔을 때 헤더 높이 30, 펼쳤을 때 `30 + 행 수 × 26`에 상한 약 220을 두고 안에서 스크롤한다. `syncSubRow`처럼 "요청함" 가드를 둬서 레이아웃이 따라오는 동안 반복 호출하지 않는다.
- **다시 그리기**: `cx.notify()`는 폴링을 시작한 복사본만 다시 그린다. 모듈 스코프에 `version` 카운터를 두고, servers 복사본은 12초 타이머에서 자기 `seenVersion`과 비교해 다를 때만 notify한다. 스캔은 in-flight 가드로 중복되지 않는다.
- **접힘 상태**는 `setShared("servers.folded", …)`에 둔다. Agents 복사본이 높이 계산에 써야 하고 변경이 드물어서 전체 재렌더 비용이 문제되지 않는다.
- **블록이 없는 레이아웃**(`find(root, "servers")`가 null)에서는 지금의 목록 내 그룹을 그대로 쓴다. 이미 작성돼 있고 분기 하나면 된다. 블록이 있을 때만 `shellGroups`를 목록에서 뺀다.
- 헤더는 `Servers`와 개수, 그룹은 스페이스 단위로 한다. 레이아웃 조각은 mod 헤더 주석과 README에 적는다(레이아웃 파일은 저장소 밖이다).

## 3. 프리셋 셀렉터: 3개에서 10개 이상으로

지금은 `flex_wrap` 칩(이름 + 역할 수 + `docs/` 배지)이고 설명은 선택한 프리셋의 카드에만 나온다(`hj-team/main.js:332-343`). 368px 패널에서 10개면 칩이 4~5줄로 감기고 설명은 클릭하기 전에는 보이지 않는다.

**세로 목록 하나로 바꾼다.**

- 행은 2줄이다. 1줄: 이름, 역할 수, `docs/` 배지. 2줄: 설명 한 줄(흐리게, `truncate`). 행 높이는 약 44px.
- 클릭 한 번으로 선택되는 것은 칩과 같다. 선택된 행은 `t.selected` 배경.
- 목록에 `max_h` 약 220(5행)과 `overflow_y_scrollbar()`를 준다. 5개 이하면 스크롤 없이 전부 보이고, 그 이상이면 목록 안에서만 스크롤해 Launch Bar가 밀려나지 않는다. 가상 리스트는 필요 없다.
- **정렬로 관련성을 준다**: 현재 프로젝트에 오버레이가 있는 것(`hasOverlay`) 먼저, 다음은 최근 실행 순(`localStorage`의 `lastUsed`), 다음은 이름순. 설정 없이도 자주 쓰는 것이 위에 온다.
- 필터 `Input`은 8개를 넘을 때만 그린다. 이름, 설명, 역할 id를 부분 일치로 거른다. `InputState`는 `init`에서 항상 만들고 렌더만 조건부로 한다(렌더 중에는 만들 수 없다).
- 아래 상세 카드는 설명 전문을 그대로 둔다.

**하지 말 것**: 개수에 따라 칩과 목록을 바꾸는 이중 모드(컴포넌트가 둘이 된다), 드롭다운이나 팝업 피커(클릭이 하나 늘고 설명이 숨는다), 태그·카테고리·폴더(`tags`는 스키마에서 이미 뺐고 10~20개는 필터로 충분하다), 즐겨찾기 핀(정렬이 대신한다).

비용은 프리셋이 3개일 때 세로 공간을 약 100px 더 쓰는 것이다. 설명을 항상 보여 달라는 요구와 맞바꾼 것이고, 모드를 둘로 나누는 것보다 싸다.
