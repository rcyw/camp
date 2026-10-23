import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describePrivateBundle, bindArtifactReceipt, privateArtifactRequest, uploadPrivateBundle, downloadPrivateBundle } from '../src/private-artifacts.mjs';
import { serializePrivateArtifactManifest, CAMP_ARTIFACT_LIMITS } from '../../camp-protocol/src/index.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'camp-artifact-test-')), source = join(home, 'source');
  await mkdir(source, { mode: 0o700 });
  for (const [name, bytes] of [['manifest.json', Buffer.from('{"format":"test-only"}')], ['project.record', Buffer.from('opaque discovery')], ['store.sqlite', Buffer.alloc(CAMP_ARTIFACT_LIMITS.partBytes + 73, 42)]]) await writeFile(join(source, name), bytes, { mode: 0o600 });
  const manifest = await describePrivateBundle(source);
  const receipt = { schemaVersion: 1, operationId: '11111111-1111-4111-8111-111111111111', manifestDigest: manifest.files[0].sha256, storeSha256: manifest.files[2].sha256, bytes: manifest.files[2].bytes, toolchainDigest: 'd'.repeat(64), imageId: `sha256:${'e'.repeat(64)}`, sourceStorageId: 'a'.repeat(64), candidateCount: 1, stopped: true, verified: true };
  const artifact = { schemaVersion: 1, id: '22222222-2222-4222-8222-222222222222', state: 'uploading', manifestDigest: hash(serializePrivateArtifactManifest(manifest)), manifest, received: [] };
  const objects = new Map(), calls = [], failures = { upload: null, download: null, corrupt: null };
  const descriptors = manifest.files.flatMap(file => file.parts);
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET' });
    if (path.endsWith('/seal')) { assert.equal(objects.size, descriptors.length); artifact.state = 'ready'; return structuredClone(artifact); }
    if (path.endsWith('/artifact')) return structuredClone(artifact);
    const index = Number(path.split('/').at(-1));
    if (options.method === 'PUT') {
      assert.equal(hash(options.body), descriptors[index].sha256);
      objects.set(index, Buffer.from(options.body)); artifact.received = [...objects.keys()];
      if (failures.upload === index) { failures.upload = null; throw new Error('Lost upload ACK'); }
      return { received: index };
    }
    if (failures.download === index) { failures.download = null; throw new Error('Interrupted download'); }
    if (failures.corrupt === index) return Buffer.alloc(descriptors[index].bytes, 7);
    return Buffer.from(objects.get(index));
  };
  return { home, source, manifest, receipt, artifact, request, calls, failures };
}
test('upload resumes an acknowledged part after a lost response and seals immutable bytes', async () => {
  const f = await fixture(); f.failures.upload = 1;
  const input = { request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: f.source };
  await assert.rejects(uploadPrivateBundle(input), /Lost upload ACK/);
  const done = await uploadPrivateBundle(input); assert.equal(done.state, 'ready');
  assert.equal(f.calls.filter(call => call.method === 'PUT' && call.path.endsWith('/1')).length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/seal')).length, 1);
});
test('download resumes verified private chunks and atomically publishes exactly the native bundle', async () => {
  const f = await fixture(); await uploadPrivateBundle({ request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: f.source });
  const target = join(f.home, 'target'), input = { request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: target };
  f.failures.download = 2; await assert.rejects(downloadPrivateBundle(input), /Interrupted download/);
  await assert.rejects(readFile(join(target, 'manifest.json')), { code: 'ENOENT' });
  await downloadPrivateBundle(input);
  assert.deepEqual((await readdir(target)).sort(), ['manifest.json', 'project.record', 'store.sqlite']);
  for (const file of f.manifest.files) assert.deepEqual(await readFile(join(target, file.name)), await readFile(join(f.source, file.name)));
  assert.equal(f.calls.filter(call => call.method === 'GET' && call.path.endsWith('/0')).length, 1);
  const before = f.calls.length; await downloadPrivateBundle(input); assert.equal(f.calls.length, before + 1, 'Identical published target verifies locally without redownloading parts');
});
test('corrupted downloads never become a bundle and changed backup identity is rejected', async () => {
  const f = await fixture(); await uploadPrivateBundle({ request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: f.source });
  f.failures.corrupt = 1;
  await assert.rejects(downloadPrivateBundle({ request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: join(f.home, 'bad') }), /digest/);
  await assert.rejects(readFile(join(f.home, 'bad', 'manifest.json')), { code: 'ENOENT' });
  assert.throws(() => bindArtifactReceipt(f.manifest, { ...f.receipt, storeSha256: 'f'.repeat(64) }), /differs/);
});
test('transport rejects public/linked files and does not overwrite an existing destination', async () => {
  const f = await fixture(); await chmod(join(f.source, 'project.record'), 0o644);
  await assert.rejects(describePrivateBundle(f.source), /private owned/); await chmod(join(f.source, 'project.record'), 0o600);
  await symlink(f.source, join(f.home, 'linked')); await assert.rejects(describePrivateBundle(join(f.home, 'linked')), /without symlinks/);
  await uploadPrivateBundle({ request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: f.source });
  const target = join(f.home, 'existing'); await mkdir(target, { mode: 0o700 }); await writeFile(join(target, 'keep.txt'), 'preserve');
  await assert.rejects(downloadPrivateBundle({ request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: target }), /exactly/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'preserve');
});
test('remote private transfer requires HTTPS and cannot redirect credentials', () => {
  for (const origin of ['http://worker.example', 'https://u:p@worker.example', 'https://worker.example/path', 'https://worker.example/?secret=1']) assert.throws(() => privateArtifactRequest({ CAMP_API_URL: origin, CAMP_WORKER_TOKEN: 'private' }));
  assert.equal(typeof privateArtifactRequest({ CAMP_API_URL: 'https://camp.example', CAMP_WORKER_TOKEN: 'private' }), 'function');
  assert.equal(typeof privateArtifactRequest({ CAMP_API_URL: 'http://127.0.0.1:13018', CAMP_WORKER_TOKEN: 'private' }), 'function');
});
test('HTTP transfer preserves bounded business error codes and never forwards a Room credential on redirects', async () => {
  let forwarded = 0, expectedAuthorization;
  const destination = createServer((_req, res) => { forwarded++; res.end('{}'); });
  await new Promise(resolveListen => destination.listen(0, '127.0.0.1', resolveListen));
  const source = createServer((req, res) => {
    expectedAuthorization = req.headers.authorization;
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/stolen` }); res.end(); }
    else if (req.url.endsWith('/oversized')) { res.writeHead(503); res.end(Buffer.alloc(20000, 120)); }
    else { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'artifact_storage_unavailable', error: 'Untrusted diagnostic text must stay private' })); }
  });
  await new Promise(resolveListen => source.listen(0, '127.0.0.1', resolveListen));
  try {
    const request = privateArtifactRequest({ CAMP_API_URL: `http://127.0.0.1:${source.address().port}`, CAMP_WORKER_TOKEN: 'fixture-private-room' });
    await assert.rejects(request('/fail'), error => error.code === 'artifact_storage_unavailable' && error.status === 503 && !error.message.includes('Untrusted'));
    await assert.rejects(request('/oversized'), { code: 'camp_artifact_http', status: 503 });
    await assert.rejects(request('/redirect'), TypeError);
    assert.equal(expectedAuthorization, 'Bearer fixture-private-room'); assert.equal(forwarded, 0);
  } finally {
    for (const server of [source, destination]) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  }
});
test('a crash after publication recovers its own transfer chunks without deleting an unrelated journal', async () => {
  const f = await fixture(); await uploadPrivateBundle({ request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: f.source });
  const target = join(f.home, 'published'), input = { request: f.request, operationId: f.receipt.operationId, receipt: f.receipt, bundlePath: target };
  await downloadPrivateBundle(input);
  const work = `${target}.transfer-${f.artifact.id}`;
  const recreate = async digest => {
    await mkdir(join(work, 'parts'), { recursive: true, mode: 0o700 });
    await writeFile(join(work, 'transfer.json'), JSON.stringify({ schemaVersion: 1, artifactId: f.artifact.id, manifestDigest: digest }), { mode: 0o600 });
    await writeFile(join(work, 'parts', '0'), 'retained private bytes', { mode: 0o600 });
  };
  await recreate(f.artifact.manifestDigest); await downloadPrivateBundle(input);
  await assert.rejects(readdir(work), { code: 'ENOENT' });
  await recreate('f'.repeat(64)); await assert.rejects(downloadPrivateBundle(input), /unrelated transfer journal/);
  assert.equal(await readFile(join(work, 'parts', '0'), 'utf8'), 'retained private bytes');
  assert.deepEqual(await readFile(join(target, 'project.record')), await readFile(join(f.source, 'project.record')));
});
