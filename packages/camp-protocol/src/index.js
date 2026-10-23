/** Pure wire contracts. No Node, browser, database, DSH or sandbox imports. */
export const CAMP_PROTOCOL_VERSION = 3;
export const CAMP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([1, 2, 3]);
export const CAMP_WORKER_VERSION = '0.5.0';
export const CAMP_PLAN_MODES = Object.freeze(/** @type {const} */ (['sequential', 'same_baseline_pair']));
export const CAMP_ROLES = Object.freeze(/** @type {const} */ (['planner', 'builder', 'reviewer']));
export const CAMP_AGENT_TASK_KINDS = Object.freeze(/** @type {const} */ (['plan', 'build', 'review', 'final_review', 'summary', 'clarification']));
export const CAMP_TASK_KINDS = Object.freeze(/** @type {const} */ ([...CAMP_AGENT_TASK_KINDS, 'verification', 'integration']));
export const CAMP_REF_KINDS = Object.freeze(/** @type {const} */ (['layer', 'commit']));
export const CAMP_CAPABILITIES_V1 = Object.freeze(/** @type {const} */ ([
  'dsh.acp.v1', 'layerfs.candidate.v1', 'structured-plan.v1', 'questions.v1',
  'candidate-review.v1', 'finalize.v1', 'checkpoint-yield.v1',
]));
export const CAMP_CAPABILITIES_V2 = Object.freeze(/** @type {const} */ ([...CAMP_CAPABILITIES_V1, 'candidate-diff.v1', 'trusted-verification.v1']));
export const CAMP_CAPABILITIES = Object.freeze(/** @type {const} */ ([...CAMP_CAPABILITIES_V2, 'trusted-integration.v1']));
export const CAMP_INTEGRATION_ALGORITHM = 'layerfs-three-way-v1';
export const CAMP_INTEGRATION_POLICY = 'reject-overlap-v1';
export const CAMP_INTEGRATION_LIMITS = Object.freeze({ maxConflicts: 100, maxPayloadBytes: 65536 });
export const CAMP_CHANGE_LIMITS = Object.freeze({ maxEntries: 500, maxPatchBytes: 16384, maxTotalPatchBytes: 262144, maxPayloadBytes: 524288 });
export const CAMP_VERIFICATION_LIMITS = Object.freeze({ maxChecks: 5, maxArguments: 32, maxArgumentLength: 4096, maxPolicyBytes: 65536, maxTimeoutMs: 120000, maxOutputBytes: 32768, maxPayloadBytes: 262144, maxRepairAttempts: 3 });
export const CAMP_PREFLIGHT_CHECK_IDS = Object.freeze(/** @type {const} */ (['platform', 'node', 'host_tools', 'runtime_home', 'toolchain', 'docker', 'fuse', 'image', 'plugin', 'harnesses', 'source', 'capacity', 'api', 'resource_policy', 'model']));
export const CAMP_RUN_STATUSES = Object.freeze(/** @type {const} */ (['running', 'completed', 'failed', 'cancelled', 'suspended']));
export const CAMP_TASK_STATUSES = Object.freeze(/** @type {const} */ (['queued', 'running', 'completed', 'failed', 'cancelled', 'blocked', 'waiting_question']));
export const CAMP_GOAL_STATUSES = Object.freeze(/** @type {const} */ (['queued', 'running', 'waiting_question', 'cancelling', 'completed', 'cancelled', 'needs_attention']));
export const CAMP_QUESTION_STATUSES = Object.freeze(/** @type {const} */ (['pending', 'awaiting_role', 'awaiting_human', 'answered', 'cancelled']));
export const CAMP_LIMITS = Object.freeze({ planItems: 5, planKey: 48, planTitle: 200, planText: 4000, text: 16000, remainingItems: 20, remainingText: 4000 });
export const DEFAULT_CAMP_BUDGET = Object.freeze({ maxRuns: 12, maxReviewRounds: 3, maxDurationSeconds: 1800 });
export const DEFAULT_SERIAL_CAMP_BUDGET = Object.freeze({ maxRuns: 24, maxReviewRounds: 10, maxDurationSeconds: 3600 });
export const DEFAULT_BUDGETS = Object.freeze({ legacy: DEFAULT_CAMP_BUDGET, serial: DEFAULT_SERIAL_CAMP_BUDGET });

export class CampProtocolError extends Error {
  /** @param {string} code @param {string} message @param {number} [status] */
  constructor(code, message, status = 400) {
    super(message); this.name = 'CampProtocolError'; this.code = code; this.status = status;
  }
}
/** @param {unknown} value @param {string} [label] @returns {Record<string, any>} */
function object(value, label = 'record') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CampProtocolError('invalid_protocol', `${label} must be an object`);
  return /** @type {Record<string, any>} */ (value);
}
/** @param {Record<string, any>} value @param {string[]} keys @param {string} label */
function only(value, keys, label) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new CampProtocolError('invalid_protocol', `${label} contains an unknown field`);
}
/** @param {unknown} value @param {string} label @param {number} maximum */
function text(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new CampProtocolError('invalid_protocol', `${label} must be nonempty text of at most ${maximum} characters`);
  return value.trim();
}
/** @param {unknown} value @param {string} label @param {number} max @returns {string[]} */
function identifiers(value, label, max) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !/^[a-z][a-z0-9_.-]{0,99}$/.test(item)) || new Set(value).size !== value.length) throw new CampProtocolError('invalid_protocol', `${label} must contain unique bounded identifiers`);
  return [...value];
}
/** @param {unknown} value @returns {number[]} */
function versions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some(item => !Number.isSafeInteger(item) || item < 1 || item > 65535) || new Set(value).size !== value.length) throw new CampProtocolError('invalid_protocol', 'protocolVersions must contain one to eight unique positive versions');
  return [...value];
}

