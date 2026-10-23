import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName } from './index.js';
test('normalizes whitespace and case', () => {
  assert.equal(normalizeName('  Ada   Lovelace '), 'ada lovelace');
  assert.equal(normalizeName('\tGRACE\n HOPPER\t'), 'grace hopper');
});
test('rejects non-string input', () => assert.throws(() => normalizeName(42), TypeError));
