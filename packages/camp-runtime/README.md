# Camp local sandbox runtime

This package is the trusted worker and LayerFS adapter for Camp rooms. It runs on one Linux storage host with local Docker. Agent attempts get separate Docker containers, LayerFS branches and DSH sessions. LayerFS's privileged filesystem daemon runs inside the agent container; DSH commands run as UID 501/GID 20. Roleless verification operations run without DSH in separate ordinary containers; trusted integration uses private LayerFS branches and full tree comparison without a model. The Docker socket and room worker credential stay on the host.

The worker currently launches from the Camp repository root on one local storage host. It shares the daemon package's ACP client rather than implementing another agent engine.

## Bounded two-lane pool (0.6.0)

For a `parallel_pair` goal, stop the serial worker and start one pool manager
on the same Linux host and with the same `CAMP_RUNTIME_HOME`, Room credential,
image, toolchain bundle and source configuration:

```sh
node --env-file=.camp/worker.env --import @oxc-node/core/register \
  packages/camp-runtime/scripts/worker-pool.mjs
```

The supervisor runs two ordinary serial Worker lanes in one Node process.
Each has a separate stable WorkerID, journal, Runtime instance, branch and
sandbox. Planner, builder and reviewer remain logical Room roles; the pool is
not another role scheduler. The server chooses work and freezes the pool's
identity and resource declaration. Standalone workers advertise protocols
1–3; only this manager advertises protocol 4 and `bounded-pair.v1`. An older
server cannot silently turn a pool request into serial parallel work.

`execution-pool.json` is private, atomically persisted and binds the original
API URL, base WorkerID, random pool/Store identities, Docker daemon ID and
resource configuration. Do not delete or regenerate it to bypass a mismatch.
Existing serial and lane outboxes are recovered before checking replacement
execution limits, including a first pool upgrade with invalid new limits.
Changing limits cannot rewrite the declaration or authorize a new claim for
an already pinned goal.
Both lane IDs survive process restarts. A daemon-and-Unix-user `flock` outside
the runtime home excludes another production manager, including a standalone
worker using another home. This is one manager per local host/user, not a
multi-host allocator. Operator calls that instantiate a Runtime directly, and
the export CLI, are maintenance operations outside the pool's admission
contract; stop the manager before running them.
The lock alone does not prove physical cleanup after SIGKILL. A standalone
worker also refuses new claims while any managed attempt container remains;
it leaves foreign resources for their original manager to recover.

Before either lane can allocate new work, the manager restores the original
base Worker journal and both lane journals. Pending intents use
`restoreOnly:true`, which can recover an existing binding but cannot allocate
a run or spend a budget. Exact old outboxes retain their original payload,
WorkerID and epoch, including older protocol metadata. A confirmed unbound
base-worker intent is retired during upgrade; lane intents remain reusable
after the barrier. Foreign pending journals, unknown containers, ownership
conflicts and operations requiring inspection block the pool. Recovery never
kills resources merely because their names resemble a different worker's.
Restoration first requires explicit version 4 server discovery. With an older
server and a pending intent, the worker can replay already recorded outboxes
but preserves the unresolved intent and stops, without sending a claim whose
unknown `restoreOnly` field might be ignored. With no pending intent, ordinary
version 1–3 serial execution remains supported.

The pool reserves at most two executing attempts and four Docker containers:
one main sandbox and one snapshot helper per lane. Helpers are counted and
checks remain serial within each verification operation. Default agent bounds
of 2 CPU, 2 GiB and 256 PIDs therefore reserve a worst-case total of 8 CPU,
8 GiB and 1024 PIDs. Host admission also requires 1 GiB memory headroom,
kernel/available cgroup PID headroom and the free-space floor plus 2 GiB for
bounded private snapshots. `CAMP_POOL_HOST_MEMORY_RESERVE_MIB` may change host
headroom (minimum 512 MiB); the existing `CAMP_AGENT_*` limits control the
lane policy. Smaller agent CPU/PID settings still reserve the fixed verifier
check bounds. Admission uses Docker host capacity and exact container cgroup
readback; it is not a Docker parent-cgroup hard limit for the supervisor or
trusted host tools. Other host workloads can still consume those resources.

