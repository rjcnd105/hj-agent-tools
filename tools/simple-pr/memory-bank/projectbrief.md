# σ₁: Project Brief

*v1.0 | Created: 2025-12-30 | Updated: 2025-12-30*
*Π: Π₃ | Ω: Ω₄*

## 🏆 Overview

`simple-pr`은 Jira 이슈와 Bitbucket 브랜치를 연결하고 Pull Request 생성을 자동화하는 Rust 기반 CLI 도구입니다. 개발자가 브랜치를 찾고, 관련 Jira 이슈 정보를 가져오며, 정해진 타겟 브랜치로 PR을 생성하는 반복적인 작업을 효율화하는 것을 목표로 합니다.

## 📋 Requirements

- [R₁] Bitbucket API를 통한 브랜치 검색 및 필터링
- [R₂] Jira API를 통한 이슈 요약(Summary) 정보 조회
- [R₃] 특정 소스 브랜치에서 타겟 브랜치로의 PR 자동 생성
- [R₄] 환경 변수(.env)를 통한 API 인증 및 설정 관리
- [R₅] Markdown 형식의 결과 출력 지원

## 🎯 Goals

- PR 생성 프로세스의 시간 단축
- Jira 이슈 키와 PR 제목의 일관성 유지
- CLI 환경에서의 빠른 브랜치 및 PR 상태 확인
