import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink, link, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployOciImage, ociConfiguration, parseOciArguments } from './oci-image.mjs';

const imageId = `sha256:${'a'.repeat(64)}`, registryDigest = `sha256:${'b'.repeat(64)}`, toolchainDigest = 'c'.repeat(64);
const repository = 'registry.example.test/camp/runtime', reference = `${repository}@${registryDigest}`;
const image = overrides => JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'camp.toolchain.digest': toolchainDigest } }, ...overrides }]);
const manifestType = 'application/vnd.oci.image.manifest.v1+json';
const manifestObject = () => ({ schemaVersion: 2, mediaType: manifestType, config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'d'.repeat(64)}`, size: 9630 }, layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'e'.repeat(64)}`, size: 4096 }] });
const manifest = JSON.stringify(manifestObject());
const result = (stdout = '', stderr = '') => ({ stdout, stderr });
const missing = stderr => Object.assign(new Error('docker command failed'), { stderr });
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-oci-')), config = join(home, 'auth'), socket = join(home, 'docker.sock');
  await mkdir(config, { mode: 0o700 }); await writeFile(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  const server = createServer(); server.listen(socket); await once(server, 'listening'); await chmod(socket, 0o600);
  const daemon = { ID: 'fixture-daemon', DockerRootDir: '/var/lib/docker', OSType: 'linux', Architecture: 'x86_64', RegistryConfig: { InsecureRegistryCIDRs: ['::1/128', '127.0.0.0/8'], IndexConfigs: {}, Mirrors: [] } };
  return { home, config, socket, daemon, close: async () => { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(home, { recursive: true, force: true }); }, options: { imageId, toolchainDigest, dockerConfig: config, dockerSocket: socket } };
}
async function deploy(f, input, { run = async () => result(image()), daemon = () => f.daemon, lookupRegistry = async () => [{ address: '203.0.113.8', family: 4 }], ...options } = {}) {
  return deployOciImage(input, { ...options, lookupRegistry, run: async (command, args, child) => {
    assert.equal(command, 'docker'); assert.deepEqual(args.slice(0, 2), ['--host', `unix://${f.socket}`]);
    const action = args.slice(2);
    if (action[0] === 'info') return result(JSON.stringify(daemon()));
    return run(command, action, child);
  } });
}

test('OCI arguments require explicit actions, complete digests and safe local configuration', async () => {
  const f = await fixture();
  try {
    const pull = { command: 'pull', reference, ...f.options };
    assert.equal(ociConfiguration(pull).registryDigest, registryDigest);
    for (const changed of [{ command: undefined }, { reference: `${repository}:latest` }, { reference: `${repository}:v1` }, { reference: `${repository}@sha256:abc` }, { reference: `https://${reference}` }, { imageId: 'camp-runtime:latest' }, { toolchainDigest: 'short' }, { dockerConfig: 'relative' }, { dockerSocket: 'tcp://remote:2375' }, { dockerIdHash: 'short' }, { password: 'forbidden' }, { reference: `registry.example.test:70000/camp/runtime@${registryDigest}` }, { reference: `bad-.example.test/camp/runtime@${registryDigest}` }]) assert.throws(() => ociConfiguration({ ...pull, ...changed }), { code: 'camp_oci_configuration' });
    assert.equal(ociConfiguration({ ...pull, reference: `registry.example.test/runtime@${registryDigest}` }).repository, 'registry.example.test/runtime');
    assert.equal(ociConfiguration({ ...pull, reference: `[2001:db8::1]:5000/runtime@${registryDigest}` }).repository, '[2001:db8::1]:5000/runtime');
    assert.throws(() => ociConfiguration({ command: 'publish', repository, tag: 'latest', ...f.options }), { code: 'camp_oci_configuration' });
    assert.throws(() => parseOciArguments(['pull', '--reference', reference, '--password', 'forbidden']), { code: 'camp_oci_configuration' });
    assert.throws(() => parseOciArguments(['pull', '--reference', reference, '--reference', reference]), { code: 'camp_oci_configuration' });
    assert.equal(parseOciArguments(['inspect', '--docker-socket', f.socket]).dockerSocket, f.socket);
    assert.equal(ociConfiguration({ command: 'inspect', imageId, toolchainDigest }, { DOCKER_CONFIG: f.config, CAMP_DOCKER_SOCKET: f.socket }).dockerSocket, f.socket);
  } finally { await f.close(); }
});

