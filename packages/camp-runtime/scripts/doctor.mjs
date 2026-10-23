import { CampRuntime } from '../src/index.mjs';
import { inspectWorker } from '../src/worker-preflight.mjs';

const args = process.argv.slice(2);
if (args.some(arg => !['--report', '--require-agent'].includes(arg)) || new Set(args).size !== args.length) {
  console.error('Usage: node --env-file=.camp/worker.env packages/camp-runtime/scripts/doctor.mjs [--report] [--require-agent]'); process.exitCode = 2;
} else {
  try {
    const result = await inspectWorker({ runtime: new CampRuntime(), report: args.includes('--report'), requireAgent: args.includes('--require-agent') });
    console.log(JSON.stringify({ event: 'worker_preflight', ready: result.ready, reported: result.reported, modelCalls: 0, report: result.report }));
    if (!result.ready) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ event: 'worker_preflight_failed', code: /^[a-z_]{1,80}$/.test(error.code ?? '') ? error.code : 'camp_preflight_failed' })); process.exitCode = 1;
  }
}
