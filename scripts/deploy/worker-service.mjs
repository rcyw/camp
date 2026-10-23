import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseEnv, isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = (code = 'camp_worker_service_invalid') => Object.assign(new Error('Worker service configuration or deployment checks failed; inspect the reviewed private configuration'), { code });
const path = value => typeof value === 'string' && isAbsolute(value) && /^\/[A-Za-z0-9_./-]+$/.test(value) && resolve(value) === value && value !== '/';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
const required = ['serviceName', 'configDirectory', 'nodePath', 'releasePath', 'releaseManifestSha256', 'toolchainPath', 'toolchainDigest', 'imageId', 'apiOrigin', 'roomId', 'workerId', 'runtimeHome', 'credentialFile', 'controlCaFile'];
const optional = ['modelEnvFile', 'harnessManifest', 'dockerConfig', 'dockerSocket', 'settings'];
const numericSettings = new Set(['CAMP_AGENT_CPU_MILLIS', 'CAMP_AGENT_MEMORY_MIB', 'CAMP_AGENT_PIDS_LIMIT', 'CAMP_MIN_FREE_MIB', 'CAMP_RUN_TIMEOUT_MS', 'CAMP_MODEL_MAX_REQUESTS', 'CAMP_MODEL_REQUEST_TIMEOUT_MS', 'CAMP_MODEL_MAX_REQUEST_BYTES', 'CAMP_MODEL_MAX_INPUT_BYTES', 'CAMP_MODEL_MAX_RESPONSE_BYTES']);
const modelKeys = new Set(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'CAMP_DSH_MODEL']);
const reserved = name => ['worker.env', 'service-install.json', 'service-install.pending.json', 'service-operation.lock'].includes(name) || /^worker-[a-f0-9]{64}\.env$/.test(name);
const same = isDeepStrictEqual;
// Runs before Node is allowed to consume the generation as an env file. This
// also covers an ordinary systemctl restart that bypasses this operator CLI.
export const WORKER_ENV_CHECK = "const fs=require('node:fs'),c=require('node:crypto');try{const f=fs.openSync(process.argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK),s=fs.fstatSync(f),b=Buffer.alloc(65537);let n=0,k;while(n<b.length&&(k=fs.readSync(f,b,n,b.length-n,null)))n+=k;fs.closeSync(f);if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&511)!==384||n!==s.size||n>65536||c.createHash('sha256').update(b.subarray(0,n)).digest('hex')!==process.argv[2])process.exit(1);}catch{process.exit(1);}";

/** A deliberately narrow operator configuration: secrets belong in separate
 * existing private files, never JSON, argv, unit directives or rendered output. */
