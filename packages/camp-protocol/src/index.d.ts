// Generated from index.js by scripts/declarations.mjs. Do not edit.
/** Private, immutable cold bundles only. A transfer is not a proof of native
 * candidate reachability; quarantined restoration must still verify history.
 * @param {unknown} value @returns {CampPrivateArtifactManifest} */
export function parsePrivateArtifactManifest(value: unknown): CampPrivateArtifactManifest;
/** @param {unknown} value */
export function serializePrivateArtifactManifest(value: unknown): string;
/** @param {unknown} value @returns {CampStoragePlan} */
export function parseStoragePlan(value: unknown): CampStoragePlan;
/** @param {unknown} value @returns {string} */
export function serializeStoragePlan(value: unknown): string;
/** @param {unknown} value @returns {CampStorageBackupReceipt} */
export function parseStorageBackupReceipt(value: unknown): CampStorageBackupReceipt;
/** @param {unknown} value @returns {CampStorageRestoreReceipt} */
export function parseStorageRestoreReceipt(value: unknown): CampStorageRestoreReceipt;
/** @param {unknown} value @returns {CampVerificationPolicy} */
export function parseVerificationPolicy(value: unknown): CampVerificationPolicy;
/** Fixed field order is the input to a trusted caller's SHA-256; no crypto or
 * environment implementation belongs in this browser-compatible module.
 * @param {unknown} value */
export function serializeVerificationPolicy(value: unknown): string;
/** @param {unknown} value @returns {CampVerificationReport} */
export function parseVerificationReport(value: unknown): CampVerificationReport;
/** @param {unknown} value @returns {CampChangeSet} */
export function parseChangeSet(value: unknown): CampChangeSet;
/** A pool names one trusted storage authority and its two fixed execution lanes.
 * Resource values reserve the whole pool (two main plus two auxiliary containers).
 * @param {unknown} value @returns {CampExecutionPool} */
export function parseExecutionPool(value: unknown): CampExecutionPool;
/** @param {unknown} value */
export function serializeExecutionPool(value: unknown): string;
/** Unknown offered identifiers grant no authority; this allows a newer worker
 * to offer extra abilities while retaining its implemented v1 abilities.
 * @param {unknown} value @returns {CampWorkerDeclaration} */
export function parseWorkerDeclaration(value: unknown): CampWorkerDeclaration;
/** @param {string} [workerVersion] @returns {CampWorkerDeclaration} */
export function createWorkerDeclaration(workerVersion?: string): CampWorkerDeclaration;
/** A model plugin never advertises roleless infrastructure authority.
 * @returns {CampWorkerDeclaration} */
export function createPluginDeclaration(): CampWorkerDeclaration;
/** @returns {CampServerProtocol} */
export function serverProtocol(): CampServerProtocol;
/** @param {unknown} value @returns {CampServerProtocol} */
export function parseServerProtocol(value: unknown): CampServerProtocol;
/** @param {{protocolVersion?: number|null, workflow: CampWorkflow, taskKind: CampTaskKind, inputCandidate?: CampCandidate|null,verificationPolicy?:CampVerificationPolicySnapshot|null}} input @returns {CampTaskRequirements} */
export function getTaskRequirements(input: {
    protocolVersion?: number | null;
    workflow: CampWorkflow;
    taskKind: CampTaskKind;
    inputCandidate?: CampCandidate | null;
    verificationPolicy?: CampVerificationPolicySnapshot | null;
}): CampTaskRequirements;
/** Plugins execute model tools, never host pool admission or system operations.
 * @param {CampTaskRequirements} requirements @returns {CampTaskRequirements} */
export function getPluginTaskRequirements(requirements: CampTaskRequirements): CampTaskRequirements;
/** Pure check: neither this function nor offered capability names can assign work.
 * @param {CampWorkerDeclaration|null|undefined} declaration @param {CampTaskRequirements} requirements @returns {CampWorkerCompatibility} */
