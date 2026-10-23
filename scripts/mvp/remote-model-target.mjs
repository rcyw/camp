// Read-only service/evidence probes plus one fresh fixture installer. This
// helper never starts a Worker, imports a session factory, or reads model keys.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { verifyWorkerRelease } from '../../packages/camp-runtime/src/worker-release.mjs';
import { WorkerJournal, stateKey } from '../../packages/camp-runtime/src/durable-state.mjs';
import { readWorkerCredential } from '../../packages/camp-runtime/src/worker-credentials.mjs';
import { hash, modelFixture, modelContract, modelHarnessMode, standardModelWorkerCommand } from './remote-model-fixture.mjs';

const execute = promisify(execFile);
export async function writeModelContract(file, bytes) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, modelHarnessMode);
  try { await handle.writeFile(bytes); await handle.chmod(modelHarnessMode); await handle.sync(); }
  finally { await handle.close(); }
}
async function privateJson(path, maximum = 1024 * 1024) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size <= maximum); return JSON.parse(await file.readFile('utf8')); }
  finally { await file.close(); }
}
export async function remoteModelTarget(action, operation) {
  assert.ok(typeof operation === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(operation) && resolve(operation) === operation && await realpath(operation) === operation);
  const config = await privateJson(join(operation, 'config.json'));
  const release = await verifyWorkerRelease(config.release, { expectedDigest: config.releaseDigest, expectedImageId: config.imageId, expectedToolchainDigest: config.toolchainDigest });
  const fixture = modelFixture(config.name), contract = modelContract(fixture);
  assert.equal(hash(contract), config.harnessSha256);
  let result;
  if (action === 'prepare') {
    const credential = await readWorkerCredential(join(operation, 'credential.json'));
    assert.equal(credential.roomId, config.roomId);
    await mkdir(join(operation, 'source'), { mode: 0o700 });
    for (const directory of ['foundation', 'left', 'right']) await mkdir(join(operation, 'source', directory), { mode: 0o755 });
    for (const [name, bytes] of Object.entries(fixture.files)) await writeFile(join(operation, 'source', name), bytes, { flag: 'wx', mode: 0o644 });
    await writeModelContract(join(operation, 'contract.mjs'), contract);
    await writeFile(join(operation, 'harnesses.json'), JSON.stringify([{ id: fixture.harnessId, path: join(operation, 'contract.mjs') }]), { flag: 'wx', mode: 0o600 });
    result = { prepared: true, credentialPrepared: true, sourceHashes: fixture.sourceHashes, releaseDigest: release.digest, modelKeysRead: false, managerStarted: false };
  } else if (action === 'service' || action === 'evidence') {
    const service = await serviceFacts(config.serviceName, config.release);
    const runtime = new CampRuntime({ home: join(operation, 'runtime'), imageId: config.imageId, toolchainBundle: config.toolchain });
    const dockerId = (await runtime.dockerCall(['info', '--format', '{{.ID}}'], { timeout: 10000 })).stdout.trim();
    const host = { machineIdHash: hash((await readFile('/etc/machine-id', 'utf8')).trim()), bootIdHash: hash((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()), dockerIdHash: hash(dockerId) };
    if (action === 'service') {
      const response = await fetch(config.workerApiUrl + '/health', { redirect: 'error', signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200); await response.json();
      result = { service, host, releaseDigest: release.digest, httpsHealth: 200 };
    } else {
      let raw = ''; for await (const bytes of process.stdin) { raw += bytes; assert.ok(Buffer.byteLength(raw) <= 4096); }
      const input = JSON.parse(raw); assert.deepEqual(Object.keys(input), ['goalId']); assert.match(input.goalId, /^[a-f0-9-]{36}$/);
      const workers = await readdir(join(runtime.home, 'workers')); assert.ok(workers.length <= 10);
      const pool = await privateJson(join(runtime.home, 'execution-pool.json'));
      const allowed = new Set([config.workerId, ...pool.workerIds]); const records = [];
      for (const folder of workers) {
        assert.match(folder, /^[a-f0-9]{32}$/);
        const metadata = await privateJson(join(runtime.home, 'workers', folder, 'worker.json'), 65536);
        assert.equal(metadata.apiUrl, config.workerApiUrl); assert.ok(allowed.has(metadata.workerId)); assert.equal(stateKey(metadata.apiUrl + '\n' + metadata.workerId), folder);
        const journal = new WorkerJournal({ home: runtime.home, apiUrl: metadata.apiUrl, workerId: metadata.workerId });
        for (const record of await journal.list()) if (record.goalId === input.goalId && record.roomId === config.roomId) records.push({ runId: record.runId, epoch: record.epoch, role: record.role, executor: record.executor, phase: record.phase, cleanupKnown: record.cleanupKnown, modelUsage: record.modelUsage ?? null });
      }
      assert.ok(records.length <= 100);
      const sourceFiles = [];
      const inventory = async (folder, prefix = '') => { for (const entry of await readdir(folder, { withFileTypes: true })) { assert.ok(entry.isFile() || entry.isDirectory()); const path = prefix + entry.name; if (entry.isDirectory()) await inventory(join(folder, entry.name), path + '/'); else sourceFiles.push(path); assert.ok(sourceFiles.length <= 50); } };
      await inventory(join(operation, 'source')); assert.deepEqual(sourceFiles.sort(), Object.keys(fixture.files).sort());
      for (const [path, expected] of Object.entries(fixture.sourceHashes)) assert.equal(hash(await readFile(join(operation, 'source', path))), expected, 'Original source changed');
      assert.equal(hash(await readFile(join(operation, 'contract.mjs'))), config.harnessSha256);
      result = { service, host, poolId: pool.poolId, storageId: pool.storageId, runs: records, originalSourceUnchanged: true, externalHarnessUnchanged: true, releaseDigest: release.digest, modelKeysRead: false };
    }
  } else throw new Error('Unknown remote model action');
  console.log(JSON.stringify(result)); return result;
}
async function serviceFacts(name, release) {
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9@_.-]{0,159}\.service$/);
  const active = (await execute('systemctl', ['is-active', name], { timeout: 10000 })).stdout.trim() === 'active'; assert.equal(active, true);
  const pid = Number((await execute('systemctl', ['show', '--property=MainPID', '--value', name], { timeout: 10000 })).stdout.trim()); assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  const standardWorkerCommand = standardModelWorkerCommand(argv, release);
  assert.equal(standardWorkerCommand, true, 'The service must run the persistent standard release Worker CLI');
  return { name, pid, active, standardWorkerCommand };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) remoteModelTarget(process.argv[2], process.argv[3]).catch(() => { console.error(JSON.stringify({ event: 'remote_model_probe_failed', action: process.argv[2] })); process.exitCode = 1; });
