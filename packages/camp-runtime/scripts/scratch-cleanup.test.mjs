import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampRuntime } from '../src/index.mjs';

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'camp-scratch-cleanup-'));
  const runtime = new CampRuntime({ home: join(folder, 'state') });
  const owner = runtime.runIdentity('owned-attempt');
  await mkdir(owner.folder, { recursive: true });
  runtime.dockerCall = async () => ({ stdout: '' });
  return { folder, runtime, owner, close: () => rm(folder, { recursive: true, force: true }) };
}
test('owned scratch cleanup removes exact materializations and harness copies while retaining audit and unknown data', async () => {
  const f = await fixture();
  try {
    const names = ['integration-base', 'integration-left', 'integration-right', 'integration-result', 'verification-snapshot', `diff-base-32${'a'.repeat(64)}`, `diff-target-12${'b'.repeat(64)}`];
    const outside = join(f.folder, 'outside'); await mkdir(outside); await writeFile(join(outside, 'keep'), 'untouched');
    for (const name of names) {
      const directory = join(f.owner.folder, name); await mkdir(directory);
      await writeFile(join(directory, 'large'), 'private candidate bytes');
      await symlink(outside, join(directory, 'opaque'));
      await chmod(directory, 0);
      await writeFile(`${directory}.manifest.json`, '{}');
    }
    await writeFile(join(f.owner.folder, 'harness-core'), 'trusted source');
    for (const name of ['integration-intent.json', 'integration-result.json', 'integration-native.json', 'verification-intent.json', 'verification-result.json', 'run.json', 'journal.json', 'candidate-source', 'diff-base-invalid']) {
      await writeFile(join(f.owner.folder, name), 'retain');
    }
    await f.runtime.cleanupAttempt(f.owner.prefix);
    for (const name of [...names, ...names.map(value => `${value}.manifest.json`), 'harness-core']) await assert.rejects(lstat(join(f.owner.folder, name)), { code: 'ENOENT' });
    for (const name of ['integration-intent.json', 'integration-result.json', 'integration-native.json', 'verification-intent.json', 'verification-result.json', 'run.json', 'journal.json', 'candidate-source', 'diff-base-invalid']) assert.equal(await readFile(join(f.owner.folder, name), 'utf8'), 'retain');
    assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'untouched');
    await f.runtime.cleanupAttempt(f.owner.prefix); // Idempotent after recovery.
  } finally { await f.close(); }
});
test('auxiliary-prefix cleanup cannot garbage collect its still-active parent scratch', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.owner.folder, 'verification-snapshot'));
    await f.runtime.cleanupAttempt(`${f.owner.prefix}aux-${'a'.repeat(16)}-`);
    assert.equal((await lstat(join(f.owner.folder, 'verification-snapshot'))).isDirectory(), true);
  } finally { await f.close(); }
});
for (const level of ['runs-parent', 'attempt']) test(`scratch cleanup rejects a symlink at the ${level} boundary`, async () => {
  const f = await fixture();
  try {
    const outside = join(f.folder, 'outside'); await mkdir(outside); await mkdir(join(outside, 'verification-snapshot'));
    await writeFile(join(outside, 'verification-snapshot', 'keep'), 'untouched');
    if (level === 'attempt') { await rm(f.owner.folder, { recursive: true }); await symlink(outside, f.owner.folder); }
    else { await rm(join(f.runtime.home, 'runs'), { recursive: true }); await symlink(outside, join(f.runtime.home, 'runs')); }
    await assert.rejects(f.runtime.cleanupAttempt(f.owner.prefix), /symlink|directory|boundary/i);
    assert.equal(await readFile(join(outside, 'verification-snapshot', 'keep'), 'utf8'), 'untouched');
  } finally { await f.close(); }
});
