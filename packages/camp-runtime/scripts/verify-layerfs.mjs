import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';

const runtime = await new CampRuntime().ready();
const stamp = Date.now();
const project = await runtime.prepareProject({ projectId: `real-proof-${stamp}` });
const active = [];
try {
  const builder = await runtime.prepareRun({ project, runId: `builder-${stamp}`, roleId: 'builder' });
  active.push(builder);
  const reviewer = await runtime.prepareRun({ project, runId: `reviewer-${stamp}`, roleId: 'reviewer' });
  active.push(reviewer);
  assert.notEqual(builder.containerId, reviewer.containerId, 'roles must run in different real Docker containers');
  const mutation = await runtime.exec(builder, 'printf "built by builder\\n" > candidate.txt; id -u; test ! -S /var/run/docker.sock; test ! -r /layerfs-store/global/store.sqlite');
  assert.equal(mutation.exitCode, 0, mutation.stderr);
  assert.equal(mutation.stdout.trim(), '501');
  const isolation = await runtime.exec(reviewer, 'test ! -e candidate.txt && printf isolated');
  assert.equal(isolation.exitCode, 0, isolation.stderr);
  const candidate = await runtime.commitCandidate(builder);
  assert.match(candidate.commitId, /^[0-9a-f]{64,68}$/);
  assert.match(candidate.rootId, /^[0-9a-f]{64}$/);
  const child = await runtime.prepareRun({ project, runId: `child-${stamp}`, roleId: 'reviewer', baseRef: candidate.commitId });
  active.push(child);
  const inherited = await runtime.exec(child, 'cat candidate.txt');
  assert.equal(inherited.exitCode, 0, inherited.stderr);
  assert.equal(inherited.stdout, 'built by builder\n');
  const saved = await runtime.sdk(project, 'fs.read', [candidate.commitId, '/candidate.txt']);
  assert.equal(saved.text, 'built by builder\n');
  const receipt = { at: new Date().toISOString(), profile: 'Disposable', imageId: builder.imageId, projectId: project.projectId, containers: active.map(run => ({ role: run.roleId, id: run.containerId })), candidate, isolated: isolation.stdout, inherited: inherited.stdout, uid: mutation.stdout.trim(), dockerSocketAbsent: true, storeUnreadableToAgent: true };
  await writeFile(fileURLToPath(new URL('../.local/verify-receipt.json', import.meta.url)), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  for (const run of active.reverse()) await runtime.releaseRun(run, { discard: true });
}
