import assert from 'node:assert/strict';
import test from 'node:test';
import { createCounter } from './counter.js';

test('starts at zero and increments', () => {
  const counter = createCounter(); assert.equal(counter.value(), 0);
  assert.equal(counter.increment(), 1); assert.equal(counter.value(), 1);
});
test('independent counters preserve their own starting values', () => {
  const left = createCounter(10), right = createCounter(-2);
  assert.equal(left.increment(), 11); assert.equal(right.value(), -2);
});
test('invalid initial values are rejected', () => {
  for (const value of [NaN, Infinity, '1']) assert.throws(() => createCounter(value), TypeError);
});
