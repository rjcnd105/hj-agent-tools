# hc-team 코드 리뷰

**P0 0건 · P1 11건 · P2 24건.** 가장 먼저 고칠 문제는 `Stop`이 다른 실행의 터미널까지 종료할 수 있다는 점과, Teams 패널이 사용자가 보고 있는 저장소와 다른 곳에서 작업을 시작할 수 있다는 점입니다.

`docs/plans/codex-review.md`를 쓰기 모드로 열 때 `EPERM`이 발생했습니다. `t114`에도 완료 알림과 대체 보고서 위치를 전송했지만 `hc send`가 `cannot open core lock: Operation not permitted`로 종료됐습니다. 아래가 전체 보고서입니다.

## P1

1. **같은 ID의 로컬·원격 실행을 한 번에 종료한다.** `external/herdr-mods/hj-team/model.js:15`, `skills/hc-team/scripts/hc-team.mjs:384`, `skills/hc-team/scripts/hc-team.mjs:644`. `terminal.list`는 연결된 머신의 터미널도 반환한다. 로컬 `t1`과 원격 `remote/t1`에 같은 6자리 run ID를 넣자 패널은 두 역할을 한 그룹으로 묶었다. `stop`은 같은 필터로 찾은 두 주소 모두에 `kill`과 `rm`을 보낸다. 현재 CLI가 로컬 스냅샷을 소유하므로 실행 조회와 패널 그룹 양쪽에서 원격 주소를 제외하는 것이 가장 작은 수정이다.

2. **부모 실행을 멈추면 확인창에 없는 다른 실행도 종료된다.** `skills/hc-team/scripts/hc-team.mjs:402`, `skills/hc-team/scripts/hc-team.mjs:646`, `external/herdr-mods/hj-team/main.js:268`. B를 A의 역할 터미널 아래에 실행한 뒤 A를 중지하면, `hc`의 기본 부모 종료 동작으로 B도 끝난다. 확인창은 A의 역할과 서버만 안내한다. `stop`이 첫 `kill` 전에 전체 부모 트리를 조회해 함께 종료될 다른 실행의 주소를 찾고, 발견하면 해당 주소를 표시하며 중단해야 한다.

3. **Teams가 포커스된 저장소와 다른 저장소에서 코드를 수정하거나 문서를 만든다.** `external/herdr-mods/hj-team/main.js:114`, `external/herdr-mods/hj-team/main.js:221`, `external/herdr-mods/hj-team/main.js:241`. 한 space에서 첫 탭은 `/repo-a`, 활성 탭과 부모 에이전트는 `/repo-b`인 상태를 넣자 실제 메서드는 `/repo-a`를 골랐다. `Launch`와 `Init docs/` 모두 이 값을 쓴다. 활성 탭의 포커스된 pane에서 cwd를 구하고, 그다음 활성 탭의 터미널과 `space.folder` 순서로 대체한다. 프로젝트를 결정할 수 없으면 두 버튼을 비활성화한다.

4. **A를 편집하다 B의 전역 프리셋을 덮어쓸 수 있다.** `external/herdr-mods/hj-team/main.js:194`, `skills/hc-team/scripts/hc-team.mjs:777`. A 편집창에서 JSON의 `id`를 B로 바꾸자 패널은 B의 JSON에 `--update`를 붙였다. CLI는 본문 ID로 저장 경로를 정한다. 편집 시 원래 ID를 고정하고 달라지면 저장을 거부한다. 같은 ID를 다른 창이나 CLI에서 먼저 수정한 경우도 보호하려면, 편집을 열 때 읽은 원본과 저장 직전 파일을 비교해 충돌을 반환한다.

5. **같은 역할을 동시에 추가하면 승자가 패자의 작업 지시를 읽는다.** `skills/hc-team/scripts/hc-team.mjs:491`, `skills/hc-team/scripts/hc-team.mjs:509`, `skills/hc-team/scripts/hc-team.mjs:538`. 두 `launch --run`이 모두 역할이 비어 있다고 읽은 뒤 같은 `briefs/dev.md`를 쓴다. 동시 실행 모의 검사에서 A만 터미널을 얻었지만, A가 받은 `Task: task A`의 brief 본문은 `task B`였다. 역할별로 실행 권한을 먼저 확보하고 그 안에서 live 상태를 재조회한 뒤 brief 작성과 spawn을 수행한다.