export function checkWorkerCompatibility(declaration: CampWorkerDeclaration | null | undefined, requirements: CampTaskRequirements): CampWorkerCompatibility;
/** @param {unknown} value @param {{requireImage?:boolean,requireTagged?:boolean,allowLegacy?:boolean,projectId?:string,imageId?:string,preserveExtras?:boolean}} [options] @returns {CampCandidate} */
export function parseCandidate(value: unknown, options?: {
    requireImage?: boolean;
    requireTagged?: boolean;
    allowLegacy?: boolean;
    projectId?: string;
    imageId?: string;
    preserveExtras?: boolean;
}): CampCandidate;
/** @param {unknown} value @returns {CampPlanMode} */
export function parsePlanMode(value: unknown): CampPlanMode;
/** Frozen integration authority. Parent order is plan order, not finish time.
 * Only the control side selects these reviewed producing runs.
 * @param {unknown} value @returns {CampIntegrationInput} */
export function parseIntegrationInput(value: unknown): CampIntegrationInput;
/** Fixed canonical order for host SHA-256 without platform crypto imports.
 * @param {unknown} value */
export function serializeIntegrationInput(value: unknown): string;
/** @param {unknown} value @returns {CampIntegrationReport} */
export function parseIntegrationReport(value: unknown): CampIntegrationReport;
/** @param {unknown} value @returns {CampPlanItem} */
export function parsePlanItem(value: unknown): CampPlanItem;
/** Revision 2 never infers dependencies from item order.
 * @param {unknown} value @returns {CampDagPlanItem} */
export function parseDagPlanItem(value: unknown): CampDagPlanItem;
/** @param {unknown} value @returns {CampPlanSubmission} */
export function parsePlanSubmission(value: unknown): CampPlanSubmission;
/** @param {unknown} value @returns {CampPlan} */
export function parsePlan(value: unknown): CampPlan;
/** A bounded self-report, never a remote attestation or a model-key test.
 * No free-form diagnostic text, filesystem paths or process output belong on
 * this wire. The server supplies its own observation time and project digest.
 * @param {unknown} value @returns {CampPreflightReport} */
export function parsePreflightReport(value: unknown): CampPreflightReport;
/** Pure wire contracts. No Node, browser, database, DSH or sandbox imports. */
export const CAMP_PROTOCOL_VERSION: 5;
export const CAMP_SUPPORTED_PROTOCOL_VERSIONS: readonly number[];
export const CAMP_WORKER_VERSION: "0.7.0";
export const CAMP_PLAN_MODES: readonly ["sequential", "same_baseline_pair", "parallel_pair", "bounded_dag"];
export const CAMP_ROLES: readonly ["planner", "builder", "reviewer"];
export const CAMP_AGENT_TASK_KINDS: readonly ["plan", "build", "review", "final_review", "summary", "clarification"];
export const CAMP_TASK_KINDS: readonly ["plan", "build", "review", "final_review", "summary", "clarification", "verification", "integration"];
export const CAMP_REF_KINDS: readonly ["layer", "commit"];
export const CAMP_CAPABILITIES_V1: readonly ["dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1", "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1"];
export const CAMP_CAPABILITIES_V2: readonly ["dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1", "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1", "candidate-diff.v1", "trusted-verification.v1"];
export const CAMP_CAPABILITIES_V3: readonly ["dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1", "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1", "candidate-diff.v1", "trusted-verification.v1", "trusted-integration.v1"];
export const CAMP_CAPABILITIES_V4: readonly ["dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1", "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1", "candidate-diff.v1", "trusted-verification.v1", "trusted-integration.v1", "bounded-pair.v1"];
export const CAMP_CAPABILITIES: readonly ["dsh.acp.v1", "layerfs.candidate.v1", "structured-plan.v1", "questions.v1", "candidate-review.v1", "finalize.v1", "checkpoint-yield.v1", "candidate-diff.v1", "trusted-verification.v1", "trusted-integration.v1", "bounded-pair.v1", "structured-plan.v2", "bounded-dag.v1"];
export const CAMP_INTEGRATION_ALGORITHM: "layerfs-three-way-v1";
export const CAMP_DAG_INTEGRATION_ALGORITHM: "layerfs-three-way-v2";
export const CAMP_INTEGRATION_POLICY: "reject-overlap-v1";
export const CAMP_INTEGRATION_LIMITS: Readonly<{
    maxConflicts: 100;
    maxPayloadBytes: 65536;
}>;
export const CAMP_CHANGE_LIMITS: Readonly<{
    maxEntries: 500;
    maxPatchBytes: 16384;
    maxTotalPatchBytes: 262144;
    maxPayloadBytes: 524288;
}>;
export const CAMP_VERIFICATION_LIMITS: Readonly<{
    maxChecks: 5;
    maxArguments: 32;
    maxArgumentLength: 4096;
    maxPolicyBytes: 65536;
    maxTimeoutMs: 120000;
    maxOutputBytes: 32768;
    maxPayloadBytes: 262144;
    maxRepairAttempts: 3;
}>;
export const CAMP_PREFLIGHT_CHECK_IDS: readonly ["platform", "node", "host_tools", "runtime_home", "toolchain", "docker", "fuse", "image", "plugin", "harnesses", "source", "capacity", "api", "resource_policy", "model"];
export const CAMP_RUN_STATUSES: readonly ["running", "completed", "failed", "cancelled", "suspended"];
export const CAMP_TASK_STATUSES: readonly ["queued", "running", "completed", "failed", "cancelled", "blocked", "waiting_question"];
export const CAMP_GOAL_STATUSES: readonly ["queued", "running", "waiting_question", "cancelling", "completed", "cancelled", "needs_attention"];
export const CAMP_QUESTION_STATUSES: readonly ["pending", "awaiting_role", "awaiting_human", "answered", "cancelled"];
export const CAMP_LIMITS: Readonly<{
    planItems: 5;
    planKey: 48;
    planTitle: 200;
    planText: 4000;
    text: 16000;
    remainingItems: 20;
    remainingText: 4000;
}>;
export const CAMP_DAG_LIMITS: Readonly<{
    nodes: 6;
    parents: 2;
    sinks: 2;
}>;
export const DEFAULT_CAMP_BUDGET: Readonly<{
    maxRuns: 12;
    maxReviewRounds: 3;
    maxDurationSeconds: 1800;
}>;
export const DEFAULT_SERIAL_CAMP_BUDGET: Readonly<{
    maxRuns: 24;
    maxReviewRounds: 10;
    maxDurationSeconds: 3600;
}>;
export const DEFAULT_BUDGETS: Readonly<{
    legacy: Readonly<{
        maxRuns: 12;
        maxReviewRounds: 3;
        maxDurationSeconds: 1800;
    }>;
    serial: Readonly<{
        maxRuns: 24;
        maxReviewRounds: 10;
        maxDurationSeconds: 3600;
    }>;
}>;
/** Operator-only storage contracts are separate from model tools and execution
 * negotiation. Their receipts carry identities, never host paths or secrets. */
