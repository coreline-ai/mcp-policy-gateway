# MCP Policy Gateway Handoff Pack

작성일: 2026-06-30 KST  
목적: PlayMCP hosted preflight와 runtime Gateway 제품 목적, 범위, 아키텍처, 구현 계획, 테스트 기준, 보안 경계를 한 곳에 고정한다.

## 1. Handoff 결론

새 프로젝트명 후보:

```text
mcp-policy-gateway
```

한 줄 목적:

> MCP Policy Gateway는 PlayMCP/Kakao public hosted mode에서는 target MCP 연결 전 정적 사전검증과 handoff를 제공하고, managed runtime mode에서는 target MCP의 tool 노출과 호출을 정책으로 통제한다.

이 프로젝트는 Android 제어, 공공데이터 조회, 생활정보 앱, scanner-only 보안 리포트 프로젝트가 아니다.

## 2. 문서 읽는 순서

| 순서 | 문서 | 목적 |
|---:|---|---|
| 1 | [00-executive-summary.md](00-executive-summary.md) | 의사결정자용 한 장 요약 |
| 2 | [12-decisions-and-open-questions.md](12-decisions-and-open-questions.md) | bootstrap 전에 적용할 고정 결정과 기본값 |
| 3 | [01-product-requirements.md](01-product-requirements.md) | 제품 목적, 사용자, 범위, 비범위 |
| 4 | [07-security-boundaries-and-threats.md](07-security-boundaries-and-threats.md) | 보안 주장 한계, threat model |
| 5 | [02-architecture.md](02-architecture.md) | 전체 구성, 책임 분리, runtime call path |
| 6 | [04-policy-and-permission-model.md](04-policy-and-permission-model.md) | 정책 DSL, approval, limited alias |
| 7 | [05-data-model-and-audit.md](05-data-model-and-audit.md) | DB 모델, audit/evidence 저장 기준 |
| 8 | [06-api-and-tool-surface.md](06-api-and-tool-surface.md) | Gateway MCP tools와 내부 API |
| 9 | [03-mvp-scope-and-roadmap.md](03-mvp-scope-and-roadmap.md) | MVP 단계와 완료 기준 |
| 10 | [08-testing-and-acceptance.md](08-testing-and-acceptance.md) | 테스트 전략과 acceptance criteria |
| 11 | [09-new-repo-bootstrap.md](09-new-repo-bootstrap.md) | 새 레포 생성 체크리스트 |
| 12 | [10-legacy-migration-notes.md](10-legacy-migration-notes.md) | 기존 레포에서 가져갈 것과 버릴 것 |
| 13 | [11-agents-template.md](11-agents-template.md) | 새 레포 `AGENTS.md` 템플릿 |

PlayMCP public registration 세부사항은 [../docs/playmcp-public-hosted-preflight.md](../docs/playmcp-public-hosted-preflight.md)를 함께 읽는다.

## 3. 정본 출처

이 handoff pack은 새 프로젝트에서 독립적으로 읽히도록 구성한다. 정본 목적은 [../PROJECT_DIRECTION.md](../PROJECT_DIRECTION.md)이며, 외부 feasibility report나 legacy repo 문서는 선택적 reference snapshot일 뿐 필수 입력이 아니다.

충돌 시 우선순위:

1. [../PROJECT_DIRECTION.md](../PROJECT_DIRECTION.md)
2. 이 handoff pack
3. 새 레포에 복사된 optional reference snapshot
4. 기존 CoreAudioFX/Android/Fleet 문서

handoff pack은 새 프로젝트 이관용 실행 문서다. 제품 목적, 보안 주장, 범위 경계가 [../PROJECT_DIRECTION.md](../PROJECT_DIRECTION.md)와 충돌하면 `PROJECT_DIRECTION.md`가 반드시 우선한다.

## 4. 새 프로젝트 첫 구현 목표

MVP는 두 흐름을 분리해서 다룬다.

Hosted preflight:

```text
PlayMCP / Toolbox / External AI Client
  -> public-preflight /mcp
      -> search/preflight/explain
      -> PlayMCP inventory assessment
```

Runtime Gateway:

```text
Claude / Codex / ChatGPT MCP Client
  -> MCP Runtime Policy Gateway
      -> Policy Engine
      -> Capability Catalog
      -> Approval Store
      -> Audit/Evidence Store
      -> Target Adapter
          -> Target MCP Server
```

MVP 성공 조건:

1. PlayMCP inventory 기반 preflight가 MCP별 decision/risk/handoff를 반환한다.
2. public-preflight 계획은 search/preflight/explain만 공개하고 runtime/operator tools를 숨긴다.
3. target MCP를 등록할 수 있다.
4. target `tools/list`를 수집하고 hash snapshot을 저장한다.
5. 정책상 허용된 tool만 upstream에 노출한다.
6. 숨겨진 tool을 직접 `tools/call`해도 target으로 전달하지 않는다.
7. mutation/destructive tool은 approval 없이는 실행하지 않는다.
8. 모든 allow/block/approval/call/error는 audit id를 남긴다.
9. 공개 demo에는 최소 1개 이상의 target tool alias가 실제 filtered MCP tool로 upstream `tools/list`에 노출된다.
10. `tools/list` pagination, `nextCursor`, `notifications/tools/list_changed`를 고려해 complete snapshot과 diff를 만든다.
11. 브라우저/API/paywall/약관/rate-limit/anti-bot/인증 우회 목적의 target은 등록하지 않는다.
12. stdio MVP identity는 config single principal로만 설명한다.
13. target registration은 privileged config/operator boundary로 취급한다.
14. incomplete snapshot과 unsupported reverse capability는 fail-closed한다.

## 5. 새 레포에 복사할 최소 문서

새 레포에는 아래 파일을 우선 복사한다.

```text
PROJECT_DIRECTION.md
docs/handoff/
  README.md
  00-executive-summary.md
  01-product-requirements.md
  02-architecture.md
  03-mvp-scope-and-roadmap.md
  04-policy-and-permission-model.md
  05-data-model-and-audit.md
  06-api-and-tool-surface.md
  07-security-boundaries-and-threats.md
  08-testing-and-acceptance.md
  09-new-repo-bootstrap.md
  10-legacy-migration-notes.md
  11-agents-template.md
  12-decisions-and-open-questions.md
```

그 후 [11-agents-template.md](11-agents-template.md)를 새 레포 루트의 `AGENTS.md`로 승격한다.
