import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkerLock } from './durable-state.mjs';
import { checkedResourcePolicy, storageCapacity } from './resource-policy.mjs';

const MiB = 1024 ** 2;
export const managerFailure = (message, code = 'camp_pool_unsafe') => Object.assign(new Error(message), { code, status: 409 });
export const poolResources = policy => {
  const p = checkedResourcePolicy(policy);
  // A build keeps its main sandbox while one snapshot helper runs. Verification
  // has one fresh 1 CPU / 512 MiB / 128 PID check, after its helper has stopped.
  return { maxContainers: 4, cpuMillis: 2 * Math.max(2 * p.cpuMillis, 1000), memoryBytes: 4 * p.memoryBytes, pidsLimit: 2 * Math.max(2 * p.pidsLimit, 128) };
};
export async function dockerHostFacts(runtime) {
  let facts;
  try { facts = JSON.parse((await runtime.dockerCall(['info', '--format', '{{json .}}'], { timeout: 5000 })).stdout); }
  catch { throw managerFailure('Docker host identity cannot be checked', 'camp_host_unavailable'); }
  if (typeof facts.ID !== 'string' || !facts.ID || facts.ID.length > 256 || /[\x00-\x20\x7f]/.test(facts.ID) || !Number.isSafeInteger(facts.NCPU) || facts.NCPU < 1 || !Number.isSafeInteger(facts.MemTotal) || facts.MemTotal < 1) throw managerFailure('Docker host identity or capacity is invalid', 'camp_host_unavailable');
  return facts;
}
/** One production manager per Docker daemon and Unix user, including serial
 * workers. The lock lives outside runtime homes so another home cannot bypass it. */
export async function acquireHostManager({ runtime, onLost = () => {}, lockRoot, acquireLock = acquireWorkerLock }) {
  const facts = await dockerHostFacts(runtime);
  const lock = await acquireLock(`docker-host-manager:${facts.ID}`, { root: lockRoot ?? join(tmpdir(), `camp-host-managers-${process.getuid()}`), onLost });
  let released = false;
  return { facts, async release() { if (!released) { released = true; await lock.release(); } } };
}
export async function admitPoolHost({ runtime, policy, resources = poolResources(policy), facts, env = process.env, pidLimit, capacity = storageCapacity }) {
  const raw = env.CAMP_POOL_HOST_MEMORY_RESERVE_MIB ?? '1024';
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 512 || Number(raw) > 65536) throw managerFailure('Invalid pool host memory reserve', 'camp_resource_policy');
  facts ??= await dockerHostFacts(runtime);
  if (facts.NCPU * 1000 < resources.cpuMillis || facts.MemTotal < resources.memoryBytes + Number(raw) * MiB) throw managerFailure('Docker host cannot reserve the complete two-lane CPU and memory policy', 'camp_pool_capacity');
  if (pidLimit === undefined) {
    try {
      const limits = await Promise.all(['/proc/sys/kernel/pid_max', '/proc/sys/kernel/threads-max', '/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max'].map(async (path, index) => {
        let value;
        try { value = (await readFile(path, 'utf8')).trim(); }
        catch (error) { if (index >= 2 && error.code === 'ENOENT') return Infinity; throw error; }
        return value === 'max' ? Infinity : /^[0-9]+$/.test(value) ? Number(value) : NaN;
      }));
      pidLimit = Math.min(...limits);
    } catch { throw managerFailure('Host PID capacity cannot be checked', 'camp_pool_capacity'); }
  }
  if (!(pidLimit >= resources.pidsLimit + 64)) throw managerFailure('Host PID capacity cannot reserve two lanes and helpers', 'camp_pool_capacity');
  // Two 512 MiB materializations per lane may coexist in private scratch.
  await capacity(runtime, { ...checkedResourcePolicy(policy), minFreeBytes: policy.minFreeBytes + 4 * 512 * MiB });
  return { resources, memoryReserveBytes: Number(raw) * MiB, pidLimit: Number.isFinite(pidLimit) ? pidLimit : null };
}
export async function attemptContainers(runtime) {
  const answer = await runtime.dockerCall(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}', '--filter', 'name=^/camp-mvp-run-'], { timeout: 10000 });
  return answer.stdout.trim().split('\n').filter(Boolean).map(line => {
    const [id, name, extra] = line.split(' ');
    if (!/^[a-f0-9]{64}$/.test(id) || !/^camp-mvp-run-[a-f0-9]{16}-/.test(name ?? '') || extra !== undefined) throw managerFailure('Docker returned an invalid managed container identity');
    return { id, name };
  });
}
/** The process lock cannot prove that containers from a killed manager stopped.
 * An unpooled worker has no authority over another journal's resources. */
