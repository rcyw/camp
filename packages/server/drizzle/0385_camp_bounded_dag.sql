-- Protocol 5 is explicit; preserve every old plan, pool and execution contract.
ALTER TABLE camp_goals ADD COLUMN dag_delivery jsonb;
ALTER TABLE camp_plans DROP CONSTRAINT camp_plans_revision_check;
ALTER TABLE camp_plans ADD CONSTRAINT camp_plans_revision_check CHECK (revision IN (1,2));
ALTER TABLE camp_goals DROP CONSTRAINT camp_goals_plan_mode;
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_plan_mode CHECK (
 plan_mode IN ('sequential','same_baseline_pair','parallel_pair','bounded_dag')
 AND (plan_mode <> 'same_baseline_pair' OR (workflow='serial' AND protocol_version=3))
 AND (plan_mode <> 'parallel_pair' OR (workflow='serial' AND protocol_version=4))
 AND (plan_mode <> 'bounded_dag' OR (workflow='serial' AND protocol_version=5))
 AND (protocol_version IS DISTINCT FROM 3 OR plan_mode='same_baseline_pair')
 AND (protocol_version IS DISTINCT FROM 4 OR plan_mode='parallel_pair')
 AND (protocol_version IS DISTINCT FROM 5 OR plan_mode='bounded_dag'));
ALTER TABLE camp_goals DROP CONSTRAINT camp_goals_execution_pool;
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_execution_pool CHECK (execution_pool IS NULL OR (protocol_version IN (4,5) AND jsonb_typeof(execution_pool)='object' AND octet_length(execution_pool::text)<=8192));
ALTER TABLE camp_goals DROP CONSTRAINT camp_goals_integration_inspection_pair;
ALTER TABLE camp_goals ADD CONSTRAINT camp_goals_integration_inspection_pair CHECK (NOT integration_inspection_required OR plan_mode IN ('same_baseline_pair','parallel_pair','bounded_dag'));
ALTER TABLE camp_operations ADD COLUMN scope text NOT NULL DEFAULT 'goal';
ALTER TABLE camp_operations ADD COLUMN plan_item_key text;
DROP INDEX camp_operations_integration_attempt;
CREATE UNIQUE INDEX camp_operations_integration_scope ON camp_operations(goal_id,goal_attempt,scope,coalesce(plan_item_key,'')) WHERE kind='integration';
ALTER TABLE camp_operations ADD CONSTRAINT camp_operations_scope CHECK ((scope='goal' AND plan_item_key IS NULL) OR (kind='integration' AND scope='node_input' AND plan_item_key IS NOT NULL));
CREATE TABLE camp_dag_nodes (
 id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES camp_plans(id) ON DELETE CASCADE,
 goal_id uuid NOT NULL REFERENCES camp_goals(id) ON DELETE CASCADE, goal_attempt integer NOT NULL,
 key text NOT NULL, ordinal integer NOT NULL, status text NOT NULL DEFAULT 'waiting_dependencies',
 input_candidate jsonb, input_sources jsonb NOT NULL DEFAULT '[]', input_resolution text,
 input_operation_id uuid REFERENCES camp_operations(id), active_task_id uuid REFERENCES tasks(id), approved_producer jsonb,
 rework_count integer NOT NULL DEFAULT 0,
 CONSTRAINT camp_dag_nodes_counts CHECK(goal_attempt>0 AND ordinal>=0 AND ordinal<6 AND rework_count>=0),
 CONSTRAINT camp_dag_nodes_status CHECK(status IN ('waiting_dependencies','waiting_integration','ready','building','reviewing','waiting_question','approved','blocked'))
);
CREATE UNIQUE INDEX camp_dag_nodes_key ON camp_dag_nodes(goal_id,goal_attempt,key);
CREATE INDEX camp_dag_nodes_plan ON camp_dag_nodes(plan_id,ordinal);
CREATE TABLE camp_dag_edges (
 from_node_id uuid NOT NULL REFERENCES camp_dag_nodes(id) ON DELETE CASCADE,
 to_node_id uuid NOT NULL REFERENCES camp_dag_nodes(id) ON DELETE CASCADE,
 PRIMARY KEY(from_node_id,to_node_id), CONSTRAINT camp_dag_edges_not_self CHECK(from_node_id<>to_node_id)
);
