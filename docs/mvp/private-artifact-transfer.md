# Private native Store transport and Worker handoff

Private transport moves the immutable three-file cold backup defined in
[storage lifecycle](./storage-lifecycle.md). It preserves the native Store
bytes and opaque discovery record. Transfer completion proves byte integrity;
only quarantined native restoration proves candidate reachability and history.

## Deployment and authority

Configure an absolute, owned, canonical directory in the API server:

```dotenv
CAMP_PRIVATE_ARTIFACT_DIR=/var/lib/camp/private-artifacts
```

Its permissions must be 0700; objects are 0600. It is a separate private
namespace, with no attachment route, public CDN or browser download URL. The
API's service account needs disk capacity for the declared quotas. This
version has a local filesystem backend behind an origin HTTP API; Workers on
other hosts do not mount that filesystem. Object storage is a future backend
adapter, not an assumption about the attachment bucket's confidentiality.

Every request requires a current Room worker credential and the exact storage
operation. A model Run token and an ordinary channel member cannot read raw
backups. Token revocation and Room membership/lifecycle are checked again at
mutation commit. Reused backups remain associated with their original native
receipt, independently of the current migration epoch or destination.

Remote operators use HTTPS. Local loopback HTTP is supported; a deliberate
private development network can set `CAMP_ALLOW_INSECURE_TRANSPORT=1`. API
origins cannot contain credentials, query strings or path prefixes. Redirects
are rejected. Worker/model secrets and transfer URLs are absent from durable
transfer state, public Room snapshots and progress events.

## Transfer contract

A manifest names exactly `manifest.json`, `project.record` and `store.sqlite`,
with complete file SHA-256, exact byte lengths and ordered 8-MiB part hashes.
It is canonicalized and hashed separately from the original native manifest.
The declared native manifest/Store hashes and Store length must match the
acknowledged backup receipt. The format is `camp-native-store-v1`.

The first transport supports a Store of up to 16 GiB, 512 KiB transfer
metadata, 64 GiB reserved artifact bytes per Room and two unfinished uploads.
These limits are distinct from the native backup adapter's larger Store limit.
Reservations debit quota under the Room lock before uploading. Network
streaming and filesystem writes do not hold the lifecycle lock.

| Trusted operator API | Result |
| --- | --- |
| `POST /api/camp/worker/storage-operations/:id/artifact` | Reserve or recover the same immutable transfer manifest |
| `GET /api/camp/worker/storage-operations/:id/artifact` | Bounded manifest, state and acknowledged part indexes |
| `PUT /api/camp/worker/storage-operations/:id/artifacts/:artifactId/parts/:index` | Exact binary length and SHA checked before immutable part acknowledgement |
| `POST /api/camp/worker/storage-operations/:id/artifacts/:artifactId/seal` | Verify every persisted part and complete file hash, then publish `ready` |
| `GET /api/camp/worker/storage-operations/:id/artifacts/:artifactId/parts/:index` | Read only a sealed, Room-authorized, hash-verified part |
| `DELETE /api/camp/worker/storage-operations/:id/artifacts/:artifactId` | Explicitly discard an unfinished transfer, retain the original backup receipt and an audit event |

The server chooses opaque object keys and syncs bytes before acknowledging
them. Concurrent identical upload replay cannot replace an acknowledged part.
Changed reservation replay is a conflict. ETags, file existence and HTTP 200
are not substitutes for content hashes. A complete backup can be downloaded
through a later explicit migration referencing its original backup operation.

Uploads recompute local hashes before reservation and verify each part again
when sending it. Resume asks for the same manifest and skips acknowledged
parts; a lost acknowledgement is recovered by the next explicit invocation.
Downloads use an exclusive destination lock and a private journal containing
only artifact identity and digest. Verify each resumed chunk, assemble all
three files, sync them and atomically rename the complete bundle. Interrupted
transfer directories are never valid bundles. Existing identical targets are
verified; different targets are not overwritten.

