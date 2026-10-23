import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';
import { removeOwnedDirectory } from './safe-export.mjs';

async function directoryBoundary(path) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  const identities = [];
  for (const name of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, name);
    const stat = await lstat(current).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Scratch cleanup encountered a symlink or non-directory boundary');
    identities.push({ path: current, ino: stat.ino, dev: stat.dev });
  }
  return identities;
}
async function unchangedBoundary(identities) {
  for (const expected of identities) {
    const stat = await lstat(expected.path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino !== expected.ino || stat.dev !== expected.dev) throw new Error('Scratch cleanup directory boundary changed');
  }
}

/** Remove only private materialization names after the attempt's containers stop. */
export async function cleanupAttemptScratch(home, prefix) {
  // Auxiliary mounts may be cleaned while their parent's materialization is
  // still active. Only the original attempt is allowed to collect that scratch.
  if (/^camp-mvp-run-[a-f0-9]{16}-aux-[a-f0-9]{16}-$/.test(prefix)) return;
  const match = /^camp-mvp-run-([a-f0-9]{16})-$/.exec(prefix);
  if (!match) throw new Error('Scratch cleanup requires an original attempt prefix');
  const folder = join(resolve(home), 'runs', match[1]);
  const boundary = await directoryBoundary(folder);
  if (!boundary) return;
  const snapshot = /^(?:verification-snapshot|integration-(?:base|left|right|result)|diff-(?:base|target)-(?:12|32)[a-f0-9]{64})$/;
  const manifest = /^(?:verification-snapshot|integration-(?:base|left|right|result)|diff-(?:base|target)-(?:12|32)[a-f0-9]{64})\.manifest\.json$/;
  const harness = /^harness-[a-z][a-z0-9_-]{0,63}$/;
  for (const name of await readdir(folder)) {
    if (!snapshot.test(name) && !manifest.test(name) && !harness.test(name)) continue;
    await unchangedBoundary(boundary);
    const path = join(folder, name), stat = await lstat(path);
    if (stat.isSymbolicLink() || (snapshot.test(name) ? !stat.isDirectory() : !stat.isFile())) throw new Error('Scratch cleanup encountered an unexpected private entry type');
    if (snapshot.test(name)) await removeOwnedDirectory(path, stat);
    else await unlink(path);
  }
}
