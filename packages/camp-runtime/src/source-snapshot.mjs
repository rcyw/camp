import { spawn } from 'node:child_process';
import { open, lstat, mkdir, readdir, realpath, readlink, symlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { exportMode, removeOwnedDirectory } from './safe-export.mjs';

const forbiddenDirectories = new Set(['.git', '.camp', '.dsh', '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.docker', 'node_modules']);
function gitProcess(source, args, signal, timeoutMs) {
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('Source Git deadline exceeded')), timeoutMs);
  // A local include.path can name a FIFO or endless device. Bound both elapsed
  // time and Git's own address space/CPU before parsing any repository config.
  const child = spawn('prlimit', ['--as=536870912', '--cpu=5', '--nofile=64:64', '--', 'git', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', source, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGKILL', signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
    env: { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  child.once('error', error => { clearTimeout(timer); if (deadline.signal.aborted && !signal?.aborted) error.code = 'source_git_timeout'; });
  child.once('close', () => clearTimeout(timer));
  return child;
}
export function permittedSourcePath(relative) {
  const parts = relative.split('/');
  return !parts.some(part => forbiddenDirectories.has(part) || part === '.env' || part.startsWith('.env.') || /^\.dev-env-.*\.json$/.test(part) || /^\.credentials(?:\.|$)/.test(part));
}
function sourceText(bytes) {
  try { return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('Source import requires UTF-8 file names and symlink targets'); }
}

async function gitFiles(source, signal, timeoutMs, maximum) {
  const child = gitProcess(source, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], signal, timeoutMs);
  child.stderr.resume();
  let failure;
  const finished = new Promise((resolveExit, reject) => { child.once('error', error => { failure = error; }); child.once('close', code => failure ? reject(failure) : resolveExit(code)); });
  finished.catch(() => {});
  let pending = Buffer.alloc(0), bytes = 0;
  const paths = [], maxPathBytes = 4096, maxSelectionBytes = Math.min(16 * 1024 ** 2, maximum * maxPathBytes);
  try {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > maxSelectionBytes) throw new Error('Git source selection exceeds its path byte budget');
      pending = Buffer.concat([pending, chunk]);
      let at;
      while ((at = pending.indexOf(0)) !== -1) {
        if (at > maxPathBytes || paths.length >= maximum) throw new Error('Git source selection exceeds its path or entry budget');
        const path = sourceText(pending.subarray(0, at)); pending = pending.subarray(at + 1);
        if (path) paths.push(path);
      }
      if (pending.length > maxPathBytes) throw new Error('Git source selection exceeds its path budget');
    }
    const code = await finished;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error('Git source selection failed; refusing a directory fallback');
    if (pending.length) throw new Error('Git source selection ended with an incomplete path');
    return paths;
  } finally { child.kill('SIGKILL'); await finished.catch(() => {}); }
}

