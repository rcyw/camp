import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CAMP_ARTIFACT_LIMITS, parsePrivateArtifactManifest, serializePrivateArtifactManifest, parseStorageBackupReceipt } from '../../camp-protocol/src/index.js';
import { atomicJson, privateDirectory, acquireWorkerLock } from './durable-state.mjs';

const fail = (message, code = 'camp_artifact_unsafe') => Object.assign(new Error(message), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parts = manifest => manifest.files.flatMap(file => file.parts.map((part, n) => ({ ...part, name: file.name, offset: n * CAMP_ARTIFACT_LIMITS.partBytes })));
const syncDir = async path => { const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); } };
async function privateFile(path, max) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > max || stat.size < 1) throw fail('Artifact files must be private owned bounded ordinary files');
    return { file, stat };
  } catch (error) { await file.close(); throw error; }
}
async function readPart(file, offset, bytes) {
  const buffer = Buffer.alloc(bytes); let done = 0;
  while (done < bytes) {
    const read = await file.read(buffer, done, bytes - done, offset + done);
    if (!read.bytesRead) throw fail('Artifact file changed during transfer');
    done += read.bytesRead;
  }
  return buffer;
}
async function transferState(path) {
  const saved = await privateFile(path, 4096);
  try { return JSON.parse(await readPart(saved.file, 0, saved.stat.size)); } finally { await saved.file.close(); }
}
async function cleanPublishedTransfer(work, state) {
  try { await lstat(work); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await privateDirectory(work);
  if (JSON.stringify(await transferState(join(work, 'transfer.json'))) !== JSON.stringify(state)) throw fail('Published target has an unrelated transfer journal; preserve it for inspection');
  await rm(work, { recursive: true }); await syncDir(dirname(work));
}
export async function describePrivateBundle(bundlePath, { signal } = {}) {
  await lstat(bundlePath); await privateDirectory(bundlePath);
  if (JSON.stringify((await readdir(bundlePath)).sort()) !== JSON.stringify(['manifest.json', 'project.record', 'store.sqlite'])) throw fail('Transfer requires exactly the three native backup files');
  const files = [];
  for (const [name, maximum] of [['manifest.json', 9 * 1024 ** 2], ['project.record', 65536], ['store.sqlite', CAMP_ARTIFACT_LIMITS.maxStoreBytes]]) {
    const { file, stat } = await privateFile(join(bundlePath, name), maximum);
    const digest = createHash('sha256'), chunks = [];
    try {
      for (let offset = 0; offset < stat.size; offset += CAMP_ARTIFACT_LIMITS.partBytes) {
        signal?.throwIfAborted();
        const bytes = await readPart(file, offset, Math.min(CAMP_ARTIFACT_LIMITS.partBytes, stat.size - offset));
        digest.update(bytes); chunks.push({ bytes: bytes.length, sha256: hash(bytes) });
      }
    } finally { await file.close(); }
    files.push({ name, bytes: stat.size, sha256: digest.digest('hex'), parts: chunks });
  }
  return parsePrivateArtifactManifest({ schemaVersion: 1, format: 'camp-native-store-v1', files });
}
export function bindArtifactReceipt(manifest, receipt) {
  const expected = parseStorageBackupReceipt(receipt), parsed = parsePrivateArtifactManifest(manifest);
  if (parsed.files[0].sha256 !== expected.manifestDigest || parsed.files[2].sha256 !== expected.storeSha256 || parsed.files[2].bytes !== expected.bytes) throw fail('Transfer differs from the immutable native backup receipt');
  return parsed;
}
function checkedArtifact(value, receipt, expectedId) {
  if (!value || value.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || expectedId && value.id !== expectedId || !['uploading', 'ready'].includes(value.state)) throw fail('Invalid private artifact response');
  const manifest = bindArtifactReceipt(value.manifest, receipt), manifestDigest = hash(serializePrivateArtifactManifest(manifest));
  if (manifestDigest !== value.manifestDigest || !Array.isArray(value.received) || value.received.some(index => !Number.isSafeInteger(index) || index < 0 || index >= parts(manifest).length) || new Set(value.received).size !== value.received.length) throw fail('Private artifact response changed its immutable content');
  return { ...value, manifest };
}
/** Origin-only requests, no redirects, no signed URLs or credentials in the
 * resume journal. Transport is separate from Worker/model execution. */
export function privateArtifactRequest(env = process.env) {
  const url = new URL(env.CAMP_API_URL ?? 'http://127.0.0.1:3018');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !env.CAMP_WORKER_TOKEN) throw fail('Configure a Camp API origin and private Room worker token');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && env.CAMP_ALLOW_INSECURE_TRANSPORT !== '1') throw fail('Remote private transfer requires HTTPS');
  return async (path, { method = 'GET', body, signal, binary = false, expectedBytes } = {}) => {
    const response = await fetch(`${url.origin}/api/camp/worker${path}`, { method, redirect: 'error', headers: { authorization: `Bearer ${env.CAMP_WORKER_TOKEN}`, ...(body ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}) }, ...(body ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
    if (!response.ok) {
      let code; const chunks = []; let size = 0;
      try {
        for await (const chunk of response.body) { size += chunk.length; if (size > 16384) break; chunks.push(Buffer.from(chunk)); }
        if (size <= 16384) { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (/^[a-z_]{1,80}$/.test(value.code ?? '')) code = value.code; }
      } catch { /* Error diagnostics never expose response text or credentials. */ }
      throw Object.assign(fail(`Private transfer rejected (HTTP ${response.status}${code ? `, ${code}` : ''})`, code ?? 'camp_artifact_http'), { status: response.status });
    }
    const maximum = binary ? expectedBytes : CAMP_ARTIFACT_LIMITS.maxManifestBytes + 65536;
    let size = 0; const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maximum) { await response.body.cancel().catch(() => {}); throw fail('Artifact response exceeded its byte budget'); }
      chunks.push(Buffer.from(chunk));
    }
    if (binary && size !== expectedBytes) throw fail('Artifact response ended before its exact part length');
    const bytes = Buffer.concat(chunks, size);
    return binary ? bytes : JSON.parse(bytes.toString('utf8'));
  };
}
export async function uploadPrivateBundle({ request, operationId, receipt, bundlePath, signal, onProgress = () => {} }) {
  const manifest = bindArtifactReceipt(await describePrivateBundle(bundlePath, { signal }), receipt);
  const prefix = `/storage-operations/${operationId}`;
  let artifact = checkedArtifact(await request(`${prefix}/artifact`, { method: 'POST', body: manifest, signal }), receipt);
  if (artifact.manifestDigest !== hash(serializePrivateArtifactManifest(manifest))) throw fail('The server accepted another transfer manifest');
  const received = new Set(artifact.received);
  for (const [index, part] of parts(manifest).entries()) {
    signal?.throwIfAborted(); if (received.has(index)) continue;
    const { file } = await privateFile(join(bundlePath, part.name), CAMP_ARTIFACT_LIMITS.maxStoreBytes);
    let bytes; try { bytes = await readPart(file, part.offset, part.bytes); } finally { await file.close(); }
    if (hash(bytes) !== part.sha256) throw fail('Local bundle changed after reservation');
    await request(`${prefix}/artifacts/${artifact.id}/parts/${index}`, { method: 'PUT', body: bytes, signal });
    onProgress({ artifactId: artifact.id, receivedParts: index + 1, totalParts: parts(manifest).length });
  }
  artifact = checkedArtifact(await request(`${prefix}/artifacts/${artifact.id}/seal`, { method: 'POST', body: {}, signal }), receipt, artifact.id);
  if (artifact.state !== 'ready') throw fail('The transfer did not seal');
  return artifact;
}
export async function downloadPrivateBundle(options) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const lock = await acquireWorkerLock(`artifact-download:${resolve(options.bundlePath)}`, { signal, onLost: error => controller.abort(error) });
  try { return await downloadBundle({ ...options, signal }); } finally { await lock.release(); }
}
async function downloadBundle({ request, operationId, receipt, bundlePath, signal, onProgress = () => {} }) {
  const prefix = `/storage-operations/${operationId}`;
  const artifact = checkedArtifact(await request(`${prefix}/artifact`, { signal }), receipt);
  if (artifact.state !== 'ready') throw fail('Wait for the native backup transfer to seal');
  const target = resolve(bundlePath), parent = await realpath(dirname(target));
  if (join(parent, basename(target)) !== target) throw fail('Download requires a canonical local parent');
  const work = `${target}.transfer-${artifact.id}`;
  const state = { schemaVersion: 1, artifactId: artifact.id, manifestDigest: artifact.manifestDigest };
  let targetExists = false;
  try { await lstat(target); targetExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (targetExists) {
    if (hash(serializePrivateArtifactManifest(await describePrivateBundle(target, { signal }))) !== artifact.manifestDigest) throw fail('Existing target differs from the immutable artifact');
    await cleanPublishedTransfer(work, state);
    return artifact;
  }
  await privateDirectory(work); await privateDirectory(join(work, 'parts'));
  try {
    const stored = await transferState(join(work, 'transfer.json'));
    if (JSON.stringify(stored) !== JSON.stringify(state)) throw fail('Download journal belongs to another immutable artifact');
  } catch (error) { if (error.code !== 'ENOENT') throw error; await atomicJson(join(work, 'transfer.json'), state); }
  for (const [index, part] of parts(artifact.manifest).entries()) {
    signal?.throwIfAborted(); const path = join(work, 'parts', String(index)); let existing = false;
    try {
      const { file } = await privateFile(path, part.bytes);
      try { const bytes = await readPart(file, 0, part.bytes); if (bytes.length === part.bytes && hash(bytes) === part.sha256) existing = true; } finally { await file.close(); }
      if (!existing) throw fail('Resumed download part failed its digest check');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!existing) {
      const bytes = await request(`${prefix}/artifacts/${artifact.id}/parts/${index}`, { binary: true, expectedBytes: part.bytes, signal });
      if (hash(bytes) !== part.sha256) throw fail('Received artifact part failed its digest check');
      const temporary = path + '.partial'; await rm(temporary, { force: true });
      const file = await open(temporary, 'wx', 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path); await syncDir(join(work, 'parts'));
    }
    onProgress({ artifactId: artifact.id, receivedParts: index + 1, totalParts: parts(artifact.manifest).length });
  }
  const assembled = join(work, 'bundle'); await privateDirectory(assembled);
  let index = 0;
  for (const descriptor of artifact.manifest.files) {
    signal?.throwIfAborted(); const path = join(assembled, descriptor.name);
    await rm(path, { force: true }); const file = await open(path, 'wx', 0o600), digest = createHash('sha256');
    try {
      for (const part of descriptor.parts) {
        const source = await privateFile(join(work, 'parts', String(index++)), part.bytes);
        let bytes; try { bytes = await readPart(source.file, 0, part.bytes); } finally { await source.file.close(); }
        if (bytes.length !== part.bytes || hash(bytes) !== part.sha256) throw fail('Private download part changed before assembly');
        digest.update(bytes); await file.writeFile(bytes);
      }
      if (digest.digest('hex') !== descriptor.sha256) throw fail('Downloaded file failed its complete digest check');
      await file.sync();
    } finally { await file.close(); }
  }
  await syncDir(assembled); signal?.throwIfAborted();
  await rename(assembled, target); await syncDir(parent);
  await rm(work, { recursive: true });
  return artifact;
}
