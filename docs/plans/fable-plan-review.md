# Plan Review: `hc-subsession-presets.md`

검토자: `plan-advisor` (claude-fable-5-2), 2026-11-21. 읽기 전용 검토이며 아래 수치는 이 머신에서 실측했다(터미널 63개, LISTEN pid 74개).

## 결론

방향(로컬 `hc` + 프리셋 + 패널 + 서버 URL)은 맞다. 다만 지금 설계대로 구현하면 **확실히 깨지는 지점이 8개** 있고, 상태를 파일 3종(`run.json`/`board.json`/템플릿)에 복제하는 부분이 경합과 동기화 문제의 원천이다. 핵심 제안은 세 가지다.

1. **런 상태의 주인을 `hc` 라벨로 옮긴다.** `board.json`과 `run.json` 조인을 없애면 동시 쓰기 경합, 런 디렉터리 탐색, 패널 폴링이 같이 사라진다.
2. **서버 URL 해석을 argv/인증서 파일 파싱에서 TLS 프로브로 바꾼다.** 휴리스틱 5단이 함수 하나가 된다.
3. **스키마에서 소비자가 없는 필드 12개를 뺀다.** 패널 CRUD는 폼 대신 JSON 에디터 다이얼로그로 시작한다.

착수 전에 2분짜리 실측 3개가 필요하다(§5).

---

## 1. 그대로 구현하면 깨지는 것 (P0)

**1-1. `--name <role>`은 두 번째 런에서 실패한다.** `hc run --name`은 라이브 터미널 전체에서 유일해야 하고 1~32자다. 같은 프리셋을 두 프로젝트에서 띄우거나 재실행하면 `dev`가 충돌한다. 이름은 `<run6>-<role>`로 만들고(`role.id` 24자 + 7자 = 31자), 대상 조회는 이름이 아니라 `terminal.list {labels: {"hc.team.run": id}}`로 한다. 이 필터는 API에 이미 있다.

**1-2. `ps -axo pid=,ppid=,comm=,args=`는 파싱할 수 없다.** `comm`에 공백이 있다(`next-server (v16.3.6)`, `LM Studio`). `ps -axo pid=,ppid=,args=`만 쓰고, 프로세스 이름은 `lsof +c 0 -F pcn`의 `c` 필드에서 얻는다. `lsof -F`는 요청하지 않은 `f` 줄도 내보내므로 모르는 접두는 무시하고, IPv4/IPv6 이중 바인드는 `(pid, port)`로 중복 제거한다.

**1-3. `readyPattern` 정규식은 `hc wait --output`에 넘길 수 없다.** `--output`은 평문 포함 검사이고 대기 시작 이후 출력만 본다. `"Local:|ready|listening"`은 절대 매칭되지 않는다. 준비 판정은 "그 터미널에 귀속된 LISTEN 소켓이 생겼다"로 바꾼다(§3의 스캐너 재사용, 60초 후 경고만 남기고 진행). `readyPattern`과 `urlHint`는 스키마에서 삭제한다.

**1-4. mod의 `exec`에는 stdin이 없다.** 시그니처가 `exec(command, args, {cwd, on, timeout})`이라 패널에서 `hc-team preset save --stdin`을 쓸 수 없다. CLI에 `preset save --json '<문자열>'`을 추가한다(`--stdin`은 에이전트용으로 유지).

**1-5. Teams 버튼은 지금 방식으로는 나타나지 않는다.** `shared.json`에 `"workspace.panels": ["files","changes"]`가 이미 저장돼 있어 `?? [...]` 기본값이 적용되지 않는다. 이 키는 앱의 welcome이 소유하므로 건드리지 말고, 버튼은 `find(root, "teams")`가 있을 때 무조건 그린다(`SUB_ROW`와 같은 degrade 패턴). 같은 이유로 `syncPanel`의 `enabled.includes(stored)`가 `"teams"`를 버려서 스페이스 전환 때 패널이 닫힌다. `syncPanel`에는 `enabled ∪ 레이아웃에 있는 teams`를 넘긴다.

