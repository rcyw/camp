import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, access, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toolchainLock, hostAbi, assertHostAbi, artifactInventory, loadToolchain, regularBytes, sha256, runtimePackage } from '../src/toolchain.mjs';
import { assertTrackedNativeInputs, checkLayerfsSource, copySdkFromGit, packDsh } from '../src/toolchain-build.mjs';
import { lockedBase } from '../src/image-build.mjs';
import { runLocalChecks, supportsLayerfsDocker } from '../src/local-doctor.mjs';
import { CampRuntime } from '../src/index.mjs';

const execute = promisify(execFile);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'camp-toolchain-test-'));
  const bundle = join(root, 'bundle');
  for (const path of ['layerfs/sdk/src/index.js', 'layerfs/layerfs.node', 'layerfs/layerfs-daemon', 'layerfs/Cargo.lock', 'licenses/LayerFS-LICENSE', 'licenses/DSH-LICENSE', 'licenses/Camp-LICENSE', 'licenses/Rust-dependencies.json', 'dsh-runtime.tar', 'dsh-package-lock.json', 'dsh-plugin.tar', 'camp-protocol.tar']) {
    const file = join(bundle, path);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, `fixture ${path}\n`, { mode: 0o600 });
  }
  // These two inputs really are pinned; the remaining fixture artifacts are
  // tiny because this test verifies identity/admission rather than compilation.
  await copyFile(join(runtimePackage, 'toolchain/dsh/package-lock.json'), join(bundle, 'dsh-package-lock.json'));
  await copyFile(join(runtimePackage, 'toolchain/layerfs/Cargo.lock'), join(bundle, 'layerfs/Cargo.lock'));
  const manifest = { schemaVersion: 1, kind: 'camp-toolchain', inputs: { layerfs: toolchainLock.layerfs, dsh: toolchainLock.dsh }, host: hostAbi(), files: await artifactInventory(bundle) };
  async function save() { await writeFile(join(bundle, 'manifest.json'), JSON.stringify(manifest)); }
  await save();
  return { root, bundle, manifest, save, async close() { await rm(root, { recursive: true, force: true }); } };
}
test('relocated bundle verifies exact artifacts without its source checkout', async () => {
  const f = await fixture();
  try {
    const selected = await loadToolchain(f.bundle);
    assert.equal(selected.digest, sha256(await readFile(join(f.bundle, 'manifest.json'))));
    assert.equal(selected.sdkEntry, join(f.bundle, 'layerfs/sdk/src/index.js'));
    const runtime = new CampRuntime({ home: join(f.root, 'state'), toolchainBundle: f.bundle, imageId: `sha256:${'a'.repeat(64)}` });
    await runtime.ready();
    assert.equal(runtime.toolchain.digest, selected.digest);
    assert.equal(runtime.source, null);
  } finally { await f.close(); }
});
test('corrupt artifact and changed executable mode fail before execution', async () => {
  const f = await fixture();
  try {
    const file = join(f.bundle, 'layerfs/layerfs.node');
    await writeFile(file, 'corrupted');
    await assert.rejects(loadToolchain(f.bundle), /differs from its manifest/);
    await writeFile(file, 'fixture layerfs/layerfs.node\n');
    await chmod(file, 0o700);
    await assert.rejects(loadToolchain(f.bundle), /differs from its manifest/);
  } finally { await f.close(); }
});
test('bundle selection uses its verified binaries for retained local project records', async () => {
  const f = await fixture();
  try {
    const runtime = new CampRuntime({ toolchainBundle: f.bundle });
    const previous = { native: '/retained/old.node', daemon: '/retained/old-daemon', storePath: '/retained/store.sqlite' };
    const selected = await runtime.sdkConfig(previous);
    assert.equal(selected.native, join(f.bundle, 'layerfs/layerfs.node'));
    assert.equal(selected.daemon, join(f.bundle, 'layerfs/layerfs-daemon'));
    assert.equal(selected.storePath, previous.storePath);
    assert.equal(previous.native, '/retained/old.node');
    const dev = new CampRuntime({ layerfsSource: f.root });
    assert.equal(await dev.sdkConfig(previous), previous);
  } finally { await f.close(); }
});
test('unexpected files, symlinks and manifest traversal cannot join a bundle', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.bundle, 'extra'), 'unexpected');
    await assert.rejects(loadToolchain(f.bundle), /differs from its manifest/);
    await rm(join(f.bundle, 'extra'));
    await symlink('/etc/passwd', join(f.bundle, 'link'));
    await assert.rejects(loadToolchain(f.bundle), /links or special/);
    await rm(join(f.bundle, 'link'));
    f.manifest.files[0].path = '../outside'; await f.save();
    await assert.rejects(loadToolchain(f.bundle), /artifact identity/);
  } finally { await f.close(); }
});
test('locked input and host ABI mismatches fail closed', async () => {
  const f = await fixture();
  try {
    f.manifest.inputs = { ...f.manifest.inputs, layerfs: { ...f.manifest.inputs.layerfs, revision: '0'.repeat(40) } }; await f.save();
    await assert.rejects(loadToolchain(f.bundle), /locked versions/);
    assert.throws(() => assertHostAbi({ ...hostAbi(), arch: 'other' }), /Node ABI/);
    assert.throws(() => assertHostAbi({ ...hostAbi(), glibc: '999.1' }), /glibc is older/);
    assert.doesNotThrow(() => assertHostAbi(hostAbi()));
  } finally { await f.close(); }
});
test('metadata FIFO is refused without waiting for a writer', async () => {
  const f = await fixture();
  try {
    const fifo = join(f.root, 'fifo'); await execute('mkfifo', [fifo]);
    const module = new URL('../src/toolchain.mjs', import.meta.url).href;
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `import {regularBytes} from ${JSON.stringify(module)};try{await regularBytes(process.argv[1]);process.exit(2)}catch{console.log('rejected')}`, fifo], { timeout: 2000 });
    assert.equal(stdout.trim(), 'rejected');
    await assert.rejects(regularBytes(join(f.root, 'missing')));
  } finally { await f.close(); }
});
test('development source is explicit, pinned build rejects another Git revision', async () => {
  const f = await fixture();
  try {
    await assert.rejects(checkLayerfsSource(), /must explicitly name/);
    const checkout = join(f.root, 'wrong-source'); await mkdir(checkout);
    await execute('git', ['init', '-q', checkout]);
    await execute('git', ['-C', checkout, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-qm', 'fixture']);
    await assert.rejects(checkLayerfsSource(checkout), /locked revision/);
    assert.match(lockedBase('x64'), /^node:24\.16\.0-trixie@sha256:[a-f0-9]{64}$/);
    assert.throws(() => lockedBase('unknown'), /no pinned base/);
  } finally { await f.close(); }
});
test('SDK packaging reads the frozen Git tree and excludes ignored, untracked and changed worktree modules', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'checkout'), destination = join(f.root, 'sdk');
    await mkdir(join(source, 'sdk/js/src'), { recursive: true });
    await writeFile(join(source, 'sdk/js/package.json'), '{"type":"module"}\n');
    await writeFile(join(source, 'sdk/js/src/index.js'), 'export const pinned = true;\n');
    await writeFile(join(source, 'sdk/js/src/executable.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    await writeFile(join(source, '.gitignore'), 'ignored.js\n');
    await execute('git', ['init', '-q', source]);
    await execute('git', ['-C', source, 'add', '.']);
    await execute('git', ['-C', source, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'pinned SDK']);
    const revision = (await execute('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    await writeFile(join(source, 'sdk/js/src/index.js'), 'export const pinned = false;\n');
    await writeFile(join(source, 'sdk/js/src/untracked.js'), 'untracked secret\n');
    await writeFile(join(source, 'sdk/js/src/ignored.js'), 'ignored secret\n');
    const previousMask = process.umask(0o077);
    try { await copySdkFromGit({ source, destination, revision }); }
    finally { process.umask(previousMask); }
    assert.equal(await readFile(join(destination, 'src/index.js'), 'utf8'), 'export const pinned = true;\n');
    assert.equal(await readFile(join(destination, 'package.json'), 'utf8'), '{"type":"module"}\n');
    assert.equal((await stat(join(destination, 'src/executable.js'))).mode & 0o777, 0o755);
    assert.equal((await stat(join(destination, 'src/index.js'))).mode & 0o777, 0o644);
    for (const name of ['untracked.js', 'ignored.js']) await assert.rejects(access(join(destination, 'src', name)), { code: 'ENOENT' });
    await symlink('/etc/passwd', join(source, 'sdk/js/src/link.js'));
    await execute('git', ['-C', source, 'add', 'sdk/js/src/link.js']);
    await execute('git', ['-C', source, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'unsupported link']);
    await assert.rejects(copySdkFromGit({ source, destination: join(f.root, 'reject-links'), revision: 'HEAD' }), /regular files/);
    await assert.rejects(access(join(f.root, 'reject-links')), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('native build rejects Cargo auto-discovered or ignored inputs without rejecting ordinary workspace caches', async () => {
  const f = await fixture();
  try {
    const source = join(f.root, 'native-checkout');
    await mkdir(join(source, 'core/crates/layerfs-daemon/src'), { recursive: true });
    await writeFile(join(source, 'core/crates/layerfs-daemon/Cargo.toml'), '[package]\nname="layerfs-daemon"\nversion="1.0.0"\n');
    await writeFile(join(source, 'core/crates/layerfs-daemon/src/main.rs'), 'fn main() {}\n');
    await writeFile(join(source, '.gitignore'), '*.ignored.rs\ntarget/\n');
    await execute('git', ['init', '-q', source]);
    await execute('git', ['-C', source, 'add', '.']);
    await execute('git', ['-C', source, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'pinned native inputs']);
    for (const name of ['core/target/debug/cache', 'core/target-linux/cache', 'target/cache', 'core/docs/local-evidence']) {
      await mkdir(join(source, name, '..'), { recursive: true });
      await writeFile(join(source, name), 'not a compiler input');
    }
    await assertTrackedNativeInputs(source);
    for (const name of ['core/crates/layerfs-daemon/build.rs', 'core/crates/layerfs-daemon/src/bin/injected.rs', 'core/vendor/dependency/injected.ignored.rs', 'sdk/js/native/build.rs', '.cargo/config']) {
      await mkdir(join(source, name, '..'), { recursive: true });
      await writeFile(join(source, name), 'untracked compiler input');
      assert.equal((await execute('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])).stdout, '');
      await assert.rejects(assertTrackedNativeInputs(source), /untracked or ignored files/);
      await rm(join(source, name));
    }
    await assertTrackedNativeInputs(source);
  } finally { await f.close(); }
});
test('DSH packing rejects a changed lock or installed version', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'package-lock.json'), '{}');
    await assert.rejects(packDsh({ prefix: f.root }), /dependency lock differs/);
    await copyFile(join(runtimePackage, 'toolchain/dsh/package-lock.json'), join(f.root, 'package-lock.json'));
    await mkdir(join(f.root, 'node_modules/@deepseek-ai/dsh'), { recursive: true });
    await writeFile(join(f.root, 'node_modules/@deepseek-ai/dsh/package.json'), '{"version":"unexpected"}');
    await assert.rejects(packDsh({ prefix: f.root }), /version differs/);
  } finally { await f.close(); }
});
test('local doctor is read-only and produces only bounded secret-free check facts', async () => {
  const f = await fixture();
  try {
    const home = join(f.root, 'new-state');
    const native = join(f.root, 'binding.cjs');
    await writeFile(native, 'exports.call=()=>{};exports.storeOpen=()=>{};');
    const sdkEntry = join(f.root, 'sdk.js'); await writeFile(sdkEntry, '');
    const id = `sha256:${'a'.repeat(64)}`;
    const runtime = { home, source: f.root, native, daemon: native, sdkEntry, imageId: id, dockerCall: async args => ({ stdout: JSON.stringify(args[0] === 'version' ? { Os: 'linux', ApiVersion: '1.55' } : [{ Id: id, Os: 'linux', Architecture: process.arch === 'x64' ? 'amd64' : 'arm64' }]) }) };
    const value = await runLocalChecks({ runtime, env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: 'secret-fixture', CAMP_DSH_PLUGIN: join(f.root, 'bad-plugin') } });
    assert.deepEqual(value.checks.map(item => item.id), ['platform', 'node', 'host_tools', 'runtime_home', 'toolchain', 'docker', 'fuse', 'image', 'plugin', 'harnesses', 'source', 'capacity']);
    assert.equal(value.checks.find(item => item.id === 'toolchain').code, 'development_checkout');
    assert.equal(value.checks.find(item => item.id === 'plugin').status, 'failed');
    assert.equal(value.checks.find(item => item.id === 'capacity').status, 'skipped');
    assert.equal(value.checks.find(item => item.id === 'source').code, 'default_seed');
    assert(!JSON.stringify(value).includes('secret-fixture'));
    assert(!JSON.stringify(value).includes(f.root));
    assert(value.checks.every(item => Object.keys(item).sort().join(',') === 'code,id,status'));
    await assert.rejects(access(home), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('Docker readiness checks its full API range rather than decimal versions', () => {
  assert.equal(supportsLayerfsDocker({ Os: 'linux', ApiVersion: '1.100', MinAPIVersion: '1.40' }), true);
  assert.equal(supportsLayerfsDocker({ Os: 'linux', ApiVersion: '1.55', MinAPIVersion: '1.55' }), false);
  assert.equal(supportsLayerfsDocker({ Os: 'linux', ApiVersion: '1.53', MinAPIVersion: '1.40' }), false);
  assert.equal(supportsLayerfsDocker({ Os: 'linux', ApiVersion: 'garbled' }), false);
});
