import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  statSync,
  watch,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import CONFIG from './build-config.mjs';
import { SIDECAR_WAKE_PROMPT, canonicalizePath, isPathUnder, markRemoteTaint } from './caller.mjs';
import { canonicalStateRoot } from './channel.mjs';
import {
  StateStore,
  readProcessStartToken,
  sameHostProvenance,
} from './store.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HEARTBEAT_INTERVAL_MS = 25_000;
const DEBOUNCE_MS = 120;
const MIN_WAKE_INTERVAL_MS = 2_000;
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];
const HANDSHAKE_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_TURN_QUEUE = 64;
const MAX_STDERR_TAIL = 4096;

export const USAGE_TEXT = `Usage: masons-agy.sh [options]

Options:
  -c, --conversation <uuid>          Resume an existing Antigravity conversation by UUID
  --cwd <dir>                        Working directory for the session (default: current directory)
  -p, --prompt <text>                Initial prompt to send immediately after startup
  --headless                         Run without interactive prompt (autonomous MASONS wake mode)
  --sandbox                          Pass --sandbox to agy acp
  --dangerously-skip-permissions     Pass --dangerously-skip-permissions to agy acp
  --agent <name>                     Pass --agent <name> to agy acp
  --add-dir <dir>                    Pass --add-dir <dir> to agy acp (repeatable)
  --agy-bin <path>                   Explicit path to trusted agy executable
  -h, --help                         Show this help message
`;

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isTrustedExecutable(filePath) {
  try {
    accessSync(filePath, fsConstants.X_OK);
    const st = statSync(filePath);
    if (!st.isFile()) return false;
    if ((st.mode & 0o022) !== 0) return false;
    const uid = currentUid();
    if (uid !== null && st.uid !== 0 && st.uid !== uid) return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveAgyBin(explicit, { home = homedir(), envPath = process.env.PATH ?? '' } = {}) {
  const requested = typeof explicit === 'string' && explicit.trim() ? explicit.trim() : '';
  if (requested) {
    if (requested.includes('/') || isAbsolute(requested)) {
      const abs = resolve(requested);
      if (!isTrustedExecutable(abs)) {
        throw new Error(`untrusted_agy_binary:${abs}`);
      }
      return abs;
    }
    if (requested !== 'agy') {
      throw new Error(`invalid_agy_binary:${requested}`);
    }
  }

  const candidates = [];
  for (const dir of envPath.split(':')) {
    if (!dir || !isAbsolute(dir) || dir.includes('..')) continue;
    candidates.push(join(dir, 'agy'));
  }
  candidates.push(
    join(home, '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  );

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isTrustedExecutable(candidate)) return candidate;
  }
  throw new Error('agy_binary_not_found');
}

function assertSafeAddDir(rawDir, { cwd, home }) {
  if (!rawDir || rawDir.startsWith('-')) {
    throw new Error('invalid_add_dir');
  }
  const abs = canonicalizePath(resolve(cwd, rawDir));
  const stateParent = canonicalizePath(dirname(canonicalStateRoot(CONFIG, home)));
  const geminiRoot = canonicalizePath(resolve(home, '.gemini'));
  if (isPathUnder(abs, stateParent) || isPathUnder(stateParent, abs) ||
      isPathUnder(abs, geminiRoot) || isPathUnder(geminiRoot, abs)) {
    throw new Error('protected_add_dir_refused');
  }
  return abs;
}

export function parseCliArgs(argv, { cwd = process.cwd(), home = homedir(), envAgyBin = process.env.AGY_BIN ?? '' } = {}) {
  const opts = {
    help: false,
    conversationId: null,
    cwd: resolve(cwd),
    headless: false,
    agyBin: envAgyBin.trim() || null,
    extraAcpArgs: [],
    initialPrompt: null,
  };

  const expanded = [];
  for (const raw of argv) {
    if (typeof raw !== 'string') continue;
    if (raw.startsWith('--') && raw.includes('=')) {
      const eqIdx = raw.indexOf('=');
      expanded.push(raw.slice(0, eqIdx), raw.slice(eqIdx + 1));
    } else {
      expanded.push(raw);
    }
  }

  const takeValue = (flag, idx) => {
    const val = expanded[idx + 1];
    if (val === undefined || val === '') throw new Error(`missing_value:${flag}`);
    return val;
  };

  const rawAddDirs = [];
  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i];
    if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else if (arg === '--conversation' || arg === '-c') {
      const val = takeValue(arg, i++);
      if (!UUID_RE.test(val)) throw new Error(`invalid_conversation_id:${val}`);
      opts.conversationId = val.toLowerCase();
    } else if (arg === '--cwd') {
      const val = takeValue(arg, i++);
      if (val.startsWith('-')) throw new Error(`invalid_value:${arg}`);
      opts.cwd = resolve(val);
    } else if (arg === '--headless') {
      opts.headless = true;
    } else if (arg === '--agy-bin') {
      opts.agyBin = takeValue(arg, i++);
    } else if (arg === '--prompt' || arg === '-p') {
      opts.initialPrompt = takeValue(arg, i++);
    } else if (arg === '--sandbox' || arg === '--dangerously-skip-permissions') {
      opts.extraAcpArgs.push(arg);
    } else if (arg === '--agent') {
      const val = takeValue(arg, i++);
      if (val.startsWith('-')) throw new Error(`invalid_value:${arg}`);
      opts.extraAcpArgs.push('--agent', val);
    } else if (arg === '--add-dir') {
      rawAddDirs.push(takeValue(arg, i++));
    } else {
      throw new Error(`unknown_option:${arg}`);
    }
  }

  for (const dir of rawAddDirs) {
    const safeDir = assertSafeAddDir(dir, { cwd: opts.cwd, home });
    opts.extraAcpArgs.push('--add-dir', safeDir);
  }
  return opts;
}