/** @param {unknown} value @returns {CampHarnessIdentity} */
function harnessIdentity(value) {
  const record = object(value, 'Harness'); only(record, ['id', 'sha256'], 'Harness');
  if (typeof record.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(record.id) || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new CampProtocolError('invalid_verification_policy', 'Harness requires a bounded identifier and exact SHA-256');
  return { id: record.id, sha256: record.sha256 };
}
/** @param {unknown} value @param {boolean} [deduplicate] @returns {CampHarnessIdentity[]} */
function parseHarnesses(value, deduplicate = false) {
  if (!Array.isArray(value) || value.length > 32) throw new CampProtocolError('invalid_protocol', 'Harness declarations must be a bounded array');
  const items = value.map(harnessIdentity), selected = new Map();
  for (const item of items) {
    if (selected.has(item.id) && (!deduplicate || selected.get(item.id).sha256 !== item.sha256)) throw new CampProtocolError('invalid_protocol', 'Harness IDs must be unique and cannot contradict their digest');
    selected.set(item.id, item);
  }
  return [...selected.values()];
}

/** @param {unknown} value @param {string} label @param {number} maximum */
function integer(value, label, maximum) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new CampProtocolError('invalid_protocol', `${label} must be a bounded nonnegative integer`);
  return /** @type {number} */ (value);
}
/** @param {unknown} value @returns {string[]} */
function commandArguments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CAMP_VERIFICATION_LIMITS.maxArguments || value.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > CAMP_VERIFICATION_LIMITS.maxArgumentLength) || !value[0].trim()) throw new CampProtocolError('invalid_verification_policy', 'Checks require a bounded nonempty argv array');
  return [...value];
}
/** @param {unknown} value @returns {CampVerificationPolicy} */
export function parseVerificationPolicy(value) {
  const policy = object(value, 'Verification policy'); only(policy, ['id', 'revision', 'name', 'checks', 'maxRepairAttempts'], 'Verification policy');
  if (typeof policy.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(policy.id)) throw new CampProtocolError('invalid_verification_policy', 'Policy requires a bounded identifier');
  const revision = integer(policy.revision, 'Policy revision', 1_000_000_000);
  if (!revision || !Array.isArray(policy.checks) || policy.checks.length < 1 || policy.checks.length > CAMP_VERIFICATION_LIMITS.maxChecks) throw new CampProtocolError('invalid_verification_policy', 'Policy requires a positive revision and one to five checks');
  const checks = policy.checks.map(value => {
    const check = object(value, 'Verification check'); only(check, ['id', 'label', 'argv', 'timeoutMs', 'harness'], 'Verification check');
    if (typeof check.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(check.id)) throw new CampProtocolError('invalid_verification_policy', 'Check requires a bounded identifier');
    const timeoutMs = integer(check.timeoutMs, 'Check timeout', CAMP_VERIFICATION_LIMITS.maxTimeoutMs);
    if (!timeoutMs) throw new CampProtocolError('invalid_verification_policy', 'Check timeout must be positive');
    const harness = check.harness === undefined ? undefined : harnessIdentity(check.harness);
    const argv = commandArguments(check.argv);
    if (harness && !argv.includes('/camp-checks/' + harness.id)) throw new CampProtocolError('invalid_verification_policy', 'External check argv must name its readonly /camp-checks/<id> file');
    return { id: check.id, label: text(check.label, 'Check label', 200), argv, timeoutMs, ...(harness ? { harness } : {}) };
  });
  if (new Set(checks.map(check => check.id)).size !== checks.length) throw new CampProtocolError('invalid_verification_policy', 'Check IDs must be unique');
  parseHarnesses(checks.flatMap(check => check.harness ? [check.harness] : []), true);
  const parsed = { id: policy.id, revision, name: text(policy.name, 'Policy name', 200), checks, maxRepairAttempts: integer(policy.maxRepairAttempts ?? 1, 'Repair attempts', CAMP_VERIFICATION_LIMITS.maxRepairAttempts) };
  // Every check's argv must also fit in the eventual observed report. Per-arg
  // limits alone allow a valid policy whose mandatory report can never fit.
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > CAMP_VERIFICATION_LIMITS.maxPolicyBytes) throw new CampProtocolError('invalid_verification_policy', 'Policy exceeds its total byte budget');
  return parsed;
}
/** Fixed field order is the input to a trusted caller's SHA-256; no crypto or
 * environment implementation belongs in this browser-compatible module.
 * @param {unknown} value */
export function serializeVerificationPolicy(value) { return JSON.stringify(parseVerificationPolicy(value)); }

/** @param {unknown} value @returns {CampVerificationReport} */
export function parseVerificationReport(value) {
  const report = object(value, 'Verification receipt'); only(report, ['candidate', 'policyDigest', 'checks'], 'Verification receipt');
  if (typeof report.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(report.policyDigest) || !Array.isArray(report.checks) || report.checks.length < 1 || report.checks.length > CAMP_VERIFICATION_LIMITS.maxChecks) throw new CampProtocolError('invalid_verification_receipt', 'Receipt requires a policy digest and bounded checks');
  const checks = report.checks.map(value => {
    const check = object(value, 'Check result'); only(check, ['id', 'argv', 'exitCode', 'signal', 'timedOut', 'oomKilled', 'durationMs', 'stdout', 'stderr', 'outputTruncated'], 'Check result');
    if (typeof check.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(check.id) || (check.exitCode !== null && (!Number.isSafeInteger(check.exitCode) || check.exitCode < 0 || check.exitCode > 255)) || (check.signal !== null && (typeof check.signal !== 'string' || !/^[A-Z][A-Z0-9_]{0,31}$/.test(check.signal)))) throw new CampProtocolError('invalid_verification_receipt', 'Check identity or termination is malformed');
    for (const field of ['timedOut', 'oomKilled', 'outputTruncated']) if (typeof check[field] !== 'boolean') throw new CampProtocolError('invalid_verification_receipt', `Check ${field} must be explicit`);
    if (typeof check.stdout !== 'string' || typeof check.stderr !== 'string' || new TextEncoder().encode(check.stdout + check.stderr).length > CAMP_VERIFICATION_LIMITS.maxOutputBytes) throw new CampProtocolError('invalid_verification_receipt', 'Check output exceeds its retained byte budget');
    return { id: check.id, argv: commandArguments(check.argv), exitCode: check.exitCode, signal: check.signal, timedOut: check.timedOut, oomKilled: check.oomKilled, durationMs: integer(check.durationMs, 'Duration', 3_600_000), stdout: check.stdout, stderr: check.stderr, outputTruncated: check.outputTruncated };
  });
  if (new Set(checks.map(check => check.id)).size !== checks.length) throw new CampProtocolError('invalid_verification_receipt', 'Receipt check IDs must be unique');
  const parsed = { candidate: parseCandidate(report.candidate), policyDigest: report.policyDigest, checks };
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > CAMP_VERIFICATION_LIMITS.maxPayloadBytes) throw new CampProtocolError('invalid_verification_receipt', 'Receipt exceeds its total byte budget');
  return parsed;
}
export const parseVerificationReceipt = parseVerificationReport;

