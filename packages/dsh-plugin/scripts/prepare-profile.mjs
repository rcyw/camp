/** Assemble a dedicated profile from already installed DSH packages, without network access or copying upstream code. */
import { mkdir, readFile, symlink, writeFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pluginProtocol } from '../src/protocol.js';
import { parseWorkerDeclaration } from '../../camp-protocol/src/index.js';

const args = process.argv.slice(2);
const option = (/** @type {string} */ key) => {
  const at = args.indexOf(key); return at < 0 ? undefined : args[at + 1];
};
const home = option("--home") ?? process.env.DSH_HOME;
const modules = option("--node-modules") ?? process.env.CAMP_DSH_NODE_MODULES;
const plugin = option("--plugin") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!home || !modules) throw new Error("Usage: node prepare-profile.mjs --home <DSH_HOME> --node-modules <installed node_modules> [--plugin <bundle directory>]");
const declared = parseWorkerDeclaration(JSON.parse(await readFile(path.join(plugin, 'protocol.json'), 'utf8')));
if (JSON.stringify(declared) !== JSON.stringify(pluginProtocol)) throw new Error('Selected Camp plugin protocol descriptor does not match this profile assembler');
const packageRoots = {
  "@deepseek-ai/dsh-base": path.join(modules, "@deepseek-ai/dsh-base"),
  "@deepseek-ai/dsh-acp-app": path.join(modules, "@deepseek-ai/dsh-acp-app"),
  "@camp/dsh-plugin": plugin,
};
// Resolve every dependency before changing the profile. Bundle resolution stays in DSH's normal launcher.
for (const root of Object.values(packageRoots)) await readFile(path.join(root, "package.json"), "utf8");
const profile = path.resolve(home, "profiles/camp");
await mkdir(profile, { recursive: true });
for (const [name, root] of Object.entries(packageRoots)) {
  const link = path.join(profile, "node_modules", name);
  await mkdir(path.dirname(link), { recursive: true });
  const target = await realpath(root);
  try {
    await lstat(link);
    if (await realpath(link) !== target) throw new Error(`Existing Camp profile dependency points elsewhere: ${name}`);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
    await symlink(target, link, "dir");
  }
}
await writeFile(path.join(profile, "package.json"), `${JSON.stringify({
  name: "dsh-profile-camp", private: true, type: "module",
  campProtocol: declared,
  dependencies: Object.fromEntries(Object.entries(packageRoots).map(([name, root]) => [name, `file:${path.resolve(root)}`])),
  dsh: { profile: { bundles: Object.keys(packageRoots) } },
}, null, 2)}\n`);
for (const filename of ["cordis.yml", "cordis.patch.yml"]) {
  try { await writeFile(path.join(profile, filename), "# Dedicated Camp ACP profile.\n[]\n", { flag: "wx" }); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error; }
}
process.stdout.write(`${profile}\n`);
