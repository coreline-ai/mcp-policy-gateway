# 05. Data Model And Audit

## 1. Storage Principles

1. 원문 request/result는 기본 저장하지 않는다.
2. 기본 저장값은 hash, redacted metadata, decision reason이다.
3. 원문 evidence가 필요하면 암호화, 짧은 TTL, 별도 권한으로 분리한다.
4. audit event는 append-only로 취급한다.
5. policy version과 capability snapshot hash를 반드시 event에 연결한다.
6. `argumentsHash`와 `resultHash`는 plain SHA가 아니라 tenant-scoped HMAC/salt 기반 hash를 쓴다.
7. target secret은 policy YAML, command args, env dump, audit/evidence, tool schema에 저장하지 않는다.
8. audit read API는 redact-on-write에 더해 redact-on-read를 적용한다.
9. MVP SQLite의 `tenant_id`는 config single principal에서 온다. per-user tenant/client/actor 분리는 authenticated transport 이후 완성한다.
10. policy decision 재현을 위해 활성 policy 원문 또는 content ref를 version별로 저장한다.

## 2. Core Tables

아래 DDL은 logical schema다. MVP SQLite migration은 `uuid`, `timestamptz`, `jsonb`, `text[]`를 각각 `text`, ISO timestamp text, JSON text로 매핑한다. Postgres 전환 시 logical type을 그대로 사용할 수 있다.

### `mcp_targets`

```sql
create table mcp_targets (
  id uuid primary key,
  tenant_id uuid not null,
  name text not null,
  target_kind text not null,
  registration_source text not null default 'privileged_config',
  executable_ref text,
  args_template jsonb,
  env_profile_id uuid,
  endpoint_url text,
  egress_policy_id uuid,
  repository_url text,
  package_identifier text,
  auth_profile_id uuid,
  credential_scope text,
  credential_rotation_at timestamptz,
  watch_interval_seconds int not null default 3600,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

`executable_ref`는 allowlist나 package provenance check를 통과한 값만 저장한다. `args_template`에는 secret literal을 넣지 않고 secret placeholder/ref만 둔다. HTTP target은 `egress_policy_id`로 private IP, link-local, metadata endpoint 차단 정책을 연결한다.

### `mcp_observations`

```sql
create table mcp_observations (
  id uuid primary key,
  target_id uuid not null references mcp_targets(id),
  observed_at timestamptz not null default now(),
  source_kind text not null,
  protocol_version text,
  server_name text,
  server_version text,
  capabilities jsonb,
  normalized_hash text not null,
  completeness_status text not null default 'incomplete',
  next_cursor text,
  list_changed_at timestamptz,
  raw_evidence_ref text,
  redaction_report jsonb,
  status text not null
);
```

### `mcp_tool_snapshots`

```sql
create table mcp_tool_snapshots (
  id uuid primary key,
  observation_id uuid not null references mcp_observations(id),
  tool_name text not null,
  exposed_name text,
  description_hash text,
  input_schema_hash text,
  output_schema_hash text,
  rewrite_hash text,
  exposure_status text not null default 'hidden',
  tool_json jsonb not null,
  review_status text not null default 'unreviewed',
  policy_labels text[] not null default '{}',
  unique (observation_id, tool_name)
);
```

`review_status`와 `policy_labels`는 수동 정책 분류용 metadata다. 악성 MCP 탐지 점수나 완전 위험 판정을 의미하지 않는다.

### `mcp_policies`

```sql
create table mcp_policies (
  version text primary key,
  tenant_id uuid not null,
  content_hash text not null,
  content_ref text,
  normalized_policy jsonb not null,
  author_actor_id text,
  activated_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);