/** @param {unknown} value @returns {CampChangeSide|null} */
function changeSide(value) {
  if (value === null) return null;
  const side = object(value, 'Change side');
  if (!['file', 'directory', 'symlink'].includes(side.type)) throw new CampProtocolError('invalid_change_set', 'Unknown file kind');
  const mode = integer(side.mode, 'File mode', 0o7777), size = integer(side.size, 'File size', Number.MAX_SAFE_INTEGER);
  if (side.type === 'file') {
    only(side, ['type', 'mode', 'size', 'sha256'], 'File change side');
    if (typeof side.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(side.sha256)) throw new CampProtocolError('invalid_change_set', 'Files require exact content SHA-256');
    return { type: 'file', mode, size, sha256: side.sha256 };
  }
  if (side.type === 'directory') {
    only(side, ['type', 'mode', 'size'], 'Directory change side');
    if (size !== 0) throw new CampProtocolError('invalid_change_set', 'Directory changes use a normalized zero size');
    return { type: 'directory', mode, size };
  }
  only(side, ['type', 'mode', 'size', 'target'], 'Symlink change side');
  if (typeof side.target !== 'string' || !side.target || side.target.includes('\0') || side.target.length > 4096) throw new CampProtocolError('invalid_change_set', 'Symlinks require an opaque bounded target');
  return { type: 'symlink', mode, size, target: side.target };
}
/** @param {unknown} value @returns {CampChangeSet} */
export function parseChangeSet(value) {
  const report = object(value, 'Change set'); only(report, ['schemaVersion', 'base', 'target', 'entries', 'truncated', 'stats'], 'Change set');
  if (report.schemaVersion !== 1 || !Array.isArray(report.entries) || report.entries.length > CAMP_CHANGE_LIMITS.maxEntries || typeof report.truncated !== 'boolean') throw new CampProtocolError('invalid_change_set', 'Change set requires a bounded explicit schema');
  const paths = new Set(); let patchBytes = 0;
  const entries = report.entries.map(value => {
    const entry = object(value, 'Change entry'); only(entry, ['path', 'change', 'before', 'after', 'binary', 'modeChanged', 'patch', 'patchTruncated', 'previewReason'], 'Change entry');
    const path = entry.path;
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\\') || path.includes('\0') || (path !== '.' && path.split('/').some(part => !part || part === '.' || part === '..')) || paths.has(path)) throw new CampProtocolError('invalid_change_set', 'Change entry requires a unique safe relative path');
    paths.add(path);
    if (!['added', 'modified', 'deleted', 'type_changed'].includes(entry.change) || typeof entry.binary !== 'boolean' || typeof entry.modeChanged !== 'boolean' || typeof entry.patchTruncated !== 'boolean' || (entry.previewReason !== null && (typeof entry.previewReason !== 'string' || entry.previewReason.length > 500))) throw new CampProtocolError('invalid_change_set', 'Change classification or preview state is invalid');
    const before = changeSide(entry.before), after = changeSide(entry.after);
    if ((!before && !after) || (entry.change === 'added' && before) || (entry.change === 'deleted' && after) || (['modified', 'type_changed'].includes(entry.change) && (!before || !after)) || (entry.change === 'modified' && (before?.type !== after?.type || JSON.stringify(before) === JSON.stringify(after))) || (entry.change === 'type_changed' && before?.type === after?.type) || (path === '.' && (before?.type !== 'directory' || after?.type !== 'directory'))) throw new CampProtocolError('invalid_change_set', 'Change sides contradict their classification');
    if (entry.modeChanged !== Boolean(before && after && before.mode !== after.mode)) throw new CampProtocolError('invalid_change_set', 'Mode change must match the recorded permissions');
    const filePair = (!before || before.type === 'file') && (!after || after.type === 'file');
    if (entry.binary && before?.type !== 'file' && after?.type !== 'file') throw new CampProtocolError('invalid_change_set', 'Only file content can be binary');
    if (entry.patchTruncated && (!filePair || entry.binary)) throw new CampProtocolError('invalid_change_set', 'Only text file previews can be truncated');
    if (entry.patch !== null && (typeof entry.patch !== 'string' || !filePair || entry.binary || new TextEncoder().encode(entry.patch).length > CAMP_CHANGE_LIMITS.maxPatchBytes)) throw new CampProtocolError('invalid_change_set', 'Patch must be bounded text for a nonbinary file');
    patchBytes += entry.patch === null ? 0 : new TextEncoder().encode(entry.patch).length;
    return { path, change: entry.change, before, after, binary: entry.binary, modeChanged: entry.modeChanged, patch: entry.patch, patchTruncated: entry.patchTruncated, previewReason: entry.previewReason };
  });
  if (patchBytes > CAMP_CHANGE_LIMITS.maxTotalPatchBytes) throw new CampProtocolError('invalid_change_set', 'Change patches exceed their combined byte budget');
  const stats = object(report.stats, 'Change stats'); only(stats, ['added', 'modified', 'deleted', 'typeChanged'], 'Change stats');
  for (const field of ['added', 'modified', 'deleted', 'typeChanged']) integer(stats[field], field, Number.MAX_SAFE_INTEGER);
  for (const [field, kind] of [['added', 'added'], ['modified', 'modified'], ['deleted', 'deleted'], ['typeChanged', 'type_changed']]) {
    const count = entries.filter(entry => entry.change === kind).length;
    if (report.truncated ? stats[field] < count : stats[field] !== count) throw new CampProtocolError('invalid_change_set', 'Change counts contradict the retained entries');
  }
  const parsed = { schemaVersion: /** @type {1} */ (1), base: parseCandidate(report.base), target: parseCandidate(report.target), entries, truncated: report.truncated, stats: { added: stats.added, modified: stats.modified, deleted: stats.deleted, typeChanged: stats.typeChanged } };
  if (parsed.base.projectId !== parsed.target.projectId || parsed.base.imageId !== parsed.target.imageId) throw new CampProtocolError('invalid_change_set', 'Change set snapshots must belong to the same project and runtime image');
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > CAMP_CHANGE_LIMITS.maxPayloadBytes) throw new CampProtocolError('invalid_change_set', 'Change set exceeds its total byte budget');
  return parsed;
}

