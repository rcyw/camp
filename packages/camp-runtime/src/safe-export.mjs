import { constants } from 'node:fs';
import { open, mkdir, chmod, symlink, lstat, rm, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';

const limitExceeded = message => Object.assign(new Error(message), { code: 'camp_snapshot_limit_exceeded' });

export function exportPath(path) {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Export entry has an unsafe path');
  return path;
}
export function exportMode(mode) {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777 || (mode & 0o6000)) throw new Error('Export refuses invalid or privileged permission bits');
  return mode;
}
export function exportLink(path, target) {
  if (typeof target !== 'string' || !target || target.includes('\0') || target.includes('\\') || posix.isAbsolute(target)) throw new Error('Export refuses an absolute or invalid symlink');
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) throw new Error('Export symlink escapes the output tree');
  return target;
}
async function* frames(stream) {
  stream.setEncoding('utf8');
  let pending = '';
  for await (const chunk of stream) {
    pending += chunk;
    let at;
    while ((at = pending.indexOf('\n')) >= 0) {
      if (at > 1024 * 1024) throw new Error('Export frame exceeds its size limit');
      yield JSON.parse(pending.slice(0, at));
      pending = pending.slice(at + 1);
    }
    if (pending.length > 1024 * 1024) throw new Error('Export frame exceeds its size limit');
  }
  if (pending) throw new Error('Export stream ended with a partial frame');
}

/** Materialize only validated entries in a new caller-owned empty directory. */
export async function receiveSnapshot(stream, directory, { maxBytes = 100 * 1024 ** 3, maxEntries = 1_000_000, allowUnsafeLinks = false } = {}) {
  const seen = new Map([['', 'directory']]);
  const directories = [], links = [];
  const counts = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  let rootMode, ended = false, file;
  try {
    for await (const frame of frames(stream)) {
      if (ended) throw new Error('Export stream contains data after completion');
      if (frame.type === 'root') {
        if (rootMode !== undefined || seen.size !== 1) throw new Error('Duplicate export root');
        rootMode = exportMode(frame.mode);
      } else if (frame.type === 'data') {
        if (!file || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('Invalid export file data');
        const bytes = Buffer.from(frame.data, 'base64');
        if (file.received + bytes.length > file.size) throw new Error('Export exceeds its declared file size');
        if (counts.bytes + bytes.length > maxBytes) throw limitExceeded('Export exceeds its byte budget');
        await file.handle.writeFile(bytes);
        file.received += bytes.length;
        counts.bytes += bytes.length;
      } else if (frame.type === 'file_end') {
        if (!file || file.received !== file.size) throw new Error('Export file length does not match its header');
        await file.handle.chmod(file.mode);
        await file.handle.close();
        file = null;
      } else if (frame.type === 'end') {
        if (file || rootMode === undefined) throw new Error('Export completed before its file or root');
        ended = true;
      } else {
        if (file || rootMode === undefined) throw new Error('Export entry is out of order');
        const path = exportPath(frame.path);
        if (seen.has(path) || seen.get(posix.dirname(path) === '.' ? '' : posix.dirname(path)) !== 'directory') throw new Error('Export entry has a duplicate or unsafe parent');
        if (seen.size > maxEntries) throw limitExceeded('Export exceeds its entry budget');
        const mode = exportMode(frame.mode);
        const target = join(directory, path);
        if (frame.type === 'directory') {
          await mkdir(target, { mode: 0o700 });
          directories.push({ target, mode });
          counts.directories++;
        } else if (frame.type === 'file') {
          if (!Number.isSafeInteger(frame.size) || frame.size < 0) throw new Error('Export file size is invalid');
          if (frame.size > maxBytes - counts.bytes) throw limitExceeded('Export file size exceeds its byte budget');
          const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          file = { handle, size: frame.size, received: 0, mode };
          counts.files++;
        } else if (frame.type === 'symlink') {
          const link = allowUnsafeLinks && typeof frame.target === 'string' && frame.target && !frame.target.includes('\0') ? frame.target : exportLink(path, frame.target);
          links.push({ target, link }); counts.symlinks++;
        }
        else throw new Error('Export contains an unsupported entry');
        seen.set(path, frame.type);
      }
    }
    if (!ended) throw new Error('Export stream ended before its completion marker');
    // Links are created last so no subsequent file operation can follow them.
    for (const link of links) await symlink(link.link, link.target);
    for (const entry of directories.reverse()) await chmod(entry.target, entry.mode);
    await chmod(directory, rootMode);
    return counts;
  } finally { await file?.handle.close(); }
}

export async function removeOwnedDirectory(path, identity) {
  const current = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (current && current.ino === identity.ino && current.dev === identity.dev && current.isDirectory() && !current.isSymbolicLink()) {
    const unlock = async directory => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await unlock(join(directory, entry.name));
    };
    await unlock(path);
    await rm(path, { recursive: true, force: true });
  }
}
