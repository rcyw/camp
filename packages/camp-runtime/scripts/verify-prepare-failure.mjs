import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CampRuntime } from '../src/index.mjs';

// Actual LayerFS fork/mount and Docker cleanup, with only post-mount inspection
// deliberately failed. No model, agent or existing service is involved.
class FailingInspectionRuntime extends CampRuntime {
  async dockerCall(args, options) {
    if (!this.injected && args[0] === 'inspect' && args.includes('{{.Id}}')) {
      this.injected = true;
      this.mountedContainer = (await super.dockerCall(args, options)).stdout.trim();
      throw new Error('Injected post-mount inspect failure');
    }
    return super.dockerCall(args, options);
  }
}
const runtime = await new FailingInspectionRuntime().ready();
const projects = await readdir(join(runtime.home, 'projects'));
const records = await Promise.all(projects.map(id => readFile(join(runtime.home, 'projects', id, 'project.json'), 'utf8').then(JSON.parse)));
const project = records.find(record => record.externalId.startsWith('room:')) ?? records[0];
assert.ok(project, 'Run the real LayerFS proof or room first');
const runId = `prepare-failure-${Date.now()}`;
const hash = createHash('sha256').update(runId).digest('hex').slice(0, 16);
await assert.rejects(runtime.prepareRun({ project, runId, roleId: 'builder' }), error => /Injected post-mount/.test(error.message) && error.cleanupKnown === true);
assert.ok(runtime.mountedContainer, 'The injected failure must occur after a real mount');
const remaining = (await runtime.dockerCall(['ps', '-a', '-q', '--filter', `name=^/camp-mvp-run-${hash}-`])).stdout.trim();
assert.equal(remaining, '', 'No attempt-owned container may remain');
const failure = JSON.parse(await readFile(join(runtime.home, 'runs', hash, 'prepare-failed.json'), 'utf8'));
assert.equal(failure.cleanupKnown, true);
assert.equal(failure.phase, 'mounted');
const receipt = { at: new Date().toISOString(), runId, mountedContainer: runtime.mountedContainer, injectedAt: 'post-mount inspection', cleanupKnown: failure.cleanupKnown, remainingContainers: 0 };
await writeFile(new URL('../.local/prepare-failure-receipt.json', import.meta.url), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
