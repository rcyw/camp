import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { workerServiceConfiguration, renderWorkerService, verifyServiceRelease, validateWorkerService, installWorkerService, operateWorkerService, workerServiceMain } from './worker-service.mjs';

const execute = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const sample = () => ({ serviceName: 'camp-worker-pool', configDirectory: '/etc/camp/service', nodePath: '/usr/bin/node', releasePath: '/opt/camp/releases/abcdef', releaseManifestSha256: '1'.repeat(64), toolchainPath: '/opt/camp/toolchains/locked', toolchainDigest: '2'.repeat(64), imageId: 'sha256:' + '3'.repeat(64), apiOrigin: 'https://control.example:443', roomId: '11111111-2222-4333-8444-555555555555', workerId: 'my-persistent-pool', runtimeHome: '/var/lib/camp/worker', credentialFile: '/etc/camp/credential/worker.json', controlCaFile: '/etc/camp/control-ca.crt' });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'camp-service-')); t.after(() => rm(root, { recursive: true, force: true }));
  const c = { ...sample(), configDirectory: join(root, 'config'), nodePath: process.execPath, releasePath: join(root, 'release'), toolchainPath: join(root, 'toolchain'), runtimeHome: join(root, 'state'), credentialFile: join(root, 'private/worker.json'), controlCaFile: join(root, 'public/control.crt') };
  for (const folder of ['config', 'release', 'toolchain', 'state', 'private', 'public', 'units']) await mkdir(join(root, folder), { mode: ['release', 'toolchain', 'public', 'units'].includes(folder) ? 0o755 : 0o700 });
  await writeFile(c.credentialFile, JSON.stringify({ token: 'camp_worker_secret_test_value', roomId: c.roomId }), { mode: 0o600 });
  await execute('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', join(root, 'private/ca.key'), '-out', c.controlCaFile, '-days', '1', '-subj', '/CN=Camp test root', '-addext', 'basicConstraints=critical,CA:TRUE']);
  await chmod(c.controlCaFile, 0o644);
  const bytes = Buffer.from('export const fixture = true;\n');
  await writeFile(join(c.releasePath, 'sample.mjs'), bytes, { mode: 0o644 });
  const manifest = { schemaVersion: 1, kind: 'camp-worker-release', nodeMajor: 24, external: { toolchainDigest: c.toolchainDigest, imageId: c.imageId }, files: [{ path: 'sample.mjs', size: bytes.length, mode: 0o644, sha256: hash(bytes) }] };
  const text = JSON.stringify(manifest);
  await writeFile(join(c.releasePath, 'worker-release.json'), text, { mode: 0o644 }); c.releaseManifestSha256 = hash(text);
  const calls = [], run = async (command, args) => { calls.push({ command, args }); return { stdout: command === '/usr/bin/docker' ? c.imageId + '\n' : args[0] === '--version' ? 'v24.21.0\n' : args.includes('--property=ActiveState') ? 'inactive\n' : '', stderr: '' }; };
  return { root, c, calls, run, unitDirectory: join(root, 'units') };
}

test('configuration rejects argv/unit/origin injection and secret fields before any IO', async () => {
  const c = sample();
  for (const patch of [
    { apiOrigin: 'http://control.example' }, { apiOrigin: 'https://user:secret@control.example' }, { apiOrigin: 'https://control.example?token=secret' }, { apiOrigin: 'https://control.example/#secret' }, { apiOrigin: 'https://control.example/api' },
    { serviceName: '../ssh' }, { serviceName: 'sshd' }, { serviceName: 'camp-worker\nExecStart=/bad' }, { workerId: '--bad' },
    { nodePath: '/tmp/a;bad' }, { releasePath: '/tmp/a b' }, { releasePath: '/tmp/%H' }, { modelEnvFile: '/tmp/$HOME' }, { credentialFile: '/etc/../secret' },
    { token: 'secret' }, { modelKey: 'secret' }, { settings: { CAMP_WORKER_TOKEN: 'secret' } }, { settings: { CAMP_AGENT_MEMORY_MIB: '2048' } },
    { runtimeHome: c.releasePath + '/state' }, { credentialFile: c.toolchainPath + '/secret' }, { controlCaFile: c.credentialFile },
  ]) assert.throws(() => renderWorkerService({ ...c, ...patch }), { code: 'camp_worker_service_invalid' });
  await assert.rejects(workerServiceMain(['install', '--config', '/tmp/a\nsecret']), { code: 'camp_worker_service_invalid' });
  assert.equal(workerServiceConfiguration({ ...c, apiOrigin: 'https://CONTROL.example:443/' }).apiOrigin, 'https://CONTROL.example:443');
});

