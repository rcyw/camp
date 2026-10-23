# Persistent trusted Worker

`worker-service.mjs` installs one stopped, root-owned systemd pool service. It
uses a verified immutable Worker release and an existing toolchain/image. It
does not install Node or Docker, pull an image, issue a credential, configure a
registry, change firewall rules, or delete a Store. Complete the
[two-host deployment prerequisites](../../docs/mvp/two-host-worker.md) first.

Keep the deployment script outside the immutable release, for example under
`/data/github-projects/rcyw/camp/operations/deploy/`. Review its bytes before
running it. Use Node 24. All commands require root and an explicit private JSON
configuration. Configuration paths use canonical absolute ASCII paths containing
letters, digits, `/`, `.`, `_` or `-`; whitespace, symlinks in directories and
shell/systemd expansion characters are rejected.

Example `/etc/camp/worker-service.json` (0600, `/etc/camp` 0700):

```json
{
  "serviceName": "camp-worker-pool",
  "configDirectory": "/etc/camp/service",
  "nodePath": "/usr/bin/node",
  "releasePath": "/data/github-projects/rcyw/camp/releases/REVIEWED_RELEASE",
  "releaseManifestSha256": "REPLACE_WITH_REVIEWED_64_HEX_MANIFEST_SHA256",
  "toolchainPath": "/data/github-projects/rcyw/camp/toolchains/REVIEWED_TOOLCHAIN",
  "toolchainDigest": "REPLACE_WITH_REVIEWED_64_HEX_TOOLCHAIN_DIGEST",
  "imageId": "sha256:REPLACE_WITH_REVIEWED_64_HEX_IMAGE_ID",
  "apiOrigin": "https://8.217.75.234",
  "roomId": "REPLACE_WITH_ROOM_UUID",
  "workerId": "my-persistent-pool",
  "runtimeHome": "/data/github-projects/rcyw/camp/state/persistent-worker",
  "credentialFile": "/etc/camp/credential/worker.json",
  "controlCaFile": "/etc/camp/control-ca.crt",
  "modelEnvFile": "/etc/camp/model.env",
  "dockerSocket": "/var/run/docker.sock",
  "settings": {
    "CAMP_AGENT_CPU_MILLIS": 2000,
    "CAMP_AGENT_MEMORY_MIB": 2048,
    "CAMP_AGENT_PIDS_LIMIT": 256
  }
}
```

Create the runtime home as 0700 before checking. Supply the reviewed manifest
SHA from a trusted channel, not the archive's own unsigned manifest. `check`
validates the complete release inventory before executing packaged verification
code, Node 24, credential-file permissions and metadata, a currently valid public
CA, full toolchain bytes/ABI, exact local Docker image ID, and an existing pool's
API/Room/Worker identity. It performs no API calls and makes no allocations. The
Worker's own readiness checks still run after journal recovery.

The credential is the complete JSON response from the Room worker-token API:
`schemaVersion`, `token`, `tokenId`, `roomId`, `expiresAt`, `renewUntil`. Store it
as 0600 with a 0700 parent, no hardlinks or symlinks. Do not set
`CAMP_WORKER_TOKEN` in any environment file. The managed Worker renews the same
secret within the server's renewable window and absolute deadline, fsyncing
metadata. Revoke/expiry or the absolute renewal limit requires operator action;
do not change the secret while pending claim intents/outboxes need recovery.

Optional `modelEnvFile` is 0600 in a 0700 directory. Only single-line
`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `CAMP_DSH_MODEL` assignments are
accepted. No model key is rendered, copied into the unit or passed in argv.
Omit the file for a verification-only Worker. Optional `harnessManifest` selects
the operator harness manifest. Optional `dockerConfig` names an existing private
Docker credential directory; the installer never reads or prints its auth file.
Image distribution and Docker daemon private-CA trust are separate prerequisites.

The public control CA is sent to host Node through `NODE_EXTRA_CA_CERTS` and to
isolated role containers through `CAMP_CONTROL_CA_FILE`. The latter installs
only the public certificate in each run; no CA private key belongs on a Worker.
Use an HTTPS origin with no credentials, query, fragment or path. API spelling,
including explicit port/hostname case, remains stable to preserve journal keys.

```sh
node /path/to/worker-service.mjs render --config /etc/camp/worker-service.json
node /path/to/worker-service.mjs check --config /etc/camp/worker-service.json
node /path/to/worker-service.mjs install --config /etc/camp/worker-service.json
node /path/to/worker-service.mjs enable --config /etc/camp/worker-service.json
node /path/to/worker-service.mjs start --config /etc/camp/worker-service.json
node /path/to/worker-service.mjs status --config /etc/camp/worker-service.json
```

`install` does not enable or start the service. It refuses an active unit or an
unowned/modified existing unit. `service-install.json` and generated `worker.env`
are 0600. Operations verify that ownership record and only address the configured
unit. `start`, `restart` and `enable` also require the reviewed installed
configuration. `status` exposes only fixed systemd state properties; it does not
dump environment, credentials or task logs.

For a release upgrade, explicitly stop and wait for drain, retain the same API,
base Worker ID, Docker socket, runtime home and credential, update the reviewed
release fields, then run `check`, `install`, `start`. Never copy another host's
pool metadata/journals into this home. Stop and inspect a configuration mismatch
rather than delete it. The unit uses `PrivateTmp=no` so offline recovery and
service runs share the host-manager lock; Runtime still permits only one manager
per Docker daemon and Unix UID and refuses foreign physical resources. Host
manager locks, pool metadata, journals, outboxes and Store are retained across
restarts.

SIGTERM drains lanes and confirms cleanup before terminal completion. A process
crash restarts through recovery; ordinary nonzero/fatal exits remain failed for
inspection (`Restart=on-abnormal`, bounded systemd start rate). After 180 seconds
systemd may kill remaining host children; Docker-owned containers are outside the
service cgroup and must be recovered from the same journal before new claims.
Runtime's admission/cgroup checks own the two-attempt/four-container budget;
systemd process limits are not an aggregate limit for Docker containers.

`ReadWritePaths` includes the credential parent so atomic credential renewal
works under `ProtectSystem=full`. Use this directory only for the credential.
Never make the immutable release or toolchain writable to support rotation.

Use `stop` before offline reap, maintenance, backup or restore, and preserve any
inspection evidence. Do not globally prune Docker or remove journal records.
Concurrent installer actions are refused. An interrupted install may leave
`service-operation.lock` or a unit/environment/record mismatch; confirm no
installer is alive, inspect the exact private files, and explicitly repair them
before retrying. The installer never guesses ownership or removes that evidence.

The existing standalone `doctor` CLI does not automatically consume the managed
credential file. For an API doctor use `managedWorkerCredential` and pass its
returned environment/request to `inspectWorker`; do not materialize its token in
a unit or another env file. The service itself needs no pre-start API doctor.

`roomId` is required and becomes part of the permanent install identity. The
credential JSON must belong to that Room. `CAMP_WORKER_ROOM_ID` is also enforced
inside the managed Worker, including a direct `systemctl start`; replacing the
file with another Room's token cannot rebind the same Store. All secret/input
files must be distinct and cannot use generated `worker.env`,
`service-install.json` or `service-operation.lock` paths. The control CA must be
one pure PEM, current, self-signed root, as required by the isolated Sandbox.

Validation:

```sh
node --test scripts/deploy/worker-service.test.mjs
```
