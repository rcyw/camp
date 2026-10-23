# Next: dependency plans beyond bounded pairs

This document proposes dependency graphs after [serial room delivery](./serial-room-workflow.md), [trusted two-candidate integration](./trusted-integration.md) and [bounded pair execution](./bounded-pair-execution.md). The current API accepts bounded ordered plans, the sequential `same_baseline_pair` and the explicit two-lane `parallel_pair`. Arbitrary dependency graphs remain disabled. The graph request shape below is a proposal, not an accepted current request.

## Product boundary

A human submits one outcome in a room. The planner may propose a small dependency graph; the server validates and persists that plan. Workers claim only server-authorized work. Agents do not create private subagents, hold leases, choose new credentials, perform trusted integration or increase their own execution budget. They retain ordinary process execution for code and tests inside their assigned sandbox.

The useful demonstration is two independent implementation tasks from the same immutable baseline, followed by a trusted integration operation and a review of the combined candidate. Showing two chats or picking the last finished commit does not demonstrate this capability.

## Proposed planning contract

The current `camp_submit_plan` tool uses `POST /api/camp/worker/runs/:runId/plan` for ordered items with acceptance and verification fields. A future graph-capable contract could extend it as illustrated below. Current endpoints reject unknown dependency/role/model fields rather than silently treating such a graph as a serial plan.

```json
{
  "workerId": "trusted-worker-identity",
  "epoch": 1,
  "planRevision": 1,
  "summary": "Separate parser and presentation changes, then verify their integration.",
  "tasks": [
    {"key":"parser","title":"Implement parser","description":"...","dependsOn":[]},
    {"key":"presentation","title":"Implement presentation","description":"...","dependsOn":[]},
    {"key":"integration-tests","title":"Verify combined behavior","description":"...","dependsOn":["parser","presentation"]}
  ]
}
```

The tool schema should expose only the planner's task keys, titles, descriptions and dependencies. It should not expose worker IDs, agent IDs, arbitrary role names, machine/container specifications, model overrides, credentials, merge strategies or raw budget increases. The client adds the current run identity. The server alone assigns implementation roles and creates the trusted integration/review nodes.

Admission must atomically enforce:

- Current room, goal, planner role, run ID, epoch, live lease and uncancelled goal.
- A configured maximum number of tasks, dependency edges, description bytes, attempts, active runs and total goal runtime.
- Unique local keys, existing dependency keys, no self references, no cycles and no references to another goal's task.
- A single accepted plan per goal revision. Retrying the identical revision returns the same task IDs. A different body for that revision is a conflict.
- A graph normalized into durable task/dependency records before acknowledging acceptance. An agent's final text cannot be a substitute for acceptance.

Independent implementation nodes may become ready together, within the goal and worker concurrency caps. A downstream implementation node starts from a candidate containing all its required predecessors, not whichever predecessor happens to be listed last.

## Candidate lineage and fan-in

Each implementation attempt has an immutable input baseline and an immutable output candidate. References must include the goal, task, run and epoch that produced them. A completed attempt's output should remain addressable even after its sandbox is removed.

For siblings built from the same baseline, trusted integration must combine changes relative to that baseline. It must not replace the whole workspace with one sibling's complete filesystem snapshot. Using the final array element, newest completion timestamp or last candidate commit silently drops other work.

The implemented release integrates exactly two candidates from one frozen baseline; arbitrary graph scheduling remains disabled. In the pinned LayerFS revision (`5fb68ddc1acc3163e3ac3486133bde014c5fbed3`), `branch.merge(a, b, name, message, units)` provides a three-way merge without mutating the input branches. Camp now invokes this API with a conservative policy and validates the complete resulting tree; the implementation and actual acceptance are described in the trusted integration guide. LayerFS's default `/.lww` selection and optional units can select one side, so the integration policy must explicitly control them rather than assume every overlap becomes a conflict.

The supported integration mechanism is explicit and narrow:

