# Developing Camp

Camp is maintained at [rcyw/camp](https://github.com/rcyw/camp), as an independent
fork of [Raft](https://github.com/botiverse/raft-source).

## Working on a change

- Start a feature branch from `main` and keep each change focused.
- Describe the resulting behavior and the validation performed in your commit
  or pull request.
- Run checks relevant to the affected packages. For behavior changes, verify
  the corresponding login, messaging, task or Computer flow.
- Preserve the existing license and upstream copyright notices.

## Upstream changes

Keep `origin` pointed at `rcyw/camp` and `upstream` pointed at
`botiverse/raft-source`. Review and integrate upstream updates separately from
Camp customizations.

## Camp execution changes

Use the [serial workflow contract](docs/mvp/serial-room-workflow.md) and
[architecture boundaries](docs/mvp/architecture-review.md) when changing Camp
execution. For same-baseline plans, also follow the
[trusted integration contract](docs/mvp/trusted-integration.md). For parallel
pairs, follow the [bounded pool contract](docs/mvp/bounded-pair-execution.md). Keep task
ownership and lifecycle in the control side and trusted Worker, preserve
immutable candidate identities, and verify recovery and
protocol compatibility at the affected boundaries. The existing CLI-specific
rules remain in [packages/cli/AGENTS.md](packages/cli/AGENTS.md).

Upstream Raft is a release mirror with its own contribution policy. Camp
development takes place in this fork.

## Security

For vulnerabilities affecting upstream Raft, follow its policy retained in
[SECURITY.md](SECURITY.md). The contacts and support commitments there belong
to the upstream project. For Camp-specific changes, arrange private reporting
with the fork maintainer. Never post credentials or exploit details in a public
issue, pull request or discussion.

## License of contributions

Code in this repository remains licensed under [FSL-1.1-ALv2](LICENSE).