test('inspect is read only, checks one local daemon and strips ambient remote, proxy, TLS and secret environment', async () => {
  const f = await fixture(), calls = [];
  try {
    const injected = { PATH: '/tmp/user-bin', DOCKER_HOST: 'tcp://other:2375', DOCKER_CONTEXT: 'production', DOCKER_TLS_VERIFY: '0', DOCKER_CERT_PATH: '/tmp/unsafe', HTTP_PROXY: 'http://secret@proxy', HTTPS_PROXY: 'https://secret@proxy', SSL_CERT_FILE: '/tmp/unsafe-ca', NODE_TLS_REJECT_UNAUTHORIZED: '0', DEEPSEEK_API_KEY: 'never-forward', CAMP_WORKER_TOKEN: 'never-forward' };
    const receipt = await deploy(f, { command: 'inspect', ...f.options }, { env: injected, run: async (command, args, options) => {
      calls.push(args); assert.equal(options.env.DOCKER_CONFIG, f.config);
      for (const key of Object.keys(injected).filter(key => key !== 'PATH')) assert.equal(options.env[key], undefined);
      assert.equal(options.env.PATH.includes('/tmp/'), false); return result(image());
    } });
    assert.deepEqual(calls, [['image', 'inspect', imageId]]);
    assert.equal(receipt.runtimeImageId, imageId); assert.equal(receipt.registryDigest, undefined); assert.equal(receipt.dockerIdHash, hash(f.daemon.ID));
    for (const data of [image({ Id: registryDigest }), image({ Config: { Labels: { 'camp.toolchain.digest': 'e'.repeat(64) } } }), image({ Os: 'windows' }), '[]', 'invalid-json']) await assert.rejects(deploy(f, { command: 'inspect', ...f.options }, { run: async () => result(data) }), { code: 'camp_oci_image_identity' });
  } finally { await f.close(); }
});

test('pull uses only the complete registry digest and independently verifies the preserved local image ID', async () => {
  const f = await fixture(), calls = [];
  try {
    const receipt = await deploy(f, { command: 'pull', reference, ...f.options }, { run: async (command, args) => {
      calls.push(args); return result(args[0] === 'manifest' ? manifest : args[1] === 'inspect' ? image() : '');
    } });
    assert.deepEqual(calls, [['manifest', 'inspect', reference], ['image', 'pull', reference], ['image', 'inspect', reference]]);
    assert.equal(receipt.registryDigest, registryDigest); assert.equal(receipt.runtimeImageId, imageId); assert.notEqual(receipt.registryDigest, receipt.runtimeImageId);
    const mismatch = [];
    await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { run: async (command, args) => {
      mismatch.push(args); return result(args[0] === 'manifest' ? manifest : args[1] === 'inspect' ? image({ Id: registryDigest }) : '');
    } }), { code: 'camp_oci_image_identity' });
    assert.equal(mismatch.some(args => ['tag', 'rm', 'rmi', 'run'].includes(args[1])), false);
  } finally { await f.close(); }
});

test('daemon insecure host rules, IPv4/IPv6 CIDRs, localhost and unknown policies fail before registry requests', async () => {
  const f = await fixture();
  try {
    const cases = [
      { policy: { ...f.daemon.RegistryConfig, IndexConfigs: { 'registry.example.test': { Name: 'registry.example.test', Secure: false, Mirrors: [] } } } },
      { policy: { ...f.daemon.RegistryConfig, InsecureRegistryCIDRs: ['203.0.113.0/24'] } },
      { policy: { ...f.daemon.RegistryConfig, InsecureRegistryCIDRs: ['2001:db8::/32'] }, address: '2001:db8::8' },
      { policy: f.daemon.RegistryConfig, selected: `localhost:5000/camp/runtime@${registryDigest}`, address: '127.0.0.1' },
      { policy: f.daemon.RegistryConfig, selected: `[::1]:5000/camp/runtime@${registryDigest}` },
      { policy: { ...f.daemon.RegistryConfig, InsecureRegistryCIDRs: ['not-a-cidr'] } },
      { policy: undefined },
    ];
    for (const scenario of cases) {
      let calls = 0;
      await assert.rejects(deploy(f, { command: 'pull', reference: scenario.selected ?? reference, ...f.options }, { daemon: () => ({ ...f.daemon, RegistryConfig: scenario.policy }), lookupRegistry: async () => [{ address: scenario.address ?? '203.0.113.8' }], run: async () => { calls++; return result(manifest); } }), { code: 'camp_oci_registry_tls' });
      assert.equal(calls, 0);
    }
    await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { lookupRegistry: async () => { throw new Error('DNS unavailable'); } }), { code: 'camp_oci_registry_tls' });
  } finally { await f.close(); }
});