6. **기존 run을 다른 저장소나 부모 아래에서 이어갈 수 있다.** `skills/hc-team/scripts/hc-team.mjs:488`, `skills/hc-team/scripts/hc-team.mjs:492`, `skills/hc-team/scripts/hc-team.mjs:516`. 마지막 역할이 종료되면 원래 프로젝트를 확인할 live 라벨이 사라진다. 이후 `--run`은 호출자의 cwd와 부모를 사용한다. live 역할이 있어도 새 역할의 기본 부모는 호출자이며, dry-run은 기존 터미널 조회 자체를 생략한다. 최초 생성 시 `projectRoot`와 부모 주소를 run에 저장하고, 재개와 dry-run 모두 같은 메타데이터를 사용한다.

7. **이미 입력된 brief를 자동으로 다시 제출한다.** `skills/hc-team/scripts/hc-team.mjs:413`, `skills/hc-team/scripts/hc-team.mjs:430`, `tests/hc-team.test.mjs:299`. `hc`의 `started:false`는 텍스트를 넣은 뒤 관찰 시간 안에 `working`을 보지 못했다는 뜻이다. 느린 에이전트가 같은 turn에서 잠시 `idle`이면 실제 재시도 함수는 두 번 제출한다. 테스트도 두 번을 기대한다. 입력 후 시작을 확인하지 못한 경우를 별도 결과로 반환하고, 미입력이 확인된 실패에만 재전송한다.

8. **역할의 결과 보고가 일반 셸에 입력된다.** `skills/hc-team/scripts/hc-team.mjs:488`, `skills/hc-team/scripts/hc-team.mjs:585`, `skills/hc-team/scripts/hc-team.mjs:412`. Herdr 셸에서 CLI로 실행하면 그 셸이 기본 부모가 된다. 역할이 `send parent`를 호출하면 `hc send`가 보고문을 부모 PTY에 붙여넣고 Enter를 누른다. 셸이 전경이면 보고문 안의 셸 문법을 해석할 수 있다. 부모 자동 선택과 전달 직전에 에이전트 상태를 확인하고, 일반 셸이면 이벤트만 기록한다.

9. **단일 실행 파일 경로가 `hc`에서 셸 명령으로 재해석된다.** `skills/hc-team/scripts/hc-team.mjs:394`, `skills/hc-team/scripts/hc-team.mjs:404`. 인자가 없는 역할의 실행 파일이 공백을 포함한 경로에 설치되면, `hc run`은 단일 문자열을 셸 명령으로 처리할 수 있다. 바깥 `execFile`과 `--`는 `hc` 내부의 변환을 막지 못한다. macOS에서 이 경우 `/usr/bin/env`와 실행 파일의 절대 경로를 두 개의 argv 원소로 전달하거나, `terminal.run`의 명시적 `argv`를 사용한다.

10. **`--update` 없는 저장도 외부에서 만든 파일을 덮어쓴다.** `skills/hc-team/scripts/hc-team.mjs:226`, `skills/hc-team/scripts/hc-team.mjs:233`, `skills/hc-team/scripts/hc-team.mjs:240`. 존재 검사와 `rename` 사이에 편집기나 동기화 도구가 대상 파일을 만들면 새 파일을 교체한다. `.save-lock`은 외부 작성자를 보호하지 않고, 프로세스가 강제 종료되면 후속 저장도 계속 막는다. 신규 저장과 seed는 같은 디렉터리에 완성한 임시 파일을 `link(temp, target)`으로 게시하고 `EEXIST`를 처리한다. 교체용 `rename`은 명시적 업데이트에만 사용한다.

