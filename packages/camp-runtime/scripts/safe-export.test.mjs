import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readlink, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportPath, exportLink, exportMode, receiveSnapshot } from '../src/safe-export.mjs';
import { checkedCandidate, checkedManifest } from '../src/candidate.mjs';

const stream = values => Readable.from(values.map(value => `${JSON.stringify(value)}\n`));
test('export paths, links and permission bits reject host traversal and privilege creation', () => {
  for (const path of ['../outside', '/absolute', 'nested/../outside', 'nested//file', 'a\\b', 'a\0b']) assert.throws(() => exportPath(path), /unsafe/);
  assert.equal(exportPath('src/你好.mjs'), 'src/你好.mjs');
  assert.equal(exportLink('src/link', '../target'), '../target');
  for (const link of ['/etc/shadow', '../../outside', 'a\\b']) assert.throws(() => exportLink('link', link));
  assert.equal(exportMode(0o751), 0o751);
  for (const mode of [0o4755, 0o2755, -1]) assert.throws(() => exportMode(mode));
});
test('streamed export preserves binary bytes, file mode and relative symlink without following it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-export-safe-'));
  const bytes = Buffer.from([0, 255, 128, 10, 13]);
  try {
    const result = await receiveSnapshot(stream([{ type: 'root', mode: 0o750 }, { type: 'directory', path: 'src', mode: 0o750 }, { type: 'file', path: 'src/run', mode: 0o751, size: bytes.length }, { type: 'data', data: bytes.toString('base64') }, { type: 'file_end' }, { type: 'symlink', path: 'link', mode: 0o777, target: 'src/run' }, { type: 'end' }]), folder);
    assert.deepEqual(await readFile(join(folder, 'src/run')), bytes);
    assert.equal((await stat(join(folder, 'src/run'))).mode & 0o777, 0o751);
    assert.equal(await readlink(join(folder, 'link')), 'src/run');
    assert.deepEqual(result, { files: 1, directories: 1, symlinks: 1, bytes: 5 });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
for (const [name, entries] of [
  ['path escape', [{ type: 'file', path: '../escape', mode: 0o600, size: 0 }]],
  ['duplicate path', [{ type: 'directory', path: 'dir', mode: 0o700 }, { type: 'directory', path: 'dir', mode: 0o700 }]],
  ['symlink parent', [{ type: 'symlink', path: 'dir', mode: 0o777, target: '.' }, { type: 'file', path: 'dir/file', mode: 0o600, size: 0 }]],
  ['special entry', [{ type: 'fifo', path: 'pipe', mode: 0o600 }]],
  ['partial file', [{ type: 'file', path: 'file', mode: 0o600, size: 2 }, { type: 'data', data: 'AQ==' }, { type: 'file_end' }]],
]) {
  test(`export refuses ${name}`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'camp-export-reject-'));
    try { await assert.rejects(receiveSnapshot(stream([{ type: 'root', mode: 0o700 }, ...entries, { type: 'end' }]), folder)); }
    finally { await rm(folder, { recursive: true, force: true }); }
  });
}
test('candidate identities are exact and result manifests must be ready', () => {
  const candidate = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, commitId: `12${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
  assert.deepEqual(checkedCandidate(candidate), { ...candidate, refKind: 'commit', refId: candidate.commitId });
  for (const commitId of ['c'.repeat(64), `11${'c'.repeat(64)}`, `${candidate.commitId}ff`]) assert.throws(() => checkedCandidate({ ...candidate, commitId }));
  assert.throws(() => checkedCandidate(candidate, { projectId: `p-${'e'.repeat(16)}` }), /another project/);
  assert.throws(() => checkedManifest({ schemaVersion: 1, roomId: 'room', goalId: 'goal', resultReady: false, candidate }));
});
test('snapshot byte and entry admission failures are typed separately from corrupt transport', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-export-budget-'));
  try {
    await assert.rejects(receiveSnapshot(stream([{ type: 'root', mode: 0o700 }, { type: 'file', path: 'large', mode: 0o600, size: 3 }]), folder, { maxBytes: 2 }), { code: 'camp_snapshot_limit_exceeded' });
    await assert.rejects(readFile(join(folder, 'large')), { code: 'ENOENT' });
    await assert.rejects(receiveSnapshot(stream([{ type: 'root', mode: 0o700 }, { type: 'directory', path: 'one', mode: 0o700 }, { type: 'directory', path: 'two', mode: 0o700 }]), folder, { maxEntries: 1 }), { code: 'camp_snapshot_limit_exceeded' });
    await assert.rejects(receiveSnapshot(stream([{ type: 'root', mode: 0o700 }, { type: 'file', path: '../escape', mode: 0o600, size: 3 }]), folder), error => error.code !== 'camp_snapshot_limit_exceeded');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
