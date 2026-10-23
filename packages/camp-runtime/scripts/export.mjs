import { exportMain } from '../src/export.mjs';
await exportMain().then(result => console.log(JSON.stringify(result)), error => { console.error(JSON.stringify({ event: 'export_failed', reason: error.message })); process.exitCode = 1; });
