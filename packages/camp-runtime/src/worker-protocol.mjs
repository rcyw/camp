import { resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  CAMP_AGENT_TASK_KINDS, CAMP_TASK_KINDS, CAMP_CAPABILITIES_V1, CAMP_CAPABILITIES_V2,
  createWorkerDeclaration, parseWorkerDeclaration, parseServerProtocol,
  getTaskRequirements, getPluginTaskRequirements, checkWorkerCompatibility, parseExecutionPool,
} from '../../camp-protocol/src/index.js';
import { loadVerificationHarnesses } from './verification.mjs';

export function protocolFailure(message, code = 'protocol_unsupported') {
  return Object.assign(new Error(message), { code, status: 426 });
}
/** Specialized workers leave other known task kinds for another executor. */
export function unmatchedTaskKind(value, declaration) {
  const required = value.requirements;
  return Boolean(value.compatibility?.status === 'incompatible' && value.compatibility.code === 'capability_missing'
    && required && declaration.protocolVersions.includes(required.protocolVersion)
    && value.compatibility.protocolVersion === required.protocolVersion
    && CAMP_TASK_KINDS.includes(required.taskKind) && !declaration.taskKinds.includes(required.taskKind));
}
export function checkedServerCapabilities(value, declaration = createWorkerDeclaration()) {
  const server = parseServerProtocol(value);
  for (const field of ['capabilities', 'taskKinds', 'refKinds']) {
    const required = declaration[field];
    const missing = required.filter(item => !server[field].includes(item));
    if (missing.length) throw protocolFailure(`Camp server is missing ${field}: ${missing.join(', ')}`, 'capability_missing');
  }
  return server;
}
/** The same selected declaration is used by doctor and actual allocation. */
export function selectWorkerDeclaration(server, { hasModel = true, harnesses = [], executionPool } = {}) {
  let protocol = createWorkerDeclaration();
  // A serial process cannot accidentally offer a protocol that requires a
  // coordinated recovery barrier and two bounded execution lanes.
  protocol.protocolVersions = protocol.protocolVersions.filter(version => version <= (executionPool ? 4 : 3));
  protocol.capabilities = protocol.capabilities.filter(capability => capability !== 'bounded-pair.v1');
  if (executionPool) {
    protocol.executionPool = parseExecutionPool(executionPool);
    protocol.capabilities.push('bounded-pair.v1');
    if (!server.supportedProtocolVersions.includes(4)) throw protocolFailure('The server does not support bounded pool execution');
  }
  const version = Math.max(...server.supportedProtocolVersions.filter(item => protocol.protocolVersions.includes(item)));
  if (!Number.isFinite(version) || (!hasModel && version < 2)) throw protocolFailure('No supported execution protocol is available for this worker');
  if (version === 1) protocol = { ...protocol, protocolVersions: [1], taskKinds: [...CAMP_AGENT_TASK_KINDS], capabilities: [...CAMP_CAPABILITIES_V1] };
  else if (version === 2) protocol = { ...protocol, protocolVersions: [1, 2], taskKinds: protocol.taskKinds.filter(kind => kind !== 'integration'), capabilities: [...CAMP_CAPABILITIES_V2] };
  if (!hasModel) {
    protocol.taskKinds = version >= 3 ? ['verification', 'integration'] : ['verification'];
    protocol.capabilities = ['layerfs.candidate.v1', 'candidate-diff.v1', 'trusted-verification.v1', ...(version >= 3 ? ['trusted-integration.v1'] : []), ...(executionPool ? ['bounded-pair.v1'] : [])];
  }
  if (version >= 2 && harnesses.length) protocol.harnesses = harnesses.map(({ id, sha256 }) => ({ id, sha256 }));
  return { protocol, version };
}
export async function negotiateWorker({ request, pluginPath, env = process.env, executionPool }) {
  try {
    const server = parseServerProtocol(await request('/protocol'));
    const harnesses = await loadVerificationHarnesses(env);
    const hasModel = Boolean(env.DEEPSEEK_API_KEY);
    const { protocol, version } = selectWorkerDeclaration(server, { hasModel, harnesses, executionPool });
    checkedServerCapabilities(server, protocol);
    if (!hasModel) return { server, protocol, harnesses };
    let plugin;
    try {
      const file = await open(resolve(pluginPath, 'protocol.json'), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid descriptor file');
        plugin = parseWorkerDeclaration(JSON.parse(await file.readFile('utf8')));
      } finally { await file.close(); }
    } catch { throw protocolFailure('Selected DSH plugin lacks a valid static protocol declaration', 'plugin_protocol_required'); }
    for (const taskKind of CAMP_AGENT_TASK_KINDS) {
      const result = checkWorkerCompatibility(plugin, getPluginTaskRequirements(getTaskRequirements({ protocolVersion: version, workflow: 'serial', taskKind, inputCandidate: null })));
      if (result.status !== 'compatible') throw protocolFailure(`Selected DSH plugin does not support ${taskKind} (${result.code})`, result.code);
    }
    return { server, protocol, harnesses };
  } catch (error) {
    if (error.code === 'camp_api_transport' || error.status >= 500 || [408, 429].includes(error.status)) throw error;
    throw protocolFailure(`Worker capability negotiation failed: ${error.message}`, error.code ?? 'protocol_unsupported');
  }
}
export function assertClaimCompatibility(value, claim, declaration) {
  const compatibility = value.compatibility;
  if (!compatibility || compatibility.status !== 'compatible' || compatibility.code !== 'compatible' || !declaration.protocolVersions.includes(compatibility.protocolVersion) || ['missingTaskKinds', 'missingRefKinds', 'missingCapabilities', ...(compatibility.protocolVersion >= 2 ? ['missingHarnesses'] : [])].some(key => !Array.isArray(compatibility[key]) || compatibility[key].length)) throw protocolFailure(`Camp did not confirm a compatible claim (${compatibility?.code ?? 'missing_compatibility'})`, compatibility?.code ?? 'protocol_required');
  const negotiated = claim.workerProtocol;
  if (!negotiated || negotiated.version !== compatibility.protocolVersion || claim.protocolVersion !== negotiated.version) throw protocolFailure('Claim lacks a supported original negotiated protocol snapshot', 'protocol_required');
  const original = parseWorkerDeclaration(negotiated.declaration);
  const requirements = getTaskRequirements({ protocolVersion: compatibility.protocolVersion, workflow: claim.workflow, taskKind: claim.taskKind, inputCandidate: claim.inputCandidate, verificationPolicy: claim.verificationPolicy });
  const recorded = negotiated.requirements;
  const same = (field) => Array.isArray(recorded?.[field]) && recorded[field].length === requirements[field].length && requirements[field].every(item => recorded[field].includes(item));
  const sameHarnesses = compatibility.protocolVersion < 2 || (Array.isArray(recorded?.harnesses) && recorded.harnesses.length === requirements.harnesses.length && requirements.harnesses.every(item => recorded.harnesses.some(other => other.id === item.id && other.sha256 === item.sha256)));
  if (!recorded || recorded.protocolVersion !== requirements.protocolVersion || recorded.workflow !== requirements.workflow || recorded.taskKind !== requirements.taskKind || !same('refKinds') || !same('capabilities') || !sameHarnesses || recorded.executionPoolRequired !== requirements.executionPoolRequired) throw protocolFailure('Claim changed its original execution requirements', 'protocol_unsupported');
  if (requirements.executionPoolRequired) {
    if (JSON.stringify(parseExecutionPool(original.executionPool)) !== JSON.stringify(parseExecutionPool(declaration.executionPool)) || (claim.workerId !== undefined && !declaration.executionPool.workerIds.includes(claim.workerId))) throw protocolFailure('Claim changed its original execution pool', 'pool_mismatch');
  }
  for (const offered of [declaration, original]) {
    const result = checkWorkerCompatibility(offered, requirements);
    if (result.status !== 'compatible') throw protocolFailure(`Claim requires an unsupported execution contract (${result.code})`, result.code);
  }
}
