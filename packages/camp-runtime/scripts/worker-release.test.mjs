import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorkerRelease, verifyWorkerRelease, WORKER_RELEASE_FILES, WORKER_RELEASE_ACP_SOURCE, WORKER_RELEASE_ACP_OUTPUT, WORKER_RELEASE_MANIFEST } from '../src/worker-release.mjs';

const execute = promisify(execFile), sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
const commit = 'a'.repeat(40), toolchainDigest = 'b'.repeat(64), imageId = 'sha256:' + 'c'.repeat(64);
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'camp-worker-release-')); t.after(() => rm(home, { recursive: true, force: true }));
  const output = join(home, 'release');
  const build = overrides => buildWorkerRelease({ output, sourceCommit: commit, toolchainDigest, imageId, ...overrides });
  return { home, output, build };
}
async function copiedSource(home) {
  const copied = join(home, 'source');
  for (const path of [...WORKER_RELEASE_FILES, WORKER_RELEASE_ACP_SOURCE]) {
    await mkdir(dirname(join(copied, path)), { recursive: true }); await writeFile(join(copied, path), await readFile(join(sourceRoot, path)));
  }
  return copied;
}
async function replaceManifest(output, transform) {
  const path = join(output, WORKER_RELEASE_MANIFEST), manifest = JSON.parse(await readFile(path, 'utf8'));
  transform(manifest); await writeFile(path, JSON.stringify(manifest) + '\n');
}

