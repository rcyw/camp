import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAMP_ARTIFACT_LIMITS, parsePrivateArtifactManifest, serializePrivateArtifactManifest } from '../src/index.js';

const file = (name, bytes) => ({ name, bytes, sha256: 'a'.repeat(64), parts: [{ bytes, sha256: 'b'.repeat(64) }] });
const manifest = () => ({ schemaVersion: 1, format: 'camp-native-store-v1', files: [file('manifest.json', 100), file('project.record', 50), file('store.sqlite', 1024)] });
test('private transport canonicalizes fixed bundle names without granting native restore authority', () => {
  const input = manifest(), accepted = parsePrivateArtifactManifest(input);
  assert.equal(serializePrivateArtifactManifest({ ...input, files: [...input.files].reverse() }), serializePrivateArtifactManifest(accepted));
  accepted.files[0].parts[0].bytes = 1;
  assert.equal(input.files[0].parts[0].bytes, 100);
  assert.equal(CAMP_ARTIFACT_LIMITS.partBytes, 8 * 1024 ** 2);
});
test('transfer manifests reject names, duplicates, malformed parts, private paths and excess storage', () => {
  for (const patch of [{ files: [] }, { format: 'file-tree' }, { schemaVersion: 2 }, { workerToken: 'secret' }]) assert.throws(() => parsePrivateArtifactManifest({ ...manifest(), ...patch }));
  for (const patch of [{ name: '../store.sqlite' }, { bytes: CAMP_ARTIFACT_LIMITS.maxStoreBytes + 1 }, { bytes: 0 }, { bytes: 1.1 }, { sha256: 'etag' }, { parts: [] }, { parts: [{ bytes: 512, sha256: 'b'.repeat(64) }] }, { localPath: '/private' }]) {
    const input = manifest(); input.files[2] = { ...input.files[2], ...patch };
    assert.throws(() => parsePrivateArtifactManifest(input));
  }
  const duplicate = manifest(); duplicate.files[2] = duplicate.files[1]; assert.throws(() => parsePrivateArtifactManifest(duplicate));
  const large = manifest(), bytes = CAMP_ARTIFACT_LIMITS.partBytes;
  large.files[2] = { ...file('store.sqlite', bytes + 1), parts: [{ bytes, sha256: 'a'.repeat(64) }, { bytes: 1, sha256: 'b'.repeat(64) }] };
  assert.equal(parsePrivateArtifactManifest(large).files[2].parts.length, 2);
});
