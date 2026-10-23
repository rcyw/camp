import { CampRuntime } from '../src/index.mjs';
import { exportNativeStore, restoreNativeStore, reportNativeStore } from '../src/native-store.mjs';
import { workerApiRequest } from '../src/worker-preflight.mjs';
import { parseStoragePlan, parseStorageBackupReceipt, parseStorageRestoreReceipt } from '../../camp-protocol/src/index.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function checkStorageCommand(command, operation, plan) {
  const reject = () => { throw Object.assign(new Error('Storage command is not permitted in the current operation phase'), { code: 'camp_storage_phase' }); };
  if (!operation || operation.id !== plan.operationId || operation.roomId !== plan.roomId || operation.kind !== plan.kind) reject();
  const sourceReceipt = operation.backupReceipt ? parseStorageBackupReceipt(operation.backupReceipt) : undefined;
  if (command === 'restore') {
    if (plan.kind !== 'migration' || !['backup_ready', 'restore_ready'].includes(operation.phase) || !sourceReceipt) reject();
    return { sourceReceipt, ...(operation.restoreReceipt ? { existingRestoreReceipt: parseStorageRestoreReceipt(operation.restoreReceipt) } : {}) };
  }
  if (plan.backupOperationId || operation.phase !== 'prepared' && !sourceReceipt) reject();
  if (!['prepared', 'backup_ready', 'restore_ready', 'completed', 'activated', 'cancelled'].includes(operation.phase)) reject();
  return { ...(sourceReceipt ? { sourceReceipt } : {}), ...(command === 'backup' && sourceReceipt ? { existingOnly: true } : {}) };
}

export async function storageMain(args = process.argv.slice(2), env = process.env) {
  if (args.length !== 3 || !['backup', 'restore', 'report-backup'].includes(args[0]) || args[1] !== '--operation' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args[2])) throw Object.assign(new Error('Usage: storage.mjs backup|restore|report-backup --operation <UUID>'), { code: 'camp_storage_usage' });
  if (!env.CAMP_STORAGE_BUNDLE) throw Object.assign(new Error('CAMP_STORAGE_BUNDLE must select a private local bundle directory'), { code: 'camp_storage_configuration' });
  const request = workerApiRequest(env), operationId = args[2];
  const context = await request(`/storage-operations/${operationId}`), plan = parseStoragePlan(context.plan);
  if (plan.operationId !== operationId) throw Object.assign(new Error('Storage operation identity differs'), { code: 'camp_storage_identity' });
  const admission = checkStorageCommand(args[0], context.operation, plan);
  const controller = new AbortController(), stop = () => controller.abort(new Error('Storage maintenance interrupted'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const operation = args[0] === 'backup' ? exportNativeStore : args[0] === 'restore' ? restoreNativeStore : reportNativeStore;
    const receipt = await operation({ runtime: new CampRuntime({ env }), plan, bundlePath: env.CAMP_STORAGE_BUNDLE, ...admission, signal: controller.signal, postReceipt: value => request(`/storage-operations/${operationId}/${args[0] === 'restore' ? 'restore' : 'backup'}`, value) });
    process.stdout.write(`${JSON.stringify({ event: `storage_${args[0].replaceAll('-', '_')}_verified`, ...receipt })}\n`);
    return receipt;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) storageMain().catch(error => { process.stderr.write(`${JSON.stringify({ event: 'storage_failed', code: /^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'camp_storage_failed' })}\n`); process.exitCode = 1; });
