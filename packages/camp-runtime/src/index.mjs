import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, chmod, mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSource } from './source-snapshot.mjs';
import { atomicJson, acquireWorkerLock, privateDirectory } from './durable-state.mjs';
import { tmpdir } from 'node:os';
import { checkedCandidate, projectIdentity } from './candidate.mjs';
import { quiesceAgentScript } from './quiesce-agent.mjs';
import { packPlugin } from './plugin-package.mjs';
import { cleanupAttemptScratch } from './attempt-scratch.mjs';
import { archiveSession as archiveSessionEvidence } from './session-archive.mjs';
import { defaultBundle, bundlePaths, loadToolchain } from './toolchain.mjs';
import { resourcePolicy, checkedResourcePolicy, enforceAgentPolicy } from './resource-policy.mjs';

const execute = promisify(execFile);
const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const SDK_CALL = fileURLToPath(new URL('./sdk-call.mjs', import.meta.url));
const short = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const nameOf = value => `p-${short(value)}`;
const exists = path => access(path).then(() => true, () => false);
const json = path => readFile(path, 'utf8').then(JSON.parse);
const save = atomicJson;
async function assertProjectIdentity(project, source, imageId) {
  if (source && project.sourcePath !== await realpath(source)) throw new Error('Project source identity differs from its installed Store');
  if (project.imageId !== imageId) throw new Error('Project runtime image differs from its recorded deployment');
}

/** Local Linux runtime. Long-lived worker secrets never enter its run descriptors. */
export class CampRuntime {
  constructor(options = {}) {
    this.home = resolve(options.home ?? process.env.CAMP_RUNTIME_HOME ?? join(PACKAGE, '.local/state'));
    const source = options.layerfsSource ?? process.env.LAYERFS_SOURCE;
    this.source = source ? resolve(source) : null;
    this.toolchainBundle = options.toolchainBundle ?? process.env.CAMP_TOOLCHAIN_BUNDLE ?? (source ? null : defaultBundle);
    const paths = this.toolchainBundle ? bundlePaths(this.toolchainBundle) : null;
    this.sdkEntry = paths?.sdkEntry ?? join(this.source, 'sdk/js/src/index.js');
    this.native = resolve(options.native ?? paths?.native ?? join(PACKAGE, '.local/layerfs/layerfs.node'));
    this.daemon = resolve(options.daemon ?? paths?.daemon ?? join(PACKAGE, '.local/layerfs/layerfs-daemon'));
    this.imageId = options.imageId ?? process.env.CAMP_RUNTIME_IMAGE;
    this.docker = options.docker ?? '/var/run/docker.sock';
    this.dshArchive = options.dshArchive ?? process.env.CAMP_DSH_ARCHIVE ?? paths?.dshArchive ?? join(PACKAGE, '.local/dsh-runtime.tar');
    this.projects = new Map();
    // Defer validation until new execution so a bad replacement policy cannot
    // prevent recovery and cleanup of an already recorded attempt.
    this.resourcePolicy = options.resources ?? null;
  }

  async sdkConfig(config) {
    if (this.toolchainBundle) {
      this.toolchainReady ??= loadToolchain(this.toolchainBundle).catch(error => { this.toolchainReady = null; throw error; });
      this.toolchain = await this.toolchainReady;
      if (this.native !== this.toolchain.native || this.daemon !== this.toolchain.daemon || this.dshArchive !== this.toolchain.dshArchive) throw new Error('Bundle artifacts cannot be overridden independently; select an explicit development checkout instead');
      // Old local project records retain their paths for audit/recovery. A
      // selected bundle must actually supply the native code and daemon we
      // verified, rather than quietly executing that record's old binaries.
      return { ...config, native: this.native, daemon: this.daemon };
    }
    return config;
  }

  async ready() {
    await this.sdkConfig({});
    if (!this.imageId) this.imageId = (await json(join(PACKAGE, '.local/image.json'))).imageId;
    if (!/^sha256:[a-f0-9]{64}$/.test(this.imageId)) throw new Error('An exact local runtime image ID is required');
    await Promise.all([access(this.native), access(this.daemon), access(this.sdkEntry)]);
    await privateDirectory(this.home);
    return this;
  }

