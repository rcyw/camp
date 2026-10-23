// Trusted black-box acceptance harness. Run inside a disposable validation
// container with only the exported candidate and this file mounted read-only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = process.cwd();
const { listItems } = await import(pathToFileURL(resolve(root, 'src/catalog.mjs')));
const input = [{ name: 'Pear' }, { name: 'apricot' }, { name: 'Apple' }];
const before = JSON.stringify(input);
assert.deepEqual(listItems(input).map(item => item.name), ['Apple', 'apricot', 'Pear']);
assert.deepEqual(listItems(input, 'AP').map(item => item.name), ['Apple', 'apricot']);
assert.deepEqual(listItems(input, 'camp-no-such-fruit'), []);
assert.equal(JSON.stringify(input), before, 'Search must not mutate its input');
assert.notEqual(listItems(input), input);

const { makeServer } = await import(pathToFileURL(resolve(root, 'src/server.mjs')));
const server = await makeServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const itemsOf = value => Array.isArray(value) ? value : value?.items;
let catalogResponse;
try {
  const health = await fetch(origin + '/health');
  assert.equal(health.status, 200); assert.equal((await health.json()).ok, true);
  const all = await fetch(origin + '/api/items');
  assert.equal(all.status, 200);
  catalogResponse = await all.json();
  const items = itemsOf(catalogResponse);
  assert.ok(Array.isArray(items) && items.length >= 2, 'API must serve a real sample catalog');
  assert.ok(items.every(item => typeof item.name === 'string' && item.name));
  const query = items[0].name.toUpperCase();
  const matched = await fetch(origin + '/api/items?q=' + encodeURIComponent(query));
  assert.equal(matched.status, 200);
  assert.deepEqual(itemsOf(await matched.json()), listItems(items, query), 'HTTP filtering must match the core behavior');
  const empty = await fetch(origin + '/api/items?q=camp-no-such-fruit');
  assert.equal(empty.status, 200); assert.deepEqual(itemsOf(await empty.json()), []);
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  const html = await readFile(resolve(root, 'public/index.html'), 'utf8');
  assert.equal((await page.text()).trim(), html.trim(), 'The HTTP server must deliver the implemented page');
  assert.match(await readFile(resolve(root, 'DELIVERY.md'), 'utf8'), /node --test/);
} finally { server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done())); }
console.log('CAMP_ACCEPTANCE=' + JSON.stringify({ coreSearch: true, caseInsensitive: true, inputPreserved: true, httpFilter: true, httpPage: true, catalogResponse }));