The pinned LayerFS SDK has no creation-time CPU/memory/PID options. Container
creation is serialized through the shared guard, then Docker limits are
applied and read back before any agent code is installed or launched. The
trusted filesystem daemon has a short startup window before those limits;
this is a documented SDK limitation. Plain verification containers receive
limits directly in `docker create` and verify them after start.

A slot remains reserved until journaled cleanup and an actual empty owned
container prefix agree. Process exit, SIGKILL and lease expiry do not release
orphaned resources. Any lane fatal error, lock loss, unknown native outcome
or unconfirmed cleanup disables all new claims and stops both lanes; the
supervisor awaits their existing stop/cleanup/outbox paths before releasing
its locks. SIGTERM/SIGINT use this same drain path. `--once` runs until both
lanes report idle with zero active attempts; one idle lane cannot interrupt
its active sibling. Waiting for human clarification can legitimately leave
the pool idle and end this explicit one-shot invocation.

Relevant zero-model checks:

```sh
node --test packages/camp-runtime/scripts/worker-pool.test.mjs
node --test packages/camp-runtime/scripts/*.test.mjs
```

After stopping the manager, `scripts/verify-worker-pool.mjs --real` proves four
plain Docker orphans survive SIGKILL and disappear before another claim. Add
`--fail-after=1` or `--fail-after=3` to check partial startup cleanup. This helper
uses synthetic API responses and no model or LayerFS mutation; it complements
the separate real LayerFS workflow acceptance. Failure cleanup reads its
private fsynced journals after the owned child group has exited. An unresolved
Docker creation retains inspection evidence rather than claiming cleanup.

## Prerequisites and build

Use Linux with glibc, Node 24, the repository's pnpm dependencies, host Git,
`flock`, `setpriv`, `prlimit`, `tar`, `diff`, local Docker and `/dev/fuse`.
The host Node/native ABI and glibc build requirement are recorded in each bundle.
A bundle is local to its declared architecture and ABI; it is not a portable
binary for macOS or an arbitrary Linux distribution.

`toolchain.lock.json` fixes LayerFS revision
`5fb68ddc1acc3163e3ac3486133bde014c5fbed3`, Rust 1.99.0, DSH 0.2.1-rc.2,
the full DSH dependency lock and official Node 24.16.0 Trixie image digests for
amd64/arm64. Builds reject modified tracked LayerFS source, untracked or ignored
files in native source/configuration roots, a different Cargo lock/config,
external Rust flags and mismatched installed DSH versions. Ordinary workspace
target caches and documentation evidence are outside that source-input check.

From the Camp root, prepare the pinned checkout and Cargo dependencies, then:

```sh
export LAYERFS_SOURCE=/absolute/path/to/pinned-layerfs
cargo +1.99.0 fetch --manifest-path "$LAYERFS_SOURCE/core/Cargo.toml" --locked
node packages/camp-runtime/scripts/build-layerfs.mjs
node packages/camp-runtime/scripts/pack-dsh.mjs --install
node packages/camp-runtime/scripts/build-bundle.mjs
node packages/camp-runtime/scripts/build-image.mjs
```

Each command has a 110-second subprocess bound. A native timeout preserves
Cargo cache; repeat the explicit build. If a fresh npm installation times out,
retain its npm cache, remove only that incomplete build prefix and retry. Use
`CAMP_BUILD_JOBS` to select compile concurrency and `CAMP_NPM_OFFLINE=1` when all
locked npm tarballs are cached. npm lifecycle scripts are disabled. The build
needs an installed Rust 1.99.0 toolchain and the checkout's recorded Cargo flags;
it never edits the LayerFS checkout or shared Cargo registry.

Default new outputs are `.local/build/layerfs`, `.local/build/dsh`,
`.local/toolchain-bundle` and `.local/standard-image.json`. Existing output
bundles, build destinations and image tags are not replaced. Select fresh paths
with `CAMP_LAYERFS_OUTPUT`, `CAMP_DSH_PREFIX`, `CAMP_TOOLCHAIN_OUTPUT` and
`CAMP_RUNTIME_IMAGE_TAG`; `CAMP_LAYERFS_ARTIFACTS` selects the native build used
when bundling. `CAMP_LAYERFS_TARGET` controls the reusable Cargo cache.