test('unit preserves manager lock namespace, credential renewal and durable recovery; contains no secret', () => {
  const c = { ...sample(), modelEnvFile: '/etc/camp/model.env', settings: { CAMP_AGENT_MEMORY_MIB: 1024 } };
  const { unit, environment } = renderWorkerService(c);
  assert.match(unit, /PrivateTmp=no/); assert.match(unit, /KillMode=mixed/); assert.match(unit, /TimeoutStopSec=180/); assert.match(unit, /Restart=on-abnormal/);
  assert.match(unit, /User=root/); assert.match(unit, /ReadWritePaths="\/var\/lib\/camp\/worker" "\/etc\/camp\/credential"/);
  assert.match(unit, /Environment=NODE_EXTRA_CA_CERTS=\/etc\/camp\/control-ca.crt/);
  assert.match(unit, /--env-file=\/etc\/camp\/model.env/); assert.match(unit, /--env-file=\/etc\/camp\/service\/worker.env/);
  assert.match(unit, /verify-worker-release.mjs/); assert.doesNotMatch(unit, /doctor.mjs|@oxc|--import|EnvironmentFile=|insecure-registry/);
  assert.match(environment, /CAMP_WORKER_CREDENTIAL_FILE=\/etc\/camp\/credential\/worker.json/);
  assert.match(environment, /CAMP_WORKER_ROOM_ID=11111111-2222-4333-8444-555555555555/);
  assert.match(unit, /UnsetEnvironment=.*CAMP_WORKER_ROOM_ID/);
  assert.match(environment, /CAMP_CONTROL_CA_FILE=\/etc\/camp\/control-ca.crt/);
  assert.match(environment, /CAMP_AGENT_MEMORY_MIB=1024/); assert.match(environment, /CAMP_POOL_ONCE=0/);
  assert.doesNotMatch(environment, /CAMP_WORKER_TOKEN=|DEEPSEEK_API_KEY=/);
});

test('all generated-file collisions and duplicate input roles are rejected without overwriting inputs', async t => {
  const c = sample();
  for (const key of ['credentialFile', 'controlCaFile', 'modelEnvFile', 'harnessManifest', 'nodePath']) {
    for (const name of ['worker.env', 'service-install.json', 'service-operation.lock']) {
      assert.throws(() => renderWorkerService({ ...c, [key]: join(c.configDirectory, name) }), { code: 'camp_worker_service_invalid' });
    }
  }
  assert.throws(() => renderWorkerService({ ...c, modelEnvFile: c.controlCaFile }), { code: 'camp_worker_service_invalid' });
  const { c: f } = await fixture(t), file = join(f.configDirectory, 'worker.env'), bytes = JSON.stringify(f);
  await writeFile(file, bytes, { mode: 0o600 });
  await assert.rejects(workerServiceMain(['render', '--config', file]), { code: 'camp_worker_service_invalid' });
  assert.equal(await readFile(file, 'utf8'), bytes);
});

