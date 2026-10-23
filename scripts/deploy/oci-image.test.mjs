import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployOciImage, ociConfiguration, parseOciArguments } from './oci-image.mjs';

const imageId = `sha256:${'a'.repeat(64)}`, registryDigest = `sha256:${'b'.repeat(64)}`, toolchainDigest = 'c'.repeat(64);
const repository = 'registry.example.test/camp/runtime', reference = `${repository}@${registryDigest}`;
const image = overrides => JSON.stringify([{ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'camp.toolchain.digest': toolchainDigest } }, ...overrides }]);
const manifest = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${'d'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } }] });
const result = (stdout = '', stderr = '') => ({ stdout, stderr });
const missing = stderr => Object.assign(new Error('docker command failed'), { stderr });
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-oci-')), config = join(home, 'auth');
  await mkdir(config, { mode: 0o700 }); await writeFile(join(config, 'config.json'), JSON.stringify({ auths: {} }), { mode: 0o600 });
  return { home, config, close: () => rm(home, { recursive: true, force: true }), options: { imageId, toolchainDigest, dockerConfig: config } };
}

test('OCI arguments require an explicit action, immutable pull digest and dedicated auth directory', async () => {
  const f = await fixture();
  try {
    const pull = { command: 'pull', reference, ...f.options };
    assert.equal(ociConfiguration(pull).registryDigest, registryDigest);
    for (const changed of [{ command: undefined }, { reference: `${repository}:latest` }, { reference: `${repository}:v1` }, { reference: `${repository}@sha256:abc` }, { reference: `https://${reference}` }, { imageId: 'camp-runtime:latest' }, { toolchainDigest: 'short' }, { dockerConfig: 'relative' }, { password: 'forbidden' }, { reference: `registry.example.test:70000/camp/runtime@${registryDigest}` }]) {
      assert.throws(() => ociConfiguration({ ...pull, ...changed }), { code: 'camp_oci_configuration' });
    }
    assert.throws(() => ociConfiguration({ command: 'publish', repository, tag: 'latest', ...f.options }), { code: 'camp_oci_configuration' });
    assert.throws(() => parseOciArguments(['pull', '--reference', reference, '--password', 'forbidden']), { code: 'camp_oci_configuration' });
    assert.throws(() => parseOciArguments(['pull', '--reference', reference, '--reference', reference]), { code: 'camp_oci_configuration' });
    assert.equal(parseOciArguments(['inspect', '--image-id', imageId]).command, 'inspect');
    const inherited = ociConfiguration({ command: 'inspect', imageId, toolchainDigest }, { DOCKER_CONFIG: f.config });
    assert.equal(inherited.dockerConfig, f.config);
  } finally { await f.close(); }
});

test('inspect is read only, verifies image and toolchain identity and excludes unrelated child secrets', async () => {
  const f = await fixture(), calls = [];
  try {
    const receipt = await deployOciImage({ command: 'inspect', ...f.options }, { env: { PATH: '/usr/bin', DEEPSEEK_API_KEY: 'never-forward', CAMP_WORKER_TOKEN: 'never-forward' }, run: async (command, args, options) => {
      calls.push({ command, args }); assert.equal(options.env.DOCKER_CONFIG, f.config); assert.equal(options.env.DEEPSEEK_API_KEY, undefined); assert.equal(options.env.CAMP_WORKER_TOKEN, undefined); return result(image());
    } });
    assert.deepEqual(calls, [{ command: 'docker', args: ['image', 'inspect', imageId] }]);
    assert.equal(receipt.runtimeImageId, imageId); assert.equal(receipt.toolchainDigest, toolchainDigest); assert.equal(receipt.registryDigest, undefined);
    for (const data of [image({ Id: registryDigest }), image({ Config: { Labels: { 'camp.toolchain.digest': 'e'.repeat(64) } } }), image({ Os: 'windows' }), '[]', 'invalid-json']) {
      await assert.rejects(deployOciImage({ command: 'inspect', ...f.options }, { run: async () => result(data) }), { code: 'camp_oci_image_identity' });
    }
  } finally { await f.close(); }
});

test('pull uses only the complete registry digest and independently verifies the preserved local image ID', async () => {
  const f = await fixture(), calls = [];
  try {
    const receipt = await deployOciImage({ command: 'pull', reference, ...f.options }, { run: async (command, args) => {
      calls.push(args);
      if (args[0] === 'manifest') return result(manifest);
      if (args[1] === 'pull') return result();
      return result(image());
    } });
    assert.deepEqual(calls, [['manifest', 'inspect', reference], ['image', 'pull', reference], ['image', 'inspect', reference]]);
    assert.equal(receipt.registryDigest, registryDigest); assert.equal(receipt.runtimeImageId, imageId); assert.notEqual(receipt.registryDigest, receipt.runtimeImageId);
    const mismatch = [];
    await assert.rejects(deployOciImage({ command: 'pull', reference, ...f.options }, { run: async (command, args) => {
      mismatch.push(args); return result(args[0] === 'manifest' ? manifest : args[1] === 'inspect' ? image({ Id: registryDigest }) : '');
    } }), { code: 'camp_oci_image_identity' });
    assert.equal(mismatch.some(args => ['tag', 'rm', 'rmi', 'run'].includes(args[1])), false, 'An incompatible pull cannot retag, execute or remove a candidate image');
  } finally { await f.close(); }
});

