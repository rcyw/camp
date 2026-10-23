ALTER TABLE "camp_rooms" ADD COLUMN "accepted_revision" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "camp_rooms" ADD COLUMN "accepted_goal_id" uuid REFERENCES "camp_goals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "camp_rooms" ADD COLUMN "accepted_candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "workflow" text NOT NULL DEFAULT 'legacy' CHECK (workflow IN ('legacy','serial'));
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "base_head_revision" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "from_goal_id" uuid REFERENCES "camp_goals"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "base_candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "current_candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "final_candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD COLUMN "summary" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_goals" DROP CONSTRAINT "camp_goals_status_check";
--> statement-breakpoint
ALTER TABLE "camp_goals" ADD CONSTRAINT "camp_goals_status_check" CHECK (status IN ('queued','running','waiting_question','cancelling','completed','cancelled','needs_attention'));
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "kind" text NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan','build','review','final_review','summary','clarification'));
--> statement-breakpoint
UPDATE "camp_tasks" SET "kind" = CASE "role" WHEN 'planner' THEN 'plan' WHEN 'builder' THEN 'build' ELSE 'review' END;
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "plan_item_key" text;
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "input_candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "infrastructure_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE "camp_tasks" task SET "infrastructure_failures" = (SELECT count(*)::int FROM "camp_runs" run WHERE run.task_id = task.task_id AND run.status = 'failed' AND run.error IN ('lease_expired','worker_interrupted','worker_shutdown'));
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "question_id" uuid;
--> statement-breakpoint
ALTER TABLE "camp_tasks" DROP CONSTRAINT "camp_tasks_status_check";
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD CONSTRAINT "camp_tasks_status_check" CHECK (status IN ('queued','running','waiting_question','completed','failed','cancelled','blocked'));
--> statement-breakpoint
ALTER TABLE "camp_runs" ADD COLUMN "input_candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_runs" ADD COLUMN "candidate" jsonb;
--> statement-breakpoint
ALTER TABLE "camp_runs" ADD COLUMN "question_id" uuid;
--> statement-breakpoint
ALTER TABLE "camp_runs" DROP CONSTRAINT "camp_runs_status_check";
--> statement-breakpoint
ALTER TABLE "camp_runs" ADD CONSTRAINT "camp_runs_status_check" CHECK (status IN ('running','suspended','completed','failed','cancelled'));
--> statement-breakpoint
CREATE TABLE "camp_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "goal_id" uuid NOT NULL REFERENCES "camp_goals"("id") ON DELETE CASCADE,
  "goal_attempt" integer NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "camp_tasks"("task_id") ON DELETE CASCADE,
  "submitted_run_id" uuid REFERENCES "camp_runs"("id") ON DELETE SET NULL,
  "revision" integer NOT NULL DEFAULT 1 CHECK (revision = 1),
  "body_hash" text NOT NULL,
  "summary" text NOT NULL,
  "items" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("goal_id", "goal_attempt")
);
--> statement-breakpoint
CREATE TABLE "camp_finalizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "goal_id" uuid NOT NULL REFERENCES "camp_goals"("id") ON DELETE CASCADE,
  "goal_attempt" integer NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "camp_tasks"("task_id") ON DELETE CASCADE,
  "submitted_run_id" uuid REFERENCES "camp_runs"("id") ON DELETE SET NULL,
  "body_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "candidate" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("goal_id", "goal_attempt")
);
--> statement-breakpoint
CREATE TABLE "camp_questions" (
  "id" uuid PRIMARY KEY,
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "goal_id" uuid NOT NULL REFERENCES "camp_goals"("id") ON DELETE CASCADE,
  "goal_attempt" integer NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "camp_tasks"("task_id") ON DELETE CASCADE,
  "origin_run_id" uuid REFERENCES "camp_runs"("id") ON DELETE SET NULL,
  "active_run_id" uuid REFERENCES "camp_runs"("id") ON DELETE SET NULL,
  "origin_epoch" integer NOT NULL,
  "from_role" text NOT NULL,
  "to_role" text NOT NULL CHECK (to_role IN ('planner','builder','reviewer')),
  "needs_human" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','awaiting_role','awaiting_human','answered','cancelled')),
  "content" text NOT NULL,
  "fingerprint" text NOT NULL,
  "clarification_task_id" uuid REFERENCES "camp_tasks"("task_id") ON DELETE SET NULL,
  "candidate" jsonb,
  "answer" text,
  "answer_by_role" text,
  "answer_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "escalation_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "answered_at" timestamptz,
  "resumed_at" timestamptz,
  UNIQUE("task_id", "fingerprint")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "camp_questions_one_pending" ON "camp_questions"("task_id") WHERE "resumed_at" IS NULL AND "status" <> 'cancelled';
--> statement-breakpoint
CREATE INDEX "camp_questions_goal" ON "camp_questions"("goal_id", "goal_attempt", "status");
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD CONSTRAINT "camp_tasks_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "camp_questions"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "camp_runs" ADD CONSTRAINT "camp_runs_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "camp_questions"("id") ON DELETE SET NULL;