11. **`init-project`가 프로젝트 바깥에 파일을 만든다.** `skills/hc-team/scripts/hc-team.mjs:330`, `skills/hc-team/scripts/hc-team.mjs:333`. `docs`, 프리셋 폴더 또는 `roles`가 다른 저장소를 가리키는 심링크이면 `mkdir`와 `writeFile`이 그쪽에 문서를 만든다. `wx`는 최종 파일의 덮어쓰기만 방지한다. 쓰기 전에 기존 상위 디렉터리들의 실제 경로가 실제 프로젝트 루트 안에 있는지 검사하고, 이탈하면 파일을 하나도 만들기 전에 종료한다.

## P2

> 🧠 **From Hindsight memory** — `hc run --name`은 모든 live 터미널에서 유일해야 한다. 설치된 `hc 0.1.21`의 `run --help`에서도 이 제약을 확인했다.

1. **같은 ID의 서버와 역할을 함께 실행할 수 없다.** `skills/hc-team/scripts/hc-team.mjs:113`, `skills/hc-team/scripts/hc-team.mjs:393`. `web` 서버와 `web` 역할이 있는 프리셋은 검증을 통과했지만 두 이름 모두 `abc123-web`이었다. 서버가 먼저 실행되면 역할이 실패한다. 서버만 `<runId>--<serverId>`로 명명하면 기존 역할 이름 및 길이 제한을 유지하면서 충돌을 없앨 수 있다.

2. **역할이 하나도 시작되지 않아도 Launch가 성공으로 끝난다.** `skills/hc-team/scripts/hc-team.mjs:548`, `skills/hc-team/scripts/hc-team.mjs:554`, `external/herdr-mods/hj-team/main.js:249`. 실행 파일이 모두 없으면 CLI가 역할별 `reason`을 담아 종료 코드 0을 반환하고 패널은 빈 Runs 탭으로 이동한다. 서버의 실패 원인은 반환 객체에서도 빠진다. 요청한 역할이 모두 실패하면 결과 JSON을 유지하며 실패 코드를 반환하고, 서버별 `reason`과 `ready`도 패널에 표시한다. 기존 부분 성공은 보존한다.

3. **부모에게 메시지가 오면 정상 부팅 중인 역할의 brief 전달을 포기한다.** `skills/hc-team/scripts/hc-team.mjs:540`, `tests/hc-team.test.mjs:85`. `hc wait`는 다른 역할의 보고가 도착해도 `reason: message`로 끝난다. 현재 코드는 이를 준비 실패로 처리해 이미 생성한 역할을 작업 없이 남긴다. 같은 45초 마감 안에서 `message`이면 다시 기다리고, 실제 종료·차단·시간 초과를 구분한다.

4. **`stop` 도중 `rm`에 실패하면 재시도로 정리되지 않는다.** `skills/hc-team/scripts/hc-team.mjs:384`, `skills/hc-team/scripts/hc-team.mjs:646`. `kill` 성공 후 `rm`이 실패한 주소는 다음 호출에서 이미 `finished`라 조회되지 않는다. 두 번째 `stop`은 `No live terminals`를 반환한다. 처음 중지하기로 한 주소를 기록하고, 재시도 시 그 주소가 `finished`이면 `rm`부터 재개한다.

5. **전달 실패한 메시지가 Runs의 마지막 handoff로 표시된다.** `skills/hc-team/scripts/hc-team.mjs:581`, `skills/hc-team/scripts/hc-team.mjs:585`, `tests/hc-team.test.mjs:351`. 받는 역할이 종료됐거나 전달이 거절돼도 발신자의 라벨과 이벤트는 이미 갱신됐다. 테스트는 종료 코드만 확인한다. 수신 주소와 전달 결과가 확인된 뒤 마지막 전달 라벨을 갱신하고, 실패 시도가 기록에 필요하면 그 결과를 명시한다. 부모가 없는 실행의 기록 동작은 유지한다.