test('publish checks for existing tags before mutation and confirms its returned immutable reference', async () => {
  const f = await fixture(), calls = [];
  const tag = `camp-toolchain-${toolchainDigest.slice(0, 12)}`, tagged = `${repository}:${tag}`;
  try {
    const receipt = await deployOciImage({ command: 'publish', repository, tag, ...f.options }, { run: async (command, args) => {
      calls.push(args);
      if (args[0] === 'manifest') { if (args[2] === tagged) throw missing('manifest unknown'); return result(manifest); }
      if (args[1] === 'inspect') { if (args[2] === tagged) throw missing('No such image: unavailable'); return result(image()); }
      if (args[1] === 'push') return result(`${tag}: digest: ${registryDigest} size: 856\n`);
      return result();
    } });
    assert.equal(receipt.reference, reference); assert.equal(receipt.registryDigest, registryDigest); assert.equal(receipt.runtimeImageId, imageId);
    assert.deepEqual(calls.filter(args => ['tag', 'push'].includes(args[1])), [['image', 'tag', imageId, tagged], ['image', 'push', tagged]]);
    assert.ok(calls.find(args => args[0] === 'manifest' && args[2] === reference));
    assert.equal(calls.at(-1)[2], imageId, 'The exact original image remains available after publication');
  } finally { await f.close(); }
});

test('existing remote tags, ambiguous auth failures and conflicting local tags cannot be overwritten', async () => {
  const f = await fixture(), tag = 'version-1', tagged = `${repository}:${tag}`;
  try {
    for (const scenario of ['remote-exists', 'auth-failure', 'local-conflict']) {
      const mutations = [];
      await assert.rejects(deployOciImage({ command: 'publish', repository, tag, ...f.options }, { run: async (command, args) => {
        if (['tag', 'push'].includes(args[1])) mutations.push(args);
        if (args[0] === 'manifest') {
          if (scenario === 'remote-exists') return result(manifest);
          throw missing(scenario === 'auth-failure' ? 'unauthorized: secret-provider-detail' : 'manifest unknown');
        }
        return result(image(args[2] === tagged ? { Id: registryDigest } : {}));
      } }), { code: scenario === 'remote-exists' ? 'camp_oci_tag_exists' : scenario === 'auth-failure' ? 'camp_oci_registry_unavailable' : 'camp_oci_local_tag_conflict' });
      assert.equal(mutations.length, 0);
    }
  } finally { await f.close(); }
});

test('auth symlinks and public config modes fail before any Docker call', async () => {
  const f = await fixture(); let calls = 0;
  const run = async () => { calls++; return result(image()); };
  try {
    await chmod(join(f.config, 'config.json'), 0o644);
    await assert.rejects(deployOciImage({ command: 'inspect', ...f.options }, { run }), { code: 'camp_oci_auth_configuration' });
    await chmod(join(f.config, 'config.json'), 0o600);
    const alias = join(f.home, 'linked'); await symlink(f.config, alias);
    await assert.rejects(deployOciImage({ command: 'inspect', ...f.options, dockerConfig: alias }, { run }), { code: 'camp_oci_auth_configuration' });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('failed Docker calls expose fixed errors and incomplete registry receipts never become success', async () => {
  const f = await fixture();
  try {
    await assert.rejects(deployOciImage({ command: 'pull', reference, ...f.options }, { run: async () => { throw Object.assign(new Error('sensitive credentials'), { stderr: 'private-token' }); } }), error => error.code === 'camp_oci_registry_unavailable' && !JSON.stringify(error).includes('private-token') && !error.message.includes('sensitive'));
    const publish = { command: 'publish', repository, tag: 'version-2', ...f.options };
    await assert.rejects(deployOciImage(publish, { run: async (command, args) => {
      if (args[0] === 'manifest') throw missing('manifest unknown');
      if (args[1] === 'inspect') return result(image());
      return result();
    } }), { code: 'camp_oci_publish_receipt' });
    await assert.rejects(deployOciImage({ command: 'pull', reference, ...f.options }, { run: async () => result('{"schemaVersion":2,"manifests":[]}') }), { code: 'camp_oci_manifest_invalid' });
  } finally { await f.close(); }
});