test('all resolved addresses are checked and a secure registry can use IPv6 and explicit TLS host rules', async () => {
  const f = await fixture();
  try {
    f.daemon.RegistryConfig.IndexConfigs['registry.example.test'] = { Name: 'registry.example.test', Secure: true, Mirrors: [] };
    const run = async (command, args) => result(args[0] === 'manifest' ? manifest : args[1] === 'inspect' ? image() : '');
    await deploy(f, { command: 'pull', reference, ...f.options }, { lookupRegistry: async () => [{ address: '2001:db8::8' }, { address: '203.0.113.8' }], run });
    await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { lookupRegistry: async () => [{ address: '203.0.113.8' }, { address: '::1' }], run }), { code: 'camp_oci_registry_tls' });
  } finally { await f.close(); }
});

test('publish checks collisions and verifies the actual immutable registry image by pulling it back', async () => {
  const f = await fixture(), calls = [], tag = 'version-1', tagged = `${repository}:${tag}`;
  try {
    const run = async (command, args) => {
      calls.push(args);
      if (args[0] === 'manifest') { if (args[2] === tagged) throw missing('manifest unknown'); return result(manifest); }
      if (args[1] === 'inspect') return result(image());
      if (args[1] === 'push') return result(`${tag}: digest: ${registryDigest} size: 856\n`);
      return result();
    };
    const receipt = await deploy(f, { command: 'publish', repository, tag, ...f.options }, { run });
    assert.equal(receipt.reference, reference); assert.equal(receipt.runtimeImageId, imageId);
    assert.ok(calls.some(args => args[1] === 'pull' && args[2] === reference));
    assert.ok(calls.some(args => args[1] === 'inspect' && args[2] === reference));
    const wrong = async (command, args) => args[0] === 'image' && args[1] === 'inspect' && args[2] === reference ? result(image({ Id: registryDigest })) : run(command, args);
    await assert.rejects(deploy(f, { command: 'publish', repository, tag, ...f.options }, { run: wrong }), { code: 'camp_oci_image_identity' });
  } finally { await f.close(); }
});

test('remote tag, failed authentication and conflicting local tag cannot be overwritten', async () => {
  const f = await fixture(), tag = 'version-1', tagged = `${repository}:${tag}`;
  try {
    for (const scenario of ['remote-exists', 'auth-failure', 'local-conflict']) {
      const mutations = [];
      await assert.rejects(deploy(f, { command: 'publish', repository, tag, ...f.options }, { run: async (command, args) => {
        if (['tag', 'push', 'pull'].includes(args[1])) mutations.push(args);
        if (args[0] === 'manifest') { if (scenario === 'remote-exists') return result(manifest); throw missing(scenario === 'auth-failure' ? 'unauthorized: secret-provider-detail' : 'manifest unknown'); }
        return result(image(args[2] === tagged ? { Id: registryDigest } : {}));
      } }), { code: scenario === 'remote-exists' ? 'camp_oci_tag_exists' : scenario === 'auth-failure' ? 'camp_oci_registry_unavailable' : 'camp_oci_local_tag_conflict' });
      assert.equal(mutations.length, 0);
    }
  } finally { await f.close(); }
});

test('public or replaceable auth paths, links and a non-socket endpoint fail before Docker calls', async () => {
  const f = await fixture(); let calls = 0;
  const run = async () => { calls++; return result(image()); };
  try {
    await chmod(join(f.config, 'config.json'), 0o644);
    await assert.rejects(deploy(f, { command: 'inspect', ...f.options }, { run }), { code: 'camp_oci_auth_configuration' }); await chmod(join(f.config, 'config.json'), 0o600);
    await chmod(f.home, 0o777); await assert.rejects(deploy(f, { command: 'inspect', ...f.options }, { run }), { code: 'camp_oci_auth_configuration' }); await chmod(f.home, 0o700);
    const alias = join(f.home, 'linked'); await symlink(f.config, alias);
    await assert.rejects(deploy(f, { command: 'inspect', ...f.options, dockerConfig: alias }, { run }), { code: 'camp_oci_auth_configuration' });
    const shared = join(f.home, 'shared.json'); await link(join(f.config, 'config.json'), shared);
    await assert.rejects(deploy(f, { command: 'inspect', ...f.options }, { run }), { code: 'camp_oci_auth_configuration' }); await unlink(shared);
    await assert.rejects(deploy(f, { command: 'inspect', ...f.options, dockerSocket: join(f.config, 'config.json') }, { run }), { code: 'camp_oci_docker_configuration' });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('malformed or changed Docker identity never produces a receipt, including after an otherwise successful pull', async () => {
  const f = await fixture();
  try {
    await assert.rejects(deploy(f, { command: 'inspect', ...f.options, dockerIdHash: '0'.repeat(64) }), { code: 'camp_oci_docker_identity' });
    let reads = 0;
    await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { daemon: () => ({ ...f.daemon, ID: ++reads === 1 ? f.daemon.ID : 'different-daemon' }), run: async (command, args) => result(args[0] === 'manifest' ? manifest : args[1] === 'inspect' ? image() : '') }), { code: 'camp_oci_docker_identity' });
    await assert.rejects(deploy(f, { command: 'inspect', ...f.options }, { daemon: () => ({ ...f.daemon, ID: '' }) }), { code: 'camp_oci_docker_identity' });
  } finally { await f.close(); }
});

test('foreign layer URLs, unsafe descriptors and image sizes are rejected before pull', async () => {
  const f = await fixture();
  try {
    const variants = [
      { ...manifestObject(), schemaVersion: 1 }, { ...manifestObject(), mediaType: 'unsupported' },
      { ...manifestObject(), config: { ...manifestObject().config, data: 'embedded-data' } },
      { ...manifestObject(), layers: [{ ...manifestObject().layers[0], urls: ['http://other-host/layer'] }] },
      { ...manifestObject(), layers: [{ ...manifestObject().layers[0], size: -1 }] },
      { ...manifestObject(), layers: [{ ...manifestObject().layers[0], digest: 'sha256:short' }] },
      { ...manifestObject(), layers: [{ ...manifestObject().layers[0], size: 9 * 1024 ** 3 }] },
      { ...manifestObject(), layers: Array.from({ length: 3 }, () => ({ ...manifestObject().layers[0], size: 8 * 1024 ** 3 })) },
    ];
    for (const value of variants) {
      let pulls = 0;
      await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { run: async (command, args) => { if (args[1] === 'pull') pulls++; return result(JSON.stringify(value)); } }), { code: 'camp_oci_manifest_invalid' });
      assert.equal(pulls, 0);
    }
  } finally { await f.close(); }
});