async function gitResult(source, args, signal, timeoutMs) {
  const child = gitProcess(source, args, signal, timeoutMs);
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8192); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  let failure;
  const code = await new Promise((resolveExit, reject) => { child.once('error', error => { failure = error; }); child.once('close', code => failure ? reject(failure) : resolveExit(code)); });
  signal?.throwIfAborted(); return { code, stdout, stderr };
}
async function sourceSelection(source, signal, timeoutMs) {
  const repository = await gitResult(source, ['rev-parse', '--show-prefix'], signal, timeoutMs);
  if (repository.code !== 0) {
    if (repository.code === 128 && repository.stderr.includes('not a git repository')) return 'directory';
    throw new Error('Cannot determine source repository identity; refusing a directory fallback');
  }
  if (repository.stdout.trim()) {
    const ignored = await gitResult(source, ['check-ignore', '--quiet', '.'], signal, timeoutMs);
    if (ignored.code === 0) return 'directory';
    if (ignored.code !== 1) throw new Error('Git ignore lookup failed; refusing a directory fallback');
  }
  return 'git';
}
async function sourceEntry(root, relative, use) {
  // Linux dir-fd traversal anchors each parent before the next open. A source
  // edit cannot swap a validated directory for a link between check and read.
  const opened = [];
  let parent = root;
  try {
    const parts = relative.split('/');
    for (const part of parts.slice(0, -1)) {
      try { parent = await open(`/proc/self/fd/${parent.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) { if (['ELOOP', 'ENOTDIR'].includes(error.code)) throw new Error('Source import refuses a symlink or non-directory parent'); throw error; }
      opened.push(parent);
    }
    return await use(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`);
  } finally { for (const directory of opened.reverse()) await directory.close(); }
}

async function* directoryFiles(source, destination, scan, relative = '') {
  scan.signal?.throwIfAborted();
  for (const entry of await readdir(join(source, relative), { withFileTypes: true, encoding: 'buffer' })) {
    scan.signal?.throwIfAborted();
    const name = sourceText(entry.name), path = relative ? `${relative}/${name}` : name;
    if (resolve(source, path) === destination) continue;
    if (!permittedSourcePath(path)) continue;
    if (++scan.entries > scan.maximum) throw new Error('Source directory scan exceeds its entry budget');
    if (entry.isDirectory()) yield* directoryFiles(source, destination, scan, path);
    else yield path;
  }
}

/** Import a separate source-only seed; never mutate or directly snapshot a user's checkout. */
export async function stageSource(source, destination, { signal, maxBytes = 512 * 1024 ** 2, maxEntries = 20000, gitTimeoutMs = 10000 } = {}) {
  signal?.throwIfAborted();
  if (![maxBytes, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Source import requires positive bounded byte and entry limits');
  if (!Number.isSafeInteger(gitTimeoutMs) || gitTimeoutMs <= 0 || gitTimeoutMs > 30000) throw new Error('Source Git deadline must be a positive bounded integer');
  const original = await realpath(source);
  destination = resolve(destination);
  if (original === destination) throw new Error('Source and import seed must be different directories');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  // A partial or caller-provided seed can contain links. Never merge a new
  // source selection into it or overwrite an existing staging tree.
  await mkdir(destination, { mode: 0o700 });
  const identity = await lstat(destination);
  let root;
  try {
    root = await open(original, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let count = 0, bytes = 0;
    const entries = new Set(['']);
    const copied = new Set();
    const copy = async relative => {
      signal?.throwIfAborted();
      if (!relative || relative.startsWith('/') || relative.split('/').includes('..') || !permittedSourcePath(relative) || copied.has(relative)) return;
      const from = resolve(original, relative);
      if (from === destination || from.startsWith(`${destination}/`)) return;
      try { await sourceEntry(root, relative, async path => {
        const stat = await lstat(path);
        if (!stat.isFile() && !stat.isSymbolicLink()) return;
        let parent = '';
        for (const part of relative.split('/')) { parent = parent ? `${parent}/${part}` : part; entries.add(parent); }
        if (entries.size > maxEntries || stat.size > maxBytes - bytes) throw new Error('Source import exceeds its entry or byte budget');
        const to = join(destination, relative);
        await mkdir(dirname(to), { recursive: true });
        if (stat.isSymbolicLink()) { await symlink(sourceText(await readlink(path, { encoding: 'buffer' })), to); bytes += stat.size; }
        else {
          const mode = exportMode(stat.mode & 0o7777), input = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
          let output;
          try {
            const opened = await input.stat();
            if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Source file changed before import');
            output = await open(to, 'wx', 0o600);
            for await (const chunk of input.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
              signal?.throwIfAborted();
              if (chunk.length > maxBytes - bytes) throw new Error('Source import exceeds its byte budget');
              await output.writeFile(chunk); bytes += chunk.length;
            }
            await output.chmod(mode);
          } finally { await input.close(); await output?.close(); }
        }
        copied.add(relative); count++;
      }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
    };
    const selection = await sourceSelection(original, signal, gitTimeoutMs);
    // Finish the bounded subprocess before host copies begin. Its deadline
    // measures Git selection, never caller backpressure or source-file I/O.
    if (selection === 'git') for (const path of await gitFiles(original, signal, gitTimeoutMs, maxEntries)) await copy(path);
    // Explicit non-Git fixtures, including ignored demo folders, have no index.
    // An empty valid Git selection is authoritative; falling back in that case
    // would reintroduce files deliberately excluded by .gitignore.
    signal?.throwIfAborted();
    if (selection === 'directory') for await (const path of directoryFiles(original, destination, { entries: 0, maximum: maxEntries, signal })) await copy(path);
    signal?.throwIfAborted();
    return { sourcePath: original, importPath: destination, files: count, selection: 'source-only; known credential paths excluded' };
  } catch (error) {
    await removeOwnedDirectory(destination, identity);
    throw error;
  } finally { await root?.close(); }
}
