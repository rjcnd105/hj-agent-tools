# σ₃: Technical Context
*v1.0 | Created: 2025-12-30 | Updated: 2025-12-30*
*Π: Π₃ | Ω: Ω₄*

## 🛠️ Technology Stack
- **Language**: Rust (edition 2024)
- **Async Runtime**: `tokio` (v1.x, full features)
- **HTTP Client**: `reqwest` (v0.12, json, rustls-tls)
- **CLI**: `clap` (v4, derive)
- **Serialization**: `serde`, `serde_json`
- **Error Handling**: `anyhow`
- **Environment**: `dotenvy`
- **Regex**: `regex` (v1.12.2)

## ⚙️ Development Environment
- **Package Manager**: Cargo
- **Tool Manager**: `mise` (mise.toml 사용)
- **API Dependencies**:
  - Bitbucket Cloud REST API v2.0
  - Jira Cloud REST API v3

## 🔑 Authentication & Secrets
다음 환경 변수가 `.mise.toml` 또는 `.env` 파일에 정의되어야 합니다:
- `BB_WORKSPACE`: Bitbucket 워크스페이스 명
- `BB_REPO_SLUG`: Bitbucket 레포지토리 슬러그
- `BB_API_TOKEN`: Bitbucket API 토큰
- `JIRA_HOST`: Jira 호스트 URL
- `ATLASSIAN_EMAIL`: Atlassian 계정 이메일
- `JIRA_API_TOKEN`: Jira API 토큰
