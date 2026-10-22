CREATE TABLE "camp_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "channel_id" uuid NOT NULL REFERENCES "channels"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "project" jsonb NOT NULL,
  "roles" jsonb NOT NULL,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "camp_rooms_channel" ON "camp_rooms" ("channel_id");
--> statement-breakpoint
CREATE INDEX "camp_rooms_server" ON "camp_rooms" ("server_id");
--> statement-breakpoint
CREATE TABLE "camp_tasks" (
  "task_id" uuid PRIMARY KEY REFERENCES "tasks"("id") ON DELETE CASCADE,
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK (role IN ('planner','builder','reviewer')),
  "depends_on" jsonb NOT NULL DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  "attempt" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "camp_tasks_room" ON "camp_tasks" ("room_id", "status");
--> statement-breakpoint
CREATE TABLE "camp_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK (role IN ('planner','builder','reviewer')),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "epoch" integer NOT NULL,
  "worker_id" text NOT NULL,
  "run_token_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
  "lease_expires_at" timestamptz NOT NULL,
  "heartbeat_at" timestamptz NOT NULL DEFAULT now(),
  "cancel_requested_at" timestamptz,
  "summary" text,
  "artifacts" jsonb NOT NULL DEFAULT '[]',
  "session_id" text,
  "error" text,
  "outcome" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "camp_runs_task_epoch" ON "camp_runs" ("task_id", "epoch");
--> statement-breakpoint
CREATE UNIQUE INDEX "camp_runs_token" ON "camp_runs" ("run_token_hash");
--> statement-breakpoint
CREATE INDEX "camp_runs_room_status" ON "camp_runs" ("room_id", "status");
--> statement-breakpoint
CREATE TABLE "camp_worker_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "camp_worker_tokens_hash" ON "camp_worker_tokens" ("token_hash");
--> statement-breakpoint
CREATE TABLE "camp_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq" bigserial NOT NULL,
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "camp_runs"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "content" text NOT NULL,
  "to_role" text,
  "artifact" jsonb,
  "message_id" uuid REFERENCES "messages"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "camp_events_room_seq" ON "camp_events" ("room_id", "seq");
