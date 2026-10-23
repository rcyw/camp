import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateArtifactRequest, uploadPrivateBundle, downloadPrivateBundle } from '../src/private-artifacts.mjs';
import { parseStorageBackupReceipt } from '../../camp-protocol/src/index.js';
import { managedWorkerCredential } from '../src/worker-credentials.mjs';

export async function artifactsMain(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 3 || !['upload', 'download', 'discard'].includes(args[0]) || args[1] !== '--operation' || !/^[a-f0-9-]{36}$/.test(args[2]) || args[0] !== 'discard' && !env.CAMP_STORAGE_BUNDLE) throw Object.assign(new Error('Usage: artifacts.mjs upload|download|discard --operation <UUID>; configure CAMP_STORAGE_BUNDLE privately for transfer'), { code: 'camp_artifact_usage' });
  const credential = await managedWorkerCredential({ env });
  const request = credential.wrapRequest(privateArtifactRequest(credential.env)), operationId = args[2];
  const context = await request(`/storage-operations/${operationId}`);
  if (context.plan?.operationId !== operationId || context.operation?.phase === 'cancelled') throw new Error('Storage operation is unavailable');
  const receipt = parseStorageBackupReceipt(context.operation?.backupReceipt);
  if (args[0] === 'discard') {
    const artifact = await request(`/storage-operations/${operationId}/artifact`);
    const result = await request(`/storage-operations/${operationId}/artifacts/${artifact.id}`, { method: 'DELETE' });
    process.stdout.write(`${JSON.stringify({ event: 'artifact_unpublished_discarded', artifactId: result.artifactId })}\n`);
    return result;
  }
  const controller = new AbortController(), stop = () => controller.abort(new Error('Private transfer interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const transfer = args[0] === 'upload' ? uploadPrivateBundle : downloadPrivateBundle;
    const artifact = await transfer({ request, operationId, receipt, bundlePath: env.CAMP_STORAGE_BUNDLE, signal: controller.signal, onProgress: progress => process.stdout.write(`${JSON.stringify({ event: 'artifact_transfer', ...progress })}\n`) });
    process.stdout.write(`${JSON.stringify({ event: `artifact_${args[0]}_complete`, artifactId: artifact.id, manifestDigest: artifact.manifestDigest })}\n`);
    return artifact;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) artifactsMain().catch(error => { process.stderr.write(`${JSON.stringify({ event: 'artifact_transfer_failed', code: /^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'camp_artifact_failed' })}\n`); process.exitCode = 1; });