/** Unknown offered identifiers grant no authority; this allows a newer worker
 * to offer extra abilities while retaining its implemented v1 abilities.
 * @param {unknown} value @returns {CampWorkerDeclaration} */
export function parseWorkerDeclaration(value) {
  const record = object(value, 'Worker declaration');
  only(record, ['protocolVersions', 'workerVersion', 'taskKinds', 'refKinds', 'capabilities', 'harnesses'], 'Worker declaration');
  return { protocolVersions: versions(record.protocolVersions), workerVersion: text(record.workerVersion, 'workerVersion', 100), taskKinds: identifiers(record.taskKinds, 'taskKinds', 32), refKinds: identifiers(record.refKinds, 'refKinds', 8), capabilities: identifiers(record.capabilities, 'capabilities', 64), ...(record.harnesses === undefined ? {} : { harnesses: parseHarnesses(record.harnesses) }) };
}
/** @param {string} [workerVersion] @returns {CampWorkerDeclaration} */
export function createWorkerDeclaration(workerVersion = CAMP_WORKER_VERSION) {
  return parseWorkerDeclaration({ protocolVersions: [...CAMP_SUPPORTED_PROTOCOL_VERSIONS], workerVersion, taskKinds: [...CAMP_TASK_KINDS], refKinds: [...CAMP_REF_KINDS], capabilities: [...CAMP_CAPABILITIES] });
}
/** A model plugin never advertises roleless infrastructure authority.
 * @returns {CampWorkerDeclaration} */
export function createPluginDeclaration() {
  return { ...createWorkerDeclaration(), taskKinds: [...CAMP_AGENT_TASK_KINDS], capabilities: [...CAMP_CAPABILITIES_V1, 'candidate-diff.v1'] };
}
/** @returns {CampServerProtocol} */
export function serverProtocol() {
  return { schemaVersion: 1, supportedProtocolVersions: [...CAMP_SUPPORTED_PROTOCOL_VERSIONS], capabilities: [...CAMP_CAPABILITIES], taskKinds: [...CAMP_TASK_KINDS], refKinds: [...CAMP_REF_KINDS] };
}
/** @param {unknown} value @returns {CampServerProtocol} */
export function parseServerProtocol(value) {
  const record = object(value, 'Server protocol');
  only(record, ['schemaVersion', 'supportedProtocolVersions', 'capabilities', 'taskKinds', 'refKinds'], 'Server protocol');
  if (record.schemaVersion !== 1) throw new CampProtocolError('protocol_unsupported', 'Unsupported server protocol discovery schema', 409);
  const result = { schemaVersion: /** @type {1} */ (1), supportedProtocolVersions: versions(record.supportedProtocolVersions), capabilities: identifiers(record.capabilities, 'capabilities', 64), taskKinds: identifiers(record.taskKinds, 'taskKinds', 32), refKinds: identifiers(record.refKinds, 'refKinds', 8) };
  if (!result.supportedProtocolVersions.some(version => CAMP_SUPPORTED_PROTOCOL_VERSIONS.includes(version))) throw new CampProtocolError('protocol_unsupported', 'Server does not support this worker protocol', 409);
  return result;
}
/** @param {{protocolVersion?: number|null, workflow: CampWorkflow, taskKind: CampTaskKind, inputCandidate?: CampCandidate|null,verificationPolicy?:CampVerificationPolicySnapshot|null}} input @returns {CampTaskRequirements} */
export function getTaskRequirements(input) {
  if (!['serial', 'legacy'].includes(input.workflow) || !CAMP_TASK_KINDS.includes(input.taskKind)) throw new CampProtocolError('protocol_unsupported', 'Unknown workflow or task kind', 409);
  const serial = input.workflow === 'serial';
  const protocolVersion = input.protocolVersion === undefined ? serial ? CAMP_PROTOCOL_VERSION : null : input.protocolVersion;
  if (serial && protocolVersion === null) throw new CampProtocolError('protocol_unsupported', 'Serial work requires a frozen protocol version', 409);
  const refKinds = !input.inputCandidate || ['build', 'integration'].includes(input.taskKind) ? [...CAMP_REF_KINDS] : [input.inputCandidate.refKind];
  const trusted = input.taskKind === 'verification';
  const capabilities = input.taskKind === 'integration' ? ['layerfs.candidate.v1', 'candidate-diff.v1', 'trusted-integration.v1'] : trusted ? ['layerfs.candidate.v1', 'candidate-diff.v1', 'trusted-verification.v1'] : serial ? [...CAMP_CAPABILITIES_V1, ...(protocolVersion !== null && protocolVersion >= 2 ? ['candidate-diff.v1'] : [])] : ['dsh.acp.v1', 'layerfs.candidate.v1', 'candidate-review.v1'];
  const harnesses = trusted ? input.verificationPolicy?.policy.checks.flatMap(check => check.harness ? [check.harness] : []) ?? [] : [];
  return { protocolVersion, workflow: input.workflow, taskKind: input.taskKind, refKinds, capabilities, ...(protocolVersion !== null && protocolVersion >= 2 ? { harnesses: parseHarnesses(harnesses, true) } : {}) };
}
/** Pure check: neither this function nor offered capability names can assign work.
 * @param {CampWorkerDeclaration|null|undefined} declaration @param {CampTaskRequirements} requirements @returns {CampWorkerCompatibility} */
