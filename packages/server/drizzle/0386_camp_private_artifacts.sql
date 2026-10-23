-- Private cold-Store transfers are independent of attachment/CDN storage.
-- Candidate IDs, backup receipts and accepted heads remain immutable.
CREATE TABLE camp_private_artifacts (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES camp_rooms(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL REFERENCES camp_storage_operations(id) ON DELETE CASCADE,
  manifest jsonb NOT NULL,
  manifest_digest text NOT NULL,
  bytes bigint NOT NULL,
  state text NOT NULL DEFAULT 'uploading',
  parts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  CONSTRAINT camp_private_artifacts_digest CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT camp_private_artifacts_budget CHECK (bytes > 0 AND bytes <= 17189371904 AND octet_length(manifest::text) <= 524288 AND octet_length(parts::text) <= 524288),
  CONSTRAINT camp_private_artifacts_state CHECK ((state = 'uploading' AND sealed_at IS NULL) OR (state = 'ready' AND sealed_at IS NOT NULL))
);
CREATE UNIQUE INDEX camp_private_artifacts_operation ON camp_private_artifacts(room_id, operation_id);
CREATE INDEX camp_private_artifacts_room ON camp_private_artifacts(room_id, state);
