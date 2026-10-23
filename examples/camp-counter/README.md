# First Camp project

Copy `project/` to a new working directory and use its absolute path in a Room.
It needs only Node and has three passing tests; no package installation or
network is required. The original directory is an import source, so accepted
results are exported to a separate directory.

Configure the project check as `["node", "--test"]`. A useful first goal is:

> Add `reset()` to the counter. It restores the initial value, returns that
> value, and preserves independent instances and existing behavior. Add tests,
> request review and deliver the result.

For fixed external acceptance, keep `verify-reset.mjs` outside the selected
project. Map it to a Worker harness, hash its contents and add a frozen check
`["node", "/camp-checks/reset"]` with that exact harness digest. See
[Worker deployment](../../docs/mvp/single-host-worker.md) for the mapping. This
check intentionally fails until the goal has implemented reset.

Normal project tests can be run from `project/` using `node --test`.
