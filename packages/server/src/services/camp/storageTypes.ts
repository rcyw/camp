import type { CampStoragePlan, CampStorageBackupReceipt, CampStorageRestoreReceipt } from "../../../../camp-protocol/src/index.js";
export type { CampStoragePlan, CampStorageBackupReceipt, CampStorageRestoreReceipt } from "../../../../camp-protocol/src/index.js";
export type CampStorageKind = "backup" | "migration";
export type CampStoragePhase = "prepared" | "backup_ready" | "restore_ready" | "completed" | "activated" | "cancelled";
export type CampStorageOperation = {
  id: string; roomId: string; requestId: string; kind: CampStorageKind; phase: CampStoragePhase;
  plan: CampStoragePlan; planDigest: string;
  backupReceipt: CampStorageBackupReceipt | null; restoreReceipt: CampStorageRestoreReceipt | null;
  createdAt: string; updatedAt: string; completedAt: string | null;
  candidateCount: number; inventoryTruncated: boolean; originBackupOperationId: string | null; canActivate: boolean; canCancel: boolean; canRestoreFromBackup: boolean;
};
export type CampStorageSnapshot = {
  epoch: number; storageId: string | null; maintenance: boolean; activeOperationId: string | null;
  operations: CampStorageOperation[]; operationsTruncated: boolean; canBackup: boolean; canMigrate: boolean; blockers: string[];
};
