import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CONFIG from './build-config.mjs';
import { SIDECAR_WAKE_PROMPT } from './caller.mjs';
import { canonicalStateRoot } from './channel.mjs';
import {
  StateStore,
  captureHostProvenance,
  isSameRunningProcess,
  sameHostProvenance,
} from './store.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEARTBEAT_INTERVAL_MS = 25_000;
const FALLBACK_SCAN_MS = 1_000;
const DEBOUNCE_MS = 350;
const MIN_WAKE_INTERVAL_MS = 3_000;
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];
const AGENTAPI_TIMEOUT_MS = 15_000;

function defaultExecAgentApi(conversationId, prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      'agentapi',
      ['send-message', conversationId, prompt],
      { timeout: AGENTAPI_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = error.code ?? (error.killed ? 'TIMEOUT' : 'EXEC_FAILED');
          reject(Object.assign(new Error(`agentapi_${code}`), { code, stderr: String(stderr ?? '').slice(0, 200) }));
          return;
        }
        resolve({ stdout: String(stdout ?? '') });
      },
    );
  });
}

export class SidecarWakeupDaemon {
  constructor({
    store,
    hostProvenance = captureHostProvenance(),
    execAgentApi = defaultExecAgentApi,
    debounceMs = DEBOUNCE_MS,
    minWakeIntervalMs = MIN_WAKE_INTERVAL_MS,
    fallbackScanMs = FALLBACK_SCAN_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
    now = Date.now,
    log = (msg) => process.stderr.write(`${msg}\n`),
  }) {
    this.store = store;
    this.hostProvenance = hostProvenance;
    this.execAgentApi = execAgentApi;
    this.debounceMs = debounceMs;
    this.minWakeIntervalMs = minWakeIntervalMs;
    this.fallbackScanMs = fallbackScanMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.retryDelaysMs = retryDelaysMs;
    this.now = now;
    this.log = log;

    this.startedAt = now();
    this.closed = false;
    this.lock = null;
    this.watcher = null;
    this.heartbeatTimer = null;
    this.scanTimer = null;
    this.inflight = new Set();
    this.lastWakeMs = new Map();
    this.retryCounts = new Map();
    this.retryTimers = new Map();
  }

