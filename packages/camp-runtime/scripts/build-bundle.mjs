import { buildBundle } from '../src/toolchain-build.mjs';
console.log(JSON.stringify(await buildBundle()));