test('a release imports Worker and keyless doctor/ops and completes real fake-ACP traffic outside the repository with no loader or dependencies', async t => {
  const f = await fixture(t), built = await f.build();
  assert.equal(built.manifest.source.commit, commit); assert.equal(built.manifest.source.acpPath, WORKER_RELEASE_ACP_SOURCE);
  assert.deepEqual(built.manifest.external, { toolchainDigest, imageId });
  assert.ok(built.manifest.files.some(file => file.path === WORKER_RELEASE_ACP_OUTPUT));
  assert.equal(built.manifest.files.some(file => /node_modules|\.env$|\.local|daemon\/src/.test(file.path)), false);
  assert.equal(built.manifest.files.length, WORKER_RELEASE_FILES.length + 1);
  const descriptor = JSON.parse(await readFile(join(f.output, 'packages/camp-runtime/package.json'), 'utf8'));
  assert.equal(JSON.stringify(descriptor).includes('@oxc'), false); assert.equal('build:bundle' in descriptor.scripts, false);
  assert.equal(descriptor.scripts.worker, 'node src/worker.mjs'); assert.equal(descriptor.scripts['worker:pool'], 'node scripts/worker-pool.mjs');
  assert.equal('dependencies' in descriptor, false); assert.equal('devDependencies' in descriptor, false);
  assert.match(built.manifest.source.runtimePackageSha256, /^[a-f0-9]{64}$/);
  const peer = join(f.home, 'fake-acp.mjs'); await writeFile(peer, await readFile(join(sourceRoot, 'packages/daemon/src/testdata/dsh-acp-fixture.mjs')));
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: f.home, CAMP_RUNTIME_HOME: join(f.home, 'state') };
  const program = `
    import assert from 'node:assert/strict';
    const worker = await import('./packages/camp-runtime/src/worker.mjs');
    const pool = await import('./packages/camp-runtime/src/worker-pool.mjs');
    const ops = await import('./packages/camp-runtime/src/worker-ops.mjs');
    const preflight = await import('./packages/camp-runtime/src/worker-preflight.mjs');
    const acp = await import('./${WORKER_RELEASE_ACP_OUTPUT}');
    const {loadDshRuntimeSession} = await import('./packages/camp-runtime/src/dsh-session-loader.mjs');
    assert.equal(typeof worker.startWorker, 'function'); assert.equal(typeof pool.startWorkerPool, 'function');
    assert.equal(typeof ops.reapWorker, 'function'); assert.equal(typeof preflight.inspectWorker, 'function');
    assert.equal(await loadDshRuntimeSession(), acp.createDshRuntimeSession);
    assert.equal(acp.dshChildEnvironment({CAMP_WORKER_TOKEN:'never-forward',SAFE:'visible'}).CAMP_WORKER_TOKEN, undefined);
    assert.equal(new acp.DshAcpError('compiled parameter property', 7).code, 7);
    const factory = await loadDshRuntimeSession(), events = [];
    const session = factory({command:process.execPath,args:[process.argv[1]],cwd:process.cwd(),handshakeTimeoutMs:1000,cancelGraceMs:50,env:{PATH:process.env.PATH,LANG:'C.UTF-8',CAMP_WORKER_TOKEN:'supervisor-fixture',CAMP_RUN_TOKEN:'run-fixture'}});
    let timer; const ended = new Promise((resolve,reject) => {timer=setTimeout(()=>reject(new Error('Generated ACP turn deadline')),3000);session.on('error',reject);session.on('runtime_event',event=>{events.push(event);if(event.kind==='turn_end')resolve();});});
    ended.catch(()=>{});
    try {assert.equal((await session.start({text:'Use the bounded room tool'})).ok,true);await ended;assert.ok(events.some(event=>event.kind==='text'&&event.text==='worker=false;run=true'));assert.equal(events.some(event=>event.kind==='text'&&event.text==='FOREIGN'),false);}
    finally {clearTimeout(timer);await session.stop();}
    assert.equal(session.isAlive(),false);
    console.log('DEPENDENCY_FREE_IMPORT_PASSED');
  `;
  const imported = await execute(process.execPath, ['--input-type=module', '-e', program, peer], { cwd: f.output, env, timeout: 10000 });
  assert.equal(imported.stdout.trim(), 'DEPENDENCY_FREE_IMPORT_PASSED');
  const initialized = await execute(process.execPath, ['packages/camp-runtime/scripts/worker-ops.mjs', 'init'], { cwd: f.output, env, timeout: 10000 });
  assert.equal(JSON.parse(initialized.stdout).modelCalls, 0); assert.equal((await stat(env.CAMP_RUNTIME_HOME)).mode & 0o777, 0o700);
  const doctor = await execute(process.execPath, ['packages/camp-runtime/scripts/doctor.mjs', '--not-a-real-flag'], { cwd: f.output, env, timeout: 10000 }).then(() => null, error => error);
  assert.equal(doctor.code, 2); assert.match(doctor.stderr, /Usage:/); assert.equal(doctor.stderr.includes('ERR_MODULE_NOT_FOUND'), false);
  const verified = await execute(process.execPath, ['packages/camp-runtime/scripts/verify-worker-release.mjs', '--release', f.output, '--manifest-sha256', built.digest], { cwd: f.output, env, timeout: 10000 });
  assert.equal(JSON.parse(verified.stdout).sourceCommit, commit);
});

test('build reserves a fresh output, refuses linked parents and does not overwrite an existing tree', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'unchanged');
  await assert.rejects(f.build(), { code: 'EEXIST' }); assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'unchanged');
  const linked = join(f.home, 'linked'); await symlink(f.home, linked);
  await assert.rejects(f.build({ output: join(linked, 'nested') }), /symbolic links/);
  await assert.rejects(readFile(join(f.home, 'nested', WORKER_RELEASE_MANIFEST)), { code: 'ENOENT' });
});

test('build rejects linked input files and directories and removes its own incomplete output', async t => {
  const f = await fixture(t), copied = await copiedSource(f.home), path = join(copied, 'packages/camp-runtime/src/worker.mjs');
  await rm(path); await symlink(join(sourceRoot, 'packages/camp-runtime/src/worker.mjs'), path);
  await assert.rejects(f.build({ sourceRoot: copied })); await assert.rejects(stat(f.output), { code: 'ENOENT' });
  await rm(path); await writeFile(path, await readFile(join(sourceRoot, 'packages/camp-runtime/src/worker.mjs')));
  const protocol = join(copied, 'packages/camp-protocol'); await rm(protocol, { recursive: true }); await symlink(join(sourceRoot, 'packages/camp-protocol'), protocol);
  await assert.rejects(f.build({ sourceRoot: copied }), /symbolic links/); await assert.rejects(stat(f.output), { code: 'ENOENT' });
});