export function checkWorkerCompatibility(declaration, requirements) {
  const offered = declaration ? parseWorkerDeclaration(declaration) : null;
  const common = offered?.protocolVersions.filter(version => CAMP_SUPPORTED_PROTOCOL_VERSIONS.includes(version)) ?? [];
  const protocolVersion = requirements.protocolVersion ?? (requirements.workflow === 'legacy' && common.length ? Math.max(...common) : null);
  const base = { protocolVersion, missingTaskKinds: /** @type {string[]} */ ([]), missingRefKinds: /** @type {string[]} */ ([]), missingCapabilities: /** @type {string[]} */ ([]), ...(protocolVersion !== null && protocolVersion >= 2 ? { missingHarnesses: /** @type {string[]} */ ([]) } : {}) };
  if (!offered) return requirements.workflow === 'legacy' && requirements.protocolVersion === null && !['verification', 'integration'].includes(requirements.taskKind)
    ? { ...base, status: 'legacy', code: 'legacy_unversioned' }
    : { ...base, status: 'incompatible', code: 'protocol_required' };
  if (protocolVersion === null || !CAMP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion) || !offered.protocolVersions.includes(protocolVersion) || !['serial', 'legacy'].includes(requirements.workflow) || !CAMP_TASK_KINDS.includes(requirements.taskKind) || (requirements.taskKind === 'verification' && (requirements.workflow !== 'serial' || protocolVersion < 2)) || (requirements.taskKind === 'integration' && (requirements.workflow !== 'serial' || protocolVersion < 3))) return { ...base, status: 'incompatible', code: 'protocol_unsupported' };
  const missingTaskKinds = offered.taskKinds.includes(requirements.taskKind) ? [] : [requirements.taskKind];
  const missingRefKinds = requirements.refKinds.filter(kind => !offered.refKinds.includes(kind));
  const missingCapabilities = requirements.capabilities.filter(capability => !offered.capabilities.includes(capability));
  const missingHarnesses = (requirements.harnesses ?? []).filter(required => !(offered.harnesses ?? []).some(item => item.id === required.id && item.sha256 === required.sha256)).map(item => item.id);
  const missing = missingTaskKinds.length + missingRefKinds.length + missingCapabilities.length + missingHarnesses.length;
  return { protocolVersion, status: missing ? 'incompatible' : 'compatible', code: missing ? 'capability_missing' : 'compatible', missingTaskKinds, missingRefKinds, missingCapabilities, ...(protocolVersion >= 2 ? { missingHarnesses } : {}) };
}

/** @param {unknown} value @param {{requireImage?:boolean,requireTagged?:boolean,allowLegacy?:boolean,projectId?:string,imageId?:string,preserveExtras?:boolean}} [options] @returns {CampCandidate} */
export function parseCandidate(value, options = {}) {
  const record = object(value, 'Candidate');
  const { requireImage = true, requireTagged = true, allowLegacy = false, preserveExtras = false } = options;
  const refId = record.refId ?? (allowLegacy ? record.commitId ?? record.layerId : undefined);
  const refKind = record.refKind ?? (allowLegacy && typeof refId === 'string' ? refId.startsWith('32') ? 'layer' : 'commit' : undefined);
  if (record.type !== 'layerfs' || typeof record.projectId !== 'string' || !/^p-[a-f0-9]{16}$/.test(record.projectId) || typeof record.rootId !== 'string' || !/^[a-f0-9]{64}$/.test(record.rootId)) throw new CampProtocolError('invalid_candidate', 'A complete immutable LayerFS project and root identity is required');
  if (requireTagged && (!record.refKind || !record.refId)) throw new CampProtocolError('invalid_candidate', 'Candidate must explicitly identify refKind and refId');
  if (typeof refId !== 'string' || (refKind === 'layer' ? !/^32[a-f0-9]{64}$/.test(refId) : refKind === 'commit' ? !/^12[a-f0-9]{64}$/.test(refId) : true) || (record.commitId !== undefined && (refKind !== 'commit' || record.commitId !== refId)) || (record.layerId !== undefined && (refKind !== 'layer' || record.layerId !== refId))) throw new CampProtocolError('invalid_candidate', 'Candidate has an invalid tagged immutable reference or contradictory aliases');
  if ((requireImage && record.imageId === undefined) || (record.imageId !== undefined && (typeof record.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.imageId)))) throw new CampProtocolError('invalid_candidate', 'Candidate image identity is required and must be exact');
  if (options.projectId && options.projectId !== record.projectId) throw new CampProtocolError('candidate_project_mismatch', 'Candidate belongs to another project', 409);
  if (options.imageId && record.imageId && options.imageId !== record.imageId) throw new CampProtocolError('candidate_project_mismatch', 'Candidate image differs from the recorded project image', 409);
  for (const field of ['branch', 'baseRef']) if (record[field] !== undefined) text(record[field], field, 1024);
  return { ...(preserveExtras ? record : {}), type: 'layerfs', projectId: record.projectId, refKind, refId, ...(refKind === 'layer' ? { layerId: refId } : { commitId: refId }), rootId: record.rootId, ...(record.imageId === undefined ? {} : { imageId: record.imageId }), ...(record.branch === undefined ? {} : { branch: record.branch }), ...(record.baseRef === undefined ? {} : { baseRef: record.baseRef }) };
}
/** @param {unknown} value @returns {CampPlanMode} */
export function parsePlanMode(value) {
  if (!CAMP_PLAN_MODES.includes(/** @type {any} */ (value))) throw new CampProtocolError('invalid_plan_mode', 'Choose sequential or same_baseline_pair');
  return /** @type {CampPlanMode} */ (value);
}
/** Frozen integration authority. Parent order is plan order, not finish time.
 * Only the control side selects these reviewed producing runs.
 * @param {unknown} value @returns {CampIntegrationInput} */
