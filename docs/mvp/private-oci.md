# Private OCI image distribution

Camp distributes the fixed sandbox image through a private OCI repository.
The Worker release and the native toolchain bundle remain separate verified
artifacts. A registry image contains the baked DSH runtime and Camp plugin; it
does not contain a Room credential, provider key, Worker journal or LayerFS Store.

## Preserve both identities

An OCI registry manifest digest and Docker's local image ID are separate facts.
Docker versions and image stores can expose a configuration or index identity
as `.Id`. Publishing an image does not establish that the registry digest equals
that identity. A deployment receipt records both, plus the toolchain digest.

The receiving host pulls `repository@sha256:<64 hex>` and then checks Docker's
actual `.Id` and `camp.toolchain.digest` label against the reviewed deployment.
A mismatch stops deployment. It never changes a project's recorded image,
rewrites a candidate or silently accepts an equivalent rebuilt image. The
normal Runtime also verifies the separate toolchain bundle's complete inventory
and native ABI before execution; checking the image label does not replace that.

## Dedicated authentication

Provision a dedicated Docker config outside the checkout, owned by the service
operator: directory mode `0700`, `config.json` mode `0600`, no symlinks or shared
hardlinks. Use an existing credential helper or `docker login --password-stdin`
with the registry's independently provisioned credentials. Do not put passwords
in arguments, shell history, source files, receipts or service environment files.
Publishing credentials stay on the publishing host. Provision a pull-only
repository credential on the Worker when the registry supports that scope.

The helper requires `--docker-config /absolute/private/path` or the same path
through `DOCKER_CONFIG`; it does not fall back to a user's global Docker config.
It never reads or prints authentication contents. Child Docker processes receive
the dedicated path and a fixed host tool search path, excluding unrelated model
and Room credentials. The helper ignores ambient `DOCKER_HOST`, `DOCKER_CONTEXT`,
proxy and alternate TLS environment. Credential helpers must be installed on the
trusted host tool path. Docker failures return fixed error codes.

Every command uses an explicit local Unix socket. Select it with
`--docker-socket`, or `CAMP_DOCKER_SOCKET`; the compatibility default is
`/var/run/docker.sock`. Remote Docker contexts are outside this deployment
contract. The socket and authentication paths must have trusted, unwritable
ancestors. A root-owned sticky `/tmp` is accepted for private temporary builds.
The receipt records the canonical socket and Docker daemon ID hash, checked
before and after the operation. Pin a known daemon with `--docker-id-hash` when
the operation is attached to an existing deployment.

The registry must use verified HTTPS. Configure an operator-owned private CA in
Docker's trust store when necessary. Do not configure the registry as insecure,
disable certificate verification or publish the Docker socket. Before any
registry request, the helper checks the local daemon's `RegistryConfig` and all
current IPv4/IPv6 DNS answers against its insecure host/CIDR rules. It repeats
those checks before issuing a successful receipt. A direct CLI manifest request
does not prove that the daemon will preserve TLS on push or pull. Unknown policy,
failed DNS, insecure matching addresses and target registry mirrors fail closed.
Daemon proxy configuration remains an operator-managed host concern; a proxy
must preserve verified registry HTTPS. These checks assume the local privileged
daemon, DNS and trust configuration remain under operator control during the
operation.

## Explicit operations

The following values are deployment identities, not credentials. Use a fresh
release tag; production Workers always consume the returned digest reference.