export const CAMP_STORAGE_LIMITS: Readonly<{
    maxCandidates: 4096;
    maxPlanBytes: number;
    maxStoreBytes: number;
}>;
export const CAMP_ARTIFACT_LIMITS: Readonly<{
    partBytes: number;
    maxStoreBytes: number;
    maxManifestBytes: number;
    roomBytes: number;
    pendingPerRoom: 2;
}>;
/** @typedef {{schemaVersion:1,operationId:string,roomId:string,kind:'backup'|'migration',storageEpoch:number,sourceStorageId:string,acceptedRevision:number,acceptedCandidate:CampCandidate,projectId:string,candidates:CampCandidate[],backupOperationId?:string}} CampStoragePlan */
/** @typedef {{schemaVersion:1,operationId:string,manifestDigest:string,storeSha256:string,bytes:number,toolchainDigest:string,imageId:string,candidateCount:number,sourceStorageId:string,stopped:true,verified:true}} CampStorageBackupReceipt */
/** @typedef {CampStorageBackupReceipt & {targetStorageId:string,verifiedCandidates:number,historyVerified:true}} CampStorageRestoreReceipt */
export class CampProtocolError extends Error {
    /** @param {string} code @param {string} message @param {number} [status] */
    constructor(code: string, message: string, status?: number);
    code: string;
    status: number;
}
/** @param {unknown} value @returns {CampVerificationReport} */
export function parseVerificationReceipt(value: unknown): CampVerificationReport;
export const CAMP_PLAN_ITEM_SCHEMA: Record<string, any>;
export const CAMP_DAG_PLAN_ITEM_SCHEMA: Record<string, any>;
export const CAMP_DAG_PLAN_TOOL_SCHEMA: Record<string, any>;
/** These schemas are model-facing: no worker credentials, model selection or
 * arbitrary role/identity provisioning fields belong here. */
