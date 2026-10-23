-- A pair is an explicitly frozen two-parent workflow, not a general DAG.
ALTER TABLE camp_goals ADD COLUMN plan_mode text NOT NULL DEFAULT 'sequential';
ALTER TABLE camp_goals ADD COLUMN reviewed_items jsonb NOT NULL DEFAULT '{}';
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_plan_mode CHECK (
  plan_mode IN ('sequential','same_baseline_pair')
  AND (plan_mode <> 'same_baseline_pair' OR (workflow = 'serial' AND protocol_version = 3))
  AND (protocol_version IS DISTINCT FROM 3 OR plan_mode = 'same_baseline_pair')
);
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_reviewed_items CHECK (jsonb_typeof(reviewed_items) = 'object' AND octet_length(reviewed_items::text) <= 65536);
--> statement-breakpoint
ALTER TABLE camp_operations DROP CONSTRAINT camp_operations_kind_check;
ALTER TABLE camp_operations ALTER COLUMN verification_policy DROP NOT NULL;
ALTER TABLE camp_operations ADD COLUMN integration_input jsonb;
ALTER TABLE camp_operations ADD COLUMN integration_report jsonb;
ALTER TABLE camp_operations ADD COLUMN input_digest text;
ALTER TABLE camp_operations ADD CONSTRAINT camp_operations_payload_kind CHECK (
  (kind = 'verification' AND verification_policy IS NOT NULL AND integration_input IS NULL AND integration_report IS NULL AND input_digest IS NULL)
  OR (kind = 'integration' AND verification_policy IS NULL AND receipt IS NULL AND integration_input IS NOT NULL AND input_digest IS NOT NULL AND input_digest ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX camp_operations_integration_attempt ON camp_operations(goal_id,goal_attempt) WHERE kind = 'integration';
--> statement-breakpoint
ALTER TABLE camp_runs ADD COLUMN integration jsonb;
ALTER TABLE camp_runs DROP CONSTRAINT camp_runs_executor_owner;
ALTER TABLE camp_runs ADD CONSTRAINT camp_runs_executor_owner CHECK (
  (executor = 'agent' AND task_id IS NOT NULL AND role IS NOT NULL AND agent_id IS NOT NULL AND operation_id IS NULL)
  OR (executor IN ('verification','integration') AND task_id IS NULL AND role IS NULL AND agent_id IS NULL AND operation_id IS NOT NULL)
);
