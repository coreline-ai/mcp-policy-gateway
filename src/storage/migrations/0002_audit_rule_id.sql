-- 0002_audit_rule_id: preserve the policy rule that produced a decision.
alter table mcp_policy_events add column rule_id text;
