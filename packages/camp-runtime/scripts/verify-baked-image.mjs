import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const originalRecord = await readFile(`${root}/.local/image.json`, 'utf8');
const baked = JSON.parse(await readFile(`${root}/.local/baked-image.json`, 'utf8'));
const runtime = await new CampRuntime({ imageId: baked.imageId }).ready();
const stamp = Date.now();
const project = await runtime.prepareProject({ projectId: `baked-toolchain-proof-${stamp}` });
let run;
try {
  run = await runtime.prepareRun({ project, runId: `baked-proof-${stamp}`, roleId: 'builder' });
  await runtime.installDsh(run); // Must use the already installed executable.
  await runtime.installPlugin(run, `${root}/../dsh-plugin`);
  const checked = async command => {
    const result = await runtime.exec(run, command);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const versions = await checked('node --version && npm --version && git --version');
  const git = await checked('git init -q && git config user.name Camp && git config user.email camp@example.invalid && git add README.md && git commit -qm "Local toolchain proof" && git rev-parse HEAD && git show HEAD:README.md');
  const tests = await checked("printf \"import {test} from 'node:test'; import assert from 'node:assert/strict'; test('baked runtime',()=>assert.equal(2+2,4));\\n\" > runtime.test.mjs && npm exec --offline -- node --test");
  assert.match(tests, /pass 1/);
  const config = await checked('DSH_HOME=/tmp/camp-dsh-home node /opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile camp --dump-config');
  assert.match(config, /camp-room-tools/);
  assert.equal(await readFile(`${root}/.local/image.json`, 'utf8'), originalRecord, 'Existing project image record must remain unchanged');
  const receipt = { at: new Date().toISOString(), profile: 'Disposable', imageId: baked.imageId, originalImageUnchanged: true, versions: versions.trim(), gitLocalCommit: git.trim(), npmOfflineExecAndNodeTests: tests.trim(), dshProfileInitialized: true, agentUid: '501', modelCalled: false };
  await writeFile(`${root}/.local/baked-image-verification.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally {
  if (run) await runtime.releaseRun(run, { discard: true });
}
