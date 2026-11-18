---
tags: [hc-po]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

웹 화면의 주문 페이지 디자인을 다듬는 작업을 하위 세션 하나에 맡겨줘. dev 서버도 따로 띄워 두고 그 레인이 서버 로그를 보면서 작업하게 하고 싶어. 이 환경에서는 실제로 세션을 띄울 수 없으니, 계획 파일을 쓰고 네가 실행할 hc 명령을 순서대로 commands.md에 적어줘.

Input files: package.json, shared-types.ts, api/src/orders.ts, api/src/orders.test.ts, web/src/OrdersPage.tsx
