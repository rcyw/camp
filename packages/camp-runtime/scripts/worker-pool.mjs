import { startWorkerPool } from '../src/worker-pool.mjs';
await startWorkerPool({ once: process.argv.includes('--once') }).catch(error => {
  console.error(JSON.stringify({ event: 'pool_stopped', code: error.code, reason: error.message }));
  process.exitCode = 1;
});
