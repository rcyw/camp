import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { ModelBudget, RunLimitError } from './run-limits.mjs';

/** A run-scoped streaming proxy; the real provider credential stays on the host. */
export async function createModelProxy({ apiKey, baseUrl = 'https://api.deepseek.com/anthropic', host = '127.0.0.1', budget = new ModelBudget(), onBudget = async () => {}, onLimit = () => {} }) {
  const upstreamBase = new URL(baseUrl);
  if (!['http:', 'https:'].includes(upstreamBase.protocol)) throw new Error('Invalid model upstream URL');
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token);
  const active = new Map();
  let closing = false;
  const server = createServer(async (req, res) => {
    if (closing) { res.writeHead(503).end(); return; }
    const authorization = Buffer.from(req.headers['x-api-key'] ?? (req.headers.authorization ?? '').replace(/^Bearer /, ''));
    if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) { res.writeHead(401).end(); return; }
    const path = new URL(req.url, 'http://proxy').pathname;
    if (!['/v1/messages', '/messages', '/chat/completions', '/v1/chat/completions', '/models', '/v1/models'].includes(path) || !['POST', 'GET'].includes(req.method)) { res.writeHead(404).end(); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(new RunLimitError('Model request timed out')); onLimit(new RunLimitError('Model request timed out')); }, budget.limits.requestTimeoutMs);
    let finish;
    active.set(controller, new Promise(resolve => { finish = resolve; }));
    res.once('close', () => controller.abort());
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > budget.limits.maxRequestBytes) throw new RunLimitError('Model request body exceeds its byte budget');
        chunks.push(chunk);
      }
      await onBudget(budget.reserve(bytes));
      const base = upstreamBase.toString().replace(/\/+$/, '');
      const isMessages = path.endsWith('/messages');
      const upstream = new URL(isMessages ? `${base.endsWith('/v1') ? base : `${base}/v1`}/messages` : `${base}${path.replace(/^\/v1\//, '/')}`);
      const response = await fetch(upstream, {
        method: req.method,
        headers: { ...(isMessages ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${apiKey}` }), 'content-type': req.headers['content-type'] ?? 'application/json', accept: req.headers.accept ?? 'application/json' },
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
        signal: controller.signal,
        redirect: 'error',
      });
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' });
      if (response.body) for await (const chunk of Readable.fromWeb(response.body)) {
        budget.response(chunk.length);
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
      await onBudget(budget.snapshot());
    } catch (error) {
      if (error instanceof RunLimitError) { controller.abort(error); onLimit(error); }
      if (!res.headersSent) res.writeHead(error instanceof RunLimitError ? 429 : 502, { 'content-type': 'application/json' }).end('{"error":{"message":"Model proxy request stopped"}}');
      else res.destroy();
    } finally { clearTimeout(timeout); active.delete(controller); finish(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return {
    token,
    budget,
    baseUrl: `http://${host}:${server.address().port}`,
    close: async () => {
      closing = true;
      const pending = [...active.values()];
      for (const controller of active.keys()) controller.abort();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await Promise.all(pending);
    },
  };
}
