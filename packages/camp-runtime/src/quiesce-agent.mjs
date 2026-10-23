// Trusted code, executed as root only in the current attempt's private PID namespace.
// It imports no workspace code and leaves the root filesystem daemon running.
export const quiesceAgentScript = `
const fs = require('node:fs/promises');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function agents() {
  const result = [];
  for (const name of await fs.readdir('/proc')) {
    if (!/^[0-9]+$/.test(name)) continue;
    let status;
    try { status = await fs.readFile('/proc/' + name + '/status', 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const uid = status.match(/^Uid:\\s+(.+)$/m)?.[1].trim().split(/\\s+/).map(Number);
    const state = status.match(/^State:\\s+(\\S)/m)?.[1];
    if (uid?.includes(501) && !['Z', 'X'].includes(state)) result.push(Number(name));
  }
  return result;
}
(async () => {
  if (process.getuid() !== 0) throw new Error('Quiescence requires the trusted root manager');
  const start = Date.now();
  let empty = false;
  for (;;) {
    const pids = await agents();
    if (!pids.length) { if (empty) break; empty = true; }
    else {
      empty = false;
      if (Date.now() - start > 5000) throw new Error('Agent processes remain after bounded stop');
      for (const pid of pids) {
        try { process.kill(pid, Date.now() - start < 500 ? 'SIGTERM' : 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    }
    await sleep(50);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
