import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync, watch } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import CONFIG from './build-config.mjs';
import { SIDECAR_WAKE_PROMPT } from './caller.mjs';
import { canonicalStateRoot } from './channel.mjs';
import { createConversationServiceClient, sanitizeSessionTitle } from './conversation-service.mjs';
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
const BUSY_BACKOFF_MS = [3_000, 3_000, 5_000, 10_000];
const ARCHIVED_RECHECK_MS = 60_000;
const STRANDED_IDLE_MIN_MS = 6_000;
const AGENTAPI_TIMEOUT_MS = 15_000;
const PROBE_RETRY_INTERVAL_MS = 5_000;
const PROBE_MAX_ATTEMPTS = 6;
const MAX_BRIDGE_REQUEST_BYTES = 4_096;
const MAX_BRIDGE_CONNECTIONS = 16;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

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

function safeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function hasOnlyKeys(obj, allowed) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  for (const key of Object.keys(obj)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
    if (!allowed.has(key)) return false;
  }
  return true;
}

const REQUEST_KEYS = new Set(['token', 'hostPid', 'hostStartToken', 'method', 'params']);
const GET_PARAM_KEYS = new Set(['conversationId']);
const SET_TITLE_PARAM_KEYS = new Set(['conversationId', 'title']);

export class SidecarWakeupDaemon {
  constructor({
    store,
    hostProvenance = captureHostProvenance(),
    execAgentApi = defaultExecAgentApi,
    conversationService = undefined,
    debounceMs = DEBOUNCE_MS,
    minWakeIntervalMs = MIN_WAKE_INTERVAL_MS,
    fallbackScanMs = FALLBACK_SCAN_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
    busyBackoffMs = BUSY_BACKOFF_MS,
    archivedRecheckMs = ARCHIVED_RECHECK_MS,
    strandedIdleMinMs = STRANDED_IDLE_MIN_MS,
    now = Date.now,
    log = (msg) => process.stderr.write(`${msg}\n`),
  }) {
    this.store = store;
    this.hostProvenance = hostProvenance;
    this.execAgentApi = execAgentApi;
    this.conversationService = conversationService !== undefined
      ? conversationService
      : createConversationServiceClient();
    this.debounceMs = debounceMs;
    this.minWakeIntervalMs = minWakeIntervalMs;
    this.fallbackScanMs = fallbackScanMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.retryDelaysMs = retryDelaysMs;
    this.busyBackoffMs = busyBackoffMs;
    this.archivedRecheckMs = archivedRecheckMs;
    this.strandedIdleMinMs = strandedIdleMinMs;
    this.now = now;
    this.log = log;

    this.startedAt = now();
    this.closed = false;
    this.lock = null;
    this.watcher = null;
    this.heartbeatTimer = null;
    this.scanTimer = null;
    this.probeTimer = null;
    this.probeAttempts = 0;
    this.conversationServiceReady = false;
    this.bridgeServer = null;
    this.bridgeSocketPath = null;
    this.bridgeToken = null;
    this.activeBridgeSockets = new Set();

    this.inflight = new Set();
    this.lastWakeMs = new Map();
    this.retryCounts = new Map();
    this.busyCounts = new Map();
    this.strandedIdleState = new Map(); // conversationId -> firstSeenMs
    this.lastSeenWakeToken = new Map();
    this.retryTimers = new Map(); // conversationId -> { timer, dueAtMs }
  }

  recordSeenWakeToken(conversationId, token) {
    this.lastSeenWakeToken.set(conversationId, token);
    if (this.lastSeenWakeToken.size > 512) {
      const oldestKey = this.lastSeenWakeToken.keys().next().value;
      if (oldestKey !== undefined) this.lastSeenWakeToken.delete(oldestKey);
    }
  }

