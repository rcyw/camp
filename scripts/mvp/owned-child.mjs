import { setTimeout as delay } from 'node:timers/promises';

/** Observe only a child created by this script. Detached children use a private process group. */
export function superviseOwnedChild(child, { group = true, handleSignals = false } = {}) {
  let result = null;
  let stopping = null;
  let removeSignalHandlers = () => {};
  const exited = new Promise(resolve => {
    child.once('error', error => { result ??= { code: null, signal: null, error }; removeSignalHandlers(); resolve(result); });
    child.once('exit', (code, signal) => { result ??= { code, signal }; removeSignalHandlers(); resolve(result); });
  });
  function assertRunning(message) {
    if (result || child.exitCode !== null || child.signalCode !== null) throw new Error(message, { cause: result?.error });
  }
  function signal(value) {
    if (result) return;
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('Owned child has no valid process id');
    try { process.kill(group ? -child.pid : child.pid, value); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function wait(ms) {
    const controller = new AbortController();
    try { return await Promise.race([exited, delay(ms, null, { signal: controller.signal })]); }
    finally { controller.abort(); }
  }
  async function performStop({ graceMs = 30_000, killMs = 5_000 } = {}) {
    if (result) return result;
    if (!child.pid) return exited; // A failed spawn emits error on the next turn.
    signal('SIGTERM');
    if (await wait(graceMs)) return result;
    signal('SIGKILL');
    if (await wait(killMs)) return result;
    throw new Error('Owned worker did not exit after SIGKILL');
  }
  function stop(options) { return stopping ??= performStop(options); }
  if (handleSignals) {
    const handlers = ['SIGINT', 'SIGTERM'].map((signal, index) => {
      const handler = () => { void stop().catch(error => console.error(error.message)).finally(() => process.exit(index === 0 ? 130 : 143)); };
      process.on(signal, handler);
      return [signal, handler];
    });
    removeSignalHandlers = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
  }
  return { exited, assertRunning, stop };
}