test('CA preflight matches isolated agent trust: one pure self-signed root with a valid self signature', async t => {
  const { c, root, run } = await fixture(t), ca = await readFile(c.controlCaFile);
  await writeFile(c.controlCaFile, Buffer.concat([ca, ca]));
  await assert.rejects(validateWorkerService(c, { run }), { code: 'camp_worker_service_ca' });
  await writeFile(c.controlCaFile, Buffer.concat([Buffer.from('not a PEM certificate\n'), ca]));
  await assert.rejects(validateWorkerService(c, { run }), { code: 'camp_worker_service_ca' });
  await writeFile(c.controlCaFile, ca);
  const csr = join(root, 'private/child.csr'), child = join(root, 'public/child.crt'), extensions = join(root, 'private/child.ext');
  await writeFile(extensions, 'basicConstraints=critical,CA:TRUE\n');
  await execute('openssl', ['req', '-new', '-key', join(root, 'private/ca.key'), '-out', csr, '-subj', '/CN=Intermediate CA']);
  await execute('openssl', ['x509', '-req', '-in', csr, '-CA', c.controlCaFile, '-CAkey', join(root, 'private/ca.key'), '-set_serial', '2', '-days', '1', '-extfile', extensions, '-out', child]);
  await assert.rejects(validateWorkerService({ ...c, controlCaFile: child }, { run }), { code: 'camp_worker_service_ca' });
  await validateWorkerService(c, { run });
});

test('a model environment must supply a nonempty key under the actual Node dotenv parser', async t => {
  const { c, root, run, calls } = await fixture(t), model = join(root, 'private/model.env');
  for (const text of ['DEEPSEEK_API_KEY=\n', 'DEEPSEEK_API_KEY=""\n', "DEEPSEEK_API_KEY=''\n", 'DEEPSEEK_API_KEY= # comment\n', 'CAMP_DSH_MODEL=profile\n']) {
    await writeFile(model, text, { mode: 0o600 });
    await assert.rejects(validateWorkerService({ ...c, modelEnvFile: model }, { run }), { code: 'camp_worker_service_model_environment' });
  }
  assert.equal(calls.length, 0);
  await writeFile(model, 'DEEPSEEK_API_KEY="model_secret_not_printed"\n');
  await validateWorkerService({ ...c, modelEnvFile: model }, { run });
});

test('Room identity is immutable and a replaced credential cannot rebind a persistent Store', async t => {
  const { c, run, unitDirectory } = await fixture(t), otherRoom = '22222222-2222-4333-8444-555555555555';
  await installWorkerService(c, { run, unitDirectory });
  const record = JSON.parse(await readFile(join(c.configDirectory, 'service-install.json'), 'utf8'));
  assert.equal(record.identity.roomId, c.roomId);
  await writeFile(c.credentialFile, JSON.stringify({ token: 'replacement_secret', roomId: otherRoom }));
  await assert.rejects(validateWorkerService(c, { run }), { code: 'camp_worker_service_identity' });
  await assert.rejects(installWorkerService({ ...c, roomId: otherRoom }, { run, unitDirectory }), { code: 'camp_worker_service_identity' });
  await assert.rejects(operateWorkerService('start', { ...c, roomId: otherRoom }, { run, unitDirectory }), { code: 'camp_worker_service_identity' });
  assert.equal(JSON.parse(await readFile(join(c.configDirectory, 'service-install.json'), 'utf8')).identity.roomId, c.roomId);
});

test('release bootstrap checks reviewed manifest digest, bytes and complete inventory without executing code', async t => {
  const { c } = await fixture(t);
  assert.equal((await verifyServiceRelease(c)).nodeMajor, 24);
  await assert.rejects(verifyServiceRelease({ ...c, releaseManifestSha256: '0'.repeat(64) }), { code: 'camp_worker_service_release' });
  await writeFile(join(c.releasePath, 'extra.mjs'), 'throw new Error("must not execute")', { mode: 0o644 });
  await assert.rejects(verifyServiceRelease(c), { code: 'camp_worker_service_release' });
  await rm(join(c.releasePath, 'extra.mjs'));
  await writeFile(join(c.releasePath, 'sample.mjs'), 'changed');
  await assert.rejects(verifyServiceRelease(c), { code: 'camp_worker_service_release' });
});

