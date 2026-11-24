import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function maskPayload(payload) {
  const mask = randomBytes(4);
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3];
  return { mask, masked: out };
}

function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;
  const { mask, masked } = maskPayload(payload);
  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len < 65536) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  mask.copy(frame, offset);
  masked.copy(frame, offset + 4);
  return frame;
}

/**
 * Minimal zero-dependency RFC 6455 WebSocket client over node:http / node:https.
 * Supports Authorization headers, HTTP upgrade refusal inspection (401/403),
 * RFC 6455 Ping/Pong control frames, close codes (1008), and fragmented UTF-8 text frames.
 */
export function connectWebSocket(targetUrl, {
  headers = {},
  openTimeoutMs = 15000,
  silenceTimeoutMs = 0,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  createConnection,
  signal,
  onOpen = () => {},
  onMessage = () => {},
  onClose = () => {},
  onError = () => {},
} = {}) {
  const url = new URL(targetUrl);
  const isSecure = url.protocol === 'wss:';
  if (!isSecure && (url.protocol !== 'ws:' || !LOOPBACK_HOSTS.has(url.hostname))) {
    throw Object.assign(new Error('ws_protocol_invalid'), { code: 'ws_protocol_invalid' });
  }
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
  const mod = isSecure ? https : http;
  const utf8 = new TextDecoder('utf-8', { fatal: true });

  let socket = null;
  let closed = false;
  let opened = false;
  let openTimer = null;
  let silenceTimer = null;
  let buffer = Buffer.alloc(0);
  let fragOpcode = null;
  let fragChunks = [];
  let fragBytes = 0;

  const clearTimers = () => {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  };

  const resetSilence = () => {
    if (!silenceTimeoutMs || closed) return;
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      fail(Object.assign(new Error('stream_silence_timeout'), { code: 'stream_silence_timeout' }));
    }, silenceTimeoutMs);
    silenceTimer.unref?.();
  };

  const finishClose = (code = 1006, reason = '', graceful = false) => {
    if (closed) return;
    closed = true;
    clearTimers();
    signal?.removeEventListener('abort', onAbort);
    try { req.destroy(); } catch {}
    if (socket && !socket.destroyed) {
      if (graceful) {
        try { socket.end(); } catch {}
        const s = socket;
        const t = setTimeout(() => { try { s.destroy(); } catch {} }, 50);
        t.unref?.();
      } else {
        try { socket.destroy(); } catch {}
      }
    }
    onClose({ code, reason });
  };

  const fail = (err) => {
    if (closed) return;
    closed = true;
    clearTimers();
    signal?.removeEventListener('abort', onAbort);
    try { req.destroy(); } catch {}
    try { socket?.destroy(); } catch {}
    onError(err);
  };

  const sendRaw = (opcode, payload) => {
    if (closed || !socket || socket.destroyed) return;
    try { socket.write(encodeClientFrame(opcode, payload)); } catch {}
  };

  const close = (code = 1000, reason = '') => {
    if (closed) return;
    if (opened && socket && !socket.destroyed) {
      const reasonBytes = Buffer.from(reason, 'utf8').subarray(0, 123);
      const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
      payload.writeUInt16BE(code, 0);
      reasonBytes.copy(payload, 2);
      sendRaw(0x8, payload);
      finishClose(code, reason, true);
      return;
    }
    finishClose(code, reason, false);
  };

  const onAbort = () => close(1000, 'aborted');
  if (signal?.aborted) {
    queueMicrotask(() => finishClose(1000, 'aborted'));
    return { close };
  }
  signal?.addEventListener('abort', onAbort, { once: true });

  const req = mod.request({
    protocol: isSecure ? 'https:' : 'http:',
    hostname: url.hostname,
    port: url.port || (isSecure ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    ...(createConnection && { createConnection }),
    headers: {
      ...headers,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
    },
  });

  openTimer = setTimeout(() => {
    fail(Object.assign(new Error('stream_open_timeout'), { code: 'stream_open_timeout' }));
  }, openTimeoutMs);
  openTimer.unref?.();

  req.on('response', (res) => {
    res.resume();
    const status = res.statusCode ?? 0;
    const code = status === 401 || status === 403 ? 'credential_ended' : 'stream_upgrade_refused';
    fail(Object.assign(new Error(code), { code, status }));
  });

  req.on('error', () => {
    fail(Object.assign(new Error('stream_error'), { code: 'stream_error' }));
  });

  const decodeText = (buf) => {
    try {
      return utf8.decode(buf);
    } catch {
      fail(Object.assign(new Error('stream_unreadable'), { code: 'stream_unreadable' }));
      return null;
    }
  };

  const processBuffer = () => {
    while (!closed && buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (rsv !== 0 || masked) {
        fail(Object.assign(new Error('stream_protocol_error'), { code: 'stream_protocol_error' }));
        return;
      }
      let payloadLen = b1 & 0x7f;
      let offset = 2;
      if (payloadLen === 126) {
        if (buffer.length < 4) return;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) return;
        const bigLen = buffer.readBigUInt64BE(2);
        if (bigLen > BigInt(maxFrameBytes)) {
          fail(Object.assign(new Error('stream_backlog_exceeded'), { code: 'stream_backlog_exceeded' }));
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }
      const isControl = (opcode & 0x08) !== 0;
      if (isControl && (!fin || payloadLen > 125)) {
        fail(Object.assign(new Error('stream_protocol_error'), { code: 'stream_protocol_error' }));
        return;
      }
      if (payloadLen > maxFrameBytes) {
        fail(Object.assign(new Error('stream_backlog_exceeded'), { code: 'stream_backlog_exceeded' }));
        return;
      }
      if (buffer.length < offset + payloadLen) return;
      const payload = buffer.subarray(offset, offset + payloadLen);
      buffer = buffer.length === offset + payloadLen ? Buffer.alloc(0) : buffer.subarray(offset + payloadLen);
      resetSilence();

      if (opcode === 0x9) {
        sendRaw(0xA, payload);
        continue;
      }
      if (opcode === 0xA) {
        continue;
      }
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        sendRaw(0x8, payload.subarray(0, 2));
        finishClose(code, reason, true);
        return;
      }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fragOpcode !== null) {
          fail(Object.assign(new Error('stream_protocol_error'), { code: 'stream_protocol_error' }));
          return;
        }
        if (fin) {
          if (opcode === 0x1) {
            const text = decodeText(payload);
            if (text !== null) onMessage(text);
          }
        } else {
          fragOpcode = opcode;
          fragChunks = [Buffer.from(payload)];
          fragBytes = payload.length;
        }
        continue;
      }
      if (opcode === 0x0) {
        if (fragOpcode === null) {
          fail(Object.assign(new Error('stream_protocol_error'), { code: 'stream_protocol_error' }));
          return;
        }
        fragBytes += payload.length;
        if (fragBytes > maxFrameBytes) {
          fail(Object.assign(new Error('stream_backlog_exceeded'), { code: 'stream_backlog_exceeded' }));
          return;
        }
        fragChunks.push(Buffer.from(payload));
        if (fin) {
          const full = Buffer.concat(fragChunks, fragBytes);
          const op = fragOpcode;
          fragOpcode = null;
          fragChunks = [];
          fragBytes = 0;
          if (op === 0x1) {
            const text = decodeText(full);
            if (text !== null) onMessage(text);
          }
        }
        continue;
      }
      fail(Object.assign(new Error('stream_protocol_error'), { code: 'stream_protocol_error' }));
      return;
    }
  };

  req.on('upgrade', (res, sock, head) => {
    if (closed) {
      sock.destroy();
      return;
    }
    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      sock.destroy();
      fail(Object.assign(new Error('stream_handshake_invalid'), { code: 'stream_handshake_invalid' }));
      return;
    }
    socket = sock;
    opened = true;
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    resetSilence();
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => {
      if (closed) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      processBuffer();
    });
    socket.on('error', () => {
      fail(Object.assign(new Error('stream_error'), { code: 'stream_error' }));
    });
    socket.on('close', () => {
      finishClose(1006, '');
    });
    onOpen();
    if (head?.length) {
      buffer = head;
      processBuffer();
    }
  });

  req.end();

  return { close };
}
