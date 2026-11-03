# σ₂: System Patterns
*v1.0 | Created: 2025-12-30 | Updated: 2025-12-30*
*Π: Π₃ | Ω: Ω₄*

## 🏛️ Architecture Overview
현재 `simple-pr`은 단일 바이너리 Rust 애플리케이션으로 구성되어 있습니다.

### 핵심 구성 요소
- **CLI Layer (`clap`)**: 사용자 명령 및 인자 파싱
- **App Context (`AppContext`)**: HTTP 클라이언트(`reqwest`) 및 설정(API 토큰, 호스트 정보)을 관리하는 중앙 상태 객체
- **API Integration**: Bitbucket 및 Jira Cloud REST API와 통신
- **Data Models**: API 응답 및 요청을 처리하기 위한 `serde` 기반 구조체

## 🛠️ Design Decisions
- **Async Runtime**: 고성능 비동기 I/O를 위해 `tokio`를 사용
- **Error Handling**: 전파 및 컨텍스트 추가가 용이한 `anyhow` 사용
- **Authentication**:
    - Bitbucket: Basic Auth (Email + Token)
    - Jira: Basic Auth (Email + Token)
    - `bb_auth`, `jira_auth` 헬퍼 메서드를 통한 중복 제거
- **Regex**: 브랜치 이름에서 Jira 키(`PROJ-123`)를 추출하기 위해 `OnceLock`을 사용한 정규표현식 캐싱 적용
- **API Robustness**: `check_status` 공통 메서드를 통한 일관된 에러 처리 및 디버깅 메시지 제공

## 🔄 Data Flow
1. 사용자 입력 (CLI)
2. `.env` 로드 및 `AppContext` 초기화
3. Bitbucket API 호출 (브랜치 검색)
4. 브랜치명에서 Jira 키 추출 (Regex)
5. Jira API 호출 (이슈 요약 정보 획득)
6. (Create 모드 시) Bitbucket API 호출 (PR 생성)
7. 결과 출력 (Console/Markdown)
