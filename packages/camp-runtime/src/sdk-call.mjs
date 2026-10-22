// This process is trusted: only it receives LayerFS discovery and Docker access.
import { pathToFileURL } from 'node:url';
// Covers the small race before setpriv installs Linux's parent-death signal.
if (String(process.ppid) !== process.env.CAMP_SDK_OWNER_PID) process.exit(1);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const { source, projectId, config, method, args } = JSON.parse(input);
Object.assign(process.env, {
  LAYERFS_HOME: config.home,
  LAYERFS_NATIVE: config.native,
  LAYERFS_DOCKER: config.docker,
  LAYERFS_IMAGE: config.imageId,
  LAYERFS_VOLUME: config.volume,
  LAYERFS_DAEMON: config.daemon,
  LAYERFS_STORE_PATH: config.storePath,
  LAYERFS_CONTAINER_PREFIX: config.prefix,
});
const { LayerFS } = await import(pathToFileURL(`${source}/sdk/js/src/index.js`).href);
const client = new LayerFS(projectId, { storePath: config.storePath });
try {
  const [group, operation] = method.split('.');
  const result = await client[group][operation](...args);
  process.stdout.write(JSON.stringify({ result }) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { message: error.message, code: error.code, detail: error.detail } }) + '\n');
  process.exitCode = 1;
} finally {
  await client.close();
}
