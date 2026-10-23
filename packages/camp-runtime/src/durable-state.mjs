import { open, mkdir, rename, unlink, readdir, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

export const stateKey = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const runTokenForClaim = (workerToken, claimId) => `camp_run_${createHmac('sha256', workerToken).update(claimId).digest('hex')}`;

/** Existing shared or linked homes must not silently expose private attempts. */
export async function privateDirectory(path) {
  // Refuse a linked ancestor before recursive mkdir can create anything on
  // the other side of it. Only the final new private directory is ours.
  let ancestor = resolve(path);
  for (;;) {
    try { if (await realpath(ancestor) !== ancestor) throw Object.assign(new Error('Runtime state and lock directories must be owned private directories (0700), without symlinks'), { code: 'camp_journal_io' }); break; }
    catch (error) { if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await realpath(path) !== resolve(path)) throw Object.assign(new Error('Runtime state and lock directories must be owned private directories (0700), without symlinks'), { code: 'camp_journal_io' });
}

/** Local-filesystem durability: contents first, then atomic name, then directory. */
export async function atomicJson(path, value) {
  try { return await writeAtomic(path, value); }
  catch (error) { throw Object.assign(new Error(`Durable worker state write failed (${error.code ?? error.name})`), { code: 'camp_journal_io', cause: error }); }
}
async function writeAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function readJson(path, maximum = 16 * 1024 * 1024) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > maximum) throw Object.assign(new Error('Journal file is not an owned private bounded regular file'), { code: 'camp_journal_invalid' });
    // Journal updates replace immutable files atomically. One byte beyond the
    // observed size detects in-place growth without allocating the full cap
    // for every small heartbeat document.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw Object.assign(new Error('Journal file changed while reading'), { code: 'camp_journal_invalid' });
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw Object.assign(new Error(`Worker journal read failed (${error.code ?? error.name})`), { code: error instanceof SyntaxError || error.code === 'camp_journal_invalid' ? 'camp_journal_invalid' : 'camp_journal_io', cause: error }); }
  finally { await file?.close(); }
}

