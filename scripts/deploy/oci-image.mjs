import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const digest = /^sha256:[a-f0-9]{64}$/;
const hex = /^[a-f0-9]{64}$/;
const fail = code => Object.assign(new Error('Camp OCI image verification failed; inspect the configured registry, immutable reference and Docker deployment identity'), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const canonicalPath = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && /^\/[A-Za-z0-9_./-]+$/.test(value) && value !== '/';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function registryIdentity(repository) {
  if (typeof repository !== 'string' || repository.length > 512) throw fail('camp_oci_configuration');
  const [authority, ...parts] = repository.split('/');
  if (!parts.length || parts.some(value => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value))) throw fail('camp_oci_configuration');
  let url;
  try { url = new URL(`https://${authority}`); } catch { throw fail('camp_oci_configuration'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || authority !== authority.toLowerCase()
    || !/^(?:\[[a-f0-9:]+\]|[a-z0-9.-]+)(?::[1-9][0-9]{0,4})?$/.test(authority)
    || (!isIP(host) && (host.length > 253 || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))))
    || (!isIP(host) && !host.includes('.') && host !== 'localhost' && !url.port)) throw fail('camp_oci_configuration');
  return { authority, host };
}

export function ociConfiguration(input, env = process.env) {
  const allowed = ['command', 'imageId', 'toolchainDigest', 'repository', 'tag', 'reference', 'dockerConfig', 'dockerSocket', 'dockerIdHash'];
  if (!object(input) || Object.keys(input).some(key => !allowed.includes(key)) || !['publish', 'pull', 'inspect'].includes(input.command)
    || !digest.test(input.imageId) || !hex.test(input.toolchainDigest)) throw fail('camp_oci_configuration');
  const config = { ...input, dockerConfig: input.dockerConfig ?? env.DOCKER_CONFIG, dockerSocket: input.dockerSocket ?? env.CAMP_DOCKER_SOCKET ?? '/var/run/docker.sock' };
  if (!canonicalPath(config.dockerConfig) || !canonicalPath(config.dockerSocket) || config.dockerIdHash !== undefined && !hex.test(config.dockerIdHash)) throw fail('camp_oci_configuration');
  if (config.command === 'publish') {
    registryIdentity(config.repository);
    if (typeof config.tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(config.tag) || config.tag.toLowerCase() === 'latest' || config.reference !== undefined) throw fail('camp_oci_configuration');
  } else if (config.command === 'pull') {
    if (typeof config.reference !== 'string' || config.reference.split('@').length !== 2 || config.repository !== undefined || config.tag !== undefined) throw fail('camp_oci_configuration');
    const [repository, registryDigest] = config.reference.split('@');
    registryIdentity(repository);
    if (!digest.test(registryDigest)) throw fail('camp_oci_configuration');
    config.repository = repository; config.registryDigest = registryDigest;
  } else if (['repository', 'tag', 'reference'].some(key => config[key] !== undefined)) throw fail('camp_oci_configuration');
  return config;
}

async function trustedParents(path) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const entry = await lstat(parent);
    const stickyTemporary = parent === '/tmp' && entry.uid === 0 && (entry.mode & 0o1000);
    if (!entry.isDirectory() || entry.isSymbolicLink() || ![0, process.getuid()].includes(entry.uid) || (!stickyTemporary && entry.mode & 0o022)) throw fail('camp_oci_auth_configuration');
    if (parent === '/') break;
  }
}
async function localDockerSocket(path) {
  try {
    const canonical = await realpath(path), stat = await lstat(canonical);
    await trustedParents(canonical);
    if (!stat.isSocket() || ![0, process.getuid()].includes(stat.uid) || stat.mode & 0o002) throw fail('camp_oci_docker_configuration');
    return canonical;
  } catch { throw fail('camp_oci_docker_configuration'); }
}

/** Only a dedicated private Docker config is accepted. Contents and credentials
 * are never read by this tool, embedded in an argument or returned in errors. */
async function privateDockerConfig(path) {
  try {
    await trustedParents(path);
    const directory = await lstat(path), file = await lstat(join(path, 'config.json'));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700 || await realpath(path) !== path
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600 || file.size > 1024 * 1024) throw fail('camp_oci_auth_configuration');
  } catch { throw fail('camp_oci_auth_configuration'); }
}

function daemonFacts(stdout, expected) {
  let value;
  try { value = JSON.parse(stdout); } catch { throw fail('camp_oci_docker_identity'); }
  if (!object(value) || typeof value.ID !== 'string' || value.ID.length < 1 || value.ID.length > 256 || /[\u0000-\u0020\u007f]/.test(value.ID) || value.OSType !== 'linux' || !canonicalPath(value.DockerRootDir)) throw fail('camp_oci_docker_identity');
  const dockerIdHash = hash(value.ID);
  if (expected && expected !== dockerIdHash) throw fail('camp_oci_docker_identity');
  return { dockerIdHash, info: value };
}

/** Docker's daemon controls pull/push TLS. A successful direct manifest lookup
 * alone says nothing about its insecure-registry policy or HTTP fallback. */
