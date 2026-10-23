import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampRuntime } from '../src/index.mjs';
import { defaultBundle, runtimePackage, loadToolchain, sha256 } from '../src/toolchain.mjs';

const folder = await mkdtemp(join(tmpdir(), 'camp-bundle-proof-'));
const namespace = `toolchain-${randomUUID()}`;
const bundle = process.env.CAMP_TOOLCHAIN_BUNDLE ?? defaultBundle;
const image = JSON.parse(await readFile(join(runtimePackage, '.local/standard-image.json'), 'utf8'));
const originalImage = await readFile(join(runtimePackage, '.local/image.json')).catch(() => null);
// Explicitly invalidate the checkout compatibility path. Only bundled SDK
// code and native artifacts may be used during this proof.
const runtime = new CampRuntime({ home: join(folder, 'state'), layerfsSource: join(folder, 'checkout-does-not-exist'), toolchainBundle: bundle, imageId: image.imageId });
const ownedVolume = `camp-mvp-p-${sha256(namespace).slice(0, 16)}`;
let project, run;
const runId = `${namespace}-builder`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(new Error('Bundle proof deadline')), 110_000);
try {
  const toolchain = await loadToolchain(bundle);
  assert.equal(toolchain.digest, image.toolchainDigest);
  assert(runtime.sdkEntry.startsWith(toolchain.root + '/'));
  const source = join(folder, 'source'); await mkdir(source);
  await writeFile(join(source, 'README.md'), '# Bundle proof\n');
  project = await runtime.prepareProject({ projectId: namespace, sourcePath: source, signal: controller.signal });
  run = await runtime.prepareRun({ project, runId, roleId: 'builder', signal: controller.signal });
  const baseline = await runtime.pinInputCandidate(run, null, { signal: controller.signal });
  const exec = async command => {
    const result = await runtime.exec(run, command);
    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    return result.stdout;
  };
  const versions = await exec('id -u && node --version && npm --version && git --version');
  assert.match(versions, /^501\nv24\.16\.0\n/);
  const test = await exec("printf \"import {test} from 'node:test';test('standard bundle',()=>{});\\n\" > bundle.test.mjs && npm exec --offline -- node --test bundle.test.mjs");
  assert.match(test, /pass 1/);
  await exec('git init -q && git -c user.name=Camp -c user.email=camp@example.invalid add README.md && git -c user.name=Camp -c user.email=camp@example.invalid commit -qm proof && git show HEAD:README.md');
  await runtime.installDsh(run);
  await runtime.installPlugin(run, join(runtimePackage, '../dsh-plugin'));
  const profile = await exec('DSH_HOME=/tmp/camp-dsh-home node /opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile camp --dump-config');
  assert.match(profile, /camp-room-tools/);
  await exec('printf "bundle candidate\\n" > bundle-result.txt');
  await runtime.quiesceAgent(run, { signal: controller.signal });
  const candidate = await runtime.commitCandidate(run, { signal: controller.signal });
  assert.equal(candidate.refKind, 'commit');
  const saved = await runtime.sdk(project, 'fs.read', [candidate.refId, '/bundle-result.txt'], project, { signal: controller.signal });
  assert.equal(saved.text, 'bundle candidate\n');
  const previous = await readFile(join(runtimePackage, '.local/image.json')).catch(() => null);
  assert.equal(previous && sha256(previous), originalImage && sha256(originalImage));
  const receipt = { schemaVersion: 1, namespace, at: new Date().toISOString(), toolchainDigest: toolchain.digest, imageId: image.imageId, bundledSdkWithoutCheckout: true, hostNativeAbiLoaded: true, containerDaemonAbiLoaded: true, immutableLayerBaseline: baseline.refKind === 'layer', candidate, dshProfileLoaded: true, npmOfflineTestPassed: true, gitLocalCommitPassed: true, uid: 501, oldImageRecordUnchanged: true, modelCalls: 0 };
  await writeFile(join(runtimePackage, '.local/bundle-verification.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  clearTimeout(timer);
  await runtime.cleanupAttempt(runtime.runIdentity(runId).prefix);
  if (project) assert.equal(project.volume, ownedVolume);
  const volume = (await runtime.dockerCall(['volume', 'ls', '--filter', `name=^${ownedVolume}$`, '--format', '{{.Name}}'])).stdout.trim();
  if (volume) {
    assert.equal(volume, ownedVolume);
    await runtime.dockerCall(['volume', 'rm', ownedVolume]);
  }
  await rm(folder, { recursive: true, force: true });
}