6. **큰 `hc connect` 응답 하나로 상태 조회와 서버 검색이 함께 실패한다.** `skills/hc-team/scripts/hc-team.mjs:361`, `skills/hc-team/scripts/hc-team.mjs:365`, `skills/hc-team/scripts/hc-team.mjs:381`. 같은 `execFile` 설정에 8 MiB를 넘는 정상 JSON-RPC 응답을 주면 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`와 8,388,608바이트의 부분 stdout이 남았다. 현재 오류 처리기는 이 부분 응답까지 진단문에 넣을 수 있다. `connect`는 stdout에서 요청 ID에 해당하는 완결된 프레임을 읽어 반환하고, 크기 초과나 중간 EOF에는 응답 본문을 제외한 오류를 반환한다.

7. **IPv6 전용 서버가 HTTP로 잘못 표시된다.** `skills/hc-team/scripts/servers.mjs:31`, `skills/hc-team/scripts/servers.mjs:80`, `tests/hc-team.test.mjs:377`. `[::1]:8443`을 파싱하면 bind 주소가 사라지고 TLS는 `127.0.0.1`만 검사한다. IPv6에서 HTTPS가 정상이어도 실패 결과를 10분간 캐시한다. 리스너의 주소와 주소군을 보관하고 실제 bind 주소를 검사한다. wildcard 리스너만 해당 주소군의 loopback으로 바꾼다.

8. **HTTP를 제공하지 않는 TCP 포트도 브라우저 URL이 된다.** `skills/hc-team/scripts/servers.mjs:81`, `skills/hc-team/scripts/servers.mjs:191`, `skills/hc-team/scripts/hc-team.mjs:468`. DB나 디버거 포트에서 TLS 협상이 실패하면 `http://localhost:<port>`가 만들어지고, 웹 앱보다 이 포트가 먼저 열려도 서버에 `ready:true`가 붙는다. TCP 수신 여부와 브라우저 URL을 구분한다. 명시적 URL 라벨이 없는 포트는 제한 시간 안에 HTTP 응답을 확인한 경우에만 링크로 노출한다.

9. **스캐너가 찾은 detached 서버를 사이드바가 다시 버린다.** `skills/hc-team/scripts/servers.mjs:168`, `external/herdr-mods/hj-agents/model.js:52`, `external/herdr-mods/hj-agents/model.js:80`. space의 `folder`가 비어 있고 그 안의 터미널 cwd가 `/repo`이면 CLI는 `/repo`의 서버를 반환한다. 같은 입력을 패널 모델에 넣으면 표시 그룹은 0개다. `herdr.space`로 공간을 확인할 수 있는 live 터미널의 cwd도 해당 space의 매칭 후보로 사용한다.

10. **프로젝트 오버레이를 수정해도 패널 미리보기가 갱신되지 않는다.** `external/herdr-mods/hj-team/main.js:90`, `external/herdr-mods/hj-team/main.js:98`, `skills/hc-team/scripts/hc-team.mjs:286`. 같은 space에서 `docs/agent-presets/<id>/preset.json`의 역할이나 명령을 바꾸면 패널은 이전 값을 표시하고 Launch는 새 파일을 읽는다. 현재 프로젝트의 오버레이 디렉터리 변경도 목록 갱신에 연결하고, 프로젝트가 바뀌면 이전 감시를 취소한다.

11. **프리셋 하나가 깨지면 정상 프리셋까지 사용할 수 없다.** `skills/hc-team/scripts/hc-team.mjs:758`, `external/herdr-mods/hj-team/main.js:320`. JSON 문법 오류, 깨진 파일 심링크, 유효하지 않은 오버레이 중 하나만 있어도 `Promise.all`이 전체 목록을 실패시킨다. 첫 로드라면 패널에서 다른 프리셋을 열 수 없다. 파일별로 읽기 결과를 수집해 정상 항목을 반환하고, 실패한 ID와 진단을 별도로 표시한다.

12. **GUI의 PATH에 Node가 없으면 절대 경로 fallback도 실패한다.** `skills/hc-team/scripts/hc-team.mjs:1`, `external/herdr-mods/hj-team/main.js:23`, `justfile:57`, `README.md:16`. `PATH=/usr/bin:/bin`에서 설치된 `~/.local/bin/hc-team schema`를 실행하자 `env: node: No such file or directory`가 발생했다. CLI 심링크를 찾은 뒤에도 shebang이 Node를 다시 찾아야 한다. Darwin GUI 환경에 설치된 Node의 bin 디렉터리를 제공하고, 설치 요구사항에도 Node를 추가한다.

