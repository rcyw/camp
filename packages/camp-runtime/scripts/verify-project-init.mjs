import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';

let initializations = 0;
class AuditedRuntime extends CampRuntime {
  async sdk(project, method, args, config) {
    if (method === 'project.init') initializations++;
    return super.sdk(project, method, args, config);
  }
}
const stamp = Date.now();
const first = await new AuditedRuntime().ready();
const second = await new AuditedRuntime().ready();
const projectId = `concurrent-project-proof-${stamp}`;
const [a, b] = await Promise.all([first.prepareProject({ projectId }), second.prepareProject({ projectId })]);
assert.equal(initializations, 1, 'Only one SDK project.init may run for a project');
assert.equal(a.projectId, b.projectId);
assert.equal(a.storePath, b.storePath);
const original = await first.sdk(a, 'fs.read', ['main', '/README.md']);
assert.match(original.text, /Camp shared project/);
const separate = await new AuditedRuntime({ home: `${first.home}-separate-${stamp}` }).ready();
await assert.rejects(separate.prepareProject({ projectId }), /volume exists without this runtime home project record/);
assert.equal(initializations, 1, 'A second runtime home must never overwrite an existing Store');
const retained = await first.sdk(a, 'fs.read', ['main', '/README.md']);
assert.equal(retained.text, original.text);
const receipt = { at: new Date().toISOString(), projectId: a.projectId, actualConcurrentCallers: 2, sdkInitializations: initializations, sharedStore: a.storePath, differentHomeRejected: true, storeContentsUnchanged: true, modelCalled: false };
await writeFile(fileURLToPath(new URL('../.local/project-init-concurrency.json', import.meta.url)), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