export function parseIntegrationInput(value) {
  const input = object(value, 'Integration input'); only(input, ['schemaVersion', 'algorithm', 'policy', 'base', 'parents'], 'Integration input');
  if (input.schemaVersion !== 1 || input.algorithm !== CAMP_INTEGRATION_ALGORITHM || input.policy !== CAMP_INTEGRATION_POLICY || !Array.isArray(input.parents) || input.parents.length !== 2) throw new CampProtocolError('invalid_integration_input', 'Integration requires the frozen algorithm, conservative policy and exactly two reviewed parents');
  const base = parseCandidate(input.base);
  const parents = input.parents.map(value => {
    const parent = object(value, 'Integration parent'); only(parent, ['key', 'runId', 'epoch', 'candidate'], 'Integration parent');
    if (typeof parent.key !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(parent.key) || typeof parent.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parent.runId) || !Number.isSafeInteger(parent.epoch) || parent.epoch < 1 || parent.epoch > 2147483647) throw new CampProtocolError('invalid_integration_input', 'Integration parents require exact producing run identities');
    return { key: parent.key, runId: parent.runId, epoch: parent.epoch, candidate: parseCandidate(parent.candidate, { projectId: base.projectId, imageId: base.imageId }) };
  });
  if (parents[0].key === parents[1].key || parents[0].runId === parents[1].runId) throw new CampProtocolError('invalid_integration_input', 'Integration parents must name distinct plan items and producing runs');
  return { schemaVersion: 1, algorithm: CAMP_INTEGRATION_ALGORITHM, policy: CAMP_INTEGRATION_POLICY, base, parents: /** @type {[CampIntegrationParent,CampIntegrationParent]} */ (parents) };
}
/** Fixed canonical order for host SHA-256 without platform crypto imports.
 * @param {unknown} value */
export function serializeIntegrationInput(value) { return JSON.stringify(parseIntegrationInput(value)); }
/** @param {unknown} value @returns {CampIntegrationReport} */
export function parseIntegrationReport(value) {
  const report = object(value, 'Integration report'); only(report, ['schemaVersion', 'inputDigest', 'algorithm', 'policy', 'status', 'candidate', 'conflicts', 'truncated'], 'Integration report');
  const invalid = () => new CampProtocolError('invalid_integration_report', 'Integration requires a bounded exact result or explicit conflicts');
  if (report.schemaVersion !== 1 || report.algorithm !== CAMP_INTEGRATION_ALGORITHM || report.policy !== CAMP_INTEGRATION_POLICY || typeof report.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(report.inputDigest) || !['merged', 'conflict', 'rejected'].includes(report.status) || typeof report.truncated !== 'boolean' || !Array.isArray(report.conflicts) || report.conflicts.length > CAMP_INTEGRATION_LIMITS.maxConflicts) throw invalid();
  const conflicts = report.conflicts.map(value => {
    const conflict = object(value, 'Integration conflict'); only(conflict, ['path', 'reason'], 'Integration conflict');
    const path = conflict.path;
    if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\\') || path.includes('\0') || (path !== '.' && path.split('/').some(part => !part || part === '.' || part === '..')) || !['overlap', 'delete_modify', 'structural', 'policy_path', 'unsupported'].includes(conflict.reason)) throw invalid();
    return { path, reason: conflict.reason };
  });
  if (new Set(conflicts.map(item => item.path)).size !== conflicts.length) throw invalid();
  const candidate = report.candidate === null ? null : parseCandidate(report.candidate);
  if (report.status === 'merged' ? !candidate || conflicts.length || report.truncated : candidate !== null || !conflicts.length) throw invalid();
  /** @type {CampIntegrationReport} */
  const parsed = { schemaVersion: 1, inputDigest: report.inputDigest, algorithm: CAMP_INTEGRATION_ALGORITHM, policy: CAMP_INTEGRATION_POLICY, status: report.status, candidate, conflicts, truncated: report.truncated };
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > CAMP_INTEGRATION_LIMITS.maxPayloadBytes) throw invalid();
  return parsed;
}
/** @param {unknown} value @returns {CampPlanItem} */
export function parsePlanItem(value) {
  const record = object(value, 'Plan item'); only(record, ['key', 'title', 'description', 'acceptance', 'verification'], 'Plan item');
  if (typeof record.key !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(record.key)) throw new CampProtocolError('invalid_plan', 'Plan key must be a lowercase identifier of at most 48 characters');
  return { key: record.key, title: text(record.title, 'title', CAMP_LIMITS.planTitle), description: text(record.description, 'description', CAMP_LIMITS.planText), acceptance: text(record.acceptance, 'acceptance', CAMP_LIMITS.planText), verification: text(record.verification, 'verification', CAMP_LIMITS.planText) };
}
/** @param {unknown} value @returns {{planRevision:1,summary:string,tasks:CampPlanItem[]}} */
export function parsePlanSubmission(value) {
  const record = object(value, 'Plan'); only(record, ['planRevision', 'summary', 'tasks'], 'Plan');
  if (record.planRevision !== 1 || !Array.isArray(record.tasks) || !record.tasks.length || record.tasks.length > CAMP_LIMITS.planItems) throw new CampProtocolError('invalid_plan', 'Plan requires revision 1 and one to five ordered items');
  const tasks = record.tasks.map(parsePlanItem);
  if (new Set(tasks.map(task => task.key)).size !== tasks.length) throw new CampProtocolError('invalid_plan', 'Plan item keys must be unique');
  return { planRevision: 1, summary: text(record.summary, 'summary', CAMP_LIMITS.text), tasks };
}
/** @param {unknown} value @returns {CampPlan} */
export function parsePlan(value) {
  const record = object(value, 'Plan'); only(record, ['revision', 'summary', 'tasks'], 'Plan');
  const result = parsePlanSubmission({ planRevision: record.revision, summary: record.summary, tasks: record.tasks });
  return { revision: 1, summary: result.summary, tasks: result.tasks };
}

/** A bounded self-report, never a remote attestation or a model-key test.
 * No free-form diagnostic text, filesystem paths or process output belong on
 * this wire. The server supplies its own observation time and project digest.
 * @param {unknown} value @returns {CampPreflightReport} */
