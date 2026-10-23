-- Cancellation, budget failure and native outcome uncertainty are independent.
-- Keep this latch even when the lifecycle reason later changes.
ALTER TABLE camp_goals ADD COLUMN integration_inspection_required boolean NOT NULL DEFAULT false;
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_integration_inspection_pair CHECK (
  NOT integration_inspection_required OR plan_mode = 'same_baseline_pair'
);

--> statement-breakpoint
-- Preserve known uncertainty recorded before this independent latch existed.
-- Only current-attempt pair facts are eligible; historical v1/v2 rows stay intact.
UPDATE camp_goals AS goal
SET integration_inspection_required = true
WHERE goal.plan_mode = 'same_baseline_pair'
  AND (
    goal.reason = 'integration_inspection_required'
    OR EXISTS (
      SELECT 1 FROM camp_operations AS operation
      JOIN camp_runs AS run ON run.operation_id = operation.id
      WHERE operation.goal_id = goal.id
        AND operation.goal_attempt = goal.attempt
        AND operation.kind = 'integration'
        AND run.error = 'camp_integration_inspection_required'
    )
  );
