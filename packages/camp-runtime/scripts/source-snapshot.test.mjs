import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSource } from '../src/source-snapshot.mjs';

test('source import excludes known credentials and dependency homes without modifying the source', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-snapshot-'));
  const source = join(folder, 'input');
  await mkdir(join(source, '.camp'), { recursive: true });
  await mkdir(join(source, 'node_modules'), { recursive: true });
  for (const [file, text] of Object.entries({ 'app.js': 'export const ready = true;', '.env': 'SECRET=not-for-agent', '.env.local': 'SECRET=private', '.dev-env-camp.json': '{"jwt":"private"}', '.camp/runtime.env': 'KEY=private', 'node_modules/private.js': 'private' })) await writeFile(join(source, file), text);
  try {
    const staged = await stageSource(source, join(folder, 'seed'));
    assert.equal(staged.files, 1);
    assert.equal(await readFile(join(folder, 'seed/app.js'), 'utf8'), 'export const ready = true;');
    for (const file of ['.env', '.env.local', '.dev-env-camp.json', '.camp', 'node_modules']) await assert.rejects(access(join(folder, 'seed', file)));
    assert.equal(await readFile(join(source, '.env'), 'utf8'), 'SECRET=not-for-agent');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test('an import seed inside the source is excluded from recursive import', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-nested-seed-'));
  try {
    await writeFile(join(folder, 'source.js'), 'export const value = 1;');
    const destination = join(folder, 'runtime', 'import-seed');
    const staged = await stageSource(folder, destination);
    assert.equal(staged.files, 1);
    await assert.rejects(access(join(destination, 'runtime')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});
