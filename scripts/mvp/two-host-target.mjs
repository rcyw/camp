// Test-only overlay. All runtime imports resolve through probe/packages to the
// separately verified, immutable Worker release. This file is never a daemon.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { lstat, readFile, writeFile, open, cp, unlink, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CampRuntime } from '../../packages/camp-runtime/src/index.mjs';
import { verifyWorkerRelease } from '../../packages/camp-runtime/src/worker-release.mjs';
import { inspectWorker } from '../../packages/camp-runtime/src/worker-preflight.mjs';
import { privateArtifactRequest, downloadPrivateBundle } from '../../packages/camp-runtime/src/private-artifacts.mjs';
import { storageMain } from '../../packages/camp-runtime/scripts/storage.mjs';
import { exportCandidate } from '../../packages/camp-runtime/src/export.mjs';
import { superviseOwnedChild } from './owned-child.mjs';
import { digest, checkedPath, readNetworkGate, transportFailureCode } from './two-host-support.mjs';

async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size <= 1024 * 1024); return JSON.parse(await file.readFile('utf8')); }
  finally { await file.close(); }
}
export async function targetMain(action, operation) {
  checkedPath(operation);
  const stat = await lstat(operation); assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077));
  const env = await privateJson(join(operation, 'worker-env.json')), input = await privateJson(join(operation, 'input.json'));
  const runtime = new CampRuntime({ env });
  const release = checkedPath(input.release), manifestBytes = await readFile(join(release, 'worker-release.json'));
  const releaseHash = digest(manifestBytes);
  assert.match(input.releaseDigest, /^[a-f0-9]{64}$/);
  assert.equal(releaseHash, input.releaseDigest, 'Release differs from the operator-reviewed digest');
  const verifiedRelease = await verifyWorkerRelease(release, { expectedDigest: releaseHash, expectedImageId: env.CAMP_RUNTIME_IMAGE, expectedToolchainDigest: input.toolchainDigest });
  const request = privateArtifactRequest(env), worker = async path => {
    const response = await fetch(env.CAMP_API_URL + '/api/camp/worker' + path, { headers: { authorization: 'Bearer ' + env.CAMP_WORKER_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200); return response.json();
  };
  let result;
  if (action === 'preflight') {
    for (const path of input.absentPaths) await assert.rejects(lstat(path), { code: 'ENOENT' });
    const checked = await inspectWorker({ runtime, env, report: false });
    const allowed = new Set(['source']); // The original checkout is absent until native restore.
    assert.ok(checked.report.checks.every(row => row.status !== 'failed' || allowed.has(row.id)), 'Remote prerequisites failed');
    const facts = JSON.parse((await runtime.dockerCall(['info', '--format', '{{json .}}'])).stdout);
    const containers = await containerFacts(runtime);
    await writeFile(join(operation, 'containers-before.json'), JSON.stringify(containers), { flag: 'wx', mode: 0o600 });
    result = { machineIdHash: digest((await readFile('/etc/machine-id', 'utf8')).trim()), bootIdHash: digest((await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()), dockerIdHash: digest(facts.ID), releaseDigest: releaseHash, releaseCommit: verifiedRelease.manifest.source.commit, toolchainDigest: checked.report.toolchainDigest, imageId: checked.report.imageId, sourcePathsAbsent: true, checks: checked.report.checks };
  } else if (action === 'download-network-fault') {
    const discovery = await worker(`/storage-operations/${input.operationId}`);
    result = await networkInterruptedDownload({ request, operationId: input.operationId, receipt: discovery.operation.backupReceipt, bundlePath: env.CAMP_STORAGE_BUNDLE });
    console.log(JSON.stringify({ schemaVersion: 1, type: 'result', result })); return result;
  } else if (action === 'download-interrupted' || action === 'download') {
    const discovery = await worker(`/storage-operations/${input.operationId}`);
    let gets = 0;
    const download = () => downloadPrivateBundle({ request: async (path, options) => {
      if (action === 'download-interrupted' && /\/parts\/\d+$/.test(path) && ++gets === 2) throw Object.assign(new Error('Explicit request-hook fault after the first downloaded part'), { code: 'camp_probe_hook' });
      return request(path, options);
    }, operationId: input.operationId, receipt: discovery.operation.backupReceipt, bundlePath: env.CAMP_STORAGE_BUNDLE });
    if (action === 'download-interrupted') {
      await assert.rejects(download(), { code: 'camp_probe_hook' }); result = { requestHookInterrupted: true, realNetworkInterrupted: false };
    } else { const artifact = await download(); result = { artifactId: artifact.id, state: artifact.state }; }
  } else if (action === 'restore') {
    // Actual corrupt bytes, in a fresh private namespace, cannot publish a
    // native target receipt. The complete original remains untouched.
    const corrupt = join(operation, 'corrupt-bundle'); await cp(env.CAMP_STORAGE_BUNDLE, corrupt, { recursive: true, errorOnExist: true, force: false });
    const file = await open(join(corrupt, 'store.sqlite'), 'r+'); try { await file.write(Buffer.from('corrupt'), 0, 7, 100); await file.sync(); } finally { await file.close(); }
    await assert.rejects(storageMain(['restore', '--operation', input.operationId], { ...env, CAMP_STORAGE_BUNDLE: corrupt, CAMP_RUNTIME_HOME: join(operation, 'corrupt-runtime') }));
    assert.equal((await worker(`/storage-operations/${input.operationId}`)).operation.phase, 'backup_ready');
    // storageMain prints a receipt; capture it in-process so SSH stdout remains
    // one JSON object. Other CLI phases are intentionally not used here.
    const { restoreNativeStore } = await import('../../packages/camp-runtime/src/native-store.mjs');
    const discovery = await worker(`/storage-operations/${input.operationId}`);
    const perform = () => restoreNativeStore({ runtime: new CampRuntime({ env }), plan: discovery.plan, bundlePath: env.CAMP_STORAGE_BUNDLE, sourceReceipt: discovery.operation.backupReceipt, ...(discovery.operation.restoreReceipt ? { existingRestoreReceipt: discovery.operation.restoreReceipt } : {}), postReceipt: async receipt => {
      const response = await fetch(env.CAMP_API_URL + `/api/camp/worker/storage-operations/${input.operationId}/restore`, { method: 'POST', headers: { authorization: 'Bearer ' + env.CAMP_WORKER_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(receipt), redirect: 'error', signal: AbortSignal.timeout(15000) }); assert.equal(response.status, 200);
    } });
    const receipt = await perform();
    const replay = await restoreNativeStore({ runtime: new CampRuntime({ env }), plan: discovery.plan, bundlePath: env.CAMP_STORAGE_BUNDLE, sourceReceipt: discovery.operation.backupReceipt, existingRestoreReceipt: receipt });
    assert.deepEqual(replay, receipt);
    result = { receipt, corruptBundleRejected: true, restoreReplayIdempotent: true };
  } else if (action === 'export-baseline' || action === 'export-result') {
    const message = action === 'export-baseline' ? input.baseline : JSON.parse(await readFile(join(operation, 'result.json'), 'utf8'));
    await runtime.ready();
    const output = join(operation, action);
    const exported = await exportCandidate({ runtime, candidate: message.candidate, roomId: input.roomId, goalId: message.goalId, output });
    for (const side of ['left', 'right']) {
      assert.equal(await readFile(join(output, side + '-note.txt'), 'utf8'), side + '\n');
      if (action === 'export-result') assert.equal(await readFile(join(output, `${input.notePrefix}-${side}-note.txt`), 'utf8'), side + '\n');
    }
    result = { candidate: exported.candidate, files: exported.files, bytes: exported.bytes, originalFilesPreserved: true, ...(action === 'export-result' ? { remoteNonceFilesVerified: true } : {}) };
  } else if (action === 'continue') {
    const childInput = join(operation, 'child.json');
    await writeFile(childInput, JSON.stringify({ apiUrl: env.CAMP_API_URL, kind: 'complete', notePrefix: input.notePrefix, probeSandbox: true, expectedParentPid: process.pid }), { flag: 'wx', mode: 0o600 });
    const log = await open(join(operation, 'pool.log'), 'wx', 0o600);
    const childScript = join(dirname(fileURLToPath(import.meta.url)), 'parallel-real-smoke.mjs');
    const child = spawn('setpriv', ['--pdeathsig', 'TERM', process.execPath, childScript, '--child', childInput], { cwd: join(operation, 'probe'), stdio: ['ignore', log.fd, log.fd], env: { ...env, DEEPSEEK_API_KEY: 'synthetic-unused-no-provider-requests' } });
    const owner = superviseOwnedChild(child, { group: false, handleSignals: true });
    const hup = () => { void owner.stop().finally(() => process.exit(129)); }; process.once('SIGHUP', hup);
    const timer = setTimeout(() => { void owner.stop(); }, 420000);
    try {
      const startTime = await processStart(child.pid);
      await writeFile(join(operation, 'pool-owner.json'), JSON.stringify({ pid: child.pid, startTime, childScript, childInput }), { flag: 'wx', mode: 0o600 });
      const exit = await owner.exited; assert.equal(exit.code, 0, 'Remote synthetic pool did not finish');
    }
    finally { clearTimeout(timer); process.off('SIGHUP', hup); await owner.stop(); await log.close(); }
    const lines = (await readFile(join(operation, 'pool.log'), 'utf8')).split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.ok(lines.some(row => row.probe === 'two_live_build_containers'));
    assert.ok(lines.some(row => row.probe === 'sandbox_api_reachable'));
    assert.ok(lines.some(row => row.probe === 'review_overlaps_build'));
    result = { twoLiveBuilders: true, sandboxApiReachable: true, resourceLimitsVerified: true, roleOutputs: 'synthetic', modelCalls: 0 };
  } else if (action === 'record-result') {
    let raw = ''; for await (const bytes of process.stdin) { raw += bytes; assert.ok(Buffer.byteLength(raw) <= 1024 * 1024); }
    const manifest = JSON.parse(raw); assert.equal(manifest.roomId, input.roomId); assert.equal(manifest.resultReady, true);
    await writeFile(join(operation, 'result.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 }); result = { recorded: true };
  } else if (action === 'final') {
    const before = await privateJson(join(operation, 'containers-before.json')), after = await containerFacts(runtime);
    for (const row of before) assert.deepEqual(after.find(current => current.id === row.id), row, 'An existing foreign container changed during the probe');
    assert.ok(!after.some(row => row.name?.startsWith('camp-mvp-run-') && !before.some(old => old.id === row.id)), 'An owned execution sandbox remains; preserve journals and recover it');
    for (const path of input.absentPaths) await assert.rejects(lstat(path), { code: 'ENOENT' });
    result = { existingContainersUnchanged: true, sourcePathsStillAbsent: true, releaseDigest: releaseHash };
  } else if (action === 'auth-wrong-room') {
    let raw = ''; for await (const bytes of process.stdin) { raw += bytes; assert.ok(Buffer.byteLength(raw) <= 4096); }
    const credential = JSON.parse(raw); assert.equal(typeof credential.token, 'string');
    const response = await fetch(env.CAMP_API_URL + `/api/camp/worker/storage-operations/${input.operationId}`, { headers: { authorization: 'Bearer ' + credential.token }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.ok([403, 404].includes(response.status)); result = { wrongRoomCredentialRejected: true };
  } else if (action === 'auth-revoked') {
    const response = await fetch(env.CAMP_API_URL + `/api/camp/worker/storage-operations/${input.operationId}`, { headers: { authorization: 'Bearer ' + env.CAMP_WORKER_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.ok([401, 403].includes(response.status)); result = { revokedCredentialRejected: true };
  } else if (action === 'stop-owned') {
    let owned;
    try { owned = await privateJson(join(operation, 'pool-owner.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; result = { ownedProcessAbsent: true }; }
    if (owned) {
      assert.ok(Number.isSafeInteger(owned.pid) && owned.pid > 1);
      const current = await processStart(owned.pid).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (current === null) result = { ownedProcessAbsent: true };
      else {
        assert.equal(current, owned.startTime, 'PID was reused; refuse to signal it');
        const argv = (await readFile(`/proc/${owned.pid}/cmdline`)).toString().split('\0');
        assert.ok(argv.includes(owned.childScript) && argv.includes(owned.childInput), 'Owned process identity changed');
        process.kill(owned.pid, 'SIGTERM');
        const { setTimeout: delay } = await import('node:timers/promises');
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && await processStartOrAbsent(owned.pid) === owned.startTime) await delay(250);
        assert.notEqual(await processStartOrAbsent(owned.pid), owned.startTime, 'Owned pool did not stop; retain evidence for recovery');
        result = { ownedProcessStopped: true };
      }
    }
  } else if (action === 'clear-credential') {
    await unlink(join(operation, 'worker-env.json')); result = { credentialRemoved: true };
  } else throw new Error('Unknown remote acceptance action');
  console.log(JSON.stringify(result)); return result;
}
/** onProgress is synchronous, but follows file sync, rename and directory
 * sync. Pause in the next request wrapper, after proving those disk facts. */
export async function networkInterruptedDownload({ request, operationId, receipt, bundlePath, download = downloadPrivateBundle, stdin = process.stdin, emit = value => console.log(JSON.stringify(value)), gateTimeoutMs = 60000 }) {
  let first, phase, phaseSent = false, released = false, nextRequest = false;
  const cancel = new AbortController();
  const gate = readNetworkGate(stdin, () => phaseSent, { timeoutMs: gateTimeoutMs, signal: cancel.signal });
  gate.catch(() => {});
  const snapshot = async meta => {
    const work = `${resolve(bundlePath)}.transfer-${meta.artifactId}`;
    const state = await privateJson(join(work, 'transfer.json'));
    assert.equal(state.artifactId, meta.artifactId); assert.match(state.manifestDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readdir(join(work, 'parts')), ['0']);
    const file = await open(join(work, 'parts/0'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try { const stat = await file.stat(); assert.ok(stat.isFile() && stat.uid === process.getuid() && !(stat.mode & 0o077) && stat.size > 0 && stat.size <= 8 * 1024 ** 2); bytes = await file.readFile(); assert.equal(bytes.length, stat.size); }
    finally { await file.close(); }
    return { schemaVersion: 1, type: 'phase', phase: 'first_part_persisted', artifactId: meta.artifactId, receivedParts: 1, totalParts: meta.totalParts, manifestDigest: state.manifestDigest, partSha256: digest(bytes), partBytes: bytes.length };
  };
  try {
    await download({ operationId, receipt, bundlePath,
      onProgress: meta => { if (meta.receivedParts === 1) { assert.ok(meta.totalParts >= 2); first = meta; } },
      request: async (path, options) => {
        if (first && /\/parts\/\d+$/.test(path)) {
          assert.ok(!phaseSent, 'Only one post-gate network request may run');
          phase = await snapshot(first); phaseSent = true; emit(phase);
          await gate; released = true; nextRequest = true;
        }
        return request(path, options);
      },
    });
    throw new Error('The API stayed reachable after closing the owned tunnel');
  } catch (error) {
    const code = transportFailureCode(error);
    if (!phase || !released || !nextRequest || !code) throw error;
    assert.deepEqual(await snapshot(first), phase, 'Partial download evidence changed after network failure');
    return { realNetworkInterrupted: true, requestHookInterrupted: false, partialRetained: true, artifactId: phase.artifactId, transferManifestDigest: phase.manifestDigest, partSha256: phase.partSha256, transportCode: code };
  } finally { cancel.abort(); }
}
async function containerFacts(runtime) {
  return (await runtime.dockerCall(['ps', '-a', '--no-trunc', '--format', '{{json .}}'])).stdout.trim().split('\n').filter(Boolean).map(line => { const row = JSON.parse(line); return { id: row.ID, state: row.State, name: row.Names }; }).sort((a, b) => a.id.localeCompare(b.id));
}
async function processStart(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')'); assert.ok(close > 0);
  return stat.slice(close + 2).split(' ')[19];
}
async function processStartOrAbsent(pid) { try { return await processStart(pid); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) targetMain(process.argv[2], process.argv[3]).catch(() => { console.error(JSON.stringify({ event: 'two_host_target_failed', action: process.argv[2] })); process.exitCode = 1; });
