import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, readdir, mkdir, chmod, realpath, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_LIMITS = Object.freeze({ maxBytes: 32 * 1024 ** 2, maxEntries: 5000, timeoutMs: 30000 });
const SOURCE = '/tmp/camp-dsh-home';
const failure = reason => Object.assign(new Error(`Session archive: ${reason}`), { archiveReason: reason });

async function abortable(work, signal) {
  signal.throwIfAborted();
  return new Promise((resolveWork, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(work).then(resolveWork, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
async function settledWithin(work, milliseconds) {
  const controller = new AbortController();
  try { return await Promise.race([work, delay(milliseconds, null, { signal: controller.signal })]); }
  finally { controller.abort(); }
}

/** This entry point runs only trusted Node code after the agent is quiescent. */
export async function streamSessionHome(output, { maxBytes, maxEntries, sourceDirectory = SOURCE }) {
  let entries = 0, bytes = 0;
  const emit = async frame => { if (!output.write(`${JSON.stringify(frame)}\n`)) await once(output, 'drain'); };
  const root = await lstat(sourceDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw failure('unsafe_entry');
  await emit({ type: 'root', mode: 0o700 });
  async function walk(relative = '') {
    for (const nameBytes of await readdir(join(sourceDirectory, relative), { encoding: 'buffer' })) {
      if (++entries > maxEntries) throw failure('entry_limit');
      const name = nameBytes.toString('utf8');
      if (!Buffer.from(name).equals(nameBytes)) { await emit({ type: 'omitted', path: `[non-UTF8:${nameBytes.toString('hex').slice(0, 120)}]`, reason: 'invalid_name' }); continue; }
      const path = relative ? `${relative}/${name}` : name;
      const source = join(sourceDirectory, path), stat = await lstat(source);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { await emit({ type: 'omitted', path, reason: stat.isSymbolicLink() ? 'symlink' : 'special_entry' }); continue; }
      if (stat.isDirectory()) { await emit({ type: 'directory', path, mode: stat.mode & 0o777 }); await walk(path); }
      else {
        if (stat.size > maxBytes - bytes) throw failure('byte_limit');
        const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const current = await file.stat();
          if (!current.isFile() || current.ino !== stat.ino || current.dev !== stat.dev || current.size !== stat.size) throw failure('source_changed');
          await emit({ type: 'file', path, size: stat.size, mode: stat.mode & 0o777 });
          let length = 0;
          for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
            if (chunk.length > maxBytes - bytes) throw failure('byte_limit');
            length += chunk.length; bytes += chunk.length;
            await emit({ type: 'data', data: chunk.toString('base64') });
          }
          if (length !== stat.size) throw failure('source_changed');
          await emit({ type: 'file_end' });
        } finally { await file.close(); }
      }
    }
  }
  await walk(); await emit({ type: 'end' });
}

/** Validate again on the host: a transport is never authority for links or paths. */
async function* archiveFrames(stream, signal, state, maxEntries) {
  stream.setEncoding('utf8');
  let pending = '';
  for await (const chunk of stream) {
    signal.throwIfAborted(); pending += chunk;
    let at;
    while ((at = pending.indexOf('\n')) !== -1) {
      if (at > 128 * 1024) throw failure('invalid_stream');
      let frame;
      try { frame = JSON.parse(pending.slice(0, at)); } catch { throw failure('invalid_stream'); }
      pending = pending.slice(at + 1);
      if (!frame || !['root', 'directory', 'file', 'data', 'file_end', 'end', 'failure', 'omitted'].includes(frame.type)) throw failure('unsafe_entry');
      if (frame.type === 'failure') throw failure(['byte_limit', 'entry_limit', 'source_changed'].includes(frame.reason) ? frame.reason : 'transport_failed');
      if (['file', 'directory', 'omitted'].includes(frame.type) && ++state.entries > maxEntries) throw failure('entry_limit');
      if (frame.type === 'omitted') {
        if (typeof frame.path !== 'string' || frame.path.length > 4096 || !['invalid_name', 'symlink', 'special_entry'].includes(frame.reason)) throw failure('invalid_stream');
        state.omittedCount++;
        if (state.omittedEntries.length < 30) state.omittedEntries.push({ path: frame.path.slice(0, 240), reason: frame.reason });
        continue;
      }
      if (frame.type === 'root' || frame.type === 'directory') frame.mode = 0o700;
      if (frame.type === 'file') frame.mode = 0o600;
      yield `${JSON.stringify(frame)}\n`;
    }
    if (pending.length > 128 * 1024) throw failure('invalid_stream');
  }
  if (pending) throw failure('invalid_stream');
}

/** Best-effort evidence only. Failure cannot invalidate an immutable candidate. */
export async function archiveSession({ runtime, run, signal, maxBytes = DEFAULT_LIMITS.maxBytes, maxEntries = DEFAULT_LIMITS.maxEntries, timeoutMs = DEFAULT_LIMITS.timeoutMs, spawnCommand = spawn }) {
  const identity = runtime.runIdentity(run.runId);
  if (identity.folder !== run.folder || identity.prefix !== run.config?.prefix || !/^camp-mvp-run-[a-f0-9]{16}-$/.test(identity.prefix) || !/^[a-f0-9]{64}$/.test(run.containerId ?? '')) throw failure('invalid_owner');
  const folder = await lstat(run.folder);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid() || (folder.mode & 0o077) || await realpath(run.folder) !== resolve(run.folder)) throw failure('invalid_owner');
  const { atomicJson } = await import('./durable-state.mjs');
  const { receiveSnapshot, removeOwnedDirectory } = await import('./safe-export.mjs');
  const receiptPath = join(run.folder, 'session-archive.json'), output = join(run.folder, 'dsh-home');
  const receipt = { schemaVersion: 1, runId: run.runId, status: 'error', reason: null, counts: { files: 0, directories: 0, bytes: 0 }, omittedCount: 0, omittedEntries: [], retained: false, limits: { maxBytes, maxEntries, timeoutMs }, createdAt: new Date().toISOString() };
  let outputIdentity, child, exited, sourceFile, sourceIdentity;
  const state = { entries: 0, omittedCount: 0, omittedEntries: [] };
  const controller = new AbortController();
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(failure('timeout')), timeoutMs);
  try {
    for (const [key, value] of Object.entries(receipt.limits)) if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[key]) throw failure('invalid_limits');
    activeSignal.throwIfAborted();
    await mkdir(output, { mode: 0o700 }); outputIdentity = await lstat(output);
    const name = `camp-session-archive-${randomUUID()}.mjs`;
    sourceFile = join(run.folder, name);
    const handle = await open(sourceFile, 'wx', 0o600);
    try { sourceIdentity = await handle.stat(); await handle.writeFile(await readFile(fileURLToPath(import.meta.url))); } finally { await handle.close(); }
    await abortable(runtime.dockerCall(['cp', sourceFile, `${run.containerId}:/tmp/${name}`], { signal: activeSignal, timeout: timeoutMs }), activeSignal);
    child = spawnCommand('docker', ['-H', `unix://${runtime.docker}`, 'exec', '--user', '0:0', '--workdir', '/', run.containerId, '/usr/local/bin/node', `/tmp/${name}`, '--send', String(maxBytes), String(maxEntries)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, signal: activeSignal });
    let senderReason = '';
    child.stderr.on('data', chunk => { senderReason = (senderReason + chunk).slice(-1024); });
    exited = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolveExit() : reject(failure(/\b(byte_limit|entry_limit)\b/.exec(senderReason)?.[1] ?? 'transport_failed'))); });
    exited.catch(() => {});
    const abort = () => { child.kill('SIGKILL'); child.stdout.destroy(activeSignal.reason); };
    activeSignal.addEventListener('abort', abort, { once: true });
    try {
      const counts = await receiveSnapshot(Readable.from(archiveFrames(child.stdout, activeSignal, state, maxEntries)), output, { maxBytes, maxEntries });
      await exited; activeSignal.throwIfAborted();
      receipt.counts = { files: counts.files, directories: counts.directories, bytes: counts.bytes };
      await chmod(output, 0o700); receipt.retained = true; receipt.status = state.omittedCount ? 'truncated' : 'archived'; receipt.reason = state.omittedCount ? 'omitted_entries' : null;
    } finally { activeSignal.removeEventListener('abort', abort); }
  } catch (error) {
    const transport = exited && await settledWithin(exited.then(() => null, error => error), 20);
    const reason = controller.signal.aborted ? 'timeout' : signal?.aborted ? 'aborted' : error.archiveReason ?? transport?.archiveReason ?? (/byte budget|file size exceeds/.test(error.message) ? 'byte_limit' : 'invalid_stream');
    receipt.reason = reason; receipt.status = ['byte_limit', 'entry_limit'].includes(reason) ? 'truncated' : 'error';
  } finally {
    clearTimeout(timer); child?.kill('SIGKILL');
    if (exited) await settledWithin(exited.catch(() => {}), 1000);
    try {
      if (sourceIdentity) { const current = await lstat(sourceFile); if (current.ino === sourceIdentity.ino && current.dev === sourceIdentity.dev && !current.isSymbolicLink()) await unlink(sourceFile); }
      if (outputIdentity && !receipt.retained) await removeOwnedDirectory(output, outputIdentity);
    } catch { receipt.status = 'error'; receipt.reason = 'cleanup_failed'; }
    receipt.omittedCount = state.omittedCount; receipt.omittedEntries = state.omittedEntries;
  }
  await atomicJson(receiptPath, receipt);
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--send') {
  try { await streamSessionHome(process.stdout, { maxBytes: Number(process.argv[3]), maxEntries: Number(process.argv[4]) }); }
  catch (error) { process.stdout.write(`${JSON.stringify({ type: 'failure', reason: error.archiveReason ?? 'source_error' })}\n`); process.exitCode = 1; }
}
