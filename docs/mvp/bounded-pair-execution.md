# Bounded pair execution

This stage adds one explicit plan mode, `parallel_pair`: exactly two independent
implementation items, one immutable baseline, two local execution lanes and one
trusted integration. It extends the existing three logical roles (planner,
builder and reviewer). It does not create another agent framework or let model
tools own scheduling.

## User flow and immutable facts

1. A human submits an outcome and selects the parallel pair mode. The server
   freezes protocol 4, the budget and the verification policy for that goal.
2. The planner submits exactly two items through the existing DSH plan tool. The
   server records both tasks and makes both builds eligible. Both start from the
   same pinned baseline, including when the second build starts later.
3. Two lanes may run the same logical builder concurrently. A finished item can
   enter review while its sibling is still building. There is at most one active
   reviewer and at most two active runs in the Room. A question suspends its own
   item; the other item can progress. Clarification receives scheduling priority.
4. A requested change creates a new attempt for that item and retains the other
   item's approval. The goal's shared candidate remains the common baseline
   during item execution. Per-item candidates live in durable task, attempt,
   question and review records, rather than overwriting a shared “latest” value.
5. Only two current, candidate-bound approvals can create the integration
   operation. Parent ordering follows plan order, never completion time. The
   existing trusted merge, independent checks, combined review and planner
   summary then produce a deliverable with both changes.

`sequential` remains protocol 2. `same_baseline_pair` remains protocol 3 and
continues to execute its builders sequentially. Changing defaults or a Worker
upgrade cannot reinterpret an existing goal. Protocol 4 is an explicit contract
and is not an arbitrary dependency graph.

## Division of authority

The control server owns plan validation, eligibility, role assignment, budgets,
lease epochs, cancellation and the accepted project head. DSH runs the existing
model task tools inside one authorized sandbox. Its plugin cannot claim work,
increase capacity, merge trusted parents or approve cleanup. The trusted local
Worker owns containers, candidate capture, trusted integration, verification and
durable completion delivery.

The shared `@camp/protocol` package defines the protocol declaration and
validation. Worker 0.6.0 supports versions 1–4. Protocol 4 requires the host
capability `bounded-pair.v1`; the DSH plugin declares only model task
capabilities. An unpooled serial Worker offers at most version 3, even if the
server supports version 4. Upgrading an agent plugin alone cannot enable
concurrency.

## Pool contract

A trusted supervisor starts two instances of the existing Worker loop, with
separate stable lane IDs and journals but one runtime home and LayerFS Store.
Every version 4 claim carries the same `protocol.executionPool` declaration:

```json
{
  "executionPool": {
    "poolId": "b515481e-1461-4ca9-8577-96999d152872",
    "storageId": "<64 lowercase hexadecimal characters>",
    "maxParallel": 2,
    "workerIds": ["camp-local-lane-1", "camp-local-lane-2"],
    "resources": {
      "maxContainers": 4,
      "cpuMillis": 8000,
      "memoryBytes": 8589934592,
      "pidsLimit": 1024
    }
  }
}
```

The pool UUID, lane IDs and resource policy are private, durable host
configuration. `storageId` is an opaque digest of a persisted Store UUID and the
Docker daemon identity. It identifies this local storage domain; it is not
remote storage replication or cryptographic attestation.

On the first version 4 allocation, the server pins the Room's storage domain and
the goal's exact pool declaration under the Room lock. Later claims must match,
including system operations and manual retries. The claiming Worker must be one
of the two declared lanes and have no occupied slot already. The server exposes
the accepted project head in Worker setup, allowing the local Store to verify
an existing accepted candidate before first admission. Legacy Rooms acquire
storage provenance only when that check and version 4 admission occur; the
migration does not invent historical ownership.

A foreign pool, unavailable protocol or mismatched storage domain allocates no
Run and consumes no goal budget. A compatible Worker waiting for a free slot is
idle, with a capacity explanation. Admission, budget debit and lease creation
are one transaction under the existing Room lock. No model output can bypass
these checks.

## Physical capacity and supervision

One Node supervisor owns both lanes. A host manager lock keyed by Docker daemon
and OS user prevents another production pool or standalone Worker from sharing
the same host manager domain. This intentionally bounds the supported setup to
one manager per host user. It does not promise coordination across OS users,
remote Docker daemons, manual containers or independent runtime maintenance.

For a managed installation, adapt the
[pool systemd example](../../deploy/camp-worker-pool.service.example) with the
operator's absolute paths and private environment files. Run either that unit
or the serial Worker unit for this manager domain. Keep the runtime home and
base Worker identity stable across restarts.

Each lane reserves space for its main sandbox and one temporary materialization
or verification helper. Thus the pair reserves four containers. With the
default per-container policy of 2 CPU, 2 GiB and 256 PIDs, its configured
worst-case ceiling is 8 CPU, 8 GiB and 1,024 PIDs. Startup checks the configured
reservation against Docker's reported CPU/memory and the operator's limits,
with a host memory floor and existing storage free-space checks. The declaration
is a configured reservation, not live host utilization or a parent-cgroup quota.

The runtime must count every admitted helper, enforce container CPU, memory and
PID limits, and confirm cleanup before releasing its reservation. The pinned
LayerFS SDK starts its daemon before Docker resource updates can be applied;
limits are read back before agent execution. This short startup window remains
an explicit limitation. Maintenance/export tools outside the supervised pool
require the manager to be stopped first.

