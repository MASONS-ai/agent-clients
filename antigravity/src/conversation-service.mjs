import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PROBE_CONVERSATION_ID = '00000000-0000-4000-8000-000000000000';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOWED_CONNECT_METHODS = new Set(['GetConversation', 'UpdateConversation']);
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_BYTES = 65_536;
const MAX_BRIDGE_RESPONSE_BYTES = 8_192;
const MAX_SESSION_TITLE_LENGTH = 80;

// Strip C0/C1 controls, line/paragraph separators, format/BiDi/invisible chars, Hangul fillers,
// and astral Unicode Tag characters while preserving ZWNJ (\u200C) and ZWJ (\u200D) per Services grammar.
const UNSAFE_TITLE_CHARS_RE = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u034F\u115F\u1160\u180E\u3164\uFFA0\u{E0000}-\u{E007F}]/gu;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001F\u007F]/u;

function fault(code, detail = null) {
  return Object.assign(new Error(code), {
    code,
    ...(detail ? { detail } : {}),
  });
}

/**
 * Strictly validate an ANTIGRAVITY_LS_ADDRESS (`host:port`) as loopback-only HTTP.
 * Returns normalized `{ baseUrl, hostname, port }` or `null`.
 */
export function parseLoopbackAddress(rawAddr) {
  if (typeof rawAddr !== 'string') return null;
  const trimmed = rawAddr.trim();
  if (!trimmed || trimmed.includes('://') || /[\s/@?#\\]/u.test(trimmed)) return null;
  let url;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://${url.host}`;
}

/**
 * Sanitize and normalize a conversation/session title for both Services -> Host and Host -> Services.
 * Preserves ZWNJ/ZWJ (compound emoji & scripts), strips controls/BiDi/format/Tag chars, collapses whitespace,
 * and enforces Services' 80-code-unit length bound.
 */
export function sanitizeSessionTitle(raw, { maxLength = MAX_SESSION_TITLE_LENGTH } = {}) {
  if (typeof raw !== 'string' || !raw.isWellFormed()) return null;
  const cleaned = raw
    .replace(UNSAFE_TITLE_CHARS_RE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned || cleaned.length > maxLength) return null;
  return cleaned;
}

function projectConversation(raw, fallbackId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw fault('conversation_service_unreadable');
  }
  const conv = raw.conversation && typeof raw.conversation === 'object' ? raw.conversation : raw;
  const id = typeof conv.id === 'string' && UUID_RE.test(conv.id) ? conv.id.toLowerCase() : fallbackId;
  const annotations = conv.annotations && typeof conv.annotations === 'object' ? conv.annotations : {};
  const state = conv.state && typeof conv.state === 'object' ? conv.state : {};
  const rawTitle = typeof annotations.title === 'string' ? annotations.title : null;
  return {
    id,
    title: rawTitle !== null ? sanitizeSessionTitle(rawTitle) : null,
    archived: annotations.archived === true,
    runState: typeof state.runState === 'string' && state.runState.trim() ? state.runState.trim() : null,
  };
}

function combineSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Direct loopback HTTP POST via node:http — immune to NODE_USE_ENV_PROXY / HTTP_PROXY
 * and never follows redirects.
 */
function directLoopbackPost(urlStr, { headers, body, signal, maxBytes }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
    const req = httpRequest(
      {
        protocol: 'http:',
        hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // Reject redirects explicitly (matches redirect: 'error').
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(fault('transient'));
          return;
        }
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        const chunks = [];
        let total = 0;
        let failed = false;
        res.on('data', (chunk) => {
          if (failed) return;
          total += chunk.length;
          if (total > maxBytes) {
            failed = true;
            res.destroy();
            reject(fault('conversation_service_oversized'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (failed) return;
          resolve({ status, contentType, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', () => {
          if (failed) return;
          failed = true;
          reject(fault(signal?.aborted ? 'operation_aborted' : 'transient'));
        });
      },
    );
    req.on('error', (error) => {
      if (signal?.aborted) {
        reject(fault('operation_aborted'));
        return;
      }
      const code = error?.code ?? error?.cause?.code ?? null;
      if (code === 'ECONNREFUSED') {
        reject(fault('connection_refused'));
        return;
      }
      reject(fault('transient'));
    });
    req.end(body);
  });
}

async function readBoundedText(response, maxBytes, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw fault('conversation_service_oversized');
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw fault('conversation_service_oversized');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error?.code === 'conversation_service_oversized') throw error;
    throw fault(signal?.aborted ? 'operation_aborted' : 'transient');
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Create an in-memory Connect HTTP+JSON client for Antigravity `product.v1.ConversationService`.
 * Strictly closed method allowlist: `GetConversation` and `UpdateConversation` (title-only).
 * Uses direct loopback node:http by default (immune to env proxies); never logs or persists `csrfToken`.
 */
export function createConversationServiceClient({
  address = process.env.ANTIGRAVITY_LS_ADDRESS,
  csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN,
  fetchImpl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const baseUrl = parseLoopbackAddress(address);
  const token = typeof csrfToken === 'string' && csrfToken.trim() && csrfToken.isWellFormed() && !CTRL_RE.test(csrfToken)
    ? csrfToken.trim()
    : null;
  if (!baseUrl || !token) return null;

  async function callConnect(method, body, { signal, timeoutMs: reqTimeoutMs = timeoutMs } = {}) {
    if (!ALLOWED_CONNECT_METHODS.has(method)) {
      throw fault('conversation_service_method_forbidden');
    }
    const urlStr = `${baseUrl}/product.v1.ConversationService/${method}`;
    const headers = {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
      'x-antigravity-csrf-token': token,
    };
    const serialized = JSON.stringify(body);
    const combinedSignal = combineSignal(signal, reqTimeoutMs);

    let status;
    let contentType;
    let text;

    if (typeof fetchImpl === 'function') {
      let response;
      try {
        response = await fetchImpl(urlStr, {
          method: 'POST',
          headers,
          body: serialized,
          redirect: 'error',
          signal: combinedSignal,
        });
      } catch (error) {
        if (signal?.aborted) throw fault('operation_aborted');
        const causeCode = error?.cause?.code ?? error?.code ?? null;
        if (causeCode === 'ECONNREFUSED') throw fault('connection_refused');
        throw fault('transient');
      }
      status = response.status;
      contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase();
      text = await readBoundedText(response, maxBytes, signal);
    } else {
      const res = await directLoopbackPost(urlStr, {
        headers,
        body: serialized,
        signal: combinedSignal,
        maxBytes,
      });
      status = res.status;
      contentType = res.contentType;
      text = res.text;
    }

    let parsed = null;
    if (text && contentType.includes('application/json')) {
      try { parsed = JSON.parse(text); } catch {}
    }

    if (status === 200) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw fault('conversation_service_unreadable');
      }
      return parsed;
    }

    if (status === 404 && contentType.includes('application/json') && parsed?.code === 'not_found') {
      throw fault('not_found');
    }
    if (status === 401 || status === 403 || parsed?.code === 'unauthenticated' || parsed?.code === 'permission_denied') {
      throw fault('auth_failed');
    }
    if (status === 404 || status === 501 || parsed?.code === 'unimplemented') {
      throw fault('unavailable');
    }
    throw fault('transient');
  }

  return {
    async probe({ signal, timeoutMs: probeTimeoutMs = 500 } = {}) {
      try {
        await callConnect('GetConversation', { conversationId: PROBE_CONVERSATION_ID }, { signal, timeoutMs: probeTimeoutMs });
        return true;
      } catch (error) {
        return error?.code === 'not_found';
      }
    },

    async getConversation(conversationId, { signal, timeoutMs: reqTimeoutMs = timeoutMs } = {}) {
      if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
        throw fault('conversation_id_invalid');
      }
      const id = conversationId.toLowerCase();
      const raw = await callConnect('GetConversation', { conversationId: id }, { signal, timeoutMs: reqTimeoutMs });
      return projectConversation(raw, id);
    },

    async setConversationTitle(conversationId, title, { signal, timeoutMs: reqTimeoutMs = timeoutMs } = {}) {
      if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
        throw fault('conversation_id_invalid');
      }
      const cleanTitle = sanitizeSessionTitle(title);
      if (!cleanTitle) throw fault('title_invalid');
      const id = conversationId.toLowerCase();
      const raw = await callConnect(
        'UpdateConversation',
        { conversationId: id, annotations: { title: cleanTitle } },
        { signal, timeoutMs: reqTimeoutMs },
      );
      const projected = projectConversation(raw, id);
      if (projected.title !== null) return projected;
      return this.getConversation(id, { signal, timeoutMs: reqTimeoutMs });
    },
  };
}