The SDK JavaScript and package metadata are read from the pinned Git objects;
ignored, untracked or later changed worktree files cannot join that SDK bundle.
The bundle contains the SDK JavaScript, native binding, daemon, locked DSH
archive, Camp plugin/protocol archives, LayerFS/DSH/Camp licenses and Rust dependency
LICENSE/NOTICE files. DSH dependency notices remain in its complete archive. Its manifest records
every file's SHA-256, size and mode plus source inputs and host ABI. Runtime
verifies that inventory before new execution. This verifies artifact identity;
it does not provide a signature, remote attestation or a bit-for-bit reproducible
compiler result. Keep operator artifacts outside agent write authority.

The single standard Docker recipe starts from an exact official Node image
digest; Node, git, npm and their libraries come from that image. It installs the
locked DSH/plugin archives without network during Docker build. The former
host-executable/library copy recipe has been removed. `build-baked-image.mjs`
is an alias for the same standard recipe. Image receipts include the exact image
ID, base digest and bundle digest; neither the old `.local/image.json` nor any
existing image tag is changed. Select the new exact ID with
`CAMP_RUNTIME_IMAGE=sha256:...` for a new project. Existing projects keep their
recorded image.

After building, unset `LAYERFS_SOURCE` and set
`CAMP_TOOLCHAIN_BUNDLE=/absolute/path/to/toolchain-bundle`. Runtime then imports
its bundled SDK and no longer needs the original checkout. An explicitly set
`LAYERFS_SOURCE` retains the old development-checkout mode and old artifact
paths, unless a bundle is explicitly selected. Runtime's existing image default
remains `.local/image.json`; the new build receipt is selected explicitly.

## Local diagnostics

```sh
node --env-file=.camp/worker.env packages/camp-runtime/scripts/doctor.mjs --report
```

Doctor reads local platform, tools, private state-directory permissions, bundle
hashes/native ABI, Docker/FUSE, the selected image, static plugin descriptor,
harness mappings and source availability. It does not create a Store/container,
claim a run, execute project programs or call a model. The structured report
contains check IDs/status/codes, artifact identity and mode; paths, credentials
and arbitrary command output are excluded. A missing runtime home can pass as
creatable without being created. Explicit development-checkout mode is reported
as such and has no bundle digest.

`verify-toolchain-bundle.mjs` is the separate, explicitly invoked real Docker
proof. It uses its own project, private home and containers, verifies SDK/native
and daemon operation without the source checkout, exercises Node/npm/git and
DSH profile loading without a model, and removes only its own resources.
Existing project records and discovery files retain local absolute storage paths;
bundle relocation alone is not a Store backup or cross-host recovery procedure.

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
node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs init
node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
  packages/camp-runtime/scripts/doctor.mjs --report --require-agent
node --env-file=.camp/runtime.env --env-file=.camp/worker.env \
  --import @oxc-node/core/register packages/camp-runtime/src/worker.mjs
