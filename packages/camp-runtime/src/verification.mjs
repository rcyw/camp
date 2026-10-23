import { createHash } from 'node:crypto';
import { open, mkdir, readFile, lstat, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseCandidate, parseVerificationPolicy, serializeVerificationPolicy, parseVerificationReport, CAMP_VERIFICATION_LIMITS } from '../../camp-protocol/src/index.js';
import { materializeCandidate } from './export.mjs';
import { removeOwnedDirectory } from './safe-export.mjs';
import { atomicJson } from './durable-state.mjs';
import { streamSnapshot } from './snapshot-stream.mjs';

async function boundedFile(path, maximum) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error('Trusted harness file exceeds its allowed shape or size');
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length <= maximum) { const result = await file.read(buffer, length, buffer.length - length); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > maximum) throw new Error('Trusted harness file exceeds its byte limit');
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}
export async function loadVerificationHarnesses(env = process.env) {
  if (!env.CAMP_VERIFICATION_HARNESSES) return [];
  let config;
  try { config = JSON.parse((await boundedFile(env.CAMP_VERIFICATION_HARNESSES, 65536)).toString('utf8')); }
  catch { throw new Error('CAMP_VERIFICATION_HARNESSES must name a valid bounded JSON mapping file'); }
  if (!Array.isArray(config) || config.length > 32) throw new Error('Harness mapping must be a bounded array');
  const result = [];
  for (const item of config) {
    if (!item || Object.keys(item).some(key => !['id', 'path'].includes(key)) || !/^[a-z][a-z0-9_-]{0,63}$/.test(item.id ?? '') || !isAbsolute(item.path ?? '') || result.some(row => row.id === item.id)) throw new Error('Harness mapping requires unique IDs and explicit absolute file paths');
    const bytes = await boundedFile(item.path, 1024 * 1024);
    result.push({ id: item.id, path: item.path, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return result;
}

/** The host attempt stays private, while the read-only file bind must remain
 * readable by sandbox UID 501 even under a service's restrictive umask. */
export async function stageVerificationHarness(path, bytes) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.chmod(0o444);
    await file.sync();
  } finally { await file.close(); }
}
const hostEnv = () => ({ PATH: process.env.PATH, LANG: 'C.UTF-8' });
function processExit(child) {
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolveExit() : reject(new Error(`Trusted snapshot transport failed (${code})`))); });
}
async function copySnapshot(runtime, containerId, directory, signal) {
  // Import trusted receiver code as data, then stream files as data. No host
  // workspace mount, root chown or candidate JavaScript participates in setup.
  const source = await readFile(new URL('./safe-export.mjs', import.meta.url));
  const script = `import {receiveSnapshot} from 'data:text/javascript;base64,${source.toString('base64')}'; await receiveSnapshot(process.stdin, '/workspace', {maxBytes:536870912,maxEntries:20000,allowUnsafeLinks:true});`;
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const copy = spawn('docker', ['-H', `unix://${runtime.docker}`, 'exec', '-i', '--user', '501:20', containerId, '/usr/local/bin/node', '--input-type=module', '-e', script], { stdio: ['pipe', 'ignore', 'pipe'], env: hostEnv(), signal: activeSignal });
  let diagnostic = '';
  copy.stderr.on('data', part => { diagnostic = (diagnostic + part).slice(-2000); });
  copy.stdin.on('error', () => {});
  const exited = processExit(copy); exited.catch(() => {});
  const timer = setTimeout(() => controller.abort(new Error('Snapshot setup deadline exceeded')), 30000);
  try { await streamSnapshot(directory, copy.stdin, activeSignal); copy.stdin.end(); await exited; }
  catch (error) { throw new Error(`Trusted snapshot setup failed: ${diagnostic || error.message}`); }
  finally { clearTimeout(timer); copy.kill('SIGKILL'); }
}
function retainedText(bytes, maximum) {
  const decoded = Buffer.from(bytes.toString('utf8'));
  let end = Math.min(maximum, decoded.length);
  while (end > 0) try { return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(decoded.subarray(0, end)); } catch { end--; }
  return '';
}
function jsonTextPrefix(value, maximum) {
  if (typeof value !== 'string') throw new Error('Verification output must be text');
  const bytes = text => Buffer.byteLength(JSON.stringify(text)) - 2;
  if (bytes(value) <= maximum) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, middle)) <= maximum) low = middle;
    else high = middle - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return value.slice(0, low);
}
/** Keep exit facts intact even when control characters expand in JSON logs. */
export function boundedVerificationReport({ candidate, policyDigest, checks }) {
  // Validate identity, argv and observed exit facts independently of logs. A
  // policy's metadata is bounded before allocation by the shared policy parser.
  const facts = parseVerificationReport({ candidate, policyDigest, checks: checks.map(check => ({ ...check, stdout: '', stderr: '' })) });
  const full = { ...facts, checks: facts.checks.map((check, index) => ({ ...check, stdout: checks[index].stdout, stderr: checks[index].stderr })) };
  if (Buffer.byteLength(JSON.stringify(full)) <= CAMP_VERIFICATION_LIMITS.maxPayloadBytes) return parseVerificationReport(full);
  const remaining = CAMP_VERIFICATION_LIMITS.maxPayloadBytes - Buffer.byteLength(JSON.stringify(facts));
  const fieldBudget = Math.max(0, Math.floor(remaining / (checks.length * 2)));
  return parseVerificationReport({ ...facts, checks: facts.checks.map((check, index) => {
    const stdout = retainedText(Buffer.from(jsonTextPrefix(checks[index].stdout, fieldBudget)), CAMP_VERIFICATION_LIMITS.maxOutputBytes);
    const stderr = retainedText(Buffer.from(jsonTextPrefix(checks[index].stderr, fieldBudget)), CAMP_VERIFICATION_LIMITS.maxOutputBytes - Buffer.byteLength(stdout));
    return { ...check, stdout, stderr, outputTruncated: check.outputTruncated || stdout !== checks[index].stdout || stderr !== checks[index].stderr };
  }) });
}
export async function executeVerificationCheck({ runtime, containerId, check, signal, spawnCommand = spawn, stopGraceMs = 6000 }) {
  signal?.throwIfAborted();
  const start = performance.now();
  const child = spawnCommand('docker', ['-H', `unix://${runtime.docker}`, 'exec', '--user', '501:20', '--workdir', '/workspace', '--', containerId, ...check.argv], { stdio: ['ignore', 'pipe', 'pipe'], env: hostEnv(), signal });
  const stdout = [], stderr = []; let bytes = 0, timedOut = false, outputTruncated = false, killWork;
  let hardTimer, rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  deadline.catch(() => {});
  const stop = () => {
    if (!killWork) {
      killWork = runtime.dockerCall(['kill', containerId], { timeout: 5000 }).catch(() => {});
      // The Docker client can stay connected after a failed/ambiguous daemon
      // kill. Bound that client independently, then let owned-prefix cleanup
      // establish whether the remote sandbox actually stopped.
      hardTimer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectDeadline(Object.assign(new Error('Verification Docker execution did not stop before its hard deadline'), { code: 'verification_execution_failed' }));
      }, stopGraceMs);
    }
    return killWork;
  };
  const onAbort = () => { void stop(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; void stop(); }, check.timeoutMs);
  const capture = destination => chunk => {
    const remaining = Math.max(0, CAMP_VERIFICATION_LIMITS.maxOutputBytes - bytes);
    if (remaining) { const kept = chunk.subarray(0, remaining); destination.push(kept); bytes += kept.length; }
    if (chunk.length > remaining) { outputTruncated = true; void stop(); }
  };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  let exitCode, childSignal;
  try {
    [exitCode, childSignal] = await Promise.race([new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (code, sig) => resolveExit([code, sig])); }), deadline]);
    await Promise.race([killWork, deadline]);
    signal?.throwIfAborted();
    const inspected = JSON.parse((await runtime.dockerCall(['inspect', containerId], { timeout: 5000 })).stdout)[0];
    const rawOut = Buffer.concat(stdout), rawErr = Buffer.concat(stderr);
    const out = retainedText(rawOut, CAMP_VERIFICATION_LIMITS.maxOutputBytes);
    const err = retainedText(rawErr, CAMP_VERIFICATION_LIMITS.maxOutputBytes - Buffer.byteLength(out));
    if (Buffer.byteLength(Buffer.from(rawOut.toString('utf8'))) + Buffer.byteLength(Buffer.from(rawErr.toString('utf8'))) > Buffer.byteLength(out + err)) outputTruncated = true;
    return { id: check.id, argv: check.argv, exitCode, signal: childSignal, timedOut, oomKilled: Boolean(inspected.State.OOMKilled), durationMs: Math.round(performance.now() - start), stdout: out, stderr: err, outputTruncated };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); child.kill('SIGKILL'); if (killWork) await Promise.race([killWork, deadline.catch(() => {})]); clearTimeout(hardTimer); }
}

