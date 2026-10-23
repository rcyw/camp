import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWorkerLock } from './durable-state.mjs';
import { projectIdentity } from './candidate.mjs';

/** All operator Store writers use the same logical-project fence. Runtime
 * attempt helpers already run beneath their manager and must not reenter it. */
export async function acquireProjectLock(runtime, projectId, { signal, waitMs = 0, onLost } = {}) {
  if (!projectIdentity.test(projectId ?? '')) throw new Error('Invalid project lock identity');
  const dockerHost = await realpath(runtime.docker);
  return acquireWorkerLock(`project:${dockerHost}:${projectId}`, { root: join(tmpdir(), `camp-project-locks-${process.getuid()}`), signal, waitMs, onLost });
}