Sealed artifacts are retained. This release does not silently expire backups
or prune storage. Capacity planning and an explicit audited retention workflow
must precede long-running use at the Room quota. The backend can retain orphan
objects after an API-process crash between byte publication and SQL commit;
reconciliation must compare database object references before any removal.
An abandoned upload can be explicitly discarded with
`artifacts.mjs discard --operation <UUID>` to release its reservation. This
never deletes a sealed artifact or the native backup receipt.

## Operator sequence

Use the existing Room panel to prepare a backup. Stop the source manager and
create/acknowledge the cold backup. Keep credentials in private files, with
`CAMP_STORAGE_BUNDLE` selecting a different local path on each host:

```sh
node --env-file=.camp/storage-source.env packages/camp-runtime/scripts/storage.mjs backup --operation <backup UUID>
node --env-file=.camp/storage-source.env packages/camp-runtime/scripts/artifacts.mjs upload --operation <backup UUID>
```

Prepare a migration from that completed backup. On the destination:

```sh
node --env-file=.camp/storage-target.env packages/camp-runtime/scripts/artifacts.mjs download --operation <migration UUID>
node --env-file=.camp/storage-target.env packages/camp-runtime/scripts/storage.mjs restore --operation <migration UUID>
```

Restoration requires the exact original image/toolchain and an empty runtime
home. It checks SQLite integrity, full history fingerprint and every frozen
native reference/root before reporting a new physical storage identity. Review
the receipt and activate that migration in the Room. This increments binding
epoch without changing the accepted candidate. Start a fresh pool on the
destination; old storage identities remain fenced even when the Room is idle.
Do not copy the source pool's identity, journals or model environment into the
bundle. Model configuration for future execution is separate operator data.

Workers select their local Unix socket with `CAMP_DOCKER_SOCKET` (default
`/var/run/docker.sock`). They connect to the API over the configured origin;
there is no TCP Docker endpoint or shared mutable Store. The supervisor's
physical identity includes the actual daemon identity, separate from runtime
paths and logical project IDs.

## Cross-host release boundary

The supported execution design is one active writable authority per Room,
with cold handoff to a verified new location. The pinned LayerFS SDK has no
supported export/import of independent commit graphs. Two clones can retain
the starting IDs, but two independently written clones cannot yet combine
their histories through a supported native API. Consequently, cross-host
parallel graph execution stays disabled. Importing files would create a new
candidate with an explicit origin mapping and fresh review/verification; it
cannot masquerade as the original remote candidate.

Automated transfer tests and same-host independent storage/daemon exercises
are separate from a two-host acceptance. The latter requires independent Linux
kernels and disks: source backup/upload, destination with no source paths,
download/native restore, activation/new delivery, old-host rejection, plus
interrupted transfer, crash recovery, corrupt data, wrong Room and revoked
credentials. Record host count, daemon identities, image/toolchain hashes and
model usage. Do not describe same-host isolation as real two-host validation.

## Verified on 2026-10-23

The real storage acceptance passed over the private API between two distinct
Docker daemon identities on one physical host. No model request was made.
It covered lost backup/upload acknowledgements, an interrupted download,
resumed verified chunks, source bundle/home/checkout unavailability, native
restoration of all four frozen candidates and whole SQLite history, corrupt
bundle rejection and explicit activation CAS. The original artifact was reused
after loss of the first destination. A second verified location advanced the
binding to epoch 3; a fresh destination pool then completed another full
delivery from the preserved accepted head. Original and intermediate storage
identities, including legacy claim bypass, remained fenced.

Receipt: `.camp/storage-infra-latest.json`, with `privateApiTransport: true`,
distinct `sourceDaemonId`/`targetDaemonId` and `actualHostCount: 1`. The private
daemon was stopped after verification; its Store volumes and evidence remain
available. This establishes API transfer and independent daemon/storage
restoration. Two actual hosts, independent kernels and a real network failure
domain remain the next deployment acceptance.

Automated regressions cover Room/model/revoked credentials, changed manifests,
duplicate concurrent part acknowledgement, incomplete/corrupted sealing,
unpublished discard, HTTPS/origin/redirect restrictions, interruption recovery
and publication-before-cleanup crash recovery. A verified published bundle
cleans only a matching private transfer journal; unrelated state is preserved.