export function parsePreflightReport(value) {
  const report = object(value, 'Preflight report');
  only(report, ['schemaVersion', 'workerVersion', 'mode', 'modelConfigured', 'toolchainDigest', 'imageId', 'checks'], 'Preflight report');
  const invalid = () => new CampProtocolError('invalid_preflight_report', 'Preflight requires complete bounded checks and exact deployment identities');
  if (report.schemaVersion !== 1 || !['agent', 'verification'].includes(report.mode) || typeof report.modelConfigured !== 'boolean' || !Array.isArray(report.checks) || report.checks.length !== CAMP_PREFLIGHT_CHECK_IDS.length) throw invalid();
  const seen = new Set();
  const checks = report.checks.map(value => {
    const check = object(value, 'Preflight check'); only(check, ['id', 'status', 'code'], 'Preflight check');
    if (!CAMP_PREFLIGHT_CHECK_IDS.includes(check.id) || seen.has(check.id) || !['passed', 'failed', 'skipped'].includes(check.status) || typeof check.code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(check.code)) throw invalid();
    seen.add(check.id);
    return { id: check.id, status: check.status, code: check.code };
  });
  if ((report.toolchainDigest !== null && (typeof report.toolchainDigest !== 'string' || !/^[a-f0-9]{64}$/.test(report.toolchainDigest))) || (report.imageId !== null && (typeof report.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(report.imageId)))) throw invalid();
  const parsed = { schemaVersion: /** @type {const} */ (1), workerVersion: text(report.workerVersion, 'Worker version', 80), mode: report.mode, modelConfigured: report.modelConfigured, toolchainDigest: report.toolchainDigest, imageId: report.imageId, checks };
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > 32768) throw invalid();
  return parsed;
}

