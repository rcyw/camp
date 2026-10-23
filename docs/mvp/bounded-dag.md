# Bounded dependency graphs

Camp protocol 5 adds the explicit `bounded_dag` plan mode. It retains one Room,
one project, the planner/builder/reviewer roles and a two-lane trusted local
pool. A graph changes task eligibility; it does not grant scheduling authority
to a model or turn messages into an execution queue.

## Plan and admission

The planner submits `planRevision: 2`. Each node has the existing key, title,
description, acceptance and verification fields, plus required `dependsOnKeys`.
An empty array means an independent root. Array order is a stable presentation
and parent ordering, never an implicit dependency.

```json
{
  "planRevision": 2,
  "summary": "Implement independent parts, then connect them",
  "tasks": [
    { "key": "api", "title": "API", "description": "Own API files", "acceptance": "Return the required data", "verification": "Run API checks", "dependsOnKeys": [] },
    { "key": "view", "title": "View", "description": "Own view files", "acceptance": "Render supplied data", "verification": "Run view checks", "dependsOnKeys": [] },
    { "key": "connect", "title": "Connect", "description": "Connect the approved parts", "acceptance": "Complete interaction works", "verification": "Run interaction checks", "dependsOnKeys": ["api", "view"] }
  ]
}
```

Admission limits are six nodes, two direct parents per node and at most two
final nodes. More final outputs need explicit join nodes. Reject missing,
self, duplicate, cyclic and transitively redundant dependencies, unknown
fields, resource/role assignment and changed accepted-plan replay. Parent
arrays are canonicalized by plan order before hashing. The accepted plan and
normalized node/edge facts commit atomically before acknowledgement.

Protocol 1–4 goals keep their original contract. Revision 2 is accepted only
for a protocol 5 DAG; ordered goals still require revision 1. A worker must
offer protocol 5, `bounded-dag.v1` and the original pool contract. Model roles
also require `structured-plan.v2`; plugins never advertise host admission or
trusted system operation capabilities. An incompatible worker allocates no
Run and consumes no budget.

## Input and approval facts

The server owns eligibility under the Room lifecycle lock. Roots consume the
frozen Goal baseline. A child can consume only exact, current-attempt,
candidate-bound approved producer Run/epoch facts. A suspended, failed or
unreviewed output cannot make it ready. Node rework produces another reviewed
attempt; descendants cannot have started from its rejected predecessor.

Single-parent inputs use that approved output. Two-parent inputs preserve both
sources. Identical reference identities or an explicitly proven ancestor can
be passed through without fabricating a merge receipt. Other pairs require a
scoped trusted integration operation before the builder task is created.
Content/root equality alone is not identity or an ancestry proof.

Integration scope is `(goal, attempt, scope, planItemKey)`: `node_input`
unlocks one node; `goal` joins final outputs. Repeated joins therefore have
independent immutable inputs, digests, Run records, outboxes and receipts.
Completion cannot mistakenly start whole-goal verification after an internal
node join. Existing pair goals retain one Goal-level integration.

## Actual LayerFS ancestry

The control side selects the unique closest common candidate from trusted
producer lineage. Protocol 5 integration freezes
`algorithm: layerfs-three-way-v2`, the exact baseline, ordered sources and the
existing `reject-overlap-v1` policy. The Worker independently checks actual
native history, including earlier merge second parents. It uses deterministic
private inspection branches, a total 4,096-commit bound and an intent written
before any native mutation. Missing history, cycles, ambiguous merge bases or
unsupported publication ancestry stop admission to native merge.

The native merge must report the exact expected common ancestor, source order
and conservative policy. The result is fully materialized and compared with
the complete expected tree; a display Diff is never used as an input patch.
The existing 20,000-entry/512-MiB per-tree limits remain. Overlapping changes,
including identical dual writes, are conflicts. Unknown native outcomes keep
inspection evidence and block automatic retry. Version 1 integration semantics
remain unchanged for older goals.

## Delivery, cancellation and recovery

One final node supplies its approved output. Two final nodes require a trusted
Goal join or explicit identity/ancestry reduction. The final candidate is
selected by graph facts, never the last array item or last completed Run.
Independent frozen checks, combined final review, bounded repair and planner
summary still precede accepted-head CAS. A repair cannot borrow approval from
the unrepaired candidate.

The original Run ledger, lease epochs, physical cleanup occupancy, budget,
questions and durable outbox remain authoritative. Only two builders may run;
the reviewer remains single-instance and system operations require the pool
to be empty. Cancelling a Run drains the whole DAG goal. Retry starts a new
attempt, preserving old nodes, edges and integration evidence. An unresolved
native outcome or unknown cleanup cannot be bypassed by retry or a new goal.

The UI groups nodes by dependency depth and shows blocked parents, actual
input, pinned producer facts and scoped integration receipts. It does not
recompute eligibility or ancestry. Version Diff remains relative to the Goal
baseline; actual node input and integration merge base are separate facts.

## Validation

Automated boundaries cover malformed/replayed plans, protocol compatibility,
multi-level dependencies, repeated joins, reversed completion, rejected-node
rework, identity/ancestor reduction, cancellation, stale attempts, budgets,
unknown cleanup/native outcomes and browser projection. Real infrastructure
acceptance is `node scripts/mvp/dag-real-smoke.mjs --real-infra`: six nodes,
two native joins with earlier merge ancestry, an independently reviewed rework,
two physical root sandboxes and fixed external verification. Its receipt must
state `hostCount: 1`, synthetic role decisions and zero model calls.

Graph execution and private artifact transport have separate release gates.
This graph does not enable concurrent writers in Stores on different hosts.

## Verified on 2026-10-23

789 distinct automated checks passed: shared protocol/plugin 49, process
supervision 9, Runtime 296, Web DOM 187 and Server 248. Server totals include
six Camp and two task tests on an isolated real PostgreSQL database; the
ordinary suite's eight conditional PostgreSQL placeholders are not counted a
second time. Type checks, generated declarations, scoped lint and configured
secret scanning passed.

Real infrastructure completed the six-node graph
`a,b → c(a,b) → d(c),e(a) → f(d,e)`. The first `c` review requested a fix;
`d` consumed only the subsequently approved output. Both native joins
completed, the second used approved `a` as its actual common ancestor and
traversed prior merge history. Independent checks, final acceptance and export
preserved all six changes and the review fix. Receipt:
`.camp/dag-infra-latest.json`.

The isolated native helper additionally proved second-parent traversal,
ambiguous crisscross rejection before merge, validated recovery and a real
SIGKILL after native merge without blind replay. Receipt:
`.camp/dag-native-integration-real.json`. Real HTTP/browser inspection verified
both node-input receipts and the exact final producer:
`.camp/dag-ui-infra-real-latest.json`.

The separate real DSH/provider run completed a reviewed foundation followed
by two concurrent leaves and a trusted final join. It used nine model Runs
and two system Runs in 243 seconds, with zero questions, human answers,
manual retries or rework. The final join used the approved foundation as its
base. After native export, six supplied tests and the fixed external harness
passed again in containers with no network and a read-only filesystem. Real
browser inspection confirmed the delivery candidate, Diff and verification
receipt. Receipts: `.camp/dag-model-latest.json` and
`.camp/dag-ui-model-real-latest.json`.

Both workflow probes used one physical host. Test Rooms were independently
created and archived; the standing demo, original image and accepted head were
retained. Migration 0385 introduced graph facts without rewriting existing
Room, Goal, task, Run, event, plan, operation, finalization or storage-operation
rows. The local migration receipt records pre/post historical hashes.
