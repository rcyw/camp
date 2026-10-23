import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, symlink, chmod, open, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageSource } from '../src/source-snapshot.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const execute = promisify(execFile);

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

test('an empty Git selection never falls back to ignored private files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-empty-git-'));
  try {
    const source = join(folder, 'source'); await mkdir(source);
    await execute('git', ['-C', source, 'init', '--quiet']);
    await writeFile(join(source, '.gitignore'), '*\n'); await writeFile(join(source, 'custom-private.json'), '{"private":"must remain excluded"}');
    const result = await stageSource(source, join(folder, 'seed'));
    assert.equal(result.files, 0); await assert.rejects(access(join(folder, 'seed', 'custom-private.json')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('source metadata reads never execute repository filesystem monitors', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-git-monitor-'));
  try {
    const source = join(folder, 'source'), marker = join(folder, 'executed'), hook = join(folder, 'monitor'); await mkdir(source);
    await execute('git', ['-C', source, 'init', '--quiet']); await writeFile(join(source, 'file'), 'tracked'); await execute('git', ['-C', source, 'add', 'file']);
    await writeFile(hook, `#!/bin/sh\nprintf invoked > '${marker}'\nprintf 'token\\0'\n`); await chmod(hook, 0o700);
    await execute('git', ['-C', source, 'config', 'core.fsmonitor', hook]);
    await execute('git', ['-C', source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    assert.equal(await readFile(marker, 'utf8'), 'invoked', 'The unguarded real command must reproduce code execution'); await rm(marker);
    const result = await stageSource(source, join(folder, 'seed')); assert.equal(result.files, 1);
    await assert.rejects(access(marker)); assert.equal(await readFile(join(folder, 'seed', 'file'), 'utf8'), 'tracked');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a corrupted Git index fails closed instead of importing ignored files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-git-corrupt-'));
  try {
    const source = join(folder, 'source'); await mkdir(source); await execute('git', ['-C', source, 'init', '--quiet']);
    await writeFile(join(source, 'file'), 'tracked'); await execute('git', ['-C', source, 'add', 'file']);
    await writeFile(join(source, '.gitignore'), '*.private\n'); await writeFile(join(source, 'credentials.private'), 'must remain excluded'); await writeFile(join(source, '.git', 'index'), 'corrupt index');
    await assert.rejects(stageSource(source, join(folder, 'seed')), /Git source selection failed/); await assert.rejects(access(join(folder, 'seed')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Git configuration FIFO includes have a hard subprocess deadline', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-git-config-fifo-'));
  try {
    const source = join(folder, 'source'), fifo = join(folder, 'config-fifo'); await mkdir(source); await execute('git', ['-C', source, 'init', '--quiet']); await execute('mkfifo', [fifo]);
    await writeFile(join(source, '.git', 'config'), `[core]\nrepositoryformatversion = 0\n[include]\npath = ${fifo}\n`);
    const start = Date.now(); await assert.rejects(stageSource(source, join(folder, 'seed'), { gitTimeoutMs: 100 }), { code: 'source_git_timeout' });
    assert.ok(Date.now() - start < 2000); await assert.rejects(access(join(folder, 'seed')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('Git import entry budgets include distinct parent directories and the root', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-git-entries-'));
  try {
    const source = join(folder, 'source'); await mkdir(join(source, 'one'), { recursive: true }); await mkdir(join(source, 'two')); await execute('git', ['-C', source, 'init', '--quiet']);
    await writeFile(join(source, 'one', 'file'), 'one'); await writeFile(join(source, 'two', 'file'), 'two'); await execute('git', ['-C', source, 'add', '.']);
    await assert.rejects(stageSource(source, join(folder, 'seed'), { maxEntries: 4 }), /entry.*budget/); await assert.rejects(access(join(folder, 'seed')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

for (const git of [false, true]) test(`${git ? 'Git' : 'directory'} source import rejects actual invalid UTF-8 names without silently dropping them`, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-source-invalid-name-'));
  try {
    const source = join(folder, 'source'); await mkdir(source);
    await writeFile(Buffer.concat([Buffer.from(`${source}/`), Buffer.from([0xff])]), 'must not disappear');
    if (git) { await execute('git', ['-C', source, 'init', '--quiet']); await execute('git', ['-C', source, 'add', '--all']); }
    await assert.rejects(stageSource(source, join(folder, 'seed')), /requires UTF-8/); await assert.rejects(access(join(folder, 'seed')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('source symlink targets retain exact UTF-8 or fail explicitly', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-source-invalid-link-'));
  try {
    const source = join(folder, 'source'); await mkdir(source); await symlink(Buffer.from([0xff]), join(source, 'link'));
    await assert.rejects(stageSource(source, join(folder, 'seed')), /requires UTF-8/); await assert.rejects(access(join(folder, 'seed')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('source imports preserve leading BOM characters in names and symlink targets', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-source-bom-'));
  try {
    const source = join(folder, 'source'); await mkdir(source); await writeFile(join(source, '\uFEFFname'), 'preserved'); await symlink('\uFEFFname', join(source, 'link'));
    await execute('git', ['-C', source, 'init', '--quiet']); await execute('git', ['-C', source, 'add', '--all']);
    await stageSource(source, join(folder, 'seed'));
    assert.equal(await readFile(join(folder, 'seed', '\uFEFFname'), 'utf8'), 'preserved'); assert.equal(await readlink(join(folder, 'seed', 'link')), '\uFEFFname');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('the Git command deadline excludes slow host file copies after selection finishes', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-source-slow-copy-'));
  try {
    const source = join(folder, 'source'); await mkdir(source); await execute('git', ['-C', source, 'init', '--quiet']); await writeFile(join(source, 'file'), Buffer.alloc(256 * 1024)); await execute('git', ['-C', source, 'add', 'file']);
    const handle = await open(join(source, 'file'), 'r'), prototype = Object.getPrototypeOf(handle), read = prototype.createReadStream; await handle.close();
    t.mock.method(prototype, 'createReadStream', function (options) {
      const stream = read.call(this, options);
      return (async function* () { for await (const chunk of stream) { await delay(80); yield chunk; } })();
    });
    const start = Date.now(), result = await stageSource(source, join(folder, 'seed'), { gitTimeoutMs: 100 });
    assert.equal(result.files, 1); assert.ok(Date.now() - start >= 300); assert.equal((await readFile(join(folder, 'seed', 'file'))).length, 256 * 1024);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('an explicitly selected ignored fixture directory still imports its files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-ignored-source-'));
  try {
    await execute('git', ['-C', folder, 'init', '--quiet']); await writeFile(join(folder, '.gitignore'), 'fixtures/\n');
    const source = join(folder, 'fixtures'); await mkdir(source); await writeFile(join(source, 'app.js'), 'export const ready = true;');
    const result = await stageSource(source, join(folder, 'seed'));
    assert.equal(result.files, 1); assert.equal(await readFile(join(folder, 'seed', 'app.js'), 'utf8'), 'export const ready = true;');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('a tracked file cannot read outside the source through a replaced parent link', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-git-parent-'));
  try {
    const source = join(folder, 'source'), outside = join(folder, 'outside'); await mkdir(join(source, 'nested'), { recursive: true }); await mkdir(outside);
    await execute('git', ['-C', source, 'init', '--quiet']); await writeFile(join(source, 'nested', 'file'), 'tracked'); await execute('git', ['-C', source, 'add', 'nested/file']);
    await rm(join(source, 'nested'), { recursive: true }); await writeFile(join(outside, 'file'), 'must not import'); await symlink(outside, join(source, 'nested'));
    await assert.rejects(stageSource(source, join(folder, 'seed')), /symlink or non-directory parent/); await assert.rejects(access(join(folder, 'seed', 'nested', 'file')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('staging refuses a preexisting destination and never follows its links', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-existing-seed-'));
  try {
    const source = join(folder, 'source'), outside = join(folder, 'outside'), seed = join(folder, 'seed');
    await mkdir(join(source, 'nested'), { recursive: true }); await mkdir(seed); await mkdir(outside); await writeFile(join(source, 'nested', 'file'), 'new source'); await symlink(outside, join(seed, 'nested'));
    await assert.rejects(stageSource(source, seed), { code: 'EEXIST' }); await assert.rejects(access(join(outside, 'file')));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('source import enforces actual byte and entry budgets and removes its failed partial seed', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'camp-source-limits-'));
  try {
    const source = join(folder, 'source'); await mkdir(source); await writeFile(join(source, 'one'), '12345'); await writeFile(join(source, 'two'), '67890');
    await assert.rejects(stageSource(source, join(folder, 'too-many'), { maxEntries: 1 }), /entry.*budget/);
    await assert.rejects(access(join(folder, 'too-many')));
    await assert.rejects(stageSource(source, join(folder, 'too-large'), { maxBytes: 6 }), /byte budget/);
    await assert.rejects(access(join(folder, 'too-large')));
    const controller = new AbortController(); controller.abort(new Error('Stop before importing'));
    await assert.rejects(stageSource(source, join(folder, 'aborted'), { signal: controller.signal }), /Stop before importing/);
    await assert.rejects(access(join(folder, 'aborted')));
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
