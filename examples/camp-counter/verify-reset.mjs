// Keep this file outside the selected project and hash-pin it as an operator
// harness. The candidate cannot replace this acceptance contract.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { createCounter } = await import(pathToFileURL(resolve('counter.js')));
const counter = createCounter(7);
assert.equal(counter.increment(), 8);
assert.equal(typeof counter.reset, 'function');
assert.equal(counter.reset(), 7);
assert.equal(counter.value(), 7);
assert.equal(counter.increment(), 8);
console.log('Fixed reset acceptance passed');