**1-6. `board.json`은 병렬 `send`에서 갱신이 유실된다.** temp+rename은 쓰기 하나만 원자적이고, 두 역할이 동시에 read-modify-write하면 한쪽이 사라진다. async-parallel의 정상 경로가 바로 이 경우다. 해법은 §2-1.

**1-7. 패널에서 띄운 런의 `parent`가 쉘일 수 있다.** `focused().terminal`은 fish 탭이나 서브 에이전트일 수 있고, 그러면 `hc-team send --to parent`가 쉘 프롬프트에 텍스트를 붙여 넣고 Enter를 친다. Launch Bar에 Parent를 명시적으로 표시한다. 기본값은 현재 스페이스의 포커스된 에이전트이고 `program.agent`인 터미널만 선택할 수 있게 한다. 에이전트가 없으면 parent 없이 띄우고(`--no-parent`) `--to parent`는 이벤트 기록만 한다. 이 경우 오케스트레이터가 사람이라는 점을 계획에 적는다.

**1-8. Launch `exec`의 기본 타임아웃 30초가 `hc run`의 첫 메시지 대기 60초보다 짧다.** `timeout: 180000`을 넘기고, 진행 중 플래그로 더블 클릭을 막는다(막지 않으면 스쿼드가 두 벌 뜬다). 부분 실패는 롤백하지 말고 역할별 `{address, sent, reason}`을 돌려준다. 실패한 역할만 다시 띄우는 `launch --run <id> --roles x`가 필요한데, 컨텍스트가 찬 역할을 교체하는 `hc-po` 규칙에도 같은 명령이 쓰인다.

## 2. 단순화 (P1)

**2-1. 런 상태는 라벨, 이력은 append-only.**
- 역할의 생사와 상태는 `hc`가 이미 안다. `board.json`에 `working/blocked`를 또 적으면 권위가 둘이 된다.
- `hc-team send`는 자기 터미널에만 `hc label <self> hc.team.last='<kind>|<to>|<요약 120자>'`를 건다. 역할마다 쓰는 대상이 달라 경합이 없고, 라벨 변경은 mod에 라이브 이벤트로 온다.
- `events.jsonl`에는 한 줄 append만 한다. 이 쓰기가 실패해도 send는 성공으로 처리한다. `status`는 읽을 때 접는다.
- 그러면 Runs 뷰는 `terminals()`를 `labels["hc.team.run"]`으로 묶기만 하면 된다. exec, 파일 감시, 타이머가 모두 필요 없다. 지금 계획에는 패널이 여러 프로젝트의 `<project>/.hc-team/runs/`를 찾는 방법이 아예 없다.
- 런 디렉터리는 `~/.local/state/hc-team/runs/<id>/` 한 곳으로 정한다. 프로젝트 안의 `.hc-team/`은 gitignore 오염과 "git 밖/쓰기 불가" 분기를 만든다. 런 시작 시 병합된 프리셋 스냅샷을 여기에 저장해 실행 중 프리셋이 삭제·수정돼도 영향이 없게 하고, launch 때 오래된 런을 정리한다.

**2-2. `send` 인자를 줄인다.** `--run`과 `--from`은 `$HC_TERMINAL_ID`의 라벨에서 유도한다. 에이전트는 `hc-team send web-qa "<한 줄>" [--artifact p] [--kind k]`만 친다. `hc send`가 이미 `<hc from="…">`를 붙이므로 `[hc-team:<run>:<from>→<to>]` 접두는 `[<kind>]`만 남긴다. `canMessage` 위반은 거부하지 말고 경고 후 전달한다. 원시 `hc send`로 우회할 수 있어 보안 장치가 아니고, 거부는 에이전트가 재시도하다 멈추는 새 실패 모드만 만든다. 대상이 `blocked`이거나 종료돼 `hc send`가 실패하면 0이 아닌 종료 코드와 이유 한 줄을 돌려준다.

**2-3. PO가 받는 메시지를 줄인다.** `autoNotifyParent`로 모든 핸드오프를 참조로 받으면 PO 토큰이 역할 수만큼 늘어난다. parent에게는 parent 앞으로 온 `result|blocked|ask`만 전달하고, 나머지는 PO가 필요할 때 `hc-team status`(기본 출력은 역할당 한 줄 텍스트, `--json`은 mod용)로 읽는다.

