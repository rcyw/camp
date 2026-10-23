# Two-host Worker handoff acceptance

This procedure moves one cold, accepted Room Store between two independent
Linux hosts. One location remains the writable authority. It does not enable
cross-host concurrent builders or import independent commit graphs.

The automated probe is deliberately separate from the one-host, two-daemon
storage test. It uses synthetic role decisions, real Docker/LayerFS sandboxes,
native integration, operator checks and the control API. It makes no provider
request and does not copy a model key. A passing run is not a real-model test.
The two-host acceptance below passed on 2026-10-23. Its scope and retained
evidence are recorded at the end of this guide.

## Prepare the destination

Use a private, operator-owned layout such as:

```text
/srv/camp/releases/<commit>/       immutable verified Worker release
/srv/camp/toolchains/<digest>/    immutable matching toolchain bundle
/srv/camp/state/<room>/           production Store and durable journals
/srv/camp/operations/<probe>/     credentials, probe overlay, restored state
```

Code upgrades must not relocate a production Store or its journals. The test
creates a fresh operation directory and never overwrites an existing target.
The source and destination use separate local Docker daemons and local disks.
Shared NFS storage and a remote Docker socket do not establish two-host handoff.

Build the release from a reviewed checkout with explicit deployment identities:

```sh
node packages/camp-runtime/scripts/build-worker-release.mjs \
  --output /private/build/camp-worker \
  --source-commit <full reviewed commit hash> \
  --toolchain-digest <verified toolchain SHA-256> \
  --image-id sha256:<exact image ID>
tar -cf camp-worker.tar -C /private/build/camp-worker .
sha256sum camp-worker.tar > camp-worker.tar.sha256
```

Distribute the archive checksum through a trusted channel independently of the
archive. Verify the release archive with the publisher's independently reviewed SHA-256
using the system `sha256sum` **before extraction or executing packaged code**.
Extract into an empty directory, then run the packaged inventory verifier with
the separately reviewed release-manifest SHA. Self-verification of an untrusted
archive is not source authentication:

```sh
sha256sum --check camp-worker.tar.sha256
mkdir /srv/camp/releases/<commit>
tar -xf camp-worker.tar -C /srv/camp/releases/<commit>
node /srv/camp/releases/<commit>/packages/camp-runtime/scripts/verify-worker-release.mjs \
  --release /srv/camp/releases/<commit> --manifest-sha256 <reviewed manifest SHA>
```

Install the exact source image by digest and the exact original toolchain.
The current Linux x64 bundle requires Node 24 with Node ABI 137 and glibc at
least 2.39; use its manifest as the authority. Docker must accept API 1.54,
`/dev/fuse` must be available, and the operator needs access to the local Docker
socket and Docker volume mountpoints. The current trusted host Worker normally
runs as root; role processes inside its sandboxes run as UID 501. This is not a
claim of an unprivileged host deployment.

The pure ESM release, toolchain and standard image need no external LayerFS/DSH
checkout, Rust build or package installation on the destination. Host tools are
Docker, Git, `flock`, `setpriv`, `prlimit`, `tar`, `diff` and coreutils `timeout`.
The probe keeps the default per-main-container limits: 2 CPU, 2 GiB and 256 PIDs.
Pool admission reserves its complete four-container envelope and host headroom;
a small VM must refuse admission rather than claim a smaller actual footprint.
Allow disk space for the image, chunks, assembled bundle, native Store and export.

## Private control connection

Prepare a known-host-verified SSH alias. Do not disable host-key checks or forward
an SSH agent. Keep the API listener on the source loopback interface. An operator
uses the checked tunnel helper in a separate foreground session:

```sh
node scripts/mvp/ssh-worker-tunnel.mjs --host camp-target \
  --local-api-port 13018 --remote-port 41318
```

The helper checks effective sshd policy before opening a forward, rejects
`GatewayPorts=yes`, and verifies the actual listener. Use the default sshd
configuration without command-line policy overrides and `UseDNS=no`; unsupported
or unverifiable policies fail closed. The destination additionally needs
`iproute2`'s `ss` command. The helper creates and owns the loopback reverse forward
and a narrowly bound relay from the Docker bridge gateway on the same port.
Its heartbeat removes the relay when the controller disappears. It does not
expose the Docker API or bind the API on a public interface.

