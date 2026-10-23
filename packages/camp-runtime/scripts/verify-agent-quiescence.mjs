import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';

const runtime = await new CampRuntime().ready();
const stamp = Date.now();
const project = await runtime.prepareProject({ projectId: `quiescence-proof-${stamp}` });
let run;
try {
  run = await runtime.prepareRun({ project, runId: `quiescence-${stamp}`, roleId: 'builder' });
  await runtime.dockerCall(['exec', '-d', '--user', '501:20', '--workdir', run.workspacePath, run.containerId, '/usr/local/bin/node', '-e', "setInterval(() => require('node:fs').appendFileSync('background-writes.txt', 'x'), 10)"]);
  const size = async () => Number((await runtime.dockerCall(['exec', '--user', '0:0', run.containerId, '/usr/local/bin/node', '-e', "process.stdout.write(String(require('node:fs').statSync(process.argv[1]).size))", `${run.workspacePath}/background-writes.txt`])).stdout);
  await delay(150);
  const before = await size();
  assert.ok(before > 0);
  await runtime.quiesceAgent(run);
  const stopped = await size();
  await delay(200);
  assert.equal(await size(), stopped, 'no background process may write after trusted quiescence');
  const candidate = await runtime.commitCandidate(run);
  assert.equal(candidate.refKind, 'commit', 'root LayerFS daemon must remain available to capture the stopped view');
  await runtime.releaseRun(run);
  run = null;
  const receipt = { at: new Date().toISOString(), backgroundAgentWritingBefore: true, backgroundAgentStopped: true, daemonSurvived: true, candidateRef: candidate.refId, candidateRoot: candidate.rootId, scopedToOwnSandbox: true, modelCalled: false };
  await writeFile(fileURLToPath(new URL('../.local/agent-quiescence.json', import.meta.url)), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { if (run) await runtime.abortRun(run, 'quiescence_proof_cleanup'); }
