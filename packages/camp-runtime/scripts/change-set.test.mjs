import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, chmod, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareSnapshotDirectories } from '../src/change-set.mjs';
import { parseChangeSet, CAMP_CHANGE_LIMITS } from '../../camp-protocol/src/index.js';
const base = { type: 'layerfs', projectId: `p-${'a'.repeat(16)}`, imageId: `sha256:${'b'.repeat(64)}`, refKind: 'layer', refId: `32${'c'.repeat(64)}`, layerId: `32${'c'.repeat(64)}`, rootId: 'd'.repeat(64) };
const target = { ...base, refKind: 'commit', refId: `12${'e'.repeat(64)}`, commitId: `12${'e'.repeat(64)}`, layerId: undefined, rootId: 'f'.repeat(64) };
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'camp-change-set-'));
  const beforeDirectory = join(folder, 'before'), afterDirectory = join(folder, 'after');
  await mkdir(beforeDirectory); await mkdir(afterDirectory);
  return { folder, beforeDirectory, afterDirectory, base, target, close: () => rm(folder, { recursive: true, force: true }) };
}
test('Layer baseline diff records text, binary, permissions, deletion, type changes and opaque symlinks', async () => {
  const f = await fixture();
  try {
    for (const dir of [f.beforeDirectory, f.afterDirectory]) { await writeFile(join(dir, 'text'), 'old\n'); await writeFile(join(dir, 'mode'), 'same'); }
    await writeFile(join(f.afterDirectory, 'text'), 'new\n');
    await chmod(join(f.beforeDirectory, 'mode'), 0o751); await chmod(join(f.afterDirectory, 'mode'), 0o644);
    await writeFile(join(f.beforeDirectory, 'deleted'), 'removed\n');
    await writeFile(join(f.afterDirectory, 'added'), 'created\n');
    await writeFile(join(f.beforeDirectory, 'binary'), Buffer.from([0, 1])); await writeFile(join(f.afterDirectory, 'binary'), Buffer.from([0, 2]));
    await writeFile(join(f.beforeDirectory, 'changed-type'), 'file'); await mkdir(join(f.afterDirectory, 'changed-type'));
    await symlink('text', join(f.beforeDirectory, 'link')); await symlink('/outside/unreadable', join(f.afterDirectory, 'link'));
    const report = parseChangeSet(await compareSnapshotDirectories(f));
    const rows = new Map(report.entries.map(row => [row.path, row]));
    assert.match(rows.get('text').patch, /-old\n\+new/);
    assert.equal(rows.get('binary').binary, true); assert.equal(rows.get('binary').patch, null);
    assert.equal(rows.get('mode').modeChanged, true); assert.equal(rows.get('mode').before.mode, 0o751); assert.equal(rows.get('mode').previewReason, 'metadata_only');
    assert.equal(rows.get('deleted').change, 'deleted'); assert.equal(rows.get('added').change, 'added');
    assert.equal(rows.get('changed-type').change, 'type_changed');
    assert.equal(rows.get('link').after.target, '/outside/unreadable');
    assert.equal(report.base.refKind, 'layer'); assert.equal(report.truncated, false);
  } finally { await f.close(); }
});
test('diff does not follow symlinked directories or execute project programs', async () => {
  const f = await fixture();
  try {
    const outside = join(f.folder, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'NEVER_READ');
    await symlink(outside, join(f.afterDirectory, 'directory-link'));
    const marker = join(f.folder, 'executed');
    await writeFile(join(f.afterDirectory, 'diff'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const report = await compareSnapshotDirectories(f);
    assert.equal(report.entries.some(row => row.path.includes('secret')), false);
    assert.equal(JSON.stringify(report).includes('NEVER_READ'), false);
    await assert.rejects(access(marker));
  } finally { await f.close(); }
});
test('root mode uses the sole dot path and bounded patches disclose truncation', async () => {
  const f = await fixture();
  try {
    await chmod(f.beforeDirectory, 0o700); await chmod(f.afterDirectory, 0o750);
    await writeFile(join(f.beforeDirectory, 'large'), 'before\n'.repeat(10000));
    await writeFile(join(f.afterDirectory, 'large'), 'after\n'.repeat(10000));
    const report = parseChangeSet(await compareSnapshotDirectories({ ...f, limits: { ...CAMP_CHANGE_LIMITS, maxPatchBytes: 128 } }));
    const root = report.entries.find(row => row.path === '.'); assert.equal(root.before.type, 'directory'); assert.equal(root.modeChanged, true);
    const large = report.entries.find(row => row.path === 'large'); assert.equal(large.patchTruncated, true); assert.ok(Buffer.byteLength(large.patch) <= 128);
  } finally { await f.close(); }
});
test('entry and total payload admission never presents omitted changes as an empty complete diff', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 6; n++) await writeFile(join(f.afterDirectory, `new-${n}`), `file ${n}`);
    const report = parseChangeSet(await compareSnapshotDirectories({ ...f, limits: { ...CAMP_CHANGE_LIMITS, maxEntries: 2, maxTotalPatchBytes: 10 } }));
    assert.equal(report.entries.length, 2); assert.equal(report.stats.added, 6); assert.equal(report.truncated, true);
    assert.ok(report.entries.some(row => row.patchTruncated));
  } finally { await f.close(); }
});