The destination host uses `http://127.0.0.1:41318`; role containers use the bridge
relay. The probe performs an anonymous `/health` fetch inside
the actual nonroot role sandbox. It passes only the public API origin to that
probe, not the Room worker credential. Synthetic role API calls otherwise run
on the trusted host, so the explicit in-sandbox check is essential.

Keep the forward's port stable across reconnection: API URL is part of pool and
journal identity. Do not run this development tunnel as an unattended permanent
service. A production service needs a stable authenticated HTTPS control origin,
an independently provisioned Room credential and an operator-managed service unit.

Alternatively, set `CAMP_REMOTE_MANAGED_TUNNEL=1` for the acceptance controller
to create, own and finally close the same checked tunnel helper. Do not start the
separate foreground helper on that port in managed mode. The default remains an
externally managed tunnel, which the controller never closes or replaces.

## Run the explicit probe

Stop the source fixture's host manager first. Other unrelated containers remain
untouched. The destination must have no conflicting Camp host manager. From the
source checkout, configure only non-secret deployment locations:

```sh
export CAMP_REMOTE_SSH=camp-target
export CAMP_REMOTE_ROOT=/srv/camp/releases/<commit>
export CAMP_REMOTE_TOOLCHAIN_BUNDLE=/srv/camp/toolchains/<digest>
export CAMP_REMOTE_API_URL=http://127.0.0.1:41318
export CAMP_REMOTE_RELEASE_SHA256=<reviewed manifest SHA>
export CAMP_REMOTE_PROBE_ROOT=/srv/camp/operations
node scripts/mvp/two-host-storage-smoke.mjs --real-infra
```

`CAMP_API_URL` defaults to source `http://127.0.0.1:13018`.
`CAMP_TOOLCHAIN_BUNDLE` defaults to the local 0.7.0 DAG bundle, and
`CAMP_IMAGE_RECEIPT` to `.local/dag-image-0.7.0.json` in camp-runtime.
`CAMP_STORAGE_SOURCE_RECEIPT` can select an unused completed parallel fixture;
otherwise the script creates its own fixture using the local parallel probe.
Without `CAMP_REMOTE_PROBE_ROOT`, a private sibling `<release>.operations` is used.
SSH aliases and remote paths accept a deliberately restricted character set.
`CAMP_REMOTE_RELEASE_SHA256` is required; the target cannot substitute its own
current manifest digest for the independently reviewed one.

The controller retains human/API login credentials on the source. It mints
dedicated Room credentials and sends the target token only over encrypted SSH
stdin into an owned 0600 `worker-env.json`; it never appears in SSH argv or logs.
No `.dev-env` file, real model environment, source journal or pool identity is
copied. The remote probe overlay lives outside the immutable release. Its one
explicit `packages` link points to the verified release; the release itself is
checked before every target action and after execution.

The sequence backs up and uploads privately, freezes migration, proves distinct
machine/kernel/daemon hashes and absent source paths on the destination, then
downloads and restores there. It temporarily makes its own source home, checkout
and bundle unavailable. Every historical frozen reference/root and the whole
SQLite history must validate before activation. A corrupt remote bundle copy
must fail before a target receipt can be published. Activation tests stale CAS
and exact replay. Idle and ready claims from the old pool, including an unpooled
legacy attempt, must allocate no run or budget.

A fresh target pool then writes nonce-prefixed files, integrates and independently
verifies them, advances the accepted head and exports on the destination. The
new candidate and root must differ from the original. Both old files and the
new nonce files must exist. The probe checks enforced CPU/memory/PID limits,
two physically live builders, container API reachability, unchanged pre-existing
containers, wrong-Room credential refusal and explicit token revocation.

The success receipt is `.camp/two-host-storage-latest.json`; per-run evidence is
under `.camp/two-host/<run>/` and the remote operation directory. It records
`actualHostCount: 2` only after all identity and remote execution assertions.
These facts distinguish two independent OS hosts/VMs; they do not attest two
physical chassis without separate infrastructure evidence.

## Fault and recovery limits

The default automated interrupted-download case is a **request-hook fault after
a real downloaded part**, followed by the actual private-journal resume. Its
receipt explicitly says `realNetworkInterrupted: false`; it is not a network
partition test. To run an actual network outage case, set both flags:

```sh
export CAMP_REMOTE_MANAGED_TUNNEL=1
export CAMP_REMOTE_NETWORK_FAULT=1
node scripts/mvp/two-host-storage-smoke.mjs --real-infra
```

