# 04. Policy And Permission Model

## 1. Policy Principles

정책 모델의 원칙:

1. default deny
2. tool annotation은 신뢰하지 않음
3. list filtering과 call-time enforcement를 모두 수행
4. mutation/destructive tool은 approval 기본
5. approval은 exact arguments hash, policy version, observation id, schema hash, rewrite hash에 묶음
6. alias rewrite는 명시적으로만 허용
7. 모든 decision은 audit event를 생성
8. allowed output도 redaction/egress policy를 통과
9. 브라우저/API/paywall/약관/rate-limit/anti-bot/인증 우회 target은 unsupported

## 2. Decision Types

| Decision | 의미 | Target 호출 |
|---|---|---|
| `allow` | 바로 호출 가능 | Yes |
| `block` | 차단 | No |
| `approval_required` | 승인 필요 | No |
| `rewrite` | 인자 주입/축소 후 호출 | Yes |
| `limited_alias` | target이 제공하는 preview/dry-run 모드를 강제한 제한 alias | Yes, rewritten |

정본 enum은 위 다섯 개다. 문서와 코드에서 비정본 decision 이름을 내부 별칭으로 두지 않는다.

## 3. Policy YAML Draft

```yaml
version: 1
default: deny

targets:
  risky-actions:
    trust: local-reviewed
    collisionStrategy: target_slug_double_underscore_tool_slug

classifiers:
  readonlyName: "^(.*\\.)?(list|get|query|search|diagnostics|status).*"
  destructiveName: "(apply|bypass|rollback|delete|remove|send|launch|execute|run|write|revoke|rotate|reset|stop|kill)"

rules:
  - id: allow-readonly-reviewed
    match:
      target: risky-actions
      toolNameRegex: "^(actions\\.)?(list|get|query|search|diagnostics|status).*"
    effect: allow

  - id: preview-profile
    match:
      target: risky-actions
      tool: "actions.apply_profile"
    exposeAs:
      name: "risky_actions__preview_profile"
      injectArguments:
        dryRun: true
      hideArguments:
        - dryRun
    effect: limited_alias

  - id: approve-profile-mutation
    match:
      target: risky-actions
      toolNameRegex: "(apply|bypass|rollback)"
    effect: approval_required
    approval:
      scope:
        - clientId
        - userId
        - target
        - tool
        - argumentsHash
        - policyVersion
        - observationId
        - schemaHash
        - rewriteHash
      ttlSeconds: 600
      requireExactArguments: true
      consume: one-time-atomic
      audit: true

  - id: deny-unknown
    match:
      any: true
    effect: block
```

## 4. Matching Order

권장 평가 순서:

1. target exists
2. tool exists in latest approved snapshot
3. alias mapping exists
4. argument schema validation
5. explicit deny
6. approval_required rule
7. allow/rewrite/limited_alias rule
8. default deny

명시적 deny는 allow보다 우선한다.

## 5. Approval Model

Approval record:

| Field | 의미 |
|---|---|
| `approvalId` | approval 식별자 |
| `tenantId` | tenant scope |
| `clientId` | MCP client/app scope |
| `actorId` | 사용자 또는 agent id |
| `targetId` | target MCP |
| `toolName` | target tool |
| `argumentsHash` | canonicalized arguments hash |
| `policyVersion` | 승인 시점의 policy version |
| `observationId` | 승인 시점의 target tools snapshot |
| `schemaHash` | 승인 시점의 target input/output schema hash |
| `rewriteHash` | alias/injected argument rewrite hash |
| `expiresAt` | TTL |
| `status` | pending/approved/rejected/expired/used |
| `auditEventId` | 근거 event |

보안 규칙:

- approval은 원문 인자 전체가 아니라 canonical hash에 묶는다.
- 승인 후 인자가 조금이라도 바뀌면 재승인이 필요하다.
- mutation approval은 atomic one-time consume과 짧은 TTL을 기본값으로 둔다.
- policy version, observation id, schema hash, rewrite hash가 바뀌면 기존 approval은 stale로 처리한다.
- 동일 args hash라도 동시 재사용은 차단한다.
- approval 화면에는 민감 원문을 그대로 표시하지 않는다.

