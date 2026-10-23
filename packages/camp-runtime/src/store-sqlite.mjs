// Trusted maintenance child. Never imports project code or accepts SQL.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';

if (String(process.ppid) !== process.env.CAMP_STORAGE_OWNER_PID) process.exit(1);

const quote = value => '"' + value.replaceAll('"', '""') + '"';
function inspect(db, journalMode = 'wal') {
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Store integrity check failed');
  const hash = createHash('sha256');
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
  hash.update(JSON.stringify(schema));
  const tables = schema.filter(row => row.type === 'table');
  if (tables.length > 1000) throw new Error('Store schema exceeds its table budget');
  let rows = 0;
  for (const table of tables) {
    hash.update(table.name + '\0');
    const columns = db.prepare(`PRAGMA table_info(${quote(table.name)})`).all();
    const sql = `SELECT * FROM ${quote(table.name)} ORDER BY ${columns.map(column => quote(column.name)).join(',')}`;
    const statement = db.prepare(sql); statement.setReadBigInts(true); statement.setReturnArrays(true);
    for (const row of statement.iterate()) {
      rows++;
      for (const value of row) {
        if (value === null) hash.update('n;');
        else if (value instanceof Uint8Array) { hash.update(`b${value.length}:`); hash.update(value); }
        else { const bytes = Buffer.from(String(value)); hash.update(`${typeof value}:${bytes.length}:`); hash.update(bytes); }
      }
      hash.update('\n');
    }
  }
  return { applicationId: db.prepare('PRAGMA application_id').get().application_id, userVersion: db.prepare('PRAGMA user_version').get().user_version, pageSize: db.prepare('PRAGMA page_size').get().page_size, autoVacuum: db.prepare('PRAGMA auto_vacuum').get().auto_vacuum, journalMode, tables: tables.length, rows, logicalDigest: hash.digest('hex') };
}
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('Invalid maintenance request'); }
const request = JSON.parse(input);
let source, target;
try {
  const stat = await lstat(request.source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 512 || stat.size > 1024 ** 4) throw new Error('Store must be an ordinary bounded file');
  // NOFOLLOW validation is repeated immediately before SQLite opens the path.
  const checked = await open(request.source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const header = Buffer.alloc(20); try { await checked.read(header, 0, 20, 0); } finally { await checked.close(); }
  if (header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header[18] !== 2 || header[19] !== 2) throw new Error('Store does not preserve the required WAL header profile');
  let sourcePath = request.source;
  if (request.sealedSource) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await lstat(request.source + suffix); throw new Error('Sealed Store has sidecars'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    // Readonly WAL connections otherwise create sidecars even when no WAL
    // exists. Immutable is safe only for our closed, hashed bundle file.
    sourcePath = pathToFileURL(request.source); sourcePath.searchParams.set('immutable', '1');
  }
  source = new DatabaseSync(sourcePath, { readOnly: true });
  source.exec('PRAGMA query_only=ON; BEGIN');
  const sourceInfo = inspect(source);
  if (request.destination) {
    const reserved = await open(request.destination, 'wx', 0o600); await reserved.close();
    await backup(source, request.destination, { rate: 1024 });
    target = new DatabaseSync(request.destination);
    // LayerFS refuses existing databases whose persisted journal profile is
    // not WAL. A standalone sealed file still retains WAL in its header; the
    // committed WAL pages themselves are checkpointed before closing it.
    target.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    const checkpoint = target.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy !== 0) throw new Error('Backup WAL did not checkpoint');
    const targetInfo = inspect(target);
    if (JSON.stringify(sourceInfo) !== JSON.stringify(targetInfo)) throw new Error('Store backup changed its schema or history');
    target.close(); target = null;
    const file = await open(request.destination, 'r'); try { await file.sync(); } finally { await file.close(); }
  }
  source.exec('COMMIT'); source.close(); source = null;
  process.stdout.write(JSON.stringify(sourceInfo) + '\n');
} catch {
  process.stderr.write('Store SQLite backup or integrity verification failed\n'); process.exitCode = 1;
} finally { target?.close(); source?.close(); }