/**
 * Minimal one-way newline-delimited JSON UDS client for talking to this host's Sidecar bridge.
 */
export function callSidecarBridge({
  socketPath,
  ipcToken,
  hostPid,
  hostStartToken = null,
  method,
  params = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
} = {}) {
  return new Promise((resolve, reject) => {
    if (typeof socketPath !== 'string' || !socketPath || typeof ipcToken !== 'string' || !ipcToken) {
      reject(fault('sidecar_bridge_unconfigured'));
      return;
    }
    if (signal?.aborted) {
      reject(fault('operation_aborted'));
      return;
    }

    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = connect({ path: socketPath });

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { socket.destroy(); } catch {}
      if (err) reject(err);
      else resolve(value);
    };

    const onAbort = () => finish(fault('operation_aborted'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => finish(fault('sidecar_bridge_timeout')), timeoutMs);
    timer.unref?.();

    socket.on('connect', () => {
      const payload = JSON.stringify({
        token: ipcToken,
        hostPid,
        hostStartToken: hostStartToken ?? null,
        method,
        params,
      });
      socket.write(`${payload}\n`);
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BRIDGE_RESPONSE_BYTES) {
        finish(fault('sidecar_bridge_oversized'));
        return;
      }
      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString('utf8');
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        finish(fault('sidecar_bridge_unreadable'));
        return;
      }
      if (!msg || typeof msg !== 'object') {
        finish(fault('sidecar_bridge_unreadable'));
        return;
      }
      if (msg.ok === true) {
        finish(null, msg.result);
      } else {
        finish(fault(typeof msg.error === 'string' && msg.error ? msg.error : 'sidecar_bridge_failed'));
      }
    });

    socket.on('error', (err) => {
      finish(fault(err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED' ? 'sidecar_bridge_unavailable' : 'sidecar_bridge_error'));
    });

    socket.on('end', () => {
      if (!settled) finish(fault('sidecar_bridge_closed'));
    });
  });
}