```sh
node scripts/deploy/oci-image.mjs inspect \
  --docker-config /etc/camp/publisher-docker \
  --docker-socket /var/run/docker.sock \
  --image-id sha256:<reviewed-local-image-id> \
  --toolchain-digest <reviewed-toolchain-digest>

node scripts/deploy/oci-image.mjs publish \
  --docker-config /etc/camp/publisher-docker \
  --repository registry.example.org/camp/runtime \
  --tag camp-toolchain-<toolchain-prefix> \
  --image-id sha256:<reviewed-local-image-id> \
  --toolchain-digest <reviewed-toolchain-digest>

node scripts/deploy/oci-image.mjs pull \
  --docker-config /etc/camp/pull-docker \
  --docker-socket /var/run/docker.sock \
  --reference registry.example.org/camp/runtime@sha256:<registry-manifest-digest> \
  --image-id sha256:<reviewed-local-image-id> \
  --toolchain-digest <reviewed-toolchain-digest>
```

`inspect` only reads the existing local Docker image. `publish` and `pull` are
the only commands that mutate Docker state. Pull rejects tags, partial digests
and implicit `latest`. Publish checks the source identity first, refuses an
already published tag, rejects an unrelated local alias and publishes a new
tag. Authentication/network failures are not treated as a missing tag. It then
retrieves the exact digest reference returned by Docker, pulls that reference
back and checks its actual image ID and toolchain label before checking the
source again. Keeping the source ID cached is not proof that a mutable local
tag published the same image. Use a single publisher or the registry's tag
immutability policy to prevent concurrent publishers racing that existence
check; a client-side existence check is not a registry compare-and-swap.

Manifest preflight accepts bounded Docker v2/OCI images and indexes. For an
index it checks the selected Linux platform's image manifest before pulling.
Foreign layer URLs and embedded descriptor data are rejected. The supported
envelope is 128 layer descriptors, 8 GiB per layer and 16 GiB total compressed
layer bytes; config and manifest descriptors are bounded to 4 MiB. Other formats
need an explicit reviewed extension rather than an implicit download fallback.

The helper does not delete cached images on a failed pull: another project may
still use them. A failed verification produces no successful deployment receipt
and cannot update service configuration or candidate identities.
An interrupted publication can have committed remotely even when the client
received no receipt. Retrying publication still refuses the existing tag; do
not overwrite it or infer success from a cached source image. Recover the
immutable digest through the registry's trusted operator interface, then use
`pull` with the original expected image/toolchain identities to verify it.
An interrupted digest pull can be repeated safely using that same reference.

## Current deployment scope

The HK publisher and MY Worker initially share an operator-managed private ACR
repository under `ling-swe-acr-registry.cn-hongkong.cr.aliyuncs.com/akernel/agent`.
Camp uses the separate tag `camp-toolchain-c88b8d22cfd6`; the existing Akernel
tags and deployments remain independent. This repository reuse is an initial
capacity constraint, not an authorization boundary between projects. A dedicated
Camp repository and separate publisher/pull identities should replace it when
registry quota permits.
The initial shared Docker login on MY is explicitly operator-authorized; it
does not provide repository-level publisher/receiver privilege separation.

The reviewed sandbox image is
`sha256:dfb1619b630a1c5e6e155b37b604bdc13984f457434680a30d8c5de1df78c7fa`.
The matching toolchain digest is
`c88b8d22cfd6e229cfaa98b704b10787872d89348be657af74c0eb95c8b232d2`.
On 2026-10-23 the image was published through the HK VPC endpoint and MY pulled
the public digest reference. The registry digest equals the reviewed Docker
image ID for this exact image/store. A separate anonymous manifest request was
denied; authenticated fresh index, AMD64 manifest and 9,630-byte config GETs
matched their SHA-256 digests. Existing large layers were retained, so this is
not a full cold-image download. Private receipts are
`.camp/production/my-oci-pull.json` and `my-oci-private-proof.json`.

On this HK host, Docker bridge subnets overlap the VPC registry's two resolved
addresses. Two explicit `/32` routes through the VPC gateway restore this
endpoint's connectivity without replacing the bridge routes. A host-specific
`camp-acr-vpc-route.service` retains that correction across reboot. This is a
deployment exception: use non-overlapping Docker/VPC address plans for a fresh
installation and revalidate DNS/routing before registry endpoint changes.
