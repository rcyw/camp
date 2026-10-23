import { and, eq, or } from "drizzle-orm";
import type { CampCandidate, CampIntegrationParent } from "../../../../camp-protocol/src/index.js";
import type { DatabaseExecutor } from "../../db/index";
import { campOperations, campRuns, campTasks } from "../../db/schema";
import { sameCandidate } from "./candidates";
import { CampError } from "./types";

type CandidateGraph = Map<string, { candidate: CampCandidate; parents: Set<string> }>;
/** Every edge comes from a fenced trusted completion. Stop at the frozen Goal
 * baseline: its older history is not needed to resolve this attempt's graph. */
export async function candidateLineage(tx: DatabaseExecutor, goal: { id: string; attempt: number; baseCandidate: CampCandidate | null }): Promise<CandidateGraph> {
  if (!goal.baseCandidate) throw new CampError(409, "dag_baseline_missing", "The graph has no frozen immutable baseline");
  const graph: CandidateGraph = new Map();
  const add = (candidate: CampCandidate, parents: CampCandidate[] = []) => {
    const found = graph.get(candidate.refId);
    if (found && !sameCandidate(found.candidate, candidate)) throw new CampError(409, "dag_lineage_invalid", "One candidate reference has inconsistent immutable identities");
    const row = found ?? { candidate, parents: new Set<string>() }; graph.set(candidate.refId, row);
    if (candidate.refId === goal.baseCandidate!.refId) return;
    for (const parent of parents) { if (parent.refId === candidate.refId) continue; row.parents.add(parent.refId); if (!graph.has(parent.refId)) graph.set(parent.refId, { candidate: parent, parents: new Set() }); }
    if (graph.size > 4096) throw new CampError(409, "dag_lineage_limit", "The graph lineage exceeds its bounded proof limit");
  };
  add(goal.baseCandidate);
  const rows = await tx.select({ input: campRuns.inputCandidate, candidate: campRuns.candidate, executor: campRuns.executor, integration: campOperations.integrationInput, report: campOperations.integrationReport }).from(campRuns)
    .leftJoin(campTasks, eq(campTasks.taskId, campRuns.taskId)).leftJoin(campOperations, eq(campOperations.id, campRuns.operationId))
    .where(and(or(and(eq(campTasks.goalId, goal.id), eq(campTasks.goalAttempt, goal.attempt)), and(eq(campOperations.goalId, goal.id), eq(campOperations.goalAttempt, goal.attempt))), or(eq(campRuns.status, "completed"), eq(campRuns.status, "suspended"))));
  for (const row of rows) if (row.input && row.candidate) {
    add(row.input);
    if (row.executor === "integration") {
      if (row.report?.status !== "merged" || !row.integration) continue;
      add(row.candidate, row.integration.parents.map(parent => parent.candidate));
    } else if (row.executor === "agent") add(row.candidate, [row.input]);
  }
  return graph;
}
function ancestors(graph: CandidateGraph, ref: string): Set<string> {
  const visited = new Set<string>(), pending = [ref];
  while (pending.length) { const id = pending.pop()!; if (visited.has(id)) continue; visited.add(id); if (visited.size > 4096) throw new CampError(409, "dag_lineage_limit", "The ancestry proof is too large"); for (const parent of graph.get(id)?.parents ?? []) pending.push(parent); }
  return visited;
}
export function resolveCandidateSources(graph: CandidateGraph, base: CampCandidate, sources: CampIntegrationParent[]): { resolution: "baseline" | "single_parent" | "same_ref" | "ancestor" | "integration"; candidate: CampCandidate | null; sourceRunId: string | null; mergeBase: CampCandidate | null } {
  if (!sources.length) return { resolution: "baseline", candidate: base, sourceRunId: null, mergeBase: null };
  if (sources.length === 1) return { resolution: "single_parent", candidate: sources[0].candidate, sourceRunId: sources[0].runId, mergeBase: null };
  if (sources.length !== 2) throw new CampError(409, "dag_parent_limit", "Only two direct candidate sources are supported");
  const [left, right] = sources;
  if (left.candidate.refId === right.candidate.refId) {
    if (!sameCandidate(left.candidate, right.candidate)) throw new CampError(409, "dag_lineage_invalid", "One reference has conflicting identities");
    return { resolution: "same_ref", candidate: left.candidate, sourceRunId: left.runId, mergeBase: null };
  }
  const a = ancestors(graph, left.candidate.refId), b = ancestors(graph, right.candidate.refId);
  if (a.has(right.candidate.refId)) return { resolution: "ancestor", candidate: left.candidate, sourceRunId: left.runId, mergeBase: null };
  if (b.has(left.candidate.refId)) return { resolution: "ancestor", candidate: right.candidate, sourceRunId: right.runId, mergeBase: null };
  const common = [...a].filter(ref => b.has(ref)), maximal = common.filter(ref => !common.some(other => other !== ref && ancestors(graph, other).has(ref)));
  if (maximal.length !== 1 || !graph.has(maximal[0])) throw new CampError(409, "dag_merge_base_ambiguous", "The approved inputs have no unique proven maximal common ancestor");
  return { resolution: "integration", candidate: null, sourceRunId: null, mergeBase: graph.get(maximal[0])!.candidate };
}

export function candidateDescendsFrom(graph: CandidateGraph, candidate: CampCandidate, ancestor: CampCandidate) { return ancestors(graph, candidate.refId).has(ancestor.refId); }