test('exact release modes survive restrictive umask and tampered file permissions fail verification', async t => {
  const f = await fixture(t), mask = process.umask(0o077); let built;
  try { built = await f.build(); } finally { process.umask(mask); }
  assert.equal((await stat(f.output)).mode & 0o7777, 0o755);
  const path = join(f.output, WORKER_RELEASE_ACP_OUTPUT); assert.equal((await stat(path)).mode & 0o7777, 0o644);
  await chmod(path, 0o664); await assert.rejects(verifyWorkerRelease(f.output, { expectedDigest: built.digest }), /permissions differ/);
  await chmod(path, 0o4644); await assert.rejects(verifyWorkerRelease(f.output), /permissions differ/);
});

test('verification pins publisher manifest and provenance, then detects changed bytes and unlisted data', async t => {
  const f = await fixture(t), built = await f.build();
  await assert.rejects(verifyWorkerRelease(f.output, { expectedDigest: 'd'.repeat(64) }), /manifest digest/);
  await assert.rejects(verifyWorkerRelease(f.output, { expectedSourceCommit: 'e'.repeat(40) }), /provenance/);
  await assert.rejects(verifyWorkerRelease(f.output, { expectedToolchainDigest: 'e'.repeat(64) }), /deployment/);
  await assert.rejects(verifyWorkerRelease(f.output, { expectedImageId: 'sha256:' + 'e'.repeat(64) }), /deployment/);
  await writeFile(join(f.output, 'private.env'), 'DO_NOT_DISTRIBUTE=fixture'); await assert.rejects(verifyWorkerRelease(f.output), /unexpected file/); await rm(join(f.output, 'private.env'));
  const path = join(f.output, 'packages/camp-protocol/src/index.js'); await writeFile(path, 'export const tampered = true;\n');
  await assert.rejects(verifyWorkerRelease(f.output, { expectedDigest: built.digest }), /file hash/);
});

for (const malicious of ['../outside', '/tmp/outside', 'packages/camp-runtime/src/../worker.mjs', 'packages\\camp-runtime\\worker.mjs']) test(`manifest traversal is rejected before packaged code can load: ${malicious}`, async t => {
  const f = await fixture(t); await f.build(); await replaceManifest(f.output, value => { value.files[0].path = malicious; });
  await assert.rejects(verifyWorkerRelease(f.output), /relative paths/);
});

test('matching hashes cannot authorize symlinks, special files or extra empty directories', async t => {
  const f = await fixture(t); await f.build();
  const path = join(f.output, WORKER_RELEASE_ACP_OUTPUT), backup = join(f.home, 'same-bytes.mjs'); await writeFile(backup, await readFile(path));
  await rm(path); await symlink(backup, path); await assert.rejects(verifyWorkerRelease(f.output), /link or special/);
  const { loadDshRuntimeSession } = await import(pathToFileURL(join(f.output, 'packages/camp-runtime/src/dsh-session-loader.mjs')).href);
  await assert.rejects(loadDshRuntimeSession(), /ordinary release file/);
  await rm(path); await execute('mkfifo', [path]); await assert.rejects(verifyWorkerRelease(f.output), /link or special/); await rm(path);
  await writeFile(path, await readFile(backup), { mode: 0o644 }); await mkdir(join(f.output, 'node_modules'));
  await assert.rejects(verifyWorkerRelease(f.output), /unexpected file, directory/);
});

test('only explicit valid build metadata is accepted; invalid ACP never publishes a release', async t => {
  const f = await fixture(t);
  await assert.rejects(f.build({ sourceCommit: 'main' }), /explicit output/);
  await assert.rejects(f.build({ imageId: 'camp:latest' }), /exact image ID/);
  const copied = await copiedSource(f.home); await writeFile(join(copied, WORKER_RELEASE_ACP_SOURCE), 'export this is invalid TypeScript!');
  await assert.rejects(f.build({ sourceRoot: copied })); await assert.rejects(stat(f.output), { code: 'ENOENT' });
});