test('secret files and path parents reject symlinks, shared permissions and model identity overrides', async t => {
  const { c, root, run, calls } = await fixture(t);
  await validateWorkerService(c, { run }); assert.equal(calls.length, 5);
  await chmod(c.credentialFile, 0o644);
  await assert.rejects(validateWorkerService(c, { run })); await chmod(c.credentialFile, 0o600);
  await chmod(join(root, 'private'), 0o755);
  await assert.rejects(validateWorkerService(c, { run })); await chmod(join(root, 'private'), 0o700);
  await symlink(c.credentialFile, join(root, 'private/link.json'));
  await assert.rejects(validateWorkerService({ ...c, credentialFile: join(root, 'private/link.json') }, { run }));
  const model = join(root, 'private/model.env');
  await writeFile(model, 'DEEPSEEK_API_KEY=top_secret_model_value\nCAMP_API_URL=https://wrong.example\n', { mode: 0o600 });
  const before = calls.length;
  await assert.rejects(validateWorkerService({ ...c, modelEnvFile: model }, { run }), error => error.code === 'camp_worker_service_model_environment' && !error.message.includes('top_secret'));
  assert.equal(calls.length, before);
  await writeFile(model, 'DEEPSEEK_API_KEY=top_secret_model_value\nCAMP_DSH_MODEL=profile\n');
  await validateWorkerService({ ...c, modelEnvFile: model }, { run });
  await assert.rejects(validateWorkerService({ ...c, controlCaFile: join(root, 'private/ca.key') }, { run }), { code: 'camp_worker_service_ca' });
});

