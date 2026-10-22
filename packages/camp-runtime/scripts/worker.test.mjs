import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LeaseGuard, checkedClaim, splitProgress, settleCompletion } from '../src/worker-core.mjs';

test('lease loss stops its runtime once and fences a late completion', async () => {
  let stops = 0;
  const guard = new LeaseGuard({ heartbeat: async () => { throw new Error('409'); }, onStop: async () => { stops++; } });
  await guard.refresh();
  await guard.refresh();
  assert.equal(stops, 1);
  assert.equal(guard.state, 'lost');
  assert.throws(() => guard.assertActive(), /lost/);
});
test('cancellation is acknowledged separately from lease loss after stop', async () => {
  let stopped = false;
  const guard = new LeaseGuard({ heartbeat: async () => ({ cancelRequested: true }), onStop: async () => { stopped = true; } });
  await guard.refresh();
  assert.equal(stopped, true);
  assert.equal(guard.state, 'cancelled');
});
test('long Unicode progress is split without corrupting surrogate pairs', () => {
  const text = 'x'.repeat(11999) + '😀' + 'y'.repeat(20000);
  const chunks = splitProgress(text);
  assert.ok(chunks.every(chunk => chunk.length <= 12000 && chunk.isWellFormed()));
  assert.equal(chunks.join(''), text);
});
test('idle claim is valid; invalid authenticated payload cannot launch work', () => {
  assert.equal(checkedClaim({ run: null }), null);
  assert.throws(() => checkedClaim({ error: 'unauthorized' }), /malformed/);
});
test('lost completion response retries exactly the applied payload', async () => {
  const payload = { epoch: 2, status: 'completed', summary: 'candidate verified', artifacts: [{ commitId: 'fixed' }] };
  const received = [];
  const result = await settleCompletion(async () => {
    received.push(JSON.stringify(payload));
    if (received.length === 1) throw new TypeError('response lost after server committed');
    return { replayed: true };
  }, { pause: async () => {} });
  assert.equal(result.replayed, true);
  assert.equal(received.length, 2);
  assert.equal(received[0], received[1]);
});
test('HTTP completion rejection is not retried or reported as a failed run', async () => {
  let calls = 0;
  await assert.rejects(settleCompletion(async () => { calls++; throw Object.assign(new Error('fenced'), { status: 409 }); }), error => error.completionRejected === true && error.status === 409);
  assert.equal(calls, 1);
});
test('unanswered completion stops after three attempts and preserves unknown outcome', async () => {
  let calls = 0;
  await assert.rejects(settleCompletion(async () => { calls++; throw new TypeError('network offline'); }, { pause: async () => {} }), error => error.completionOutcomeUnknown === true);
  assert.equal(calls, 3);
});