  start() {
    this.store.ensureRoot();
    this.store.ensureSubdir('wake');
    this.store.ensureSubdir('sidecars');
    try { this.store.deleteFile('sidecar-heartbeat.json'); } catch {}
    this.lock = this.store.acquireSidecarLock(this.hostProvenance.hostPid);
    if (!this.lock) {
      this.log('[masons-sidecar] another sidecar instance for this host is already active; exiting');
      return false;
    }

    this.store.writeSidecarHeartbeat({
      pid: process.pid,
      ...this.hostProvenance,
      startedAt: this.startedAt,
      updatedAt: this.now(),
    });
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      // Exit cleanly if the owning host process died or its PID was recycled (prevents orphaned sidecars).
      if (!isSameRunningProcess(this.hostProvenance.hostPid, this.hostProvenance.hostStartToken)) {
        this.log('[masons-sidecar] parent host process exited; shutting down');
        this.stop();
        return;
      }
      try {
        this.store.writeSidecarHeartbeat({
          pid: process.pid,
          ...this.hostProvenance,
          startedAt: this.startedAt,
          updatedAt: this.now(),
        });
      } catch {
        // Ignore transient write failure; next tick retries.
      }
    }, this.heartbeatIntervalMs);

    const wakeDir = this.store.resolveSafe('wake');
    try {
      this.watcher = watch(wakeDir, (_eventType, filename) => {
        if (this.closed || typeof filename !== 'string' || !filename.endsWith('.json')) return;
        const convId = filename.slice(0, -5);
        if (UUID_RE.test(convId)) {
          this.scheduleProcess(convId.toLowerCase(), this.debounceMs);
        }
      });
      this.watcher.on('error', () => {});
    } catch {
      // Fallback scan handles platforms where fs.watch is unavailable.
    }

    this.scanTimer = setInterval(() => {
      if (this.closed) return;
      this.scanOnce();
    }, this.fallbackScanMs);

    this.scanOnce();
    return true;
  }

  scanOnce() {
    const triggers = this.store.listWakeTriggers();
    for (const { conversationId, data } of triggers) {
      if (this.inflight.has(conversationId) || this.retryTimers.has(conversationId)) continue;
      if (!sameHostProvenance(data, this.hostProvenance)) {
        // Reap stale triggers whose owning host process died or was recycled; leave other live hosts untouched.
        if (!Number.isSafeInteger(data?.hostPid) || !isSameRunningProcess(data.hostPid, data.hostStartToken)) {
          this.store.clearWakeTrigger(conversationId, data?.wakeToken ?? null);
        }
        continue;
      }
      this.scheduleProcess(conversationId, this.debounceMs);
    }
  }

  scheduleProcess(conversationId, delayMs) {
    if (this.closed || this.inflight.has(conversationId) || this.retryTimers.has(conversationId)) return;
    const last = this.lastWakeMs.get(conversationId) ?? 0;
    const waitForRate = Math.max(0, this.minWakeIntervalMs - (this.now() - last));
    const effectiveDelay = Math.max(delayMs, waitForRate);
    const timer = setTimeout(() => {
      this.retryTimers.delete(conversationId);
      void this.processConversation(conversationId);
    }, effectiveDelay);
    timer.unref?.();
    this.retryTimers.set(conversationId, timer);
  }

  async processConversation(conversationId) {
    if (this.closed || this.inflight.has(conversationId)) return;
    this.inflight.add(conversationId);
    let nextDelayMs = null;
    try {
      const trigger = this.store.readJson(this.store.wakePath(conversationId), null);
      if (!trigger) {
        this.retryCounts.delete(conversationId);
        return;
      }
      // Host-affinity fence: only wake conversations owned by this exact host process.
      if (!sameHostProvenance(trigger, this.hostProvenance)) {
        if (!Number.isSafeInteger(trigger.hostPid) || !isSameRunningProcess(trigger.hostPid, trigger.hostStartToken)) {
          this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
        }
        this.retryCounts.delete(conversationId);
        return;
      }
      const chat = this.store.readChat(conversationId);
      if (chat.registration?.state === 'fenced') {
        this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
        this.retryCounts.delete(conversationId);
        return;
      }
      const hasPending = (chat.inbox ?? []).some((r) => r.phase === 'pending');
      if (!hasPending) {
        this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
        this.retryCounts.delete(conversationId);
        return;
      }
      const hasInFlight = (chat.inbox ?? []).some((r) => r.phase === 'in_flight');
      if (hasInFlight) {
        // Turn is already executing; Stop -> continue will pick up pending rows. Re-check shortly if needed.
        nextDelayMs = this.minWakeIntervalMs;
        return;
      }

      this.lastWakeMs.set(conversationId, this.now());
      if (this.lastWakeMs.size > 512) {
        const oldestKey = this.lastWakeMs.keys().next().value;
        if (oldestKey !== undefined) this.lastWakeMs.delete(oldestKey);
      }
      await this.execAgentApi(conversationId, SIDECAR_WAKE_PROMPT);
      if (!this.closed) {
        // Token-verified CAS clear so a newer wakeToken arriving during execAgentApi is never lost.
        this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
      }
      this.retryCounts.delete(conversationId);
    } catch (error) {
      const tries = (this.retryCounts.get(conversationId) ?? 0) + 1;
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      this.log(`[masons-sidecar] wake failed (${code}) attempt=${tries}`);
      if (tries <= this.retryDelaysMs.length) {
        this.retryCounts.set(conversationId, tries);
        nextDelayMs = this.retryDelaysMs[tries - 1];
      } else {
        this.retryCounts.delete(conversationId);
        if (!this.closed) this.store.clearWakeTrigger(conversationId);
      }
    } finally {
      this.inflight.delete(conversationId);
      if (nextDelayMs !== null && !this.closed) {
        this.scheduleProcess(conversationId, nextDelayMs);
      }
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
    this.store.clearSidecarHeartbeat({ pid: process.pid, hostPid: this.hostProvenance.hostPid });
    try { this.lock?.release(); } catch {}
    this.lock = null;
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntrypoint) {
  const store = new StateStore(canonicalStateRoot(CONFIG));
  const daemon = new SidecarWakeupDaemon({ store });
  const started = daemon.start();
  if (!started) {
    process.exit(0);
  }
  const shutdown = () => {
    daemon.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
