import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CampRuntime } from '../src/index.mjs';
import { resourcePolicy, storageCapacity } from '../src/resource-policy.mjs';

if (!process.argv.includes('--real')) throw new Error('Use --real for explicit local Docker and LayerFS resource checks; no model calls');
const stamp = 'resources-' + randomUUID(), folder = resolve('.camp/resource-policy', stamp);
await mkdir(folder, { recursive: true, mode: 0o700 });
const image = JSON.parse(await readFile(new URL('../.local/standard-image.json', import.meta.url), 'utf8'));
const policy = resourcePolicy({ CAMP_AGENT_CPU_MILLIS: '250', CAMP_AGENT_MEMORY_MIB: '512', CAMP_AGENT_PIDS_LIMIT: '64', CAMP_MIN_FREE_MIB: '64' });
const runtime = await new CampRuntime({ home: resolve(folder, 'state'), imageId: image.imageId, resources: policy }).ready();
const project = await runtime.prepareProject({ projectId: stamp });
let run, foreign, receipt, failure;
try {
  foreign = await runtime.prepareRun({ project, runId: 'foreign-' + stamp, roleId: 'reviewer' });
  run = await runtime.prepareRun({ project, runId: stamp, roleId: 'builder' });
  const read = program => runtime.dockerCall(['exec', '--user', '501:20', run.containerId, '/usr/local/bin/node', '-e', program], { timeout: 15000 });
  const cgroups = JSON.parse((await read("const fs=require('node:fs');console.log(JSON.stringify(Object.fromEntries(['cpu.max','memory.max','pids.max'].map(p=>[p,fs.readFileSync('/sys/fs/cgroup/'+p,'utf8').trim()]))))")).stdout);
  assert.equal(cgroups['memory.max'], String(policy.memoryBytes)); assert.equal(cgroups['pids.max'], String(policy.pidsLimit));
  const cpu = cgroups['cpu.max'].split(' ').map(Number); assert.equal(cpu[0] / cpu[1], 0.25);
  const processes = JSON.parse((await read("const {spawn}=require('node:child_process');(async()=>{const children=[];let denied=0;await Promise.all(Array.from({length:100},()=>new Promise(resolve=>{const c=spawn('/bin/sleep',['20'],{stdio:'ignore'});c.once('spawn',()=>{children.push(c);resolve()});c.once('error',e=>{if(e.code!=='EAGAIN')throw e;denied++;resolve()})})));await Promise.all(children.map(c=>new Promise(r=>{c.once('exit',r);c.kill('SIGTERM')})));console.log(JSON.stringify({started:children.length,denied}))})().catch(()=>process.exit(1))")).stdout);
  assert.ok(processes.started > 0); assert.ok(processes.denied > 0);
  let memoryExit;
  try { await read("const held=[];for(;;)held.push(Buffer.alloc(16*1024*1024,1))"); }
  catch (error) { memoryExit = error.code; }
  assert.equal(memoryExit, 137, 'The real memory cgroup must terminate the oversized process');
  assert.equal((await runtime.dockerCall(['inspect', '--format', '{{.State.Running}}', foreign.containerId])).stdout.trim(), 'true');
  await storageCapacity(runtime, policy);
  await assert.rejects(storageCapacity(runtime, resourcePolicy({ CAMP_MIN_FREE_MIB: '16777216' })), { code: 'camp_capacity_low' });
  receipt = { at: new Date().toISOString(), modelCalls: 0, projectId: project.projectId, imageId: image.imageId, policy, actualCgroups: cgroups, pidsStarted: processes.started, pidsDenied: processes.denied, memoryExit, foreignAttemptSurvived: true, capacityFloorRejected: true };
} catch (error) {
  failure = error;
} finally {
  const stopped = await Promise.allSettled([run, foreign].filter(Boolean).map(item => runtime.cleanupAttempt(item.config.prefix)));
  if (stopped.some(item => item.status === 'rejected')) failure = new Error('Resource proof cleanup was not confirmed; retained its own Store', { cause: failure });
  else try { await runtime.dockerCall(['volume', 'rm', project.volume]); }
  catch (error) { failure = new Error('Resource proof Store cleanup failed', { cause: error }); }
}
if (failure) throw failure;
await writeFile(new URL('../.local/resource-policy-proof.json', import.meta.url), JSON.stringify({ ...receipt, ownResourcesRemoved: true }, null, 2) + '\n');
console.log(JSON.stringify({ ...receipt, ownResourcesRemoved: true }));
