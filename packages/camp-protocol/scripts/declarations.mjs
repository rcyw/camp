import ts from '../../../node_modules/typescript/lib/typescript.js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../src/index.js', import.meta.url));
const target = fileURLToPath(new URL('../src/index.d.ts', import.meta.url));
const program = ts.createProgram([source], { allowJs: true, checkJs: true, strict: true, declaration: true, emitDeclarationOnly: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, types: [] });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) { process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: ts.sys.getCurrentDirectory, getCanonicalFileName: value => value, getNewLine: () => '\n' })); process.exit(1); }
let emitted;
program.emit(undefined, (path, content) => { if (path.endsWith('index.d.ts')) emitted = content; });
if (!emitted) throw new Error('Protocol declarations were not emitted');
const generated = '// Generated from index.js by scripts/declarations.mjs. Do not edit.\n' + emitted;
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8').catch(() => '') !== generated) throw new Error('Protocol declarations are stale; run node packages/camp-protocol/scripts/declarations.mjs');
} else await writeFile(target, generated);
