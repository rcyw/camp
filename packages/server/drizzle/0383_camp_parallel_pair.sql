-- One trusted storage authority per Room, one immutable two-lane pool per v4 goal.
-- Historical Rooms have no storage provenance; their first compatible v4 claim
-- binds this identity. Old protocol contracts and run ledgers remain unchanged.
ALTER TABLE camp_rooms ADD COLUMN storage_id text;
ALTER TABLE camp_rooms ADD CONSTRAINT camp_rooms_storage_id CHECK (storage_id IS NULL OR storage_id ~ '^[a-f0-9]{64}$');
ALTER TABLE camp_goals ADD COLUMN execution_pool jsonb;
ALTER TABLE camp_goals DROP CONSTRAINT camp_goals_plan_mode;
ALTER TABLE camp_goals DROP CONSTRAINT camp_goals_integration_inspection_pair;
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_integration_inspection_pair CHECK (
  NOT integration_inspection_required OR plan_mode IN ('same_baseline_pair', 'parallel_pair')
);
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_plan_mode CHECK (
  plan_mode IN ('sequential','same_baseline_pair','parallel_pair')
  AND (plan_mode <> 'same_baseline_pair' OR (workflow = 'serial' AND protocol_version = 3))
  AND (plan_mode <> 'parallel_pair' OR (workflow = 'serial' AND protocol_version = 4))
  AND (protocol_version IS DISTINCT FROM 3 OR plan_mode = 'same_baseline_pair')
  AND (protocol_version IS DISTINCT FROM 4 OR plan_mode = 'parallel_pair')
);
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_execution_pool CHECK (
  execution_pool IS NULL OR (protocol_version = 4 AND jsonb_typeof(execution_pool) = 'object' AND octet_length(execution_pool::text) <= 8192)
);