## 6. Canonical Hash And Policy Version

`argumentsHash`는 approval replay 방어의 핵심 계약이다.

정본 규칙:

1. raw user arguments를 target input schema와 alias constraint로 검증한다.
2. 명시적으로 허용된 rewrite와 injected arguments를 적용한다.
3. target에 실제 전송될 post-rewrite effective arguments를 만든다.
4. effective arguments를 RFC 8785 JSON Canonicalization Scheme으로 canonicalize한다.
5. canonical bytes에 tenant-scoped HMAC-SHA-256을 적용해 `argumentsHash`를 만든다.

세부 규칙:

- approval은 raw user arguments가 아니라 target에 실제 가는 post-rewrite effective arguments에 묶인다.
- `null`과 missing field는 서로 다른 값으로 취급한다.
- schema default 주입은 정책 rewrite에 명시된 경우에만 hash 입력에 포함한다.
- 부동소수, 유니코드, object key order는 RFC 8785 테스트 벡터로 고정한다.
- limited alias의 강제 인자, 예: `dryRun: true`, 는 effective arguments에 포함된다.
- 사용자가 숨겨진 강제 인자를 제공하면 alias constraint 위반으로 처리하거나 강제값으로 덮어쓴 뒤 그 결과를 hash한다. MVP 기본값은 강제값으로 덮어쓰기다.

`rewriteHash`는 alias/rewrite 정의의 canonical hash다. `policyVersion`은 활성 policy 원문을 canonicalize한 뒤 HMAC hash로 산출하며, 해당 원문은 `mcp_policies`에 저장되어야 한다.

## 7. Limited Alias Rules

Limited alias는 target tool이 자체 제공하는 preview/dry-run 모드를 강제 노출하는 방식이다. 이 표현은 안전 보증이 아니라 "실제 mutation을 하지 않는 target-supported mode만 호출한다"는 제한을 뜻한다.

예:

```text
target tool:
  actions.apply_profile(profileId, dryRun)

exposed alias:
  risky_actions__preview_profile(profileId)

rewrite:
  dryRun = true
```

금지:

- target이 dry-run/preview를 지원하지 않는데 임의로 safe라고 주장
- 사용자 입력이 강제 인자를 덮어쓰게 허용
- alias가 target tool의 의미를 모호하게 바꾸는 rewrite

## 8. Alias Naming

MVP exposed tool name은 다음 grammar를 쓴다.

```text
<target_slug>__<tool_slug>
```

규칙:

- `target_slug`와 `tool_slug`는 lowercase `[a-z0-9_]+`만 허용한다.
- target id, target tool name의 `.`, `-`, 공백은 `_`로 normalize한다.
- target과 tool 사이에는 double underscore `__`를 쓴다.
- collision이 생기면 policy validation에서 실패시키고 수동 alias를 요구한다.
- original target id/tool name 역매핑은 Name Mapper와 audit event에 반드시 저장한다.

예:

| Target | Target tool | Exposed tool |
|---|---|---|
| `safe-notes` | `notes.list` | `safe_notes__notes_list` |
| `risky-actions` | `actions.apply_profile` | `risky_actions__preview_profile` |

## 9. Output Policy

`allow` 결정은 target 호출 허용일 뿐, target output을 그대로 client에 반환해도 된다는 뜻이 아니다.

반환 전 처리:

| Output kind | 정책 |
|---|---|
| text | secret, credential, 개인정보 후보 redaction |
| structuredContent | schema-aware redaction, denied fields 제거 |
| resource_link | scheme/host/path allowlist 확인 |
| embedded resource | 기본 차단, 명시 allow된 MIME/type만 허용 |
| image/audio content | 크기 제한, metadata redaction, optional block |

Output policy 실패 시 target 호출은 성공했더라도 Gateway result는 policy error로 반환하고 audit event를 남긴다.

Output redaction은 완전한 DLP 보장이 아니다. MVP 테스트는 알려진 token/key 패턴, 명시 deny field, resource_link allowlist, embedded resource block처럼 결정론적으로 검증 가능한 케이스만 통과 기준으로 둔다.
