import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const MAX_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_DEDUPE_ENTRIES = 10000;
const LOCK_SPIN_TIMEOUT_MS = 2000;
const CORRUPT_LOCK_GRACE_MS = 5000;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const fault = (code, extra) => Object.assign(new Error(code), { code, ...extra });
export const fingerprint = (value) => createHash('sha256').update(typeof value === 'string' ? value : value.token).digest('hex');

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

export function readProcessStartToken(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  for (const psBin of ['/bin/ps', '/usr/bin/ps']) {
    try {
      const out = execFileSync(psBin, ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        timeout: 2000,
        env: { ...process.env, LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (out) return out;
    } catch {}
  }
  return null;
}

export function isSameRunningProcess(pid, startToken) {
  if (!isPidAlive(pid)) return false;
  if (!startToken) return true;
  const current = readProcessStartToken(pid);
  if (!current) return true;
  return current === startToken;
}

export function captureHostProvenance({ hostPid = process.ppid, readStartToken = readProcessStartToken } = {}) {
  const pid = Number.isSafeInteger(hostPid) && hostPid > 0 ? hostPid : process.pid;
  const token = readStartToken(pid);
  return Object.freeze({
    hostPid: pid,
    hostStartToken: typeof token === 'string' && token.trim() ? token.trim() : null,
  });
}

export function sameHostProvenance(a, b) {
  if (!a || !b) return false;
  if (!Number.isSafeInteger(a.hostPid) || a.hostPid < 1 || a.hostPid !== b.hostPid) return false;
  return (a.hostStartToken ?? null) === (b.hostStartToken ?? null);
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertOwnedRegularFile(stat, code = 'state_file_untrusted') {
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw fault(code);
  if (uid !== null && stat.uid !== uid) throw fault(code);
}

function assertOwnedDirectory(stat, code = 'state_directory_untrusted') {
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault(code);
  if (uid !== null && stat.uid !== uid) throw fault(code);
}

function fsyncDirBestEffort(dirPath) {
  let fd;
  try {
    fd = openSync(dirPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    fsyncSync(fd);
  } catch {
    // Best effort on filesystems that do not allow directory fsync.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function sleepSync(ms) {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, ms);
}

function ensureOwnedDir(dirPath) {
  try {
    const st = lstatSync(dirPath);
    assertOwnedDirectory(st);
    if ((st.mode & 0o077) !== 0) chmodSync(dirPath, 0o700);
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  try {
    mkdirSync(dirPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const st = lstatSync(dirPath);
  assertOwnedDirectory(st);
  if ((st.mode & 0o077) !== 0) chmodSync(dirPath, 0o700);
}

export class StateStore {
  constructor(root) {
    this.root = resolve(root);
    this.home = resolve(homedir());
  }

  ensureRoot() {
    const relFromHome = relative(this.home, this.root);
    if (relFromHome && relFromHome !== '..' && !relFromHome.startsWith(`..${sep}`) && relFromHome !== this.root) {
      let cursor = this.home;
      for (const segment of relFromHome.split(sep).filter(Boolean)) {
        cursor = join(cursor, segment);
        ensureOwnedDir(cursor);
      }
      return;
    }

    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    ensureOwnedDir(this.root);
  }

  ensureSubdir(relDir) {
    this.ensureRoot();
    if (!/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/u.test(relDir)) throw fault('state_name_invalid');
    let cursor = this.root;
    for (const seg of relDir.split('/')) {
      cursor = join(cursor, seg);
      ensureOwnedDir(cursor);
    }
    return cursor;
  }

  verifyAncestorsUnderRoot(target) {
    const rel = relative(this.root, dirname(target));
    if (!rel) return;
    let cursor = this.root;
    for (const seg of rel.split(sep).filter(Boolean)) {
      cursor = join(cursor, seg);
      const st = lstatSync(cursor);
      assertOwnedDirectory(st);
    }
  }

  resolveSafe(name) {
    if (!/^[a-z0-9_-][a-z0-9_.-]*(?:\/[a-z0-9_-][a-z0-9_.-]*)*$/u.test(name) || name.includes('..')) {
      throw fault('state_name_invalid');
    }
    const target = resolve(this.root, name);
    const rel = relative(this.root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
      throw fault('state_name_invalid');
    }
    return target;
  }

  readJson(name, fallback = null) {
    this.ensureRoot();
    const target = this.resolveSafe(name);
    for (let attempt = 0; attempt < 4; attempt++) {
      let fd;
      try {
        this.verifyAncestorsUnderRoot(target);
        fd = openSync(target, fsConstants.O_RDONLY | O_NOFOLLOW);
        const st = fstatSync(fd);
        // Concurrent atomic rename/unlink can drop an opened inode's nlink to 0; retry against the replacement.
        if (st.nlink === 0) continue;
        assertOwnedRegularFile(st);
        if (st.size > MAX_VALUE_BYTES) throw fault('state_unreadable');
        if ((st.mode & 0o077) !== 0) {
          try { fchmodSync(fd, 0o600); } catch {}
        }
        const raw = readFileSync(fd, 'utf8');
        return JSON.parse(raw);
      } catch (error) {
        if (error?.code === 'ENOENT') return structuredClone(fallback);
        if (error?.code === 'ELOOP') throw fault('state_file_untrusted');
        if (typeof error?.code === 'string' && error.code.startsWith('state_')) throw error;
        throw fault('state_unreadable');
      } finally {
        if (fd !== undefined) {
          try { closeSync(fd); } catch {}
        }
      }
    }
    return structuredClone(fallback);
  }

  writeJsonAtomic(name, value) {
    this.ensureRoot();
    const target = this.resolveSafe(name);
    const parentRel = relative(this.root, dirname(target));
    if (parentRel) this.ensureSubdir(parentRel.split(sep).join('/'));

    let encoded;
    try { encoded = JSON.stringify(value, null, 2) + '\n'; } catch { throw fault('state_value_invalid'); }
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) {
      throw fault('state_value_too_large');
    }

    try {
      const existing = lstatSync(target);
      assertOwnedRegularFile(existing);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const tmp = `${target}.tmp.${process.pid}.${randomUUID()}`;
    let fd;
    try {
      fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
      writeFileSync(fd, encoded, 'utf8');
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, target);
      fsyncDirBestEffort(dirname(target));
      return value;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      try { unlinkSync(tmp); } catch {}
      if (typeof error?.code === 'string' && error.code.startsWith('state_')) throw error;
      throw fault('state_write_failed');
    }
  }

  deleteFile(name) {
    this.ensureRoot();
    const target = this.resolveSafe(name);
    try {
      this.verifyAncestorsUnderRoot(target);
      const st = lstatSync(target);
      if (st.isSymbolicLink()) throw fault('state_file_untrusted');
      unlinkSync(target);
      fsyncDirBestEffort(dirname(target));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }

  /**
   * Atomically creates lockPath with a complete fsynced JSON payload via temp file + linkSync.
   * Eliminates 0-byte crash locks completely.
   */
  tryCreateLockAtomic(lockPath, payloadObj) {
    const tmp = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
    let fd;
    try {
      fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(payloadObj), 'utf8');
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      try {
        linkSync(tmp, lockPath);
        return true;
      } catch (linkErr) {
        if (linkErr?.code === 'EEXIST') return false;
        throw linkErr;
      }
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
      try { unlinkSync(tmp); } catch {}
    }
  }

  readLockHolder(lockPath) {
    let fd;
    try {
      fd = openSync(lockPath, fsConstants.O_RDONLY | O_NOFOLLOW);
      const st = fstatSync(fd);
      const uid = currentUid();
      if (!st.isFile() || st.isSymbolicLink() || (uid !== null && st.uid !== uid)) {
        throw fault('state_file_untrusted');
      }
      const raw = readFileSync(fd, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        return { parsed, mtimeMs: st.mtimeMs, readable: true };
      } catch {
        return { parsed: null, mtimeMs: st.mtimeMs, readable: false };
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error?.code === 'ELOOP' || error?.code === 'state_file_untrusted') throw fault('state_file_untrusted');
      return { parsed: null, mtimeMs: 0, readable: false };
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  reapStaleLockIfDead(lockPath, reapLockPath) {
    // Serialize stale eviction under a dedicated .reap lock so two contenders cannot unlink a fresh lock.
    const reapPayload = { pid: process.pid, startToken: readProcessStartToken(process.pid), token: randomUUID(), ts: Date.now() };
    if (!this.tryCreateLockAtomic(reapLockPath, reapPayload)) {
      const reapHolder = this.readLockHolder(reapLockPath);
      if (reapHolder && (!reapHolder.readable || !isSameRunningProcess(reapHolder.parsed?.pid, reapHolder.parsed?.startToken)) &&
          (Date.now() - reapHolder.mtimeMs > CORRUPT_LOCK_GRACE_MS || (reapHolder.readable && !isSameRunningProcess(reapHolder.parsed?.pid, reapHolder.parsed?.startToken)))) {
        try { unlinkSync(reapLockPath); } catch {}
      }
      return;
    }
    try {
      const current = this.readLockHolder(lockPath);
      if (!current) return;
      const staleDead = current.readable && !isSameRunningProcess(current.parsed?.pid, current.parsed?.startToken);
      const staleCorrupt = !current.readable && (Date.now() - current.mtimeMs > CORRUPT_LOCK_GRACE_MS);
      if (staleDead || staleCorrupt) {
        try { unlinkSync(lockPath); } catch {}
      }
    } finally {
      try {
        const check = this.readLockHolder(reapLockPath);
        if (check?.parsed?.pid === process.pid && check?.parsed?.token === reapPayload.token) {
          unlinkSync(reapLockPath);
        }
      } catch {}
    }
  }

  withFileLock(lockKey, fn) {
    this.ensureSubdir('locks');
    const hash = fingerprint(lockKey);
    const lockPath = this.resolveSafe(`locks/${hash}.lock`);
    const reapLockPath = this.resolveSafe(`locks/${hash}.reap`);
    const token = randomUUID();
    const deadline = Date.now() + LOCK_SPIN_TIMEOUT_MS;
    let acquired = false;

    while (!acquired) {
      if (this.tryCreateLockAtomic(lockPath, { pid: process.pid, startToken: readProcessStartToken(process.pid), token, ts: Date.now() })) {
        acquired = true;
        break;
      }
      const holder = this.readLockHolder(lockPath);
      if (holder && ((holder.readable && !isSameRunningProcess(holder.parsed?.pid, holder.parsed?.startToken)) ||
          (!holder.readable && Date.now() - holder.mtimeMs > CORRUPT_LOCK_GRACE_MS))) {
        this.reapStaleLockIfDead(lockPath, reapLockPath);
      }
      if (Date.now() >= deadline) throw fault('state_busy');
      sleepSync(15);
    }

    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw fault('state_update_async');
      return result;
    } finally {
      try {
        const holder = this.readLockHolder(lockPath);
        if (holder?.parsed?.pid === process.pid && holder?.parsed?.token === token) {
          unlinkSync(lockPath);
        }
      } catch {}
    }
  }

  updateJson(name, change, fallback = null) {
    return this.withFileLock(`file:${name}`, () => {
      const current = this.readJson(name, fallback);
      const next = change(current);
      if (next && typeof next.then === 'function') throw fault('state_update_async');
      if (next !== undefined) this.writeJsonAtomic(name, next);
      return next;
    });
  }

  /**
   * Long-lived per-conversation disk lease preventing multiple Antigravity windows or
   * surfaces from driving the same conversationId concurrently.
   * Both acquire and release serialize under the same lock key.
   */
  acquireConversationLease(conversationId) {
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw fault('conversation_id_required');
    this.ensureSubdir('leases');
    const rel = `leases/${fingerprint(conversationId)}.json`;
    const lockKey = `lease:${conversationId}`;
    const token = randomUUID();

    this.withFileLock(lockKey, () => {
      let existing = null;
      try {
        existing = this.readJson(rel, null);
      } catch (error) {
        if (error?.code === 'state_file_untrusted' || error?.code === 'state_directory_untrusted') throw error;
        // Corrupted/truncated lease file from a prior crash -> treat as stale.
        existing = null;
      }
      if (existing && isSameRunningProcess(existing.pid, existing.startToken)) {
        throw fault('conversation_owned_elsewhere', { holderPid: existing.pid });
      }
      this.writeJsonAtomic(rel, {
        pid: process.pid,
        startToken: readProcessStartToken(process.pid),
        token,
        conversationId,
        acquiredAt: new Date().toISOString(),
      });
    });

    return {
      token,
      assert: () => {
        const row = this.readJson(rel, null);
        if (!row || row.pid !== process.pid || row.token !== token) {
          throw fault('conversation_lease_lost');
        }
      },
      release: () => {
        this.withFileLock(lockKey, () => {
          let row = null;
          try { row = this.readJson(rel, null); } catch { row = null; }
          if (row && row.pid === process.pid && row.token === token) {
            this.deleteFile(rel);
          }
        });
      },
    };
  }

  chatPath(conversationId) {
    return `chats/${fingerprint(conversationId)}.json`;
  }

  defaultChat(conversationId) {
    return {
      version: 1,
      conversationId,
      registration: null,
      registrationHistory: [],
      inbox: [],
      outbox: [],
      conversations: [],
      cursors: {},
      taint: {
        tainted: false,
        lastRemoteTouchStepIndex: -1,
        lastRemoteTouchAt: null,
        lastClearedUserStepIndex: -1,
        reason: null,
      },
    };
  }

  readChat(conversationId) {
    return this.readJson(this.chatPath(conversationId), this.defaultChat(conversationId));
  }

  updateChat(conversationId, change) {
    return this.updateJson(this.chatPath(conversationId), change, this.defaultChat(conversationId));
  }

  dedupePath(nodeId) {
    return `dedupe/${fingerprint(nodeId)}.json`;
  }

  hasDedupe(nodeId, messageRef) {
    const data = this.readJson(this.dedupePath(nodeId), { version: 1, entries: [] });
    return Array.isArray(data.entries) && data.entries.includes(messageRef);
  }

  recordDedupe(nodeId, messageRef) {
    return this.updateJson(this.dedupePath(nodeId), (data) => {
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      if (!entries.includes(messageRef)) {
        entries.push(messageRef);
        if (entries.length > MAX_DEDUPE_ENTRIES) {
          entries.splice(0, entries.length - MAX_DEDUPE_ENTRIES);
        }
      }
      return { version: 1, entries };
    }, { version: 1, entries: [] });
  }

  syncHooksActiveMarker(active) {
    this.withFileLock('hooks-active', () => {
      if (active) {
        this.writeJsonAtomic('hooks-active', { active: true, updatedAt: new Date().toISOString() });
      } else {
        this.deleteFile('hooks-active');
      }
    });
  }

  syncTaintedFlag() {
    this.withFileLock('tainted-flag', () => {
      this.ensureSubdir('chats');
      const chatsDir = this.resolveSafe('chats');
      let anyTainted = false;
      try {
        for (const name of readdirSync(chatsDir)) {
          if (!name.endsWith('.json')) continue;
          try {
            const chat = this.readJson(`chats/${name}`, null);
            if (chat?.taint?.tainted === true) {
              anyTainted = true;
              break;
            }
          } catch {
            // Fail closed on transient read errors: preserve tainted.flag.
            anyTainted = true;
            break;
          }
        }
      } catch {
        anyTainted = true;
      }
      if (anyTainted) {
        this.writeJsonAtomic('tainted.flag', { tainted: true, updatedAt: new Date().toISOString() });
      } else {
        this.deleteFile('tainted.flag');
      }
    });
  }

  conversationFilePath(subdir, conversationId) {
    if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
      throw fault('conversation_id_invalid');
    }
    return `${subdir}/${conversationId.toLowerCase()}.json`;
  }

  wakePath(conversationId) {
    return this.conversationFilePath('wake', conversationId);
  }

  writeWakeTrigger(conversationId, payload) {
    this.ensureSubdir('wake');
    const rel = this.wakePath(conversationId);
    return this.withFileLock(`wake:${conversationId.toLowerCase()}`, () =>
      this.writeJsonAtomic(rel, {
        conversationId: conversationId.toLowerCase(),
        wakeToken: payload?.wakeToken ?? randomUUID(),
        queuedAt: payload?.queuedAt ?? Date.now(),
        ...(Number.isSafeInteger(payload?.hostPid) && payload.hostPid > 0 && { hostPid: payload.hostPid }),
        hostStartToken: payload?.hostStartToken ?? null,
      }),
    );
  }

  clearWakeTrigger(conversationId, expectedWakeToken = null) {
    try {
      const rel = this.wakePath(conversationId);
      this.withFileLock(`wake:${conversationId.toLowerCase()}`, () => {
        if (expectedWakeToken) {
          const cur = this.readJson(rel, null);
          if (cur && cur.wakeToken !== expectedWakeToken) return;
        }
        this.deleteFile(rel);
      });
    } catch {
      // Best-effort cleanup.
    }
  }

  listWakeTriggers() {
    this.ensureSubdir('wake');
    const wakeDir = this.resolveSafe('wake');
    const triggers = [];
    try {
      for (const name of readdirSync(wakeDir)) {
        if (!name.endsWith('.json')) continue;
        const convId = name.slice(0, -5);
        if (!UUID_RE.test(convId)) continue;
        try {
          const data = this.readJson(`wake/${name}`, null);
          if (data) triggers.push({ conversationId: convId.toLowerCase(), data });
        } catch {
          // Ignore transient or unreadable files.
        }
      }
    } catch {
      return [];
    }
    return triggers;
  }

  typingPath(conversationId) {
    return this.conversationFilePath('typing', conversationId);
  }

  writeTypingMarker(conversationId, payload) {
    this.ensureSubdir('typing');
    const rel = this.typingPath(conversationId);
    return this.withFileLock(`typing:${conversationId.toLowerCase()}`, () =>
      this.writeJsonAtomic(rel, {
        conversationId: conversationId.toLowerCase(),
        conversationRef: payload.conversationRef,
        endpointId: payload.endpointId,
        token: payload?.token ?? randomUUID(),
        startedAt: payload?.startedAt ?? Date.now(),
      }),
    );
  }

  readTypingMarker(conversationId) {
    try {
      return this.readJson(this.typingPath(conversationId), null);
    } catch {
      return null;
    }
  }

  clearTypingMarker(conversationId, { token = null, conversationRef = null } = {}) {
    try {
      const rel = this.typingPath(conversationId);
      this.withFileLock(`typing:${conversationId.toLowerCase()}`, () => {
        if (token || conversationRef) {
          const cur = this.readJson(rel, null);
          if (!cur) return;
          if (token && cur.token !== token) return;
          if (conversationRef && cur.conversationRef !== conversationRef) return;
        }
        this.deleteFile(rel);
      });
    } catch {
      // Best-effort cleanup.
    }
  }

  sidecarHeartbeatPath(hostPid) {
    if (!Number.isSafeInteger(hostPid) || hostPid < 1) throw fault('host_pid_invalid');
    return `sidecars/host-${hostPid}.json`;
  }

  sidecarSocketPath(hostPid) {
    if (!Number.isSafeInteger(hostPid) || hostPid < 1) throw fault('host_pid_invalid');
    return this.resolveSafe(`sidecars/s-${hostPid}.sock`);
  }

  writeSidecarHeartbeat({
    pid = process.pid,
    hostPid,
    hostStartToken = null,
    startedAt,
    updatedAt = Date.now(),
    conversationService = false,
    socketPath = null,
    ipcToken = null,
  } = {}) {
    this.ensureSubdir('sidecars');
    return this.writeJsonAtomic(this.sidecarHeartbeatPath(hostPid), {
      pid,
      hostPid,
      hostStartToken: hostStartToken ?? null,
      startedAt: startedAt ?? updatedAt,
      updatedAt,
      ...(conversationService === true && { conversationService: true }),
      ...(typeof socketPath === 'string' && socketPath && { socketPath }),
      ...(typeof ipcToken === 'string' && ipcToken && { ipcToken }),
    });
  }

  clearSidecarHeartbeat({ pid = process.pid, hostPid } = {}) {
    try {
      const path = this.sidecarHeartbeatPath(hostPid);
      const cur = this.readJson(path, null);
      if (cur && cur.pid === pid) this.deleteFile(path);
    } catch {
      // Best-effort cleanup.
    }
  }

  readSidecarStatus(hostProvenance, nowMs = Date.now()) {
    if (!Number.isSafeInteger(hostProvenance?.hostPid) || hostProvenance.hostPid < 1) {
      return { running: false, conversationService: false };
    }
    try {
      const hb = this.readJson(this.sidecarHeartbeatPath(hostProvenance.hostPid), null);
      if (!hb || !Number.isSafeInteger(hb.pid) || !Number.isFinite(hb.updatedAt)) {
        return { running: false, conversationService: false };
      }
      if (!sameHostProvenance(hb, hostProvenance)) return { running: false, conversationService: false };
      if (nowMs - hb.updatedAt > 90_000) return { running: false, conversationService: false };
      if (!isPidAlive(hb.pid)) return { running: false, conversationService: false };
      const expectedSocketPath = this.sidecarSocketPath(hostProvenance.hostPid);
      const hasConvService = hb.conversationService === true &&
        hb.socketPath === expectedSocketPath &&
        typeof hb.ipcToken === 'string' && hb.ipcToken.length > 0;
      return {
        running: true,
        pid: hb.pid,
        hostPid: hb.hostPid,
        startedAt: hb.startedAt ?? hb.updatedAt,
        updatedAt: hb.updatedAt,
        conversationService: hasConvService,
        ...(hasConvService && { socketPath: hb.socketPath, ipcToken: hb.ipcToken }),
      };
    } catch {
      return { running: false, conversationService: false };
    }
  }

  acquireNamedLock(name, extraPayload = {}) {
    if (typeof name !== 'string' || !/^[a-z0-9_-]{1,64}$/u.test(name)) throw fault('state_name_invalid');
    this.ensureSubdir('locks');
    const lockPath = this.resolveSafe(`locks/${name}.lock`);
    const reapPath = `${lockPath}.reap`;
    const token = randomUUID();
    const payload = {
      pid: process.pid,
      startToken: readProcessStartToken(process.pid),
      ...extraPayload,
      token,
      acquiredAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.tryCreateLockAtomic(lockPath, payload)) {
        return {
          release: () => {
            try {
              const cur = this.readLockHolder(lockPath);
              if (cur?.parsed?.pid === process.pid && cur?.parsed?.token === token) {
                unlinkSync(lockPath);
              }
            } catch {}
          },
        };
      }
      this.reapStaleLockIfDead(lockPath, reapPath);
    }
    return null;
  }

  acquireLinkPollLock() {
    return this.acquireNamedLock('link-poll');
  }

  acquireSidecarLock(hostPid) {
    if (!Number.isSafeInteger(hostPid) || hostPid < 1) throw fault('host_pid_invalid');
    return this.acquireNamedLock(`sidecar-${hostPid}`, { hostPid });
  }
}
