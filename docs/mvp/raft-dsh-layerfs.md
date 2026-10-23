# Camp MVP: Room collaboration with DSH and LayerFS

This document retains the initial fixed-pipeline MVP design and validation. The
current ordered planning, questions, item review/rework, final acceptance and
result continuation contract is documented in [serial room delivery](./serial-room-workflow.md).

## Goal and scope

One channel is the shared work room. A human describes an outcome; planner, builder and reviewer identities discuss and execute the work, report progress in the channel, and hand off through persisted tasks. DSH is the only new execution engine. LayerFS provides a branch and immutable candidate reference for each execution attempt.

The first deployment uses one Linux storage host, Docker, the existing Camp server/web/PostgreSQL/RisingWave stack, and a trusted worker. Each role executes in a separate sandbox. The existing development environment and its data are retained. Existing Raft runtimes remain available for old agents during the MVP; Camp rooms use DSH exclusively.

## Reuse and changes

| Area | Reuse | MVP addition or change |
| --- | --- | --- |
| Identity and authorization | Sessions, server membership, channel access, agent identities | Room-scoped configuration and worker credentials; role-specific posting |
| Collaboration | Channels, messages, tasks, realtime delivery, existing history | Room execution panel; structured progress; no broadcast model wake on progress |
| Task ownership | Task revisions and atomic claim | Persistent execution attempts, dependencies, lease epochs and worker fencing |
| Runtime | RuntimeSession lifecycle and event vocabulary | DSH ACP client/driver and a reusable portable session launcher |
| Agent tools | Cordis tools and DSH profiles | Camp context, progress and artifact tools using short-lived run credentials |
| Execution | Docker on the storage host | Trusted worker, per-attempt sandbox lifecycle, bounded cancellation |
| Files | LayerFS SDK and its actual daemon/FUSE implementation | Prepare project, fork/mount attempt, commit candidate, retain references, release workspace |
| Development | Existing raftdev environment and seed accounts | Local setup, worker commands, real integration smoke and browser checks |

Broad deletion of inherited code is deferred until the replacement flow is verified. Obsolete code introduced by this implementation is removed in the same change; upstream migrations, licenses and unrelated features are preserved.

## Ownership

| State | Owner |
| --- | --- |
| Channel, room, task, dependencies, identity, authorization | Camp server |
| Claim, run epoch, lease, terminal result | Camp server, updated by the trusted worker |
| Sandbox, ACP transport, process termination, cleanup | Trusted worker |
| Model loop, session log, tool execution | DSH |
| Branch, workspace overlay, committed filesystem state | LayerFS |
| UI status and channel progress | Projections of persisted server/worker facts |

The runtime driver and the Camp worker share one ACP transport implementation. A Camp-managed role must not simultaneously be driven by the inherited agent-process manager. Role identities used for Camp execution are externally managed by the Camp worker. Native DSH driver support is available for the inherited Computer path, but is a separate launch mode.

## Object model

- A room binds one channel, one project and role definitions.
- A role is a stable channel participant with instructions and a bounded execution capability.
- A task describes work, target role, dependencies and acceptance context; inherited task records remain the user-visible work items.
- A run is one attempt with task ID, worker ID, increasing epoch, lease expiry, DSH session ID, candidate references and terminal state.
- A LayerFS branch belongs to an attempt, rather than permanently to a role. A later attempt must not reuse an active old attempt's writable branch.
- A sandbox is execution infrastructure. Its lifetime does not define the lifetime of a role or task.

Initially a goal follows planner → builder → reviewer. Dependencies unlock the next role without human message forwarding. Explicit role tasks can be added independently. Reviewer feedback and cancellation remain explicit outcomes; a transport EOF or a final assistant sentence is not sufficient proof of successful execution.

## Collaboration and wake policy

The channel retains normal conversation. Room progress is persisted and displayed under the corresponding role identity without triggering every inherited runtime. A structured goal creates the task pipeline; only ready tasks are claimable. Human goal submission creates work, and completing dependencies unlocks subsequent work. Explicit role handoff tools record suggestions and context; they do not themselves create a new task or transfer a lease. Routine tool progress only updates the room.

