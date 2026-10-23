import { spawn } from 'node:child_process';
import { open, readFile, mkdir, mkdtemp, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { CampRuntime } from './index.mjs';
import { checkedCandidate, checkedManifest } from './candidate.mjs';
import { receiveSnapshot, removeOwnedDirectory } from './safe-export.mjs';
import { acquireProjectLock } from './project-lock.mjs';
import { managedWorkerCredential } from './worker-credentials.mjs';

const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('../') && path !== '..'); };
function finished(child) {
  return new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => code === 0 ? resolveExit() : reject(new Error(`Export process exited ${code ?? signal}`))); });
}

/** Export a complete immutable snapshot to a new external target, never a patch over source. */
export async function exportCandidate({ runtime, candidate, roomId, goalId, output, archive = false, maxBytes, maxEntries }) {
  const timeoutMs = Number(process.env.CAMP_EXPORT_TIMEOUT_MS ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('CAMP_EXPORT_TIMEOUT_MS must be a positive bounded integer');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Export wall-clock deadline exceeded')), timeoutMs);
  let lock;
  try {
    // Private materializations use performExport directly under their active
    // manager. Public exports must also exclude cold Store maintenance.
    if (runtime instanceof CampRuntime) lock = await acquireProjectLock(runtime, checkedCandidate(candidate).projectId, { signal: controller.signal, onLost: error => controller.abort(error) });
    return await performExport({ runtime, candidate, roomId, goalId, output, archive, maxBytes, maxEntries, signal: controller.signal });
  } finally { clearTimeout(timer); await lock?.release(); }
}
/** Private bounded materialization. Its opaque links are never followed on the host. */
export async function materializeCandidate({ runtime, candidate, ownerRun, output, signal, maxBytes = 512 * 1024 ** 2, maxEntries = 20000 }) {
  signal ??= new AbortController().signal;
  const identity = runtime.runIdentity(ownerRun.runId);
  if (identity.prefix !== ownerRun.prefix || identity.folder !== ownerRun.folder) throw new Error('Materialization owner differs from its original attempt');
  const parent = await realpath(dirname(resolve(output)));
  if (!inside(await realpath(ownerRun.folder), parent)) throw new Error('Private materialization must stay inside its original attempt folder');
  return performExport({ runtime, candidate, output, signal, maxBytes, maxEntries, ownerRun, archive: false });
}
async function performExport({ runtime, candidate, roomId, goalId, output, archive, maxBytes, maxEntries, signal, ownerRun }) {
  const requested = checkedCandidate(candidate);
  const project = await runtime.loadProject(requested.projectId, { roomId });
  const verified = await runtime.verifyCandidate(project, requested, { signal });
  const selected = { type: 'layerfs', projectId: verified.projectId, refKind: verified.refKind, refId: verified.refId, ...(verified.refKind === 'commit' ? { commitId: verified.refId } : { layerId: verified.refId }), rootId: verified.rootId, imageId: verified.imageId };
  const target = resolve(output);
  const parent = await realpath(dirname(target));
  if (join(parent, basename(target)) !== target) throw new Error('Export destination parent must be a canonical local directory');
  const stateRoot = await realpath(runtime.home);
  // A deleted source checkout does not invalidate an immutable stored result.
  const sourceRoot = project.sourcePath && await realpath(project.sourcePath).catch(error => { if (error.code === 'ENOENT') return resolve(project.sourcePath); throw error; });
  if (!ownerRun && (inside(stateRoot, target) || (sourceRoot && inside(sourceRoot, target)))) throw new Error('Export destination must be outside the runtime state and source checkout');
  await lstat(target).then(() => { throw new Error('Export destination already exists'); }, error => { if (error.code !== 'ENOENT') throw error; });
  const manifestPath = `${target}.manifest.json`;
  // Reserve the manifest name before creating a target; never overwrite either.
  const reservation = await open(manifestPath, 'wx', 0o600);
  const manifestIdentity = await reservation.stat();
  let working, identity, run, child, archiveIdentity, success = false;
  try {
    working = archive ? await mkdtemp(join(parent, '.camp-export-')) : target;
    if (!archive) await mkdir(working, { mode: 0o700 });
    identity = await lstat(working);
    signal.throwIfAborted();
    run = await runtime.prepareRun({ project, runId: `export-${randomUUID()}`, roleId: 'export', baseRef: selected.refId, owner: { purpose: ownerRun ? 'materialize' : 'export', roomId, goalId }, ...(ownerRun ? { ownerPrefix: ownerRun.prefix } : {}), signal });
    await runtime.dockerCall(['cp', fileURLToPath(new URL('./snapshot-stream.mjs', import.meta.url)), `${run.containerId}:/tmp/camp-snapshot-stream.mjs`], { signal });
    child = spawn('docker', ['-H', `unix://${runtime.docker}`, 'exec', '--user', '0:0', '--workdir', '/', run.containerId, '/usr/local/bin/node', '/tmp/camp-snapshot-stream.mjs', run.workspacePath], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, signal });
    child.stderr.resume();
    const exited = finished(child);
    exited.catch(() => {});
    const counts = await receiveSnapshot(child.stdout, working, { ...(maxBytes === undefined ? {} : { maxBytes }), ...(maxEntries === undefined ? {} : { maxEntries }), allowUnsafeLinks: Boolean(ownerRun) });
    await exited;
    if (archive) {
      const file = await open(target, 'wx', 0o600);
      archiveIdentity = await file.stat();
      const tar = spawn('docker', ['-H', `unix://${runtime.docker}`, 'exec', '--user', '0:0', run.containerId, 'tar', '--format=posix', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', run.workspacePath, '.'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, signal });
      tar.stderr.resume();
      const closed = finished(tar);
      closed.catch(() => {});
      try { for await (const chunk of tar.stdout) await file.writeFile(chunk); await closed; await file.sync(); }
      finally { tar.kill('SIGTERM'); await file.close(); }
    }
    await runtime.releaseRun(run, { discard: true, signal });
    run = null;
    const receipt = { schemaVersion: 1, ...(roomId ? { roomId } : {}), ...(goalId ? { goalId } : {}), candidate: selected, format: archive ? 'tar' : 'directory', files: counts.files, directories: counts.directories, symlinks: counts.symlinks, bytes: counts.bytes, deletionSemantics: 'complete snapshot; paths absent from this snapshot are absent from the export', createdAt: new Date().toISOString() };
    const currentManifest = await lstat(manifestPath);
    if (currentManifest.ino !== manifestIdentity.ino || currentManifest.dev !== manifestIdentity.dev || currentManifest.isSymbolicLink()) throw new Error('Export manifest reservation was replaced');
    await reservation.writeFile(`${JSON.stringify(receipt, null, 2)}\n`);
    await reservation.sync();
    success = true;
    return { ...receipt, output: target, manifestPath };
  } finally {
    try {
      child?.kill('SIGTERM');
      try { if (run) await runtime.abortRun(run, 'export_failed', { timeout: 5000 }); }
      finally {
        if (identity && (archive || !success)) await removeOwnedDirectory(working, identity);
        if (!success) {
          if (archiveIdentity) {
            const current = await lstat(target).catch(() => null);
            if (current?.ino === archiveIdentity.ino && current.dev === archiveIdentity.dev) await rm(target);
          }
          const current = await lstat(manifestPath).catch(() => null);
          if (current?.ino === manifestIdentity.ino && current.dev === manifestIdentity.dev) await rm(manifestPath);
        }
      }
    } finally { await reservation.close(); }
  }
}

export async function fetchGoalManifest({ apiUrl, token, goalId, request }) {
  if (!/^[a-f0-9-]{36}$/.test(goalId ?? '')) throw new Error('Invalid goal ID');
  if (request) {
    const manifest = checkedManifest(await request(`/goals/${goalId}/result`));
    if (manifest.goalId !== goalId) throw new Error('Manifest goal identity differs from the requested goal');
    return manifest;
  }
  if (!token) throw new Error('CAMP_WORKER_TOKEN is required for goal manifest access');
  const url = new URL(`${apiUrl.replace(/\/$/, '')}/api/camp/worker/goals/${goalId}/result`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Camp API URL');
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Goal manifest request rejected (${response.status})`);
  const manifest = checkedManifest(await response.json());
  if (manifest.goalId !== goalId) throw new Error('Manifest goal identity differs from the requested goal');
  return manifest;
}

export async function exportMain(args = process.argv.slice(2), env = process.env) {
  const values = new Map();
  const allowed = new Set(['--manifest', '--goal', '--project', '--commit', '--layer', '--ref', '--ref-kind', '--root', '--image', '--out', '--archive']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i] === '--output' ? '--out' : args[i];
    if (!allowed.has(key) || values.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --manifest FILE or --goal ID or --project ID --commit ID --root ID, with --output NEW_DIR or --archive NEW_TAR');
    values.set(key, args[i + 1]);
  }
  if (Number(values.has('--out')) + Number(values.has('--archive')) !== 1 || Number(values.has('--manifest')) + Number(values.has('--goal')) + Number(values.has('--project')) !== 1) throw new Error('Select exactly one input and one new export destination');
  let manifest;
  if (values.has('--manifest')) manifest = checkedManifest(JSON.parse(await readFile(resolve(values.get('--manifest')), 'utf8')));
  if (values.has('--goal')) {
    const credential = await managedWorkerCredential({ env });
    manifest = await fetchGoalManifest({ request: credential.request, goalId: values.get('--goal') });
  }
  if (manifest && ['--commit', '--layer', '--ref', '--ref-kind', '--root', '--image'].some(key => values.has(key))) throw new Error('A manifest candidate cannot be overridden with local candidate fields');
  if (!manifest && Number(values.has('--commit')) + Number(values.has('--layer')) + Number(values.has('--ref')) !== 1) throw new Error('Select exactly one immutable Commit or Layer reference');
  if (!manifest && values.has('--ref-kind') && !values.has('--ref')) throw new Error('--ref-kind is only valid with --ref');
  const reference = values.has('--commit') ? { commitId: values.get('--commit') } : values.has('--layer') ? { refKind: 'layer', refId: values.get('--layer'), layerId: values.get('--layer') } : { refKind: values.get('--ref-kind'), refId: values.get('--ref') };
  const candidate = manifest?.candidate ?? { type: 'layerfs', projectId: values.get('--project'), ...reference, rootId: values.get('--root'), ...(values.has('--image') ? { imageId: values.get('--image') } : {}) };
  const runtime = await new CampRuntime({ env }).ready();
  return exportCandidate({ runtime, candidate, roomId: manifest?.roomId, goalId: manifest?.goalId, output: values.get('--out') ?? values.get('--archive'), archive: values.has('--archive') });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await exportMain().then(result => console.log(JSON.stringify(result)), error => { console.error(JSON.stringify({ event: 'export_failed', reason: error.message })); process.exitCode = 1; });
}