function extractTextFromUpdate(update) {
  if (!update || typeof update !== 'object') return '';
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
  const content = update.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

/**
 * Event-driven push host for Antigravity CLI via official `agy acp --stdio`.
 *
 * Uses fs.watch on canonical `wake/` triggers (zero polling) and writes the
 * per-host heartbeat for `child.pid` (which directly spawns `mcp-server.mjs`),
 * enabling native `adapter_managed_turn` idle wakeup in CLI sessions without
 * PTY keystroke races or background-task input blocking.
 */
export class AcpCliPushHost {
  constructor({
    config = CONFIG,
    store,
    cwd = process.cwd(),
    conversationId = null,
    headless = false,
    agyBin = null,
    extraAcpArgs = [],
    initialPrompt = null,
    spawnAcp = null,
    readStartToken = readProcessStartToken,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    debounceMs = DEBOUNCE_MS,
    minWakeIntervalMs = MIN_WAKE_INTERVAL_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
    handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
    maxTurnQueue = MAX_TURN_QUEUE,
    now = Date.now,
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    onUnexpectedExit = null,
  }) {
    this.config = config;
    this.store = store;
    this.cwd = cwd;
    this.requestedConversationId = conversationId;
    this.headless = headless;
    this.agyBin = agyBin;
    this.extraAcpArgs = extraAcpArgs;
    this.initialPrompt = initialPrompt;
    this.customSpawnAcp = typeof spawnAcp === 'function' ? spawnAcp : null;
    this.readStartToken = readStartToken;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.debounceMs = debounceMs;
    this.minWakeIntervalMs = minWakeIntervalMs;
    this.retryDelaysMs = retryDelaysMs;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxTurnQueue = maxTurnQueue;
    this.now = now;
    this.stdout = stdout;
    this.stderr = stderr;
    this.stdin = stdin;
    this.onUnexpectedExit = onUnexpectedExit;

    this.child = null;
    this.hostProvenance = null;
    this.lock = null;
    this.heartbeatWritten = false;
    this.sessionId = null;
    this.agentCapabilities = {};
    this.startedAt = now();
    this.closed = false;
    this.suppressUpdates = false;
    this.stderrTail = '';

    this.nextRpcId = 1;
    this.pendingRpc = new Map();
    this.turnActive = false;
    this.turnQueue = [];
    this.wakeInFlight = false;
    this.recheckAfterTurn = false;
    this.stdinClosed = false;
    this.wakeTimer = null;
    this.wakeTimerDueAt = Number.POSITIVE_INFINITY;
    this.heartbeatTimer = null;
    this.watcher = null;
    this.lastWakeMs = 0;
    this.retryAttempts = 0;
    this.rl = null;
    this.rlOut = null;
    this.streamedSinceNewline = false;
  }

  logInfo(msg) {
    try { this.stderr.write(`[masons-agy] ${msg}\n`); } catch {}
  }

  writeOut(text) {
    if (!text) return;
    try { this.stdout.write(text); } catch {}
    this.streamedSinceNewline = !text.endsWith('\n');
  }

  ensureNewline() {
    if (this.streamedSinceNewline) {
      try { this.stdout.write('\n'); } catch {}
      this.streamedSinceNewline = false;
    }
  }

  sendRpc(method, params, { timeoutMs = 0 } = {}) {
    if (this.closed || !this.child?.stdin?.writable) {
      return Promise.reject(new Error('acp_closed'));
    }
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = {
        method,
        resolve: (val) => {
          if (timer) clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pendingRpc.delete(id)) {
            reject(new Error(`acp_rpc_timeout:${method}`));
          }
        }, timeoutMs);
        timer.unref?.();
      }
      this.pendingRpc.set(id, entry);
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      try {
        this.child.stdin.write(line, (err) => {
          if (err && this.pendingRpc.delete(id)) {
            entry.reject(err);
          }
        });
      } catch (err) {
        if (this.pendingRpc.delete(id)) {
          entry.reject(err);
        }
      }
    });
  }

  sendRpcRaw(payload) {
    if (this.closed || !this.child?.stdin?.writable) return;
    try {
      this.child.stdin.write(JSON.stringify(payload) + '\n');
    } catch {}
  }

  handleAcpMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pendingRpc.get(msg.id);
      if (!pending) return;
      this.pendingRpc.delete(msg.id);
      if (msg.error) {
        pending.reject(Object.assign(new Error(msg.error.message || 'acp_rpc_error'), { code: msg.error.code }));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method === 'session/update') {
      if (this.suppressUpdates) return;
      const updateSessionId = typeof msg.params?.sessionId === 'string' ? msg.params.sessionId.toLowerCase() : null;
      if (updateSessionId && this.sessionId && updateSessionId !== this.sessionId) return;
      const text = extractTextFromUpdate(msg.params?.update);
      if (text) this.writeOut(text);
      return;
    }

    // Fail-closed permission handler: strictly select explicit ACP reject kinds, otherwise cancel.
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const options = Array.isArray(msg.params?.options) ? msg.params.options : [];
      const rejectOpt = options.find((o) => o?.kind === 'reject_once' || o?.kind === 'reject_always');
      const title = msg.params?.toolCall?.title || msg.params?.toolCall?.name || 'tool action';
      this.logInfo(`auto-denied permission request (${title}); pass --sandbox or --dangerously-skip-permissions if desired`);
      this.sendRpcRaw({
        jsonrpc: '2.0',
        id: msg.id,
        result: rejectOpt?.optionId
          ? { outcome: { outcome: 'selected', optionId: rejectOpt.optionId } }
          : { outcome: { outcome: 'cancelled' } },
      });
      return;
    }

    // JSON-RPC 2.0 compliance: never leave unknown server-to-client requests hanging.
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.sendRpcRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      });
    }
  }

  writeHeartbeat() {
    if (!this.hostProvenance || !this.lock || !this.watcher) return;
    try {
      this.store.writeSidecarHeartbeat({
        pid: process.pid,
        hostPid: this.hostProvenance.hostPid,
        hostStartToken: this.hostProvenance.hostStartToken,
        startedAt: this.startedAt,
        updatedAt: this.now(),
      });
      this.heartbeatWritten = true;
    } catch {}
  }

  startWakeWatcher() {
    this.store.ensureSubdir('wake');
    const wakeDir = this.store.resolveSafe('wake');
    try {
      this.watcher = watch(wakeDir, (_eventType, filename) => {
        if (this.closed || !this.sessionId) return;
        if (typeof filename === 'string' && filename.endsWith('.json')) {
          const convId = filename.slice(0, -5).toLowerCase();
          if (convId === this.sessionId) this.scheduleWakeCheck(this.debounceMs);
        } else {
          this.scheduleWakeCheck(this.debounceMs);
        }
      });
      this.watcher.on('error', (err) => {
        this.logInfo(`wake watcher error: ${err?.message ?? err}`);
      });
      this.watcher.unref?.();
      return true;
    } catch (err) {
      this.watcher = null;
      this.logInfo(`wake watcher unavailable: ${err?.message ?? err}`);
      return false;
    }
  }

  scheduleWakeCheck(delayMs = this.debounceMs) {
    if (this.closed || !this.sessionId) return;
    const clamped = Math.max(0, delayMs);
    const dueAt = this.now() + clamped;
    if (this.wakeTimer) {
      if (dueAt >= this.wakeTimerDueAt) return;
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.wakeTimerDueAt = Number.POSITIVE_INFINITY;
    }
    this.wakeTimerDueAt = dueAt;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeTimerDueAt = Number.POSITIVE_INFINITY;
      void this.tryWakeSession();
    }, clamped);
    this.wakeTimer.unref?.();
  }

  setActiveWakeFlag(active) {
    if (!this.sessionId) return;
    try {
      this.store.updateChat(this.sessionId, (c) => {
        c.taint = {
          ...(c.taint ?? { tainted: false, lastRemoteTouchStepIndex: -1, lastRemoteTouchAt: null, lastClearedUserStepIndex: -1 }),
          activeWake: active,
        };
        return c;
      });
    } catch {}
  }

  async tryWakeSession() {
    if (this.closed || !this.sessionId || !this.hostProvenance) return;
    if (this.turnActive || this.wakeInFlight) {
      this.recheckAfterTurn = true;
      return;
    }

    this.wakeInFlight = true;
    let nextDelayMs = null;
    try {
      const trigger = this.store.readJson(this.store.wakePath(this.sessionId), null);
      if (!trigger) return;
      if (!sameHostProvenance(trigger, this.hostProvenance)) return;
      const wakeToken = typeof trigger.wakeToken === 'string' && trigger.wakeToken ? trigger.wakeToken : null;

      const chat = this.store.readChat(this.sessionId);
      if (chat.registration?.state === 'fenced') {
        if (wakeToken) this.store.clearWakeTrigger(this.sessionId, wakeToken);
        return;
      }
      const inbox = Array.isArray(chat.inbox) ? chat.inbox : [];
      const hasPending = inbox.some((r) => r.phase === 'pending');
      const hasInFlight = inbox.some((r) => r.phase === 'in_flight');
      if (!hasPending) {
        if (wakeToken) this.store.clearWakeTrigger(this.sessionId, wakeToken);
        this.retryAttempts = 0;
        return;
      }
      if (hasInFlight) {
        nextDelayMs = 1_000;
        return;
      }

      const elapsed = this.now() - this.lastWakeMs;
      if (elapsed < this.minWakeIntervalMs) {
        nextDelayMs = this.minWakeIntervalMs - elapsed;
        return;
      }

      this.lastWakeMs = this.now();
      this.setActiveWakeFlag(true);
      try {
        markRemoteTaint(this.store, this.sessionId, { reason: 'acp_wake_prompt' });
      } catch {}

      try {
        await this.submitPrompt(SIDECAR_WAKE_PROMPT, { isWake: true });
        if (wakeToken) this.store.clearWakeTrigger(this.sessionId, wakeToken);
        this.retryAttempts = 0;
        // Re-check disk in case a fresh wake trigger arrived while the prompt was running.
        const remaining = this.store.readJson(this.store.wakePath(this.sessionId), null);
        if (remaining && sameHostProvenance(remaining, this.hostProvenance)) {
          nextDelayMs = this.debounceMs;
        }
      } catch (error) {
        if (this.closed) return;
        const retryDelay = this.retryDelaysMs[this.retryAttempts];
        if (retryDelay !== undefined) {
          this.retryAttempts++;
          this.logInfo(`wake failed (${error?.message ?? error}); retrying in ${retryDelay}ms`);
          nextDelayMs = retryDelay;
        } else {
          this.logInfo(`wake exhausted retries (${error?.message ?? error})`);
          this.retryAttempts = 0;
          if (wakeToken) this.store.clearWakeTrigger(this.sessionId, wakeToken);
        }
      } finally {
        try {
          markRemoteTaint(this.store, this.sessionId, { reason: 'acp_wake_prompt_done' });
        } catch {}
        this.setActiveWakeFlag(false);
      }
    } catch (error) {
      if (!this.closed) {
        this.logInfo(`wake check error: ${error?.message ?? error}`);
      }
    } finally {
      this.wakeInFlight = false;
      if (!this.closed && nextDelayMs !== null) {
        this.scheduleWakeCheck(nextDelayMs);
      }
    }
  }

  submitPrompt(text, { isWake = false } = {}) {
    if (this.closed || !this.sessionId) return Promise.reject(new Error('session_not_ready'));
    if (this.turnQueue.length >= this.maxTurnQueue) {
      return Promise.reject(new Error('turn_queue_full'));
    }
    return new Promise((resolve, reject) => {
      this.turnQueue.push({ text, isWake, resolve, reject });
      void this.drainTurnQueue();
    });
  }

  async drainTurnQueue() {
    if (this.turnActive || this.closed) return;
    const next = this.turnQueue.shift();
    if (!next) {
      if (this.stdinClosed && !this.closed) this.stop();
      return;
    }
    this.turnActive = true;
    const isTty = Boolean(this.stdout?.isTTY);
    if (this.rl) {
      try { this.rl.pause(); } catch {}
    }
    try {
      if (this.rl && isTty) {
        this.stdout.write('\r\x1b[2K');
      }
      if (next.isWake) {
        this.logInfo('waking idle session for inbound MASONS message...');
      }
      const res = await this.sendRpc('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: next.text }],
      });
      this.ensureNewline();
      next.resolve(res);
    } catch (error) {
      this.ensureNewline();
      next.reject(error);
    } finally {
      this.turnActive = false;
      if (this.turnQueue.length > 0 && !this.closed) {
        void this.drainTurnQueue();
      } else if (this.stdinClosed && !this.closed) {
        this.stop();
      } else {
        if (this.rl && !this.closed) {
          try { this.rl.resume(); } catch {}
          if (isTty) {
            try { this.rl.prompt(true); } catch {}
          }
        }
        if (this.recheckAfterTurn && !this.closed) {
          this.recheckAfterTurn = false;
          this.scheduleWakeCheck(this.debounceMs);
        }
      }
    }
  }

  async start() {
    if (this.requestedConversationId !== null && !UUID_RE.test(String(this.requestedConversationId))) {
      throw new Error(`invalid_conversation_id:${this.requestedConversationId}`);
    }

    const bin = this.customSpawnAcp
      ? (this.agyBin || 'agy')
      : resolveAgyBin(this.agyBin);
    const args = ['acp', '--stdio', ...this.extraAcpArgs];

    this.child = this.customSpawnAcp
      ? this.customSpawnAcp(bin, args)
      : spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    if (!this.child) {
      throw new Error('acp_spawn_failed');
    }

    this.child.on('error', (err) => {
      if (!this.closed) {
        this.logInfo(`agy acp error: ${err?.message ?? err}`);
        this.stop();
        this.onUnexpectedExit?.(1);
      }
    });
    this.child.stdin?.on('error', () => {});
    // Drain stderr continuously so verbose Go glog output never fills the 64 KB OS pipe buffer.
    this.child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL);
    });
    this.child.on('exit', (code, signal) => {
      if (!this.closed) {
        this.logInfo(`agy acp exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
        this.stop();
        if (code && code !== 0) {
          this.onUnexpectedExit?.(code);
        }
      }
    });

    try {
      if (!Number.isSafeInteger(this.child.pid) || this.child.pid < 1) {
        throw new Error('acp_spawn_failed');
      }

      const rawToken = this.readStartToken(this.child.pid);
      const hostStartToken = typeof rawToken === 'string' && rawToken.trim() ? rawToken.trim() : null;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error('acp_exited_early');
      }

      this.hostProvenance = Object.freeze({
        hostPid: this.child.pid,
        hostStartToken,
      });

      this.lock = this.store.acquireSidecarLock(this.hostProvenance.hostPid);
      if (!this.lock) {
        throw new Error('sidecar_lock_busy');
      }

      this.rlOut = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
      this.rlOut.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          this.handleAcpMessage(JSON.parse(trimmed));
        } catch {}
      });
      this.rlOut.on('close', () => {
        if (!this.closed) this.stop();
      });

      const initRes = await this.sendRpc(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: `${this.config.identity}-cli`, version: this.config.version },
        },
        { timeoutMs: this.handshakeTimeoutMs },
      );
      this.agentCapabilities = initRes?.agentCapabilities ?? {};

      let sessionRes;
      if (this.requestedConversationId) {
        const reqId = this.requestedConversationId.toLowerCase();
        const caps = this.agentCapabilities?.sessionCapabilities ?? {};
        if (caps.resume !== undefined) {
          try {
            sessionRes = await this.sendRpc(
              'session/resume',
              { sessionId: reqId, cwd: this.cwd, mcpServers: [] },
              { timeoutMs: this.handshakeTimeoutMs },
            );
          } catch {
            this.suppressUpdates = true;
            try {
              sessionRes = await this.sendRpc(
                'session/load',
                { sessionId: reqId, cwd: this.cwd, mcpServers: [] },
                { timeoutMs: this.handshakeTimeoutMs },
              );
            } finally {
              this.suppressUpdates = false;
            }
          }
        } else {
          this.suppressUpdates = true;
          try {
            sessionRes = await this.sendRpc(
              'session/load',
              { sessionId: reqId, cwd: this.cwd, mcpServers: [] },
              { timeoutMs: this.handshakeTimeoutMs },
            );
          } finally {
            this.suppressUpdates = false;
          }
        }
        this.sessionId = String(sessionRes?.sessionId ?? reqId).toLowerCase();
      } else {
        sessionRes = await this.sendRpc(
          'session/new',
          { cwd: this.cwd, mcpServers: [] },
          { timeoutMs: this.handshakeTimeoutMs },
        );
        this.sessionId = String(sessionRes?.sessionId ?? '').toLowerCase();
      }

      if (!UUID_RE.test(this.sessionId)) {
        throw new Error('acp_session_id_invalid');
      }

      const watcherActive = this.startWakeWatcher();
      if (watcherActive) {
        this.writeHeartbeat();
        this.heartbeatTimer = setInterval(() => this.writeHeartbeat(), this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
        this.scheduleWakeCheck(0);
        this.logInfo(`session=${this.sessionId} hostPid=${this.hostProvenance.hostPid} idle_wakeup=active (acp)`);
      } else {
        this.logInfo(`session=${this.sessionId} hostPid=${this.hostProvenance.hostPid} idle_wakeup=inactive (watcher unavailable)`);
      }

      if (this.initialPrompt) {
        await this.submitPrompt(this.initialPrompt, { isWake: false });
      }
      if (!this.headless && !this.closed) {
        this.startInteractivePrompt();
      }

      return { sessionId: this.sessionId, hostProvenance: this.hostProvenance };
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  startInteractivePrompt() {
    const isTty = Boolean(this.stdout?.isTTY);
    this.rl = createInterface({
      input: this.stdin,
      output: isTty ? this.stdout : undefined,
      prompt: '> ',
      terminal: isTty,
    });
    if (isTty) this.rl.prompt();
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        if (isTty && !this.turnActive) this.rl.prompt();
        return;
      }
      if (trimmed === '/exit' || trimmed === '/quit') {
        void this.shutdown();
        return;
      }
      void this.submitPrompt(trimmed, { isWake: false }).catch((err) => {
        if (!this.closed) this.logInfo(`prompt error: ${err?.message ?? err}`);
      });
    });
    this.rl.on('close', () => {
      this.stdinClosed = true;
      if (!this.turnActive && this.turnQueue.length === 0 && !this.closed) {
        this.stop();
      }
    });
  }

  async shutdown() {
    if (this.closed) return;
    if (this.sessionId && this.agentCapabilities?.sessionCapabilities?.close !== undefined && this.child?.stdin?.writable) {
      try {
        await this.sendRpc('session/close', { sessionId: this.sessionId }, { timeoutMs: CLOSE_TIMEOUT_MS });
      } catch {}
    }
    const childRef = this.child;
    this.stop();
    if (childRef && childRef.exitCode === null && childRef.signalCode === null) {
      await new Promise((done) => {
        const timer = setTimeout(() => {
          try { childRef.kill('SIGKILL'); } catch {}
          done();
        }, 1_500);
        timer.unref?.();
        childRef.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
      this.wakeTimerDueAt = Number.POSITIVE_INFINITY;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    if (this.rl) {
      try { this.rl.close(); } catch {}
      this.rl = null;
    }
    if (this.rlOut) {
      try { this.rlOut.close(); } catch {}
      this.rlOut = null;
    }
    for (const entry of this.pendingRpc.values()) {
      entry.reject(new Error('acp_closed'));
    }
    this.pendingRpc.clear();
    for (const item of this.turnQueue.splice(0)) {
      item.reject(new Error('acp_closed'));
    }
    this.setActiveWakeFlag(false);
    if (this.hostProvenance && this.heartbeatWritten) {
      this.store.clearSidecarHeartbeat({ pid: process.pid, hostPid: this.hostProvenance.hostPid });
      this.heartbeatWritten = false;
    }
    try { this.lock?.release(); } catch {}
    this.lock = null;
    if (this.child) {
      try { this.child.stdin?.end(); } catch {}
      if (!this.child.killed && this.child.exitCode === null && this.child.signalCode === null) {
        try { this.child.kill('SIGTERM'); } catch {}
      }
    }
  }
}

export async function runDefaultCliAcpHost(argv = process.argv.slice(2)) {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE_TEXT);
    return null;
  }
  const store = new StateStore(canonicalStateRoot(CONFIG));
  const host = new AcpCliPushHost({
    config: CONFIG,
    store,
    cwd: opts.cwd,
    conversationId: opts.conversationId,
    headless: opts.headless,
    agyBin: opts.agyBin,
    extraAcpArgs: opts.extraAcpArgs,
    initialPrompt: opts.initialPrompt,
    onUnexpectedExit: (code) => {
      process.exitCode = code || 1;
    },
  });
  let shuttingDown = false;
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void host.shutdown().finally(() => process.exit(process.exitCode ?? 0));
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, onSignal);
  }
  process.on('exit', () => host.stop());

  try {
    await host.start();
  } catch (err) {
    host.stop();
    throw err;
  }
  return host;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDefaultCliAcpHost().catch((err) => {
    process.stderr.write(`[masons-agy] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
