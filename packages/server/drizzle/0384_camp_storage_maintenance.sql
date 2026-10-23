-- Storage placement is mutable only through a cold, explicitly authorized
-- operation. Historical goals, negotiated pools and candidate IDs are untouched.
ALTER TABLE camp_rooms ADD COLUMN storage_epoch integer NOT NULL DEFAULT 1;
ALTER TABLE camp_rooms ADD CONSTRAINT camp_rooms_storage_epoch CHECK (storage_epoch > 0);
CREATE TABLE camp_storage_operations (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES camp_rooms(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  kind text NOT NULL,
  phase text NOT NULL DEFAULT 'prepared',
  plan jsonb NOT NULL,
  plan_digest text NOT NULL,
  backup_receipt jsonb,
  restore_receipt jsonb,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT camp_storage_operations_digest CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT camp_storage_operations_payload CHECK (octet_length(plan::text) <= 8388608 AND (backup_receipt IS NULL OR octet_length(backup_receipt::text) <= 8192) AND (restore_receipt IS NULL OR octet_length(restore_receipt::text) <= 8192)),
  CONSTRAINT camp_storage_operations_phase CHECK ((kind = 'backup' AND phase IN ('prepared','completed','cancelled')) OR (kind = 'migration' AND phase IN ('prepared','backup_ready','restore_ready','activated','cancelled'))),
  CONSTRAINT camp_storage_operations_receipts CHECK (phase = 'cancelled' OR (phase = 'prepared' AND backup_receipt IS NULL AND restore_receipt IS NULL) OR (phase IN ('completed','backup_ready') AND backup_receipt IS NOT NULL AND restore_receipt IS NULL) OR (phase IN ('restore_ready','activated') AND backup_receipt IS NOT NULL AND restore_receipt IS NOT NULL))
);
CREATE UNIQUE INDEX camp_storage_operations_request ON camp_storage_operations(room_id, request_id);
CREATE UNIQUE INDEX camp_storage_operations_active ON camp_storage_operations(room_id) WHERE phase IN ('prepared','backup_ready','restore_ready');
CREATE INDEX camp_storage_operations_room ON camp_storage_operations(room_id, created_at);
