-- Historical raw request bodies cannot be reconstructed from merged artifacts.
-- Preserve their semantic replay fallback; every new settlement records an
-- immutable hash of its normalized original request in the same transaction.
ALTER TABLE camp_runs ADD COLUMN completion_payload_hash text;
ALTER TABLE camp_runs ADD CONSTRAINT camp_runs_completion_payload_hash
  CHECK (completion_payload_hash IS NULL OR completion_payload_hash ~ '^[a-f0-9]{64}$');