**2-4. 브리프는 파일, 태스크 인자는 한 줄.** launch가 `runs/<id>/briefs/<role>.md`를 쓰고 첫 메시지는 `Read <path>. Task: <task>`만 보낸다. 인용 문제가 없고, 사람이 검사할 수 있고, 역할을 다시 띄울 때 재사용된다. `shared.md`의 "짧은 핵심 요약만 인라인"은 CLI에 요약할 주체가 없으니 경로 포인터만 넣는다.

**2-5. 템플릿 컴파일은 조건부로 유지한다(§5-1 결과에 따라).** `templates/<preset>--<role>.md`를 상시 동기화하면 드리프트(수동 편집 덮어쓰기, 삭제·개명 후 고아 파일)가 생긴다. 프로젝트 오버레이가 `command`와 `instructions`를 바꿀 수 있어 전역 템플릿은 실제 launch 경로와도 어긋난다. 직접 실행에서도 `first_message`가 추적되면 템플릿을 전부 삭제한다. 템플릿이 있어야만 추적되면 launch가 **런 전용 템플릿을 쓰고, 실행하고, 지운다**. 어느 쪽이든 `Sync hc templates` 버튼과 `sync-templates` 명령은 없앤다. `id` 32자 + `--` + `role` 24자 = 58자가 템플릿 이름 제한을 넘는지도 확인한다.

**2-6. 스키마 v1 축소안.**

```json
{
  "schemaVersion": 1,
  "id": "web-feature-squad",
  "name": "Web Feature Squad",
  "description": "…",
  "servers": [{ "id": "web", "command": ["bun", "dev"], "cwd": "." }],
  "roles": [{
    "id": "dev",
    "title": "Frontend Developer",
    "command": ["pi", "--provider", "openai", "--model", "gpt-6.2-sol", "--thinking", "high"],
    "default": true,
    "readOnly": false,
    "skills": [],
    "owns": ["src/**"],
    "talksTo": ["web-qa", "reviewer"],
    "checkpoints": ["bun tsc --noEmit 통과", "bun test 통과"],
    "instructions": "…"
  }]
}
```

| 삭제·변경 | 이유 |
| --- | --- |
| `orchestration.*` | `mode`와 `transport`는 값이 하나뿐이고, `maxConcurrency`는 큐를 구현하는 주체가 없다 |
| `agent` | `command[0]`에서 유도된다. 두 필드가 어긋날 수 있다 |
| `tags`, `worktree`, `tools`, `scripts` | 계획 안에 소비자가 없다. 프로젝트 스크립트는 오버레이 `tools/`가 이미 담당한다 |
| `projectOverlay.dir`, `autoScaffold` | 경로는 `docs/agent-presets/<id>/` 규약으로 고정하면 `..` 검증이 필요 없다. launch가 남의 저장소에 파일을 만드는 부작용은 `init-project`만 갖게 한다 |
| `servers[].name`, `readyPattern`, `urlHint`, `optional` | §1-3 참고. 이름은 `<run6>-<id>`로 유도한다 |
| `enabled` → `default` | 실행 시 선택은 UI 상태다. 프리셋에는 기본 체크 여부만 둔다 |
| `canMessage` → `talksTo` | 강제가 아니라 브리프에 들어가는 라우팅 안내다 |
| `checkpoints` | `"typecheck"` 같은 라벨은 프로젝트마다 명령이 달라 에이전트에게 의미가 없다. 명령이나 관찰 가능한 문장을 쓰고 오버레이가 덮어쓴다 |

`owns`, `readOnly`, `skills`, `checkpoints`는 브리프에 들어가는 문장일 뿐 강제 장치가 아니라고 `schema.md`에 적는다. `codex --no-daemon`은 검증 실패로 처리하지 말고 launch 시 자동으로 넣는다. `which`로 얻은 절대경로는 프리셋에 저장하지 않는다.

