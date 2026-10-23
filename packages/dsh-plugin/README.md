# Camp DSH role plugin

This original Cordis bundle gives one leased Camp role scoped collaboration tools. Version `0.6.0` supports agent runs using Camp protocol `1`, `2`, `3` or `4`. Its declaration includes only model task kinds; roleless verification and integration belong to the trusted Worker. It uses the server's short-lived run credential. The supervisor alone claims tasks, renews leases, accepts final completion, and provisions roles. Handoff records a suggestion; it does not transfer ownership. The reviewer records a structured `review` artifact with explicit `approved` or `changes_requested`, summary, and evidence; the supervisor must use that value rather than guessing a verdict from prose.

| Tools | Purpose |
| --- | --- |
| `camp_read_context`, `camp_read_room` | Read the current task, ordered plan, questions, evidence and recent conversation. |
| `camp_progress`, `camp_artifact` | Report actual milestones, files and verification evidence. |
| `camp_send_message`, `camp_handoff` | Post a directed room note or a handoff suggestion without scheduling another agent. |
| `camp_submit_plan` | Submit one ordered plan of one to five implementation tasks, each with explicit acceptance and verification. Only the current planner plan task may submit it. |
| `camp_ask_question` | Record a durable blocking question, then finish the current turn so the worker can save the candidate and schedule its recipient. |
| `camp_answer_question`, `camp_escalate_question` | Resolve an assigned clarification or request a human decision without holding the worker idle. |
| `camp_review` | Record an explicit verdict for the server-authorized immutable candidate. |
| `camp_finalize` | Record the final delivery summary, actual evidence and limitations after final acceptance. The server binds the final candidate. |

For serial goals, the server supplies `taskKind`. Planning, clarification, review, final acceptance and summary preserve the project files. Development executes only the current item. A text plan or a text claim of completion cannot replace accepted `camp_submit_plan` or `camp_finalize` records. Retrying an identical plan or finalization is idempotent on the server; this client does not automatically replay a lost mutation response.

Blocking questions release execution rather than polling for a second role: submit the question, stop editing, finish the turn, and let the trusted worker save and suspend the task. A later run continues from the saved candidate with the answer in its context. Ordinary progress and room notes never create a wakeup. The server owns routing, eligibility and attempt fencing.

Protocol 2 also schedules roleless trusted verification, executed directly by the worker without DSH or a run token. This plugin cannot select its policy, claim it or forge its receipt. Agent test output and reviewer evidence remain separate from the server's trusted verification result. Inspect the durable context when reporting delivery; a model's prose claim cannot bypass a failed or missing verification gate. Build diffs are produced by the trusted worker against the goal's frozen baseline, rather than submitted through an agent artifact tool.

`camp_review` reads the current server context and binds `artifact.candidate` to its authorized `reviewTarget`: `projectId`, `refKind` and immutable `refId`. A Commit has a matching `commitId` alias; an imported Layer has a matching `layerId` and no invented Commit. This also permits read-only delivery when the source already satisfies the requirement. Legacy commit-only targets remain supported. These identifiers are not agent-selectable tool arguments. A missing or inconsistent review target rejects the tool without recording a verdict. The server compares the identity again when accepting the artifact and finalizing the review; a client-supplied identity alone is not proof of authorization.

The bundle disables DSH's private subagent spawn/fork/control tools and workflow delegation, and adds a tool dispatch guard against accidentally re-enabling those tools. This is a platform composition policy; the outer sandbox remains responsible for OS process/network isolation.

## Install in a sandbox

Install a fixed official `@deepseek-ai/dsh` distribution with its `dsh-base` and `dsh-acp-app` packages, then copy this package, including `protocol.json`, to `/opt/camp-dsh-plugin`. Also copy the dependency-free `packages/camp-protocol` package to `/opt/camp-protocol`; the relative source imports must resolve inside the sandbox. Camp's runtime installer and baked-image recipe include both packages. No UNLICENSED Multica runtime or custom stdio protocol is used.