export async function assertNoManagedContainers(runtime) {
  if ((await attemptContainers(runtime)).length) throw managerFailure('Managed containers remain from another or interrupted execution; recover their original manager before allocating new work', 'camp_foreign_resources');
}
/** Reservations survive in each lane's journal; this in-memory guard never
 * treats process exit or lease expiry as evidence of physical cleanup. */
export class PoolAdmission {
  constructor({ runtime, onFatal = () => {}, resources }) {
    this.runtime = runtime; this.onFatal = onFatal; this.resources = resources;
    this.attempts = new Map(); this.creating = Promise.resolve(); this.closed = false; this.generation = 0;
  }
  fail(error) { this.closed = true; this.onFatal(error); throw error; }
  assertOpen() { if (this.closed) throw managerFailure('Pool is draining; no new work is permitted', 'camp_pool_stopped'); }
  async observe() {
    // Docker's response and the reservations must describe the same registry
    // generation. A sibling may finish (or claim) while `docker ps` is in flight.
    for (;;) {
      this.assertOpen();
      const generation = this.generation;
      const existing = await attemptContainers(this.runtime);
      this.assertOpen();
      if (generation === this.generation) return existing;
    }
  }
  async beforeClaim() {
    const existing = await this.observe();
    if (existing.length > this.resources.maxContainers || existing.some(item => ![...this.attempts.keys()].some(key => item.name.startsWith(key))) || [...this.attempts.keys()].some(key => existing.filter(item => item.name.startsWith(key)).length > 2)) return this.fail(managerFailure('Physical resources no longer match the active pool reservations'));
  }
  hold(prefix, workerId) {
    this.assertOpen();
    if (!/^camp-mvp-run-[a-f0-9]{16}-$/.test(prefix) || this.attempts.has(prefix) || this.attempts.size >= 2 || [...this.attempts.values()].includes(workerId)) return this.fail(managerFailure('Pool attempt reservation is invalid'));
    this.attempts.set(prefix, workerId);
    this.generation++;
  }
  async finish(prefix, record) {
    if (!record.cleanupKnown || record.requiresInspection || record.phase === 'ownership_conflict' || (await attemptContainers(this.runtime)).some(item => item.name.startsWith(prefix))) return this.fail(managerFailure('An attempt did not confirm physical cleanup; pool admission remains closed'));
    this.attempts.delete(prefix);
    this.generation++;
  }
  async withContainer(prefix, create) {
    const previous = this.creating;
    let release;
    this.creating = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      this.assertOpen();
      const existing = await this.observe();
      const owner = [...this.attempts.keys()].find(key => prefix.startsWith(key));
      if (!owner) return this.fail(managerFailure('Container creation has no reserved attempt'));
      if (existing.some(item => ![...this.attempts.keys()].some(key => item.name.startsWith(key))) || existing.length >= this.resources.maxContainers || existing.filter(item => item.name.startsWith(owner)).length >= 2) return this.fail(managerFailure('Owned container capacity is exhausted or contains foreign resources'));
      return await create();
    } finally { release(); }
  }
}
export const storageIdentity = (storeId, dockerId) => createHash('sha256').update(`camp-storage-v1\n${storeId}\n${dockerId}`).digest('hex');
