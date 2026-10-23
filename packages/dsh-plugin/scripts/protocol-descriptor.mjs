import { readFile, writeFile } from 'node:fs/promises';
import { createPluginDeclaration } from '../../camp-protocol/src/index.js';

const path = new URL('../protocol.json', import.meta.url);
const expected = `${JSON.stringify(createPluginDeclaration(), null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== expected) throw new Error('DSH plugin protocol.json is stale; regenerate the static descriptor');
} else await writeFile(path, expected);
