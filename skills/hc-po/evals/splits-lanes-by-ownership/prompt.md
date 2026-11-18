---
tags: [hc-po]
max_turns: 30
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

주문 목록에 "환불됨" 상태를 추가하고 싶어. API는 상태별 필터를 받고, 웹 화면은 상태 배지를 보여줘야 해. 하위 세션으로 나눠서 PO로 진행해줘. 이 환경에서는 실제로 세션을 띄울 수 없으니, 계획 파일을 쓰고 네가 실행할 hc 명령을 순서대로 commands.md에 적어줘.

Input files: package.json, shared-types.ts, api/src/orders.ts, api/src/orders.test.ts, web/src/OrdersPage.tsx
