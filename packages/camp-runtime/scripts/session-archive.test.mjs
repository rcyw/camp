import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable, PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archiveSession, streamSessionHome } from '../src/session-archive.mjs';

const root = { type: 'root', mode: 0o777 };
const file = (path, bytes = Buffer.from('session')) => [{ type: 'file', path, size: bytes.length, mode: 0o4755 }, { type: 'data', data: bytes.toString('base64') }, { type: 'file_end' }];
function transport(frames, { hang = false } = {}) {
  let child;
  const spawnCommand = (_command, args, options) => {
    assert.equal(args.includes('/usr/local/bin/node'), true); assert.equal(options.env.CAMP_WORKER_TOKEN, undefined);
    child = new EventEmitter(); child.stdout = hang ? new PassThrough() : Readable.from(frames.map(frame => typeof frame === 'string' ? frame : JSON.stringify(frame) + '\n'));
    child.stderr = new PassThrough(); child.kills = [];
    child.kill = signal => { child.kills.push(signal); child.stdout.destroy(); child.stderr.end(); queueMicrotask(() => child.emit('close', null, signal)); };
    if (!hang) child.stdout.once('end', () => { child.stderr.end(); child.emit('close', 0); });
    return child;
  };
  return { spawnCommand, child: () => child };
}
async function fixture(use) {
  const folder = await mkdtemp(join(tmpdir(), 'camp-session-archive-'));
  const run = { runId: 'owned-run', folder, containerId: 'a'.repeat(64), config: { prefix: 'camp-mvp-run-0123456789abcdef-' } };
  const runtime = { docker: '/tmp/test-docker.sock', runIdentity: () => ({ folder, prefix: run.config.prefix }), dockerCall: async args => { assert.equal(args[0], 'cp'); assert.match(await readFile(args[1], 'utf8'), /streamSessionHome/); return { stdout: '' }; } };
  try { await use({ folder, run, runtime, output: join(folder, 'dsh-home'), receipt: join(folder, 'session-archive.json') }); }
  finally { await rm(folder, { recursive: true, force: true }); }
}
async function assertRemoved(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

test('bounded archives preserve binary sessions in private files and omit every link or special entry', async () => fixture(async kit => {
  const bytes = Buffer.from([0, 255, 23, 120]);
  const sender = transport([root, { type: 'directory', path: 'sessions', mode: 0o777 }, ...file('sessions/state', bytes), { type: 'omitted', path: 'profiles/camp/node_modules', reason: 'symlink' }, { type: 'omitted', path: 'pipe', reason: 'special_entry' }, { type: 'end' }]);
  const receipt = await archiveSession({ ...kit, ...sender });
  assert.equal(receipt.status, 'truncated'); assert.equal(receipt.reason, 'omitted_entries'); assert.equal(receipt.retained, true);
  assert.equal(receipt.omittedCount, 2); assert.equal(receipt.counts.bytes, 4);
  assert.deepEqual(await readFile(join(kit.output, 'sessions/state')), bytes);
  assert.equal((await lstat(kit.output)).mode & 0o7777, 0o700); assert.equal((await lstat(join(kit.output, 'sessions/state'))).mode & 0o7777, 0o600);
  await assertRemoved(join(kit.output, 'pipe')); await assertRemoved(join(kit.output, 'profiles'));
  assert.deepEqual(JSON.parse(await readFile(kit.receipt, 'utf8')), receipt);
  assert.deepEqual((await readdir(kit.folder)).sort(), ['dsh-home', 'session-archive.json']);
}));

for (const [label, frames, options, status, reason] of [
  ['byte limit', [root, ...file('large', Buffer.alloc(5)), { type: 'end' }], { maxBytes: 4 }, 'truncated', 'byte_limit'],
  ['entry limit', [root, ...file('a'), ...file('b'), { type: 'end' }], { maxEntries: 1 }, 'truncated', 'entry_limit'],
  ['sender limit before EOF', [root, ...file('a'), { type: 'failure', reason: 'byte_limit' }], {}, 'truncated', 'byte_limit'],
  ['symlink injection', [root, { type: 'symlink', path: 'link', target: '/etc/passwd', mode: 0o777 }, { type: 'end' }], {}, 'error', 'unsafe_entry'],
  ['special injection', [root, { type: 'fifo', path: 'pipe', mode: 0o600 }, { type: 'end' }], {}, 'error', 'unsafe_entry'],
  ['traversal', [root, ...file('../outside'), { type: 'end' }], {}, 'error', 'invalid_stream'],
  ['partial stream', [root, { type: 'file', path: 'partial', size: 10, mode: 0o600 }], {}, 'error', 'invalid_stream'],
]) {
  test(`archive ${label} removes only the new partial and persists a failure receipt`, async () => fixture(async kit => {
    const sender = transport(frames);
    const receipt = await archiveSession({ ...kit, ...sender, ...options });
    assert.equal(receipt.status, status); assert.equal(receipt.reason, reason); assert.equal(receipt.retained, false);
    await assertRemoved(kit.output); assert.deepEqual(JSON.parse(await readFile(kit.receipt, 'utf8')), receipt);
  }));
}

test('omission evidence is bounded while ordinary files remain available', async () => fixture(async kit => {
  const sender = transport([root, ...Array.from({ length: 100 }, (_, index) => ({ type: 'omitted', path: 'link-' + index + '-'.repeat(300), reason: 'symlink' })), { type: 'end' }]);
  const result = await archiveSession({ ...kit, ...sender });
  assert.equal(result.omittedCount, 100); assert.equal(result.omittedEntries.length, 30);
  assert.ok(result.omittedEntries.every(entry => entry.path.length <= 240)); assert.ok((await readFile(kit.receipt)).length < 16000);
}));

test('deadline kills a stalled transport and abort also cleans and records an ordinary error', async () => fixture(async kit => {
  const sender = transport([], { hang: true });
  const result = await archiveSession({ ...kit, ...sender, timeoutMs: 30 });
  assert.equal(result.reason, 'timeout'); assert.equal(result.status, 'error'); await assertRemoved(kit.output);
  assert.ok(sender.child().kills.includes('SIGKILL'));
  const controller = new AbortController(); controller.abort(new Error('Stop requested'));
  const aborted = await archiveSession({ ...kit, ...transport([]), signal: controller.signal });
  assert.equal(aborted.reason, 'aborted'); await assertRemoved(kit.output);
}));

test('the wall-clock deadline also bounds a copier that does not honor its signal', async () => fixture(async kit => {
  kit.runtime.dockerCall = async () => new Promise(() => {});
  const result = await archiveSession({ ...kit, ...transport([]), timeoutMs: 25 });
  assert.equal(result.reason, 'timeout'); await assertRemoved(kit.output);
}));

test('existing archives and other attempt folders are never merged into or removed', async () => fixture(async kit => {
  await mkdir(kit.output); const before = await lstat(kit.output);
  const result = await archiveSession({ ...kit, ...transport([]) });
  assert.equal(result.status, 'error'); assert.equal((await lstat(kit.output)).ino, before.ino);
  await assert.rejects(archiveSession({ ...kit, ...transport([]), run: { ...kit.run, folder: join(kit.folder, 'other') } }), /invalid_owner/);
}));

test('trusted sender skips actual absolute links and FIFOs without following or opening them', async () => fixture(async kit => {
  const source = join(kit.folder, 'source'); await mkdir(source);
  await writeFile(join(source, 'session.json'), '{"messages":[]}');
  await symlink('/etc/passwd', join(source, 'node_modules')); execFileSync('mkfifo', [join(source, 'pipe')]);
  const frames = [], output = { write: value => { frames.push(JSON.parse(value)); return true; } };
  await streamSessionHome(output, { sourceDirectory: source, maxBytes: 1024, maxEntries: 10 });
  assert.deepEqual(frames.filter(frame => frame.type === 'omitted').map(frame => frame.reason).sort(), ['special_entry', 'symlink']);
  assert.equal(frames.filter(frame => frame.type === 'file').length, 1);
  assert.equal(frames.at(-1).type, 'end');
  await assert.rejects(streamSessionHome(output, { sourceDirectory: source, maxBytes: 3, maxEntries: 10 }), /byte_limit/);
  await assert.rejects(streamSessionHome(output, { sourceDirectory: source, maxBytes: 1024, maxEntries: 1 }), /entry_limit/);
}));

test('failure to persist the durable archive receipt propagates instead of claiming success', async () => fixture(async kit => {
  await mkdir(kit.receipt);
  await assert.rejects(archiveSession({ ...kit, ...transport([root, ...file('session'), { type: 'end' }]) }), { code: 'camp_journal_io' });
}));