test('an index validates its selected platform child before Docker can follow child layer URLs', async () => {
  const f = await fixture(), childDigest = `sha256:${'f'.repeat(64)}`;
  const index = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [{ mediaType: manifestType, digest: childDigest, size: 1024, platform: { os: 'linux', architecture: 'amd64' } }] };
  try {
    const calls = [];
    const run = async (command, args) => { calls.push(args); return result(args[0] === 'manifest' ? JSON.stringify(args[2] === reference ? index : manifestObject()) : args[1] === 'inspect' ? image() : ''); };
    await deploy(f, { command: 'pull', reference, ...f.options }, { run });
    assert.deepEqual(calls[1], ['manifest', 'inspect', `${repository}@${childDigest}`]);
    let pulls = 0;
    await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { run: async (command, args) => {
      if (args[1] === 'pull') pulls++;
      const child = { ...manifestObject(), layers: [{ ...manifestObject().layers[0], urls: ['http://unexpected/layer'] }] };
      return result(JSON.stringify(args[2] === reference ? index : child));
    } }), { code: 'camp_oci_manifest_invalid' });
    assert.equal(pulls, 0);
  } finally { await f.close(); }
});

test('failed pushes preserve their bounded outcome, and a retry cannot overwrite a tag that may already have committed', async () => {
  const f = await fixture(), tag = 'retry', tagged = `${repository}:${tag}`, mutations = [];
  try {
    let committed = false;
    const run = async (command, args) => {
      if (args[0] === 'manifest') { if (args[2] === tagged && !committed) throw missing('manifest unknown'); return result(manifest); }
      if (args[1] === 'inspect') return result(image());
      mutations.push(args);
      if (args[1] === 'push') { committed = true; throw missing('private failure details'); }
      return result();
    };
    await assert.rejects(deploy(f, { command: 'publish', repository, tag, ...f.options }, { run }), error => error.code === 'camp_oci_push_failed' && !error.message.includes('private failure'));
    const before = mutations.length;
    await assert.rejects(deploy(f, { command: 'publish', repository, tag, ...f.options }, { run }), { code: 'camp_oci_tag_exists' });
    assert.equal(mutations.length, before);
    assert.equal(mutations.some(args => ['rm', 'rmi', 'run'].includes(args[1])), false);
  } finally { await f.close(); }
});

test('failed Docker calls and incomplete publish receipts expose only fixed errors', async () => {
  const f = await fixture();
  try {
    await assert.rejects(deploy(f, { command: 'pull', reference, ...f.options }, { run: async () => { throw Object.assign(new Error('sensitive credentials'), { stderr: 'private-token' }); } }), error => error.code === 'camp_oci_registry_unavailable' && !JSON.stringify(error).includes('private-token') && !error.message.includes('sensitive'));
    await assert.rejects(deploy(f, { command: 'publish', repository, tag: 'incomplete', ...f.options }, { run: async (command, args) => {
      if (args[0] === 'manifest') throw missing('manifest unknown');
      return result(args[1] === 'inspect' ? image() : '');
    } }), { code: 'camp_oci_publish_receipt' });
  } finally { await f.close(); }
});
