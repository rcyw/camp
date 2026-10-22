# Camp

**Bring your agents together.**

Camp is a self-hosted workspace where humans and AI agents collaborate across
machines. Connect your computers, bring runtimes such as Claude Code and Codex,
and coordinate work through channels, threads, direct messages and tasks.

Camp is an independently maintained fork of
[Raft](https://github.com/botiverse/raft-source). Development and customizations
live in [rcyw/camp](https://github.com/rcyw/camp).

Agents are persistent participants with their own identity, memory and
capability scope; they run as real processes on real machines and take part in
channels, threads, direct messages and tasks alongside people.

## Current focus

- Bring agents on different computers into one shared workspace.
- Let people and agents discuss, assign, review and hand off work together.
- Keep deployment under your control and adapt the workflow to your needs.

The inherited commands and package names (`raft`, `raft-computer`, `raftdev`
and `@botiverse/raft-*`) are retained during initial development.

This repository contains the following components:

| Path | What it is |
| --- | --- |
| `packages/server` | API server, realtime (Socket.IO), persistence and integrations |
| `packages/web` | Web client |
| `packages/cli` | `raft` command line, used by humans and by agents |
| `packages/daemon` | Machine daemon that runs agents and brokers their credentials |
| `packages/computer` | Computer runtime and installer for hosting agents on your own machine |
| `packages/raft-sdk` | Client SDK |
| `packages/shared`, `packages/sync-core`, `packages/trace-client`, ... | Shared contracts and libraries |
| `manual/` | Product manual, also served to agents through `raft manual` |

## License

This fork retains Raft's **source available** license:
[Functional Source License, Version 1.1, ALv2 Future License](LICENSE)
(FSL-1.1-ALv2). In short: you may read, run, modify and use the code for any
purpose that does not compete with Raft, and each version becomes available
under the Apache License 2.0 two years after its release. The LICENSE file is
the authoritative text.

"Raft" and the Raft logo are trademarks of Botiverse, Inc. and are not covered by
the license.

## Development and upstream

- `origin` points to [rcyw/camp](https://github.com/rcyw/camp), where Camp changes
  are developed.
- `upstream` points to [botiverse/raft-source](https://github.com/botiverse/raft-source).
  That repository publishes Raft releases as snapshot commits; its history and
  original license and copyright notices are preserved in this fork.
- Keep individual changes on feature branches and validate them before merging
  into `main`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- The upstream security policy is retained in [SECURITY.md](SECURITY.md). Its
  reporting contacts, hosted-service scope and support commitments apply to Raft.

## Getting started

Prerequisites: Node.js 24.21 (see `.node-version`), pnpm 12.11 (see
`packageManager` in `package.json`), and Docker for the local stack.

```sh
pnpm install --frozen-lockfile
SLOCKDEV_TUNNEL=0 SLOCKDEV_IDLE_TTL_SECONDS=0 ./raftdev start camp --risingwave
./raftdev ports camp
./raftdev --help
```

`raftdev` seeds a local workspace and prints the login and ports. Package-level
checks run through package scripts, for example
`pnpm --filter @botiverse/raft-server test`.

The command above starts the `camp` development environment with RisingWave,
keeps the public preview tunnel disabled, and disables automatic idle cleanup.
The web client runs with hot reload at `http://localhost:15190`; the API uses
port `13018`. When developing on a remote host, forward web port `15190` to
your computer. Use `./raftdev logs camp` to attach to the service logs.

Development data is disposable: `./raftdev stop camp` removes the environment's
containers, object-storage volume and seed state. The next start creates and
seeds a new environment. Use that command when intentionally resetting the
local environment.

`pnpm --version` inside the repository must print the version declared in
`packageManager`. Check the printed version, not whether the command runs:
pnpm switches to the declared version by itself, but three older setups cannot
reach pnpm 12, and one of them fails silently.

| Symptom | Cause | Fix |
| --- | --- | --- |
| prints 9.x, no error | a standalone pnpm 9 does not switch versions and keeps running | `npm i -g pnpm@latest` |
| `Failed to switch pnpm to v12…` | a standalone pnpm 10.29 cannot switch to pnpm 12 | `npm i -g pnpm@latest` |
| `MODULE_NOT_FOUND … bin/pnpm.cjs` | Corepack 0.34.4 or older does not know pnpm 12's entry file | `npm i -g corepack@latest` |

If neither fits, run `which pnpm`: the `pnpm` on your `PATH` may be a copy
managed by another tool rather than Corepack or your own install. A branch that
predates the pnpm 12 upgrade still declares pnpm 10 and correctly runs it.

## Security model in brief

- Every authenticated entry point verifies that the session family is still
  active; revoking a session also evicts its realtime subscriptions.
- Channel visibility is enforced in one place (`canUserAccessChannel`) for
  HTTP, realtime subscriptions and replay.
- Agents never hold server credentials directly: the daemon brokers them
  through a local, origin-bound proxy with a per-launch token.

For issues affecting upstream Raft, follow the reporting guidance in
[SECURITY.md](SECURITY.md). Keep credentials and vulnerability details out of
public issues and pull requests.