Both flags accept only `0` or `1`; a network fault requires managed mode. The
target confirms the first downloaded part was synced and renamed into its
private journal, records that part's hash and pauses before requesting the next
part. A separate SSH control session, with connection multiplexing disabled,
keeps stdin open. The controller waits for its owned API tunnel to close fully
before releasing the target gate. The next fetch must produce a real TCP
connection error; an ordinary exception or HTTP refusal cannot pass this case.
The target rechecks that the same partial bytes and manifest remain. Only then
does the controller reopen the tunnel on the same port and resume the same
operation, destination and artifact. It verifies normal complete hashes during
assembly and native restoration. It never mints a replacement operation to hide
a failed transfer. The receipt sets `realNetworkInterrupted: true` only when this
entire case runs; failed reconnect or unknown tunnel cleanup cannot publish PASS.
The native bundle's `manifestDigest` remains distinct from the resumed transport's
`transferManifestDigest`.

Target actions have independent hard deadlines. The pool child has a parent
death signal, verifies the expected parent and records PID plus Linux start time.
The controller stops only that exact owned process, never `pkill` or Docker prune.
Successful receipts require confirmed pool exit and remote credential removal.
On any failed acceptance, the failure receipt keeps physical cleanup unverified.
On SSH failure, keep the private operation and journals; cleanup is unknown until
the operator reconnects and verifies the owned process and resources. A lease
expiry or a stopped SSH client does not prove container cleanup.

Before enabling continuous use, execute the managed network-fault mode on the
actual two hosts, a target process kill with journal/outbox recovery, and native integration death
after durable intent. The last case must remain inspection-required, not merge
again automatically. An API failure stops an active Worker safely; this procedure
does not promise uninterrupted execution through a network partition. Preserve
uncertain Stores and journals and use the existing doctor/recovery tools. No
global cleanup command belongs in this acceptance procedure.

## Verified on 2026-10-23

The complete procedure passed between two independent Linux hosts, with
different machine, boot and Docker identities. The destination used the
standalone 63-file Worker release without a monorepo install, Node 24.21
(ABI 137), glibc 2.39 and Docker 29.6.2. Its 278-file toolchain inventory,
native addon and exact original image identity were verified before execution.

The run preserved all four frozen native candidates and the complete Store
history. It rejected a corrupted backup, checked activation CAS and replay,
advanced storage epoch from 1 to 2 without changing the accepted candidate,
and fenced both idle and ready old-location claims, including the legacy
unpooled bypass. A fresh destination pool then completed a nine-Run delivery
with two live builders, enforced resource limits, native integration, independent
verification and fresh final review. Export on the destination preserved the
original files and proved the new nonce files belonged to a different candidate
and file root. The accepted head advanced once, after the new delivery.

Managed connectivity was tested with a genuine outage: after the first part
was synced, the owned API tunnel was closed. The next target fetch failed with
`ECONNREFUSED` while the independent control SSH session stayed alive. Reconnection
at the same port resumed the same artifact and private journal. A separate
transfer-only run observed `UND_ERR_SOCKET` and verified every received file SHA.
Neither run injected an exception to stand in for that network failure.

Wrong-Room and revoked credentials were rejected. All test pools, tunnels and
credential files were stopped or removed before publishing success. The source
watcher and original standing pool were restored, preserving the original
Room's nine Runs, accepted head and storage identity. The destination's four
pre-existing containers retained their IDs and states. Stores, immutable
releases and operation evidence remain available; no permanent remote Worker
service was enabled by this development acceptance.

Retained local receipts are `.camp/two-host-storage-latest.json`,
`.camp/remote-deploy/installed-target.json` and
`.camp/remote-deploy/private-network-real.json`. All role decisions were
synthetic and model calls were zero. This establishes private cross-host Store
transport, native cold handoff and continued execution. Provider-backed DSH
execution on the destination, a network outage during a live Worker Run and
multi-host concurrent writers remain separate acceptance boundaries.

For continuous deployment, distribute fixed images through a private OCI
registry with cached base layers, keep the toolchain separately addressable by
digest, and use a stable HTTPS control origin with a provisioned Room credential.
Code upgrades must retain the active Store and journals. Keep one writable Room
authority and respect the current Docker-daemon/UID host-manager exclusion when
planning pool placement.
