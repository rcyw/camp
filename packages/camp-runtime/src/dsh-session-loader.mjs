import { lstat } from 'node:fs/promises';

/** Releases contain a transform of the same daemon ACP source. Development
 * keeps its existing TS loader; broken generated modules never fall back. */
export async function loadDshRuntimeSession() {
  const generated = new URL('./generated/dsh-acp.mjs', import.meta.url);
  try {
    const stat = await lstat(generated);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generated ACP must be an ordinary release file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return (await import('../../daemon/src/drivers/dshAcp.ts')).createDshRuntimeSession;
  }
  const module = await import(generated.href);
  if (typeof module.createDshRuntimeSession !== 'function') throw new Error('Generated ACP does not export the session factory');
  return module.createDshRuntimeSession;
}
