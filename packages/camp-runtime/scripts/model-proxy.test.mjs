import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createModelProxy } from '../src/model-proxy.mjs';

test('DSH Messages uses a scoped x-api-key, fixed upstream path, and host-only real key', async () => {
  const observed = [];
  const upstream = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    observed.push({ path: req.url, key: req.headers['x-api-key'], authorization: req.headers.authorization, version: req.headers['anthropic-version'], body });
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: {"ok":true}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createModelProxy({ apiKey: 'host-only-key', baseUrl: `http://127.0.0.1:${upstream.address().port}/anthropic` });
  try {
    assert.equal((await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': 'wrong' }, body: '{}' })).status, 401);
    const response = await fetch(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': proxy.token }, body: '{"stream":true}' });
    assert.equal(await response.text(), 'data: {"ok":true}\n\n');
    assert.deepEqual(observed, [{ path: '/anthropic/v1/messages', key: 'host-only-key', authorization: undefined, version: '2023-06-01', body: '{"stream":true}' }]);
    assert.equal((await fetch(`${proxy.baseUrl}/arbitrary-target`, { headers: { authorization: `Bearer ${proxy.token}` } })).status, 404);
  } finally {
    await proxy.close();
    await new Promise(resolve => upstream.close(resolve));
  }
});
