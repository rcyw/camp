// Operator-owned black-box contract. Mount this file read-only outside the
// candidate; run it in a fresh, network-isolated validation container.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { listItems } = await import(pathToFileURL(resolve('src/catalog.mjs')));
const input = Object.freeze([Object.freeze({ name: 'Pear' }), Object.freeze({ name: 'apricot' }), Object.freeze({ name: 'Apple' })]);
const names = values => values.map(value => value.name);
assert.deepEqual(names(listItems(input)), ['Apple', 'apricot', 'Pear']);
assert.deepEqual(names(listItems(input, 'AP', 1)), ['Apple']);
assert.deepEqual(listItems(input, '', 0), []);
assert.deepEqual(names(listItems(input, '', 99)), ['Apple', 'apricot', 'Pear']);
assert.deepEqual(listItems(input, 'absent', 2), []);
assert.deepEqual(names(listItems(input, '', undefined)), ['Apple', 'apricot', 'Pear']);
for (const value of [-1, 0.5, Infinity, NaN]) assert.throws(() => listItems(input, '', value), RangeError);
for (const value of ['1', null, true, {}]) assert.throws(() => listItems(input, '', value), TypeError);
assert.deepEqual(names(input), ['Pear', 'apricot', 'Apple']);

const { makeServer } = await import(pathToFileURL(resolve('src/server.mjs')));
const server = await makeServer();
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const itemsOf = value => Array.isArray(value) ? value : value?.items;
try {
  const allResponse = await fetch(origin + '/api/items');
  assert.equal(allResponse.status, 200);
  const all = itemsOf(await allResponse.json());
  assert.ok(all.length >= 2);
  for (const [query, expected] of [['limit=0', []], ['limit=1', all.slice(0, 1)], ['limit=999', all], ['q=AP&limit=1', listItems(all, 'AP', 1)]]) {
    const response = await fetch(origin + '/api/items?' + query);
    assert.equal(response.status, 200, query);
    assert.deepEqual(itemsOf(await response.json()), expected, query);
  }
  for (const value of ['', '-1', '0.5', 'abc', 'Infinity', 'NaN']) {
    assert.equal((await fetch(origin + '/api/items?limit=' + encodeURIComponent(value))).status, 400, 'Invalid limit: ' + value);
  }
  assert.equal((await fetch(origin + '/health')).status, 200);
  assert.equal((await fetch(origin + '/')).status, 200);
} finally {
  server.closeAllConnections();
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));
}
const delivery = await readFile('DELIVERY.md', 'utf8');
assert.match(delivery, /^#{1,6}\s+Result limits\s*$/m, 'DELIVERY.md must document Result limits');
assert.match(delivery, /node --test/);
assert.match(delivery, /limit/);
console.log('CAMP_DELIVERY_ACCEPTANCE=' + JSON.stringify({ coreLimits: true, inputPreserved: true, httpLimits: true, invalidHttpLimits: true, deliveryNotes: true }));
