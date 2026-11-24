import http from 'node:http';
import https from 'node:https';
import { ANTIGRAVITY_DECLARATION, assertEffectiveDeclaration } from './declaration.mjs';
import { connectWebSocket } from './ws-client.mjs';

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_INBOUND_CONTENT_BYTES = 65536;
export const MAX_SEND_BYTES = 40960;
const SEND_MEDIA = 'application/vnd.masons.icm-messaging-v2+json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_CONNECT_TIMEOUT_MS = 6000;

function createSharedAgent(AgentCtor) {
  return new AgentCtor({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 6,
    maxFreeSockets: 4,
    scheduling: 'lifo',
    timeout: 50000,
  });
}

let sharedHttpsAgent = null;
let sharedHttpAgent = null;

function getSharedAgent(isHttps) {
  if (isHttps) {
    sharedHttpsAgent ??= createSharedAgent(https.Agent);
    return sharedHttpsAgent;
  }
  sharedHttpAgent ??= createSharedAgent(http.Agent);
  return sharedHttpAgent;
}

export function closeSharedAgents() {
  sharedHttpsAgent?.destroy();
  sharedHttpsAgent = null;
  sharedHttpAgent?.destroy();
  sharedHttpAgent = null;
}

export function createNodeHttpFetch({
  httpsAgent,
  httpAgent,
  createConnection,
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
} = {}) {
  return (url, { method = 'GET', headers, body, signal, connectTimeout = connectTimeoutMs } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const target = url instanceof URL ? url : new URL(String(url));
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const reqHeaders = {};
    if (headers instanceof Headers) {
      for (const [k, v] of headers.entries()) reqHeaders[k.toLowerCase()] = v;
    } else if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        if (v !== undefined) reqHeaders[k.toLowerCase()] = String(v);
      }
    }
    if (!reqHeaders['accept-encoding']) reqHeaders['accept-encoding'] = 'identity';
    const payload = body !== undefined ? Buffer.from(body, 'utf8') : null;
    if (payload !== null) {
      reqHeaders['content-length'] = String(payload.byteLength);
    }

    let settled = false;
    let connected = false;
    let connectTimer = null;
    const onAbort = () => {
      const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (req) req.destroy(err);
      fail(err);
    };
    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const succeed = (res) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(res);
    };

    const req = transport.request(
      target,
      {
        method,
        headers: reqHeaders,
        agent: createConnection ? undefined : (isHttps ? (httpsAgent ?? getSharedAgent(true)) : (httpAgent ?? getSharedAgent(false))),
        ...(createConnection && { createConnection }),
      },
      (res) => {
        connected = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        const status = res.statusCode ?? 0;
        const respHeaders = new Headers();
        try {
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            if (Array.isArray(v)) {
              for (const item of v) respHeaders.append(k, item);
            } else {
              respHeaders.set(k, v);
            }
          }
        } catch (err) {
          res.destroy();
          fail(err);
          return;
        }
        const declared = Number(respHeaders.get('Content-Length'));
        if (declared > MAX_RESPONSE_BYTES) {
          res.destroy();
          fail(new Refusal('services_response_too_large', status));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            fail(new Refusal('services_response_too_large', status));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          try {
            const buf = size ? Buffer.concat(chunks, size) : null;
            // 204/205/304 responses must be constructed with null body per Fetch spec.
            const nullBodyStatus = status === 204 || status === 205 || status === 304;
            succeed(new Response(nullBodyStatus ? null : buf, { status, headers: respHeaders }));
          } catch (err) {
            fail(err);
          }
        });
        res.on('close', () => {
          if (!settled && !res.complete) {
            fail(Object.assign(new Error('response_truncated'), { code: 'ECONNRESET' }));
          }
        });
        res.on('error', (err) => fail(err));
      },
    );

    // Attach error handler immediately before any destroy() can be invoked.
    req.on('error', (err) => {
      if (!connected && err && typeof err === 'object') {
        err.preConnect = true;
      }
      fail(err);
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('socket', (sock) => {
      if (!sock.connecting) {
        connected = true;
        return;
      }
      const onConnected = () => {
        connected = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      };
      sock.once(isHttps ? 'secureConnect' : 'connect', onConnected);
      if (Number.isFinite(connectTimeout) && connectTimeout > 0) {
        connectTimer = setTimeout(() => {
          if (!connected && !settled) {
            const err = Object.assign(new Error('connect timeout'), {
              code: 'CONNECT_TIMEOUT',
              preConnect: true,
            });
            req.destroy(err);
            fail(err);
          }
        }, connectTimeout);
        connectTimer.unref?.();
      }
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

export class Refusal extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'Refusal';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function record(value, code = 'services_record_unreadable') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(code);
  return value;
}

function text(value, code = 'services_value_unreadable') {
  if (typeof value !== 'string' || !value.trim() || !value.isWellFormed()) throw new Refusal(code);
  return value;
}

function instant(value) {
  text(value, 'services_time_unreadable');
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Refusal('services_time_unreadable');
  }
  return value;
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() && value.isWellFormed() ? value : undefined;
}

function optionalInstant(value) {
  try { return instant(value); } catch { return undefined; }
}

export function parseParticipant(raw) {
  record(raw);
  if (raw.kind !== 'node' && raw.kind !== 'session') throw new Refusal('participant_kind_unknown');
  const result = { kind: raw.kind, participant_ref: text(raw.participant_ref) };
  const key = raw.kind === 'session' ? 'parent_node' : 'node';
  if (raw[key] !== undefined) {
    const node = record(raw[key]);
    result[key] = {
      kind: text(node.kind),
      mstpAddress: text(node.mstpAddress),
    };
    for (const field of ['handle', 'displayName', 'avatarUrl']) {
      const value = optionalText(node[field]);
      if (value !== undefined) result[key][field] = value;
    }
  }
  if (raw.kind === 'session') {
    const invalidDisplay = ['name', 'host_label'].some(
      (field) => raw[field] !== undefined && optionalText(raw[field]) === undefined,
    );
    if (raw.unresolved === true || invalidDisplay) {
      result.unresolved = true;
    } else {
      for (const field of ['name', 'host_label']) {
        if (raw[field] !== undefined) result[field] = raw[field];
      }
    }
    if (typeof raw.pick_code === 'string' && /^[a-f0-9]{6}$/u.test(raw.pick_code)) {
      result.pick_code = raw.pick_code;
    }
  } else {
    for (const field of ['nickname', 'handle']) {
      const value = optionalText(raw[field]);
      if (value !== undefined) result[field] = value;
    }
    if (raw.avatar_url === null) {
      result.avatar_url = null;
    } else {
      const avatar = optionalText(raw.avatar_url);
      if (avatar !== undefined) result.avatar_url = avatar;
    }
  }
  return result;
}

export function publicParty(value) {
  const parsed = parseParticipant(value);
  const result = {};
  for (const key of ['kind', 'nickname', 'name', 'host_label', 'handle', 'pick_code', 'unresolved', 'node', 'parent_node', 'avatar_url']) {
    if (parsed[key] !== undefined) result[key] = parsed[key];
  }
  return result;
}

export function parseSubject(raw, { allowWaiting = false } = {}) {
  record(raw);
  const waiting = allowWaiting && raw.kind === 'waiting';
  if (!waiting && (raw.kind !== 'conversation' || !['session_conversation', 'node_conversation'].includes(raw.conversation_kind))) {
    throw new Refusal('message_subject_unknown');
  }
  if (!Array.isArray(raw.participants) || raw.participants.length !== (waiting ? 1 : 2)) {
    throw new Refusal('message_participants_unreadable');
  }
  const parties = raw.participants.map(parseParticipant);
  const self = text(raw.self_participant_ref);
  if (new Set(parties.map((p) => p.participant_ref)).size !== parties.length ||
      parties.filter((p) => p.participant_ref === self).length !== 1) {
    throw new Refusal('message_self_unreadable');
  }
  if (!waiting && ((raw.conversation_kind === 'node_conversation') !== parties.every((p) => p.kind === 'node'))) {
    throw new Refusal('message_conversation_grain_mismatch');
  }
  return waiting
    ? { kind: 'waiting', message_ref: text(raw.message_ref), self_participant_ref: self, participants: parties }
    : {
      kind: 'conversation',
      conversation_kind: raw.conversation_kind,
      conversation_ref: text(raw.conversation_ref),
      self_participant_ref: self,
      participants: parties,
    };
}

export function parseMessageFrame(raw) {
  record(raw);
  if (raw.type !== 'message' || raw.version !== 1) throw new Refusal('message_version_unknown');
  const messageRef = text(raw.message_ref);
  const recipient = record(raw.recipient);
  if (Object.hasOwn(recipient, 'runtime_session_id') === Object.hasOwn(recipient, 'node_id')) {
    throw new Refusal('message_recipient_unreadable');
  }
  const grain = Object.hasOwn(recipient, 'runtime_session_id') ? 'runtime_session_id' : 'node_id';
  const envelope = record(raw.envelope);
  if (envelope.type !== 'masons.remote_message.v1' || envelope.message_ref !== messageRef ||
      typeof envelope.content !== 'string' || !envelope.content.isWellFormed()) {
    throw new Refusal('message_envelope_unreadable');
  }
  if (Buffer.byteLength(envelope.content, 'utf8') > MAX_INBOUND_CONTENT_BYTES) {
    throw new Refusal('message_content_too_large');
  }
  // content_digest is opaque to the host and echoed verbatim on receipts.
  const digest = text(raw.content_digest, 'message_digest_unreadable');

  const subject = parseSubject(raw.subject);
  const speaker = parseParticipant(raw.speaker);
  const member = subject.participants.find((p) => p.participant_ref === speaker.participant_ref);
  if (!member || member.kind !== speaker.kind || speaker.participant_ref === subject.self_participant_ref) {
    throw new Refusal('message_speaker_mismatch');
  }

  const result = {
    type: 'message',
    version: 1,
    message_ref: messageRef,
    endpoint_id: text(raw.endpoint_id),
    recipient: { [grain]: text(recipient[grain]) },
    content_type: text(raw.content_type),
    content_digest: digest,
    envelope: {
      type: envelope.type,
      message_ref: messageRef,
      content: envelope.content,
    },
    subject,
    speaker,
  };

  const sentAt = optionalInstant(envelope.sent_at);
  if (sentAt !== undefined) result.envelope.sent_at = sentAt;

  // Drop individual unreadable sender fields while preserving valid ones.
  if (envelope.sender && typeof envelope.sender === 'object' && !Array.isArray(envelope.sender)) {
    const sender = {};
    for (const field of ['address', 'display_name', 'handle']) {
      const v = optionalText(envelope.sender[field]);
      if (v !== undefined) sender[field] = v;
    }
    if (Object.keys(sender).length > 0) result.envelope.sender = sender;
  }

  // Optional seat: omit malformed seat, degrade unreadable session chooser to unresolved.
  const seat = raw.seat;
  if (seat && typeof seat === 'object' && !Array.isArray(seat) &&
      optionalInstant(seat.seated_at) !== undefined &&
      seat.chosen_by && typeof seat.chosen_by === 'object' && !Array.isArray(seat.chosen_by)) {
    const chooser = seat.chosen_by;
    if (chooser.kind === 'owner' || chooser.kind === 'self') {
      result.seat = { seated_at: seat.seated_at, chosen_by: { kind: chooser.kind } };
    } else if (chooser.kind === 'session') {
      const portrayal = {};
      let invalid = false;
      for (const field of ['name', 'host_label']) {
        if (chooser[field] !== undefined) {
          const v = optionalText(chooser[field]);
          if (v === undefined) invalid = true;
          else portrayal[field] = v;
        }
      }
      result.seat = {
        seated_at: seat.seated_at,
        chosen_by: chooser.unresolved === true || invalid || Object.keys(portrayal).length === 0
          ? { kind: 'session', unresolved: true }
          : { kind: 'session', ...portrayal },
      };
    }
  }

  return result;
}

export function parseSenderDeliveryFacts(raw) {
  record(raw);
  const outcomeAt = instant(raw.outcome_at);
  if (raw.placement !== 'placed') throw new Refusal('message_placement_unknown');
  // Accept any non-empty well-formed progress rung string for forward tolerance.
  const progress = text(raw.progress, 'message_progress_unreadable');
  return { placement: 'placed', progress, outcome_at: outcomeAt };
}

export function parseSendOutcome(raw) {
  record(raw);
  const common = {
    projection_etag: text(raw.projection_etag),
    outcome_at: instant(raw.outcome_at),
  };
  if (Object.hasOwn(raw, 'attempt_ref')) {
    const attempt = text(raw.attempt_ref);
    if (Object.hasOwn(raw, 'message_ref') ||
        !['refused', 'dispatch_pending', 'acceptance_unconfirmed'].includes(raw.outcome)) {
      throw new Refusal('sending_outcome_unknown');
    }
    const result = { ...common, attempt_ref: attempt, outcome: raw.outcome };
    if (raw.outcome === 'refused') {
      if (raw.refusal_code !== 'remote_definitive_refusal' ||
          instant(raw.local_outcome_recorded_at) !== common.outcome_at) {
        throw new Refusal('sending_refusal_unreadable');
      }
      Object.assign(result, {
        refusal_code: raw.refusal_code,
        remote_refusal_decided_at: instant(raw.remote_refusal_decided_at),
        local_outcome_recorded_at: raw.local_outcome_recorded_at,
      });
    }
    return result;
  }
  const facts = parseSenderDeliveryFacts(raw);
  return {
    ...common,
    ...facts,
    message_ref: text(raw.message_ref),
    subject: parseSubject(raw.subject, { allowWaiting: true }),
  };
}

export function directoryNode(raw) {
  record(raw, 'node_card_unreadable');
  const kind = text(raw.kind, 'node_card_unreadable');
  const address = text(raw.canonicalAddress, 'node_card_unreadable');
  const handle = text(raw.handle, 'node_card_unreadable');
  const host = text(raw.host, 'node_card_unreadable');
  let url;
  try { url = new URL(address); } catch { throw new Refusal('node_card_unreadable'); }
  if (url.protocol !== 'mstps:' || url.username || url.password || url.search || url.hash ||
      url.host !== host || url.pathname !== '/' + handle) {
    throw new Refusal('node_card_identity_mismatch');
  }
  const name = optionalText(raw.displayName);
  const avatar = optionalText(raw.avatarUrl);
  const update = optionalText(raw.update);
  return {
    kind,
    canonicalAddress: address,
    host,
    handle,
    ...(name && { displayName: name }),
    ...(avatar && { avatarUrl: avatar }),
    ...(update && { update }),
  };
}

export function directoryRoom(raw) {
  record(raw, 'room_unreadable');
  const result = { wait_ref: text(raw.wait_ref, 'room_unreadable'), party: parseParticipant(raw.party) };
  const preview = raw.last_message;
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    const excerpt = optionalText(preview.excerpt);
    const at = optionalInstant(preview.sent_at);
    if (at && excerpt) {
      result.last_message = {
        excerpt,
        sent_at: at,
        ...(typeof preview.excerpt_truncated === 'boolean' && { excerpt_truncated: preview.excerpt_truncated }),
      };
    }
  }
  if (Number.isSafeInteger(raw.pending_root_count) && raw.pending_root_count >= 0) {
    result.pending_root_count = raw.pending_root_count;
  }
  const at = optionalInstant(raw.arrived_at);
  if (at) result.arrived_at = at;
  return result;
}

export function dispatchAnswer(raw, key) {
  record(raw, 'room_dispatch_unconfirmed');
  if (raw.idempotency_key !== key || typeof raw.accepted !== 'boolean' ||
      raw.resolved_conversation_ref?.kind !== 'session_conversation') {
    throw new Refusal('room_dispatch_unconfirmed');
  }
  const result = {
    idempotency_key: key,
    accepted: raw.accepted,
    emitted_at: instant(raw.emitted_at),
    resolved_conversation_ref: {
      kind: 'session_conversation',
      id: text(raw.resolved_conversation_ref.id),
    },
  };
  if (raw.resume && typeof raw.resume === 'object' && !Array.isArray(raw.resume)) {
    if (raw.resume.outcome === 'started') result.resume = { outcome: 'started' };
    else if (raw.resume.outcome === 'not_resumed' && typeof raw.resume.reason === 'string') {
      result.resume = { outcome: 'not_resumed', reason: raw.resume.reason };
    }
  }
  return result;
}

export function managementNode(value, { requireHandle = true } = {}) {
  record(value);
  if (value.tombstone !== undefined && typeof value.tombstone !== 'boolean') throw new Refusal('connection_node_unreadable');
  if (value.tombstone === true) return { tombstone: true };
  const address = text(value.mstpAddress);
  let url;
  try { url = new URL(address); } catch { throw new Refusal('connection_node_unreadable'); }
  if (url.protocol !== 'mstps:' || url.username || url.password || url.search || url.hash) {
    throw new Refusal('connection_node_unreadable');
  }
  const handle = value.handle;
  const readableHandle = typeof handle === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/u.test(handle);
  if (requireHandle && !readableHandle) throw new Refusal('connection_node_unreadable');
  return {
    kind: text(value.kind),
    ...(readableHandle && { handle }),
    mstpAddress: address,
    ...(typeof value.displayName === 'string' && { displayName: value.displayName }),
  };
}

export function managementRequest(value) {
  record(value);
  if (!['awaiting-your-decision', 'awaiting-counterparty', 'accepted', 'ignored', 'withdrawn'].includes(value.status) ||
      (value.shadowed !== undefined && typeof value.shadowed !== 'boolean')) {
    throw new Refusal('connection_request_unreadable');
  }
  const createdAt = optionalInstant(value.createdAt);
  const resolvedAt = optionalInstant(value.resolvedAt);
  const row = {
    id: text(value.id),
    counterparty: managementNode(value.counterparty),
    status: value.status,
    ...(createdAt && { createdAt }),
    ...(resolvedAt && { resolvedAt }),
    shadowed: value.shadowed === true,
  };
  if (value.initialNote !== undefined) {
    try {
      const note = record(value.initialNote);
      if (typeof note.text !== 'string' || !note.text || !note.text.isWellFormed() || Array.from(note.text).length > 300) {
        throw new Refusal('connection_note_unreadable');
      }
      const author = managementNode(note.author, { requireHandle: false });
      const noteTime = optionalInstant(note.createdAt);
      row.initialNote = { author, text: note.text, ...(noteTime && { createdAt: noteTime }) };
    } catch {
      row.initialNote = { status: 'unreadable' };
    }
  }
  return row;
}

export function managementOperation(value, id) {
  record(value);
  const operation = record(value.operation);
  if (operation.id !== id || !['admitted', 'completed', 'superseded'].includes(operation.state) ||
      (operation.revision !== undefined && (!Number.isSafeInteger(operation.revision) || operation.revision < 0))) {
    throw new Refusal('connection_operation_unreadable');
  }
  const answer = {
    operation: {
      id,
      state: operation.state,
      ...(operation.revision !== undefined && { revision: operation.revision }),
    },
  };
  if (operation.state === 'completed') {
    const result = record(value.result);
    if (!['created', 'existing', 'crossing-accepted', 'policy-accepted', 'already_connected'].includes(result.outcome)) {
      throw new Refusal('connection_operation_unreadable');
    }
    answer.result = {
      outcome: result.outcome,
      ...(result.outcome === 'already_connected'
        ? { counterparty: managementNode(result.counterparty) }
        : { request: managementRequest(result.request) }),
    };
    if (result.note_status !== undefined) {
      if (!['saved', 'not_added'].includes(result.note_status)) throw new Refusal('connection_operation_unreadable');
      answer.result.note_status = result.note_status;
    }
  }
  return answer;
}

function endpointCred(registration, { retained = false } = {}) {
  if ((!retained && registration?.state !== 'active') || !registration?.response) {
    throw new Refusal('registration_unavailable');
  }
  return {
    endpoint_id: text(registration.response.endpoint_id),
    endpoint_nonce: text(registration.nonce),
  };
}

function isIdempotentForTransportRetry(path, method) {
  const route = path.split('?')[0];
  // cli-handoff/:id/poll is delete-on-read in Services; never retry post-connect!
  if (/^cli-handoff\/[^/]+\/poll$/u.test(route)) return false;
  if (method === 'GET' || method === 'DELETE') return true;
  if (method !== 'POST') return false;
  return route === 'runtime-endpoints/ensure' ||
    route === 'runtime/receipts' ||
    route === 'runtime/control-ack' ||
    route === 'runtime/member-send' ||
    route === 'runtime/session-identity' ||
    route === 'runtime/session-conversations' ||
    route === 'runtime/session-conversation-history' ||
    route === 'profiles/view' ||
    route === 'messages' ||
    route === 'me/connection-requests' ||
    route.startsWith('discovery/');
}

export function viewedProfile(raw) {
  const fail = () => { throw new Refusal('profile_view_unreadable'); };
  const card = (value, essential = false) => {
    const node = directoryNode(value);
    if (!node.displayName) fail();
    if (essential) {
      return Object.fromEntries(['kind', 'handle', 'canonicalAddress', 'host', 'displayName'].map((k) => [k, node[k]]));
    }
    for (const key of ['avatarUrl', 'update']) {
      if (value[key] !== null && value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].isWellFormed())) fail();
    }
    return { ...node, avatarUrl: value.avatarUrl ?? null, update: value.update ?? null };
  };
  const part = (value, parse) => {
    record(value, 'profile_view_unreadable');
    if (value.status === 'unavailable') return { status: 'unavailable' };
    if (value.status !== 'available') fail();
    return { status: 'available', value: parse(value.value) };
  };
  const note = (value) => {
    record(value, 'profile_view_unreadable');
    if (['absent', 'unavailable'].includes(value.status)) return { status: value.status };
    if (value.status !== 'present' || typeof value.text !== 'string' || !value.text.isWellFormed()) fail();
    return { status: 'present', text: value.text };
  };
  record(raw, 'profile_view_unreadable');
  record(raw.subject, 'profile_view_unreadable');
  record(raw.private_notes, 'profile_view_unreadable');
  if (raw.subject.kind === 'node') {
    return {
      subject: { kind: 'node', card: card(raw.subject.card) },
      affiliation: part(raw.affiliation, (v) => {
        record(v, 'profile_view_unreadable');
        if (v.kind === 'agent') return { kind: 'agent', operator: v.operator === null ? null : card(v.operator) };
        if (v.kind !== 'user' || !Array.isArray(v.operating)) fail();
        return { kind: 'user', operating: v.operating.map((row) => card(row)) };
      }),
      relationship: part(raw.relationship, (v) => {
        record(v, 'profile_view_unreadable');
        if (!['none', 'outgoing-pending', 'incoming-pending', 'connected'].includes(v.relationship) ||
            typeof v.canDirectSend !== 'boolean') fail();
        text(v.perspectiveId, 'profile_view_unreadable');
        let pending = null;
        if (v.pendingRequest !== null) {
          record(v.pendingRequest, 'profile_view_unreadable');
          text(v.pendingRequest.id, 'profile_view_unreadable');
          if (!['awaiting-your-decision', 'awaiting-counterparty', 'accepted', 'ignored', 'withdrawn'].includes(v.pendingRequest.status)) fail();
          pending = { status: v.pendingRequest.status };
        }
        return { relationship: v.relationship, canDirectSend: v.canDirectSend, pendingRequest: pending };
      }),
      private_notes: { node: note(raw.private_notes.node) },
    };
  }
  if (raw.subject.kind !== 'session') fail();
  const subject = { kind: 'session', participant_ref: text(raw.subject.participant_ref, 'profile_view_unreadable') };
  for (const key of ['name', 'host_label']) {
    if (raw.subject[key] !== undefined) subject[key] = text(raw.subject[key], 'profile_view_unreadable');
  }
  return {
    subject,
    parent_node: part(raw.parent_node, (v) => {
      record(v, 'profile_view_unreadable');
      return {
        identity: card(v.identity, true),
        operator: part(v.operator, (value) => (value === null ? null : card(value, true))),
      };
    }),
    private_notes: {
      session: note(raw.private_notes.session),
      node: note(raw.private_notes.node),
    },
  };
}