13. **`--`로 시작하는 작업 문구를 패널에서 전달할 수 없다.** `external/herdr-mods/hj-team/model.js:64`, `skills/hc-team/scripts/hc-team.mjs:683`, `skills/hc-team/scripts/hc-team.mjs:710`. 작업 문구 `--flag`는 `Missing value for --task`가 되고, `--help`는 실제 실행 없이 사용법과 종료 코드 0을 반환했다. 패널은 작업을 `--task=<text>` 한 인자로 보내고, CLI는 값 소비를 결정한 뒤 도움말 옵션을 판정한다.

14. **Codex 프롬프트의 문자열을 실제 `--no-daemon` 옵션으로 오인한다.** `skills/hc-team/scripts/hc-team.mjs:392`, `tests/hc-team.test.mjs:253`. `["codex","--","--no-daemon"]`을 넣자 실행 계획의 인자는 그대로 `["--","--no-daemon"]`이었다. 구분자 뒤의 문자열에는 옵션 효과가 없다. 첫 `--` 앞의 옵션 구간만 검사하고, 그 구간에 없으면 맨 앞에 추가한다.

15. **기존 사용자가 `just update`를 실행해도 새 CLI와 패널이 설치되지 않는다.** `justfile:11`, `justfile:22`, `justfile:61`. 설치 경로에만 `hc-team`과 `herdr-mods`가 추가됐다. 이전 버전에서 업데이트하면 CLI 링크와 seed가 없거나 Herdr가 이전 복사본을 계속 사용한다. `update`에도 `just hc-team`과 `just herdr-mods`를 추가한다.

16. **macOS의 다른 사용자에게도 주 사용자의 프리셋 경로를 지정한다.** `systems/aarch64-darwin/default.nix:33`, `systems/aarch64-darwin/default.nix:53`, `homes/workspace/home-config.nix:41` (`nix-dots`). `environment.variables`는 시스템 전역인데 값은 주 사용자의 절대 홈이다. 다른 계정의 로그인 셸은 권한 오류를 내거나, 권한이 충분하면 주 사용자의 프리셋을 변경한다. 시스템 전역 선언을 제거하고 Home Manager의 사용자 환경 및 해당 사용자의 LaunchAgent에만 값을 제공한다.

17. **중간 부모를 park하면 손자 탭이 원래 그룹에서 빠진다.** `external/herdr-mods/hj-tabs/main.js:56`, `external/herdr-mods/hj-tabs/main.js:99`. A의 자식 B를 park하고 B의 자식 C만 sub-tab에 남긴 입력에서 `families()`는 C의 최상위 탭을 찾지 못했다. 배치 함수처럼 부모 체인을 따라 pane이 있는 조상을 찾고, 같은 space에 속할 때 그 탭에 연결한다.

18. **`hc-po`가 일반 프로그램 실행에 없는 필드를 확인하라고 지시한다.** `skills/hc-po/SKILL.md:25`, `skills/hc-po/SKILL.md:39`. 설치된 `hc`의 `first_message`는 템플릿 실행용 결과다. 예시는 일반 실행 파일도 허용하고 `--json`도 생략한다. 템플릿 예시에는 `--json`과 `first_message.sent` 검사를 붙이고, 일반 에이전트 예시는 준비를 기다린 뒤 `hc send`의 결과를 확인하도록 나눈다.

19. **`hc-po`의 서버 준비 예시는 준비 출력을 놓칠 수 있다.** `skills/hc-po/SKILL.md:69`, `skills/hc-po/SKILL.md:73`. 첫 `hc read` 직후, `hc wait --output ready`가 등록되기 전에 서버가 한 번만 `ready`를 출력하면 정상 서버를 기본 타임아웃까지 기다린다. 짧은 `--timeout` 후 화면이나 실제 리스너를 다시 확인하고 전체 마감 안에서만 반복한다.