  async loadProject(projectId, { roomId } = {}) {
    if (!projectIdentity.test(projectId ?? '')) throw new Error('Invalid local project identity');
    const project = await json(join(this.home, 'projects', projectId, 'project.json'));
    if (project.projectId !== projectId || project.volume !== `camp-mvp-${projectId}` || (roomId && project.externalId !== `room:${roomId}`)) throw new Error('Export project is not the requested room project');
    return project;
  }

  async verifyCandidate(project, candidate, { signal } = {}) {
    const selected = checkedCandidate(candidate, { projectId: project.projectId, imageId: project.imageId });
    const stat = await this.sdk(project, 'fs.stat', [selected.refId, '/'], project, { signal });
    if (stat.type !== 'dir' || stat.root !== candidate.rootId) throw new Error('Candidate root does not match the selected project Commit');
    return { ...selected, imageId: project.imageId };
  }

  async dockerCall(args, options = {}) {
    return execute('docker', ['-H', `unix://${this.docker}`, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
  }

  async sdk(project, method, args = [], config = project, { signal } = {}) {
    signal?.throwIfAborted();
    config = await this.sdkConfig(config);
    return new Promise((resolveResult, reject) => {
      const child = spawn('setpriv', ['--pdeathsig', 'KILL', process.execPath, SDK_CALL], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CAMP_SDK_OWNER_PID: String(process.pid), UV_THREADPOOL_SIZE: '64' } });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`LayerFS ${method} exceeded 90 seconds; its outcome requires inspection`), { cleanupKnown: false })); }, 90_000);
      const abort = () => { child.kill('SIGKILL'); reject(Object.assign(new Error(`LayerFS ${method} was interrupted; its outcome requires inspection`), { cleanupKnown: false })); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      child.stdin.on('error', error => reject(Object.assign(new Error(`LayerFS ${method} input transport failed`), { cleanupKnown: false, cause: error })));
      child.on('error', error => { clearTimeout(timeout); signal?.removeEventListener('abort', abort); reject(error); });
      child.on('exit', code => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        try {
          const answer = JSON.parse(stdout);
          if (answer.error) return reject(Object.assign(new Error(answer.error.message), answer.error));
          if (code !== 0) return reject(new Error(`LayerFS ${method} exited ${code}: ${stderr}`));
          resolveResult(answer.result);
        } catch (error) { reject(Object.assign(new Error(`LayerFS ${method} returned no valid result (${code}): ${stderr || error.message}`), { cleanupKnown: false })); }
      });
      child.stdin.end(JSON.stringify({ sdkEntry: this.sdkEntry, projectId: project.projectId, config, method, args }));
    });
  }

  async prepareProject({ projectId, sourcePath, repoPath, name, signal } = {}) {
    signal?.throwIfAborted();
    const externalId = projectId ?? name;
    if (!externalId) throw new Error('projectId is required');
    await this.ready();
    const dockerHost = await realpath(this.docker);
    const lock = await acquireWorkerLock(`project:${dockerHost}:${nameOf(externalId)}`, { root: join(tmpdir(), `camp-project-locks-${process.getuid()}`), waitMs: 110_000, signal });
    try { signal?.throwIfAborted(); return await this.prepareProjectExclusive({ externalId, sourcePath, repoPath, signal }); }
    finally { await lock.release(); }
  }

  async prepareProjectExclusive({ externalId, sourcePath, repoPath, signal }) {
    signal?.throwIfAborted();
    const id = nameOf(externalId);
    if (this.projects.has(id)) {
      const project = this.projects.get(id);
      await assertProjectIdentity(project, sourcePath ?? repoPath, this.imageId);
      return project;
    }
    const folder = join(this.home, 'projects', id);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const record = join(folder, 'project.json');
    if (await exists(record)) {
      const project = await json(record);
      await assertProjectIdentity(project, sourcePath ?? repoPath, this.imageId);
      this.projects.set(id, project);
      return project;
    }
    const volume = `camp-mvp-${id}`;
    const existingVolume = (await this.dockerCall(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'], { signal })).stdout.trim();
    if (existingVolume) throw new Error('Project volume exists without this runtime home project record; share CAMP_RUNTIME_HOME or inspect the interrupted initialization before importing');
    await this.dockerCall(['volume', 'create', '--label', 'camp.mvp=true', volume], { signal });
    const mountpoint = (await this.dockerCall(['volume', 'inspect', '--format', '{{.Mountpoint}}', volume], { signal })).stdout.trim();
    const sdkHome = join(folder, 'sdk-home');
    await mkdir(sdkHome, { recursive: true, mode: 0o700 });
    const project = { projectId: id, externalId, home: sdkHome, native: this.native, daemon: this.daemon, docker: this.docker, imageId: this.imageId, volume, storePath: join(mountpoint, 'global/store.sqlite'), prefix: `camp-mvp-project-${short(externalId)}-`, profile: 'Disposable' };
    let seed = sourcePath ?? repoPath;
    if (!seed) {
      seed = join(folder, 'seed');
      await mkdir(seed, { recursive: true });
      await writeFile(join(seed, 'README.md'), `# ${externalId}\n\nCamp shared project.\n`);
    }
    const staged = await stageSource(resolve(seed), join(folder, 'import-seed'), { signal });
    Object.assign(project, staged);
    await this.sdk(project, 'project.init', [staged.importPath], project, { signal });
    await save(record, project);
    this.projects.set(id, project);
    return project;
  }

  runIdentity(runId) {
    return { runId, prefix: `camp-mvp-run-${short(runId)}-`, folder: join(this.home, 'runs', short(runId)) };
  }

  async prepareRun({ project, projectId, sourcePath, runId, roleId, baseRef = 'main', owner, ownerPrefix, signal }) {
    signal?.throwIfAborted();
    if (!runId || !roleId) throw new Error('runId and roleId are required');
    const selected = project ?? await this.prepareProject({ projectId, sourcePath });
    const folder = join(this.home, 'runs', short(runId));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (await exists(join(folder, 'prepare.json'))) throw Object.assign(new Error('This attempt already has retained runtime state; inspect it before recovery'), { cleanupKnown: false });
    // Each attempt owns its discovery home. It therefore cannot be packed into
    // another role's Sandbox, while every daemon opens the same project Store.
    const runHome = join(folder, 'sdk-home');
    const projectHome = join(runHome, selected.projectId);
    await mkdir(projectHome, { recursive: true, mode: 0o700 });
    await copyFile(join(selected.home, selected.projectId, 'project.record'), join(projectHome, 'project.record'));
    await chmod(join(projectHome, 'project.record'), 0o600);
    if (ownerPrefix && !/^camp-mvp-run-[a-f0-9]{16}-$/.test(ownerPrefix)) throw new Error('Auxiliary resources require an original attempt prefix');
    const config = { ...selected, home: runHome, prefix: ownerPrefix ? `${ownerPrefix}aux-${short(runId)}-` : `camp-mvp-run-${short(runId)}-` };
    const branch = `run-${short(runId)}`;
    const resources = checkedResourcePolicy(this.resourcePolicy ?? resourcePolicy());
    const intent = { runId, roleId, branch, baseRef, config, owner, resources, phase: 'forking' };
    await save(join(folder, 'prepare.json'), intent);
    try {
      await this.sdk(selected, 'branch.fork', [branch, baseRef], config, { signal });
      intent.phase = 'mounting';
      await save(join(folder, 'prepare.json'), intent);
      const workspace = await this.sdk(selected, 'workspace.mount', [branch], config, { signal });
      Object.assign(intent, { phase: 'mounted', workspace });
      await save(join(folder, 'prepare.json'), intent);
      const containerId = (await this.dockerCall(['inspect', '--format', '{{.Id}}', `${config.prefix}${selected.projectId}-${workspace.sandbox}`], { signal })).stdout.trim();
      const resourceReceipt = await enforceAgentPolicy(this, containerId, resources, { signal });
      await save(join(folder, 'resource-policy.json'), resourceReceipt);
      const run = { projectId: selected.projectId, externalProjectId: selected.externalId, runId, roleId, branch, baseRef, mountRoot: workspace.root, mountBase: workspace.base, sandboxId: workspace.sandbox, containerId, workspacePath: workspace.path, imageId: workspace.image, config, folder, owner, profile: 'Disposable' };
      await save(join(folder, 'run.json'), run);
      return run;
    } catch (error) {
      // This discovery home and prefix belong only to this attempt. Even when
      // mount/inspect fails before a run descriptor exists, remove its containers.
      let cleanupKnown = error.cleanupKnown !== false;
      try { await this.cleanupAttempt(config.prefix, { timeout: signal?.aborted ? 5000 : 30000 }); }
      catch { cleanupKnown = false; }
      try { await save(join(folder, 'prepare-failed.json'), { at: new Date().toISOString(), phase: intent.phase, cleanupKnown, reason: error.message }); }
      catch { cleanupKnown = false; }
      throw Object.assign(error, { cleanupKnown });
    }
  }

  async cleanupAttempt(prefix, { timeout = 30000 } = {}) {
    if (!/^camp-mvp-run-[a-f0-9]{16}-(?:aux-[a-f0-9]{16}-)?$/.test(prefix)) throw new Error('Refusing cleanup without an owned run prefix');
    const list = await this.dockerCall(['ps', '-a', '--format', '{{.ID}} {{.Names}}', '--filter', `name=^/${prefix}`], { timeout });
    for (const line of list.stdout.trim().split('\n').filter(Boolean)) {
      const [id, name] = line.split(' ');
      if (!name?.startsWith(prefix) || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Docker returned an unexpected cleanup identity');
      await this.dockerCall(['rm', '-f', id], { timeout });
    }
    if ((await this.dockerCall(['ps', '-a', '-q', '--filter', `name=^/${prefix}`], { timeout })).stdout.trim()) throw new Error('Attempt containers remain after cleanup');
    await cleanupAttemptScratch(this.home, prefix);
  }

  async exec(run, command) {
    return this.sdk(run.config, 'workspace.exec', [{ sandbox: run.sandboxId, path: run.workspacePath }, command], run.config);
  }

  async pinInputCandidate(run, candidate, { signal } = {}) {
    const expected = candidate ? await this.verifyCandidate(run.config, candidate, { signal }) : null;
    // Capture the actual mounted view before DSH starts. A supplied authority
    // identity remains the input even if this checkpoint has another Commit ID.
    const checkpoint = await this.commitCandidate(run, { message: `Camp immutable input ${run.runId}`, signal });
    const input = expected ?? checkpoint;
    checkedCandidate(input, { projectId: run.projectId, imageId: run.imageId, requireImage: true });
    if (checkpoint.rootId !== input.rootId) throw new Error('Mounted workspace root differs from the immutable input candidate');
    run.forkRef = run.baseRef;
    run.baseRef = input.refId;
    run.inputCandidate = input;
    run.initialCheckpoint = checkpoint.refId;
    await save(join(run.folder, 'input-candidate.json'), input);
    await save(join(run.folder, 'run.json'), run);
    return input;
  }

  async commitCandidate(run, { message = `Camp candidate ${run.runId}`, force = false, signal } = {}) {
    const result = await this.sdk(run.config, 'workspace.commit', [{ sandbox: run.sandboxId, path: run.workspacePath }, message, force], run.config, { signal });
    const commitId = result.commit?.id ?? result.head;
    const rootId = result.commit?.root ?? result.root;
    let reference;
    if (commitId) reference = { refKind: 'commit', refId: commitId, commitId };
    else {
      const status = await this.sdk(run.config, 'workspace.status', [{ sandbox: run.sandboxId, path: run.workspacePath }], run.config, { signal });
      const layer = await this.sdk(run.config, 'fs.stat', [status.baseLayer, '/'], run.config, { signal });
      if (layer.root !== rootId) throw new Error('Unchanged workspace does not match its immutable initial Layer');
      reference = { refKind: 'layer', refId: status.baseLayer, layerId: status.baseLayer };
    }
    const artifact = checkedCandidate({ type: 'layerfs', projectId: run.projectId, branch: run.branch, ...reference, rootId, baseRef: run.baseRef, runId: run.runId, role: run.roleId, sandboxId: run.sandboxId, imageId: run.imageId, profile: 'Disposable' }, { requireImage: true, requireTagged: true });
    await save(join(run.folder, 'candidate.json'), { artifact, result });
    return artifact;
  }

  async releaseRun(run, { discard = false, signal } = {}) {
    await this.sdk(run.config, 'workspace.unmount', [{ sandbox: run.sandboxId, path: run.workspacePath }, discard], run.config, { signal });
    await this.dockerCall(['stop', '--time', '3', run.containerId], { signal });
    await this.dockerCall(['rm', run.containerId], { signal });
    await save(join(run.folder, 'released.json'), { at: new Date().toISOString(), discard });
  }

  async installDsh(run, archive = this.dshArchive) {
    try {
      await this.dockerCall(['exec', '--user', '501:20', run.containerId, 'test', '-f', '/opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js']);
      return;
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    if (!archive) throw new Error('CAMP_DSH_ARCHIVE is required for DSH execution');
    await this.dockerCall(['cp', resolve(archive), `${run.containerId}:/tmp/camp-dsh.tar`], { timeout: 90_000 });
    await this.dockerCall(['exec', '--user', '0:0', run.containerId, 'bash', '-c', 'tar -xf /tmp/camp-dsh.tar -C /opt/camp-dsh && rm /tmp/camp-dsh.tar && install -d -o 501 -g 20 /tmp/camp-dsh-home']);
  }

  async installPlugin(run, path) {
    const archive = join(run.folder, 'dsh-plugin.tar');
    const protocolArchive = join(run.folder, 'camp-protocol.tar');
    await packPlugin({ plugin: path, archive, protocolArchive });
    await this.dockerCall(['cp', archive, `${run.containerId}:/tmp/camp-plugin.tar`]);
    await this.dockerCall(['cp', protocolArchive, `${run.containerId}:/tmp/camp-protocol.tar`]);
    await this.dockerCall(['exec', '--user', '0:0', run.containerId, 'bash', '-c', 'mkdir -p /opt/camp-dsh-plugin /opt/camp-protocol && tar -xf /tmp/camp-plugin.tar -C /opt/camp-dsh-plugin && tar -xf /tmp/camp-protocol.tar -C /opt/camp-protocol && rm /tmp/camp-plugin.tar /tmp/camp-protocol.tar']);
    await this.dockerCall(['exec', '--user', '501:20', run.containerId, 'node', '/opt/camp-dsh-plugin/scripts/prepare-profile.mjs', '--home', '/tmp/camp-dsh-home', '--node-modules', '/opt/camp-dsh/node_modules', '--plugin', '/opt/camp-dsh-plugin']);
  }

  async abortRun(run, reason = 'cancelled', { timeout = 30000 } = {}) {
    // Container termination is owned by the trusted worker, never by an agent.
    // A killed filesystem incarnation is retained as aborted, not committed.
    await this.dockerCall(['stop', '--time', '3', run.containerId], { timeout });
    await this.dockerCall(['rm', run.containerId], { timeout });
    await save(join(run.folder, 'aborted.json'), { at: new Date().toISOString(), reason });
  }

  async archiveSession(run, { signal } = {}) {
    return archiveSessionEvidence({ runtime: this, run, signal });
  }

  async quiesceAgent(run, { signal } = {}) {
    if (!/^camp-mvp-run-[a-f0-9]{16}-$/.test(run.config?.prefix ?? '') || !/^[a-f0-9]{64}$/.test(run.containerId ?? '')) throw new Error('Quiescence requires an owned isolated attempt');
    await this.dockerCall(['exec', '--user', '0:0', '--workdir', '/', run.containerId, '/usr/local/bin/node', '-e', quiesceAgentScript], { timeout: 10_000, signal });
  }

  async sandboxApiUrl(run, apiUrl) {
    const url = new URL(apiUrl);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      url.hostname = await this.sandboxHostAddress(run);
    }
    return url.toString().replace(/\/$/, '');
  }

  async sandboxHostAddress(run) {
    const networks = JSON.parse((await this.dockerCall(['inspect', '--format', '{{json .NetworkSettings.Networks}}', run.containerId])).stdout);
    const gateways = [...new Set(Object.values(networks).map(network => network.Gateway).filter(Boolean))];
    if (gateways.length !== 1) throw new Error('The run container must have one unambiguous host gateway');
    return gateways[0];
  }

  launchSpec(run, { env = {}, args = [], profile = 'camp' } = {}) {
    const dockerArgs = ['-H', `unix://${this.docker}`, 'exec', '-i', '--user', '501:20', '--workdir', run.workspacePath];
    const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TZ', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
    Object.assign(environment, { HOME: '/home/camp', DSH_HOME: '/tmp/camp-dsh-home', ...env });
    for (const key of Object.keys({ HOME: '/home/camp', DSH_HOME: '/tmp/camp-dsh-home', ...env })) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error('Invalid environment variable name');
      dockerArgs.push('--env', key);
    }
    dockerArgs.push(run.containerId, 'node', '/opt/camp-dsh/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', profile, ...args);
    return { command: 'docker', args: dockerArgs, env: environment };
  }
}
