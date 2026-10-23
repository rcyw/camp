-- A last authenticated self-report, not an online or remote attestation.
-- Existing workers retain NULL and old claim/recovery contracts are unchanged.
ALTER TABLE camp_workers ADD COLUMN preflight_project_digest text;
ALTER TABLE camp_workers ADD COLUMN preflight_report jsonb;
ALTER TABLE camp_workers ADD COLUMN preflight_observed_at timestamptz;
ALTER TABLE camp_workers ADD CONSTRAINT camp_workers_preflight_consistency CHECK (
  (preflight_project_digest IS NULL AND preflight_report IS NULL AND preflight_observed_at IS NULL)
  OR (preflight_project_digest IS NOT NULL AND preflight_report IS NOT NULL AND preflight_observed_at IS NOT NULL)
);
ALTER TABLE camp_workers ADD CONSTRAINT camp_workers_preflight_digest CHECK (
  preflight_project_digest IS NULL OR preflight_project_digest ~ '^[a-f0-9]{64}$'
);
ALTER TABLE camp_workers ADD CONSTRAINT camp_workers_preflight_size CHECK (
  preflight_report IS NULL OR (jsonb_typeof(preflight_report) = 'object' AND octet_length(preflight_report::text) <= 32768)
);
CREATE INDEX camp_workers_room_preflight ON camp_workers(room_id, preflight_observed_at);