async function requireRegistryTls(repository, info, lookupRegistry) {
  const registry = registryIdentity(repository), policy = info.RegistryConfig;
  if (!object(policy) || !object(policy.IndexConfigs) || !Array.isArray(policy.InsecureRegistryCIDRs) || policy.InsecureRegistryCIDRs.length > 128) throw fail('camp_oci_registry_tls');
  const entry = policy.IndexConfigs[registry.authority];
  if (entry !== undefined && (!object(entry) || entry.Secure !== true || entry.Name !== registry.authority || !Array.isArray(entry.Mirrors) || entry.Mirrors.length)) throw fail('camp_oci_registry_tls');
  if (['docker.io', 'index.docker.io', 'registry-1.docker.io'].includes(registry.authority) && (!Array.isArray(policy.Mirrors) || policy.Mirrors.length)) throw fail('camp_oci_registry_tls');
  const blocked = new BlockList();
  try {
    for (const cidr of policy.InsecureRegistryCIDRs) {
      if (typeof cidr !== 'string' || cidr.split('/').length !== 2) throw fail('camp_oci_registry_tls');
      const [address, rawBits] = cidr.split('/'), family = isIP(address), bits = Number(rawBits);
      if (!family || !/^(0|[1-9][0-9]*)$/.test(rawBits) || bits > (family === 4 ? 32 : 128)) throw fail('camp_oci_registry_tls');
      blocked.addSubnet(address, bits, family === 4 ? 'ipv4' : 'ipv6');
    }
    const addresses = isIP(registry.host) ? [{ address: registry.host }] : await lookupRegistry(registry.host, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 || addresses.some(item => !isIP(item?.address) || blocked.check(item.address, isIP(item.address) === 4 ? 'ipv4' : 'ipv6'))) throw fail('camp_oci_registry_tls');
  } catch { throw fail('camp_oci_registry_tls'); }
}

function imageFacts(stdout, config) {
  let rows;
  try { rows = JSON.parse(stdout); } catch { throw fail('camp_oci_image_identity'); }
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.Id !== config.imageId || rows[0]?.Config?.Labels?.['camp.toolchain.digest'] !== config.toolchainDigest
    || rows[0].Os !== 'linux' || !['amd64', 'arm64'].includes(rows[0].Architecture)) throw fail('camp_oci_image_identity');
  return { runtimeImageId: rows[0].Id, platform: rows[0].Os, architecture: rows[0].Architecture };
}

function manifestFacts(stdout) {
  let value;
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 4 * 1024 * 1024) throw fail('camp_oci_manifest_invalid');
  try { value = JSON.parse(stdout); } catch { throw fail('camp_oci_manifest_invalid'); }
  if (value?.schemaVersion !== 2) throw fail('camp_oci_manifest_invalid');
  const indexes = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']);
  const manifests = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']);
  const configs = new Set(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json']);
  const layers = new Set(['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd', 'application/vnd.docker.image.rootfs.diff.tar', 'application/vnd.docker.image.rootfs.diff.tar.gzip']);
  const descriptor = (item, types, maximum) => object(item) && digest.test(item.digest) && types.has(item.mediaType) && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= maximum && item.urls === undefined && item.data === undefined;
  if (Array.isArray(value.manifests)) {
    if (!indexes.has(value.mediaType) || !value.manifests.length || value.manifests.length > 128 || !value.manifests.every(item => descriptor(item, manifests, 4 * 1024 * 1024))) throw fail('camp_oci_manifest_invalid');
  } else if (!manifests.has(value.mediaType) || !descriptor(value.config, configs, 4 * 1024 * 1024) || !Array.isArray(value.layers) || value.layers.length > 128 || !value.layers.every(item => descriptor(item, layers, 8 * 1024 ** 3)) || value.layers.reduce((sum, item) => sum + item.size, 0) > 16 * 1024 ** 3) throw fail('camp_oci_manifest_invalid');
  return value;
}

function pushedDigest(stdout, stderr) {
  const matches = [...`${stdout}\n${stderr}`.matchAll(/(?:^|[\r\n])[^\r\n]*\bdigest:\s+(sha256:[a-f0-9]{64})\s+size:\s+\d+\s*(?=$|[\r\n])/g)];
  const values = [...new Set(matches.map(match => match[1]))];
  if (values.length !== 1) throw fail('camp_oci_publish_receipt');
  return values[0];
}