export function workerServiceConfiguration(input) {
  if (!own(input, [...required, ...optional]) || required.some(key => input[key] === undefined)) throw fail();
  const c = { dockerSocket: '/var/run/docker.sock', settings: {}, ...input };
  if (!/^camp-worker(?:-[a-z0-9]+)*$/.test(c.serviceName ?? '') || c.serviceName.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(c.workerId ?? '') || !hex(c.releaseManifestSha256) || !hex(c.toolchainDigest) || !/^sha256:[a-f0-9]{64}$/.test(c.imageId ?? '')) throw fail();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(c.roomId ?? '')) throw fail();
  for (const key of ['configDirectory', 'nodePath', 'releasePath', 'toolchainPath', 'runtimeHome', 'credentialFile', 'controlCaFile', 'dockerSocket', 'modelEnvFile', 'harnessManifest', 'dockerConfig']) if (c[key] !== undefined && !path(c[key])) throw fail();
  let url;
  try { url = new URL(c.apiOrigin); } catch { throw fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || typeof c.apiOrigin !== 'string' || /[\s\\"'$%]/.test(c.apiOrigin) || !/^https:\/\/[^/?#]+\/?$/.test(c.apiOrigin)) throw fail();
  // Match the Worker's existing identity rule; do not URL-canonicalize host
  // case or an explicit default port and orphan a journal during upgrade.
  c.apiOrigin = c.apiOrigin.replace(/\/$/, '');
  if (!own(c.settings, [...numericSettings]) || Object.values(c.settings).some(value => !Number.isSafeInteger(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER)) throw fail();
  const trees = [c.releasePath, c.toolchainPath, c.runtimeHome, c.configDirectory];
  if (trees.some((left, index) => trees.some((right, other) => index !== other && (left === right || left.startsWith(right + '/'))))) throw fail();
  const inputs = ['nodePath', 'credentialFile', 'controlCaFile', 'modelEnvFile', 'harnessManifest'].map(key => c[key]).filter(Boolean);
  if (new Set(inputs).size !== inputs.length || inputs.some(file => dirname(file) === c.configDirectory && reserved(file.slice(c.configDirectory.length + 1))) || c.credentialFile.startsWith(c.releasePath + '/') || c.credentialFile.startsWith(c.toolchainPath + '/')) throw fail();
  return c;
}

export function renderWorkerService(input) {
  const c = workerServiceConfiguration(input);
  const environment = {
    CAMP_API_URL: c.apiOrigin, CAMP_WORKER_ROOM_ID: c.roomId, CAMP_WORKER_ID: c.workerId, CAMP_RUNTIME_HOME: c.runtimeHome,
    CAMP_TOOLCHAIN_BUNDLE: c.toolchainPath, CAMP_RUNTIME_IMAGE: c.imageId,
    CAMP_WORKER_CREDENTIAL_FILE: c.credentialFile, CAMP_CONTROL_CA_FILE: c.controlCaFile,
    CAMP_DOCKER_SOCKET: c.dockerSocket, CAMP_POOL_ONCE: '0', CAMP_WORKER_ONCE: '0',
    ...(c.harnessManifest ? { CAMP_VERIFICATION_HARNESSES: c.harnessManifest } : {}),
    ...(c.dockerConfig ? { DOCKER_CONFIG: c.dockerConfig } : {}),
    ...Object.fromEntries(Object.entries(c.settings).sort(([left], [right]) => left.localeCompare(right))),
  };
  const environmentText = Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  const envFile = join(c.configDirectory, `worker-${sha(environmentText)}.env`);
  const envArgs = [...(c.modelEnvFile ? [`--env-file=${c.modelEnvFile}`] : []), `--env-file=${envFile}`];
  const q = value => `"${value}"`; // All paths are validated ASCII without systemd expansion characters.
  const credentialDirectory = dirname(c.credentialFile);
  const unit = `[Unit]\nDescription=Camp trusted Worker pool (${c.workerId})\nWants=network-online.target\nAfter=network-online.target docker.service\nRequires=docker.service\nStartLimitIntervalSec=300\nStartLimitBurst=3\n\n[Service]\nType=simple\nUser=root\nWorkingDirectory=${c.releasePath}\n# Node startup and each isolated agent trust the same operator public root.\nEnvironment=NODE_EXTRA_CA_CERTS=${c.controlCaFile}\n# Never inherit stale tokens, alternate origins, TLS bypasses or shell loaders.\nUnsetEnvironment=CAMP_WORKER_TOKEN CAMP_WORKER_CREDENTIAL_FILE CAMP_WORKER_ROOM_ID CAMP_API_URL CAMP_WORKER_ID CAMP_RUNTIME_HOME CAMP_TOOLCHAIN_BUNDLE CAMP_RUNTIME_IMAGE CAMP_CONTROL_CA_FILE CAMP_POOL_ONCE CAMP_WORKER_ONCE CAMP_DOCKER_SOCKET CAMP_DSH_PLUGIN CAMP_DSH_ARCHIVE CAMP_DSH_PREFIX CAMP_VERIFICATION_HARNESSES CAMP_ALLOW_INSECURE_TRANSPORT CAMP_POOL_HOST_MEMORY_RESERVE_MIB DEEPSEEK_API_KEY DEEPSEEK_BASE_URL CAMP_DSH_MODEL DOCKER_HOST DOCKER_CONFIG NODE_OPTIONS NODE_TLS_REJECT_UNAUTHORIZED ${[...numericSettings].join(' ')}\nExecStartPre=${q(c.nodePath)} -e "${WORKER_ENV_CHECK}" ${q(envFile)} ${sha(environmentText)}\nExecStartPre=${q(c.nodePath)} ${q(join(c.releasePath, 'packages/camp-runtime/scripts/verify-worker-release.mjs'))} --release ${q(c.releasePath)} --manifest-sha256 ${c.releaseManifestSha256}\nExecStart=${q(c.nodePath)} ${envArgs.map(q).join(' ')} ${q(join(c.releasePath, 'packages/camp-runtime/scripts/worker-pool.mjs'))}\nUMask=0077\n# Same lock namespace as manual recovery/reap; Docker containers are outside this unit cgroup.\nPrivateTmp=no\nNoNewPrivileges=yes\nProtectSystem=full\nReadWritePaths=${[...new Set([c.runtimeHome, credentialDirectory])].map(q).join(' ')}\nKillMode=mixed\nKillSignal=SIGTERM\nTimeoutStopSec=180\n# Ordinary unsafe/fatal exits require inspection, not a restart loop.\nRestart=on-abnormal\nRestartSec=10\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=${c.serviceName}\n\n[Install]\nWantedBy=multi-user.target\n`;
  return { config: c, unit, environment: environmentText, environmentPath: envFile };
}

async function checkedDirectory(directory, { privateMode = false, create = false, uid = process.getuid() } = {}) {
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw fail(); }
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || stat.mode & (privateMode ? 0o077 : 0o022) || await realpath(directory) !== directory) throw fail();
  // A writable ancestor could replace an otherwise protected final path.
  let parent = dirname(directory);
  while (parent !== directory) {
    const entry = await lstat(parent);
    const trustedTemporary = parent === '/tmp' && !!(entry.mode & 0o1000);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 && entry.uid !== uid || !trustedTemporary && entry.mode & 0o022) throw fail();
    directory = parent; parent = dirname(parent);
  }
  return stat;
}
async function ordinary(file, { privateMode = false, maximum = 65536, uid = process.getuid() } = {}) {
  await checkedDirectory(dirname(file), { privateMode, uid });
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid || stat.mode & (privateMode ? 0o077 : 0o022) || privateMode && (stat.mode & 0o777) !== 0o600 || stat.size > maximum) throw fail();
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const next = await handle.read(bytes, length, bytes.length - length); if (!next.bytesRead) break; length += next.bytesRead; }
    if (length !== stat.size) throw fail();
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
async function optionalJson(file) {
  try { return JSON.parse((await ordinary(file, { privateMode: true })).toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw fail(); }
}
async function syncDirectory(folder) { const handle = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function acquireServiceLock(file) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.mode & 0o077) throw fail(); }
  finally { await handle.close(); }
  const script = "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));";
  const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '--no-fork', file, process.execPath, '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root' } });
  let owned = false, releasing = false, output = '', ended = false;
  const exited = new Promise(resolveExit => child.once('close', () => { ended = true; owned = false; resolveExit(); }));
  child.stdin.on('error', () => {}); child.stderr.resume();
  try {
    await new Promise((resolveLock, reject) => {
      const timer = setTimeout(() => reject(fail('camp_worker_service_busy')), 5000);
      child.once('error', () => { clearTimeout(timer); reject(fail('camp_worker_service_busy')); });
      child.once('close', () => { clearTimeout(timer); reject(fail('camp_worker_service_busy')); });
      child.stdout.on('data', bytes => {
        output += bytes;
        if (output === 'LOCKED\n') { clearTimeout(timer); owned = true; resolveLock(); }
        else if (output.length > 128) { clearTimeout(timer); reject(fail('camp_worker_service_busy')); }
      });
    });
  } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  return {
    check: () => { if (!owned || ended || releasing) throw fail('camp_worker_service_lock_lost'); },
    release: async () => {
      releasing = true; child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    },
  };
}
async function serviceOperation(c, unitDirectory, operation) {
  // One unit has one lock even when two operators supply different config
  // directories. Also serialize different units sharing the same config root.
  await checkedDirectory(unitDirectory);
  const root = join(unitDirectory, '.camp-worker-service-locks');
  await checkedDirectory(root, { privateMode: true, create: true });
  const keys = [`unit:${join(unitDirectory, c.serviceName + '.service')}`, `config:${c.configDirectory}`].sort();
  const locks = [];
  try {
    for (const key of keys) locks.push(await acquireServiceLock(join(root, sha(key) + '.lock')));
    try { await lstat(join(c.configDirectory, 'service-operation.lock')); throw fail('camp_worker_service_busy'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return await operation(() => locks.forEach(lock => lock.check()));
  } finally { for (const lock of locks.reverse()) await lock.release(); }
}
async function publish(file, bytes, mode, check = () => {}) {
  const temp = `${file}.tmp-${randomBytes(12).toString('hex')}`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
  finally { await handle.close(); }
  try { check(); await rename(temp, file); await syncDirectory(dirname(file)); }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Bootstrap verification does not execute or import the release being checked. */
export async function verifyServiceRelease(input) {
  const c = workerServiceConfiguration(input);
  await checkedDirectory(c.releasePath);
  const bytes = await ordinary(join(c.releasePath, 'worker-release.json'));
  if (sha(bytes) !== c.releaseManifestSha256) throw fail('camp_worker_service_release');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw fail('camp_worker_service_release'); }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'camp-worker-release' || manifest.nodeMajor !== 24 || manifest.external?.toolchainDigest !== c.toolchainDigest || manifest.external?.imageId !== c.imageId || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 256) throw fail('camp_worker_service_release');
  const allowed = new Set(['worker-release.json']); let total = 0;
  for (const item of manifest.files) {
    if (!own(item, ['path', 'size', 'mode', 'sha256']) || typeof item.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(item.path) || item.path.split('/').some(part => !part || part === '.' || part === '..') || allowed.has(item.path) || item.mode !== 0o644 || !hex(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 2 * 1024 * 1024 || (total += item.size) > 16 * 1024 * 1024) throw fail('camp_worker_service_release');
    allowed.add(item.path);
    const content = await ordinary(join(c.releasePath, item.path), { maximum: 2 * 1024 * 1024 });
    if (content.length !== item.size || sha(content) !== item.sha256 || ((await lstat(join(c.releasePath, item.path))).mode & 0o777) !== item.mode) throw fail('camp_worker_service_release');
  }
  async function walk(folder, prefix = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (![...allowed].some(path => path.startsWith(name + '/'))) throw fail('camp_worker_service_release');
        await checkedDirectory(join(folder, entry.name)); await walk(join(folder, entry.name), name + '/');
      } else if (!entry.isFile() || !allowed.delete(name)) throw fail('camp_worker_service_release');
    }
  }
  await walk(c.releasePath);
  if (allowed.size) throw fail('camp_worker_service_release');
  return manifest;
}

