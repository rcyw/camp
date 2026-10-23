import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';
import { runTrustedVerification, loadVerificationHarnesses } from '../src/verification.mjs';
import { serializeVerificationPolicy, parseVerificationReport } from '../../camp-protocol/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const image = JSON.parse(await readFile(`${root}/.local/baked-image.json`, 'utf8'));
const runtime = await new CampRuntime({ imageId: image.imageId }).ready();
const folder = await mkdtemp(join(root, '.local/trusted-proof-'));
const source = join(folder, 'source'); await mkdir(source);
await writeFile(join(source, 'calc.cjs'), 'module.exports=(a,b)=>a+b;\n');
await writeFile(join(source, 'marker'), 'immutable');
await writeFile(join(source, 'unreadable'), 'must remain mode zero'); await chmod(join(source, 'unreadable'), 0);
await writeFile(join(source, 'executable'), '#!/bin/sh\nexit 0\n'); await chmod(join(source, 'executable'), 0o751);
await symlink('/etc/passwd', join(source, 'opaque-link'));
const harness = join(folder, 'independent.cjs');
await writeFile(harness, `const assert=require('node:assert/strict'), fs=require('node:fs');
(async()=>{assert.equal(process.getuid(),501);assert.equal(fs.readFileSync('marker','utf8'),'immutable');assert.equal(require('/workspace/calc.cjs')(2,3),5);assert.equal(fs.statSync('executable').mode&511,489);assert.throws(()=>fs.readFileSync('unreadable'),e=>e.code==='EACCES');assert.equal(fs.readlinkSync('opaque-link'),'/etc/passwd');assert.throws(()=>fs.writeFileSync('/camp-checks/core','changed'));assert.throws(()=>fs.statSync('/var/run/docker.sock'));assert.throws(()=>fs.statSync('/layerfs-store'));for(const [key,value]of Object.entries(process.env))if(/TOKEN|API_KEY/.test(key))assert.equal(value,'');await assert.rejects(fetch('http://192.0.2.1',{signal:AbortSignal.timeout(200)}));console.log('INDEPENDENT_CHECK_PASSED');})().catch(e=>{console.error(e.message);process.exitCode=1});\n`);
const manifest = join(folder, 'harnesses.json'); await writeFile(manifest, JSON.stringify([{ id: 'core', path: harness }]));
const harnesses = await loadVerificationHarnesses({ CAMP_VERIFICATION_HARNESSES: manifest });
const project = await runtime.prepareProject({ projectId: `trusted-proof-${Date.now()}`, sourcePath: source });
let run;
try {
  run = await runtime.prepareRun({ project, runId: `trusted-proof-base-${Date.now()}`, roleId: 'planner' });
  const candidate = await runtime.pinInputCandidate(run, null); await runtime.releaseRun(run, { discard: true }); run = null;
  const policy = { id: 'independent', revision: 1, name: 'Independent immutable checks', maxRepairAttempts: 1, checks: [
    { id: 'project-test', label: 'Project controlled test', timeoutMs: 5000, argv: ['/usr/local/bin/node', '-e', "require('node:fs').writeFileSync('marker','polluted');require('node:child_process').spawn(process.execPath,['-e',\"setInterval(()=>require('node:fs').writeFileSync('/workspace/marker','background'),10)\"],{detached:true,stdio:'ignore'}).unref();console.log('project test done');"] },
    { id: 'independent', label: 'Trusted frozen acceptance', timeoutMs: 5000, argv: ['/usr/local/bin/node', '/camp-checks/core'], harness: { id: 'core', sha256: harnesses[0].sha256 } },
  ] };
  const snapshot = policy => ({ policy, digest: createHash('sha256').update(serializeVerificationPolicy(policy)).digest('hex') });
  const owners = [], ids = [];
  const execute = async policy => { const ownerRun = runtime.runIdentity(`trusted-proof-${owners.length}-${Date.now()}`); owners.push(ownerRun); return runTrustedVerification({ runtime, ownerRun, candidate, verificationPolicy: snapshot(policy), harnesses, signal: new AbortController().signal, onPrepared: id => ids.push(id) }); };
  const passed = parseVerificationReport(await execute(policy));
  assert.ok(passed.checks.every(check => check.exitCode === 0 && !check.outputTruncated && !check.timedOut), JSON.stringify(passed.checks));
  assert.match(passed.checks[1].stdout, /INDEPENDENT_CHECK_PASSED/);
  const timed = await execute({ ...policy, checks: [{ id: 'deadline', label: 'Deadline', argv: ['/usr/local/bin/node', '-e', 'setInterval(()=>{},1000)'], timeoutMs: 100 }] });
  assert.equal(timed.checks[0].timedOut, true); assert.notEqual(timed.checks[0].exitCode, 0);
  const flooded = await execute({ ...policy, checks: [{ id: 'output', label: 'Output cap', argv: ['/usr/local/bin/node', '-e', "setInterval(()=>process.stdout.write('x'.repeat(4096)),0)"], timeoutMs: 5000 }] });
  assert.equal(flooded.checks[0].outputTruncated, true); assert.ok(Buffer.byteLength(flooded.checks[0].stdout + flooded.checks[0].stderr) <= 32768);
  const memory = await execute({ ...policy, checks: [{ id: 'memory', label: 'Memory cap', argv: ['/usr/local/bin/node', '-e', "const chunks=[];setInterval(()=>{for(let n=0;n<8;n++)chunks.push(Buffer.alloc(16*1024*1024,1));},1)"], timeoutMs: 10000 }] });
  assert.notEqual(memory.checks[0].exitCode, 0, 'Memory exhaustion must never pass verification');
  assert.equal(memory.checks[0].timedOut, false, 'The memory probe must hit its memory bound before the wall deadline');
  await writeFile(harness, 'throw new Error("changed after negotiation");');
  await assert.rejects(execute(policy), /changed after negotiation/);
  for (const id of ids) await assert.rejects(runtime.dockerCall(['inspect', id]));
  for (const owner of owners) for (const name of ['verification-snapshot', 'verification-snapshot.manifest.json', 'harness-core']) await assert.rejects(lstat(join(owner.folder, name)), { code: 'ENOENT' });
  const receipt = { at: new Date().toISOString(), candidate, independentChecks: passed.checks.map(check => ({ id: check.id, exitCode: check.exitCode })), immutableFreshWorkspacePerCheck: true, backgroundProcessesContained: true, opaqueLinkNotFollowedOnHost: true, mode000Preserved: true, mode0751Preserved: true, noNetworkOrCredentialsOrStore: true, readonlyHashPinnedHarness: true, harnessMutationRejected: true, timeoutStoppedSandbox: true, outputBudgetStoppedSandbox: true, memoryLimit: { exitCode: memory.checks[0].exitCode, signal: memory.checks[0].signal, oomKilled: memory.checks[0].oomKilled, timedOut: memory.checks[0].timedOut }, allOwnedContainersRemoved: true, privateScratchRemoved: true, modelCalled: false };
  await writeFile(`${root}/.local/trusted-verification.json`, JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt));
} finally { if (run) await runtime.abortRun(run, 'trusted_proof_cleanup'); }