**2-7. 오버레이 병합 규칙을 명시한다.** 배열(`skills`, `owns`, `talksTo`)은 합치지 않고 교체한다. 오버레이의 `"default": false`와 역할 제거(`"remove": true`)를 구분한다. 검증은 병합 후 한 번 더 한다(없어진 역할을 가리키는 `talksTo`). 오버레이 위치는 `--cwd`가 아니라 `git rev-parse --show-toplevel` 기준으로 찾는다. 이 사용자는 `ps-frontend-admin.feature-PSR-1309-…` 같은 워크트리에서 작업한다.

**2-8. `qa-probe.mjs`는 v1에서 뺀다.** `replay`, `rec-list`, `rec-test`는 `input-replay`와 `ego-rec`을 감싸는 통과 계층이고, `skills/input-replay/scripts/replay.mjs`를 상대 경로로 참조하면 스킬별 심링크 설치(`link_dirs`)에서 깨진다. 출력이 길다면 원본 도구에 `--json` 요약을 추가한다. `check <url>`은 `curl -sk -o /dev/null -w '%{http_code} %{time_total}'` 한 줄이다.

**2-9. 패널 CRUD는 JSON 에디터로 시작한다.** `EditorState` + `Editor`(구문 강조 지원)로 프리셋 JSON을 다이얼로그에서 편집하고, 저장할 때 CLI로 검증해 오류(JSON 경로 + 메시지)를 그대로 보여준다. 한 위젯으로 모든 필드를 다루고 스키마와 항상 일치한다. 368px 패널에서 `canMessage` 화살표, Duplicate, Refresh, Sync 버튼, 역할별 폼 다이얼로그는 v1에서 뺀다. Role 폼을 유지한다면 `command`는 쉘 문자열이 아니라 `Textarea`에 인자를 한 줄씩 적는다. `-c model_reasoning_effort="xhigh"` 같은 따옴표 분해를 피하기 위해서다.

## 3. 서버 노출 (`hc-team servers` + `hj-agents`)

**실측.** LISTEN pid 74개 중 55개가 ppid 체인으로 터미널에 귀속된다. tty로만 잡히는 것은 0개이고, 귀속된 것 중 21개는 tty가 `??`다(에이전트의 Bash 도구가 띄운 서버). ppid 체인이 맞는 선택이다. `hc connect`에 `terminal.list` 한 줄을 쓰고 stdin을 닫으면 31ms에 응답 한 줄이 온다. `hc ls --json`에는 `pid`와 `labels`가 없어서 `hc connect`가 실제로 필요하다. `lsof`와 `ps`는 각각 0.11초다.

**3-1. 노이즈는 denylist가 아니라 구조 규칙 두 개로 거른다.** 계획의 프로세스 이름 목록은 계속 낡는다.
- (a) **포트 49152 미만만 남긴다.** claude/agy/codex/antigravity의 내부 소켓 34개가 전부 `127.0.0.1`의 50047~64798이었다. 이름 목록 없이 모두 빠진다.
- (b) **같은 터미널 안에서 조상도 리스너면 자식을 버린다.** turbopack 워커(`pool_entry-[turbopack-node]`, 5678~5694)는 전부 `next-server`의 자식이다. (a)를 먼저 적용해야 claude의 자식인 `tls-proxy.mjs`(9443)가 남는다.
- `rapportd`, `ControlCenter`, `zed`, `GitKraken`, `LM Studio`, `jetbrains-toolbox`는 터미널 조상이 없어 귀속 단계에서 이미 빠진다. 목록에 넣을 필요가 없다.

