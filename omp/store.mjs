import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, lstatSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sqlite = await import(process.versions.bun ? 'bun:sqlite' : 'node:sqlite');
const Database = process.versions.bun ? sqlite.Database : sqlite.DatabaseSync;
const MAX_VALUE_BYTES = 32 * 1024 * 1024;

export const fault = (code) => Object.assign(new Error(code), { code });
export const fingerprint = (value) => createHash('sha256').update(typeof value === 'string' ? value : value.token).digest('hex');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function sqliteFault(error, fallback) {
  if (typeof error.code === 'string' && error.code.startsWith('state_')) return error;
  if (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED' || error.errcode === 5 || error.errcode === 6 ||
      /database (?:is )?(?:locked|busy)/i.test(error.message ?? '')) return fault('state_busy');
  return fault(fallback);
}
function encoded(value) {
  let result;
  try { result = JSON.stringify(value); }
  catch { throw fault('state_value_invalid'); }
  if (result === undefined) throw fault('state_value_invalid');
  if (Buffer.byteLength(result) > MAX_VALUE_BYTES) throw fault('state_value_too_large');
  return result;
}
function query(db, sql, method, ...args) {
  const statement = db.prepare(sql);
  try { return statement[method](...args); }
  finally { statement.finalize?.(); }
}
function leaseRecord(value) {
  if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string' || !value.token)) throw fault('state_unreadable');
  return value;
}

export class Store {
  constructor(root) {
    this.root = resolve(root);
    this.db = null;
    this.transactionDepth = 0;
  }

  path(name) {
    if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*\.json$/u.test(name)) throw fault('state_name_invalid');
    return join(this.root, 'state.sqlite3');
  }

  directory() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('state_directory_untrusted');
    chmodSync(this.root, 0o700);
  }

  secureFiles() {
    for (const suffix of ['', '-wal', '-shm']) {
      const path = join(this.root, `state.sqlite3${suffix}`);
      let stat;
      try { stat = lstatSync(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fault('state_file_untrusted');
      if (!suffix && stat.size > 0 && stat.size < 100) throw fault('state_unreadable');
      try { chmodSync(path, 0o600); }
      catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    }
  }

  connection() {
    if (this.db) return this.db;
    this.directory();
    const path = join(this.root, 'state.sqlite3');
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
    this.secureFiles();
    let db;
    try {
      db = new Database(path);
      db.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      db.exec('CREATE TABLE IF NOT EXISTS entries (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL CHECK (json_valid(value))) WITHOUT ROWID;');
      const check = query(db, 'PRAGMA quick_check(1)', 'get');
      if (check.quick_check !== 'ok') throw fault('state_unreadable');
      this.secureFiles();
      this.db = db;
      return db;
    } catch (error) {
      try { if (process.versions.bun) db?.close(true); else db?.close(); } catch { /* Preserve the opening failure. */ }
      if (error.code === 'state_file_untrusted') throw error;
      throw sqliteFault(error, 'state_unreadable');
    }
  }

  read(name, fallback = null) {
    this.path(name);
    let row;
    try { row = query(this.connection(), 'SELECT value FROM entries WHERE name = ?', 'get', name); }
    catch (error) {
      if (['state_file_untrusted', 'state_directory_untrusted'].includes(error.code)) throw error;
      throw sqliteFault(error, 'state_unreadable');
    }
    if (!row) return structuredClone(fallback);
    if (typeof row.value !== 'string' || Buffer.byteLength(row.value) > MAX_VALUE_BYTES) throw fault('state_unreadable');
    try { return JSON.parse(row.value); }
    catch { throw fault('state_unreadable'); }
  }

  transaction(run) {
    const db = this.connection();
    if (this.transactionDepth) return run(db);
    try { db.exec('BEGIN IMMEDIATE'); }
    catch (error) { throw sqliteFault(error, 'state_write_failed'); }
    this.transactionDepth++;
    try {
      const result = run(db);
      try { db.exec('COMMIT'); }
      catch (error) { throw sqliteFault(error, 'state_write_unconfirmed'); }
      this.secureFiles();
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* COMMIT may already have completed. */ }
      throw error;
    } finally { this.transactionDepth--; }
  }

  put(db, name, value) {
    const text = encoded(value);
    try { query(db, 'INSERT INTO entries (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value', 'run', name, text); }
    catch (error) { throw sqliteFault(error, 'state_write_failed'); }
    return value;
  }

  write(name, value) {
    this.path(name);
    return this.transaction((db) => this.put(db, name, value));
  }

  update(name, change, fallback = null) {
    this.path(name);
    return this.transaction((db) => {
      const value = change(this.read(name, fallback));
      if (value && typeof value.then === 'function') throw fault('state_update_async');
      if (value !== undefined) this.put(db, name, value);
      return value;
    });
  }

  lease(key) {
    const name = `leases/${fingerprint(key)}.json`, token = randomUUID();
    this.update(name, (previous) => {
      const row = leaseRecord(previous);
      if (row && alive(row.pid)) throw fault('native_session_owned_elsewhere');
      return { pid: process.pid, token };
    });
    return {
      assert: () => {
        const row = leaseRecord(this.read(name));
        if (row?.token !== token || row.pid !== process.pid) throw fault('native_session_lease_lost');
      },
      release: () => this.update(name, (previous) => {
        const row = leaseRecord(previous);
        return row?.token === token && row.pid === process.pid ? null : row;
      }),
    };
  }

  journal(credential, root) {
    return `sessions/${fingerprint(credential)}-${fingerprint(root)}.json`;
  }

  journals() {
    let rows;
    try { rows = query(this.connection(), "SELECT name FROM entries WHERE name LIKE 'sessions/%' ORDER BY name", 'all'); }
    catch (error) { throw sqliteFault(error, 'state_unreadable'); }
    return rows.map((row) => row.name).filter((name) => /^sessions\/[a-f0-9]{64}-[a-f0-9]{64}\.json$/u.test(name));
  }

  close() {
    if (this.transactionDepth) throw fault('state_transaction_active');
    if (!this.db) return;
    if (process.versions.bun) this.db.close(true); else this.db.close();
    this.db = null;
  }
}
