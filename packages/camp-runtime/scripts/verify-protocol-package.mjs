import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';
import { CAMP_PROTOCOL_VERSION, CAMP_WORKER_VERSION } from '../../camp-protocol/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const image = JSON.parse(await readFile(`${root}/.local/baked-image.json`, 'utf8'));
const runtime = await new CampRuntime({ imageId: image.imageId }).ready();
const stamp = Date.now();
const project = await runtime.prepareProject({ projectId: `protocol-package-proof-${stamp}` });
let run;
try {
  run = await runtime.prepareRun({ project, runId: `protocol-package-${stamp}`, roleId: 'planner' });
  await runtime.installDsh(run);
  await runtime.installPlugin(run, `${root}/../dsh-plugin`);
  const code = `
    import assert from 'node:assert/strict';
    import {readFile} from 'node:fs/promises';
    import {apply} from '/opt/camp-dsh-plugin/src/index.js';
    import {pluginProtocol} from '/opt/camp-dsh-plugin/src/protocol.js';
    import {CAMP_TOOL_SCHEMAS, createWorkerDeclaration} from '/opt/camp-protocol/src/index.js';
    const descriptor = JSON.parse(await readFile('/opt/camp-dsh-plugin/protocol.json', 'utf8'));
    assert.deepEqual(descriptor, createWorkerDeclaration());
    assert.deepEqual(pluginProtocol, descriptor);
    const tools = new Map();
    apply({tools:{register(tool){tools.set(tool.name,tool);return()=>{};}},systemPrompt:{section(){}},on(){}});
    assert.equal(tools.size, 12);
    for (const [name, tool] of tools) assert.deepEqual(tool.parameters, CAMP_TOOL_SCHEMAS[name]);
    console.log(JSON.stringify({protocolLoaded:true,pluginLoaded:true,staticDescriptorMatches:true,sharedToolSchemas:tools.size,uid:process.getuid()}));
  `;
  const installed = JSON.parse((await runtime.dockerCall(['exec', '--user', '501:20', run.containerId, '/usr/local/bin/node', '--input-type=module', '-e', code])).stdout);
  assert.equal(installed.uid, 501);
  const config = await runtime.exec(run, 'DSH_HOME=/tmp/camp-dsh-home node /opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile camp --dump-config');
  assert.equal(config.exitCode, 0, config.stderr);
  assert.match(config.stdout, /camp-room-tools/);
  await runtime.releaseRun(run, { discard: true });
  run = null;
  const receipt = { at: new Date().toISOString(), imageId: image.imageId, protocolVersion: CAMP_PROTOCOL_VERSION, workerVersion: CAMP_WORKER_VERSION, installed, dshProfileLoaded: true, originalImageUnchanged: true, modelCalled: false };
  await writeFile(`${root}/.local/protocol-packaging.json`, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt));
} finally { if (run) await runtime.abortRun(run, 'protocol_package_proof_cleanup'); }