test('install is explicit stopped-only, private and repeatable, preserving existing journal bytes', async t => {
  const f = await fixture(t), { c, run, unitDirectory, calls } = f;
  const journal = join(c.runtimeHome, 'outbox.json'); await writeFile(journal, '{"immutable":"completion"}\n', { mode: 0o600 });
  const result = await installWorkerService(c, { run, unitDirectory });
  assert.equal(result.started, false); assert.equal(result.enabled, false);
  assert.equal((await stat(join(c.configDirectory, 'worker.env'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(unitDirectory, c.serviceName + '.service'))).mode & 0o777, 0o644);
  assert.equal(await readFile(journal, 'utf8'), '{"immutable":"completion"}\n');
  assert.ok(!calls.some(call => call.args.includes('start') || call.args.includes('enable')));
  await installWorkerService(c, { run, unitDirectory });
  await operateWorkerService('start', c, { run, unitDirectory });
  assert.deepEqual(calls.at(-1), { command: '/usr/bin/systemctl', args: ['start', 'camp-worker-pool.service'] });
  await operateWorkerService('stop', c, { run, unitDirectory });
  assert.deepEqual(calls.at(-1).args, ['stop', 'camp-worker-pool.service']);
  assert.equal(await readFile(journal, 'utf8'), '{"immutable":"completion"}\n');
});

test('existing unit ownership, runtime identity and installed environment are enforced across upgrades', async t => {
  const { c, run, unitDirectory } = await fixture(t);
  const pool = join(c.runtimeHome, 'execution-pool.json');
  await writeFile(pool, JSON.stringify({ apiUrl: 'https://other.example', baseWorkerId: c.workerId }), { mode: 0o600 });
  await assert.rejects(installWorkerService(c, { run, unitDirectory }), { code: 'camp_worker_service_identity' }); await rm(pool);
  await writeFile(join(unitDirectory, c.serviceName + '.service'), 'foreign unit', { mode: 0o644 });
  await assert.rejects(installWorkerService(c, { run, unitDirectory }), { code: 'camp_worker_service_identity' }); await rm(join(unitDirectory, c.serviceName + '.service'));
  await installWorkerService(c, { run, unitDirectory });
  await assert.rejects(installWorkerService({ ...c, apiOrigin: 'https://other.example' }, { run, unitDirectory }), { code: 'camp_worker_service_identity' });
  await assert.rejects(operateWorkerService('start', { ...c, settings: { CAMP_AGENT_MEMORY_MIB: 1024 } }, { run, unitDirectory }), { code: 'camp_worker_service_identity' });
  await writeFile(join(c.configDirectory, 'worker.env'), 'CAMP_WORKER_TOKEN=secret_override\n');
  await assert.rejects(operateWorkerService('start', c, { run, unitDirectory }), { code: 'camp_worker_service_identity' });
  // An operator may still stop the verified own unit to inspect bad config.
  await operateWorkerService('stop', c, { run, unitDirectory });
});

test('active service is not overwritten and public errors never expose command stderr', async t => {
  const { c, run, calls, unitDirectory } = await fixture(t);
  const active = async (command, args) => args.includes('--property=ActiveState') ? { stdout: 'active\n' } : run(command, args);
  await assert.rejects(installWorkerService(c, { run: active, unitDirectory }), { code: 'camp_worker_service_active' });
  assert.equal(calls.some(call => call.args.includes('daemon-reload')), false);
  await assert.rejects(readFile(join(unitDirectory, c.serviceName + '.service')), { code: 'ENOENT' });
});

test('simultaneous operator actions serialize and a stale install lock fails closed', async t => {
  const { c, run, unitDirectory } = await fixture(t);
  await installWorkerService(c, { run, unitDirectory });
  let entered, finish;
  const pending = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { finish = resolve; });
  const deferred = async (command, args) => { if (args[0] === 'stop') { entered(); await released; } return run(command, args); };
  const first = operateWorkerService('stop', c, { run: deferred, unitDirectory });
  await pending;
  await assert.rejects(operateWorkerService('start', c, { run, unitDirectory }), { code: 'camp_worker_service_busy' });
  finish(); await first;
  await mkdir(join(c.configDirectory, 'service-operation.lock'), { mode: 0o700 });
  await assert.rejects(installWorkerService(c, { run, unitDirectory }), { code: 'camp_worker_service_busy' });
});

test('wrong local image and deployment configuration drift are rejected without starting a service', async t => {
  const { c, run, calls, unitDirectory } = await fixture(t);
  const wrong = (command, args) => command === '/usr/bin/docker' ? Promise.resolve({ stdout: 'sha256:' + '0'.repeat(64) }) : run(command, args);
  await assert.rejects(installWorkerService(c, { run: wrong, unitDirectory }), { code: 'camp_worker_service_image' });
  assert.ok(!calls.some(call => call.command === '/usr/bin/systemctl'));
  await installWorkerService(c, { run, unitDirectory });
  await assert.rejects(operateWorkerService('start', { ...c, releaseManifestSha256: 'a'.repeat(64) }, { run, unitDirectory }), { code: 'camp_worker_service_identity' });
  await operateWorkerService('disable', c, { run, unitDirectory });
  assert.deepEqual(calls.at(-1).args, ['disable', 'camp-worker-pool.service']);
});

test('generated unit passes actual systemd syntax validation with a compiled release entry', async t => {
  const { c, root } = await fixture(t), node = process.execPath;
  const dir = join(c.releasePath, 'packages/camp-runtime/scripts'); await mkdir(dir, { recursive: true, mode: 0o755 });
  await writeFile(join(dir, 'worker-pool.mjs'), ''); await writeFile(join(dir, 'verify-worker-release.mjs'), '');
  const { unit } = renderWorkerService({ ...c, nodePath: node });
  const file = join(root, 'camp-worker-pool.service'); await writeFile(file, unit);
  try { await execute('systemd-analyze', ['verify', '--man=no', file], { timeout: 15000 }); }
  catch (error) { assert.fail('systemd syntax validation failed: ' + error.stderr); }
});
