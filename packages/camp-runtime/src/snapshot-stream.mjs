// Trusted code run in a fresh export-only sandbox. Never import project code.
import { readdir, lstat, open, readlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function streamSnapshot(root, output = process.stdout, signal) {
const emit = async value => { signal?.throwIfAborted(); if (!output.write(`${JSON.stringify(value)}\n`)) await once(output, 'drain', { signal }); };
await emit({ type: 'root', mode: (await lstat(root)).mode & 0o7777 });
async function walk(relative = '') {
  for (const bytes of (await readdir(join(root, relative), { encoding: 'buffer' })).sort(Buffer.compare)) {
    const name = bytes.toString('utf8');
    if (!Buffer.from(name).equals(bytes)) throw new Error('Export requires UTF-8 file names');
    const path = relative ? `${relative}/${name}` : name;
    const source = join(root, path);
    const stat = await lstat(source);
    const mode = stat.mode & 0o7777;
    if (stat.isDirectory()) { await emit({ type: 'directory', path, mode }); await walk(path); }
    else if (stat.isSymbolicLink()) {
      const bytes = await readlink(source, { encoding: 'buffer' }), target = bytes.toString('utf8');
      if (!Buffer.from(target).equals(bytes)) throw new Error('Export requires UTF-8 symlink targets');
      await emit({ type: 'symlink', path, mode, target });
    }
    else if (stat.isFile()) {
      const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await file.stat();
        if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isFile()) throw new Error('Export source changed while opening');
        await emit({ type: 'file', path, mode, size: current.size });
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) await emit({ type: 'data', data: chunk.toString('base64') });
        await emit({ type: 'file_end' });
      } finally { await file.close(); }
    } else throw new Error('Export refuses special filesystem entries');
  }
}
await walk();
await emit({ type: 'end' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!/^\/workspaces\/[0-9]+$/.test(root ?? '')) throw new Error('Invalid export workspace');
  await streamSnapshot(root);
}
