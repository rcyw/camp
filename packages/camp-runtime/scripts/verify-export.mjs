import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, readlink, stat, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CampRuntime } from '../src/index.mjs';
import { exportCandidate } from '../src/export.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const folder = await mkdtemp(join(root, '.local/export-proof-'));
const source = join(folder, 'source');
await mkdir(join(source, 'src'), { recursive: true });
await mkdir(join(source, '.camp'));
await writeFile(join(source, '.camp/runtime.env'), 'DO_NOT_EXPORT_RUNTIME_SECRET');
await writeFile(join(source, 'src/program.mjs'), '#!/usr/bin/env node\nconsole.log(2+2);\n');
await chmod(join(source, 'src/program.mjs'), 0o751);
const binary = Buffer.from(Array.from({ length: 180_000 }, (_, index) => index % 256));
await writeFile(join(source, 'payload.bin'), binary);
await writeFile(join(source, 'obsolete.txt'), 'original remains on host');
await symlink('src/program.mjs', join(source, 'program-link'));
const runtime = await new CampRuntime().ready();
const project = await runtime.prepareProject({ projectId: `export-proof-${Date.now()}`, sourcePath: source });
let run;
const env = { ...process.env, CAMP_RUNTIME_HOME: runtime.home, CAMP_RUNTIME_IMAGE: runtime.imageId };
const cli = (candidate, flag, output) => execute(process.execPath, [join(root, 'scripts/export.mjs'), '--project', candidate.projectId, '--commit', candidate.commitId, '--root', candidate.rootId, flag, output], { env, timeout: 30_000 });
try {
  run = await runtime.prepareRun({ project, runId: `export-fixture-${Date.now()}`, roleId: 'builder' });
  const changed = await runtime.exec(run, 'rm obsolete.txt && printf "delivery complete\\n" > DELIVERY.md');
  assert.equal(changed.exitCode, 0);
  const candidate = await runtime.commitCandidate(run);
  await runtime.releaseRun(run);
  run = null;
  const output = join(folder, 'directory');
  const receipt = JSON.parse((await cli(candidate, '--output', output)).stdout);
  assert.deepEqual(await readFile(join(output, 'payload.bin')), binary);
  assert.equal((await stat(join(output, 'src/program.mjs'))).mode & 0o777, 0o751);
  assert.equal(await readlink(join(output, 'program-link')), 'src/program.mjs');
  await assert.rejects(access(join(output, 'obsolete.txt')));
  await assert.rejects(access(join(output, '.camp')));
  assert.equal(await readFile(join(source, 'obsolete.txt'), 'utf8'), 'original remains on host');
  const archive = join(folder, 'result.tar');
  await cli(candidate, '--archive', archive);
  const unpacked = join(folder, 'unpacked');
  await mkdir(unpacked);
  await execute('tar', ['-xf', archive, '-C', unpacked], { timeout: 10_000 });
  assert.deepEqual(await readFile(join(unpacked, 'payload.bin')), binary);
  assert.equal((await stat(join(unpacked, 'src/program.mjs'))).mode & 0o777, 0o751);
  assert.equal(await readlink(join(unpacked, 'program-link')), 'src/program.mjs');
  await assert.rejects(access(join(unpacked, 'obsolete.txt')));
  await assert.rejects(cli(candidate, '--output', output));
  const wrong = { ...candidate, rootId: '0'.repeat(64) };
  await assert.rejects(cli(wrong, '--output', join(folder, 'wrong-root')));
  run = await runtime.prepareRun({ project, runId: `export-badlink-${Date.now()}`, roleId: 'builder', baseRef: candidate.commitId });
  assert.equal((await runtime.exec(run, 'ln -s /tmp/camp-dsh-home unsafe-runtime-link')).exitCode, 0);
  const unsafe = await runtime.commitCandidate(run);
  await runtime.releaseRun(run);
  run = null;
  await assert.rejects(cli(unsafe, '--output', join(folder, 'unsafe')));
  await assert.rejects(access(join(folder, 'unsafe')));
  const dockerCall = runtime.dockerCall.bind(runtime), prepareRun = runtime.prepareRun.bind(runtime);
  const replacedOutput = join(folder, 'replaced-manifest');
  const sentinel = join(folder, 'untouched-sentinel');
  await writeFile(sentinel, 'never overwrite this file');
  let replaced = false;
  runtime.dockerCall = async (args, options) => {
    if (!replaced && args[0] === 'cp' && args[2]?.endsWith(':/tmp/camp-snapshot-stream.mjs')) {
      replaced = true;
      await unlink(`${replacedOutput}.manifest.json`);
      await symlink(sentinel, `${replacedOutput}.manifest.json`);
    }
    return dockerCall(args, options);
  };
  try {
    await assert.rejects(exportCandidate({ runtime, candidate, output: replacedOutput }), /reservation was replaced/);
    assert.equal(await readFile(sentinel, 'utf8'), 'never overwrite this file');
    await assert.rejects(access(replacedOutput));
    assert.equal(await readlink(`${replacedOutput}.manifest.json`), sentinel, 'cleanup must not remove a replaced sidecar');
  } finally { runtime.dockerCall = dockerCall; await unlink(`${replacedOutput}.manifest.json`); }
  const stall = join(folder, 'stall-snapshot.mjs');
  await writeFile(stall, 'setInterval(() => {}, 1000);\n');
  let stalledContainer;
  runtime.dockerCall = (args, options) => dockerCall(args[0] === 'cp' && args[2]?.endsWith(':/tmp/camp-snapshot-stream.mjs') ? ['cp', stall, args[2]] : args, options);
  runtime.prepareRun = async options => { const prepared = await prepareRun(options); stalledContainer = prepared.containerId; return prepared; };
  const previousDeadline = process.env.CAMP_EXPORT_TIMEOUT_MS;
  const timedOutput = join(folder, 'deadline-output');
  const deadlineStart = Date.now();
  try {
    process.env.CAMP_EXPORT_TIMEOUT_MS = '5000';
    await assert.rejects(exportCandidate({ runtime, candidate, output: timedOutput }));
    assert.ok(stalledContainer, 'the deadline must interrupt a real running export sandbox');
    await assert.rejects(dockerCall(['inspect', stalledContainer]));
    await assert.rejects(access(timedOutput));
    await assert.rejects(access(`${timedOutput}.manifest.json`));
    assert.ok(Date.now() - deadlineStart < 15_000, 'deadline cleanup must remain bounded');
  } finally {
    if (previousDeadline === undefined) delete process.env.CAMP_EXPORT_TIMEOUT_MS;
    else process.env.CAMP_EXPORT_TIMEOUT_MS = previousDeadline;
    runtime.dockerCall = dockerCall;
    runtime.prepareRun = prepareRun;
  }
  const proof = { at: new Date().toISOString(), candidate: { projectId: candidate.projectId, refKind: candidate.refKind, refId: candidate.refId, rootId: candidate.rootId }, binaryBytes: binary.length, executableMode: '0751', symlinkPreserved: true, deletionPreserved: true, originalSourceUnchanged: true, runtimeHomeExcluded: true, existingOutputRejected: true, rootMismatchRejected: true, unsafeSymlinkRejected: true, directoryAndTarVerified: true, replacedManifestRejectedWithoutOverwrite: true, stalledSnapshotDeadlineMs: 5000, deadlineStoppedOwnSandbox: true, deadlineRemovedPartialOutput: true, files: receipt.files, modelCalled: false };
  await writeFile(join(root, '.local/export-roundtrip.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally { if (run) await runtime.abortRun(run, 'export_proof_cleanup'); }
