import { createHash } from 'node:crypto';
import { open, lstat, readdir, readlink, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseCandidate, CAMP_CHANGE_LIMITS } from '../../camp-protocol/src/index.js';
import { exportPath, removeOwnedDirectory } from './safe-export.mjs';
import { materializeCandidate } from './export.mjs';

async function scan(directory, signal) {
  const entries = new Map();
  const walk = async (path = '.') => {
    signal?.throwIfAborted();
    if (entries.size >= 20000) throw new Error('Snapshot metadata scan exceeds its entry budget');
    const full = path === '.' ? directory : join(directory, exportPath(path));
    const stat = await lstat(full);
    const mode = stat.mode & 0o7777;
    let value;
    if (stat.isDirectory()) value = { type: 'directory', mode, size: 0 };
    else if (stat.isSymbolicLink()) {
      const bytes = await readlink(full, { encoding: 'buffer' }), target = bytes.toString('utf8');
      if (!Buffer.from(target).equals(bytes)) throw new Error('Diff requires UTF-8 symlink targets');
      value = { type: 'symlink', mode, size: stat.size, target };
    }
    else if (stat.isFile()) {
      const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      const hash = createHash('sha256');
      let binary = false, size = 0;
      const decoder = new TextDecoder('utf8', { fatal: true });
      try {
        const current = await file.stat();
        if (current.ino !== stat.ino || current.dev !== stat.dev || !current.isFile()) throw new Error('Snapshot changed during metadata scan');
        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
          signal?.throwIfAborted(); size += chunk.length; hash.update(chunk);
          if (chunk.includes(0)) binary = true;
          if (!binary) try { decoder.decode(chunk, { stream: true }); } catch { binary = true; }
        }
        if (!binary) try { decoder.decode(); } catch { binary = true; }
        if (size !== stat.size) throw new Error('Snapshot file size changed during metadata scan');
      } finally { await file.close(); }
      value = { type: 'file', mode, size, sha256: hash.digest('hex') };
      entries.set(path, { value, binary, full });
      return;
    } else throw new Error('Snapshot contains an unsupported special entry');
    entries.set(path, { value, binary: false, full });
    if (value.type === 'directory') {
      const names = (await readdir(full, { encoding: 'buffer' })).sort(Buffer.compare);
      for (const bytes of names) {
        const name = bytes.toString('utf8');
        if (!Buffer.from(name).equals(bytes)) throw new Error('Diff requires UTF-8 file names');
        await walk(path === '.' ? name : `${path}/${name}`);
      }
    }
  };
  await walk();
  return entries;
}
function utf8Prefix(bytes) {
  for (let trim = 0; trim <= 4; trim++) {
    try { return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, Math.max(0, bytes.length - trim))); } catch {}
  }
  return '';
}
async function patch(left, right, path, maximum, signal) {
  const child = spawn('diff', ['--unified=3', '--label', left ? `a/${path}` : '/dev/null', '--label', right ? `b/${path}` : '/dev/null', '--', left?.full ?? '/dev/null', right?.full ?? '/dev/null'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, signal });
  const chunks = []; let length = 0, truncated = false, stderr = '';
  const timeout = setTimeout(() => { truncated = true; child.kill('SIGKILL'); }, 2000);
  child.stdout.on('data', bytes => {
    const remaining = Math.max(0, maximum - length);
    if (remaining) { const kept = bytes.subarray(0, remaining); chunks.push(kept); length += kept.length; }
    if (bytes.length > remaining) { truncated = true; child.kill('SIGKILL'); }
  });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-1000); });
  try {
    await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 || code === 1 || truncated ? resolveExit() : reject(new Error(`Trusted diff failed: ${stderr || code}`)));
    });
    return { text: utf8Prefix(Buffer.concat(chunks)), truncated };
  } finally { clearTimeout(timeout); child.kill('SIGKILL'); }
}

/** Compares two private immutable materializations; never executes project code. */
export async function compareSnapshotDirectories({ base, target, beforeDirectory, afterDirectory, limits = CAMP_CHANGE_LIMITS, signal }) {
  base = parseCandidate(base); target = parseCandidate(target, { projectId: base.projectId, imageId: base.imageId });
  const before = await scan(beforeDirectory, signal), after = await scan(afterDirectory, signal);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const report = { schemaVersion: 1, base, target, entries: [], truncated: false, stats: { added: 0, modified: 0, deleted: 0, typeChanged: 0 } };
  let patchBytes = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const l = before.get(path), r = after.get(path), a = l?.value ?? null, b = r?.value ?? null;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const change = !a ? 'added' : !b ? 'deleted' : a.type !== b.type ? 'type_changed' : 'modified';
    report.stats[change === 'type_changed' ? 'typeChanged' : change]++;
    if (report.entries.length >= limits.maxEntries) { report.truncated = true; continue; }
    const binary = Boolean(l?.binary || r?.binary);
    const entry = { path, change, before: a, after: b, binary, modeChanged: Boolean(a && b && a.mode !== b.mode), patch: null, patchTruncated: false, previewReason: null };
    const filePair = (!a || a.type === 'file') && (!b || b.type === 'file');
    if (!filePair || path === '.') entry.previewReason = change === 'type_changed' ? 'type_changed' : 'non_text_entry';
    else if (binary) entry.previewReason = 'binary';
    else if (a?.sha256 === b?.sha256) entry.previewReason = 'metadata_only';
    else if ((a?.size ?? 0) + (b?.size ?? 0) > 512 * 1024) { entry.patchTruncated = true; entry.previewReason = 'text_input_limit'; }
    else {
      const maximum = Math.min(limits.maxPatchBytes, limits.maxTotalPatchBytes - patchBytes);
      if (maximum <= 0) { entry.patchTruncated = true; entry.previewReason = 'total_patch_limit'; }
      else {
        const result = await patch(l, r, path, maximum, signal);
        entry.patch = result.text || null; entry.patchTruncated = result.truncated;
        if (result.truncated) entry.previewReason = 'patch_limit';
        patchBytes += Buffer.byteLength(entry.patch ?? '');
      }
    }
    report.entries.push(entry);
  }
  while (Buffer.byteLength(JSON.stringify(report)) > limits.maxPayloadBytes && report.entries.length) { report.entries.pop(); report.truncated = true; }
  if (Buffer.byteLength(JSON.stringify(report)) > limits.maxPayloadBytes) throw new Error('Diff identity exceeds its payload budget');
  return report;
}

export async function createChangeSet({ runtime, ownerRun, base, target, signal }) {
  base = parseCandidate(base);
  target = parseCandidate(target, { projectId: base.projectId, imageId: base.imageId });
  await mkdir(ownerRun.folder, { recursive: true, mode: 0o700 });
  const beforeDirectory = join(ownerRun.folder, `diff-base-${base.refId}`), afterDirectory = join(ownerRun.folder, `diff-target-${target.refId}`);
  const owned = [];
  try {
    for (const [candidate, output] of [[base, beforeDirectory], [target, afterDirectory]]) {
      await materializeCandidate({ runtime, candidate, ownerRun, output, signal });
      owned.push({ output, identity: await lstat(output) });
    }
    return await compareSnapshotDirectories({ base, target, beforeDirectory, afterDirectory, signal });
  } finally {
    for (const { output, identity } of owned) { await removeOwnedDirectory(output, identity); await rm(`${output}.manifest.json`, { force: true }); }
  }
}
