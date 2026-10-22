import { spawn } from 'node:child_process';
import { cp, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const forbiddenDirectories = new Set(['.git', '.camp', '.dsh', '.codex', '.ssh', '.aws', '.azure', '.gnupg', '.docker', 'node_modules']);
export function permittedSourcePath(relative) {
  const parts = relative.split('/');
  return !parts.some(part => forbiddenDirectories.has(part) || part === '.env' || part.startsWith('.env.') || /^\.dev-env-.*\.json$/.test(part) || /^\.credentials(?:\.|$)/.test(part));
}

async function* gitFiles(source) {
  const child = spawn('git', ['-C', source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.setEncoding('utf8');
  const finished = new Promise(resolve => { child.once('error', () => resolve(128)); child.once('exit', resolve); });
  let pending = '';
  for await (const chunk of child.stdout) {
    pending += chunk;
    let at;
    while ((at = pending.indexOf('\0')) !== -1) { const path = pending.slice(0, at); pending = pending.slice(at + 1); if (path) yield path; }
  }
  if (await finished !== 0) return;
}

async function* directoryFiles(source, destination, relative = '') {
  for (const entry of await readdir(join(source, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (resolve(source, path) === destination) continue;
    if (!permittedSourcePath(path)) continue;
    if (entry.isDirectory()) yield* directoryFiles(source, destination, path);
    else yield path;
  }
}

/** Import a separate source-only seed; never mutate or directly snapshot a user's checkout. */
export async function stageSource(source, destination) {
  const original = await realpath(source);
  destination = resolve(destination);
  if (original === destination) throw new Error('Source and import seed must be different directories');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  let count = 0;
  const copied = new Set();
  const copy = async relative => {
    if (!relative || relative.startsWith('/') || relative.split('/').includes('..') || !permittedSourcePath(relative) || copied.has(relative)) return;
    const from = resolve(original, relative);
    if (from === destination || from.startsWith(`${destination}/`)) return;
    let stat;
    try { stat = await lstat(from); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isFile() && !stat.isSymbolicLink()) return;
    const to = join(destination, relative);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { dereference: false, verbatimSymlinks: true });
    copied.add(relative);
    count++;
  };
  for await (const path of gitFiles(original)) await copy(path);
  // Explicit non-Git fixtures, including ignored demo folders, have no index.
  if (count === 0) for await (const path of directoryFiles(original, destination)) await copy(path);
  return { sourcePath: original, importPath: destination, files: count, selection: 'source-only; known credential paths excluded' };
}
