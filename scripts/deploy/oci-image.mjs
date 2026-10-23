import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const digest = /^sha256:[a-f0-9]{64}$/;
const hex = /^[a-f0-9]{64}$/;
const fail = code => Object.assign(new Error('Camp OCI image verification failed; inspect the configured registry, immutable reference and Docker deployment identity'), { code });
const repositoryPattern = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;

export function ociConfiguration(input, env = process.env) {
  const allowed = ['command', 'imageId', 'toolchainDigest', 'repository', 'tag', 'reference', 'dockerConfig'];
  if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !['publish', 'pull', 'inspect'].includes(input.command)
    || !digest.test(input.imageId) || !hex.test(input.toolchainDigest)) throw fail('camp_oci_configuration');
  const config = { ...input, dockerConfig: input.dockerConfig ?? env.DOCKER_CONFIG };
  if (typeof config.dockerConfig !== 'string' || !isAbsolute(config.dockerConfig) || resolve(config.dockerConfig) !== config.dockerConfig || /[\u0000-\u0020\u007f]/.test(config.dockerConfig)) throw fail('camp_oci_configuration');
  if (config.command === 'publish') {
    if (!repositoryPattern.test(config.repository) || typeof config.tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(config.tag) || config.tag.toLowerCase() === 'latest' || config.reference !== undefined) throw fail('camp_oci_configuration');
  } else if (config.command === 'pull') {
    if (typeof config.reference !== 'string' || config.reference.split('@').length !== 2 || config.repository !== undefined || config.tag !== undefined) throw fail('camp_oci_configuration');
    const [repository, registryDigest] = config.reference.split('@');
    if (!repositoryPattern.test(repository) || !digest.test(registryDigest)) throw fail('camp_oci_configuration');
    config.repository = repository; config.registryDigest = registryDigest;
  } else if (['repository', 'tag', 'reference'].some(key => config[key] !== undefined)) throw fail('camp_oci_configuration');
  if (config.repository) {
    const registry = config.repository.split('/')[0], port = registry.split(':')[1];
    if ((!registry.includes('.') && !port) || registry.includes('..') || (port && Number(port) > 65535)) throw fail('camp_oci_configuration');
  }
  return config;
}

/** Only a dedicated private Docker config is accepted. Contents and credentials
 * are never read by this tool, embedded in an argument or returned in errors. */
async function privateDockerConfig(path) {
  try {
    const directory = await lstat(path), file = await lstat(join(path, 'config.json'));
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid() || (directory.mode & 0o777) !== 0o700 || await realpath(path) !== path
      || !file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600 || file.size > 1024 * 1024) throw fail('camp_oci_auth_configuration');
  } catch { throw fail('camp_oci_auth_configuration'); }
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
  try { value = JSON.parse(stdout); } catch { throw fail('camp_oci_manifest_invalid'); }
  if (value?.schemaVersion !== 2) throw fail('camp_oci_manifest_invalid');
  if (Array.isArray(value.manifests)) {
    if (!value.manifests.length || value.manifests.length > 128 || !value.manifests.every(item => digest.test(item?.digest))) throw fail('camp_oci_manifest_invalid');
  } else if (!digest.test(value.config?.digest) || !Array.isArray(value.layers) || value.layers.length > 1024 || !value.layers.every(item => digest.test(item?.digest))) throw fail('camp_oci_manifest_invalid');
}

function pushedDigest(stdout, stderr) {
  const matches = [...`${stdout}\n${stderr}`.matchAll(/(?:^|[\r\n])[^\r\n]*\bdigest:\s+(sha256:[a-f0-9]{64})\s+size:\s+\d+\s*(?=$|[\r\n])/g)];
  const values = [...new Set(matches.map(match => match[1]))];
  if (values.length !== 1) throw fail('camp_oci_publish_receipt');
  return values[0];
}

export async function deployOciImage(input, { run = execute, env = process.env, now = Date.now } = {}) {
  const config = ociConfiguration(input, env);
  await privateDockerConfig(config.dockerConfig);
  // Do not pass unrelated model/session credentials to the Docker child.
  const childEnv = { DOCKER_CONFIG: config.dockerConfig };
  for (const key of ['PATH', 'HOME', 'XDG_RUNTIME_DIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) if (env[key] !== undefined) childEnv[key] = env[key];
  const docker = async args => run('docker', args, { env: childEnv, maxBuffer: 64 * 1024 * 1024 });
  const checkedDocker = async (args, code) => { try { return await docker(args); } catch { throw fail(code); } };
  const inspect = async reference => imageFacts((await checkedDocker(['image', 'inspect', reference], 'camp_oci_image_unavailable')).stdout, config);
  let facts, registryDigest, reference;
  if (config.command === 'inspect') {
    facts = await inspect(config.imageId);
  } else if (config.command === 'pull') {
    reference = config.reference; registryDigest = config.registryDigest;
    // No tag lookup or fallback is permitted. A registry digest can differ
    // from Docker's local index/config identity and is checked independently.
    manifestFacts((await checkedDocker(['manifest', 'inspect', reference], 'camp_oci_registry_unavailable')).stdout);
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
    const pushed = await checkedDocker(['image', 'push', tagged], 'camp_oci_push_failed');
    registryDigest = pushedDigest(pushed.stdout, pushed.stderr);
    reference = `${config.repository}@${registryDigest}`;
    manifestFacts((await checkedDocker(['manifest', 'inspect', reference], 'camp_oci_registry_unavailable')).stdout);
    facts = await inspect(config.imageId);
  }
  return { schemaVersion: 1, kind: 'camp-private-oci-image', action: config.command, ...facts, toolchainDigest: config.toolchainDigest,
    ...(reference ? { repository: config.repository, reference, registryDigest } : {}), verifiedAt: new Date(now()).toISOString() };
}

export function parseOciArguments(argv) {
  const [command, ...arguments_] = argv;
  const options = { command }, flags = { '--image-id': 'imageId', '--toolchain-digest': 'toolchainDigest', '--repository': 'repository', '--tag': 'tag', '--reference': 'reference', '--docker-config': 'dockerConfig' };
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
