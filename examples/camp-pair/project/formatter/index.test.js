import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCount } from './index.js';
test('formats item counts', () => {
  assert.equal(formatCount(0), '0 items');
  assert.equal(formatCount(1), '1 item');
  assert.equal(formatCount(3), '3 items');
});
test('rejects invalid counts', () => {
  for (const value of [-1, 1.2, Infinity, NaN, '2']) assert.throws(() => formatCount(value), RangeError);
});