/** @param {Record<string,unknown>} properties @param {string[]} required @returns {Record<string,any>} */
function schema(properties, required) { return { type: 'object', properties, required, additionalProperties: false }; }
const ordinaryText = { type: 'string', minLength: 1, maxLength: CAMP_LIMITS.text };
const itemText = { type: 'string', minLength: 1, maxLength: CAMP_LIMITS.planText };
const roleSchema = { type: 'string', enum: [...CAMP_ROLES] };
export const CAMP_PLAN_ITEM_SCHEMA = schema({ key: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,47}$' }, title: { type: 'string', minLength: 1, maxLength: CAMP_LIMITS.planTitle }, description: itemText, acceptance: itemText, verification: itemText }, ['key', 'title', 'description', 'acceptance', 'verification']);
/** These schemas are model-facing: no worker credentials, model selection or
 * arbitrary role/identity provisioning fields belong here. */
export const CAMP_TOOL_SCHEMAS = Object.freeze({
  camp_read_context: schema({}, []),
  camp_read_room: schema({ after: { type: 'string' } }, []),
  camp_send_message: schema({ content: ordinaryText, to_role: roleSchema }, ['content', 'to_role']),
  camp_progress: schema({ content: ordinaryText }, ['content']),
  camp_artifact: schema({ path: ordinaryText, summary: ordinaryText, branch: ordinaryText, commit: ordinaryText, evidence: ordinaryText }, ['path', 'summary']),
  camp_handoff: schema({ to_role: roleSchema, summary: ordinaryText, remaining: ordinaryText }, ['to_role', 'summary', 'remaining']),
  camp_submit_plan: schema({ summary: ordinaryText, tasks: { type: 'array', minItems: 1, maxItems: CAMP_LIMITS.planItems, items: CAMP_PLAN_ITEM_SCHEMA } }, ['summary', 'tasks']),
  camp_ask_question: schema({ content: ordinaryText, to_role: roleSchema, needs_human: { type: 'boolean' } }, ['content', 'to_role']),
  camp_answer_question: schema({ question_id: { type: 'string', format: 'uuid' }, answer: ordinaryText }, ['question_id', 'answer']),
  camp_escalate_question: schema({ question_id: { type: 'string', format: 'uuid' }, reason: ordinaryText }, ['question_id', 'reason']),
  camp_finalize: schema({ summary: ordinaryText, evidence: ordinaryText, remaining: { type: 'array', maxItems: CAMP_LIMITS.remainingItems, items: itemText } }, ['summary']),
  camp_review: schema({ outcome: { type: 'string', enum: ['approved', 'changes_requested'] }, summary: ordinaryText, evidence: ordinaryText }, ['outcome', 'summary', 'evidence']),
});

/** @typedef {typeof CAMP_ROLES[number]} CampRole */
/** @typedef {typeof CAMP_TASK_KINDS[number]} CampTaskKind */
/** @typedef {typeof CAMP_AGENT_TASK_KINDS[number]} CampAgentTaskKind */
/** @typedef {typeof CAMP_PLAN_MODES[number]} CampPlanMode */
/** @typedef {'serial'|'legacy'} CampWorkflow */
/** @typedef {typeof CAMP_RUN_STATUSES[number]} CampRunStatus */
/** @typedef {typeof CAMP_TASK_STATUSES[number]} CampTaskStatus */
/** @typedef {typeof CAMP_GOAL_STATUSES[number]} CampGoalStatus */
/** @typedef {typeof CAMP_QUESTION_STATUSES[number]} CampQuestionStatus */
/** @typedef {'unknown'|'confirmed'|'pending'} CampCleanupState */
/** @typedef {{maxRuns:number,maxReviewRounds:number,maxDurationSeconds:number}} CampBudget */
/** @typedef {{refKind?:'layer'|'commit',refId?:string,commitId?:string,layerId?:string}} CampReference */
/** @typedef {{type:'layerfs',projectId:string,refKind:'layer'|'commit',refId:string,commitId?:string,layerId?:string,rootId:string,imageId?:string,branch?:string,baseRef?:string,[key:string]:unknown}} CampCandidate */
/** @typedef {CampReference & {projectId:string,branch?:string}} CampReviewTarget */
/** @typedef {{outcome:'approved'|'changes_requested',evidence:string|string[],summary:string,candidate?:CampReviewTarget}} CampReview */
/** @typedef {CampReference & {type:string,path?:string,summary?:string,evidence?:string|string[],candidate?:CampReviewTarget,outcome?:'approved'|'changes_requested'|'handoff',branch?:string,rootId?:string,projectId?:string,runId?:string,sandboxId?:string,imageId?:string,baseRef?:string,profile?:string,[key:string]:unknown}} CampArtifact */
/** @typedef {{status:'completed'|'failed'|'cancelled'|'suspended',summary:string,artifacts?:CampArtifact[],sessionId?:string,error?:string,outcome?:'approved'|'changes_requested'|'handoff',inputCandidate?:CampCandidate,candidate?:CampCandidate,questionId?:string,changeSet?:CampChangeSet,verification?:CampVerificationReport,integration?:CampIntegrationReport}} CampCompletion */
/** @typedef {{key:string,title:string,description:string,acceptance:string,verification:string}} CampPlanItem */
/** @typedef {{revision:1,summary:string,tasks:CampPlanItem[]}} CampPlan */
/** @typedef {{summary:string,evidence:string|null,remaining:string[]}} CampFinalSummary */
/** @typedef {{runs:number,reviewRounds:number,elapsedSeconds:number,itemsTotal:number,itemsApproved:number,questionsAsked:number,questionsAnswered:number,reworks:number,humanAnswers:number,agentAnswers:number,roleAnswers?:number,manualRetries:number}} CampMetrics */
/** @typedef {{runId:string,outcome:'approved'|'changes_requested',evidence:string|string[],summary:string,candidate:CampReviewTarget|null,createdAt:string}} CampReviewRecord */
/** @typedef {CampPlanItem & {index:number,status:'pending'|'building'|'reviewing'|'approved'|'needs_attention',reworkCount:number,candidate:CampCandidate|null,reviews:CampReviewRecord[]}} CampWorkItem */
/** @typedef {{id:string,goalId:string,goalAttempt:number,taskId:string,originRunId:string|null,fromRole:CampRole,toRole:CampRole|null,needsHuman:boolean,status:CampQuestionStatus,content:string,answer:string|null,answerByRole:string|null,canAnswer:boolean,createdAt:string,answeredAt:string|null}} CampQuestion */
/** @typedef {{schemaVersion:1,roomId:string,goalId:string,goalAttempt?:number,workflow?:CampWorkflow,planMode?:CampPlanMode,status:CampGoalStatus,resultReady:boolean,candidate:CampCandidate|null,summary:string|null,evidence:string|null,remaining:string[],metrics:CampMetrics,verification?:{policy:CampVerificationPolicySnapshot|null,receipt:CampVerificationReceipt|null}|null,integration?:{input:CampIntegrationInput,receipt:CampIntegrationReceipt|null}|null}} CampResultManifest */
/** @typedef {{protocolVersions:number[],workerVersion:string,taskKinds:string[],refKinds:string[],capabilities:string[],harnesses?:CampHarnessIdentity[]}} CampWorkerDeclaration */
/** @typedef {{schemaVersion:1,supportedProtocolVersions:number[],capabilities:string[],taskKinds:string[],refKinds:string[]}} CampServerProtocol */
/** @typedef {{protocolVersion:number|null,workflow:CampWorkflow,taskKind:CampTaskKind,refKinds:string[],capabilities:string[],harnesses?:CampHarnessIdentity[]}} CampTaskRequirements */
/** @typedef {{status:'compatible'|'incompatible'|'legacy',code:'compatible'|'legacy_unversioned'|'protocol_required'|'protocol_unsupported'|'capability_missing',protocolVersion:number|null,missingTaskKinds:string[],missingRefKinds:string[],missingCapabilities:string[],missingHarnesses?:string[]}} CampWorkerCompatibility */
/** @typedef {{version:number,declaration:CampWorkerDeclaration,requirements:CampTaskRequirements}} CampNegotiatedProtocol */
/** @typedef {{id:string,sha256:string}} CampHarnessIdentity */
/** @typedef {{id:string,label:string,argv:string[],timeoutMs:number,harness?:CampHarnessIdentity}} CampVerificationCheck */
/** @typedef {{id:string,revision:number,name:string,checks:CampVerificationCheck[],maxRepairAttempts:number}} CampVerificationPolicy */
/** @typedef {{policy:CampVerificationPolicy,digest:string}} CampVerificationPolicySnapshot */
/** @typedef {{id:string,argv:string[],exitCode:number|null,signal:string|null,timedOut:boolean,oomKilled:boolean,durationMs:number,stdout:string,stderr:string,outputTruncated:boolean}} CampVerificationCheckResult */
/** @typedef {{candidate:CampCandidate,policyDigest:string,checks:CampVerificationCheckResult[]}} CampVerificationReport */
/** @typedef {CampVerificationReport & {schemaVersion:1,status:'passed'|'failed',runId:string,operationId:string,verifiedAt:string}} CampVerificationReceipt */
/** @typedef {{key:string,runId:string,epoch:number,candidate:CampCandidate}} CampIntegrationParent */
/** @typedef {{schemaVersion:1,algorithm:'layerfs-three-way-v1',policy:'reject-overlap-v1',base:CampCandidate,parents:[CampIntegrationParent,CampIntegrationParent]}} CampIntegrationInput */
/** @typedef {{path:string,reason:'overlap'|'delete_modify'|'structural'|'policy_path'|'unsupported'}} CampIntegrationConflict */
/** @typedef {{schemaVersion:1,inputDigest:string,algorithm:'layerfs-three-way-v1',policy:'reject-overlap-v1',status:'merged'|'conflict'|'rejected',candidate:CampCandidate|null,conflicts:CampIntegrationConflict[],truncated:boolean}} CampIntegrationReport */
/** @typedef {CampIntegrationReport & {runId:string,operationId:string,integratedAt:string}} CampIntegrationReceipt */
/** @typedef {'queued'|'running'|'completed'|'failed'|'cancelled'|'blocked'} CampOperationStatus */
/** @typedef {{type:'file',mode:number,size:number,sha256:string}|{type:'directory',mode:number,size:number}|{type:'symlink',mode:number,size:number,target:string}} CampChangeSide */
/** @typedef {{path:string,change:'added'|'modified'|'deleted'|'type_changed',before:CampChangeSide|null,after:CampChangeSide|null,binary:boolean,modeChanged:boolean,patch:string|null,patchTruncated:boolean,previewReason:string|null}} CampChangeEntry */
/** @typedef {{schemaVersion:1,base:CampCandidate,target:CampCandidate,entries:CampChangeEntry[],truncated:boolean,stats:{added:number,modified:number,deleted:number,typeChanged:number}}} CampChangeSet */
/** @typedef {typeof CAMP_PREFLIGHT_CHECK_IDS[number]} CampPreflightCheckId */
/** @typedef {{id:CampPreflightCheckId,status:'passed'|'failed'|'skipped',code:string}} CampPreflightCheck */
/** @typedef {{schemaVersion:1,workerVersion:string,mode:'agent'|'verification',modelConfigured:boolean,toolchainDigest:string|null,imageId:string|null,checks:CampPreflightCheck[]}} CampPreflightReport */
