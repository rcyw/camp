import assert from 'node:assert/strict';
import test from 'node:test';
import { CAMP_PREFLIGHT_CHECK_IDS, parsePreflightReport } from '../src/index.js';

const report = () => ({ schemaVersion: 1, workerVersion: '0.4.0', mode: 'agent', modelConfigured: true, toolchainDigest: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), checks: CAMP_PREFLIGHT_CHECK_IDS.map(id => ({ id, status: 'passed', code: 'available' })) });
test('preflight preserves complete diagnostics without asserting online status or a tested model key', () => {
  const input = report(); const parsed = parsePreflightReport(input);
  assert.deepEqual(parsed, input); assert.notEqual(parsed.checks, input.checks);
  assert.equal('online' in parsed, false); assert.equal('ready' in parsed, false);
});
test('preflight rejects missing or duplicated checks and arbitrary diagnostic payloads', () => {
  const complete = report();
  for (const value of [
    { ...complete, checks: complete.checks.slice(1) },
    { ...complete, checks: [...complete.checks.slice(1), complete.checks[1]] },
    { ...complete, checks: [{ ...complete.checks[0], message: 'A credential or host path' }, ...complete.checks.slice(1)] },
    { ...complete, checks: [{ ...complete.checks[0], code: '/private/path' }, ...complete.checks.slice(1)] },
    { ...complete, imageId: 'latest' }, { ...complete, observedAt: new Date().toISOString() },
  ]) assert.throws(() => parsePreflightReport(value));
});
