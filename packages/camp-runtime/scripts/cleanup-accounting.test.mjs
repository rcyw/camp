import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampRuntime } from '../src/index.mjs';

for (const cause of ['uncertain-native-outcome', 'cleanup-query-failed']) {
  test(`prepareRun does not claim known cleanup after ${cause}`, async () => {
    const folder = await mkdtemp(join(tmpdir(), 'camp-cleanup-'));
    const project = { projectId: 'project', home: join(folder, 'project-home') };
    await mkdir(join(project.home, project.projectId), { recursive: true });
    await writeFile(join(project.home, project.projectId, 'project.record'), '{}');
    class FaultRuntime extends CampRuntime {
      async sdk() { throw Object.assign(new Error('Native fork failed'), cause === 'uncertain-native-outcome' ? { cleanupKnown: false } : {}); }
      async dockerCall() {
        if (cause === 'cleanup-query-failed') throw new Error('Docker unavailable');
        return { stdout: '' };
      }
    }
    try {
      const runtime = new FaultRuntime({ home: folder });
      await assert.rejects(runtime.prepareRun({ project, runId: cause, roleId: 'builder' }), error => error.cleanupKnown === false);
      const runs = await import('node:fs/promises').then(fs => fs.readdir(join(folder, 'runs')));
      const receipt = JSON.parse(await readFile(join(folder, 'runs', runs[0], 'prepare-failed.json'), 'utf8'));
      assert.equal(receipt.cleanupKnown, false);
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
}