Each role has at most one active run in the MVP. The worker claims ready work transactionally. The LLM does not own heartbeat timing, worker credentials, container creation or final lease confirmation. Camp profiles disable DSH child-agent orchestration for platform roles; collaboration happens through room tasks and messages.

## HTTP interfaces

Browser routes are session-authenticated, server-scoped and channel-access checked:

| Method | Route | Purpose |
| --- | --- | --- |
| GET / POST | `/api/camp/rooms` | List rooms / bind a channel and create role identities |
| GET | `/api/camp/rooms/:roomId` | Room, tasks, attempts and progress |
| POST | `/api/camp/rooms/:roomId/tasks` | Submit a goal or a role-specific dependent task |
| POST | `/api/camp/rooms/:roomId/worker-token` | Issue a room-scoped worker credential, displayed once |
| POST | `/api/camp/rooms/:roomId/runs/:runId/cancel` | Request cancellation without pretending the process stopped |

Trusted worker routes use a room-scoped bearer token, stored hashed on the server:

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/camp/worker/claim` | Atomically claim ready work and obtain an execution epoch |
| POST | `/api/camp/worker/runs/:runId/heartbeat` | Renew the lease / observe cancellation |
| POST | `/api/camp/worker/runs/:runId/events` | Persist progress or candidate artifacts |
| POST | `/api/camp/worker/runs/:runId/complete` | Settle the current attempt |
| GET | `/api/camp/worker/runs/:runId/context` | Return only the authorized run's task, room context and dependency results |

Run mutations carry `workerId` and `epoch`. An expired, cancelled or superseded attempt cannot submit a valid final result. A short-lived run credential permits the DSH plugin to read its context and report progress/artifacts; it must not permit claiming another task, renewing worker leases or completing an attempt. The long-lived worker credential stays outside the agent sandbox.

The implementation's exported request/response types are authoritative for exact field names. Errors distinguish invalid input, denied access, missing resource, stale epoch/lease and unavailable execution infrastructure.

## DSH integration

DSH launches through its supported ACP profile plus an owned Camp bundle/patch. The ACP client performs `initialize`, `session/new` or `session/resume`, advertised model configuration, `session/prompt`, `session/cancel` and `session/close`. DSH does not implement `session/load`. ACP emits committed semantic updates, not raw provider token deltas.

The portable RuntimeSession accepts command/args/cwd/env, so the worker can launch it through `docker exec -i` inside the selected sandbox. Its start returns admission; terminal events drive completion. Busy input is queued by the owner or explicitly rejected, never silently treated as supported steering.

The Camp DSH plugin provides context/progress/artifact operations. It never receives the room worker token. Profile composition explicitly configures the approval policy so unattended runs cannot hang on an unhandled prompt. Task capabilities remain enforced by the server, regardless of prompt instructions.

## LayerFS integration

The adapter exposes project preparation, run preparation, candidate commit and run release. The run descriptor includes project, branch, sandbox/container, workspace path and image identity. A candidate is identified by a tagged immutable Layer or Commit plus its file root and fixed image. Initial imports and unchanged results can remain Layers; changes after validation require a new candidate and validation result.

LayerFS Store access is in the trusted SDK process on the same Linux host and local filesystem as its daemons. No shared mutable SQLite Store over NFS or across independent kernels is promised. The filesystem daemon's mount privileges and the DSH command identity must remain separate. Docker socket and global worker credentials are not mounted into the DSH environment.

The existing LayerFS JS placement packs multiple Workspaces per sandbox. The Camp adapter must explicitly arrange isolated execution placement rather than treating separate paths as separate sandboxes. Filesystem read/write and command execution refer to the same mounted view.

The current supported Store profile is Disposable/WAL/synchronous=OFF. Camp task/run records live in PostgreSQL and DSH session archives are retained outside the Store. Authorized result manifests and explicit local export to a new directory or tar archive are implemented; automatic independent artifact backup and retention remain future work. A filesystem commit is not a process, memory, socket or external-service checkpoint. LayerFS `publish` is not automatically a merge, approval or test gate; raw publication is reserved for a future trusted integration operation with explicit current-head checks. Current candidate Diff and independent verification behavior is documented in [delivery evidence](./delivery-evidence.md).

## Failure and cancellation

1. Claim and run creation occur atomically. Repeated claim requests cannot create two active attempts for one task.
2. Heartbeats are owned by the worker, independently of model activity.
3. Lease expiry invalidates the epoch. Old workers cannot finalize or hand off newer attempts.
4. Cancellation transitions through a requested/cancelling state until the worker has stopped DSH and released its resources.
5. ACP cancellation precedes bounded termination; a process that does not quiesce is terminated with its sandbox.
6. LayerFS operations with an unknown outcome are inspected rather than blindly replayed.
7. Completion is idempotent for the same run, worker, epoch and semantic result, including message and successor-task effects. Ordinary progress events are append-only; callers do not blindly retry an ambiguous mutation.
8. Only completed dependencies unlock successors; failures and cancellation remain visible and block dependent work.

## Implementation order and acceptance

| Step | Deliverable | Acceptance |
| --- | --- | --- |
| 1 | Room/role/task/run persistence and authenticated API | Concurrent claim, stale epoch, access denial and dependency tests |
| 2 | Portable ACP transport, native DSH driver, Camp plugin | Fake peer covers resume, configuration, semantic events, cancellation and transport loss |
| 3 | Real LayerFS/Docker adapter and worker | Fork, isolated mount, ordinary command, commit, remount/read, release |
| 4 | Channel room panel and goal submission | Browser creates a room, submits a goal and observes role/run progress |
| 5 | Integrated worker flow | Planner → builder → reviewer; dependency outputs and candidate references visible |
| 6 | Real model smoke | Same flow through installed DSH and user-configured provider; report actual result separately from fixtures |

Tests must distinguish actual DSH, actual LayerFS and actual Docker from stand-ins. The default regression suite never needs a real API key. Real-provider verification is explicit and uses ignored `.camp/runtime.env`; credentials and bearer tokens must not appear in logs, reports, screenshots or tracked files.

## Local operations

The existing Camp UI is `http://localhost:15190`; API is `http://localhost:13018`. Do not run `raftdev stop camp` to restart code: it deletes disposable development data. The server and Vite watcher should reload source changes; targeted process restart is used only if required.