/** No tokens or provider keys are stored in this journal. */
export class WorkerJournal {
  constructor({ home, apiUrl, workerId, persist = atomicJson }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.workerId = workerId;
    this.home = resolve(home);
    this.folder = resolve(home, 'workers', stateKey(`${this.apiUrl}\n${workerId}`));
    this.pending = new Map();
    this.persist = persist;
  }
  async ready() {
    await privateDirectory(this.home);
    // Check every authority-bearing boundary before reading or creating facts.
    // Recursive mkdir alone accepts pre-existing linked or shared descendants.
    await privateDirectory(join(this.home, 'workers'));
    await privateDirectory(this.folder);
    await privateDirectory(join(this.folder, 'attempts'));
    const metadata = await readJson(join(this.folder, 'worker.json'), 65536);
    if (metadata && (metadata.version !== 1 || metadata.apiUrl !== this.apiUrl || metadata.workerId !== this.workerId)) throw new Error('Worker journal identity mismatch');
    if (!metadata) await this.persist(join(this.folder, 'worker.json'), { version: 1, apiUrl: this.apiUrl, workerId: this.workerId, pendingClaim: null });
    return this;
  }
  async claimIntent() {
    const path = join(this.folder, 'worker.json');
    const metadata = await readJson(path, 65536);
    if (metadata.pendingClaim) return metadata.pendingClaim;
    const claimId = randomUUID();
    await this.persist(path, { ...metadata, pendingClaim: claimId });
    return claimId;
  }
  async pendingClaim() { return (await readJson(join(this.folder, 'worker.json'), 65536)).pendingClaim; }
  async finishClaim() {
    const path = join(this.folder, 'worker.json');
    const metadata = await readJson(path, 65536);
    await this.persist(path, { ...metadata, pendingClaim: null });
  }
  path(record) { return join(this.folder, 'attempts', `${stateKey(`${record.runId}:${record.epoch}`)}.json`); }
  async recordClaim(claim, { claimId, deadlineAt, runtime } = {}) {
    const record = { version: 1, apiUrl: this.apiUrl, workerId: this.workerId, runId: claim.id, roomId: claim.roomId, epoch: claim.epoch, role: claim.role, executor: claim.executor, operationId: claim.operationId, goalId: claim.goalId, protocolVersion: claim.protocolVersion, workflow: claim.workflow, taskKind: claim.taskKind, planItemKey: claim.planItemKey, workerProtocol: claim.workerProtocol ?? null, ...(claim.integrationInput ? { integrationInput: claim.integrationInput } : {}), claimId, leaseExpiresAt: claim.leaseExpiresAt, deadlineAt, runtime, phase: 'claimed', cleanupKnown: false, createdAt: new Date().toISOString() };
    const path = this.path(record);
    const previous = await readJson(path);
    if (previous) return previous;
    await this.persist(path, record);
    return record;
  }
  async list() {
    const result = [];
    for (const file of await readdir(join(this.folder, 'attempts'))) {
      if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
      const record = await readJson(join(this.folder, 'attempts', file));
      if (!record || record.version !== 1 || record.apiUrl !== this.apiUrl || record.workerId !== this.workerId || typeof record.runId !== 'string' || !Number.isSafeInteger(record.epoch) || record.epoch < 1 || file !== `${stateKey(`${record.runId}:${record.epoch}`)}.json`) throw Object.assign(new Error('Invalid worker journal entry; refusing automatic recovery'), { code: 'camp_journal_invalid' });
      result.push(record);
    }
    return result;
  }
  update(record, patch) {
    const path = this.path(record);
    const previous = this.pending.get(path) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await readJson(path);
      if (!current || current.workerId !== this.workerId || current.epoch !== record.epoch || current.runId !== record.runId) throw new Error('Cannot update an unowned journal');
      const next = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), updatedAt: new Date().toISOString() };
      await this.persist(path, next);
      Object.assign(record, next);
      return next;
    });
    this.pending.set(path, operation);
    // A fulfilled Promise retains its complete result, including large Diff
    // and report payloads. Keep only currently queued writes in a long-lived
    // worker; a later writer must retain ownership of its own queue slot.
    const release = () => { if (this.pending.get(path) === operation) this.pending.delete(path); };
    operation.then(release, release);
    return operation;
  }
  async stageCompletion(record, payload) {
    if (payload.workerId !== record.workerId || payload.epoch !== record.epoch) throw new Error('Completion identity differs from original attempt');
    const serialized = JSON.stringify(payload);
    const digest = createHash('sha256').update(serialized).digest('hex');
    return this.update(record, current => {
      if (current.completion && current.completion.digest !== digest) throw new Error('A completion outbox payload is immutable');
      return current.completion ? {} : { phase: 'result_staged', completion: { payload: JSON.parse(serialized), digest, preparedAt: new Date().toISOString(), attempts: 0 } };
    });
  }
  async prepareCompletion(record, payload) {
    await this.stageCompletion(record, payload);
    return this.update(record, current => {
      if (!current.cleanupKnown) throw new Error('Cannot prepare completion before resource cleanup is confirmed');
      return { phase: 'completion_pending' };
    });
  }
  async prepareCancellation(record) {
    const payload = { workerId: record.workerId, epoch: record.epoch, status: 'cancelled', summary: 'Execution stopped and its sandbox was removed.', ...(record.executor === 'integration' && record.requiresInspection ? { error: 'camp_integration_inspection_required' } : {}) };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return this.update(record, current => {
      if (!current.cleanupKnown) throw new Error('Cannot acknowledge cancellation before cleanup');
      if (current.cancellationAck && current.cancellationAck.digest !== digest) throw new Error('Cancellation acknowledgement is immutable');
      return { phase: 'cancellation_pending', cancellationAck: current.cancellationAck ?? { payload, digest, preparedAt: new Date().toISOString(), attempts: 0 } };
    });
  }
}

/** The kernel releases flock after SIGKILL; the helper exits when its owner pipe closes. */
export async function acquireWorkerLock(workerId, { root = join(tmpdir(), `camp-worker-locks-${process.getuid()}`), onLost = () => {}, waitMs = 0, signal } = {}) {
  signal?.throwIfAborted();
  await privateDirectory(root);
  const path = join(root, `${stateKey(workerId)}.lock`);
  const script = "process.stdout.write('LOCKED\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.stdin.on('error',()=>process.exit(0));";
  const child = spawn('flock', ['--exclusive', ...(waitMs ? ['--wait', String(waitMs / 1000)] : ['--nonblock']), '--conflict-exit-code', '73', path, process.execPath, '-e', script], { stdio: ['pipe', 'pipe', 'pipe'], signal });
  let releasing = false;
  let acquired = false;
  const exited = new Promise(resolveExit => child.once('exit', resolveExit));
  await new Promise((resolveLock, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Worker lock acquisition timed out')); }, Math.max(5000, waitMs + 1000));
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (!acquired) reject(new Error(code === 73 ? 'This workerId is already running on this host' : `Worker lock helper exited (${code})`));
      else if (!releasing) onLost(new Error('Worker process lock was lost'));
    });
    child.stdout.once('data', data => {
      clearTimeout(timeout);
      if (data.toString() !== 'LOCKED\n') { child.kill('SIGTERM'); reject(new Error('Invalid worker lock handshake')); return; }
      acquired = true;
      resolveLock();
    });
  });
  return { path, async release() { releasing = true; child.stdin.end(); await exited; } };
}
