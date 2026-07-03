-- 0001_init: core catalog/policy/audit tables.
-- Logical schema from docs/handoff/05-data-model-and-audit.md, mapped to SQLite:
--   uuid -> text, timestamptz -> ISO-8601 text, jsonb -> JSON text, text[] -> JSON text.
-- Postgres migration can restore the logical types 1:1.

create table if not exists mcp_targets (
  id                     text primary key,
  tenant_id              text not null,
  name                   text not null,
  target_kind            text not null,
  registration_source    text not null default 'privileged_config',
  executable_ref         text,
  args_template          text,          -- JSON; secret placeholders/refs only, never literals
  env_profile_id         text,
  endpoint_url           text,
  egress_policy_id       text,
  repository_url         text,
  package_identifier     text,
  auth_profile_id        text,
  credential_scope       text,
  credential_rotation_at text,
  watch_interval_seconds integer not null default 3600,
  status                 text not null default 'active',
  command                text,          -- JSON (legacy/simple stdio spawn); prefer executable_ref+args_template
  created_at             text not null default (datetime('now')),
  updated_at             text not null default (datetime('now'))
);

create table if not exists mcp_observations (
  id                  text primary key,
  target_id           text not null references mcp_targets(id),
  observed_at         text not null default (datetime('now')),
  source_kind         text not null,
  protocol_version    text,
  server_name         text,
  server_version      text,
  capabilities        text,             -- JSON
  normalized_hash     text not null,
  completeness_status text not null default 'incomplete',
  next_cursor         text,
  list_changed_at     text,
  raw_evidence_ref    text,
  redaction_report    text,             -- JSON
  status              text not null
);

create table if not exists mcp_tool_snapshots (
  id                 text primary key,
  observation_id     text not null references mcp_observations(id),
  tool_name          text not null,
  exposed_name       text,
  description_hash   text,
  input_schema_hash  text,
  output_schema_hash text,
  rewrite_hash       text,
  exposure_status    text not null default 'hidden',
  tool_json          text not null,     -- JSON
  review_status      text not null default 'unreviewed',
  policy_labels      text not null default '[]',  -- JSON array
  unique (observation_id, tool_name)
);

create table if not exists mcp_policies (
  version           text primary key,
  tenant_id         text not null,
  content_hash      text not null,
  content_ref       text,
  normalized_policy text not null,       -- canonical JSON of policy content
  author_actor_id   text,
  activated_at      text,
  superseded_at     text,
  created_at        text not null default (datetime('now'))
);

create table if not exists mcp_policy_events (
  id                   text primary key,
  event_type           text not null,
  tenant_id            text not null,
  target_id            text references mcp_targets(id),
  observation_id       text references mcp_observations(id),
  policy_version       text not null,
  actor_id             text,
  client_id            text,
  exposed_tool         text,
  target_tool          text,
  decision             text,
  reason               text,
  arguments_hash       text,
  result_hash          text,
  output_policy_status text,
  redaction_report     text,            -- JSON
  approval_id          text,
  evidence_pack_ref    text,
  audit_metadata       text,            -- JSON
  created_at           text not null default (datetime('now'))
);

create table if not exists mcp_approvals (
  id                text primary key,
  tenant_id         text not null,
  target_id         text not null references mcp_targets(id),
  actor_id          text,
  client_id         text,
  target_tool       text not null,
  arguments_hash    text not null,
  policy_version    text not null,
  observation_id    text not null references mcp_observations(id),
  schema_hash       text not null,
  rewrite_hash      text,
  status            text not null,
  consumed_at       text,
  requested_event_id text references mcp_policy_events(id),
  decided_event_id  text references mcp_policy_events(id),
  expires_at        text not null,
  created_at        text not null default (datetime('now')),
  updated_at        text not null default (datetime('now'))
);

create index if not exists idx_targets_tenant_status on mcp_targets(tenant_id, status);
create index if not exists idx_events_tenant_created on mcp_policy_events(tenant_id, created_at);
create index if not exists idx_approvals_lookup on mcp_approvals(tenant_id, target_tool, arguments_hash, status);