An uncertain native operation, unsafe journal, lost manager lock, failed
inspection or unconfirmed cleanup stops admissions for the whole pool. The
supervisor aborts and drains both lanes and waits for both outcomes. A routine
task failure with confirmed cleanup can follow the existing bounded workflow
recovery rules.

## Restart, cancellation and unknown resources

Startup has a recovery barrier. Before either lane may claim new work, the
supervisor examines the previous serial Worker journal and both lane journals,
restores bound claim intents, cleans up owned leftovers and delivers any durable
completion outboxes. Unknown ownership or native outcomes preserve evidence and
block admission.

Claim restoration uses `/claim` with `restoreOnly: true`, the original claim ID
and run token. A bound intent returns its original Run with the original owner
and negotiation. An unbound intent returns `run: null, unbound: true`; it must not
reconcile, mutate the registry, allocate or debit a budget. The normal replay of
an unbound intent is deferred until both lanes pass the barrier.

An expired lease is not proof that a container stopped. A version 4 Run without
confirmed cleanup continues occupying capacity. A fresh epoch, a manual retry
or a new goal cannot bypass that fact. Goal cancellation fences all active
attempts and prevents new admissions; the Worker then stops both physical
attempts and acknowledges cleanup. Cancelling an individual Run in this mode
cancels the entire goal, and the interface labels that action accordingly.

The browser uses server-observed `leaseValid`, cancellation and cleanup facts.
It lists both builder attempts and their exact input/output candidates and
distinguishes waiting for review, waiting for a slot and waiting for a human.
It never uses the browser clock as evidence of physical cleanup.

## Validation and rollout

The implementation must be checked at distinct boundaries:

- Shared protocol and plugin tests: strict declarations, old goal compatibility,
  model-only plugin requirements and zero-allocation rejection.
- Server tests with PostgreSQL: simultaneous claims, final budget slot races,
  reversed completion order, isolated rework/questions, one integration,
  cancelled goals, stale epochs and unknown-cleanup occupancy.
- Worker tests: two-loop supervision, resource accounting, all-journal recovery,
  restore-only claims, host-manager exclusion, failed cleanup and pool shutdown.
- Real Docker/LayerFS acceptance with synthetic role outputs: simultaneous live
  sandboxes, both immutable changes preserved and independent verification.
- A separate real DSH/provider run: planner, two builders, item reviews, trusted
  integration, external checks, final review and summary without human task
  coordination. Its report records model usage and observed concurrency.
- DOM and live Room checks: both runs, pending cleanup, pool ceilings, explicit
  goal cancellation and delivery evidence remain visible.

Receipts must distinguish simulated model output, real infrastructure and paid
provider execution. Local receipts and credentials stay outside version control.
No test result implies automatic publication, deployment or a Git merge.

After this contract is proven, the next independent stages are storage transfer
between hosts, durable worker registry/ownership handoff and then bounded DAG
dependencies. Each requires its own provenance and recovery contract. Increasing
the lane count or accepting a dependency list is not a safe substitute.

## Local acceptance on 2026-10-23

The focused and surrounding regression suites passed 660 checks:

| Boundary | Checks passed |
| --- | ---: |
| Shared protocol and DSH plugin | 37 |
| Runtime, including 16 pool regressions | 238 |
| Web DOM behavior | 160 |
| Server and surrounding task/channel regressions | 215 |
| Real PostgreSQL (Camp and ordinary task authority) | 6 |
| Acceptance child-process supervision | 4 |

TypeScript, generated declaration/descriptor freshness, scoped lint and the
working diff checks also passed. Browser fixtures and real infrastructure/model
acceptance below are separate from those automated check counts.

The additive migration `0383_camp_parallel_pair` was applied transactionally.
Its SHA-256 is
`157b6a5961d322789bbd229497b00584d852a9e4855f3d7e1485b5b1784c9b70`.
The existing 27 Rooms, 31 goals and 165 Runs were preserved, including their
previous execution facts. Historical pool and storage fields remain null.
Migrations 0376–0382 were not rewritten.

The pinned 0.6.0 toolchain digest is
`9ab4d022bd79c8a92067347bb7ea700b0355b7ec2c25d97a40a3d660f9495150`;
the standard image is
`sha256:10604b36acd44542b19a7060ab76059ab691a911c1a13d8d36b165226036633e`.

The real infrastructure acceptance completed all three cases with zero model
requests. It inspected two running main containers with enforced CPU, memory
and PID bounds. Reversed item completion still produced one integration and an
export with both notes. A single-Run cancellation cleaned both containers. A
SIGKILL left both actual containers running; restarting the pool recovered both
lane journals and removed both before logging the recovery barrier as ready.
Unpooled protocol 3 and wrong-storage claims allocated no additional work.
The private receipt is `.camp/parallel-infra-latest.json`.

The separate real-provider run completed in 178 seconds: seven DSH model Runs
and two trusted system Runs, with two simultaneous builder leases observed,
two approved items, three review rounds, zero human answers, zero manual retries
and zero reworks. Both independent module changes survived integration. The
frozen checks passed in the product's isolated UID 501 verifier; a separate
export check then passed the project suite and external contract in a read-only,
network-disabled container (UID 0 for this export-only probe). Its receipt is
`.camp/parallel-model-latest.json`.

PostgreSQL tests separately establish atomic final-budget admission, lease
expiry without physical slot release and fresh epoch admission only after
cleanup acknowledgement. Browser fixtures exercise live dual-Run presentation,
isolated questions, reviewer queueing, exact cancellation and the two cleanup
facts. Read-only browser captures use the real API and do not allocate tasks or
call a model. These results do not establish power-loss durability, remote
storage transfer or arbitrary dependency execution.
