import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, lstat, readdir, rm, symlink, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { checkedAlias, checkedPath, checkedLoopback, shellQuote, sshArguments, sshJson, bootstrapSource, checkedChildInput, noteName, settleTwoHostProbe, compensateProbe } from './two-host-support.mjs';
import { remoteConfiguration } from './two-host-storage-smoke.mjs';

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
    for (const failing of ['stopOwned', 'restoreSources', 'revokeCredential', 'probeRevoked', 'removeCredential', 'revokeForeign', 'archiveFixtures']) {
      const latest = join(root, failing + '.json'), calls = [];
      const actions = Object.fromEntries(['stopOwned', 'restoreSources', 'revokeCredential', 'probeRevoked', 'removeCredential', 'revokeForeign', 'archiveFixtures'].map(name => [name, async () => {
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
    const names = ['stopOwned', 'restoreSources', 'revokeCredential', 'probeRevoked', 'removeCredential', 'revokeForeign', 'archiveFixtures'];
    await settleTwoHostProbe({ ...Object.fromEntries(names.map(name => [name, async () => { order.push(name); }])), publish: () => { assert.deepEqual(order, names); published = true; } });
    assert.equal(published, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('failure compensation continues source recovery and revocation after an earlier failure', async () => {
  const calls = [];
  const failed = await compensateProbe([['remote_process', async () => { calls.push('stop'); throw new Error('unreachable'); }], ['source_home', async () => { calls.push('home'); throw new Error('rename refused'); }], ['source_checkout', async () => { calls.push('checkout'); }], ['revoke', async () => { calls.push('revoke'); }]]);
  assert.deepEqual(calls, ['stop', 'home', 'checkout', 'revoke']); assert.deepEqual(failed, ['remote_process', 'source_home']);
});
function bootstrap(release, operation, payload) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrapSource, release, operation], { stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '';
    child.stdout.on('data', value => { stdout += value; }); child.stderr.resume(); child.once('close', code => resolveResult({ code, stdout })); child.stdin.end(JSON.stringify(payload));
  });
}
