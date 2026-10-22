import { setTimeout as delay } from 'node:timers/promises';

/** Retry only an identical completion after a missing/invalid transport response. */
export async function settleCompletion(send, { attempts = 3, pause = delay } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await send(); }
    catch (error) {
      if (error.status) throw Object.assign(error, { completionRejected: true });
      if (attempt >= attempts) throw Object.assign(error, { completionOutcomeUnknown: true });
      await pause(attempt * 250);
    }
  }
}

/** Keep each progress event below the API's 16,000 UTF-16-unit limit. */
export function splitProgress(text, maximum = 12000) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + maximum);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end;
  }
  return chunks;
}

/** A stale lease cannot authorize completion, even after model work settled. */
export class LeaseGuard {
  constructor({ heartbeat, onStop }) { this.heartbeat = heartbeat; this.onStop = onStop; this.state = 'active'; }
  async refresh() {
    if (this.state !== 'active') return;
    let result;
    try { result = await this.heartbeat(); }
    catch (error) { this.state = 'lost'; await this.onStop(error); return; }
    if (result.cancelRequested) { this.state = 'cancelled'; await this.onStop(new Error('Task cancellation requested')); }
  }
  assertActive() {
    if (this.state !== 'active') throw new Error(`Run lease is ${this.state}`);
  }
}

export function checkedClaim(value) {
  if (value?.run === null) return null;
  const run = value?.run;
  if (!run || typeof run.id !== 'string' || !Number.isSafeInteger(run.epoch) || run.epoch <= 0 || typeof run.prompt !== 'string' || typeof run.runToken !== 'string') throw new Error('Camp claim returned malformed run data');
  return run;
}