20. **이전 space의 Launch 결과가 현재 space의 탭과 알림을 바꾼다.** `external/herdr-mods/hj-team/main.js:234`, `external/herdr-mods/hj-team/main.js:253`. A에서 느린 실행을 시작한 뒤 B로 이동하면 A의 완료 콜백이 B의 공지를 덮고 Runs 탭으로 전환한다. `initDocs`가 하는 것처럼 시작 시점의 `context`를 보관하고, 여전히 같은 context일 때만 공지와 탭을 바꾼다.

21. **패널이 CLI보다 먼저 타임아웃돼 작업 결과를 잃는다.** `external/herdr-mods/hj-team/main.js:16`, `external/herdr-mods/hj-team/main.js:201`, `external/herdr-mods/hj-team/main.js:248`, `skills/hc-team/scripts/hc-team.mjs:360`. Stop은 8초 뒤 실패로 표시할 수 있지만 CLI는 아직 `kill` 또는 `rm`을 수행 중일 수 있다. Launch도 서버 준비, 역할 대기, 전송 재시도의 합이 180초를 넘는다. Stop과 Launch에 각각 내부 호출의 전체 마감보다 긴 제한을 주고, 타임아웃 뒤에는 기존 run 상태를 조회해 재실행 여부를 판단한다.

22. **로컬 인증서의 SAN이 외부 사이트를 여는 링크가 될 수 있다.** `skills/hc-team/scripts/servers.mjs:73`, `skills/hc-team/scripts/servers.mjs:197`, `external/herdr-mods/hj-agents/main.js:270`. 로컬 서버가 운영 도메인도 포함한 인증서를 쓰지만 로컬 DNS 매핑은 없으면, 검사한 소켓은 loopback인데 클릭은 운영 호스트로 간다. 자동 추출한 SAN이 로컬 인터페이스로 해석되는지 확인한 경우에만 사용한다. 사용자가 명시한 `hj.url`은 기존 계약대로 우선한다.

23. **park한 하위 세션은 Agents 목록에서 클릭해도 열리지 않는다.** `external/herdr-mods/hj-agents/main.js:315`, `external/herdr-mods/hj-agents/main.js:280`. 트리는 pane이 없는 live 자식도 표시하지만 하위 세션 행은 항상 `pane.focus`를 호출한다. 같은 파일의 서버 버튼처럼 `panes()`에 주소가 있으면 `pane.focus`, 없으면 `terminal.peek`를 호출한다.

24. **`checking()` 중에도 기존 핀 마이그레이션과 상태 저장을 호출한다.** `external/herdr-mods/hj-agents/main.js:149`, `external/herdr-mods/hj-agents/main.js:204`, `external/herdr-mods/hj-agents/main.js:342`. 초기화의 검사 가드보다 앞에 `localStorage.removeItem`이 있고, 검사 렌더도 `migratePins()`와 `track()`을 호출한다. 이전 핀이 있는 입력이면 `terminal.pin` 호출 경로에 들어간다. 원본 `agents`에도 있던 동작이다. 검사 중에는 저장소 변경과 핀 마이그레이션만 건너뛰도록 가드를 옮긴다.

## 검증 범위

요청한 24개 파일을 검토했다. 기본 프리셋 3개는 실제 CLI 검증을 통과했고, 설치된 CLI의 목록 조회와 dry-run도 실행했다. 두 Nix 파일은 구문 검사를 통과했고, 개인 레이아웃의 `panel-body`에서 `teams → hj-team` 연결을 확인했다.

Node 테스트는 **24개 중 15개 통과**했다. 8개는 임시 디렉터리 생성, 1개는 loopback 포트 바인딩이 `EPERM`으로 차단됐다. 패널의 잘못된 cwd 선택, 편집 대상 변경, 머신 간 run 병합, 동시 brief 덮어쓰기와 중복 제출은 소스 메서드에 모의 입력을 넣어 별도로 확인했다. Herdr 네이티브 검사는 launchd·GUI 접근 제한으로 완료되지 않아 실제 창 렌더링과 클릭 결과는 검증하지 못했다.