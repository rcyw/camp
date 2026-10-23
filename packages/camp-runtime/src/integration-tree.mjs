import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { exportPath, exportMode } from './safe-export.mjs';

export const integrationTreeLimits = Object.freeze({ maxEntries: 20000, maxBytes: 512 * 1024 ** 2 });
const order = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const treeDigest = entries => createHash('sha256').update(JSON.stringify([...entries].sort(([a], [b]) => order(a, b)))).digest('hex');
const unsupported = path => Object.assign(new Error('Integration snapshot exceeds its supported filesystem contract'), { code: 'camp_integration_unsupported', path });

/** Complete private snapshot facts, never the bounded display Diff or project code. */
export async function inventoryIntegrationTree(directory, { signal, limits = integrationTreeLimits } = {}) {
  const entries = new Map(); let bytes = 0;
  async function walk(path = '.') {
    signal?.throwIfAborted();
    if (entries.size >= limits.maxEntries) throw unsupported(path);
    const full = path === '.' ? directory : join(directory, exportPath(path));
    const before = await lstat(full);
    let mode; try { mode = exportMode(before.mode & 0o7777); } catch { throw unsupported(path); }
    let value;
    if (before.isDirectory()) value = { type: 'directory', mode, size: 0 };
    else if (before.isSymbolicLink()) {
      const raw = await readlink(full, { encoding: 'buffer' }), target = raw.toString('utf8');
      if (!Buffer.from(target).equals(raw)) throw unsupported(path);
      value = { type: 'symlink', mode, size: raw.length, target };
    } else if (before.isFile()) {
      if (before.size > limits.maxBytes - bytes) throw unsupported(path);
      const file = await open(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const actual = await file.stat();
        if (!actual.isFile() || actual.ino !== before.ino || actual.dev !== before.dev) throw unsupported(path);
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
          signal?.throwIfAborted(); size += chunk.length; bytes += chunk.length;
          if (bytes > limits.maxBytes) throw unsupported(path);
          hash.update(chunk);
        }
        if (size !== before.size) throw unsupported(path);
        value = { type: 'file', mode, size, sha256: hash.digest('hex') };
      } finally { await file.close(); }
    } else throw unsupported(path);
    entries.set(path, value);
    if (value.type === 'directory') for (const raw of (await readdir(full, { encoding: 'buffer' })).sort(Buffer.compare)) {
      const name = raw.toString('utf8');
      if (!Buffer.from(name).equals(raw)) throw unsupported(path);
      await walk(path === '.' ? name : `${path}/${name}`);
    }
  }
  await walk();
  return entries;
}
function changes(base, target) {
  return new Map([...new Set([...base.keys(), ...target.keys()])].filter(path => !same(base.get(path), target.get(path))).map(path => [path, target.get(path) ?? null]));
}

/** reject-overlap-v1 deliberately refuses even identical dual writes. */
export function planIntegrationTree(base, left, right, limits = integrationTreeLimits) {
  const conflicts = new Map();
  const add = (path, reason) => { if (!conflicts.has(path)) conflicts.set(path, { path, reason }); };
  for (const tree of [base, left, right]) for (const path of tree.keys()) if (path.split('/').includes('.lww')) add(path, 'policy_path');
  if (conflicts.size) return { status: 'rejected', conflicts: [...conflicts.values()].sort((a, b) => order(a.path, b.path)) };
  const a = changes(base, left), b = changes(base, right);
  for (const [path, after] of a) {
    if (b.has(path)) add(path, after === null || b.get(path) === null ? 'delete_modify' : after.type !== b.get(path).type ? 'structural' : 'overlap');
  }
  // Look up ancestors rather than comparing every changed path pair. A
  // 20,000-entry admission bound must not become 400 million comparisons.
  for (const [delta, other] of [[a, b], [b, a]]) for (const [path, value] of delta) {
    let parent = path;
    while (parent !== '.') {
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '.';
      if (other.has(parent)) add(parent, value === null || other.get(parent) === null ? 'delete_modify' : 'structural');
    }
  }
  if (conflicts.size) return { status: 'conflict', conflicts: [...conflicts.values()].sort((a, b) => order(a.path, b.path)) };
  const expected = new Map(base);
  for (const delta of [a, b]) for (const [path, value] of delta) {
    if (value === null) expected.delete(path); else expected.set(path, value);
  }
  let bytes = 0;
  for (const [path, value] of expected) {
    if (path !== '.' && expected.get(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')?.type !== 'directory') add(path, 'structural');
    if (value.type === 'file') bytes += value.size;
  }
  if (expected.size > limits.maxEntries || bytes > limits.maxBytes) add('.', 'unsupported');
  if (conflicts.size) return { status: 'rejected', conflicts: [...conflicts.values()].sort((a, b) => order(a.path, b.path)) };
  return { status: 'ready', expected, expectedDigest: treeDigest(expected), changes: [a.size, b.size] };
}
export function compareIntegrationTree(expected, actual) {
  return [...new Set([...expected.keys(), ...actual.keys()])].sort(order).filter(path => !same(expected.get(path), actual.get(path))).map(path => ({ path, reason: 'structural' }));
}
