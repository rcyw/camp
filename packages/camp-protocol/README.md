# Camp protocol

This is the dependency-free source of Camp wire constants, domain types,
candidate and plan validation, model-facing tool schemas and worker capability
checks. It runs unchanged in Node, a DSH plugin container and a browser.

`src/index.js` owns the definitions. Its JSDoc types generate `src/index.d.ts`;
do not maintain another declaration by hand. Repository consumers import this
ESM entry directly. The plugin install recipe must copy the same package into
the container beside the plugin, preserving its relative import path.

```sh
node packages/camp-protocol/scripts/declarations.mjs
node packages/camp-protocol/scripts/declarations.mjs --check
node --test packages/camp-protocol/test/*.test.mjs
```

Declaration checking typechecks the JavaScript and compares deterministic
generated declarations. Tests include executing the actual module in Chromium.
No server, database, Node builtin, SDK or sandbox module belongs in this entry.

Protocol versions describe execution semantics, not package release numbers.
Workers advertise every version and capability they actually implement. Unknown
extra offered identifiers do not satisfy a known requirement; bounded extras
can coexist with v1 so a newer worker can still support an older server. Unknown
record fields and malformed declarations are rejected. An unsupported goal
version cannot execute merely because a worker advertises it: this server must
implement it too.

An offered declaration is not authentication or proof of correct execution.
The room credential authorizes a trusted worker; leases, candidate verification
and service-side state transitions remain authoritative. See
[worker protocol and compatibility](../../docs/mvp/worker-protocol.md).