**3-2. URL 해석은 TLS 프로브로 한다.** `next-server`는 argv가 비어 있어 플래그는 부모(`node …/next dev --experimental-https --experimental-https-cert local-productservice-cert.pem -p 4437`)에 있고, 인증서 경로가 상대 경로라 pid별 `lsof -d cwd`(75ms)와 `openssl`이 더 필요하다. `env-cmd … next start -p 3460` 앞에 별도 `tls-proxy.mjs`를 둔 구성은 argv 규칙으로 일반화되지 않는다. 대신 Node에서 `tls.connect({host: "127.0.0.1", port, rejectUnauthorized: false})`를 300ms 타임아웃으로 시도한다. 핸드셰이크가 성공하면 `https`이고 `getPeerCertificate().subjectaltname`에서 `localhost`와 와일드카드가 아닌 첫 `DNS:`를 호스트로 쓴다. 실패하면 `http://localhost`다. 결과는 `(pid, port)`로 캐시하므로 새 리스너만 비용을 낸다. argv 분석, 인증서 파일 탐색, `openssl`, 포트 번호 휴리스틱(`443/8443/4430-4439`)이 모두 없어진다. `hj.url` 라벨 우선은 유지하고, `hc read` 스크래핑(3순위)은 삭제한다. 히스토리 읽기는 풀스크린 앱을 스크롤할 수 있고 `working` 중에는 불완전한 결과를 준다.

**3-3. "전부 빠짐없이"는 현재 설계로 보장되지 않는다.** `nohup`/`setsid`로 분리된 서버는 ppid가 1이라 귀속되지 않는다. 지금도 `python :8000/:9500`, `node :9931/:9932`, `beam.smp`, `postgres`가 그렇다. 귀속 실패한 pid들의 cwd를 `lsof -a -d cwd -p <pid,…> -Fpn` 한 번으로 구해, 라이브 스페이스 폴더 아래에 있으면 그 스페이스의 `Detached` 행에 붙인다. 이걸 하지 않을 거면 계획에서 "빠짐없이"를 빼야 한다. `/`가 들어간 원격 터미널(`homelab/…`)은 로컬 `lsof` 대상이 아니니 명시적으로 제외한다.

**3-4. 계획의 예시 JSON은 불가능한 상태다.** `t6m`과 `t88`이 같은 포트 4437을 가질 수 없다. 실제로는 `t6m` 하나가 `next-server` 7개(4431~4437)를 소유한다. 소유자당 3개까지 보이고 `+N`으로 접으며 포트 순으로 정렬한다. 접힌 카운트(`subs.length`)에 서버를 세지 않는다.

**3-5. 4초 폴링은 과하다.** 한 번에 약 0.3초(node 기동 + lsof + ps + connect)가 들고, mod 타이머는 블록이 숨겨져도 돈다. `cx.notify()`는 창 전체를 다시 그린다.
- 기본 주기는 10~15초로 하고, 에이전트 상태가 바뀌면(이미 `render`가 불린다) 최소 2초 간격으로 즉시 갱신한다.
- **stdout 문자열이 직전과 같으면 `cx.notify()`를 부르지 않는다.**
- 사이드바가 레일(`narrow()`)이거나 `window().active === false`면 건너뛴다.
- `exec`에 `timeout: 5000`을 준다. 기본 30초 동안 걸려 있으면 in-flight 가드가 갱신을 막는다. `exec`가 reject하면(`hc-team` 미설치) 60초로 백오프하고 서버 행 없이 그린다.
- 타이머는 `init`의 `if (props()?.sortMenu) return;` **뒤**, `if (checking()) return;` 뒤에서 시작한다. 정렬 팝업도 같은 mod의 복사본이라 앞에 두면 팝업마다 폴러가 생긴다. 스냅샷과 in-flight Promise는 `hj-tabs`의 `asked`처럼 모듈 스코프에 둬서 복사본끼리 공유한다.

**3-6. 행 렌더링.** `tree()`의 결과와 서버를 `{kind, lines}` 평면 목록으로 만드는 순수 함수를 `model.js`에 둔다. 이 파일은 `"herdr"`를 import하지 않아야 `node --test`가 된다. id는 `srv-${addr}-${port}`로 한다. `pane.focus {terminal}`은 pane이 없는 터미널(`hj.sub` 라벨이 남은 parked 서브 에이전트)에서 아무 일도 하지 않으므로, `panes()`에 없으면 `terminal.peek`으로 대체한다. Runs 뷰의 역할 행도 같다. `exec("open", …)`은 macOS 전용이니 `window().platform`으로 분기한다. Shell Servers 그룹의 스페이스는 터미널 라벨 `herdr.space`로 알 수 있다.