1. Freeze the shared baseline and both exact parent candidate identities, roots, image and policy in a server-owned operation. Require both parents to descend from the intended baseline; reject unrelated or superseded inputs.
2. Use fresh, trusted branches outside agent write authority. Invoke a versioned LayerFS merge adapter with an explicit conflict policy. Never use the bounded display Diff as an applicable patch; it can be truncated and is not a complete filesystem representation.
3. Reject ambiguous overlaps, unsupported filesystem objects and unapproved conflict-selection policy. Preserve both inputs. A merge conflict yields no accepted result; `NameTaken` or an interrupted native call requires inspection of the recorded intent before retrying.
4. Persist the exact immutable integrated candidate, both parents, algorithm/policy version and evidence through an outbox. An operation replay must not create another accepted candidate or rewrite history.
5. Run the frozen checks against the integrated candidate, then assign review to that exact identity. Separate approvals of the parents cannot approve their combination.

Real LayerFS round-trip, conflicting-edit, deletion, binary/mode, no-op Layer, prior merge-Commit baseline, replay and interruption tests establish this narrow contract. Two-lane admission, aggregate resources, concurrent cancellation and multiple active leases have their own contract and acceptance in the bounded pair guide. Those checks do not establish arbitrary graph or multi-host execution.
Integration is a first-class durable operation with its own idempotency key and recovery state. An unknown integration outcome must be inspected before retrying. A conflicting integration becomes `needs_attention`; downstream review must not run against an arbitrary fallback candidate.

## Review contract

A review verdict binds to the candidate actually mounted and checked by the reviewer. The reviewer reports an explicit verdict and evidence; the server compares the submitted candidate identity with the run's authorized input. A claim in prose or a commit invented by the agent cannot approve another candidate.

Before finalization, the worker and server must agree on the goal ID, producing task/run/epoch, candidate commit/root and any integration revision. If the candidate changes, its old approval cannot be reused. Review failure, missing verdict or stale candidate identity leaves the goal recoverable or requiring attention; none defaults to approval.

## Recovery and UI

The server exposes goal state, budget usage, active operations and supported recovery actions. The browser projects those facts. It must not infer that a lease expired solely from its own clock and then claim a container has stopped.

A goal card should show the original outcome, execution budget, dependency graph, current candidates, exact review verdict and one explicit recovery action. The graph should label actual prerequisites rather than treating nearby cards as a dependency. Failed attempts remain in history when a task is retried. Cancellation stops new admissions immediately and stays visibly pending until active work is fenced and cleanup is confirmed.

Keep multi-node automatic repair disabled in the first dynamic-plan release. A reviewer request for changes to an integrated candidate should stop at a visible, budget-bounded recovery decision. This differs from the current fixed pipeline's bounded builder/reviewer rework: multi-node repair needs separate plan revisions, lineage and rejection-loop tests before it is enabled.

## Enablement gates

Arbitrary graph scheduling remains disabled until these checks pass:

1. Concurrent identical plan submissions create one graph; changed replay, stale capability and cross-room/cross-goal edges are rejected.
2. Cyclic, oversized and ambiguous plans are rejected without partially creating tasks.
3. Two independent builders from one baseline each modify a different file; the integrated candidate retains both changes after remount and review.
4. Conflicting edits, deletions and unsupported file kinds produce an explicit integration failure and never silently drop a sibling's changes.
5. A dependent task with multiple parents reads the combined candidate; the scheduler never chooses the last dependency as a shortcut.
6. Worker termination during plan admission, candidate export, integration and finalization recovers without duplicate tasks or a second accepted candidate.
7. Reviewer approval for candidate A cannot finalize candidate B, a superseded attempt or a newer plan revision.
8. Goal cancellation and exhausted budgets prevent new work while retaining history, diagnostics and candidate artifacts.
9. The browser shows actual goal grouping, active work, blocked integration and supported recovery actions through a complete real-provider run.

The acceptance report must distinguish fake ACP tests, real LayerFS/Docker checks and a real DSH/model run. No result here promises automatic publication, deployment or merging into a human-owned branch.
