# Candidate storage lifecycle

Camp separates a logical LayerFS project, a physical storage location, and the
control database. Candidate identities belong to the project. A Worker pool is
an execution deployment at a location; it is not the owner of project history.

## Ordered delivery

The first storage release delivers cold project backups, isolated restoration
and an explicit migration handoff. Protocol 5 [bounded dependency graphs](./bounded-dag.md) now have a separate
local-pool contract. Concurrent writers on different hosts remain disabled
until the transport and scheduling gates below pass. A migration is not concurrent multi-host execution.

The pinned LayerFS SDK has no supported online backup or graph-transfer API.
Importing an exported file tree creates new project bindings, Layers and
Commits. File equality therefore cannot prove preservation of a candidate or
its parents. Camp backs up the complete stopped SQLite Store and its opaque SDK
discovery record, using a versioned Camp format tied to the pinned toolchain.
This adapter must be reviewed when the LayerFS revision changes.

## Invariants

- A supported project is bound to `room:<room UUID>`, with its deterministic
  logical project ID. Different Rooms using the same source directory have
  separate Stores. Legacy or inconsistent project mappings require inspection.
- A backup contains the entire project Store, including branch and commit
  history, and the original discovery record. Its manifest records exact file
  hashes and lengths, toolchain and image identities, and the control side's
  frozen inventory of candidate references and roots.
- The bundle is private operator data. It contains project source and history;
  the backup process does not copy runtime API/model configuration, Worker
  journals, lease tokens, execution-pool identity or host deployment paths.
- A LayerFS project backup is not a PostgreSQL disaster-recovery backup. Room
  messages, tasks, reviews, receipts and credentials remain in PostgreSQL.
- Each restored location gets a new physical identity and Docker volume. The
  original project ID, ref IDs, root IDs and image identity remain unchanged.
  A copied runtime home must never reactivate old Worker identities or outboxes.
- Restoration starts in quarantine. Check hashes, SQLite integrity, exact
  toolchain/image compatibility and every frozen candidate reference and root through LayerFS
  before offering the result for activation. Refuse unsupported formats rather
  than silently reimporting files or selecting a different branch.
- Historical Goals, pool declarations, producing Runs, review evidence and
  accepted candidates are immutable. Migration increments the storage binding
  epoch and changes the active location; it does not advance the accepted head.

## Cold maintenance

An administrator creates a backup or migration operation against the expected
storage epoch and accepted-head revision. The server serializes it with ordinary
Room lifecycle operations. Require an accepted candidate and a registered
physical location, no active Goal or Run, no unconfirmed physical cleanup and no
ambiguous native integration. Maintenance blocks fresh claims and new Goals or
retries. Original result/cleanup recovery remains available.

The host command obtains the same host-manager lock used by Workers and the
project lock used by initialization. It inspects journals and all containers
using the volume, including stopped containers. A released process lock or an
expired server lease does not prove that an old sandbox stopped. Refuse pending
outboxes, unknown cleanup, native inspection and foreign volume users.

Create the SQLite backup into a fresh private staging directory. Verify it,
write and sync the manifest, then publish by an atomic directory rename. An
incomplete staging directory is never a valid backup. The server receives only
bounded immutable receipts and progress facts; paths and transfer credentials
stay on the operator host. Identical receipt replay is idempotent; contradictory
replay is a conflict.

A normal backup releases maintenance after the source receipt is recorded. A
migration keeps admission closed after backup and isolated restore. Explicit
administrator activation compares the original operation, epoch, active
location and accepted head, then switches once to the verified target location.
An old Worker must be rejected even when no task is currently ready. Older
protocols must not bypass the storage check. New work continues as a new Goal;
an old Goal's frozen pool cannot be rewritten to make a retry work elsewhere.

A migration may reuse a completed backup without contacting the old host. It
must still pass cold admission and exactly match the accepted-head revision,
candidate and complete candidate inventory. Placement changes do not invalidate
an otherwise current artifact: the new operation freezes the current epoch and
location for activation CAS, separately from the backup's original placement.
This allows recovery if a freshly activated destination is lost before another
backup can be made. The new operation
explicitly names the original backup operation and retains its receipt unchanged;
it does not pretend that the source has just performed another backup. The
restore receipt names the new operation and the actual original bundle digest.
A stale backup can be restored in isolation to retrieve files, but it cannot
silently replace a newer Room baseline.

