-- Room policy changes apply only to later goals; every v2 goal and operation
-- carries its own immutable policy snapshot and server-computed digest.
ALTER TABLE camp_rooms ADD COLUMN verification_policy jsonb;
ALTER TABLE camp_goals ADD COLUMN verification_policy jsonb;
ALTER TABLE camp_goals ADD COLUMN verification_repairs integer NOT NULL DEFAULT 0;
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_verification_repairs_nonnegative CHECK (verification_repairs >= 0);
--> statement-breakpoint
CREATE TABLE camp_operations (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES camp_rooms(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES camp_goals(id) ON DELETE CASCADE,
  goal_attempt integer NOT NULL,
  kind text NOT NULL DEFAULT 'verification' CHECK (kind = 'verification'),
  input_candidate jsonb NOT NULL,
  verification_policy jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled','blocked')),
  attempt integer NOT NULL DEFAULT 0,
  infrastructure_failures integer NOT NULL DEFAULT 0,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT camp_operations_counts CHECK (goal_attempt > 0 AND attempt >= 0 AND infrastructure_failures >= 0)
);
CREATE INDEX camp_operations_room_status ON camp_operations(room_id, status);
CREATE INDEX camp_operations_goal_attempt ON camp_operations(goal_id, goal_attempt);
--> statement-breakpoint
-- Runs are a unified execution ledger. The discriminator is a real sum type:
-- a model execution owns a canonical task and agent identity, while trusted
-- verification owns an operation and can never impersonate a model role.
ALTER TABLE camp_runs ADD COLUMN executor text NOT NULL DEFAULT 'agent';
ALTER TABLE camp_runs ADD COLUMN operation_id uuid REFERENCES camp_operations(id) ON DELETE CASCADE;
ALTER TABLE camp_runs ALTER COLUMN task_id DROP NOT NULL;
ALTER TABLE camp_runs ALTER COLUMN role DROP NOT NULL;
ALTER TABLE camp_runs ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE camp_runs ADD COLUMN change_set jsonb;
ALTER TABLE camp_runs ADD COLUMN verification jsonb;
ALTER TABLE camp_runs ADD CONSTRAINT camp_runs_executor_owner CHECK (
  (executor = 'agent' AND task_id IS NOT NULL AND role IS NOT NULL AND agent_id IS NOT NULL AND operation_id IS NULL)
  OR (executor = 'verification' AND task_id IS NULL AND role IS NULL AND agent_id IS NULL AND operation_id IS NOT NULL)
);
CREATE UNIQUE INDEX camp_runs_operation_epoch ON camp_runs(operation_id, epoch) WHERE operation_id IS NOT NULL;