async function defaultRun(command, args) {
  try { return await execute(command, args, { timeout: 180_000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C.UTF-8' } }); }
  catch { throw fail('camp_worker_service_command'); }
}
const identity = c => ({ apiOrigin: c.apiOrigin, roomId: c.roomId, workerId: c.workerId, runtimeHome: c.runtimeHome, dockerSocket: c.dockerSocket, serviceName: c.serviceName });

export async function validateWorkerService(input, { run = defaultRun } = {}) {
  const c = workerServiceConfiguration(input);
  const manifest = await verifyServiceRelease(c);
  await checkedDirectory(c.toolchainPath);
  await checkedDirectory(c.runtimeHome, { privateMode: true });
  let credential;
  try { credential = JSON.parse((await ordinary(c.credentialFile, { privateMode: true, maximum: 16384 })).toString('utf8')); }
  catch { throw fail('camp_worker_service_credential'); }
  if (credential?.roomId !== c.roomId) throw fail('camp_worker_service_identity');
  const caBytes = await ordinary(c.controlCaFile, { maximum: 16384 });
  if (!caBytes.every(byte => byte <= 127)) throw fail('camp_worker_service_ca');
  let ca;
  const pem = caBytes.toString('ascii');
  if (!/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)) throw fail('camp_worker_service_ca');
  try { ca = new X509Certificate(pem); } catch { throw fail('camp_worker_service_ca'); }
  if (!ca.ca || !ca.checkIssued(ca) || !ca.verify(ca.publicKey) || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now()) throw fail('camp_worker_service_ca');
  if (c.harnessManifest) await ordinary(c.harnessManifest);
  if (c.dockerConfig) await checkedDirectory(c.dockerConfig, { privateMode: true });
  if (c.modelEnvFile) {
    const text = (await ordinary(c.modelEnvFile, { privateMode: true })).toString('utf8');
    const keys = new Set();
    // Single-line dotenv only; reject identity overrides and multiline values.
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match || !modelKeys.has(match[1]) || keys.has(match[1]) || /[\x00-\x1f\x7f]/.test(match[2]) || match[2].startsWith('"') && !match[2].endsWith('"') || match[2].startsWith("'") && !match[2].endsWith("'")) throw fail('camp_worker_service_model_environment');
      keys.add(match[1]);
    }
    const parsed = parseEnv(text);
    if (!parsed.DEEPSEEK_API_KEY?.trim()) throw fail('camp_worker_service_model_environment');
  }
  const node = await realpath(c.nodePath), nodeStat = await lstat(node);
  await checkedDirectory(dirname(c.nodePath)); await checkedDirectory(dirname(node));
  if (!nodeStat.isFile() || nodeStat.uid !== process.getuid() || nodeStat.mode & 0o022 || !(nodeStat.mode & 0o111)) throw fail();
  const version = await run(c.nodePath, ['--version']);
  if (!/^v24\.\d+\.\d+\s*$/.test(version.stdout)) throw fail('camp_worker_service_node');
  // These programs are now byte-verified. No API check precedes recovery.
  await run(c.nodePath, [join(c.releasePath, 'packages/camp-runtime/scripts/verify-worker-release.mjs'), '--release', c.releasePath, '--manifest-sha256', c.releaseManifestSha256]);
  await run(c.nodePath, ['--input-type=module', '-e', 'const {readWorkerCredential}=await import(process.argv[1]);await readWorkerCredential(process.argv[2]);', new URL(`file://${join(c.releasePath, 'packages/camp-runtime/src/worker-credentials.mjs')}`).href, c.credentialFile]);
  const checked = await run(c.nodePath, ['--input-type=module', '-e', 'const {loadToolchain}=await import(process.argv[1]);const t=await loadToolchain(process.argv[2]);if(t.digest!==process.argv[3])process.exit(1);', new URL(`file://${join(c.releasePath, 'packages/camp-runtime/src/toolchain.mjs')}`).href, c.toolchainPath, c.toolchainDigest]);
  void checked;
  const image = await run('/usr/bin/docker', ['--host', `unix://${c.dockerSocket}`, 'image', 'inspect', '--format', '{{.Id}}', c.imageId]);
  if (image.stdout.trim() !== c.imageId) throw fail('camp_worker_service_image');
  const pool = await optionalJson(join(c.runtimeHome, 'execution-pool.json'));
  if (pool && (pool.apiUrl !== c.apiOrigin || pool.baseWorkerId !== c.workerId)) throw fail('camp_worker_service_identity');
  return { manifest, identity: identity(c) };
}

