import { CampRuntime } from '../src/index.mjs';
import { privateDirectory } from '../src/durable-state.mjs';
import { reapWorker } from '../src/worker-ops.mjs';
import { workerIdForEnvironment } from '../src/worker-preflight.mjs';

const args = process.argv.slice(2), action = args.shift();
if (!['init', 'reap'].includes(action) || args.some(value => value !== '--apply') || new Set(args).size !== args.length || action === 'init' && args.length) {
  console.error('Usage: node --env-file=.camp/worker.env packages/camp-runtime/scripts/worker-ops.mjs init | reap [--apply]'); process.exitCode = 2;
} else {
  try {
    const runtime = new CampRuntime();
    if (action === 'init') {
      await privateDirectory(runtime.home);
      console.log(JSON.stringify({ event: 'worker_home_initialized', modelCalls: 0 }));
    } else {
      const result = await reapWorker({ runtime, apiUrl: process.env.CAMP_API_URL ?? 'http://127.0.0.1:3001', workerId: workerIdForEnvironment(), apply: args.includes('--apply') });
      console.log(JSON.stringify(result));
      if (result.attempts.some(item => ['ownership_conflict', 'requires_inspection', 'unexpected_resources'].includes(item.action))) process.exitCode = 1;
    }
  } catch (error) {
    // Docker and local IO errors can contain arbitrary process output. Keep the
    // public diagnostic bounded and do not echo the environment or command.
    console.error(JSON.stringify({ event: 'worker_operation_failed', code: /^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'camp_operation_failed' })); process.exitCode = 1;
  }
}