export function versionedNodeCard(raw) {
  record(raw, 'profile_unreadable');
  const p = record(raw.profile, 'profile_unreadable');
  const rev = text(raw.profileRevision, 'profile_unreadable');
  if (rev.length > 128) throw new Refusal('profile_unreadable');
  if (!['agent', 'user'].includes(p.kind)) throw new Refusal('profile_unreadable');
  const handle = text(p.handle, 'profile_unreadable');
  const canonicalAddress = text(p.canonicalAddress, 'profile_unreadable');
  const host = text(p.host, 'profile_unreadable');
  let url;
  try { url = new URL(canonicalAddress.replace(/^mstps:\/\//u, 'https://')); } catch { throw new Refusal('profile_unreadable'); }
  if (!canonicalAddress.startsWith('mstps://') || url.username || url.password || url.search || url.hash ||
      url.host !== host || url.pathname !== '/' + handle) {
    throw new Refusal('profile_unreadable');
  }
  const card = {
    kind: p.kind,
    handle,
    canonicalAddress,
    host,
    displayName: text(p.displayName, 'profile_unreadable'),
  };
  if (p.avatarUrl === null) card.avatarUrl = null;
  else if (p.avatarUrl !== undefined) card.avatarUrl = text(p.avatarUrl, 'profile_unreadable');
  if (p.update === null) card.update = null;
  else if (p.update !== undefined) card.update = text(p.update, 'profile_unreadable');
  return { profile: card, profileRevision: rev };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseSessionIdentity(raw) {
  record(raw, 'session_identity_unreadable');
  const selfRaw = record(raw.self, 'session_identity_unreadable');
  const topology = raw.topology;
  if (!['multi_session', 'single_session'].includes(topology)) {
    throw new Refusal('session_identity_unreadable');
  }
  const self = {};
  if (optionalText(selfRaw.name) !== undefined) self.name = selfRaw.name;
  if (optionalText(selfRaw.host_label) !== undefined) self.host_label = selfRaw.host_label;
  if (selfRaw.node !== undefined && isPlainObject(selfRaw.node)) {
    const h = optionalText(selfRaw.node.handle);
    if (h !== undefined) {
      self.node = {
        handle: h,
        ...(optionalText(selfRaw.node.display_name) !== undefined && { display_name: selfRaw.node.display_name }),
      };
    }
  }
  const result = { self, topology };
  if (topology === 'multi_session') {
    if (!Array.isArray(raw.siblings)) throw new Refusal('session_identity_unreadable');
    const siblings = [];
    let notShown = 0;
    for (const row of raw.siblings) {
      if (!isPlainObject(row) || !['present', 'away'].includes(row.state)) {
        notShown++;
        continue;
      }
      const name = optionalText(row.name);
      siblings.push({
        ...(name !== undefined && { name }),
        state: row.state,
      });
    }
    result.siblings = siblings;
    if (notShown > 0) result.not_shown = notShown;
  }
  return result;
}

function parseReachableProjection(raw) {
  record(raw, 'reachable_unreadable');
  if (raw.status !== 'exact_session_action_target_projection' || raw.contract_version !== 2) {
    throw new Refusal('reachable_unreadable');
  }
  const source = record(raw.acting_source, 'reachable_unreadable');
  if (source.kind !== 'exact_session') throw new Refusal('reachable_unreadable');
  text(source.session_ref, 'reachable_unreadable');
  const currentOnline = record(raw.current_online, 'reachable_unreadable');
  const recentConvs = record(raw.recent_conversations, 'reachable_unreadable');
  if (currentOnline.status !== 'available' || recentConvs.status !== 'available' ||
      typeof recentConvs.complete !== 'boolean' ||
      !Array.isArray(currentOnline.rows) || !Array.isArray(recentConvs.rows)) {
    throw new Refusal('reachable_unreadable');
  }
  return {
    acting_source: { kind: 'exact_session', session_ref: source.session_ref },
    current_online: {
      status: currentOnline.status,
      rows: currentOnline.rows,
    },
    recent_conversations: {
      status: recentConvs.status,
      complete: recentConvs.complete,
      ...(typeof recentConvs.continuation === 'string' && recentConvs.continuation && { continuation: recentConvs.continuation }),
      rows: recentConvs.rows,
    },
  };
}

export class Services {
  constructor({
    api,
    credential,
    fetch: fetchImpl,
    connectSocket = connectWebSocket,
    assertCurrent = () => {},
    requestTimeoutMs = 15000,
    silenceTimeoutMs = 30000,
  }) {
    const url = new URL(api);
    const httpLoopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    if ((url.protocol !== 'https:' && !httpLoopback) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Refusal('services_origin_invalid');
    }
    this.api = url.origin;
    this.credential = credential?.token === undefined && credential?.node === undefined
      ? {}
      : { token: text(credential.token), node: text(credential.node) };
    this.usePooledNodeHttp = !fetchImpl;
    this.fetch = fetchImpl ?? createNodeHttpFetch();
    this.connectSocket = connectSocket;
    this.assertCurrent = assertCurrent;
    this.requestTimeoutMs = requestTimeoutMs;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.serverTime = undefined;
  }

  async request(path, body, { method = 'POST', headers = {}, auth = true, expected, signal } = {}) {
    this.assertCurrent();
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..') || path.includes('#') || /^[a-z]+:/i.test(path)) {
      throw new Refusal('services_path_invalid');
    }
    const url = new URL(`${this.api}/v1/${path}`);
    if (url.origin !== this.api || !url.pathname.startsWith('/v1/')) {
      throw new Refusal('services_path_invalid');
    }
    const canRetryTransport = isIdempotentForTransportRetry(path, method);
    const maxAttempts = this.usePooledNodeHttp
      ? (canRetryTransport ? 3 : 2)
      : (canRetryTransport ? 2 : 1);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.assertCurrent();
      const merged = new Headers(headers);
      if (!merged.has('Accept')) merged.set('Accept', 'application/json');
      if (body !== undefined && !merged.has('Content-Type')) merged.set('Content-Type', 'application/json');
      if (auth) merged.set('Authorization', `Bearer ${text(this.credential.token, 'link_required')}`);
      // For custom fetch callers, force Connection: close on retry; pooled node:https keeps warm TLS sockets.
      if (!this.usePooledNodeHttp && attempt > 0) merged.set('Connection', 'close');

      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) controller.abort();
      const timer = setTimeout(abort, this.requestTimeoutMs);
      timer.unref?.();
      let gotResponse = false;

      try {
        const fetchOpts = {
          method,
          headers: merged,
          redirect: 'manual',
          signal: controller.signal,
          ...(body !== undefined && { body: JSON.stringify(body) }),
        };
        if (this.usePooledNodeHttp) {
          // Fail fast on wedged TCP/TLS handshakes for early attempts so retries dial a clean socket quickly.
          fetchOpts.connectTimeout = attempt + 1 < maxAttempts
            ? Math.min(DEFAULT_CONNECT_TIMEOUT_MS, this.requestTimeoutMs)
            : this.requestTimeoutMs;
        }
        const response = await this.fetch(url, fetchOpts);
        gotResponse = true;
        const declared = Number(response.headers.get('Content-Length'));
        if (declared > MAX_RESPONSE_BYTES) throw new Refusal('services_response_too_large', response.status);
        const date = response.headers.get('Date');
        if (date && Number.isFinite(Date.parse(date))) this.serverTime = new Date(date).toISOString();

        const chunks = [];
        const reader = response.body?.getReader();
        let size = 0;
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > MAX_RESPONSE_BYTES) throw new Refusal('services_response_too_large', response.status);
              chunks.push(chunk.value);
            }
          } catch (error) {
            void reader.cancel().catch(() => {});
            throw error;
          } finally {
            reader.releaseLock();
          }
        }

        this.assertCurrent();
        let value;
        try {
          value = size ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) : null;
        } catch {
          throw new Refusal('services_response_unreadable', response.status);
        }

        if (response.status >= 300) {
          const code = /^[a-z][a-z0-9_]{0,127}$/.test(value?.error ?? '') ? value.error : 'services_request_refused';
          const err = new Refusal(code, response.status);
          if (value && typeof value === 'object') err.body = value;
          throw err;
        }
        if (expected !== undefined && response.status !== expected) {
          throw new Refusal('services_status_unconfirmed', response.status);
        }
        return value;
      } catch (error) {
        if (error instanceof Refusal) throw error;
        if (controller.signal.aborted) {
          throw new Refusal(signal?.aborted ? 'operation_aborted' : 'services_timeout');
        }
        const safeToRetry = !gotResponse && attempt + 1 < maxAttempts && !signal?.aborted &&
          (canRetryTransport || error?.preConnect === true);
        if (safeToRetry) {
          await new Promise((r) => {
            const t = setTimeout(r, error?.preConnect ? 80 : 120);
            t.unref?.();
          });
          continue;
        }
        const rawCode = error?.cause?.code ?? error?.code;
        const reason = typeof rawCode === 'string' && /^[A-Z0-9_]{2,64}$/u.test(rawCode) ? rawCode : undefined;
        const err = new Refusal('services_network_unconfirmed');
        if (reason) err.reason = reason;
        throw err;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    }
    throw new Refusal('services_network_unconfirmed');
  }

  async viewProfile(body, { signal } = {}) {
    return viewedProfile(await this.request('profiles/view', body, {
      signal,
      headers: { 'Cache-Control': 'no-store' },
    }));
  }

  async icmProfile({ signal } = {}) {
    return versionedNodeCard(await this.request('runtime/icm-profile', undefined, {
      method: 'GET',
      signal,
      headers: { 'Cache-Control': 'no-store' },
    }));
  }

  async updateIcmProfile(body, { signal } = {}) {
    return versionedNodeCard(await this.request('runtime/icm-profile', body, {
      method: 'PATCH',
      signal,
      headers: { 'Cache-Control': 'no-store' },
    }));
  }

  async sessionIdentity(registration, { signal } = {}) {
    return parseSessionIdentity(await this.request('runtime/session-identity', {
      type: 'runtime_session_identity',
      version: 1,
      ...endpointCred(registration),
    }, { signal }));
  }

  async reachableTargets(registration, continuation, { signal } = {}) {
    return parseReachableProjection(await this.request('runtime/member-send', {
      type: 'list_runtime_session_targets',
      version: 2,
      ...endpointCred(registration),
      ...(continuation !== undefined && { continuation }),
    }, { signal }));
  }

  async identity({ signal } = {}) {
    const identity = record(await this.request('me/identity', undefined, { method: 'GET', signal }));
    const principal = record(await this.request('whoami', undefined, { method: 'GET', signal }));
    if (principal.subjectType !== 'agent-runtime' || principal.carrier !== 'runtime-api-key' || principal.subjectId !== this.credential.node) {
      throw new Refusal('link_principal_mismatch');
    }
    const node = record(identity.node);
    return {
      node: this.credential.node,
      handle: text(node.handle),
      address: text(node.mstpAddress),
      displayName: optionalText(node.displayName),
      raw: identity,
    };
  }

  async listEndpoints({ signal } = {}) {
    return record(await this.request(`runtime-endpoints?as=${encodeURIComponent(this.credential.node)}`, undefined, { method: 'GET', signal }));
  }

  async ensureEndpoint(intent, { startedAt, declaration = ANTIGRAVITY_DECLARATION, signal } = {}) {
    instant(startedAt);
    const value = record(await this.request('runtime-endpoints/ensure', intent, {
      headers: { 'x-registration-started-at': startedAt },
      signal,
    }));
    if (value.node_id !== this.credential.node || !['active', 'retired', 'superseded', 'expired'].includes(value.registration_outcome)) {
      throw new Refusal('registration_answer_unreadable');
    }
    if (value.registration_outcome === 'expired') {
      throw Object.assign(new Refusal('registration_expired'), {
        registration: { node_id: value.node_id, registration_outcome: 'expired' },
      });
    }
    text(value.endpoint_id);
    instant(value.registered_at);
    if (value.registration_outcome !== 'active') {
      throw Object.assign(new Refusal(`registration_${value.registration_outcome}`), { registration: value });
    }
    assertEffectiveDeclaration(value, declaration);
    return value;
  }

  async inspectEndpoint(registration, { declaration = ANTIGRAVITY_DECLARATION, signal } = {}) {
    const ep = endpointCred(registration, { retained: true });
    const value = record(await this.request(
      `runtime-endpoints/${encodeURIComponent(ep.endpoint_id)}?as=${encodeURIComponent(this.credential.node)}`,
      undefined,
      { method: 'GET', headers: { 'X-Endpoint-Nonce': ep.endpoint_nonce }, signal },
    ));
    if (value.endpoint_id !== ep.endpoint_id || value.node_id !== this.credential.node ||
        value.runtime_session_id !== registration.conversationId ||
        value.runtime_kind !== declaration.runtime_kind || value.is_self !== true) {
      throw new Refusal('registration_inactive');
    }
    if (Object.hasOwn(value, 'superseded_by_endpoint_id')) {
      text(value.superseded_by_endpoint_id, 'registration_answer_unreadable');
      throw Object.assign(new Refusal('registration_superseded'), { registration: value });
    }
    if (Object.hasOwn(value, 'retired_at')) {
      instant(value.retired_at);
      throw Object.assign(new Refusal('registration_retired'), { registration: value });
    }
    assertEffectiveDeclaration(value, declaration);
    return value;
  }

  retireEndpoint(registration, { signal } = {}) {
    const ep = endpointCred(registration, { retained: true });
    return this.request(
      `runtime-endpoints/${encodeURIComponent(ep.endpoint_id)}?as=${encodeURIComponent(this.credential.node)}`,
      undefined,
      { method: 'DELETE', signal },
    );
  }

  async postReceipt(registration, { act, messageRef, contentDigest: digest, endpointId, endpointNonce }, { signal } = {}) {
    const ep = endpointCred(registration);
    if (ep.endpoint_id !== endpointId || ep.endpoint_nonce !== endpointNonce) {
      throw new Refusal('receipt_registration_changed');
    }
    if (!['delivered', 'presented'].includes(act)) throw new Refusal('receipt_act_unknown');
    return this.request('runtime/receipts', {
      ...ep,
      act,
      items: [{ message_ref: text(messageRef), content_digest: text(digest) }],
    }, { expected: 204, signal });
  }

  controlAck(idempotencyKey, { signal } = {}) {
    return this.request('runtime/control-ack', {
      idempotency_key: text(idempotencyKey),
      status: 'applied',
    }, { signal });
  }

  async resolveTargets(registration, query, continuation, { signal } = {}) {
    const page = record(await this.request('runtime/member-send', {
      type: 'list_runtime_session_targets',
      version: 3,
      ...endpointCred(registration),
      query,
      ...(continuation !== undefined && { continuation }),
    }, { signal }));
    const source = record(page.acting_source);
    if (page.contract_version !== 3 || source.kind !== 'exact_session') throw new Refusal('target_page_unreadable');
    text(source.session_ref);
    const echo = record(page.query);
    if (echo.kind !== query.kind) throw new Refusal('target_query_mismatch');
    if (query.kind === 'node_match') {
      if (page.status !== 'runtime_node_target_resolution' || echo.match !== 'canonical_handle_exact' ||
          echo.handle !== query.match.handle || !['zero', 'one'].includes(page.outcome) ||
          !Array.isArray(page.nodes) || page.nodes.length !== (page.outcome === 'one' ? 1 : 0)) {
        throw new Refusal('target_node_resolution_unreadable');
      }
    } else if (query.kind === 'node_sessions') {
      if (echo.node_ref !== query.node_ref || record(page.node).node_ref !== query.node_ref || !Array.isArray(page.sessions)) {
        throw new Refusal('target_session_resolution_unreadable');
      }
      if (query.match) {
        if (page.status !== 'runtime_node_session_target_resolution' || echo.match !== 'approved_display_exact' ||
            echo.label !== query.match.label || echo.pick_code !== query.match.pick_code ||
            !['not_applicable', 'zero', 'one', 'many'].includes(page.outcome)) {
          throw new Refusal('target_session_resolution_unreadable');
        }
      } else if (page.status !== 'runtime_node_session_target_page') {
        throw new Refusal('target_session_page_unknown');
      }
      for (const row of page.sessions) {
        text(row.target_ref);
        text(record(row.display).label);
      }
    } else if (query.kind !== 'browse_nodes' || page.status !== 'runtime_node_target_page' || !Array.isArray(page.nodes)) {
      throw new Refusal('target_page_unknown');
    }
    return page;
  }

  async nodeAddressingOutcomes(registration, targets, { signal } = {}) {
    const ep = endpointCred(registration);
    return record(await this.request('discovery/node-addressing-outcomes', {
      agentIds: targets,
      declarations: { source_endpoint_id: ep.endpoint_id },
    }, { signal }));
  }

  async sendMessage(registration, sendRequestId, intent, { signal } = {}) {
    if (typeof intent?.content !== 'string' || !intent.content || !intent.content.isWellFormed() ||
        Buffer.byteLength(intent.content, 'utf8') > MAX_SEND_BYTES) {
      throw new Refusal('send_content_invalid');
    }
    const raw = await this.request('messages', {
      ...intent,
      ...endpointCred(registration),
      send_request_id: text(sendRequestId),
    }, {
      headers: { Accept: SEND_MEDIA, 'Content-Type': SEND_MEDIA },
      signal,
    });
    const result = parseSendOutcome(raw);
    if (result.subject && result.subject.self_participant_ref !== intent.acting_source?.session_ref) {
      throw new Refusal('send_outcome_source_mismatch');
    }
    if (intent.requested_conversation_ref && result.subject?.conversation_ref !== intent.requested_conversation_ref) {
      throw new Refusal('send_outcome_conversation_mismatch');
    }
    return result;
  }

  async readOutcome(registration, path, { signal } = {}) {
    if (!/^(messages|sending-attempts)\/[^/?#]+$/.test(path)) throw new Refusal('outcome_path_invalid');
    const ep = endpointCred(registration);
    const result = parseSendOutcome(await this.request(`${path}/outcome?version=2`, undefined, {
      method: 'GET',
      headers: { Accept: SEND_MEDIA, 'X-Endpoint-Id': ep.endpoint_id, 'X-Endpoint-Nonce': ep.endpoint_nonce },
      signal,
    }));
    const resource = decodeURIComponent(path.slice(path.indexOf('/') + 1));
    const key = path.startsWith('messages/') ? 'message_ref' : 'attempt_ref';
    if ((key === 'message_ref' || result.attempt_ref) && result[key] !== resource) {
      throw new Refusal('outcome_resource_mismatch');
    }
    return result;
  }

  async conversations(registration, opts, { signal } = {}) {
    const continuation = typeof opts === 'string' ? opts : opts?.continuation;
    const limit = typeof opts === 'object' && Number.isSafeInteger(opts?.limit)
      ? Math.max(1, Math.min(100, opts.limit))
      : 50;
    const since = typeof opts === 'object' && typeof opts?.since === 'string' && opts.since.trim()
      ? opts.since.trim()
      : undefined;
    return record(await this.request('runtime/session-conversations', {
      type: 'runtime_session_conversations',
      version: 1,
      ...endpointCred(registration),
      limit,
      ...(continuation !== undefined && { continuation_ref: continuation }),
      ...(since !== undefined && { since }),
    }, { signal }));
  }

  async history(registration, lookup, opts, { signal } = {}) {
    const continuation = typeof opts === 'string' ? opts : opts?.continuation;
    const limit = typeof opts === 'object' && Number.isSafeInteger(opts?.limit)
      ? Math.max(1, Math.min(100, opts.limit))
      : 10;
    const tail = typeof opts === 'object' && opts?.tail === true;
    return record(await this.request('runtime/session-conversation-history', {
      type: 'runtime_session_conversation_history',
      version: 2,
      ...endpointCred(registration),
      ...lookup,
      limit,
      ...(tail && { tail: true }),
      ...(continuation !== undefined && { continuation_ref: continuation }),
    }, { signal }));
  }

  async discoverNodes(action, q, limit = 10, { signal } = {}) {
    if (!['nodes', 'agents'].includes(action)) throw new Refusal('discovery_action_invalid');
    const query = new URLSearchParams({ q, limit: String(limit) });
    const value = record(await this.request(`discovery/nodes${action === 'agents' ? '/search' : ''}?${query}`, undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.results) || value.results.length > limit || (action === 'nodes' && typeof value.hasMore !== 'boolean')) {
      throw new Refusal('search_results_unreadable');
    }
    const results = value.results.map(directoryNode);
    return { results, ...(action === 'nodes' && { hasMore: value.hasMore }), recall: 'bounded', permission: 'not_established' };
  }

  async vacantRooms(cursor, { signal } = {}) {
    const query = new URLSearchParams({ limit: '100', ...(cursor !== undefined && { continuation_ref: cursor }) });
    const value = record(await this.request(`runtime/undispatched?${query}`, undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.items) || value.items.length > 100) throw new Refusal('room_page_unreadable');
    return {
      items: value.items.map(directoryRoom),
      ...(typeof value.continuation_ref === 'string' && value.continuation_ref && { continuation_ref: value.continuation_ref }),
    };
  }

  async dispatchRoom(body, { signal } = {}) {
    return dispatchAnswer(await this.request('runtime/dispatch', body, { signal }), body.idempotency_key);
  }

  async connectionList({ signal } = {}) {
    const value = record(await this.request('me/connections', undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.connections) || !Number.isSafeInteger(value.total) || value.total < value.connections.length) {
      throw new Refusal('connections_unreadable');
    }
    return {
      total: value.total,
      connections: value.connections.map((row) => {
        record(row);
        if (!['mutual', 'inbound', 'outbound'].includes(row.access)) throw new Refusal('connections_unreadable');
        return {
          counterparty: managementNode(row.counterparty),
          access: row.access,
          ...(typeof row.counterpartyProfile?.update === 'string' && { update: row.counterpartyProfile.update }),
          ...(typeof row.presence === 'string' && { presence: row.presence }),
        };
      }),
    };
  }

  async connectionRequests(handle, cursor, { signal } = {}) {
    const query = new URLSearchParams({
      limit: '100',
      ...(handle && { counterparty: handle }),
      ...(cursor !== undefined && { cursor }),
    });
    const value = record(await this.request(`me/connection-requests?${query}`, undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.items) || value.items.length > 100) throw new Refusal('connection_page_unreadable');
    return {
      items: value.items.map(managementRequest),
      nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null,
    };
  }

  createConnectionRequest(body, { signal } = {}) {
    return this.request('me/connection-requests', body, { signal });
  }

  async connectionOperation(id, { signal } = {}) {
    return managementOperation(await this.request(`me/connection-operations/${encodeURIComponent(id)}`, undefined, { method: 'GET', signal }), id);
  }

  async decideConnectionRequest(id, action, { signal } = {}) {
    if (!['accept', 'ignore', 'withdraw'].includes(action)) throw new Refusal('connection_action_invalid');
    const value = record(await this.request(`me/connection-requests/${encodeURIComponent(id)}/${action}`, undefined, { signal }));
    return managementRequest(value.request);
  }

  /**
   * Direct Services control-events WebSocket stream.
   * Unknown stream frame types are ignored while keeping the stream open.
   */
  stream(onFrame, { signal, onOpen = () => {}, silenceTimeoutMs = this.silenceTimeoutMs } = {}) {
    this.assertCurrent();
    text(this.credential.token, 'link_required');
    text(this.credential.node, 'link_required');
    if (signal?.aborted) return Promise.resolve();
    const url = new URL(`${this.api}/v1/runtime/control-events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('agent_id', this.credential.node);

    return new Promise((resolve, reject) => {
      let stopped = false;
      let chain = Promise.resolve();
      let pendingBytes = 0;
      let pendingFrames = 0;
      let conn = null;

      const finish = (error) => {
        if (stopped) return;
        stopped = true;
        try { conn?.close(); } catch {}
        if (error) {
          reject(error instanceof Refusal ? error : new Refusal(error?.code ?? 'stream_consumer_failed', error?.status));
        } else {
          resolve();
        }
      };

      const knownTypes = new Set([
        'message',
        'caught_up',
        'typing',
        'force_unregister',
        'registration_retired',
        'session_name_changed',
        'session_resume',
      ]);

      conn = this.connectSocket(url.href, {
        headers: { Authorization: `Bearer ${this.credential.token}` },
        openTimeoutMs: this.requestTimeoutMs,
        silenceTimeoutMs,
        maxFrameBytes: MAX_FRAME_BYTES,
        signal,
        onOpen: () => {
          chain = chain.then(() => {
            this.assertCurrent();
            return onOpen();
          }).catch(finish);
        },
        onMessage: (data) => {
          if (stopped) return;
          if (typeof data !== 'string' || !data.isWellFormed()) {
            finish(new Refusal('stream_unreadable'));
            return;
          }
          const bytes = Buffer.byteLength(data, 'utf8');
          pendingBytes += bytes;
          pendingFrames++;
          if (bytes > MAX_FRAME_BYTES || pendingBytes > MAX_FRAME_BYTES || pendingFrames > 256) {
            finish(new Refusal('stream_backlog_exceeded'));
            return;
          }
          chain = chain.then(async () => {
            if (stopped) return;
            this.assertCurrent();
            let raw;
            try { raw = JSON.parse(data); } catch { throw new Refusal('stream_unreadable'); }
            record(raw, 'stream_unreadable');
            // Ignore unknown frame types while keeping stream open.
            if (!knownTypes.has(raw.type)) return;
            if (['force_unregister', 'registration_retired', 'session_name_changed', 'session_resume'].includes(raw.type)) {
              if (raw.version !== 1 || !Number.isFinite(raw.emitted_at)) throw new Refusal('stream_control_unreadable');
              text(raw.idempotency_key, 'stream_control_unreadable');
              text(raw.type === 'session_resume' ? raw.runtime_session_id : raw.endpoint_id, 'stream_control_unreadable');
            }
            if (raw.type === 'caught_up' || raw.type === 'typing') text(raw.endpoint_id, 'stream_frame_unreadable');
            if (raw.type === 'typing') text(raw.conversation_ref, 'stream_frame_unreadable');
            await onFrame(raw.type === 'message' ? parseMessageFrame(raw) : raw);
            this.assertCurrent();
          }).catch(finish).finally(() => {
            pendingBytes -= bytes;
            pendingFrames--;
          });
        },
        onError: (err) => {
          finish(new Refusal(err?.code ?? 'stream_error', err?.status));
        },
        onClose: (evt) => {
          if (signal?.aborted) finish();
          else if (evt.code === 1008) finish(new Refusal('credential_ended', 401));
          else finish(new Refusal('stream_closed'));
        },
      });
    });
  }
}