function recordFor(c, rendered, unitPath) {
  return { schemaVersion: 2, identity: { ...identity(c), configDirectory: c.configDirectory, credentialFile: c.credentialFile }, unitPath, unitSha256: sha(rendered.unit), environmentPath: rendered.environmentPath, environmentSha256: sha(rendered.environment), releaseManifestSha256: c.releaseManifestSha256, toolchainDigest: c.toolchainDigest, imageId: c.imageId };
}
function matchesIdentity(record, c) {
  const expected = record.schemaVersion === 1 ? identity(c) : { ...identity(c), configDirectory: c.configDirectory, credentialFile: c.credentialFile };
  return [1, 2].includes(record.schemaVersion) && same(record.identity, expected);
}
function environmentPath(record, c) {
  const file = record.schemaVersion === 1 ? join(c.configDirectory, 'worker.env') : record.environmentPath;
  if (!path(file) || dirname(file) !== c.configDirectory || !/^worker-(?:[a-f0-9]{64})\.env$/.test(file.slice(c.configDirectory.length + 1)) && record.schemaVersion !== 1) throw fail('camp_worker_service_identity');
  return file;
}
async function unitText(unitPath) {
  try { return (await ordinary(unitPath)).toString('utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function verifyRecordEnvironment(record, c) {
  const bytes = await ordinary(environmentPath(record, c), { privateMode: true });
  // Older receipts did not explicitly bind the credential pathname. The
  // immutable old environment supplies that fact during the first upgrade.
  if (sha(bytes) !== record.environmentSha256 || parseEnv(bytes.toString('utf8')).CAMP_WORKER_CREDENTIAL_FILE !== c.credentialFile) throw fail('camp_worker_service_identity');
}
async function loadedUnit(run, name, unitPath, { fresh = false, allowReload = false, allowMissing = false } = {}) {
  const text = (await run('/usr/bin/systemctl', ['show', '--property=FragmentPath,DropInPaths,NeedDaemonReload', name])).stdout;
  const values = Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  if (fresh ? values.FragmentPath !== '' : values.FragmentPath !== unitPath && !(allowMissing && values.FragmentPath === '')) throw fail('camp_worker_service_override');
  if (values.DropInPaths !== '' || !['yes', 'no'].includes(values.NeedDaemonReload) || !allowReload && values.NeedDaemonReload !== 'no') throw fail('camp_worker_service_override');
}
function checkedIntent(intent, c, rendered, unitPath) {
  const next = recordFor(c, rendered, unitPath);
  if (!own(intent, ['schemaVersion', 'previousUnitSha256', 'previousRecordDigest', 'nextRecord', 'unit', 'environment']) || intent.schemaVersion !== 1 || intent.previousUnitSha256 !== null && !hex(intent.previousUnitSha256) || intent.previousRecordDigest !== null && !hex(intent.previousRecordDigest) || !same(intent.nextRecord, next) || intent.unit !== rendered.unit || intent.environment !== rendered.environment) throw fail('camp_worker_service_pending');
  return next;
}
async function immutableEnvironment(file, bytes, check) {
  try {
    const previous = await ordinary(file, { privateMode: true });
    if (!previous.equals(Buffer.from(bytes))) throw fail('camp_worker_service_identity');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Do not expose a partial generation if the installer is killed while
    // writing it. A complete generation is never rewritten on replay.
    await publish(file, bytes, 0o600, check);
  }
}

/** Install stopped only. A durable intent replays the exact same deployment;
 * each unit always references its own immutable environment generation. */
export async function installWorkerService(input, { unitDirectory = '/etc/systemd/system', run = defaultRun } = {}) {
  const rendered = renderWorkerService(input), c = rendered.config;
  if (process.getuid() !== 0 || !path(unitDirectory)) throw fail();
  await checkedDirectory(c.configDirectory, { privateMode: true, create: true });
  return serviceOperation(c, unitDirectory, async check => {
    const guardedRun = async (...args) => { check(); const result = await run(...args); check(); return result; };
    const recordPath = join(c.configDirectory, 'service-install.json'), pendingPath = join(c.configDirectory, 'service-install.pending.json'), unitPath = join(unitDirectory, c.serviceName + '.service');
    const previous = await optionalJson(recordPath), pending = await optionalJson(pendingPath), current = await unitText(unitPath), desired = recordFor(c, rendered, unitPath);
    if (pending) {
      checkedIntent(pending, c, rendered, unitPath);
      if (![pending.previousUnitSha256, desired.unitSha256].includes(current === null ? null : sha(current)) || ![pending.previousRecordDigest, sha(JSON.stringify(desired))].includes(previous === null ? null : sha(JSON.stringify(previous)))) throw fail('camp_worker_service_pending');
    } else {
      if (previous && (previous.unitPath !== unitPath || !matchesIdentity(previous, c)) || current !== null && (!previous || sha(current) !== previous.unitSha256) || previous && current === null) throw fail('camp_worker_service_identity');
      if (previous) await verifyRecordEnvironment(previous, c);
    }
    await loadedUnit(guardedRun, c.serviceName + '.service', unitPath, { fresh: current === null, allowReload: true, allowMissing: Boolean(pending && pending.previousUnitSha256 === null) });
    const state = await guardedRun('/usr/bin/systemctl', ['show', '--property=ActiveState', '--value', c.serviceName + '.service']);
    if (!['inactive', 'failed', ''].includes(state.stdout.trim())) throw fail('camp_worker_service_active');
    await validateWorkerService(c, { run: guardedRun }); check();
    const intent = pending ?? { schemaVersion: 1, previousUnitSha256: current === null ? null : sha(current), previousRecordDigest: previous === null ? null : sha(JSON.stringify(previous)), nextRecord: desired, unit: rendered.unit, environment: rendered.environment };
    if (!pending) await publish(pendingPath, JSON.stringify(intent, null, 2) + '\n', 0o600, check);
    check(); await immutableEnvironment(rendered.environmentPath, rendered.environment, check); check();
    await publish(unitPath, rendered.unit, 0o644, check);
    await publish(recordPath, JSON.stringify(desired, null, 2) + '\n', 0o600, check);
    await guardedRun('/usr/bin/systemctl', ['daemon-reload']);
    await loadedUnit(guardedRun, c.serviceName + '.service', unitPath);
    check(); await unlink(pendingPath); await syncDirectory(c.configDirectory);
    return { event: 'worker_service_installed', service: c.serviceName + '.service', started: false, enabled: false, releaseManifestSha256: c.releaseManifestSha256 };
  });
}

export async function operateWorkerService(action, input, { unitDirectory = '/etc/systemd/system', run = defaultRun } = {}) {
  if (!['start', 'stop', 'restart', 'status', 'enable', 'disable'].includes(action) || process.getuid() !== 0 || !path(unitDirectory)) throw fail();
  const c = workerServiceConfiguration(input);
  await checkedDirectory(c.configDirectory, { privateMode: true });
  return serviceOperation(c, unitDirectory, async check => {
    const guardedRun = async (...args) => { check(); const result = await run(...args); check(); return result; };
    const unitPath = join(unitDirectory, c.serviceName + '.service'), current = await unitText(unitPath), pending = await optionalJson(join(c.configDirectory, 'service-install.pending.json'));
    const previous = await optionalJson(join(c.configDirectory, 'service-install.json'));
    // A partially published but owned deployment may always be stopped or
    // inspected. It must be repaired before any operation can start it.
    const starts = ['start', 'restart', 'enable'].includes(action);
    if (pending && starts) throw fail('camp_worker_service_pending');
    const record = pending?.nextRecord?.unitSha256 === (current === null ? null : sha(current)) ? pending.nextRecord : previous;
    if (!record || record.unitPath !== unitPath || !matchesIdentity(record, c) || current === null || sha(current) !== record.unitSha256) throw fail('camp_worker_service_identity');
    if (starts) {
      const rendered = renderWorkerService(c), expected = recordFor(c, rendered, unitPath);
      // v1 records can be stopped and upgraded, but their mutable env layout
      // must go through install before a new reviewed start.
      if (!same(record, expected)) throw fail('camp_worker_service_identity');
      await verifyRecordEnvironment(record, c);
      await loadedUnit(guardedRun, c.serviceName + '.service', unitPath);
      await validateWorkerService(c, { run: guardedRun });
    }
    const args = action === 'status' ? ['show', '--property=ActiveState,SubState,Result,MainPID,ExecMainStatus', c.serviceName + '.service'] : [action, c.serviceName + '.service'];
    const result = await guardedRun('/usr/bin/systemctl', args);
    return { event: 'worker_service_' + action, service: c.serviceName + '.service', ...(action === 'status' ? { state: result.stdout.trim() } : {}) };
  });
}

export async function workerServiceMain(args) {
  const [action, flag, file] = args;
  if (args.length !== 3 || flag !== '--config' || !path(file)) throw fail();
  let config;
  try { config = JSON.parse((await ordinary(file, { privateMode: true })).toString('utf8')); } catch { throw fail(); }
  const checked = workerServiceConfiguration(config);
  if (dirname(file) === checked.configDirectory && reserved(file.slice(checked.configDirectory.length + 1))) throw fail();
  if (action === 'render') {
    const { unit, environment } = renderWorkerService(config);
    return { unit, environment };
  }
  if (action === 'check') { await validateWorkerService(config); return { event: 'worker_service_checked' }; }
  if (action === 'install') return installWorkerService(config);
  return operateWorkerService(action, config);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await workerServiceMain(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ event: 'worker_service_failed', code: error.code ?? 'camp_worker_service_invalid' })); process.exitCode = 1; }
}