```

For a verification-only worker, omit the model environment file and start `node --env-file=.camp/worker.env packages/camp-runtime/src/worker.mjs`. Without `DEEPSEEK_API_KEY`, the worker offers trusted verification, plus trusted integration on a protocol 3 server; it does not read the DSH plugin, import the ACP driver, or require a model key to replay existing outboxes. A worker without model configuration needs protocol 2 or 3. It cannot advance agent tasks by itself.

`CAMP_WORKER_ONCE=1` exits when no ready task remains; omit it for a long-lived worker. The worker renews leases every eight seconds. Camp leases expire after 45 seconds. A reviewer must record `camp_review` with an explicit verdict and evidence. A cancelled or stale attempt cannot settle a successful result.

Keep `CAMP_WORKER_ID`, `CAMP_API_URL` and `CAMP_RUNTIME_HOME` stable across restarts. The default ID is `camp-<hostname>` and the default home is this package's `.local/state/`. Choose a different explicit ID for each worker deployment. A kernel `flock` prevents two local processes from sharing one worker ID, including when they use different runtime homes. The lock releases after SIGKILL without deleting a stale PID file. It is a host-local lock; do not reuse one identity across independent hosts.

Runtime homes and lock directories must be owned by the worker's host user, private (0700) and ordinary directories. Existing public or symlink homes are refused without changing their permissions. Host processes running as that same user remain inside the trusted boundary; this does not isolate mutually hostile host users sharing one account.

The same checks apply to every journal directory below the home. Ancestors must
be canonical paths without symlinks; journal JSON must be an owned private,
bounded regular file. An unsafe existing layout is preserved and refused,
without chmod, overwrite, API reconciliation or automatic cleanup.

Workers in the same deployment must share `CAMP_RUNTIME_HOME`. First project initialization is serialized by a host lock keyed by the Docker socket's real path and project ID, independent of worker ID. A different runtime home that finds the existing project volume without its local project record fails closed; it never reimports over that Store. Preserve the shared home alongside its Docker volumes.

The host starts a per-run streaming model proxy on the run container's local Docker gateway, independently of the Camp API's address. DSH receives a temporary proxy credential and the current run token; the real provider key and room worker token remain on the host. The proxy supports the installed DSH Messages protocol and fixed model endpoints, with a fixed upstream. It is closed when the run ends. Environment secrets are passed by named Docker environment variables, not embedded in command arguments.

## Protocol and capability negotiation

Worker `0.6.0` supports Camp protocols `1`–`4`. Only supervised pool lanes offer protocol 4; standalone Workers offer versions 1–3. Protocol 3 adds roleless trusted integration for an explicit same-baseline pair; default sequential goals retain protocol 2. See the [trusted integration guide](../../docs/mvp/trusted-integration.md) and [bounded pair contract](../../docs/mvp/bounded-pair-execution.md). Protocol 2 adds candidate diffs and roleless trusted verification to the six agent task kinds. Before allocating a claim the worker reads `/api/camp/worker/protocol`, selects a supported version and declares its actual task/reference/capability and installed harness support. A protocol 1 server receives the old six-kind/seven-capability declaration without v2 harness fields. A missing discovery endpoint, unknown version or missing capability for an offered task stops new allocation with a diagnostic. A specialized worker leaves known task kinds it does not offer for another worker and remains idle; with `CAMP_WORKER_ONCE=1` it exits normally. Missing harnesses or capabilities for its own task kind still require an operator correction. Every empty claim clears its unused intent.

When offering agent work, the actual `CAMP_DSH_PLUGIN` directory must contain a valid static `protocol.json` declaration. Preflight only reads that bounded JSON file, without executing plugin JavaScript on the host. Verification-only workers skip this agent check. The maintained declaration is generated from `packages/camp-protocol`:

```sh
node packages/dsh-plugin/scripts/protocol-descriptor.mjs
node packages/dsh-plugin/scripts/protocol-descriptor.mjs --check
```

The shared package supplies task/reference names, plan/candidate/report validation and all twelve model-facing tool schemas. Runtime installation and the baked-image recipe copy both the plugin and the dependency-free protocol source, to `/opt/camp-dsh-plugin` and `/opt/camp-protocol`. Their relative imports work without a host workspace symlink or package installation in the agent. The worker injects the run's selected `CAMP_PROTOCOL_VERSION` (`1`–`4`) with the run credential; plugin tools reject a missing or unsupported run protocol.

Each new run freezes its selected version, original offered declaration and exact task requirements in `workerProtocol`. The worker checks that snapshot against its explicit input and current capabilities before launching DSH. An old unversioned or unknown run can be retained and recovered, but is not interpreted as a new supported execution. Capability declarations detect old packages and deployment drift; they are self-reported compatibility data, not attestation or authority to bypass server permissions.

## Candidate differences and trusted verification

Protocol 2 builders report the goal's frozen baseline against their exact immutable output, rather than comparing a mutable room head. A trusted helper materializes both snapshots and compares file types, numeric modes, symlink targets and SHA-256 content. It uses the host's `diff` with literal argv for bounded UTF-8 text previews; it never runs project programs to generate a diff. Imported Layer references and saved Commits are both supported. Binary, deletion, type and permission changes remain explicit even when no text patch is available. A report retains at most 500 entries, 16 KiB per patch, 256 KiB total patches and 512 KiB total JSON; omission is marked as truncation. A complete empty report means no differences; a failed or missing report does not.

An operator configures and freezes the goal's verification policy through the Camp API/UI. Each check supplies literal `argv` and a timeout of at most 120 seconds. Model tools cannot choose or complete trusted verification operations. The worker reports actual check exit codes, signals, timeout/OOM observations and bounded stdout/stderr; the server derives pass/fail and enforces the delivery gate. Agent review evidence remains a separate claim from this trusted execution receipt.

For checks outside the candidate's control, configure a host mapping in an ignored file:

```json
[{"id":"delivery","path":"/absolute/operator-owned/delivery-check.mjs"}]
```

Set `CAMP_VERIFICATION_HARNESSES=/absolute/path/harnesses.json` on the worker. It reads regular files with `O_NOFOLLOW`, hashes their actual contents, and declares `{id,sha256}` before allocation. The frozen policy references that exact hash and invokes `/camp-checks/delivery`, for example `["node","/camp-checks/delivery"]`. The worker rechecks the hash before execution and mounts a private copy read-only. Missing or mismatched harnesses fail capability matching before allocation. Keep the mapping and harnesses operator-owned; the declaration is compatibility data, not remote attestation.

Each check starts in a **fresh** container from the candidate's pinned image and a fresh copy of that same candidate. A project test that edits files or starts background processes cannot change a later check's input. Checks run as UID 501, with no network, read-only image root, all capabilities dropped, `no-new-privileges`, one CPU, 512 MiB memory with equal swap limit, 128 processes, bounded tmpfs workspace and a combined 32 KiB output budget. The complete report also budgets JSON escaping across all checks: logs may be shortened and marked `outputTruncated`, while candidate, argv and exit facts remain intact. They receive no model or Camp credentials, Docker socket or LayerFS Store. Dependencies must already exist in the pinned image or candidate; verification cannot fetch them. A deadline or excessive output stops the whole check container; a separate client deadline prevents a disconnected Docker exec from blocking forever. Unconfirmed cleanup prevents a successful completion from being dispatched.

Trusted materialization preserves modes, including executable files and unreadable mode-000 files. Internal diff/verification can retain opaque absolute or escaping symlinks without following them on the host; the stricter public export rules below still reject those links. Special files and privilege-creating mode bits are unsupported. Metadata scans are capped at 20,000 entries and materialized bytes at 512 MiB. All auxiliary snapshot and check containers belong to the run's recorded prefix before creation, so recovery can remove them after SIGKILL without affecting another worker's live resources.

After confirming those containers are gone, cleanup removes only the attempt's named diff/verification materializations, their sidecars and private harness copies. It validates directory boundaries without following symlinks. Auxiliary cleanup cannot collect an active parent's scratch. Intent/result receipts, journals, source candidates, session archives and unknown files remain for audit; a cleanup receipt does not mean every local runtime file was deleted. Retention and overall host disk capacity still need operator policy.

Recovery precedes new-execution checks. Existing journals can clean owned sandboxes and replay their original outbox even if discovery is unsupported or a new provider key/budget configuration is unavailable. Recovery does not add capability fields to an immutable completion or recompute its digest. An ambiguous claim is only resent after successful negotiation; otherwise it is reconciled through read-only state without allocating another run.

## Ordered plans, questions and immutable inputs

The server schedules a serial goal as `plan` → each ordered `build` and `review` pair → trusted `verification` (protocol 2) → `final_review` → `summary`. Whole-goal repair in protocol 2 repeats trusted verification. A failed item review can return the current item to the builder. The planner records 1–5 actionable items through `camp_submit_plan`; the final summary must durably record `camp_finalize`. Missing plans, verdicts, finalization or clarification answers fail the attempt instead of accepting prose as evidence. The server owns ordering, retries and goal budgets.

Every claim supplies one explicit `inputCandidate` and `baseRef`. The worker never chooses a parent from model artifacts or dependency order, and rejects ambiguous parents or a mismatched reference. Only the initial plan may receive a null input with `baseRef=main`; before DSH starts the worker records that mounted immutable baseline. Candidates explicitly identify `refKind: layer|commit` and `refId`: a Layer has a `32` prefix, a Commit has a `12` prefix, and both also bind project, root and exact image identity. An unchanged initial project can remain a real immutable Layer; no marker files or fake empty Commits are created. Output candidates bind their actual input reference.

Only `build` may change the workspace root. Planning, reviews including changes requested, final acceptance, summaries and clarification must preserve their supplied root. Before snapshotting, the worker stops ACP, then a trusted root process stops and waits for UID 501 processes in that attempt's private container. This also stops background agent commands while leaving the root LayerFS daemon available to capture the filesystem. It does not undo network requests or other external side effects already performed.

After quiescence, session evidence is streamed to a fresh private archive with a 32 MiB, 5,000-entry and 30-second limit. Host files/directories use 0600/0700. Symlinks and special entries are omitted, never created on the host, and the durable `session-archive.json` receipt records truncation; ordinary profile links therefore do not discard the real session files. Failed or oversized transport removes its fresh partial archive and records the error without invalidating the candidate or rewriting its outbox. A durable receipt write failure still stops execution, like other journal failures.

A durable current-run pending question causes `suspended` settlement with the partial candidate and question ID. While a model is executing, each successful heartbeat is followed by a context check; the trusted worker ends DSH even if the model keeps waiting. It waits for process quiescence and confirms the live lease before capturing the candidate. Cancellation and lease loss take priority. The server releases the lease, schedules clarification or waits for a human, and later starts a new fenced attempt from that saved candidate. A clarification that durably answers or escalates is also ended by the worker, so waiting for a human cannot occupy the sole worker. Suspension uses the same immutable journal/outbox and exact replay as other results. Its summary names the recipient and question; clarification summaries contain the answer or escalation reason.

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

All limits must be positive integers. Reservations are journaled before an upstream request is sent. Exceeding a limit aborts the run; it does not silently reset the budget in a new local loop. These are execution/request/byte limits, not a monetary or exact token-cost ceiling. Agent CPU, memory and PID bounds are enforced before agent launch by the host resource policy; disk and egress hard quotas remain deployment work; independent verification containers apply the fixed bounds described above. Verification-only workers use the run deadline without requiring valid provider budget settings.

## Runtime interface

| Operation | Result |
| --- | --- |
| `ready()` | Validate native artifacts, image and local state directory |
| `prepareProject({projectId, sourcePath})` | Stage source and initialize or load a project Store; worker namespaces project IDs by Room ID |
| `prepareRun({project, runId, roleId, baseRef})` | Fork and mount an isolated attempt, returning a persisted runtime descriptor |
| `installDsh(run)` / `installPlugin(run, path)` | Prepare official DSH and the owned Camp profile before launching the agent |
| `launchSpec(run, {env})` | Docker ACP launcher using the sandbox workspace and non-root identity |
| `exec(run, command)` | Execute an ordinary command in that same mounted filesystem view |
| `pinInputCandidate(run, candidate)` | Verify and record the immutable mounted input before DSH starts |
| `quiesceAgent(run)` | Stop agent processes only in the current attempt's private container |
| `commitCandidate(run)` | Return a tagged immutable Layer or Commit with root/branch/image identity |
| `archiveSession(run)` | Retain the DSH profile/session home outside the Store |
| `releaseRun(run)` / `abortRun(run)` | Release or stop the owned attempt; retain cleanup diagnostics |

Only the trusted worker can report infrastructure artifacts. The run token can report files and a reviewer verdict, but cannot forge a LayerFS candidate, claim tasks, renew a worker lease, or complete work.

## Source and filesystem semantics

The adapter imports a fresh, separate source staging directory, bounded to 512 MiB and 20,000 total directories/files/links, including the root. Preparation and waiting for a project lock follow cancellation. In a Git checkout it selects tracked files plus untracked files permitted by repository exclusions; an empty selection stays empty, and a corrupt index fails closed. Only confirmed non-Git directories or explicitly selected ignored fixture directories use the directory fallback. Git runs without inherited credentials, host global/system configuration, executable filesystem monitors or a pager, with a 10-second command deadline and process memory/CPU limits. Known credential homes, `.camp`, `.env*`, `.dev-env-*.json`, `.git` and `node_modules` are excluded. This is a known-path filter, not a general secret detector; use a source checkout appropriate for agent access. Existing source files are never changed by staging. Linux directory descriptors anchor each source parent without following symlinks; regular-file opens reject symlink and FIFO replacements. File symlinks are copied as links rather than dereferenced. Failed staging removes only its fresh partial seed.

Projects use LayerFS **Disposable** Store semantics, synchronous=OFF. All SDK processes and filesystem daemons share the same Linux kernel and local volume. The implementation does not support a mutable Store over NFS or across independent kernels. A filesystem Commit saves files, not live processes, memory, sockets or external side effects. Automatic publish is not part of this MVP. File artifacts in channel messages are references; they are not automatically exported to an independent artifact store.

Each run uses a separate SDK discovery home and container prefix so LayerFS workspace packing cannot place two Camp roles in one sandbox. Source selection, project Store, branch and candidate references are distinct from the role's persistent channel identity.

Reviewers must preserve the server's explicit input candidate root for either verdict. Their diagnostic file reports cannot replace that input. The next builder receives its authoritative parent from the server.

## Export a final result

Download a ready goal result manifest through the authenticated Camp UI/API, then export on the Linux storage host using the original runtime home and image:

```sh
node packages/camp-runtime/scripts/export.mjs \
  --manifest /absolute/path/result.json --output /absolute/path/new-output-directory