## 4. 요구사항 대비 누락 (P2)

| 요구사항 | 누락 |
| --- | --- |
| 비동기/병렬 오케스트레이션 | 패널에서 띄웠을 때 누가 PO인지(§1-7), 역할 재시작·추가(§1-8), `stop`의 확인 절차. 미랜딩 작업이 있는 세션을 죽이므로 패널의 `Stop`은 확인 다이얼로그를 거치고, 대상은 `run.json` 주소가 아니라 라벨 필터로 고른다. 기본 실행 시 부모가 끝나면 자식도 끝난다는 점도 적는다 |
| 토큰 효율 | §2-2~2-4. `hc-po`의 "두세 개로 시작" 원칙에 맞게 기본 체크 역할은 2~3개로 한다 |
| `hc-po`와의 관계 | 트리거가 겹친다("세션 띄워서 맡겨"). `hc-team` 스킬은 프리셋 작성과 launch 명령만 다루고 PO 행동(판정, 랜딩, 종료)은 `hc-po`를 가리킨다. `hc-po`에는 "프리셋으로 레인을 띄울 수 있다" 한 줄만 추가한다. 두 스킬이 PO 규칙을 각자 서술하면 권위가 둘이 된다 |
| 자연어 → 스키마 | 검증 오류를 JSON 경로 + 메시지로 낸다. 기존 `id`에 저장할 때는 `--update`를 요구해 사용자의 프리셋을 조용히 덮어쓰지 않게 한다. `hc-team schema`로 JSON Schema 하나를 출력하고 검증기와 `references/schema.md`가 그것에서 나오게 하면, Lane 4의 "100% 일치"가 수동 확인이 아니라 테스트가 된다(SKILL 예제가 검증을 통과하는지). 4단계의 "패널 표시 확인"은 에이전트가 볼 수 없으니 `hc-team preset list`로 바꾼다. 기존 프리셋 수정 흐름(읽기 → 패치 → 저장)이 빠져 있다 |
| docs 오버레이 + web-qa | 일반 스캐폴드만 있고 web-qa 전용 내용이 없다. `init-project`가 `roles/web-qa.md`에 다음 섹션을 만든다: 환경별 base URL과 서버 기동 방법, 로그인·테스트 계정 위치(비밀은 포인터만), 핵심 사용자 여정, `ego-rec` 녹화 목록과 각 녹화가 덮는 범위, `input-replay`로 볼 제스처 대상(캐러셀, 가로 스크롤러, 스냅), 뷰포트·디바이스, 알려진 불안정 영역. web-qa는 dev의 메시지를 기다리지 말고 `hc-team servers --run`으로 URL을 직접 얻는다. ego 브라우저는 하나라서 web-qa 역할이나 런이 둘이면 탭과 CDP가 충돌한다. 런당 web-qa는 하나로 제한하거나 사전 점검을 둔다 |
| 스킬 이름 | `skills: ["ego-recorder"]`는 하네스마다 이름이 다르다(Claude는 `hj-agent-tools:ego-recorder`). 브리프 문장으로만 쓰고 존재 검증은 하지 않는다 |
| 우측 패널 | §1-4, 1-5, 2-9 |

## 5. 착수 전 실측 (각 2분)

1. `hc run --bg --json <agent> "<task>"`(템플릿 아님)의 결과에 `first_message`가 있는지, `hc wait --children any`가 부팅 중 idle을 완료로 보는지. 결과에 따라 §2-5가 갈린다.
2. 계획대로 설정한 `codex --no-daemon` 리뷰어(읽기 전용) 안에서 `hc send`와 `hc label`이 되는지. 샌드박스가 유닉스 소켓이나 파일 쓰기를 막으면 리뷰어는 보고할 수 없다. 라벨 방식(§2-1)은 `hc send`와 같은 소켓만 쓰므로 `hc send`가 되면 같이 된다.
3. 태스크 `Input`에 타이핑하는 동안 `focused().terminal`이 무엇을 가리키는지(§1-7).

## 6. Herdr mod 엣지 케이스 체크리스트

