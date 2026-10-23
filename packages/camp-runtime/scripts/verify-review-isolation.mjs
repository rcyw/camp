// Keyless, uniquely named real Docker/LayerFS proof. Never touches a Camp API.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CampRuntime } from '../src/index.mjs';
import { runTrustedVerification } from '../src/verification.mjs';
import { createModelProxy } from '../src/model-proxy.mjs';
import { serializeVerificationPolicy } from '../../camp-protocol/src/index.js';

const home = await mkdtemp(join(tmpdir(), 'camp-review-isolation-'));
const runtime = await new CampRuntime({ home }).ready(), namespace = `review-${randomUUID()}`;
const active = []; let project, proxy;
try {
  project = await runtime.prepareProject({ projectId: namespace });
  const builder = await runtime.prepareRun({ project, runId: `${namespace}-builder`, roleId: 'builder' }); active.push(builder);
  const observer = await runtime.prepareRun({ project, runId: `${namespace}-observer`, roleId: 'reviewer' }); active.push(observer);
  const probe = "const fs=require('node:fs');const readable=p=>{try{fs.accessSync(p,fs.constants.R_OK);return true}catch{return false}};const cap=fs.readFileSync('/proc/self/status','utf8').match(/^CapEff:\\s+(.+)$/m)[1].trim();process.stdout.write(JSON.stringify({uid:process.getuid(),store:readable('/layerfs-store/global/store.sqlite'),docker:fs.existsSync('/var/run/docker.sock'),rootEnvironment:readable('/proc/1/environ'),capabilities:cap}));";
  const permissions = JSON.parse((await runtime.dockerCall(['exec', '--user', '501:20', builder.containerId, '/usr/local/bin/node', '-e', probe])).stdout);
  assert.equal(permissions.uid, 501); assert.equal(permissions.store, false); assert.equal(permissions.docker, false); assert.equal(permissions.rootEnvironment, false); assert.match(permissions.capabilities, /^0+$/);
  await runtime.dockerCall(['exec', '-d', '--user', '501:20', '--workdir', builder.workspacePath, builder.containerId, '/usr/local/bin/node', '-e', "setInterval(()=>require('node:fs').appendFileSync('background.txt','x'),10)"]);
  await delay(150); await runtime.quiesceAgent(builder);
  const length = async () => Number((await runtime.dockerCall(['exec', '--user', '501:20', '--workdir', builder.workspacePath, builder.containerId, '/usr/local/bin/node', '-e', "process.stdout.write(String(require('node:fs').statSync('background.txt').size))"])).stdout);
  const stoppedSize = await length(); assert.ok(stoppedSize > 0); await delay(150); assert.equal(await length(), stoppedSize);
  await runtime.dockerCall(['exec', '--user', '501:20', builder.containerId, '/usr/local/bin/node', '-e', "const fs=require('node:fs');fs.writeFileSync('/tmp/camp-dsh-home/session.json',JSON.stringify({evidence:'keyless proof'}));fs.symlinkSync('/opt/camp-dsh/node_modules','/tmp/camp-dsh-home/profile-modules')"]);
  const archive = await runtime.archiveSession(builder);
  assert.equal(archive.status, 'truncated'); assert.equal(archive.retained, true); assert.equal(archive.omittedCount, 1);
  assert.equal(JSON.parse(await readFile(join(builder.folder, 'dsh-home', 'session.json'), 'utf8')).evidence, 'keyless proof');
  await assert.rejects(readFile(join(builder.folder, 'dsh-home', 'profile-modules')));
  const candidate = await runtime.commitCandidate(builder); assert.equal(candidate.refKind, 'commit');
  const isolated = await runtime.dockerCall(['exec', '--user', '501:20', '--workdir', observer.workspacePath, observer.containerId, '/usr/local/bin/node', '-e', "if(require('node:fs').existsSync('background.txt'))process.exit(1)"]);
  assert.equal(isolated.stderr, '');
  assert.equal(await runtime.sandboxApiUrl(builder, 'https://camp.example.invalid:8443'), 'https://camp.example.invalid:8443');
  const gateway = await runtime.sandboxHostAddress(builder);
  proxy = await createModelProxy({ apiKey: 'keyless-proof-never-used', host: gateway }); await proxy.close(); proxy = null;
  const ownerRun = runtime.runIdentity(`${namespace}-verification`); await mkdir(ownerRun.folder, { recursive: true, mode: 0o700 });
  const policy = { id: 'review-isolation', revision: 1, name: 'Keyless independent isolation checks', maxRepairAttempts: 0, checks: [
    { id: 'first', label: 'Observe ordinary sandbox', argv: ['node', '-e', "const fs=require('node:fs');if(process.getuid()!==501||fs.existsSync('/layerfs-store')||fs.existsSync('/var/run/docker.sock')||process.env.CAMP_WORKER_TOKEN||process.env.DEEPSEEK_API_KEY)process.exit(2);fs.writeFileSync('contamination','private to first check');process.stdout.write('isolated')"], timeoutMs: 5000 },
    { id: 'second', label: 'Fresh immutable input', argv: ['node', '-e', "const fs=require('node:fs');if(fs.existsSync('contamination')||!fs.existsSync('background.txt'))process.exit(3);process.stdout.write('fresh')"], timeoutMs: 5000 },
  ] };
  const report = await runTrustedVerification({ runtime, ownerRun, candidate, verificationPolicy: { policy, digest: createHash('sha256').update(serializeVerificationPolicy(policy)).digest('hex') } });
  assert.deepEqual(report.checks.map(check => check.exitCode), [0, 0]);
  assert.deepEqual(report.checks.map(check => check.stdout), ['isolated', 'fresh']);
  await runtime.dockerCall(['inspect', observer.containerId]);
  await assert.rejects(readFile(join(ownerRun.folder, 'verification-snapshot', 'background.txt')));
  const receipt = { at: new Date().toISOString(), modelCalls: 0, ownNamespace: namespace, nonRootNoCapabilities: true, storeAndSocketInaccessible: true, daemonEnvironmentInaccessible: true, backgroundQuiescedBeforeCommit: true, boundedSessionArchiveRetained: true, unsafeArchiveEntriesOmitted: true, foreignAttemptSurvived: true, remoteApiIndependentFromProxyBind: true, verificationExitCodes: report.checks.map(check => check.exitCode), freshSnapshotPerCheck: true, scratchRemoved: true };
  await writeFile(fileURLToPath(new URL('../.local/review-isolation.json', import.meta.url)), `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify(receipt));
} finally {
  await proxy?.close();
  for (const run of active.reverse()) await runtime.abortRun(run, 'namespaced_review_proof_cleanup');
  if (project) {
    // Match only this proof's exact project prefix and recorded volume.
    const listed = await runtime.dockerCall(['ps', '-a', '--format', '{{.ID}} {{.Names}}', '--filter', `name=^/${project.prefix}`]);
    for (const line of listed.stdout.trim().split('\n').filter(Boolean)) { const [id, name] = line.split(' '); assert.ok(name.startsWith(project.prefix) && /^[a-f0-9]{12,64}$/.test(id)); await runtime.dockerCall(['rm', '-f', id]); }
    assert.equal(project.volume, `camp-mvp-${project.projectId}`); await runtime.dockerCall(['volume', 'rm', project.volume]);
  }
  await rm(home, { recursive: true, force: true });
}
