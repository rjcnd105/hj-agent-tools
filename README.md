# simple-pr (Jira & Bitbucket PR Automator)

PR을 지라 이슈 기반으로 간단하게 생성하거나, find로 보고용 형식으로 출력하는 cli.

## 🚀 주요 기능

- **브랜치 검색 및 필터링**: 키워드를 통해 Bitbucket 브랜치를 빠르게 검색합니다.
- **Jira 연동**: 브랜치 이름에서 Jira 키를 추출하여 해당 이슈의 요약(Summary) 정보를 자동으로 가져옵니다.
- **PR 자동 생성**: 소스 브랜치에서 타겟 브랜치로, Jira 이슈 정보가 포함된 제목의 PR을 즉시 생성합니다.
- **Markdown 출력**: 결과물을 Markdown 형식으로 제공하여 문서화에 용이합니다.

## 🛠️ 설치 및 설정

[각각 아래에 해당하는 토큰 생성 필요](https://id.atlassian.com/manage-profile/security/api-tokens)

- **Jira token(general token)**
- **Bitbucket token(scoped token)**
  - read:pullrequest:bitbucket
  - read:repository:bitbucket
  - write:pullrequest:bitbucket

### 요구 사항

- **Rust**: edition 2024 이상
- **mise** (권장): 도구 버전 관리, task

### 환경 변수 설정

.env.template를 기입하고 파일 명을 .env로 변경합니다.

설정은 아래 순서로 읽으며, 앞쪽 값이 우선합니다.

1. 셸 환경변수 (예: `BITBUCKET_REPO_SLUG=other-repo simple-pr ...`)
2. 현재 경로 또는 상위 경로의 `.env`
3. `~/.config/simple-pr/.env` (`$XDG_CONFIG_HOME`이 있으면 그 아래)

### 설치 (어디서든 `simple-pr`로 실행)

```bash
mise run install
```

release 빌드 후 `~/.local/bin/simple-pr`를 빌드 결과물로 링크합니다. 이후에는 `cargo build --release`만 실행해도 반영됩니다.
`~/.config/simple-pr/.env`가 없으면 이 프로젝트의 `.env`를 그 위치로 링크합니다.

에이전트 스킬까지 함께 설치하려면 [hj-agent-tools](https://github.com/rjcnd105/hj-agent-tools)의 `just install`을 사용합니다. 이 경우 `~/.local/bin/simple-pr`는 링크가 아니라 빌드 결과물의 복사본입니다.

## 📖 사용 방법

### 1. 브랜치 및 Jira 이슈 찾기 (`find`)

소스 브랜치 이름에 키워드가 포함된 PR(열림·병합·거절 포함)을 검색하고 연결된 Jira 정보를 확인합니다.
기본은 키워드당 최신 PR 1개이며, `--all`을 주면 일치하는 PR을 모두 출력합니다. `--to`로 대상 브랜치를 필터링할 수 있습니다.
`PROJ-12`로 검색해도 `PROJ-123` 브랜치는 일치하지 않습니다.

PR에 연결되는 Jira 이슈는 소스 브랜치 이름의 키(예: `feature/PROJ-123-login` → `PROJ-123`)입니다.
브랜치 이름에 키가 없으면(예: `feature/shared-dev`) PR 커밋 메시지에 언급된 키 중 Jira에 실제로 있는 이슈를 모두 연결하고, 이슈마다 한 줄씩 출력합니다.
검색은 브랜치 이름 기준이므로, 이런 PR은 `--from shared-dev`처럼 브랜치 이름으로 찾습니다.

```bash
simple-pr bitbucket find --from PROJ-123 PROJ-124
```

**출력 예시:**

```text
🔍 Searching PRs for from-branch 'PROJ-123, PROJ-124' (to-branch filter: None, mode: latest 1 per keyword)...
[PROJ-123](https://your-domain.atlassian.net/browse/PROJ-123) 사용자 로그인 시 세션 만료 오류 수정 [PR](https://bitbucket.org/your_workspace/your_repo/pull-requests/101) 🟣 MERGED → main
[PROJ-124](https://your-domain.atlassian.net/browse/PROJ-124) 사용자 인증 노티 처리 [PR](https://bitbucket.org/your_workspace/your_repo/pull-requests/102) 🟢 OPEN → dev
```

### 2. PR 생성 (`create`)

소스 브랜치에서 타겟 브랜치(예: `dev`)로 PR을 생성합니다.

```bash
# PR을 만들지 않고 찾은 브랜치와 제목만 확인
simple-pr bitbucket create --from PROJ-123 --to dev --dry-run

# 단일 PR 생성
simple-pr bitbucket create --from PROJ-123 --to dev

# 제목을 직접 지정 (--from 키워드 1개일 때만)
simple-pr bitbucket create --from feature/login --to dev --title "로그인 리다이렉트 수정"

# 여러 브랜치 한 번에 처리 (동시에 생성)
simple-pr bitbucket create --from PROJ-123 PROJ-124 --to dev
```

**출력 예시:**

```text
🔍 Finding target branch for 'dev'...
🎯 Target Branch: dev

Processing PROJ-123 ...
✅ Created: [feature/PROJ-123-login-fix] -> [dev]

🚀 PR Summary:
[PROJ-123](https://your-domain.atlassian.net/browse/PROJ-123) 사용자 로그인 시 세션 만료 오류 수정 [PR](https://bitbucket.org/your_workspace/your_repo/pull-requests/102) 🟢 OPEN → dev
```

PR 제목은 `--title`이 있으면 그 값을 쓰고, 없으면 `[Jira 키] Jira 요약`이며, Jira 키는 찾은 소스 브랜치 이름에서 추출합니다. Jira 조회에 실패하면 경고를 출력하고 `[키] Task 키`로 생성합니다.
브랜치 이름에 Jira 키가 없으면, 대상 브랜치에 없는 커밋이 하나일 때 그 커밋의 제목을 쓰고, 그 외에는 `[키워드] Update from 키워드`로 생성합니다.
여러 키 중 하나라도 실패하면 나머지를 모두 처리한 뒤 exit code 1로 종료합니다.

매칭 규칙, 출력 형식, 설정, exit code 전체는 `simple-pr --help`, `simple-pr bitbucket find --help`, `simple-pr bitbucket create --help`에서 확인할 수 있습니다.

*참고: `--to` 인자에 브랜치명의 일부(예: `dev`)만 입력해도 가장 유사한 브랜치를 자동으로 찾아 타겟으로 지정합니다.*

## 🏗️ 개발 정보

이 프로젝트는 **CursorRIPER♦Σ Lite** 프레임워크를 사용하여 관리됩니다. 상세한 설계 결정 사항 및 기술 스택 정보는 `memory-bank/` 디렉토리를 참조하세요.

- `memory-bank/projectbrief.md`: 프로젝트 개요 및 요구사항
- `memory-bank/systemPatterns.md`: 시스템 아키텍처 및 디자인 결정
- `memory-bank/techContext.md`: 기술 스택 및 환경 설정