- `watchFolder`에는 `home() + "/.config/herdr-core/presets"` 같은 절대경로를 넘긴다(`~` 불가). 폴더가 없으면 reject되므로 `for(;;){ await watchFolder }` 루프는 catch 없이 돌리면 뜨거운 루프가 된다. 실패하면 30초 타이머로 내려간다. 유휴 감시는 회수될 수 있으니 감시를 시작할 때마다 다시 읽는다. 원자적 쓰기의 임시 파일은 `.tmp-*`로 만들고 목록에서는 `*.json`만 본다. 감시가 있으면 10초 폴링은 필요 없다.
- 프리셋 목록은 exec 없이 `fs/promises`의 `readdir`과 `readTextFile`로 읽는다. 쓰기는 CLI만 한다(검증의 주인이 하나).
- `openOverlay({mod: "hj-team", kind: "dialog"})`는 **별도 복사본**이다. 패널 인스턴스의 상태에 접근할 수 없고 `localStorage`도 따로다. 입력은 `props`로 넘기고 결과는 파일 변경(감시)과 `setShared("hj-team.select", id)`로 돌려받는다. 다이얼로그 복사본의 `init`에서는 감시와 타이머를 시작하지 않는다.
- `InputState.new`, `TextareaState.new`, `EditorState.new`는 `init`에서만 만들 수 있다. 렌더 중 동적 개수의 입력은 만들 수 없다. Esc와 바깥 클릭이 편집 내용을 버리므로 `modal: true`를 쓰고, 다이얼로그 위에 다이얼로그를 띄우지 않는다.
- `hj-team/mod.json`은 `"place": "none"`으로 한다. 아니면 앱이 처음 볼 때 레이아웃에 복사본을 자동으로 붙인다.
- `layouts/main-skillshare.json`은 저장소 밖 사용자 상태라 `just install`로 재현되지 않는다. `hj-tabs` 헤더 주석처럼 넣을 JSON 조각을 mod 주석과 README에 적는다.
- `just herdr-mods`는 `external/herdr-mods/*/`를 통째로 복사하고, 앱은 파일이 저장될 때마다 모든 복사본을 다시 로드한다. `*.test.mjs`는 mod 폴더 밖(`tests/herdr-mods/`)에 둔다. `external/herdr-mods/` 아래에 테스트 폴더를 만들면 mod로 복사된다.
- 숨겨진 스택 자식(`teams`)의 타이머도 계속 돈다. §2-1대로 하면 `hj-team`에는 타이머가 필요 없다.
- `hj-tabs`의 `placements`는 부모가 있는 라이브 터미널을 모두 서브탭에 둘씩 배치한다. 서버 세션(프로그램 자식)도 pane을 얻는다. 4역할 + 서버를 동시에 띄우면 `hc label` 작업이 한꺼번에 나가니 E2E에서 배치 결과를 `herdr-app shot`으로 확인한다. `hc-team`은 `herdr.*` 라벨을 직접 걸지 않는다(배치의 주인은 `hj-tabs`).
- 모든 `exec`와 `hc` 호출은 `checking()` 가드 뒤에 둔다. check 중에도 실제로 실행되고 경고를 낸다.

## 7. 레인 구성 조정

- **계약을 먼저 고정한다.** Lane 2와 3은 Lane 1의 JSON(`servers --json`, `preset list --json`, `status --json`)을 소비한다. PO가 `skills/hc-team/references/contracts.md`와 픽스처 파일(이 머신의 `ps`, `lsof`, `terminal.list` 캡처)을 먼저 쓰고 나서 병렬로 띄운다. 귀속 로직은 `attribute(terminals, psRows, lsofRows)` 순수 함수로 만들어 픽스처로 테스트한다.
- **순서.** 서버 노출(§3)은 프리셋과 무관하고 단독 가치가 가장 크다. 먼저 출하한다. 그다음 CLI의 launch/send/status, 패널, 스킬 순이다.
- §2-1을 채택하면 Lane 3이 크게 줄어든다(Runs 뷰에 exec와 감시가 없고, CRUD는 에디터 다이얼로그 하나).
