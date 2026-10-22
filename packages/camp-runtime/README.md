# Camp local sandbox runtime

This package is the trusted worker and LayerFS adapter for Camp rooms. It runs on one Linux storage host with local Docker. Each execution attempt gets a separate Docker container, LayerFS branch and DSH session. LayerFS's privileged filesystem daemon runs inside the container; DSH commands run as UID 501/GID 20. The Docker socket and room worker credential stay on the host.

The worker is a local source-package MVP, launched from the Camp repository root. It shares the daemon package's ACP client rather than implementing another agent engine.

## Prerequisites and build

Use Node 24+, the repository's pnpm dependencies, Linux `flock` and `setpriv` (util-linux), local Docker with `/dev/fuse`, and a checked-out LayerFS source tree with its SDK dependencies and Rust toolchain installed. This implementation was verified against LayerFS revision `5fb68ddc1acc3163e3ac3486133bde014c5fbed3` and official DSH `0.2.1-rc.2`.

From the Camp root:

```sh
export LAYERFS_SOURCE=/absolute/path/to/layerfs
# Ensure the LayerFS Cargo dependencies are available before the offline build.
cargo fetch --manifest-path "$LAYERFS_SOURCE/core/Cargo.toml" --locked
node packages/camp-runtime/scripts/build-layerfs.mjs
node packages/camp-runtime/scripts/build-image.mjs
npm install --prefix .camp/dsh --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.1-rc.2
node packages/camp-runtime/scripts/pack-dsh.mjs
```

`build-layerfs` builds the Native binding and daemon under this package's ignored `.local/` directory. It does not modify the LayerFS source tree. Set `CAMP_RUST_TOOLCHAIN` when selecting a named toolchain, and `CAMP_BUILD_JOBS` to control compile parallelism. The command has a 110-second bound; a timeout retains Cargo artifacts for a subsequent explicit invocation.

`build-image` defaults to `node:24-trixie`; `CAMP_BASE_IMAGE` selects an already available compatible base. Image metadata records the exact content ID in `.local/image.json`. Runtime records pin that ID; keep the original image available for existing projects and candidate verification.

The original verified local fallback image contained Node 24 and a minimal Linux userland, with DSH installed during preparation of each run. It did not contain npm or git. The optional `build-baked-image.mjs` / `Dockerfile.dsh` recipe prepares a separate image with DSH, the Camp plugin, npm and git. This recipe currently copies the host toolchain for local development; it requires matching Linux architecture and compatible libraries. Its generated `.local/baked-image.json` is separate from the original base image. Select the baked image explicitly with `CAMP_RUNTIME_IMAGE=sha256:...` for a **new** project, rather than changing the image under an existing project. Standardize the toolchain base before distributing an image to other machines.

The baked image has also been built and verified on this host (`camp-mvp-runtime:dsh-0.2.1-rc.2`). In an actual LayerFS sandbox at UID 501 it passed git init/local commit/read, npm offline execution of a Node test, and DSH Camp profile loading without a model call. See `.local/baked-image-verification.json`. This supplements the original real-model pipeline evidence; that pipeline continues to use its pinned original image.

## Connect a worker

Create a room in the channel's **Team runs / 团队执行** tab, then issue a room worker credential there. Save it in ignored `.camp/worker.env`, readable only by the current user:

```dotenv
CAMP_API_URL=http://127.0.0.1:13018
CAMP_WORKER_TOKEN=<room worker credential>
CAMP_WORKER_ID=camp-local
```

Save the model key in `.camp/runtime.env` and run:

```sh
chmod 600 .camp/worker.env .camp/runtime.env
node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
  --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs
```

`CAMP_WORKER_ONCE=1` exits when no ready task remains; omit it for a long-lived worker. The worker renews leases every eight seconds. Camp leases expire after 45 seconds. A role completion unlocks dependent tasks. A reviewer must record `camp_review` with an explicit verdict and evidence. A cancelled or stale attempt cannot settle a successful result.

Keep `CAMP_WORKER_ID`, `CAMP_API_URL` and `CAMP_RUNTIME_HOME` stable across restarts. The default ID is `camp-<hostname>` and the default home is this package's `.local/state/`. Choose a different explicit ID for each worker deployment. A kernel `flock` prevents two local processes from sharing one worker ID, including when they use different runtime homes. The lock releases after SIGKILL without deleting a stale PID file. It is a host-local lock; do not reuse one identity across independent hosts.