Failure leaves the source Store and candidates intact. Cancellation may release
the control gate without activating a target. Restored volumes and incomplete
operations retain evidence for inspection; cleanup is an explicit operator
action, never an automatic volume prune.

## Operator workflow

Use the Room's **Storage and backups** panel to create a backup or migration.
Stop the source host's Worker manager before running the displayed command.
An active manager or any unsettled physical resource causes the command to
refuse maintenance. Keep the API server available; the CLI records its receipt
while it still holds the maintenance locks.

Configure private `.camp/storage-source.env` and `.camp/storage-target.env`
files on their respective hosts. The commands require these values:

```dotenv
CAMP_API_URL=http://127.0.0.1:13018
CAMP_WORKER_TOKEN=<Room worker credential supplied privately>
CAMP_RUNTIME_HOME=<existing source home, or an empty fresh target home>
CAMP_RUNTIME_IMAGE=sha256:<exact candidate image ID>
CAMP_TOOLCHAIN_BUNDLE=<verified original toolchain bundle directory>
CAMP_STORAGE_BUNDLE=<private local backup bundle directory>
```

Storage maintenance needs no model key. Resumable private transfer through the
API is documented in the [transport guide](./private-artifact-transfer.md).
The source and target select the same bundle content, toolchain digest and
image identity. Use the private artifact upload/download commands to move it through
the authenticated API, or retain a separately managed private transport. Local
bundle paths never enter API metadata or public snapshots.

```sh
node --env-file=.camp/storage-source.env packages/camp-runtime/scripts/storage.mjs backup --operation <operation UUID>
node --env-file=.camp/storage-target.env packages/camp-runtime/scripts/storage.mjs restore --operation <migration UUID>
```

If publication succeeded but its API acknowledgement was lost, the complete
bundle is the durable outbox. An administrator can use the prepared operation's
recovery command on another trusted host, even when the source runtime home is
gone. Configure `.camp/storage-recovery.env` with the same API, Room credential,
image, toolchain and bundle, and a separate private operator runtime home:

```sh
node --env-file=.camp/storage-recovery.env packages/camp-runtime/scripts/storage.mjs report-backup --operation <original backup operation UUID>
```

This command verifies the original manifest and complete SQLite history, then
resolves all frozen candidates through the native SDK in a disposable copy.
It reports the original snapshot receipt without changing the bundle or
pretending that the recovery host is the source storage location. It does not
restore a running project or activate a migration.

A completed ordinary backup can be selected as the source of a new migration
when it still matches the Room. The original source host is not required for
that restore. Review the destination receipt and activate it in the Room. Then
start a fresh Worker pool at the target home using the normal Worker setup;
verify the displayed active storage identity. New requirements continue from
the unchanged accepted candidate. Retain the source volume until the operator
decides to retire it.

For an isolated recovery drill, trusted host code may call
`restoreNativeStore({ runtime, plan, bundlePath })` without `postReceipt` using
the original frozen plan from the bundle. This installs a separate location and
does not change the control database or activate that location. The ordinary
CLI's restore action reports to an authorized migration operation.

The SQLite integrity and schema/row fingerprint checks prove that the complete
database history survived copying. Native checks resolve every declared ref
and root. They do not rehash the contents of every file in every undeclared
historical branch; acceptance also exports the accepted tree and executes new
work from that candidate.

## Dependency scheduling after storage

This boundary is implemented for protocol 5 in the [bounded graph contract](./bounded-dag.md); the limits and receipt semantics there are authoritative.

Use a new negotiated plan contract with bounded task keys and `dependsOnKeys`.
Store normalized nodes, edges and plan revision before acknowledging a plan.
Reject cycles, missing keys, cross-Goal edges, oversized graphs and changed
replays atomically. Start with two ready implementation nodes and one approved
input per node; keep role assignment, budget and resource policy on the trusted
side.