Runtime files, installed DSH, local tokens and generated artifacts belong under ignored `.camp/` or package `.local/`. The implementation and validation commands are recorded in the completion section after they actually run.

## Deferred scope

Multi-host shared LayerFS Store, arbitrary provider/runtime compatibility, semantic conflict resolution, durable filesystem guarantees, automatic external deployment, autonomous permission expansion and a full replacement of Raft's messaging pipeline are outside this MVP. These exclusions do not weaken task fencing, channel authorization or sandbox cleanup in the supported flow.

## Validation record

The following checks ran on 2026-10-22 in the existing Camp development environment.

| Check | Command / evidence | Observed result |
| --- | --- | --- |
| Actual provider credential | Official DSH `0.2.1-rc.2`, `--profile headless`, a single requested response, env from `.camp/runtime.env` | Returned `CAMP_DSH_READY`, exit 0 |
| Actual Docker + LayerFS | `node packages/camp-runtime/scripts/verify-layerfs.mjs`; package `.local/verify-receipt.json` | Three independent sandboxes; isolation, non-root command execution, candidate commit, fork/read and cleanup passed |
| Actual channel submission | `node scripts/mvp/prepare-demo.mjs --skip-submit` then `node scripts/mvp/browser-smoke.mjs --submit` | Authenticated Chromium submitted `/camp` through the existing composer; server created three dependent tasks |
| Actual role execution | Worker launched with `.camp/runtime.env` and `.camp/mvp-worker.env`; `.camp/mvp-validation.json` | Planner reproduced failure and wrote PLAN.md; builder changed subtraction to addition and passed tests; independent reviewer inspected and re-ran tests, recording structured `approved` with evidence |
| Candidate | Builder commit `1272256d9601a9b7b5699336bfdd36d4307a220ac8019a6e7aa0329f30e8c69a78` | Reviewer inherited the exact candidate and produced the same filesystem Commit |
| Actual cancellation | `node scripts/mvp/cancel-smoke.mjs`; `.camp/mvp-cancel-receipt.json` | Real DSH reported its readiness through the plugin; browser Stop button requested cancellation; worker confirmed cleanup and server settled cancelled; probe worker exited with code 1 as designed |
| Independent filesystem verification | `.camp/mvp-filesystem-verification.json` | Fresh candidate sandbox passed the test and returned `add(7,5)=12`; fresh `main` sandbox failed; host source matched unchanged `main`; both inspection sandboxes were released |
| Preparation failure cleanup | `node packages/camp-runtime/scripts/verify-prepare-failure.mjs`; runtime `.local/prepare-failure-receipt.json` | Injected failure after an actual LayerFS mount and before descriptor return; only that attempt's container prefix was cleaned; remaining containers: 0 |
| Preinstalled sandbox image | Runtime `.local/baked-image-verification.json` and `.local/baked-image.json` | Separate optional image with DSH `0.2.1-rc.2`, Camp plugin, Node 24.16, npm 11.13 and git 2.43; actual LayerFS sandbox passed local git commit/read, offline npm/Node test and DSH profile load; no model call |
| Browser rendering | `node scripts/mvp/browser-smoke.mjs`; `.camp/mvp-room.png` | Three role cards, goal input, queue, results and progress rendered without a page exception or Camp API alert |
| ACP regression | Daemon `dshAcp.test.ts` | 10 fake-peer tests passed; no provider calls |
| Plugin regression | `node --test packages/dsh-plugin/test/*.test.mjs` | 5 tests passed; offline profile assembly and structured review included |
| Runtime regression | `node --test packages/camp-runtime/scripts/worker.test.mjs packages/camp-runtime/scripts/model-proxy.test.mjs packages/camp-runtime/scripts/source-snapshot.test.mjs packages/camp-runtime/scripts/cleanup-accounting.test.mjs` | 12 tests passed; lease loss, cancellation, Unicode progress, malformed claims, Messages streaming adapter, source selection, nested staging, identical-payload completion replay, rejection, unknown outcome and uncertain cleanup accounting |
| API and route regression | `pnpm --filter @botiverse/raft-server exec vitest run src/routes/camp.test.ts src/test/routeAuthorityClassification.structure.test.ts` | 6 tests passed: 3 Camp API integrations against PGlite with actual app/auth and 3 route-authority checks; includes rollback, member/admin permission scope, forbidden infrastructure artifacts, leases, review, token revocation and settlement replay |
| PostgreSQL concurrency | `CAMP_REAL_PG_REQUIRED=1` plus privately configured `CAMP_REAL_PG_URL`, server Vitest `src/services/camp/camp.realPg.test.ts` | 1 real PostgreSQL test passed using a separate temporary database; concurrent claim and epoch recovery each have one winner |
| Composer regression | Web Vitest `packages/web/tests/campCommand.test.ts` | 3 tests passed; ordinary messages, multiline goals and empty commands |
| Composer DOM regression | Existing `messageInputDoubleSubmit.behavior.test.tsx` suite | 65 tests passed, including 3 Camp cases for failed-send draft/retry, missing room without creating a thread, and ordinary messages avoiding the Camp API |
| Type and lint checks | Server, daemon, web and plugin package checks; targeted web oxlint, i18n literals and color tokens | Passed after review changes |
| Credential scan | Configured secret values compared in memory against changed/untracked, nonignored source files | No credential matches; `.camp/` and package `.local/` are ignored |

The real-model integration used a locally built Ubuntu + Node 24 fallback image. It had no npm or git binary, so the fixture deliberately used Node's built-in test runner without dependency installation. A separate baked DSH/npm/git image was subsequently built and verified without a model call; the original project's pinned image was retained. These checks establish the stated fixture and toolchain flows, not support for arbitrary repositories or dependency stacks. Changing a project's image requires a new project snapshot and validation.

Current execution recovery fences stale results and creates a new attempt after an expired lease. Automatic reconciliation of containers orphaned by worker `SIGKILL`, a persisted completion retry outbox, review-round budgets and multi-host placement remain later work. Retained `run.json`, candidate and cleanup receipts support diagnosis; they are not a completed recovery controller. Agent progress and tests are evidence reported by the execution, not a claim that arbitrary hostile code is securely verified.
