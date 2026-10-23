import { CAMP_PREFLIGHT_CHECK_IDS, CAMP_WORKER_VERSION, parsePreflightReport, parseServerProtocol } from '../../camp-protocol/src/index.js';
import { resourcePolicy, storageCapacity } from './resource-policy.mjs';
import { checkedServerCapabilities, selectWorkerDeclaration } from './worker-protocol.mjs';
import { hostname } from 'node:os';

const check = (id, status, code) => ({ id, status, code });
/** Match the server's trimmed identity without silently rebinding an existing
 * journal or lock to a different worker after configuration changes. */
export function workerIdForEnvironment(env = process.env) {
  const id = env.CAMP_WORKER_ID ?? `camp-${hostname()}`;
  if (typeof id !== 'string' || !id || id.length > 200 || id.trim() !== id || /[\u0000-\u001f\u007f]/.test(id)) throw Object.assign(new Error('Camp worker ID must be a nonempty bounded identity without surrounding whitespace or control characters'), { code: 'camp_worker_configuration', status: 409 });
  return id;
}
export function workerApiUrl(env = process.env) {
  const fail = () => Object.assign(new Error('Camp API URL must be an HTTP origin or base path without credentials, query or fragment'), { code: 'camp_api_configuration', status: 409 });
  const configured = env.CAMP_API_URL ?? 'http://127.0.0.1:3001';
  if (typeof configured !== 'string') throw fail();
  // Preserve the existing journal identity byte-for-byte, including host case,
  // explicit ports and base paths. Parsing is for validation, not normalization.
  const raw = configured.replace(/\/$/, '');
  let url;
  try { url = new URL(raw); } catch { throw fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || raw.includes('?') || raw.includes('#')) throw fail();
  return raw;
}
export function workerApiRequest(env = process.env) {
  const raw = workerApiUrl(env);
  return async (path, body) => {
    if (!env.CAMP_WORKER_TOKEN) throw Object.assign(new Error('Camp room credential is required'), { code: 'camp_auth_required', status: 401 });
    let response;
    try { response = await fetch(`${raw}/api/camp/worker${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${env.CAMP_WORKER_TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000), redirect: 'error' }); }
    catch { throw Object.assign(new Error('Camp worker API transport failed'), { code: 'camp_api_transport' }); }
    if (!response.ok) {
      const value = await response.json().catch(() => null);
      const code = typeof value?.code === 'string' && /^[a-z_]{1,80}$/.test(value.code) ? value.code : response.status === 401 ? 'camp_auth_required' : 'camp_api_unavailable';
      throw Object.assign(new Error('Camp worker API rejected the request'), { status: response.status, code });
    }
    try { return await response.json(); }
    catch { throw Object.assign(new Error('Camp worker API response was interrupted'), { code: 'camp_api_transport' }); }
  };
}

/** Reads local prerequisites and the room configuration without allocating a
 * run. Reporting is an explicit small control-side mutation, never a claim. */
export async function inspectWorker({ runtime, env = process.env, request, report = false, localChecks, capacity = storageCapacity, setup: initialSetup, requireAgent = false, executionPool } = {}) {
  const workerId = workerIdForEnvironment(env);
  const requestApi = request ?? workerApiRequest(env), mode = requireAgent || Boolean(env.DEEPSEEK_API_KEY) ? 'agent' : 'verification';
  const modelConfigured = Boolean(env.DEEPSEEK_API_KEY?.trim());
  const facts = new Map(CAMP_PREFLIGHT_CHECK_IDS.map(id => [id, check(id, 'skipped', 'not_checked')]));
  let setup = initialSetup, apiAvailable = false, apiFailure = null, protocolVersion, toolchainDigest = null, imageId = null;
  try {
    setup ??= await requestApi('/setup');
    if (!setup || typeof setup.roomId !== 'string' || !/^[a-f0-9]{64}$/.test(setup.projectDigest ?? '') || !setup.project || typeof setup.project.name !== 'string') throw Object.assign(new Error('Invalid setup response'), { code: 'camp_setup_invalid', status: 409 });
    const protocol = parseServerProtocol(await requestApi('/protocol'));
    const { protocol: declaration, version } = selectWorkerDeclaration(protocol, { hasModel: mode === 'agent', executionPool });
    protocolVersion = version;
    checkedServerCapabilities(protocol, declaration);
    apiAvailable = true; facts.set('api', check('api', 'passed', 'authenticated'));
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : undefined;
    const code = typeof error.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'camp_api_unavailable';
    // Operational metadata stays outside the wire self-report. In particular,
    // retain no raw API body, URL, exception message or process output.
    apiFailure = { ...(status ? { status } : {}), code, retryable: !status || status >= 500 || [408, 429].includes(status) };
    facts.set('api', check('api', 'failed', 'api_unavailable'));
  }
  try {
    const runChecks = localChecks ?? (await import('./local-doctor.mjs')).runLocalChecks;
    const local = await runChecks({ runtime, env, sourcePath: setup?.project?.repoPath, protocolVersion });
    for (const item of local.checks) if (facts.has(item.id) && !['api', 'resource_policy', 'model'].includes(item.id)) facts.set(item.id, item);
    toolchainDigest = local.toolchainDigest ?? null; imageId = local.imageId ?? null;
  } catch { facts.set('toolchain', check('toolchain', 'failed', 'local_checks_failed')); }
  try {
    const policy = resourcePolicy(env);
    facts.set('resource_policy', check('resource_policy', 'passed', 'bounded'));
    try { await capacity(runtime, policy); facts.set('capacity', check('capacity', 'passed', 'available')); }
    catch (error) { facts.set('capacity', check('capacity', 'failed', error.code === 'camp_capacity_low' ? 'capacity_low' : 'capacity_unavailable')); }
  } catch { facts.set('resource_policy', check('resource_policy', 'failed', 'invalid_resource_policy')); }
  facts.set('model', mode === 'verification' ? check('model', 'skipped', 'verification_only') : check('model', modelConfigured ? 'passed' : 'failed', modelConfigured ? 'configured_not_tested' : 'model_not_configured'));
  const result = parsePreflightReport({ schemaVersion: 1, workerVersion: CAMP_WORKER_VERSION, mode, modelConfigured, toolchainDigest, imageId, checks: [...facts.values()] });
  let reported = false;
  if (report && apiAvailable) {
    await requestApi('/preflight', { workerId, projectDigest: setup.projectDigest, report: result });
    reported = true;
  }
  return { report: result, setup: apiAvailable ? setup : null, ready: !result.checks.some(item => item.status === 'failed' || item.code === 'not_checked'), reported, apiFailure };
}
