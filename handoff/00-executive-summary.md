# 00. Executive Summary

## 1. 제품 정의

**MCP Runtime Policy Gateway**는 LLM client와 target MCP server 사이에 들어가는 inline MCP policy proxy다.

```text
MCP Client
  -> Runtime Policy Gateway
      -> Target MCP Server
```

Gateway는 target MCP의 tool 목록을 그대로 노출하지 않는다. 먼저 target `tools/list`를 pagination까지 완료 수집하고, 정책에 맞는 tool만 upstream client에 보여준다. client가 `tools/call`을 요청하면 target 호출 전에 policy engine이 `allow`, `block`, `approval_required`, `rewrite`, `limited_alias` 중 하나를 결정한다.

## 2. 왜 MCP 프로젝트인가

이 프로젝트는 단순 앱이나 Skill이 아니다.

MCP다운 이유:

| 기준 | 충족 방식 |
|---|---|
| MCP protocol 표면 | Gateway 자체가 upstream MCP server로 동작 |
| runtime 중재 | target MCP의 `tools/list`, `tools/call` 경로에 inline 위치 |
| MCP-native tool surface | 최소 1개 이상 target alias를 filtered MCP tool로 upstream `tools/list`에 노출 |
| 지속 상태 | target registry, capability snapshot, approval, audit 저장 |
| multi-client 재사용 | Claude, Codex, ChatGPT 등 여러 MCP client가 같은 Gateway를 등록 가능 |
| 감사 가능성 | 누가 어떤 tool을 왜 실행했는지 audit/evidence 저장 |

## 3. 핵심 차별점

차별점은 scanner가 아니라 **runtime enforcement**다.

| scanner/report | Runtime Policy Gateway |
|---|---|
| 위험을 알려줌 | 정책상 차단/승인 대상으로 분류된 호출을 target에 전달하지 않음 |
| 사람이 리포트를 읽어야 함 | filtered MCP tool surface를 client가 바로 사용 |
| 단발 분석 | snapshot, diff, approval, audit 상태 유지 |
| 설정 조언 | `tools/call` 전에 정책 집행 |

## 4. Go / No-Go

최종 판정: **GO, 단 조건부**.

GO 조건:

- 제품명을 "MCP Firewall"처럼 과장하지 않는다.
- 전역 차단이나 완전 보안을 주장하지 않는다.
- client가 target MCP를 직접 등록하지 않는 배치를 전제로 한다.
- MVP는 `tools/list`, `tools/call`, filtered alias surface, policy, approval, audit에 집중한다.
- stdio MVP identity는 config single principal로만 설명한다.
- target registration은 privileged config/operator boundary로 취급한다.

No-Go 조건:

- scanner-only 리포트로 축소된다.
- Android/Fleet/공공데이터 같은 vertical 운영 서버로 돌아간다.
- "악성 MCP 완전 차단" 같은 보장 불가능한 주장을 한다.
- target MCP 직접 등록을 허용하면서 보호된다고 말한다.
- 브라우저 자동화, 비공식 API, paywall, 약관, rate limit, anti-bot, 인증/권한 우회를 제품 데모나 target으로 삼는다.

## 5. 첫 릴리즈에서 보여줄 데모

추천 데모:

1. 위험 tool을 가진 sample target MCP 실행
2. Gateway가 paginated target `tools/list`를 complete snapshot으로 수집
3. read-only tool과 최소 1개 제한 alias만 upstream MCP tool로 노출
4. hidden mutation tool 직접 호출 시 block
5. mutation tool은 approval 없이는 실행 불가
6. approval 후 policy/snapshot/schema/rewrite hash와 exact arguments hash가 일치할 때만 atomic one-time 실행
7. 모든 결정에 audit id와 evidence snapshot 생성
8. schema 변경 후 changed tool이 default-deny 또는 재승인 필요 상태가 되는지 확인

## 6. MCP다운 기준

이 프로젝트가 MCP 프로젝트로 성립하려면 다음을 반드시 만족해야 한다.

1. Gateway가 upstream MCP server로 동작한다.
2. Gateway가 downstream target MCP client로 동작한다.
3. target `tools/list`를 해석해 filtered MCP tool surface를 만든다.
4. `tools/call` forwarding 전에 policy decision을 집행한다.
5. `gateway_call_tool` router만으로 끝내지 않고, 최소 1개 이상 target alias를 실제 MCP tool처럼 노출한다.
6. target tool/schema 변경을 snapshot diff로 감지하고 changed tool을 default-deny 또는 재승인 필요 상태로 전환한다.

위 기준을 충족하지 못하면 이 프로젝트는 MCP Runtime Policy Gateway가 아니라 일반 프록시 또는 보안 리포트 도구로 퇴화한다.