```

`policy_version`은 정규화된 policy content에 tenant-scoped HMAC hash를 적용해 산출한다. audit event가 decision reason을 재현하려면 해당 `policy_version`의 `normalized_policy` 또는 `content_ref`가 보존되어야 한다.

### `mcp_policy_events`

```sql
create table mcp_policy_events (
  id uuid primary key,
  event_type text not null,
  tenant_id uuid not null,
  target_id uuid references mcp_targets(id),
  observation_id uuid references mcp_observations(id),
  policy_version text not null,
  actor_id text,
  client_id text,
  exposed_tool text,
  target_tool text,
  decision text,
  rule_id text,
  reason text,
  arguments_hash text,
  result_hash text,
  output_policy_status text,
  redaction_report jsonb,
  approval_id uuid,
  evidence_pack_ref text,
  audit_metadata jsonb,
  created_at timestamptz not null default now()
);
```

`target_tool`, `decision`, `rule_id`는 nullable이다. `target_registered`, `credential_rotated`, `audit_event_read`처럼 tool call이 아닌 event도 같은 append-only event stream에 남기기 때문이다.
`rule_id`는 policy engine이 선택한 rule/default decision id를 보존해 `policy_version`의 `mcp_policies.normalized_policy`와 함께 decision reason 재현에 사용한다.

### `mcp_approvals`

```sql
create table mcp_approvals (
  id uuid primary key,
  tenant_id uuid not null,
  target_id uuid not null references mcp_targets(id),
  actor_id text,
  client_id text,
  target_tool text not null,
  arguments_hash text not null,
  policy_version text not null,
  observation_id uuid not null references mcp_observations(id),
  schema_hash text not null,
  rewrite_hash text,
  status text not null,
  consumed_at timestamptz,
  requested_event_id uuid references mcp_policy_events(id),
  decided_event_id uuid references mcp_policy_events(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## 3. Audit Event Types

| Event | 생성 시점 |
|---|---|
| `target_registered` | target 등록 |
| `target_observed` | tools/list snapshot 생성 |
| `tool_exposed` | upstream 노출 결정 |
| `tool_hidden` | upstream 숨김 결정 |
| `call_allowed` | target 호출 허용 |
| `call_blocked` | target 호출 차단 |
| `approval_required` | 승인 필요 |
| `approval_granted` | 승인 완료 |
| `approval_rejected` | 승인 거절 |
| `target_call_succeeded` | target 호출 성공 |
| `target_call_failed` | target 호출 실패 |
| `schema_changed` | target tool schema 변경 |
| `list_changed_received` | target `notifications/tools/list_changed` 수신 |
| `approval_consumed` | approval atomic consume 성공 |
| `approval_stale` | policy/snapshot/schema/rewrite 변경으로 승인 무효화 |
| `output_redacted` | 반환 전 output redaction 적용 |
| `output_blocked` | 반환 전 output policy 위반으로 차단 |
| `credential_rotated` | target credential rotate |
| `audit_event_read` | audit event 조회 |

## 4. Redaction Rules

기본 redaction:

- token, key, secret, password, credential
- email, phone, address 같은 개인정보 후보
- file path 중 home directory
- request/result 원문 content
- embedded resource content

저장 가능한 기본값:

- target id
- tool name
- schema hash
- arguments canonical hash
- result hash
- decision
- policy rule id
- redaction summary

## 5. Credential Custody

Target credential은 Gateway의 전용 secret store 또는 KMS에만 저장한다.

금지:

- policy YAML에 secret 저장
- command args에 token/key 직접 저장
- env dump를 audit/evidence에 저장
- tool schema, tool description, evidence pack에 credential 저장
- client에게 target credential 반환

요구:

- tenant/target scoped least privilege
- read-only credential 우선
- rotation/revoke metadata 저장
- credential leak regression test
- auth profile id만 일반 DB에 저장

## 6. Audit Read Privacy

`gateway_get_audit_event`는 최소 metadata만 반환한다.

요구:

- tenant RBAC 확인
- purpose-based access reason 기록
- retention/TTL 적용
- redact-on-write + redact-on-read
- bulk export 제한
- HMAC/salt 기반 hash 사용
- audit read 자체도 `audit_event_read`로 기록

## 7. Evidence Pack

`evidencePack`은 문제 재현과 감사에 필요한 최소 근거다.

```json
{
  "auditEventId": "uuid",
  "targetId": "risky-actions",
  "observationId": "uuid",
  "policyVersion": "hmac-sha256:...",
  "exposedTool": "risky_actions__preview_profile",
  "targetTool": "actions.apply_profile",
  "decision": "limited_alias",
  "reason": "dryRun alias injected",
  "argumentsHash": "hmac-sha256:...",
  "schemaHash": "hmac-sha256:...",
  "rewriteHash": "hmac-sha256:...",
  "outputPolicyStatus": "redacted",
  "redaction": {
    "rawArgumentsStored": false,
    "rawResultStored": false
  }
}
```
