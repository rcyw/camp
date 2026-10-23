import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, lstat, readdir, rm, symlink, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { checkedAlias, checkedPath, checkedLoopback, shellQuote, sshArguments, sshJson, bootstrapSource, checkedChildInput, noteName, settleTwoHostProbe, compensateProbe, sshGatedJson, readNetworkGate, managedTunnelOwner, digest } from './two-host-support.mjs';
import { remoteConfiguration } from './two-host-storage-smoke.mjs';
import { networkInterruptedDownload } from './two-host-target.mjs';

test('remote configuration rejects SSH options, traversal, shell syntax and non-loopback transport', () => {
  for (const value of ['-oProxyCommand=id', 'host;id', 'host\nother', 'a@b@c', 'host:22']) assert.throws(() => checkedAlias(value));
  assert.equal(checkedAlias('root@camp-target-1'), 'root@camp-target-1');
  for (const value of ['/a/../b', '/a//b', '/a b', '/a/$(id)', '/', 'relative', '/a/']) assert.throws(() => checkedPath(value));
  assert.equal(checkedPath('/srv/camp/releases/abc-123'), '/srv/camp/releases/abc-123');
  for (const value of ['http://example.com:123', 'http://127.0.0.1:123/path', 'http://u:p@127.0.0.1:123', 'http://127.0.0.1:123?secret=x', 'https://127.0.0.1:123']) assert.throws(() => checkedLoopback(value));
  assert.equal(checkedLoopback('http://127.0.0.1:41318'), 'http://127.0.0.1:41318');
});
test('all SSH remote argv are shell quoted and credentials never enter argv', async () => {
  assert.equal(shellQuote("a'b$(id)"), "'a'\\''b$(id)'");
  const args = sshArguments('target', ['node', '-e', 'console.log("$HOME")', '/tmp/one']);
  assert.equal(args.at(-1), `'node' '-e' 'console.log("$HOME")' '/tmp/one'`);
  let captured;
  const result = await sshJson('target', ['node', 'helper'], { token: 'secret-room-token' }, { spawnProcess: (command, argv, options) => {
    captured = { command, argv, options }; const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
    let body = ''; child.stdin.on('data', bytes => { body += bytes; });
    child.stdin.on('finish', () => { assert.equal(JSON.parse(body).token, 'secret-room-token'); child.stdout.end('{"ok":true}'); child.emit('close', 0); });
    return child;
  } });
  assert.deepEqual(result, { ok: true }); assert.equal(captured.command, 'ssh');
  assert.ok(!JSON.stringify(captured).includes('secret-room-token'));
  assert.ok(!Object.keys(captured.options.env).some(key => key.includes('KEY') || key.includes('TOKEN')));
});
test('SSH failure and timeout suppress remote stderr and reject success', async () => {
  for (const timeout of [false, true]) {
    await assert.rejects(sshJson('target', ['node', 'helper'], undefined, { timeoutMs: 5, spawnProcess: () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', 143)); return true; };
      child.stdin.on('finish', () => { child.stderr.end('TOP_SECRET=never expose'); if (!timeout) queueMicrotask(() => child.emit('close', 1)); });
      return child;
    } }), error => !error.message.includes('TOP_SECRET') && /failed or timed out/.test(error.message));
  }
});
test('new files use an explicit nonce, while existing local acceptance inputs keep their names', () => {
  assert.equal(noteName(checkedChildInput({}), 'left'), 'left-note.txt');
  assert.equal(noteName(checkedChildInput({ notePrefix: 'remote-a1', probeSandbox: true, expectedParentPid: 2 }), 'right'), 'remote-a1-right-note.txt');
  for (const input of [{ notePrefix: '../../secret' }, { notePrefix: 'x\ny' }, { probeSandbox: 'true' }, { expectedParentPid: 1 }, { expectedParentPid: 2.5 }]) assert.throws(() => checkedChildInput(input));
  assert.throws(() => noteName({}, 'unknown'));
});
test('probe workspace cannot be placed inside the immutable release', () => {
  const env = { CAMP_REMOTE_SSH: 'target', CAMP_REMOTE_ROOT: '/srv/camp/releases/reviewed', CAMP_REMOTE_API_URL: 'http://127.0.0.1:41318', CAMP_REMOTE_TOOLCHAIN_BUNDLE: '/srv/camp/toolchains/abc', CAMP_REMOTE_RELEASE_SHA256: 'a'.repeat(64) };
  assert.equal(remoteConfiguration(env, 'one').operation, '/srv/camp/releases/reviewed.operations/one');
  assert.throws(() => remoteConfiguration({ ...env, CAMP_REMOTE_PROBE_ROOT: env.CAMP_REMOTE_ROOT + '/probes' }, 'one'));
  assert.throws(() => remoteConfiguration({ ...env, CAMP_REMOTE_RELEASE_SHA256: undefined }, 'one'));
  assert.throws(() => remoteConfiguration({ ...env, CAMP_REMOTE_RELEASE_SHA256: 'not-reviewed' }, 'one'));
  assert.equal(remoteConfiguration(env, 'one').managedTunnel, false);
  assert.equal(remoteConfiguration(env, 'one').networkFault, false);
  assert.equal(remoteConfiguration({ ...env, CAMP_REMOTE_MANAGED_TUNNEL: '1', CAMP_REMOTE_NETWORK_FAULT: '1' }, 'one').networkFault, true);
  for (const flags of [{ CAMP_REMOTE_NETWORK_FAULT: '1' }, { CAMP_REMOTE_NETWORK_FAULT: 'yes' }, { CAMP_REMOTE_MANAGED_TUNNEL: 'true' }, { CAMP_REMOTE_MANAGED_TUNNEL: '1', CAMP_REMOTE_SSH: 'user@target' }]) assert.throws(() => remoteConfiguration({ ...env, ...flags }, 'one'));
});
test('bootstrap creates a private external overlay, preserves release bytes and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-two-host-'));
  try {
    const release = join(root, 'release'), operation = join(root, 'operations', 'unique'); await mkdir(join(release, 'packages'), { recursive: true });
    const payload = { files: Object.fromEntries(['two-host-target.mjs', 'two-host-support.mjs', 'parallel-real-smoke.mjs', 'owned-child.mjs'].map(name => [name, Buffer.from('// ' + name).toString('base64')])), env: { CAMP_WORKER_TOKEN: 'private-token' }, input: {}, harness: '// fixed harness' };
    const result = await bootstrap(release, operation, payload); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), { bootstrapped: true });
    assert.deepEqual(await readdir(release), ['packages']);
    assert.ok((await lstat(join(operation, 'probe/packages'))).isSymbolicLink());
    assert.equal((await lstat(join(operation, 'worker-env.json'))).mode & 0o777, 0o600);
    assert.equal((await lstat(operation)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await readFile(join(operation, 'worker-env.json'), 'utf8')).CAMP_WORKER_TOKEN, 'private-token');
    assert.ok(!result.stdout.includes('private-token'));
    assert.notEqual((await bootstrap(release, operation, payload)).code, 0);
    assert.equal(JSON.parse(await readFile(join(operation, 'worker-env.json'), 'utf8')).CAMP_WORKER_TOKEN, 'private-token');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('bootstrap rejects a symlinked operation parent instead of writing through it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-two-host-'));
  try {
    const release = join(root, 'release'), outside = join(root, 'outside'); await mkdir(join(release, 'packages'), { recursive: true }); await mkdir(outside, { mode: 0o700 }); await symlink(outside, join(root, 'linked'));
    const result = await bootstrap(release, join(root, 'linked', 'new'), {}); assert.notEqual(result.code, 0); assert.deepEqual(await readdir(outside), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('pool stop, source rename and credential cleanup failures never publish a passed receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-two-host-cleanup-'));
  try {
    for (const failing of ['stopOwned', 'restoreSources', 'revokeCredential', 'probeRevoked', 'removeCredential', 'revokeForeign', 'archiveFixtures', 'closeTunnel']) {
      const latest = join(root, failing + '.json'), calls = [];
      const actions = Object.fromEntries(['stopOwned', 'restoreSources', 'revokeCredential', 'probeRevoked', 'removeCredential', 'revokeForeign', 'archiveFixtures', 'closeTunnel'].map(name => [name, async () => {
        calls.push(name);
        if (name === failing) {
          if (name === 'restoreSources') await rename(join(root, 'missing-source'), join(root, 'never-overwritten'));
          throw new Error('Explicit cleanup failure');
        }
      }]));
      await assert.rejects(settleTwoHostProbe({ ...actions, publish: () => writeFile(latest, '{"passed":true}', { flag: 'wx' }) }));
      await assert.rejects(lstat(latest), { code: 'ENOENT' });
      assert.equal(calls.at(-1), failing);
    }
    const order = []; let published = false;
    const names = ['stopOwned', 'restoreSources', 'revokeCredential', 'probeRevoked', 'removeCredential', 'revokeForeign', 'archiveFixtures', 'closeTunnel'];
    await settleTwoHostProbe({ ...Object.fromEntries(names.map(name => [name, async () => { order.push(name); }])), publish: () => { assert.deepEqual(order, names); published = true; } });
    assert.equal(published, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failure compensation continues source recovery and revocation after an earlier failure', async () => {
  const calls = [];
  const failed = await compensateProbe([['remote_process', async () => { calls.push('stop'); throw new Error('unreachable'); }], ['source_home', async () => { calls.push('home'); throw new Error('rename refused'); }], ['source_checkout', async () => { calls.push('checkout'); }], ['revoke', async () => { calls.push('revoke'); }]]);
  assert.deepEqual(calls, ['stop', 'home', 'checkout', 'revoke']); assert.deepEqual(failed, ['remote_process', 'source_home']);
});
const progress = () => ({ schemaVersion: 1, type: 'phase', phase: 'first_part_persisted', artifactId: randomUUID(), manifestDigest: 'a'.repeat(64), partSha256: 'b'.repeat(64), partBytes: 128, receivedParts: 1, totalParts: 3 });
const networkResult = phase => ({ schemaVersion: 1, type: 'result', result: { realNetworkInterrupted: true, requestHookInterrupted: false, partialRetained: true, artifactId: phase.artifactId, transferManifestDigest: phase.manifestDigest, partSha256: phase.partSha256, transportCode: 'ECONNREFUSED' } });
function fakeStreamingChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', 143)); return true; };
  return child;
}
test('network-fault SSH waits for persisted phase and confirmed tunnel close before writing the gate', async () => {
  const child = fakeStreamingChild(), phase = progress(); let releaseClose, entered, received = '';
  const closing = new Promise(resolveClose => { releaseClose = resolveClose; }), invoked = new Promise(resolvePhase => { entered = resolvePhase; });
  child.stdin.on('data', bytes => { received += bytes; });
  child.stdin.on('finish', () => { assert.deepEqual(JSON.parse(received), { schemaVersion: 1, command: 'continue' }); child.stdout.end(JSON.stringify(networkResult(phase)) + '\n'); child.emit('close', 0); });
  const result = sshGatedJson('target', ['node', 'helper'], { onPhase: async value => { assert.deepEqual(value, phase); entered(); await closing; }, spawnProcess: (_command, argv) => { assert.ok(argv.includes('ControlMaster=no') && argv.includes('ControlPath=none') && argv.includes('ClearAllForwardings=yes')); return child; } });
  assert.equal(received, '');
  child.stdout.write(JSON.stringify(phase) + '\n'); await invoked; await delay(5); assert.equal(received, '');
  releaseClose(); assert.equal((await result).realNetworkInterrupted, true);
});
test('independent SSH loss or tunnel-close failure rejects without releasing the target gate', async () => {
  for (const variant of ['ssh_loss', 'close_failure', 'bad_phase', 'early_result', 'duplicate_phase']) {
    const child = fakeStreamingChild(), phase = progress(); let gate = '';
    child.stdin.on('data', bytes => { gate += bytes; });
    const result = sshGatedJson('target', ['node', 'helper'], { onPhase: async () => { if (variant === 'close_failure') throw new Error('owned close failed'); await new Promise(() => {}); }, spawnProcess: () => child, timeoutMs: 1000, stopMs: 5 });
    if (variant === 'ssh_loss') child.emit('close', 255);
    else if (variant === 'bad_phase') child.stdout.write(JSON.stringify({ ...phase, extra: 'untrusted' }) + '\n');
    else { child.stdout.write(JSON.stringify(phase) + '\n'); if (variant === 'early_result') child.stdout.write(JSON.stringify(networkResult(phase)) + '\n'); if (variant === 'duplicate_phase') child.stdout.write(JSON.stringify(phase) + '\n'); }
    await assert.rejects(result); assert.equal(gate, '');
  }
});
test('network-fault control abort and deadline stop only the owned SSH and never send a gate', async () => {
  for (const variant of ['abort', 'deadline']) {
    const child = fakeStreamingChild(), controller = new AbortController(); let kills = 0, input = '';
    child.stdin.on('data', bytes => { input += bytes; }); child.kill = () => { kills++; queueMicrotask(() => child.emit('close', 143)); return true; };
    const pending = sshGatedJson('target', ['node', 'helper'], { onPhase: async () => {}, spawnProcess: () => child, timeoutMs: variant === 'deadline' ? 5 : 1000, stopMs: 5, signal: controller.signal });
    if (variant === 'abort') controller.abort();
    await assert.rejects(pending); assert.ok(kills >= 1); assert.equal(input, ''); assert.equal(child.stdin.destroyed, true);
  }
});
test('network-fault result must bind the persisted phase and a real supported transport code', async () => {
  for (const change of [{ transferManifestDigest: 'c'.repeat(64) }, { transportCode: 'HTTP_403' }, { realNetworkInterrupted: false }]) {
    const child = fakeStreamingChild(), phase = progress();
    child.stdin.on('finish', () => { const frame = networkResult(phase); frame.result = { ...frame.result, ...change }; child.stdout.end(JSON.stringify(frame) + '\n'); queueMicrotask(() => child.emit('close', 0)); });
    const pending = sshGatedJson('target', ['node', 'helper'], { onPhase: async () => {}, spawnProcess: () => child });
    child.stdout.write(JSON.stringify(phase) + '\n'); await assert.rejects(pending);
  }
});
test('network gate rejects premature, malformed, EOF and timed-out commands', async () => {
  for (const variant of ['premature', 'extra', 'eof', 'timeout']) {
    const stream = new PassThrough(); const gate = readNetworkGate(stream, () => variant !== 'premature', { timeoutMs: 10 });
    if (variant === 'eof') stream.end();
    else if (variant !== 'timeout') stream.end(JSON.stringify({ schemaVersion: 1, command: 'continue', ...(variant === 'extra' ? { extra: true } : {}) }) + '\n');
    await assert.rejects(gate); assert.equal(stream.listenerCount('data'), 0);
  }
});
test('owned tunnel lifecycle keeps external mode untouched and does not publish after reconnect failure', async () => {
  let creates = 0, closes = 0, published = false;
  const factory = async () => { if (++creates === 2) throw new Error('reconnect refused'); return { apiUrl: 'http://127.0.0.1:41318', close: async () => { closes++; } }; };
  const external = managedTunnelOwner({ enabled: false, factory, apiUrl: 'http://127.0.0.1:41318' }); await external.start(); await external.close(); assert.equal(creates, 0);
  const own = managedTunnelOwner({ enabled: true, factory, apiUrl: 'http://127.0.0.1:41318', options: {} });
  await own.start(); await own.close();
  await assert.rejects((async () => { await own.start(); published = true; })());
  await own.close(); assert.equal(published, false); assert.equal(closes, 1);
});
test('target proves actual loopback TCP refusal only after persisted-part gate and retains identical bytes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-network-fault-')), server = createServer((_req, res) => res.end('still reachable'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port;
  const stdin = new PassThrough(), artifactId = randomUUID(), bytes = Buffer.from('persisted private part'), work = join(folder, 'bundle.transfer-' + artifactId);
  let emitted, requests = 0, started;
  const phaseReady = new Promise(resolveReady => { started = resolveReady; });
  const result = networkInterruptedDownload({ operationId: randomUUID(), bundlePath: join(folder, 'bundle'), receipt: {}, stdin,
    emit: phase => { emitted = phase; started(); },
    request: async path => { requests++; return fetch(`http://127.0.0.1:${port}${path}`); },
    download: async options => { await mkdir(join(work, 'parts'), { recursive: true, mode: 0o700 }); await writeFile(join(work, 'transfer.json'), JSON.stringify({ artifactId, manifestDigest: 'a'.repeat(64) }), { mode: 0o600 }); await writeFile(join(work, 'parts/0'), bytes, { mode: 0o600 }); options.onProgress({ artifactId, receivedParts: 1, totalParts: 3 }); await options.request('/storage-operations/test/artifacts/test/parts/1'); },
  });
  try {
    await phaseReady; assert.equal(emitted.partSha256, digest(bytes)); await delay(5); assert.equal(requests, 0);
    await new Promise(resolveClose => server.close(resolveClose)); stdin.end(JSON.stringify({ schemaVersion: 1, command: 'continue' }) + '\n');
    const facts = await result; assert.equal(facts.realNetworkInterrupted, true); assert.equal(facts.requestHookInterrupted, false); assert.equal(facts.transportCode, 'ECONNREFUSED'); assert.equal(requests, 1);
    assert.deepEqual(await readFile(join(work, 'parts/0')), bytes);
  } finally { stdin.destroy(); if (server.listening) await new Promise(resolveClose => server.close(resolveClose)); await rm(folder, { recursive: true, force: true }); }
});
test('target refuses reachable API, HTTP refusal and injected ordinary errors as real network evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'camp-not-network-fault-'));
  try {
    for (const variant of ['reachable', 'http_failure', 'ordinary_error']) {
      const folder = join(root, variant), bundlePath = join(folder, 'bundle'), artifactId = randomUUID(), work = bundlePath + '.transfer-' + artifactId, stdin = new PassThrough();
      const pending = networkInterruptedDownload({ operationId: randomUUID(), bundlePath, receipt: {}, stdin,
        emit: () => stdin.end(JSON.stringify({ schemaVersion: 1, command: 'continue' }) + '\n'),
        request: async () => { if (variant === 'reachable') return {}; throw Object.assign(new Error('Not a fetch transport failure'), variant === 'http_failure' ? { status: 403, code: 'camp_artifact_http' } : { cause: { code: 'ECONNREFUSED' } }); },
        download: async options => { await mkdir(join(work, 'parts'), { recursive: true, mode: 0o700 }); await writeFile(join(work, 'transfer.json'), JSON.stringify({ artifactId, manifestDigest: 'a'.repeat(64) }), { mode: 0o600 }); await writeFile(join(work, 'parts/0'), 'part', { mode: 0o600 }); options.onProgress({ artifactId, receivedParts: 1, totalParts: 3 }); await options.request('/artifact/parts/1'); },
      });
      await assert.rejects(pending); stdin.destroy();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
function bootstrap(release, operation, payload) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrapSource, release, operation], { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.resume(); child.once('close', code => resolveResult({ code, stdout })); child.stdin.end(JSON.stringify(payload));
  });
}
