// Both entry points use one pinned standard recipe. The host-copy recipe is retired.
import { buildStandardImage } from '../src/image-build.mjs';
console.log(JSON.stringify(await buildStandardImage({ tag: process.env.CAMP_BAKED_IMAGE_TAG })));