/** Runs operator-frozen checks in a plain sandbox with no Store or credentials. */
export async function runTrustedVerification({ runtime, ownerRun, candidate, verificationPolicy, harnesses = [], signal, onPrepared = () => {}, onResult = () => {} }) {
  candidate = parseCandidate(candidate);
  const policy = parseVerificationPolicy(verificationPolicy.policy);
  const digest = createHash('sha256').update(serializeVerificationPolicy(policy)).digest('hex');
  if (digest !== verificationPolicy.digest) throw new Error('Frozen verification policy digest differs from its canonical content');
  const identity = runtime.runIdentity(ownerRun.runId);
  if (identity.prefix !== ownerRun.prefix || identity.folder !== ownerRun.folder) throw new Error('Verification owner differs from its original attempt');
  await mkdir(ownerRun.folder, { recursive: true, mode: 0o700 });
  await atomicJson(join(ownerRun.folder, 'verification-intent.json'), { prefix: ownerRun.prefix, candidate, policyDigest: digest, phase: 'materializing' });
  const directory = join(ownerRun.folder, 'verification-snapshot');
  let snapshotIdentity, containerId, cleaned = false;
  try {
    await materializeCandidate({ runtime, candidate, ownerRun, output: directory, signal });
    snapshotIdentity = await lstat(directory);
    const binds = new Map();
    for (const requirement of new Map(policy.checks.flatMap(check => check.harness ? [[check.harness.id, check.harness]] : [])).values()) {
      const installed = harnesses.find(item => item.id === requirement.id && item.sha256 === requirement.sha256);
      if (!installed) throw new Error(`Trusted harness is unavailable: ${requirement.id}`);
      const bytes = await boundedFile(installed.path, 1024 * 1024);
      if (createHash('sha256').update(bytes).digest('hex') !== requirement.sha256) throw new Error(`Trusted harness changed after negotiation: ${requirement.id}`);
      const copy = join(ownerRun.folder, `harness-${requirement.id}`);
      await stageVerificationHarness(copy, bytes);
      if (/[\r\n,]/.test(copy)) throw new Error('Harness mount path contains unsupported separator characters');
      binds.set(requirement.id, ['--mount', `type=bind,source=${copy},target=/camp-checks/${requirement.id},readonly`]);
    }
    const image = JSON.parse((await runtime.dockerCall(['image', 'inspect', candidate.imageId])).stdout)[0];
    if (image.Id !== candidate.imageId) throw new Error('Verification image identity changed');
    const environment = [];
    for (const item of image.Config.Env ?? []) {
      const key = item.split('=')[0];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Verification image has an unsupported environment key');
      environment.push('--env', `${key}=`);
    }
    environment.push('--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'HOME=/tmp', '--env', 'LANG=C.UTF-8', '--env', 'CI=1', '--env', 'NPM_CONFIG_CACHE=/tmp/npm-cache');
    const checks = [];
    for (const check of policy.checks) {
      signal?.throwIfAborted();
      const name = `${ownerRun.prefix}verify-${check.id}`;
      const checkBinds = check.harness ? binds.get(check.harness.id) : [];
      const create = () => runtime.dockerCall(['create', '--name', name, '--label', 'camp.verification=true', '--network', 'none', '--read-only', '--user', '501:20', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '536870912', '--memory-swap', '536870912', '--cpus', '1', '--ulimit', 'nofile=1024:1024', '--log-driver', 'none', '--tmpfs', '/workspace:rw,exec,nosuid,nodev,size=536870912,uid=501,gid=20,mode=0700', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=67108864,uid=501,gid=20,mode=0700', ...checkBinds, ...environment, '--workdir', '/workspace', '--entrypoint', '/bin/sleep', candidate.imageId, 'infinity'], { signal });
      const created = runtime.createOwnedContainer ? await runtime.createOwnedContainer(ownerRun.prefix, create) : await create();
      containerId = created.stdout.trim();
      await atomicJson(join(ownerRun.folder, `verification-container-${check.id}.json`), { containerId, name, candidate, policyDigest: digest });
      await runtime.dockerCall(['start', containerId], { signal });
      const observed = JSON.parse((await runtime.dockerCall(['inspect', containerId], { signal })).stdout)[0];
      if (observed.Image !== candidate.imageId || observed.HostConfig.NetworkMode !== 'none' || !observed.HostConfig.ReadonlyRootfs || observed.Config.User !== '501:20' || observed.HostConfig.Privileged || observed.HostConfig.Memory !== 536870912 || observed.HostConfig.MemorySwap !== 536870912 || observed.HostConfig.NanoCpus !== 1000000000 || observed.HostConfig.PidsLimit !== 128 || !observed.HostConfig.CapDrop.includes('ALL')) throw new Error('Verification sandbox did not apply the required isolation');
      await atomicJson(join(ownerRun.folder, `verification-isolation-${check.id}.json`), { imageId: observed.Image, network: observed.HostConfig.NetworkMode, readonly: observed.HostConfig.ReadonlyRootfs, uid: observed.Config.User, memory: observed.HostConfig.Memory, pids: observed.HostConfig.PidsLimit, capDrop: observed.HostConfig.CapDrop, mounts: observed.Mounts.map(mount => ({ destination: mount.Destination, rw: mount.RW })) });
      await onPrepared(containerId, check);
      await copySnapshot(runtime, containerId, directory, signal);
      checks.push(await executeVerificationCheck({ runtime, containerId, check, signal }));
      // Every check starts from the immutable input, including when an earlier
      // project-controlled test changed files or left background processes.
      await runtime.dockerCall(['rm', '--force', containerId], { timeout: 5000 });
      containerId = null;
    }
    const report = boundedVerificationReport({ candidate, policyDigest: digest, checks });
    await atomicJson(join(ownerRun.folder, 'verification-result.json'), report);
    await onResult(report);
    await runtime.cleanupAttempt(ownerRun.prefix);
    cleaned = true;
    return report;
  } finally {
    if (!cleaned) await runtime.cleanupAttempt(ownerRun.prefix, { timeout: 5000 });
    if (snapshotIdentity) { await removeOwnedDirectory(directory, snapshotIdentity); await rm(`${directory}.manifest.json`, { force: true }); }
  }
}
