import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createModelProxy } from '../src/model-proxy.mjs';
import { ModelBudget, RunLimitError, runLimits } from '../src/run-limits.mjs';

test('run limits reject invalid configuration and count reserved input/response bytes', () => {
  assert.throws(() => runLimits({ CAMP_RUN_TIMEOUT_MS: '0' }), /positive/);
  const budget = new ModelBudget({ ...runLimits({}), maxRequests: 2, maxInputBytes: 7, maxResponseBytes: 5 });
  assert.deepEqual(budget.reserve(4), { requests: 1, inputBytes: 4, responseBytes: 0 });
  assert.throws(() => budget.reserve(4), RunLimitError);
  assert.equal(budget.requests, 1);
  budget.response(5);
  assert.throws(() => budget.response(1), RunLimitError);
});

test('request budget prevents a second upstream charge and reports exhaustion', async () => {
  let calls = 0;
  const upstream = createServer((req, res) => { calls++; req.resume(); res.end('{"ok":true}'); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let limit;
  const budget = new ModelBudget({ ...runLimits({}), maxRequests: 1 });
  const proxy = await createModelProxy({ apiKey: 'not-a-real-key', baseUrl: `http://127.0.0.1:${upstream.address().port}`, budget, onLimit: error => { limit = error; } });
  try {
    const send = () => fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': proxy.token }, body: '{}' });
    const first = await send();
    assert.equal(first.status, 200);
    await first.text();
    const second = await send();
    assert.equal(second.status, 429);
    await second.text();
    assert.equal(calls, 1);
    assert.equal(limit.code, 'run_budget_exhausted');
  } finally { await proxy.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test('model request timeout aborts a stalled upstream and signals run cancellation', async () => {
  const upstream = createServer(req => req.resume());
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let limit;
  const proxy = await createModelProxy({ apiKey: 'not-a-real-key', baseUrl: `http://127.0.0.1:${upstream.address().port}`, budget: new ModelBudget({ ...runLimits({}), requestTimeoutMs: 30 }), onLimit: error => { limit = error; } });
  try {
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': proxy.token }, body: '{}' });
    await response.text();
    assert.equal(response.status, 429);
    assert.equal(limit.code, 'run_budget_exhausted');
  } finally { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});