export async function deployOciImage(input, { run = execute, env = process.env, now = Date.now, lookupRegistry = lookup } = {}) {
  const config = ociConfiguration(input, env);
  await privateDockerConfig(config.dockerConfig);
  const socket = await localDockerSocket(config.dockerSocket);
  // A private auth file may contain a currentContext. The explicit local socket
  // overrides it; no ambient remote/context, proxy or alternate TLS environment
  // reaches the CLI. The local daemon's separately managed proxy remains its
  // responsibility and must preserve verified registry HTTPS.
  const childEnv = { DOCKER_CONFIG: config.dockerConfig, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  if (env.HOME !== undefined) childEnv.HOME = env.HOME;
  const docker = async args => run('docker', ['--host', `unix://${socket}`, ...args], { env: childEnv, maxBuffer: 4 * 1024 * 1024, timeout: args[1] === 'pull' || args[1] === 'push' ? 30 * 60_000 : 30_000 });
  const checkedDocker = async (args, code) => { try { return await docker(args); } catch { throw fail(code); } };
  const readDaemon = async expected => daemonFacts((await checkedDocker(['info', '--format', '{{json .}}'], 'camp_oci_docker_unavailable')).stdout, expected);
  const daemon = await readDaemon(config.dockerIdHash);
  if (config.repository) await requireRegistryTls(config.repository, daemon.info, lookupRegistry);
  const inspect = async reference => imageFacts((await checkedDocker(['image', 'inspect', reference], 'camp_oci_image_unavailable')).stdout, config);
  const inspectRegistry = async reference => {
    const manifest = manifestFacts((await checkedDocker(['manifest', 'inspect', reference], 'camp_oci_registry_unavailable')).stdout);
    if (manifest.manifests) {
      const architecture = { x86_64: 'amd64', amd64: 'amd64', aarch64: 'arm64', arm64: 'arm64' }[daemon.info.Architecture];
      const selected = manifest.manifests.filter(item => item.platform?.os === 'linux' && item.platform?.architecture === architecture);
      if (!architecture || selected.length !== 1) throw fail('camp_oci_manifest_invalid');
      const child = manifestFacts((await checkedDocker(['manifest', 'inspect', `${config.repository}@${selected[0].digest}`], 'camp_oci_registry_unavailable')).stdout);
      if (child.manifests || child.mediaType !== selected[0].mediaType) throw fail('camp_oci_manifest_invalid');
    }
  };
  let facts, registryDigest, reference;
  if (config.command === 'inspect') {
    facts = await inspect(config.imageId);
  } else if (config.command === 'pull') {
    reference = config.reference; registryDigest = config.registryDigest;
    // No tag lookup or fallback is permitted. A registry digest can differ
    // from Docker's local index/config identity and is checked independently.
    await inspectRegistry(reference);
    await checkedDocker(['image', 'pull', reference], 'camp_oci_pull_failed');
    facts = await inspect(reference);
  } else {
    facts = await inspect(config.imageId);
    const tagged = `${config.repository}:${config.tag}`;
    try {
      await docker(['manifest', 'inspect', tagged]);
      throw fail('camp_oci_tag_exists');
    } catch (error) {
      if (error.code === 'camp_oci_tag_exists') throw error;
      if (!/manifest unknown|no such manifest|manifest_unknown/i.test(error.stderr ?? '')) throw fail('camp_oci_registry_unavailable');
    }
    // A locally existing alias must already name precisely this deployment.
    try { imageFacts((await docker(['image', 'inspect', tagged])).stdout, config); }
    catch (error) {
      if (error.code === 'camp_oci_image_identity' || !/no such image/i.test(error.stderr ?? '')) throw fail('camp_oci_local_tag_conflict');
    }
    await checkedDocker(['image', 'tag', config.imageId, tagged], 'camp_oci_tag_failed');
    await inspect(tagged);
    const pushed = await checkedDocker(['image', 'push', tagged], 'camp_oci_push_failed');
    registryDigest = pushedDigest(pushed.stdout, pushed.stderr);
    reference = `${config.repository}@${registryDigest}`;
    await inspectRegistry(reference);
    // Validate the image actually published, not just that the old source ID
    // still exists. A mutable local tag can change during another publisher's
    // work, and registries may rewrite an index identity during distribution.
    await checkedDocker(['image', 'pull', reference], 'camp_oci_pull_failed');
    facts = await inspect(reference);
    await inspect(config.imageId);
  }
  const finalDaemon = await readDaemon(daemon.dockerIdHash);
  if (finalDaemon.info.DockerRootDir !== daemon.info.DockerRootDir) throw fail('camp_oci_docker_identity');
  if (config.repository) await requireRegistryTls(config.repository, finalDaemon.info, lookupRegistry);
  return { schemaVersion: 1, kind: 'camp-private-oci-image', action: config.command, ...facts, toolchainDigest: config.toolchainDigest, dockerSocket: socket, dockerIdHash: daemon.dockerIdHash,
    ...(reference ? { repository: config.repository, reference, registryDigest } : {}), verifiedAt: new Date(now()).toISOString() };
}

export function parseOciArguments(argv) {
  const [command, ...arguments_] = argv;
  const options = { command }, flags = { '--image-id': 'imageId', '--toolchain-digest': 'toolchainDigest', '--repository': 'repository', '--tag': 'tag', '--reference': 'reference', '--docker-config': 'dockerConfig', '--docker-socket': 'dockerSocket', '--docker-id-hash': 'dockerIdHash' };
  for (let index = 0; index < arguments_.length; index += 2) {
    const field = flags[arguments_[index]], value = arguments_[index + 1];
    if (!field || typeof value !== 'string' || value.startsWith('--') || options[field] !== undefined) throw fail('camp_oci_configuration');
    options[field] = value;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await deployOciImage(parseOciArguments(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ event: 'oci_image_failed', code: error.code ?? 'camp_oci_failed' })); process.exitCode = 1; }
}