  writeHeartbeatNow() {
    this.store.writeSidecarHeartbeat({
      pid: process.pid,
      ...this.hostProvenance,
      startedAt: this.startedAt,
      updatedAt: this.now(),
      conversationService: this.conversationServiceReady && Boolean(this.bridgeSocketPath && this.bridgeToken),
      socketPath: this.conversationServiceReady ? this.bridgeSocketPath : null,
      ipcToken: this.conversationServiceReady ? this.bridgeToken : null,
    });
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

    this.writeHeartbeatNow();
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      // Exit cleanly if the owning host process died or its PID was recycled (prevents orphaned sidecars).
      if (!isSameRunningProcess(this.hostProvenance.hostPid, this.hostProvenance.hostStartToken)) {
        this.log('[masons-sidecar] parent host process exited; shutting down');
        this.stop();
        return;
      }
      try {
        this.writeHeartbeatNow();
      } catch {
        // Ignore transient write failure; next tick retries.
      }
    }, this.heartbeatIntervalMs);

    if (this.conversationService) {
      void this.probeAndEnableConversationService();
    }

    const wakeDir = this.store.resolveSafe('wake');
    try {
      this.watcher = watch(wakeDir, (_eventType, filename) => {
        if (this.closed || typeof filename !== 'string' || !filename.endsWith('.json')) return;
        const convId = filename.slice(0, -5);
        if (UUID_RE.test(convId)) {
          const normalized = convId.toLowerCase();
          if (this.inflight.has(normalized)) return;
          const trigger = this.store.readJson(this.store.wakePath(normalized), null);
          if (!trigger || !sameHostProvenance(trigger, this.hostProvenance)) return;
          const token = typeof trigger.wakeToken === 'string' ? trigger.wakeToken : null;
          const isNewToken = token !== null && this.lastSeenWakeToken.get(normalized) !== token;
          if (token !== null) this.recordSeenWakeToken(normalized, token);
          this.scheduleProcess(normalized, this.debounceMs, { shortenExisting: isNewToken });
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

  async probeAndEnableConversationService() {
    if (this.closed || this.conversationServiceReady || !this.conversationService) return false;
    this.probeAttempts += 1;
    let ok = false;
    try {
      ok = await this.conversationService.probe({ timeoutMs: 500 });
    } catch {
      ok = false;
    }
    if (this.closed) return false;
    if (ok) {
      const bound = await this.startBridgeServer();
      if (bound && !this.closed) {
        this.conversationServiceReady = true;
        try { this.writeHeartbeatNow(); } catch {}
        return true;
      }
      if (this.closed) return false;
    }
    if (this.probeAttempts < PROBE_MAX_ATTEMPTS && !this.closed) {
      this.probeTimer = setTimeout(() => {
        this.probeTimer = null;
        void this.probeAndEnableConversationService();
      }, PROBE_RETRY_INTERVAL_MS);
      this.probeTimer.unref?.();
    }
    return false;
  }

  unlinkOwnedSocket(sockPath) {
    try {
      const st = lstatSync(sockPath);
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (st.isSocket() && (uid === null || st.uid === uid)) {
        unlinkSync(sockPath);
        return true;
      }
      return false;
    } catch (error) {
      return error?.code === 'ENOENT';
    }
  }

  startBridgeServer() {
    if (this.closed) return Promise.resolve(false);
    if (this.bridgeServer) return Promise.resolve(true);
    const sockPath = this.store.sidecarSocketPath(this.hostProvenance.hostPid);
    if (Buffer.byteLength(sockPath, 'utf8') >= MAX_UNIX_SOCKET_PATH_BYTES) {
      this.log('[masons-sidecar] sidecar socket path exceeds UNIX socket limit; disabling ConversationService bridge');
      return Promise.resolve(false);
    }

    // Safely unlink only a stale owned socket file (never follow symlinks or unlink foreign/regular files).
    if (!this.unlinkOwnedSocket(sockPath)) {
      this.log('[masons-sidecar] non-owned or non-socket file exists at bridge socket path; refusing to bind');
      return Promise.resolve(false);
    }

    const token = randomBytes(32).toString('hex');
    const server = createServer((socket) => this.handleBridgeSocket(socket));
    this.bridgeServer = server;
    this.bridgeSocketPath = sockPath;
    this.bridgeToken = token;

    return new Promise((resolveStart) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolveStart(ok);
      };

      const cleanupFailed = () => {
        try { server.close(); } catch {}
        if (this.bridgeServer === server) {
          this.bridgeServer = null;
          this.bridgeSocketPath = null;
          this.bridgeToken = null;
        }
        this.unlinkOwnedSocket(sockPath);
        done(false);
      };

      server.once('error', cleanupFailed);
      server.once('close', () => done(false));
      server.listen(sockPath, () => {
        server.off('error', cleanupFailed);
        if (this.closed) {
          cleanupFailed();
          return;
        }
        try { chmodSync(sockPath, 0o600); } catch {}
        server.on('error', () => {});
        done(true);
      });
    });
  }

  handleBridgeSocket(socket) {
    if (this.closed || this.activeBridgeSockets.size >= MAX_BRIDGE_CONNECTIONS) {
      try { socket.destroy(); } catch {}
      return;
    }
    this.activeBridgeSockets.add(socket);

    let buf = Buffer.alloc(0);
    let handled = false;
    let closeFallbackTimer = null;
    const timeout = setTimeout(() => {
      try { socket.destroy(); } catch {}
    }, 5_000);
    timeout.unref?.();

    const clearTimers = () => {
      clearTimeout(timeout);
      if (closeFallbackTimer) {
        clearTimeout(closeFallbackTimer);
        closeFallbackTimer = null;
      }
    };

    socket.on('close', () => {
      clearTimers();
      this.activeBridgeSockets.delete(socket);
    });
    socket.on('error', () => {});
    socket.on('end', () => {
      if (!handled) {
        try { socket.destroy(); } catch {}
      }
    });

    const respond = (payload) => {
      clearTimeout(timeout);
      try { socket.pause(); } catch {}
      closeFallbackTimer = setTimeout(() => {
        try { socket.destroy(); } catch {}
      }, 1_000);
      closeFallbackTimer.unref?.();
      try {
        socket.end(`${JSON.stringify(payload)}\n`, () => {
          try { socket.destroy(); } catch {}
        });
      } catch {
        try { socket.destroy(); } catch {}
      }
    };

    socket.on('data', (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BRIDGE_REQUEST_BYTES) {
        handled = true;
        respond({ ok: false, error: 'request_too_large' });
        return;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      handled = true;
      const line = buf.subarray(0, nl).toString('utf8');
      void this.handleBridgeRequest(line).then(respond, (err) => {
        respond({ ok: false, error: typeof err?.code === 'string' ? err.code : 'bridge_internal_error' });
      });
    });
  }

  async handleBridgeRequest(line) {
    if (this.closed || !this.conversationServiceReady || !this.conversationService) {
      return { ok: false, error: 'conversation_service_unavailable' };
    }
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return { ok: false, error: 'request_malformed' };
    }
    if (!hasOnlyKeys(req, REQUEST_KEYS)) {
      return { ok: false, error: 'request_invalid' };
    }
    if (!safeTokenEqual(req.token, this.bridgeToken)) {
      return { ok: false, error: 'unauthorized' };
    }
    if (!sameHostProvenance({ hostPid: req.hostPid, hostStartToken: req.hostStartToken }, this.hostProvenance)) {
      return { ok: false, error: 'host_mismatch' };
    }

    const params = req.params;
    if (req.method === 'conversation.get') {
      if (!hasOnlyKeys(params, GET_PARAM_KEYS) || typeof params.conversationId !== 'string' || !UUID_RE.test(params.conversationId)) {
        return { ok: false, error: 'conversation_id_invalid' };
      }
      const conversationId = params.conversationId.toLowerCase();
      if (!this.isConversationOwnedByHost(conversationId)) {
        return { ok: false, error: 'conversation_not_owned' };
      }
      try {
        const result = await this.conversationService.getConversation(conversationId);
        return { ok: true, result };
      } catch (error) {
        this.checkHostAliveOnLsFault(error);
        return { ok: false, error: typeof error?.code === 'string' ? error.code : 'transient' };
      }
    }

    if (req.method === 'conversation.setTitle') {
      if (!hasOnlyKeys(params, SET_TITLE_PARAM_KEYS) || typeof params.conversationId !== 'string' || !UUID_RE.test(params.conversationId)) {
        return { ok: false, error: 'conversation_id_invalid' };
      }
      const cleanTitle = sanitizeSessionTitle(params.title);
      if (!cleanTitle) {
        return { ok: false, error: 'title_invalid' };
      }
      const conversationId = params.conversationId.toLowerCase();
      if (!this.isConversationOwnedByHost(conversationId)) {
        return { ok: false, error: 'conversation_not_owned' };
      }
      try {
        const result = await this.conversationService.setConversationTitle(conversationId, cleanTitle);
        return { ok: true, result };
      } catch (error) {
        this.checkHostAliveOnLsFault(error);
        return { ok: false, error: typeof error?.code === 'string' ? error.code : 'transient' };
      }
    }

    return { ok: false, error: 'method_forbidden' };
  }

  isConversationOwnedByHost(conversationId) {
    try {
      const chat = this.store.readChat(conversationId);
      if (chat.registration?.state === 'fenced') return false;
      return sameHostProvenance(chat.hostProvenance, this.hostProvenance);
    } catch {
      return false;
    }
  }

  checkHostAliveOnLsFault(error) {
    if (error?.code !== 'connection_refused' && error?.code !== 'auth_failed') return;
    if (!isSameRunningProcess(this.hostProvenance.hostPid, this.hostProvenance.hostStartToken)) {
      this.log('[masons-sidecar] parent host process exited (detected on LS fault); shutting down');
      this.stop();
    }
  }

  clearConversationTrackers(conversationId) {
    this.retryCounts.delete(conversationId);
    this.busyCounts.delete(conversationId);
    this.strandedIdleState.delete(conversationId);
    this.lastSeenWakeToken.delete(conversationId);
  }

  scanOnce() {
    const triggers = this.store.listWakeTriggers();
    for (const { conversationId, data } of triggers) {
      if (this.inflight.has(conversationId)) continue;
      if (!sameHostProvenance(data, this.hostProvenance)) {
        // Reap stale triggers whose owning host process died or was recycled; leave other live hosts untouched.
        if (!Number.isSafeInteger(data?.hostPid) || !isSameRunningProcess(data.hostPid, data.hostStartToken)) {
          this.store.clearWakeTrigger(conversationId, data?.wakeToken ?? null);
        }
        continue;
      }
      const token = typeof data?.wakeToken === 'string' ? data.wakeToken : null;
      const isNewToken = token !== null && this.lastSeenWakeToken.get(conversationId) !== token;
      if (token !== null) this.recordSeenWakeToken(conversationId, token);
      if (this.retryTimers.has(conversationId) && !isNewToken) continue;
      this.scheduleProcess(conversationId, this.debounceMs, { shortenExisting: isNewToken });
    }
  }

  scheduleProcess(conversationId, delayMs, { shortenExisting = false } = {}) {
    if (this.closed || this.inflight.has(conversationId)) return;
    const nowMs = this.now();
    const last = this.lastWakeMs.get(conversationId) ?? 0;
    const waitForRate = Math.max(0, this.minWakeIntervalMs - (nowMs - last));
    const effectiveDelay = Math.max(delayMs, waitForRate);
    const dueAtMs = nowMs + effectiveDelay;

    const existing = this.retryTimers.get(conversationId);
    if (existing) {
      if (!shortenExisting || dueAtMs >= existing.dueAtMs) return;
      clearTimeout(existing.timer);
      this.retryTimers.delete(conversationId);
    }

    const timer = setTimeout(() => {
      this.retryTimers.delete(conversationId);
      void this.processConversation(conversationId);
    }, effectiveDelay);
    timer.unref?.();
    this.retryTimers.set(conversationId, { timer, dueAtMs });
  }

  async processConversation(conversationId) {
    if (this.closed || this.inflight.has(conversationId)) return;
    this.inflight.add(conversationId);
    let nextDelayMs = null;
    let triggerWakeToken = null;
    try {
      const trigger = this.store.readJson(this.store.wakePath(conversationId), null);
      if (!trigger) {
        this.clearConversationTrackers(conversationId);
        return;
      }
      triggerWakeToken = typeof trigger.wakeToken === 'string' ? trigger.wakeToken : null;
      // Host-affinity fence: only wake conversations owned by this exact host process.
      if (!sameHostProvenance(trigger, this.hostProvenance)) {
        if (!Number.isSafeInteger(trigger.hostPid) || !isSameRunningProcess(trigger.hostPid, trigger.hostStartToken)) {
          this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
        }
        this.clearConversationTrackers(conversationId);
        return;
      }
      const chat = this.store.readChat(conversationId);
      if (chat.registration?.state === 'fenced') {
        this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
        this.clearConversationTrackers(conversationId);
        return;
      }
      const hasPending = (chat.inbox ?? []).some((r) => r.phase === 'pending');
      if (!hasPending) {
        this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
        this.clearConversationTrackers(conversationId);
        return;
      }

      const hasInFlight = (chat.inbox ?? []).some((r) => r.phase === 'in_flight');
      let convState = null;

      if (this.conversationServiceReady && this.conversationService) {
        try {
          convState = await this.conversationService.getConversation(conversationId);
        } catch (error) {
          if (error?.code === 'not_found') {
            // Definitive Connect not_found — stop futile wake retries cleanly.
            this.store.clearWakeTrigger(conversationId, trigger.wakeToken ?? null);
            this.clearConversationTrackers(conversationId);
            return;
          }
          this.checkHostAliveOnLsFault(error);
          if (this.closed) return;
          // Fail-open on any transient / unavailable error so inbound messages are never stranded.
          convState = null;
        }
      }

      if (convState?.archived === true) {
        // Archived conversation — suppress wake prompt, recheck slowly so unarchiving delivers.
        this.retryCounts.delete(conversationId);
        this.busyCounts.delete(conversationId);
        this.strandedIdleState.delete(conversationId);
        nextDelayMs = this.archivedRecheckMs;
        return;
      }

      if (hasInFlight) {
        // Turn may already be executing; recover only if LS reports RUN_STATE_IDLE persistently (>=2 checks & >=6s).
        if (convState?.runState === 'RUN_STATE_IDLE') {
          const firstSeenMs = this.strandedIdleState.get(conversationId);
          const nowMs = this.now();
          if (firstSeenMs === undefined) {
            this.strandedIdleState.set(conversationId, nowMs);
            nextDelayMs = this.minWakeIntervalMs;
            return;
          }
          if (nowMs - firstSeenMs < this.strandedIdleMinMs) {
            nextDelayMs = this.minWakeIntervalMs;
            return;
          }
          // Confirmed stranded in_flight while LS is idle: fall through to wake and let PreInvocation reconcile.
          this.strandedIdleState.delete(conversationId);
        } else {
          this.strandedIdleState.delete(conversationId);
          nextDelayMs = this.minWakeIntervalMs;
          return;
        }
      } else {
        this.strandedIdleState.delete(conversationId);
      }

      // Busy-aware wakeup gating — defer agentapi send-message while LS is actively running/cancelling.
      if (convState?.runState === 'RUN_STATE_RUNNING' || convState?.runState === 'RUN_STATE_CANCELLING') {
        this.retryCounts.delete(conversationId);
        const busyIdx = this.busyCounts.get(conversationId) ?? 0;
        this.busyCounts.set(conversationId, busyIdx + 1);
        nextDelayMs = this.busyBackoffMs[Math.min(busyIdx, this.busyBackoffMs.length - 1)] ?? this.minWakeIntervalMs;
        return;
      }
      this.busyCounts.delete(conversationId);

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
      this.clearConversationTrackers(conversationId);
    } catch (error) {
      const tries = (this.retryCounts.get(conversationId) ?? 0) + 1;
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      this.log(`[masons-sidecar] wake failed (${code}) attempt=${tries}`);
      if (tries <= this.retryDelaysMs.length) {
        this.retryCounts.set(conversationId, tries);
        nextDelayMs = this.retryDelaysMs[tries - 1];
      } else {
        this.clearConversationTrackers(conversationId);
        if (!this.closed && triggerWakeToken) {
          this.store.clearWakeTrigger(conversationId, triggerWakeToken);
        }
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
    this.conversationServiceReady = false;
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    for (const entry of this.retryTimers.values()) clearTimeout(entry.timer);
    this.retryTimers.clear();
    for (const sock of this.activeBridgeSockets) {
      try { sock.destroy(); } catch {}
    }
    this.activeBridgeSockets.clear();
    if (this.bridgeServer) {
      try { this.bridgeServer.close(); } catch {}
      this.bridgeServer = null;
    }
    if (this.bridgeSocketPath) {
      this.unlinkOwnedSocket(this.bridgeSocketPath);
      this.bridgeSocketPath = null;
    }
    this.bridgeToken = null;
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
