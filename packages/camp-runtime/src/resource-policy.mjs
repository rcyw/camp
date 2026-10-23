import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

const MiB = 1024 ** 2;
const invalid = () => Object.assign(new Error('Invalid Camp resource policy; use bounded integer CPU, memory, PID and free-space limits'), { code: 'camp_resource_policy', status: 409 });
function number(env, key, fallback, minimum, maximum) {
  const raw = env[key];
  if (raw !== undefined && !/^[0-9]+$/.test(raw)) throw invalid();
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalid();
  return value;
}

/** Host-operator policy; never supplied by a role tool or a project file. */
export function resourcePolicy(env = process.env) {
  return Object.freeze({ schemaVersion: 1,
    cpuMillis: number(env, 'CAMP_AGENT_CPU_MILLIS', 2000, 250, 64000),
    memoryBytes: number(env, 'CAMP_AGENT_MEMORY_MIB', 2048, 512, 65536) * MiB,
    pidsLimit: number(env, 'CAMP_AGENT_PIDS_LIMIT', 256, 64, 4096),
    minFreeBytes: number(env, 'CAMP_MIN_FREE_MIB', 1024, 64, 16777216) * MiB,
  });
}
export function checkedResourcePolicy(value) {
  const keys = ['schemaVersion', 'cpuMillis', 'memoryBytes', 'pidsLimit', 'minFreeBytes'];
  if (!value || value.schemaVersion !== 1 || Object.keys(value).some(key => !keys.includes(key)) || !Number.isSafeInteger(value.memoryBytes) || value.memoryBytes % MiB || !Number.isSafeInteger(value.minFreeBytes) || value.minFreeBytes % MiB) throw invalid();
  const checked = resourcePolicy({ CAMP_AGENT_CPU_MILLIS: String(value.cpuMillis), CAMP_AGENT_MEMORY_MIB: String(value.memoryBytes / MiB), CAMP_AGENT_PIDS_LIMIT: String(value.pidsLimit), CAMP_MIN_FREE_MIB: String(value.minFreeBytes / MiB) });
  return checked;
}

/** Admission checks both journal and Docker storage filesystems without writes. */
export async function storageCapacity(runtime, policy, { filesystem = statfs } = {}) {
  const selected = checkedResourcePolicy(policy);
  try { return await inspectStorageCapacity(runtime, selected, filesystem); }
  catch (cause) {
    if (cause.code === 'camp_capacity_low') throw cause;
    throw Object.assign(new Error('Camp storage capacity cannot be checked', { cause }), { code: 'camp_capacity_unavailable', status: 409 });
  }
}
async function inspectStorageCapacity(runtime, selected, filesystem) {
  const answer = await runtime.dockerCall(['info', '--format', '{{json .DockerRootDir}}'], { timeout: 5000 });
  const root = JSON.parse(answer.stdout);
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0')) throw Object.assign(new Error('Cannot identify local Docker storage for capacity admission'), { code: 'camp_capacity_unavailable', status: 409 });
  const paths = [...new Set([runtime.home, root])];
  let minimum;
  for (const path of paths) {
    let selectedPath = path, facts;
    while (true) {
      try { facts = await filesystem(selectedPath, { bigint: true }); break; }
      catch (error) {
        // A read-only first-start doctor must not create the journal home.
        // Its nearest existing parent identifies the filesystem that would
        // hold it. Docker storage must already exist, even when it equals
        // the configured home; an absent Docker root is not admission.
        if (path === root || error.code !== 'ENOENT' || dirname(selectedPath) === selectedPath) throw error;
        selectedPath = dirname(selectedPath);
      }
    }
    const available = facts.bavail * facts.bsize;
    if (available < BigInt(selected.minFreeBytes)) throw Object.assign(new Error('Camp storage is below the configured free-space floor'), { code: 'camp_capacity_low', status: 409 });
    minimum = minimum === undefined || available < minimum ? available : minimum;
  }
  return { checkedFilesystems: paths.length, minimumAvailableBytes: String(minimum), requiredFreeBytes: selected.minFreeBytes };
}

/** LayerFS starts the filesystem daemon first. Enforce and read back cgroups
 * before an agent/profile can be installed or executed in that container. */
export async function enforceAgentPolicy(runtime, containerId, policy, { signal } = {}) {
  if (!/^[a-f0-9]{64}$/.test(containerId ?? '')) throw invalid();
  const selected = checkedResourcePolicy(policy);
  await runtime.dockerCall(['update', '--cpus', String(selected.cpuMillis / 1000), '--memory', String(selected.memoryBytes), '--memory-swap', String(selected.memoryBytes), '--pids-limit', String(selected.pidsLimit), containerId], { signal, timeout: 10000 });
  const answer = await runtime.dockerCall(['inspect', '--format', '{{json .HostConfig}}', containerId], { signal, timeout: 5000 });
  const facts = JSON.parse(answer.stdout);
  if (facts.NanoCpus !== selected.cpuMillis * 1000000 || facts.Memory !== selected.memoryBytes || facts.MemorySwap !== selected.memoryBytes || facts.PidsLimit !== selected.pidsLimit) throw Object.assign(new Error('Docker did not apply the exact Camp agent resource policy'), { code: 'camp_resource_enforcement_failed', status: 409 });
  return { policy: selected, observed: { cpuMillis: facts.NanoCpus / 1000000, memoryBytes: facts.Memory, memorySwapBytes: facts.MemorySwap, pidsLimit: facts.PidsLimit } };
}