An edge pins the producer Run/epoch and exact candidate, not a mutable branch or
the latest task result. Single-parent nodes consume that candidate. Multi-parent
nodes require an explicit trusted integration operation with a frozen common
baseline, ordered parents, conflict policy and immutable output. Existing
one-integration-per-Goal constraints must change before enabling repeated fan-in;
adding a dependency array alone does not implement a DAG.

Plan revisions, cancellation, repair and integration inspection retain all
previous attempt facts. No downstream node becomes ready from a failed,
superseded or unverified parent. Reviews bind to the exact mounted input, and
finalization still compares the accepted-head revision.

## Multiple hosts after dependency scheduling

Do not share a mutable Disposable Store over NFS or between Linux kernels. Add a
private artifact transport with content hashes, bounded manifests, interrupted
transfer recovery and Room-scoped authorization. Existing attachment upload
authorization and quotas do not constitute a Camp backup artifact service.

Before multiple hosts can execute concurrently, introduce a negotiated contract
carrying authority ID, binding epoch, location, input artifact and required
capabilities through claim, journal, heartbeat, completion and acceptance. Every
output must have a durable verified location before a dependent task starts.
Use separate replicas or a supported LayerFS graph-transfer API; never assume
that matching image and project IDs imply that the input candidate exists.

Enable concurrent hosts only after proving candidate transfer and history
preservation across two actual hosts, stale-location fencing, crash-safe
outboxes, bounded transfer budgets and trusted fan-in of independent outputs.
Single-host tests of separate volumes establish isolated restoration, not that
two physical hosts have been validated.

## Acceptance evidence

Keep automated contract and race tests separate from real Docker/LayerFS
round-trips. The storage acceptance must include corrupted content, partial
publication, wrong image/toolchain, candidate-root mismatch, active resources,
changed receipt replay, activation CAS conflicts and rejection of the old
location. Verify file content and historical candidates after restoration and
perform fresh work from the preserved accepted baseline. Storage validation
requires no model request.

## Verified release evidence — 2026-10-23

The implementation passed 733 distinct automated checks:

| Boundary | Passed |
| --- | ---: |
| Shared protocol and DSH plugin | 41 |
| Smoke process supervision | 9 |
| Runtime, recovery and storage | 271 |
| Web DOM behavior | 176 |
| Server API and lifecycle regression | 229 |
| Camp on isolated real PostgreSQL databases | 5 |
| Canonical tasks on isolated real PostgreSQL databases | 2 |

TypeScript checks, affected-source lint, generated declarations, descriptor
freshness and configured-secret scanning also passed. Migration `0384` was
applied transactionally to the local service. Hashes of every existing Camp
Room, Goal, task, Run, event, plan, execution operation and finalization row were
unchanged; historical storage provenance was not fabricated.

Real API/PostgreSQL/Docker/LayerFS acceptance used synthetic role decisions and
made **zero model requests**. It created a new parallel-delivery fixture, backed
up its complete Store, injected a transport error before receipt submission, and made
the source runtime home unavailable. A separate operator home verified the
published bundle and reported the original receipt twice without altering it.
Corrupt content was rejected. Restoration used a fresh volume and home while
the original checkout was also unavailable.

After the first explicit activation, the destination home was made unavailable
before any new work or backup. The original artifact was restored again to
another fresh location and activated at epoch 3. Original receipts and all
four declared historical candidate identities remained intact. CAS conflicts,
activation replay, an idle intermediate location and older unpooled claims were
checked. A fresh two-lane pool then completed another full delivery from the
unchanged accepted baseline, preserving both candidate files.

`scripts/mvp/storage-real-smoke.mjs --real-infra` reproduces this sequence with
the selected pinned toolchain/image and a stopped host manager. Its ignored
local receipt is `.camp/storage-infra-latest.json`. The actual browser fixture
in `scripts/mvp/storage-ui-smoke.mjs` independently verified prepared backup,
receipt recovery guidance, explicit activation, bounded inventories, reuse
after relocation and read-only membership. That browser fixture does not
perform actual storage operations.

These tests used **one actual host**, separate runtime homes and independent
Docker volumes. They establish cold restoration and placement handoff, not
two-host transport, concurrent multi-host execution, PostgreSQL disaster
recovery or Disposable Store power-loss guarantees. Arbitrary dependency plans
remain disabled under the gates above.
