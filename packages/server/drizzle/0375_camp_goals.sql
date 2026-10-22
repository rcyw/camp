ALTER TABLE "camp_rooms" ADD COLUMN "reconciled_at" timestamptz;
--> statement-breakpoint
CREATE TABLE "camp_goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "room_id" uuid NOT NULL REFERENCES "camp_rooms"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "roles" jsonb NOT NULL DEFAULT '["planner","builder","reviewer"]',
  "initial_depends_on" jsonb NOT NULL DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','cancelling','completed','cancelled','needs_attention')),
  "reason" text,
  "attempt" integer NOT NULL DEFAULT 1,
  "budget" jsonb NOT NULL DEFAULT '{"maxRuns":12,"maxReviewRounds":3,"maxDurationSeconds":1800}',
  "run_count" integer NOT NULL DEFAULT 0,
  "review_rounds" integer NOT NULL DEFAULT 0,
  "attempt_history" jsonb NOT NULL DEFAULT '[]',
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz,
  "deadline_at" timestamptz,
  "completed_at" timestamptz,
  CONSTRAINT "camp_goals_counts" CHECK (attempt > 0 AND run_count >= 0 AND review_rounds >= 0)
);
--> statement-breakpoint
CREATE INDEX "camp_goals_room_status" ON "camp_goals" ("room_id", "status");
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "goal_id" uuid;
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD COLUMN "goal_attempt" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "camp_tasks" DROP CONSTRAINT "camp_tasks_status_check";
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD CONSTRAINT "camp_tasks_status_check" CHECK (status IN ('queued','running','completed','failed','cancelled','blocked'));
--> statement-breakpoint
-- Preserve existing pipelines (including rework descendants) as a single goal.
-- UNION deduplicates ancestry so malformed historical cycles terminate.
WITH RECURSIVE ancestry(task_id, ancestor_id) AS (
  SELECT task_id, task_id FROM camp_tasks
  UNION
  SELECT a.task_id, parent.task_id
  FROM ancestry a
  JOIN camp_tasks child ON child.task_id = a.ancestor_id
  JOIN LATERAL jsonb_array_elements_text(child.depends_on) dep(id) ON true
  JOIN camp_tasks parent ON parent.task_id = dep.id::uuid AND parent.room_id = child.room_id
), mapping AS (
  SELECT a.task_id, coalesce(min(a.ancestor_id::text) FILTER (WHERE jsonb_array_length(t.depends_on) = 0), min(a.ancestor_id::text))::uuid AS goal_id
  FROM ancestry a JOIN camp_tasks t ON t.task_id = a.ancestor_id GROUP BY a.task_id
)
UPDATE camp_tasks t SET goal_id = mapping.goal_id FROM mapping WHERE mapping.task_id = t.task_id;
--> statement-breakpoint
INSERT INTO camp_goals (id, room_id, title, description, roles, status, reason, created_by_user_id, created_at, started_at, deadline_at, completed_at, run_count, review_rounds)
SELECT bound.goal_id, root.room_id, regexp_replace(canonical.title, '^(planner|builder|reviewer): ', ''), canonical.description,
  (SELECT jsonb_agg(role ORDER BY CASE role WHEN 'planner' THEN 0 WHEN 'builder' THEN 1 ELSE 2 END) FROM (SELECT DISTINCT ct.role FROM camp_tasks ct WHERE ct.goal_id = bound.goal_id) roles),
  CASE WHEN bool_or(bound.status = 'running') THEN 'running'
       WHEN bool_or(bound.status IN ('failed','cancelled','blocked')) THEN 'needs_attention'
       WHEN bool_and(bound.status = 'completed') THEN 'completed' ELSE 'queued' END,
  CASE WHEN bool_or(bound.status = 'failed') THEN 'run_failed'
       WHEN bool_or(bound.status IN ('cancelled','blocked')) THEN 'dependency_blocked' ELSE NULL END,
  room.created_by_user_id, min(bound.created_at),
  (SELECT min(r.created_at) FROM camp_runs r JOIN camp_tasks ct ON ct.task_id = r.task_id WHERE ct.goal_id = bound.goal_id),
  (SELECT min(r.created_at) + interval '1800 seconds' FROM camp_runs r JOIN camp_tasks ct ON ct.task_id = r.task_id WHERE ct.goal_id = bound.goal_id),
  CASE WHEN bool_and(bound.status IN ('completed','failed','cancelled','blocked')) THEN now() ELSE NULL END,
  (SELECT count(*)::int FROM camp_runs r JOIN camp_tasks ct ON ct.task_id = r.task_id WHERE ct.goal_id = bound.goal_id),
  (SELECT count(*)::int FROM camp_runs r JOIN camp_tasks ct ON ct.task_id = r.task_id WHERE ct.goal_id = bound.goal_id AND r.role = 'reviewer' AND r.status = 'completed')
FROM camp_tasks bound
JOIN camp_tasks root ON root.task_id = bound.goal_id
JOIN tasks canonical ON canonical.id = root.task_id
JOIN camp_rooms room ON room.id = root.room_id
GROUP BY bound.goal_id, root.room_id, canonical.title, canonical.description, room.created_by_user_id;
--> statement-breakpoint
ALTER TABLE "camp_tasks" ALTER COLUMN "goal_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "camp_tasks" ADD CONSTRAINT "camp_tasks_goal_id_camp_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "camp_goals"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX "camp_tasks_goal_attempt" ON "camp_tasks" ("goal_id", "goal_attempt");
--> statement-breakpoint
ALTER TABLE "camp_runs" ADD COLUMN "claim_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "camp_runs_claim" ON "camp_runs" ("room_id", "claim_id");
--> statement-breakpoint
ALTER TABLE "camp_events" ADD COLUMN "goal_id" uuid REFERENCES "camp_goals"("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE camp_events event SET goal_id = bound.goal_id FROM camp_runs run JOIN camp_tasks bound ON bound.task_id = run.task_id WHERE event.run_id = run.id;
