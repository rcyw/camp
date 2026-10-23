import { join } from 'node:path';
import { regularBytes, sha256 } from './toolchain.mjs';
import { parseStorageRestoreReceipt } from '../../camp-protocol/src/index.js';

export const restoredVolume = (projectId, operationId) => `camp-restore-${projectId}-${operationId.replaceAll('-', '')}`;
/** A restored Store is installed only by the private maintenance path. Never
 * accept arbitrary Room JSON as a Docker volume or a replacement source. */
export async function validateRestoreBinding(project, runtimeHome) {
  const folder = join(runtimeHome, 'projects', project.projectId);
  const binding = JSON.parse(await regularBytes(join(folder, 'restore-binding.json'), 65536));
  const receipt = parseStorageRestoreReceipt(binding.receipt);
  if (binding.schemaVersion !== 1 || binding.projectId !== project.projectId || binding.externalId !== project.externalId || binding.volume !== restoredVolume(project.projectId, receipt.operationId) || project.volume !== binding.volume || project.home !== join(folder, 'sdk-home') || project.storePath !== binding.storePath || project.imageId !== receipt.imageId || project.sourcePath || project.importPath || project.restore?.manifestDigest !== receipt.manifestDigest || project.restore?.operationId !== receipt.operationId) throw new Error('Restored project differs from its verified installation binding');
  const record = await regularBytes(join(project.home, project.projectId, 'project.record'), 65536);
  if (sha256(record) !== binding.recordSha256) throw new Error('Restored project authority record changed');
  return binding;
}