```

Use `--archive /absolute/path/new-result.tar` instead of `--output` for a tar file. To fetch the result directly with the room worker credential in the environment:

```sh
node --env-file=.camp/worker.env packages/camp-runtime/scripts/export.mjs \
  --goal GOAL_UUID --output /absolute/path/new-output-directory
```

A local manifest is user-provided input, not a signed document. The CLI validates its shape and verifies the selected immutable reference/root against this host's recorded project Store and image. API-fetched manifests additionally use authenticated, room-scoped access. A manifest cannot override the local project mapping or redirect export to another room's project. Trusted local operators may also provide `--project PROJECT_ID --commit COMMIT_ID --root ROOT_ID` or `--project PROJECT_ID --layer LAYER_ID --root ROOT_ID`; this mode grants no remote authority.

The destination must be new, with a canonical existing parent, outside runtime state and the original source checkout. Export never patches or overwrites that checkout. It materializes a complete snapshot: a file deleted in the candidate is absent from the exported tree. File/directory modes and binary contents are preserved; safe relative symlinks remain links. Absolute/escaping links, special files, setuid/setgid bits, malformed paths and cross-project/root mismatches are rejected. Directory export does not preserve owner IDs, hardlink identity or timestamps. A validated tar uses numeric owner/group zero. A sidecar `<destination>.manifest.json` records the verified candidate and export counts.

Export starts a dedicated short-lived LayerFS sandbox without DSH, provider keys, run credentials or runtime-home mounts. It executes trusted streaming code, never code imported from the workspace. `CAMP_EXPORT_TIMEOUT_MS` defaults to 120000 and covers the operation; on timeout only that export attempt is stopped, and partial owned outputs are removed. Uncertain native LayerFS outcomes retain their diagnostics and are not blindly retried. Known-path import filtering does not detect arbitrary secrets in user source: exported candidates contain the selected workspace files, so choose and review source accordingly.

## Verification and recovery limits

```sh
node --test packages/camp-runtime/scripts/*.test.mjs
node packages/camp-runtime/scripts/verify-layerfs.mjs
node packages/camp-runtime/scripts/verify-prepare-failure.mjs
node packages/camp-runtime/scripts/verify-worker-recovery.mjs
node packages/camp-runtime/scripts/verify-project-init.mjs
node packages/camp-runtime/scripts/verify-input-policy.mjs
node packages/camp-runtime/scripts/verify-export.mjs
node packages/camp-runtime/scripts/verify-agent-quiescence.mjs
node packages/camp-runtime/scripts/verify-protocol-package.mjs
node packages/camp-runtime/scripts/verify-change-set.mjs
node packages/camp-runtime/scripts/verify-trusted-verification.mjs
node packages/camp-runtime/scripts/verify-verification-recovery.mjs
```

The first command checks claims, atomic journals, completion/cancellation replay, stale-epoch fencing, failure semantics, budgets, heartbeat shutdown and progress draining without a model key. The second uses actual Docker and LayerFS to prove separate sandboxes, non-root execution, no Docker socket, private Store, commit and fork/read. The third injects a post-mount failure and verifies preparation cleanup before a descriptor can return. The fourth SIGKILLs a worker with a real sandbox, proves the orphan exists, then recovers its journal, removes that sandbox and proves a different active worker survives. The real checks remove their execution containers and retain receipts under `.local/`.

`verify-project-init` concurrently initializes one real project from two runtime instances, verifies one SDK initialization and a shared Store, then proves a separate runtime home is rejected without changing that Store.

The input-policy proof covers the initial planner guard, explicit parent identity, legal unchanged Layer candidates and partial-build suspension. Export verifies a directory and tar roundtrip with binary data, mode 0751, links and deletions, rejects unsafe references/links, and interrupts a real stalled snapshot stream within its deadline. The quiescence proof starts a detached UID 501 writer in an actual sandbox, stops it, verifies writes cease and commits through the surviving filesystem daemon. These checks make no model calls. Receipts are `.local/input-policy-proof.json`, `.local/export-roundtrip.json` and `.local/agent-quiescence.json`.

The protocol packaging proof installs the shared source and plugin into a real sandbox, imports them as UID 501, compares all twelve registered schemas and the static descriptor, then loads the actual DSH profile without prompting a model. Its receipt is `.local/protocol-packaging.json`.

The new diff proof compares a real Layer baseline to a modified Commit, including binary/mode/deletion/symlink changes, then compares that Layer to itself. Trusted verification proves a project-controlled first check cannot contaminate the next hash-pinned external harness, verifies no network/credentials/Store, preserves modes, and exercises timeout, output and memory limits. On the verified Docker host, the 512 MiB memory probe returns exit 137 with `oomKilled:true`; other runtimes may expose an ambiguous nonzero exit rather than an exact OOM cause, which still fails the gate. Verification recovery SIGKILLs a process with both a real ordinary check container and an owned LayerFS auxiliary container, removes both on restart, leaves another worker alive, and submits no stale result. Receipts are `.local/change-set.json`, `.local/trusted-verification.json` and `.local/verification-sigkill-recovery.json`. These proofs do not call a model.

Real-provider, browser and cancellation checks are documented in the [MVP guide](../../docs/mvp/README.md). They are explicit paid model operations rather than part of the default test suite.

Per-project/run metadata, candidates and session archives remain under the runtime home. The journal supports process-crash recovery; LayerFS still uses **Disposable** mode, so these checks do not establish filesystem durability across host power loss or disk failure. An uncertain native LayerFS operation is retained with `requiresInspection`; the worker stops rather than blindly retrying it. Preserve the journal and original image when investigating it. Do not globally prune Docker, delete an outbox, or reset the existing Camp database to recover one attempt.

Offline `worker-ops.mjs reap` defaults to a read-only report; explicit `--apply` locks the worker identity and cleans only journal-owned attempts without API access, preserving exact outboxes. See the [single-host operations guide](../../docs/mvp/single-host-worker.md) for setup, resource bounds and recovery. DSH process/session restoration, an unattended offline reaper, storage retention/garbage collection, disk quotas, egress policy and hardened multi-tenant isolation remain deployment work. A committed filesystem cannot undo already-performed external effects. A crash before a complete result is staged can still require another bounded agent attempt; the worker does not invent the missing result.
