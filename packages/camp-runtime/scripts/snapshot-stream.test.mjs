import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Writable } from 'node:stream';
import { mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamSnapshot } from '../src/snapshot-stream.mjs';

function sink() { const chunks = []; return { output: new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }), frames: () => Buffer.concat(chunks).toString('utf8').trim().split('\n').map(JSON.parse) }; }
test('snapshot transport rejects actual invalid UTF-8 symlink targets', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-snapshot-invalid-link-'));
  try { await symlink(Buffer.from([0xff]), join(folder, 'link')); await assert.rejects(streamSnapshot(folder, sink().output), /UTF-8 symlink targets/); }
  finally { await rm(folder, { recursive: true, force: true }); }
});
test('snapshot transport preserves BOM-prefixed names and opaque link targets exactly', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-snapshot-bom-'));
  try {
    await writeFile(join(folder, '\uFEFFname'), 'exact'); await symlink('\uFEFFname', join(folder, 'link')); const stream = sink(); await streamSnapshot(folder, stream.output);
    assert.ok(stream.frames().some(frame => frame.type === 'file' && frame.path === '\uFEFFname'));
    assert.equal(stream.frames().find(frame => frame.type === 'symlink').target, '\uFEFFname');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