export const CAMP_TOOL_SCHEMAS: Readonly<{
    camp_read_context: Record<string, any>;
    camp_read_room: Record<string, any>;
    camp_send_message: Record<string, any>;
    camp_progress: Record<string, any>;
    camp_artifact: Record<string, any>;
    camp_handoff: Record<string, any>;
    camp_submit_plan: Record<string, any>;
    camp_ask_question: Record<string, any>;
    camp_answer_question: Record<string, any>;
    camp_escalate_question: Record<string, any>;
    camp_finalize: Record<string, any>;
    camp_review: Record<string, any>;
}>;
export type CampPrivateArtifactManifest = {
    schemaVersion: 1;
    format: "camp-native-store-v1";
    files: {
        name: "manifest.json" | "project.record" | "store.sqlite";
        bytes: number;
        sha256: string;
        parts: {
            bytes: number;
            sha256: string;
        }[];
    }[];
};
export type CampPrivateArtifact = {
    schemaVersion: 1;
    id: string;
    state: "uploading" | "ready";
    manifestDigest: string;
    manifest: CampPrivateArtifactManifest;
    received: number[];
};
export type CampStoragePlan = {
    schemaVersion: 1;
    operationId: string;
    roomId: string;
    kind: "backup" | "migration";
    storageEpoch: number;
    sourceStorageId: string;
    acceptedRevision: number;
    acceptedCandidate: CampCandidate;
    projectId: string;
    candidates: CampCandidate[];
    backupOperationId?: string;
};
export type CampStorageBackupReceipt = {
    schemaVersion: 1;
    operationId: string;
    manifestDigest: string;
    storeSha256: string;
    bytes: number;
    toolchainDigest: string;
    imageId: string;
    candidateCount: number;
    sourceStorageId: string;
    stopped: true;
    verified: true;
};
export type CampStorageRestoreReceipt = CampStorageBackupReceipt & {
    targetStorageId: string;
    verifiedCandidates: number;
    historyVerified: true;
};
export type CampRole = (typeof CAMP_ROLES)[number];
export type CampTaskKind = (typeof CAMP_TASK_KINDS)[number];
export type CampAgentTaskKind = (typeof CAMP_AGENT_TASK_KINDS)[number];
export type CampPlanMode = (typeof CAMP_PLAN_MODES)[number];
export type CampWorkflow = "serial" | "legacy";
export type CampRunStatus = (typeof CAMP_RUN_STATUSES)[number];
export type CampTaskStatus = (typeof CAMP_TASK_STATUSES)[number];
export type CampGoalStatus = (typeof CAMP_GOAL_STATUSES)[number];
export type CampQuestionStatus = (typeof CAMP_QUESTION_STATUSES)[number];
export type CampCleanupState = "unknown" | "confirmed" | "pending";
export type CampBudget = {
    maxRuns: number;
    maxReviewRounds: number;
    maxDurationSeconds: number;
};
export type CampReference = {
    refKind?: "layer" | "commit";
    refId?: string;
    commitId?: string;
    layerId?: string;
};
export type CampCandidate = {
    type: "layerfs";
    projectId: string;
    refKind: "layer" | "commit";
    refId: string;
    commitId?: string;
    layerId?: string;
    rootId: string;
    imageId?: string;
    branch?: string;
    baseRef?: string;
    [key: string]: unknown;
};
export type CampReviewTarget = CampReference & {
    projectId: string;
    branch?: string;
};
export type CampReview = {
    outcome: "approved" | "changes_requested";
    evidence: string | string[];
    summary: string;
    candidate?: CampReviewTarget;
};
export type CampArtifact = CampReference & {
    type: string;
    path?: string;
    summary?: string;
    evidence?: string | string[];
    candidate?: CampReviewTarget;
    outcome?: "approved" | "changes_requested" | "handoff";
    branch?: string;
    rootId?: string;
    projectId?: string;
    runId?: string;
    sandboxId?: string;
    imageId?: string;
    baseRef?: string;
    profile?: string;
    [key: string]: unknown;
};
export type CampCompletion = {
    status: "completed" | "failed" | "cancelled" | "suspended";
    summary: string;
    artifacts?: CampArtifact[];
    sessionId?: string;
    error?: string;
    outcome?: "approved" | "changes_requested" | "handoff";
    inputCandidate?: CampCandidate;
    candidate?: CampCandidate;
    questionId?: string;
    changeSet?: CampChangeSet;
    verification?: CampVerificationReport;
    integration?: CampIntegrationReport;
};
export type CampPlanItem = {
    key: string;
    title: string;
    description: string;
    acceptance: string;
    verification: string;
};
export type CampDagPlanItem = CampPlanItem & {
    dependsOnKeys: string[];
};
export type CampPlanSubmission = {
    planRevision: 1;
    summary: string;
    tasks: CampPlanItem[];
} | {
    planRevision: 2;
    summary: string;
    tasks: CampDagPlanItem[];
};
export type CampPlan = {
    revision: 1;
    summary: string;
    tasks: CampPlanItem[];
} | {
    revision: 2;
    summary: string;
    tasks: CampDagPlanItem[];
};
export type CampFinalSummary = {
    summary: string;
    evidence: string | null;
    remaining: string[];
};
export type CampMetrics = {
    runs: number;
    reviewRounds: number;
    elapsedSeconds: number;
    itemsTotal: number;
    itemsApproved: number;
    questionsAsked: number;
    questionsAnswered: number;
    reworks: number;
    humanAnswers: number;
    agentAnswers: number;
    roleAnswers?: number;
    manualRetries: number;
};
export type CampReviewRecord = {
    runId: string;
    outcome: "approved" | "changes_requested";
    evidence: string | string[];
    summary: string;
    candidate: CampReviewTarget | null;
    createdAt: string;
};
export type CampWorkItem = CampPlanItem & {
    index: number;
    status: "pending" | "building" | "reviewing" | "approved" | "needs_attention";
    reworkCount: number;
    candidate: CampCandidate | null;
    reviews: CampReviewRecord[];
};
export type CampQuestion = {
    id: string;
    goalId: string;
    goalAttempt: number;
    taskId: string;
    originRunId: string | null;
    fromRole: CampRole;
    toRole: CampRole | null;
    needsHuman: boolean;
    status: CampQuestionStatus;
    content: string;
    answer: string | null;
    answerByRole: string | null;
    canAnswer: boolean;
    createdAt: string;
    answeredAt: string | null;
};
export type CampResultManifest = {
    schemaVersion: 1;
    roomId: string;
    goalId: string;
    goalAttempt?: number;
    workflow?: CampWorkflow;
    planMode?: CampPlanMode;
    status: CampGoalStatus;
    resultReady: boolean;
    candidate: CampCandidate | null;
    summary: string | null;
    evidence: string | null;
    remaining: string[];
    metrics: CampMetrics;
    verification?: {
        policy: CampVerificationPolicySnapshot | null;
        receipt: CampVerificationReceipt | null;
    } | null;
    integration?: {
        input: CampIntegrationInput;
        receipt: CampIntegrationReceipt | null;
    } | CampDagIntegrationEvidence | null;
};
export type CampWorkerDeclaration = {
    protocolVersions: number[];
    workerVersion: string;
    taskKinds: string[];
    refKinds: string[];
    capabilities: string[];
    harnesses?: CampHarnessIdentity[];
    executionPool?: CampExecutionPool;
};
export type CampServerProtocol = {
    schemaVersion: 1;
    supportedProtocolVersions: number[];
    capabilities: string[];
    taskKinds: string[];
    refKinds: string[];
};
export type CampTaskRequirements = {
    protocolVersion: number | null;
    workflow: CampWorkflow;
    taskKind: CampTaskKind;
    refKinds: string[];
    capabilities: string[];
    harnesses?: CampHarnessIdentity[];
    executionPoolRequired?: boolean;
};
export type CampWorkerCompatibility = {
    status: "compatible" | "incompatible" | "legacy";
    code: "compatible" | "legacy_unversioned" | "protocol_required" | "protocol_unsupported" | "capability_missing" | "pool_required" | "pool_mismatch" | "storage_mismatch" | "lane_not_registered";
    protocolVersion: number | null;
    missingTaskKinds: string[];
    missingRefKinds: string[];
    missingCapabilities: string[];
    missingHarnesses?: string[];
};
export type CampNegotiatedProtocol = {
    version: number;
    declaration: CampWorkerDeclaration;
    requirements: CampTaskRequirements;
};
export type CampHarnessIdentity = {
    id: string;
    sha256: string;
};
export type CampVerificationCheck = {
    id: string;
    label: string;
    argv: string[];
    timeoutMs: number;
    harness?: CampHarnessIdentity;
};
export type CampVerificationPolicy = {
    id: string;
    revision: number;
    name: string;
    checks: CampVerificationCheck[];
    maxRepairAttempts: number;
};
export type CampVerificationPolicySnapshot = {
    policy: CampVerificationPolicy;
    digest: string;
};
export type CampVerificationCheckResult = {
    id: string;
    argv: string[];
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    oomKilled: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
};
export type CampVerificationReport = {
    candidate: CampCandidate;
    policyDigest: string;
    checks: CampVerificationCheckResult[];
};
export type CampVerificationReceipt = CampVerificationReport & {
    schemaVersion: 1;
    status: "passed" | "failed";
    runId: string;
    operationId: string;
    verifiedAt: string;
};
export type CampIntegrationAlgorithm = "layerfs-three-way-v1" | "layerfs-three-way-v2";
export type CampIntegrationParent = {
    key: string;
    runId: string;
    epoch: number;
    candidate: CampCandidate;
};
export type CampIntegrationInput = {
    schemaVersion: 1;
    algorithm: CampIntegrationAlgorithm;
    policy: "reject-overlap-v1";
    base: CampCandidate;
    parents: [CampIntegrationParent, CampIntegrationParent];
};
export type CampIntegrationConflict = {
    path: string;
    reason: "overlap" | "delete_modify" | "structural" | "policy_path" | "unsupported";
};
export type CampIntegrationReport = {
    schemaVersion: 1;
    inputDigest: string;
    algorithm: CampIntegrationAlgorithm;
    policy: "reject-overlap-v1";
    status: "merged" | "conflict" | "rejected";
    candidate: CampCandidate | null;
    conflicts: CampIntegrationConflict[];
    truncated: boolean;
};
export type CampIntegrationReceipt = CampIntegrationReport & {
    runId: string;
    operationId: string;
    integratedAt: string;
};
export type CampDagInputResolution = "baseline" | "single_parent" | "same_ref" | "ancestor" | "integration";
export type CampDagDelivery = {
    status: "waiting_nodes" | "waiting_integration" | "ready" | "blocked";
    candidate: CampCandidate | null;
    sourceRunId: string | null;
    operationId: string | null;
    inputSources: CampIntegrationParent[];
    inputResolution: CampDagInputResolution | null;
};
export type CampDagIntegrationEvidence = {
    delivery: CampDagDelivery;
    operations: {
        id: string;
        scope: "goal" | "node_input";
        planItemKey: string | null;
        status: CampOperationStatus;
        integrationInput: CampIntegrationInput | null;
        inputDigest: string | null;
        integrationReport: CampIntegrationReceipt | null;
    }[];
};
export type CampOperationStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "blocked";
export type CampChangeSide = {
    type: "file";
    mode: number;
    size: number;
    sha256: string;
} | {
    type: "directory";
    mode: number;
    size: number;
} | {
    type: "symlink";
    mode: number;
    size: number;
    target: string;
};
export type CampChangeEntry = {
    path: string;
    change: "added" | "modified" | "deleted" | "type_changed";
    before: CampChangeSide | null;
    after: CampChangeSide | null;
    binary: boolean;
    modeChanged: boolean;
    patch: string | null;
    patchTruncated: boolean;
    previewReason: string | null;
};
export type CampChangeSet = {
    schemaVersion: 1;
    base: CampCandidate;
    target: CampCandidate;
    entries: CampChangeEntry[];
    truncated: boolean;
    stats: {
        added: number;
        modified: number;
        deleted: number;
        typeChanged: number;
    };
};
export type CampPreflightCheckId = (typeof CAMP_PREFLIGHT_CHECK_IDS)[number];
export type CampPreflightCheck = {
    id: CampPreflightCheckId;
    status: "passed" | "failed" | "skipped";
    code: string;
};
export type CampPreflightReport = {
    schemaVersion: 1;
    workerVersion: string;
    mode: "agent" | "verification";
    modelConfigured: boolean;
    toolchainDigest: string | null;
    imageId: string | null;
    checks: CampPreflightCheck[];
};
export type CampExecutionPool = {
    poolId: string;
    storageId: string;
    maxParallel: 2;
    workerIds: [string, string] | string[];
    resources: {
        maxContainers: 4;
        cpuMillis: number;
        memoryBytes: number;
        pidsLimit: number;
    };
};
export type CampClaimAdmission = {
    status: "waiting";
    reason: "lane_busy" | "room_capacity" | "role_busy" | "cleanup_pending" | "system_operation_busy" | "storage_maintenance";
};