Workers in the same deployment must share `CAMP_RUNTIME_HOME`. First project initialization is serialized by a host lock keyed by the Docker socket's real path and project ID, independent of worker ID. A different runtime home that finds the existing project volume without its local project record fails closed; it never reimports over that Store. Preserve the shared home alongside its Docker volumes.

The host starts a per-run streaming model proxy. DSH receives a temporary proxy credential and the current run token; the real provider key and room worker token remain on the host. The proxy supports the installed DSH Messages protocol and fixed model endpoints, with a fixed upstream. It is closed when the run ends. Environment secrets are passed by named Docker environment variables, not embedded in command arguments.

## Journal, recovery and budgets

The worker persists its claim ID before sending a claim. The run token is derived with HMAC-SHA256 using the room worker credential and that claim ID; retries of an ambiguous claim keep both values. The server binds one claim ID to one attempt. A lost claim response therefore cannot allocate another attempt. Credential rotation while a claim remains ambiguous requires inspecting that claim; the worker stops on a claim conflict instead of changing its identity.

Worker records live under `<runtime-home>/workers/<hash-of-api-and-worker>/`. Each attempt keeps its original worker ID, epoch, runtime prefix, deadline and state. Writes use a private temporary file, file fsync, atomic rename and directory fsync. A journal write/read failure stops new claims. Files use mode 0600; the worker does not copy provider keys or room/run credential fields into the journal. Result text and session archives still contain user data and require appropriate access controls.

After the agent finishes and the candidate is committed, the complete result payload is saved as `result_staged` **before** releasing its sandbox. Dispatch requires confirmed cleanup. A restart first removes the attempt's own sandbox and then sends the identical saved payload. If the server committed the result but its HTTP response was lost, its existing terminal result can acknowledge the exact replay without another task or channel completion.

Startup queries the server's read-only run state. Only the journal's original worker/epoch can authorize completion. Expired or replaced attempts are cleaned and fenced; their old result is never submitted as a new completion. An independent `/cleanup` receipt confirms physical cleanup without changing the expired result. Active foreign owners are left alone. An executing attempt interrupted by process death is stopped, then reported as `worker_interrupted` only while its original lease is still valid. Caught model/business failures retain their own failure payload; budget exhaustion remains `run_budget_exhausted`. The server, rather than the worker, decides whether another bounded attempt is allowed.

If cancellation arrives after a successful result was staged, the original result remains immutable. Once server state confirms a live cancellation for the same worker/epoch and the sandbox is gone, a separate cancellation acknowledgement is persisted and sent. Lost cancellation responses replay this acknowledgement, never the old successful result. Cancellation cannot reverse a terminal completion.

Temporary API/network failures use bounded exponential polling backoff. Ambiguous claims retain the original claim ID; ambiguous completion responses retain the original outbox payload. A heartbeat failure stops active execution instead of running through an uncertain lease. Graceful shutdown drains its active heartbeat, progress request and model-budget journal writes before releasing the process lock. SIGKILL recovery happens when that worker next starts; this package is not an independent always-on host reaper.

| Environment variable | Default | Limit |
| --- | --- | --- |
| `CAMP_RUN_TIMEOUT_MS` | `900000` | Wall-clock duration of an attempt |
| `CAMP_MODEL_MAX_REQUESTS` | `64` | Requests through its model proxy |
| `CAMP_MODEL_REQUEST_TIMEOUT_MS` | `180000` | Duration of one upstream request |
| `CAMP_MODEL_MAX_REQUEST_BYTES` | `8388608` | Bytes in one request body |
| `CAMP_MODEL_MAX_INPUT_BYTES` | `67108864` | Total reserved request-body bytes |
| `CAMP_MODEL_MAX_RESPONSE_BYTES` | `67108864` | Total streamed response bytes |

All limits must be positive integers. Reservations are journaled before an upstream request is sent. Exceeding a limit aborts the run; it does not silently reset the budget in a new local loop. These are execution/request/byte limits, not a monetary or exact token-cost ceiling. Host/container CPU, memory, disk and egress quotas need separate deployment policy.

## Runtime interface