```sh
node /opt/camp-dsh-plugin/scripts/prepare-profile.mjs \
  --home /home/agent/.dsh \
  --node-modules /opt/camp-dsh/node_modules \
  --plugin /opt/camp-dsh-plugin
DSH_HOME=/home/agent/.dsh node /opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile camp
```

The assembler uses already-installed official packages and normal DSH profile/bundle loading. It performs no network requests and runs no agent. The sandbox user must own `DSH_HOME`; keep it across container replacement when native session resume is required.

The worker injects `CAMP_API_URL` (server origin reachable inside the sandbox), `CAMP_RUN_TOKEN`, `CAMP_RUN_ID`, `CAMP_RUN_EPOCH`, `CAMP_WORKER_ID`, `CAMP_ROOM_ID` and the selected `CAMP_PROTOCOL_VERSION` (`1`, `2`, `3` or `4`). Never inject `CAMP_WORKER_TOKEN`. Set the model provider credential through the separately configured DSH credential source. An expired run capability or unsupported protocol fails without retrying a mutation.

`packages/camp-protocol` defines the model-facing tool schemas and plan validation. The static `protocol.json` declares this bundle's implemented capabilities; the supervisor reads it from the actual configured plugin directory before claiming work. This check executes no selected plugin JavaScript on the host. Regenerate the declaration with `node packages/dsh-plugin/scripts/protocol-descriptor.mjs`, and verify it with the same command plus `--check`. Offline profile assembly also checks that declaration against its source. Compatibility declarations detect stale or incomplete deployments; they do not replace sandbox isolation or server authorization.

## Runtime integration

`@botiverse/raft-daemon/dsh-runtime` exports `createDshRuntimeSession(options)`. Options accept a complete `command`/`args` launcher, ACP workspace `cwd`, optional local launcher `processCwd` (for paths that exist only inside a container), an explicit child `env`, optional `sessionId`, `model` (`profile` preserves the configured default), `reasoningEffort`, `standingPrompt`, `handshakeTimeoutMs`, `cancelGraceMs`, `signal`, and `approvePermissions` (false by default).

Subscribe to `runtime_event` and `exit` before `start({text, sessionId?})`. Start negotiates official ACP v1, calls `session/new` or `session/resume`, selects only advertised model options, and submits the first prompt. It returns acceptance before the task finishes. Observe `text`, `thinking`, `tool_call`, `tool_output`, `error`, and `turn_end` events. ACP carries committed semantic updates rather than token deltas. Context occupancy is not fabricated into token billing.

`send({mode:'idle', text})` submits another prompt after `turn_end`. Busy sends return `busy_rejected`; the caller retains pending work. `stop()` sends `session/cancel`, waits a bounded time for `session/close`, then terminates the owned process group with TERM/KILL escalation. A missing resume session is reported rather than silently replacing task context. When the launcher is `docker exec`, the outer worker must also stop/remove the owned container: killing the local Docker client alone does not prove the remote process exited.

The existing Raft APM can use `DshDriver`, which wraps this same transport and prepares Raft's managed CLI/proxy. Camp's MVP worker owns its `task_runs`; do not run APM and the worker against the same task simultaneously.

Native daemon launch variables: `CAMP_DSH_COMMAND` (default `dsh`), `CAMP_DSH_ARGS_JSON` (argument prefix as JSON), `CAMP_DSH_PROFILE` (default `camp`), and `CAMP_DSH_PATCHES` (ordered JSON array of patch paths). Arguments are passed directly without a shell.

## Validation

`node --test packages/dsh-plugin/test/*.test.mjs` checks run authorization, fencing, routing, delegation policy, and offline profile assembly. Daemon `src/drivers/dshAcp.test.ts` drives a fake ACP child process through new/resume/model selection/events/busy rejection/cancel/forced kill and credential stripping. Neither suite calls a real model.
