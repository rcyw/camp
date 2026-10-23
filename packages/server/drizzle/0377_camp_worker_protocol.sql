-- Freeze a goal's execution contract independently of a rolling server upgrade.
ALTER TABLE camp_goals ADD COLUMN protocol_version integer;
UPDATE camp_goals SET protocol_version = 1 WHERE workflow = 'serial';
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_protocol_version_positive CHECK (protocol_version IS NULL OR protocol_version > 0);
--> statement-breakpoint
-- Successful allocations retain the declaration used by that worker. Existing
-- runs keep NULL and their original recovery/completion payloads remain valid.
ALTER TABLE camp_runs ADD COLUMN worker_protocol jsonb;
--> statement-breakpoint
-- One current observation per Room/worker identity, rather than a poll event
-- stream. Credentials and host discovery paths never belong in this registry.
CREATE TABLE camp_workers (
  room_id uuid NOT NULL REFERENCES camp_rooms(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  declaration jsonb,
  compatibility jsonb,
  requirements jsonb,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_claim_at timestamptz,
  last_run_id uuid REFERENCES camp_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (room_id, worker_id),
  CONSTRAINT camp_workers_identity_length CHECK (length(worker_id) BETWEEN 1 AND 200)
);
CREATE INDEX camp_workers_room_seen ON camp_workers(room_id, last_seen_at);
