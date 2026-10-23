import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { loadToolchain, regularBytes, runtimePackage, toolchainLock } from './toolchain.mjs';
import { parseWorkerDeclaration, CAMP_AGENT_TASK_KINDS, getTaskRequirements, getPluginTaskRequirements, checkWorkerCompatibility } from '../../camp-protocol/src/index.js';
import { loadVerificationHarnesses } from './verification.mjs';

const execute = promisify(execFile);
const hostEnv = env => ({ PATH: env.PATH ?? process.env.PATH, LANG: 'C.UTF-8' });
const apiParts = value => /^(\d+)\.(\d+)$/.exec(value ?? '')?.slice(1).map(Number);
export function supportsLayerfsDocker(info) {
  const maximum = apiParts(info.ApiVersion), minimum = info.MinAPIVersion === undefined ? [1, 0] : apiParts(info.MinAPIVersion);
  const compare = value => value[0] - 1 || value[1] - 54;
  return Boolean(info.Os === 'linux' && maximum && minimum && compare(maximum) >= 0 && compare(minimum) <= 0);
}
async function homeCheck(home) {
  try {
    const stat = await lstat(home);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) return 'runtime_home_not_private';
    await access(home, constants.W_OK | constants.R_OK | constants.X_OK);
    return 'runtime_home_ready';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let parent = dirname(resolve(home));
    while (true) {
      try { await access(parent, constants.W_OK | constants.X_OK); return 'runtime_home_creatable'; }
      catch (failure) {
        if (failure.code !== 'ENOENT' || dirname(parent) === parent) throw failure;
        parent = dirname(parent);
      }
    }
  }
}

/** Read-only local checks. No SDK Store call, container creation, API or model call. */
export async function runLocalChecks({ runtime, env = process.env, sourcePath, protocolVersion = 2 } = {}) {
  if (!runtime) throw new Error('A runtime is required for local checks');
  const checks = [];
  let toolchainDigest = null, imageId = runtime.imageId ?? null;
  const add = (id, status, code) => checks.push({ id, status, code });
  async function check(id, success, failure, operation) {
    try { const code = await operation(); add(id, 'passed', code ?? success); }
    catch { add(id, 'failed', failure); }
  }
  await check('platform', 'linux_glibc', 'platform_unsupported', async () => {
    if (process.platform !== 'linux' || !process.report.getReport().header.glibcVersionRuntime) throw new Error('unsupported');
  });
  add('node', Number(process.versions.node.split('.')[0]) === toolchainLock.nodeMajor ? 'passed' : 'failed', Number(process.versions.node.split('.')[0]) === toolchainLock.nodeMajor ? 'node_supported' : 'node_version_unsupported');
  await check('host_tools', 'host_tools_available', 'host_tools_missing', async () => {
    for (const name of ['git', 'flock', 'setpriv', 'prlimit', 'tar', 'diff', 'docker']) await execute(name, ['--version'], { timeout: 3000, maxBuffer: 8192, env: hostEnv(env) });
  });
  await check('runtime_home', 'runtime_home_ready', 'runtime_home_unavailable', async () => {
    const code = await homeCheck(runtime.home);
    if (code === 'runtime_home_not_private') throw new Error(code);
    return code;
  });
  await check('toolchain', 'toolchain_verified', 'toolchain_invalid', async () => {
    if (runtime.toolchainBundle) {
      const selected = await loadToolchain(runtime.toolchainBundle);
      toolchainDigest = selected.digest;
      if (runtime.native !== selected.native || runtime.daemon !== selected.daemon || runtime.sdkEntry !== selected.sdkEntry || runtime.dshArchive !== selected.dshArchive) throw new Error('Bundle override');
    } else if (runtime.source) {
      await Promise.all([access(runtime.sdkEntry), access(runtime.native), access(runtime.daemon)]);
    } else throw new Error('No toolchain');
    // Native module initialization performs no Store operation. A missing ELF
    // dependency/Node ABI fails here before a claim can consume a run budget.
    await execute(process.execPath, ['--input-type=module', '-e', 'import {createRequire} from "node:module";const n=createRequire(import.meta.url)(process.argv[1]);if(typeof n.call!=="function"||typeof n.storeOpen!=="function")process.exit(1)', runtime.native], { timeout: 5000, maxBuffer: 4096, env: hostEnv(env) });
    return runtime.toolchainBundle ? 'toolchain_verified' : 'development_checkout';
  });
  await check('docker', 'docker_supported', 'docker_unavailable', async () => {
    const { stdout } = await runtime.dockerCall(['version', '--format', '{{json .Server}}'], { timeout: 5000 });
    const info = JSON.parse(stdout);
    if (!supportsLayerfsDocker(info)) throw new Error('unsupported Docker');
  });
  await check('fuse', 'fuse_device_available', 'fuse_device_unavailable', async () => {
    if (!(await lstat('/dev/fuse')).isCharacterDevice()) throw new Error('missing FUSE');
    await access('/dev/fuse', constants.R_OK | constants.W_OK);
  });
  await check('image', 'image_available', 'image_unavailable', async () => {
    imageId ??= JSON.parse(await regularBytes(join(runtimePackage, '.local/image.json'))).imageId;
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? '')) throw new Error('image must be immutable');
    const { stdout } = await runtime.dockerCall(['image', 'inspect', imageId], { timeout: 5000 });
    const info = JSON.parse(stdout)[0];
    if (info.Id !== imageId || info.Os !== 'linux' || info.Architecture !== ({ x64: 'amd64', arm64: 'arm64' })[process.arch]) throw new Error('Image platform differs');
  });
  if (!env.DEEPSEEK_API_KEY) add('plugin', 'skipped', 'verification_only');
  else await check('plugin', 'plugin_compatible', 'plugin_invalid', async () => {
    const folder = env.CAMP_DSH_PLUGIN ?? resolve(runtimePackage, '../dsh-plugin');
    const plugin = parseWorkerDeclaration(JSON.parse(await regularBytes(join(folder, 'protocol.json'), 65536)));
    for (const taskKind of CAMP_AGENT_TASK_KINDS) if (checkWorkerCompatibility(plugin, getPluginTaskRequirements(getTaskRequirements({ protocolVersion, workflow: 'serial', taskKind, inputCandidate: null }))).status !== 'compatible') throw new Error('Plugin capability missing');
  });
  await check('harnesses', 'harnesses_verified', 'harnesses_invalid', async () => { await loadVerificationHarnesses(env); return env.CAMP_VERIFICATION_HARNESSES ? 'harnesses_verified' : 'harnesses_not_configured'; });
  if (!sourcePath) add('source', 'passed', 'default_seed');
  else await check('source', 'source_readable', 'source_unavailable', async () => {
    // A verified native restore is an installed Store, not a fresh import.
    // Its original checkout is intentionally absent on the destination host.
    if (env.CAMP_ROOM_ID) {
      const { createHash } = await import('node:crypto');
      const projectId = `p-${createHash('sha256').update(`room:${env.CAMP_ROOM_ID}`).digest('hex').slice(0, 16)}`;
      try {
        const project = await runtime.loadProject(projectId, { roomId: env.CAMP_ROOM_ID });
        if (project.restore) return 'restored_store_verified';
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await access(sourcePath, constants.R_OK | constants.X_OK);
    if (!(await lstat(sourcePath)).isDirectory()) throw new Error('Source must be an ordinary directory');
  });
  add('capacity', 'skipped', 'not_checked');
  return { checks, toolchainDigest, imageId: /^sha256:[a-f0-9]{64}$/.test(imageId ?? '') ? imageId : null };
}
