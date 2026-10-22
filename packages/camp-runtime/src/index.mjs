import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { copyFile, chmod, mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageSource } from './source-snapshot.mjs';
import { atomicJson, acquireWorkerLock } from './durable-state.mjs';
import { tmpdir } from 'node:os';

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
    this.source = resolve(options.layerfsSource ?? process.env.LAYERFS_SOURCE ?? '/data/github-projects/Ephemeral-AI-Lab/layerfs');
    this.native = resolve(options.native ?? join(PACKAGE, '.local/layerfs/layerfs.node'));
    this.daemon = resolve(options.daemon ?? join(PACKAGE, '.local/layerfs/layerfs-daemon'));
    this.imageId = options.imageId ?? process.env.CAMP_RUNTIME_IMAGE;
    this.docker = options.docker ?? '/var/run/docker.sock';
    this.dshArchive = options.dshArchive ?? process.env.CAMP_DSH_ARCHIVE ?? join(PACKAGE, '.local/dsh-runtime.tar');
    this.projects = new Map();
  }

  async ready() {
    if (!this.imageId) this.imageId = (await json(join(PACKAGE, '.local/image.json'))).imageId;
    if (!/^sha256:[a-f0-9]{64}$/.test(this.imageId)) throw new Error('An exact local runtime image ID is required');
    await Promise.all([access(this.native), access(this.daemon)]);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return this;
  }

  async dockerCall(args, options = {}) {
    return execute('docker', ['-H', `unix://${this.docker}`, ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
  }

  async sdk(project, method, args = [], config = project) {
    return new Promise((resolveResult, reject) => {
      const child = spawn('setpriv', ['--pdeathsig', 'KILL', process.execPath, SDK_CALL], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CAMP_SDK_OWNER_PID: String(process.pid), UV_THREADPOOL_SIZE: '64' } });
      let stdout = '', stderr = '';
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(Object.assign(new Error(`LayerFS ${method} exceeded 90 seconds; its outcome requires inspection`), { cleanupKnown: false })); }, 90_000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', code => {
        clearTimeout(timeout);
        try {
          const answer = JSON.parse(stdout);
          if (answer.error) return reject(Object.assign(new Error(answer.error.message), answer.error));
          if (code !== 0) return reject(new Error(`LayerFS ${method} exited ${code}: ${stderr}`));
          resolveResult(answer.result);
        } catch (error) { reject(Object.assign(new Error(`LayerFS ${method} returned no valid result (${code}): ${stderr || error.message}`), { cleanupKnown: false })); }
      });
      child.stdin.end(JSON.stringify({ source: this.source, projectId: project.projectId, config, method, args }));
    });
  }

  async prepareProject({ projectId, sourcePath, repoPath, name } = {}) {
    const externalId = projectId ?? name;
    if (!externalId) throw new Error('projectId is required');
    await this.ready();
    const dockerHost = await realpath(this.docker);
    const lock = await acquireWorkerLock(`project:${dockerHost}:${nameOf(externalId)}`, { root: join(tmpdir(), `camp-project-locks-${process.getuid()}`), waitMs: 110_000 });
    try { return await this.prepareProjectExclusive({ externalId, sourcePath, repoPath }); }
    finally { await lock.release(); }
  }

  async prepareProjectExclusive({ externalId, sourcePath, repoPath }) {
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
    const existingVolume = (await this.dockerCall(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}'])).stdout.trim();
    if (existingVolume) throw new Error('Project volume exists without this runtime home project record; share CAMP_RUNTIME_HOME or inspect the interrupted initialization before importing');
    await this.dockerCall(['volume', 'create', '--label', 'camp.mvp=true', volume]);
    const mountpoint = (await this.dockerCall(['volume', 'inspect', '--format', '{{.Mountpoint}}', volume])).stdout.trim();
    const sdkHome = join(folder, 'sdk-home');
    await mkdir(sdkHome, { recursive: true, mode: 0o700 });
    const project = { projectId: id, externalId, home: sdkHome, native: this.native, daemon: this.daemon, docker: this.docker, imageId: this.imageId, volume, storePath: join(mountpoint, 'global/store.sqlite'), prefix: `camp-mvp-project-${short(externalId)}-`, profile: 'Disposable' };
    let seed = sourcePath ?? repoPath;
    if (!seed) {
      seed = join(folder, 'seed');
      await mkdir(seed, { recursive: true });
      await writeFile(join(seed, 'README.md'), `# ${externalId}\n\nCamp shared project.\n`);
    }
    const staged = await stageSource(resolve(seed), join(folder, 'import-seed'));
    Object.assign(project, staged);
    await this.sdk(project, 'project.init', [staged.importPath]);
    await save(record, project);
    this.projects.set(id, project);
    return project;
  }

  runIdentity(runId) {
    return { runId, prefix: `camp-mvp-run-${short(runId)}-`, folder: join(this.home, 'runs', short(runId)) };
  }

  async prepareRun({ project, projectId, sourcePath, runId, roleId, baseRef = 'main', owner }) {
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
    const config = { ...selected, home: runHome, prefix: `camp-mvp-run-${short(runId)}-` };
    const branch = `run-${short(runId)}`;
    const intent = { runId, roleId, branch, baseRef, config, owner, phase: 'forking' };
    await save(join(folder, 'prepare.json'), intent);
    try {
      await this.sdk(selected, 'branch.fork', [branch, baseRef], config);
      intent.phase = 'mounting';
      await save(join(folder, 'prepare.json'), intent);
      const workspace = await this.sdk(selected, 'workspace.mount', [branch], config);
      Object.assign(intent, { phase: 'mounted', workspace });
      await save(join(folder, 'prepare.json'), intent);
      const containerId = (await this.dockerCall(['inspect', '--format', '{{.Id}}', `${config.prefix}${selected.projectId}-${workspace.sandbox}`])).stdout.trim();
      const run = { projectId: selected.projectId, externalProjectId: selected.externalId, runId, roleId, branch, baseRef, sandboxId: workspace.sandbox, containerId, workspacePath: workspace.path, imageId: workspace.image, config, folder, owner, profile: 'Disposable' };
      await save(join(folder, 'run.json'), run);
      return run;
    } catch (error) {
      // This discovery home and prefix belong only to this attempt. Even when
      // mount/inspect fails before a run descriptor exists, remove its containers.
      let cleanupKnown = error.cleanupKnown !== false;
      try { await this.cleanupAttempt(config.prefix); }
      catch { cleanupKnown = false; }
      try { await save(join(folder, 'prepare-failed.json'), { at: new Date().toISOString(), phase: intent.phase, cleanupKnown, reason: error.message }); }
      catch { cleanupKnown = false; }
      throw Object.assign(error, { cleanupKnown });
    }
  }

  async cleanupAttempt(prefix) {
    if (!/^camp-mvp-run-[a-f0-9]{16}-$/.test(prefix)) throw new Error('Refusing cleanup without an owned run prefix');
    const list = await this.dockerCall(['ps', '-a', '--format', '{{.ID}} {{.Names}}', '--filter', `name=^/${prefix}`]);
    for (const line of list.stdout.trim().split('\n').filter(Boolean)) {
      const [id, name] = line.split(' ');
      if (!name?.startsWith(prefix) || !/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Docker returned an unexpected cleanup identity');
      await this.dockerCall(['rm', '-f', id]);
    }
    if ((await this.dockerCall(['ps', '-a', '-q', '--filter', `name=^/${prefix}`])).stdout.trim()) throw new Error('Attempt containers remain after cleanup');
  }

  async exec(run, command) {
    return this.sdk(run.config, 'workspace.exec', [{ sandbox: run.sandboxId, path: run.workspacePath }, command], run.config);
  }

  async commitCandidate(run, { message = `Camp candidate ${run.runId}` } = {}) {
    const result = await this.sdk(run.config, 'workspace.commit', [{ sandbox: run.sandboxId, path: run.workspacePath }, message], run.config);
    const commitId = result.commit?.id ?? result.head;
    const rootId = result.commit?.root ?? result.root;
    const artifact = { type: 'layerfs', projectId: run.projectId, branch: run.branch, commitId, rootId, baseRef: run.baseRef, runId: run.runId, role: run.roleId, sandboxId: run.sandboxId, imageId: run.imageId, profile: 'Disposable' };
    await save(join(run.folder, 'candidate.json'), { artifact, result });
    return artifact;
  }

  async releaseRun(run, { discard = false } = {}) {
    await this.sdk(run.config, 'workspace.unmount', [{ sandbox: run.sandboxId, path: run.workspacePath }, discard], run.config);
    await this.dockerCall(['stop', '--time', '3', run.containerId]);
    await this.dockerCall(['rm', run.containerId]);
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
    await execute('tar', ['-cf', archive, '-C', resolve(path), 'src', 'scripts', 'package.json', 'cordis.patch.yml'], { timeout: 10_000 });
    await this.dockerCall(['cp', archive, `${run.containerId}:/tmp/camp-plugin.tar`]);
    await this.dockerCall(['exec', '--user', '0:0', run.containerId, 'bash', '-c', 'mkdir -p /opt/camp-dsh-plugin && tar -xf /tmp/camp-plugin.tar -C /opt/camp-dsh-plugin && rm /tmp/camp-plugin.tar']);
    await this.dockerCall(['exec', '--user', '501:20', run.containerId, 'node', '/opt/camp-dsh-plugin/scripts/prepare-profile.mjs', '--home', '/tmp/camp-dsh-home', '--node-modules', '/opt/camp-dsh/node_modules', '--plugin', '/opt/camp-dsh-plugin']);
  }

  async abortRun(run, reason = 'cancelled') {
    // Container termination is owned by the trusted worker, never by an agent.
    // A killed filesystem incarnation is retained as aborted, not committed.
    await this.dockerCall(['stop', '--time', '3', run.containerId]);
    await this.dockerCall(['rm', run.containerId]);
    await save(join(run.folder, 'aborted.json'), { at: new Date().toISOString(), reason });
  }

  async archiveSession(run) {
    await this.dockerCall(['cp', `${run.containerId}:/tmp/camp-dsh-home`, join(run.folder, 'dsh-home')], { timeout: 90_000 });
  }

  async sandboxApiUrl(run, apiUrl) {
    const url = new URL(apiUrl);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      const gateway = (await this.dockerCall(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', run.containerId])).stdout.trim();
      if (!gateway) throw new Error('The run container has no host gateway');
      url.hostname = gateway;
    }
    return url.toString().replace(/\/$/, '');
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