| Operation | Result |
| --- | --- |
| `ready()` | Validate native artifacts, image and local state directory |
| `prepareProject({projectId, sourcePath})` | Stage source and initialize or load a project Store; worker namespaces project IDs by Room ID |
| `prepareRun({project, runId, roleId, baseRef})` | Fork and mount an isolated attempt, returning a persisted runtime descriptor |
| `installDsh(run)` / `installPlugin(run, path)` | Prepare official DSH and the owned Camp profile before launching the agent |
| `launchSpec(run, {env})` | Docker ACP launcher using the sandbox workspace and non-root identity |
| `exec(run, command)` | Execute an ordinary command in that same mounted filesystem view |
| `commitCandidate(run)` | Return a LayerFS Commit/root/branch/image artifact |
| `archiveSession(run)` | Retain the DSH profile/session home outside the Store |
| `releaseRun(run)` / `abortRun(run)` | Release or stop the owned attempt; retain cleanup diagnostics |

Only the trusted worker can report infrastructure artifacts. The run token can report files and a reviewer verdict, but cannot forge a LayerFS candidate, claim tasks, renew a worker lease, or complete work.

## Source and filesystem semantics

The adapter imports a separate source staging directory. In a Git checkout it selects tracked files plus nonignored untracked files. Known credential homes, `.camp`, `.env*`, `.dev-env-*.json`, `.git` and `node_modules` are excluded. This is a known-path filter, not a general secret detector; use a source checkout appropriate for agent access. Existing source files are never changed by staging. File symlinks are copied as links rather than dereferenced.

Projects use LayerFS **Disposable** Store semantics, synchronous=OFF. All SDK processes and filesystem daemons share the same Linux kernel and local volume. The implementation does not support a mutable Store over NFS or across independent kernels. A filesystem Commit saves files, not live processes, memory, sockets or external side effects. Automatic publish is not part of this MVP. File artifacts in channel messages are references; they are not automatically exported to an independent artifact store.

Each run uses a separate SDK discovery home and container prefix so LayerFS workspace packing cannot place two Camp roles in one sandbox. Source selection, project Store, branch and candidate references are distinct from the role's persistent channel identity.

Reviewer approval also requires its final filesystem root to equal the inherited builder candidate root. A reviewer that edits the tree cannot approve that changed tree under the builder's identity. A changes-requested completion retains the original builder artifact so the next builder starts from that candidate, while the reviewer snapshot remains diagnostic.

## Verification and recovery limits

```sh
node --test packages/camp-runtime/scripts/*.test.mjs
node packages/camp-runtime/scripts/verify-layerfs.mjs
node packages/camp-runtime/scripts/verify-prepare-failure.mjs
node packages/camp-runtime/scripts/verify-worker-recovery.mjs
node packages/camp-runtime/scripts/verify-project-init.mjs
```

The first command checks claims, atomic journals, completion/cancellation replay, stale-epoch fencing, failure semantics, budgets, heartbeat shutdown and progress draining without a model key. The second uses actual Docker and LayerFS to prove separate sandboxes, non-root execution, no Docker socket, private Store, commit and fork/read. The third injects a post-mount failure and verifies preparation cleanup before a descriptor can return. The fourth SIGKILLs a worker with a real sandbox, proves the orphan exists, then recovers its journal, removes that sandbox and proves a different active worker survives. The real checks remove their execution containers and retain receipts under `.local/`.

The final command concurrently initializes one real project from two runtime instances, verifies one SDK initialization and a shared Store, then proves a separate runtime home is rejected without changing that Store.

Real-provider, browser and cancellation checks are documented in the [MVP guide](../../docs/mvp/README.md). They are explicit paid model operations rather than part of the default test suite.

Per-project/run metadata, candidates and session archives remain under the runtime home. The journal supports process-crash recovery; LayerFS still uses **Disposable** mode, so these checks do not establish filesystem durability across host power loss or disk failure. An uncertain native LayerFS operation is retained with `requiresInspection`; the worker stops rather than blindly retrying it. Preserve the journal and original image when investigating it. Do not globally prune Docker, delete an outbox, or reset the existing Camp database to recover one attempt.

DSH process/session restoration, proactive reaping while a worker remains offline, storage retention/garbage collection, resource quotas, egress policy and hardened multi-tenant isolation remain deployment work. A committed filesystem cannot undo already-performed external effects. A crash before a complete result is staged can still require another bounded agent attempt; the worker does not invent the missing result.
