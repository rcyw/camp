# Camp DSH role plugin

This original Cordis bundle gives one leased Camp role seven tools: `camp_read_context`, `camp_read_room`, `camp_send_message`, `camp_progress`, `camp_artifact`, `camp_handoff`, and `camp_review`. It uses the server's short-lived run credential. The supervisor alone claims tasks, renews leases, accepts final completion, and provisions roles. Handoff records a suggestion; it does not transfer ownership. The reviewer records a structured `review` artifact with explicit `approved` or `changes_requested`, summary, and evidence; the supervisor must use that value rather than guessing a verdict from prose.

`camp_review` reads the current server context and binds `artifact.candidate` to its authorized `reviewTarget` (`projectId` and `commitId`). These identifiers are not agent-selectable tool arguments. A missing review target rejects the tool without recording a verdict. The server must compare the candidate again when accepting the artifact and finalizing the review; a client-supplied identity alone is not proof of authorization. This requires the durable-goal server contract, while preserving the existing tool's outcome/summary/evidence arguments.

The bundle disables DSH's private subagent spawn/fork/control tools and workflow delegation, and adds a tool dispatch guard against accidentally re-enabling those tools. This is a platform composition policy; the outer sandbox remains responsible for OS process/network isolation.

## Install in a sandbox

Install a fixed official `@deepseek-ai/dsh` distribution with its `dsh-base` and `dsh-acp-app` packages, then copy this package to `/opt/camp-dsh-plugin`. No UNLICENSED Multica runtime or custom stdio protocol is used.

```sh
node /opt/camp-dsh-plugin/scripts/prepare-profile.mjs \
  --home /home/agent/.dsh \
  --node-modules /opt/camp-dsh/node_modules \
  --plugin /opt/camp-dsh-plugin
DSH_HOME=/home/agent/.dsh node /opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile camp
```

The assembler uses already-installed official packages and normal DSH profile/bundle loading. It performs no network requests and runs no agent. The sandbox user must own `DSH_HOME`; keep it across container replacement when native session resume is required.

The worker injects `CAMP_API_URL` (server origin reachable inside the sandbox), `CAMP_RUN_TOKEN`, `CAMP_RUN_ID`, `CAMP_RUN_EPOCH`, `CAMP_WORKER_ID`, and `CAMP_ROOM_ID`. Never inject `CAMP_WORKER_TOKEN`. Set the model provider credential through the separately configured DSH credential source. An expired run capability fails without retrying a mutation.

## Runtime integration

`@botiverse/raft-daemon/dsh-runtime` exports `createDshRuntimeSession(options)`. Options accept a complete `command`/`args` launcher, ACP workspace `cwd`, optional local launcher `processCwd` (for paths that exist only inside a container), an explicit child `env`, optional `sessionId`, `model` (`profile` preserves the configured default), `reasoningEffort`, `standingPrompt`, `handshakeTimeoutMs`, `cancelGraceMs`, `signal`, and `approvePermissions` (false by default).

Subscribe to `runtime_event` and `exit` before `start({text, sessionId?})`. Start negotiates official ACP v1, calls `session/new` or `session/resume`, selects only advertised model options, and submits the first prompt. It returns acceptance before the task finishes. Observe `text`, `thinking`, `tool_call`, `tool_output`, `error`, and `turn_end` events. ACP carries committed semantic updates rather than token deltas. Context occupancy is not fabricated into token billing.

`send({mode:'idle', text})` submits another prompt after `turn_end`. Busy sends return `busy_rejected`; the caller retains pending work. `stop()` sends `session/cancel`, waits a bounded time for `session/close`, then terminates the owned process group with TERM/KILL escalation. A missing resume session is reported rather than silently replacing task context. When the launcher is `docker exec`, the outer worker must also stop/remove the owned container: killing the local Docker client alone does not prove the remote process exited.

The existing Raft APM can use `DshDriver`, which wraps this same transport and prepares Raft's managed CLI/proxy. Camp's MVP worker owns its `task_runs`; do not run APM and the worker against the same task simultaneously.

Native daemon launch variables: `CAMP_DSH_COMMAND` (default `dsh`), `CAMP_DSH_ARGS_JSON` (argument prefix as JSON), `CAMP_DSH_PROFILE` (default `camp`), and `CAMP_DSH_PATCHES` (ordered JSON array of patch paths). Arguments are passed directly without a shell.

## Validation

`node --test packages/dsh-plugin/test/*.test.mjs` checks run authorization, fencing, routing, delegation policy, and offline profile assembly. Daemon `src/drivers/dshAcp.test.ts` drives a fake ACP child process through new/resume/model selection/events/busy rejection/cancel/forced kill and credential stripping. Neither suite calls a real model.
