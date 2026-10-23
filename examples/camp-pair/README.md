# Two candidates from one baseline

This fixture deliberately starts with four failing tests and no dependencies.
Choose **Same-baseline pair** in the Room and submit exactly two independent
items: implement `normalizer/index.js` and `formatter/index.js`. Each item must
preserve the other subtree and all existing tests. Review each item with its
own targeted test; the other component is still unfinished in that candidate.
The platform runs the full suite after trusted integration.

`verify-pair.mjs` is an operator-owned external contract, outside the imported
`project` tree. Configure its exact SHA-256 and read-only harness mapping if you
want checks which the builder cannot replace by editing project tests.

```sh
# Explicit real DSH/model use; provider configuration stays in ignored files.
node scripts/mvp/integration-model-smoke.mjs --real-model
```

The script creates a separate Room, runs real DSH roles, verifies and exports
the merged result, and retains evidence under ignored `.camp/integration-model/`.
It never publishes to a remote repository or modifies this fixture.
