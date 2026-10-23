import { installDsh, packDsh } from '../src/toolchain-build.mjs';
const prefix = process.argv.includes('--install') ? await installDsh() : undefined;
console.log(JSON.stringify({ archive: await packDsh(prefix ? { prefix } : {}) }));
