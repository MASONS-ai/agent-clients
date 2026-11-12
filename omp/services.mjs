import { createHash } from 'node:crypto';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BYTES = 65536;
const SEND_MEDIA = 'application/vnd.masons.icm-messaging-v2+json';
const PROGRESS = new Set(['accepted', 'delivered', 'presented']);
const OPERATIONS = new Set(['identity', 'registration', 'endpoint_list', 'endpoint_read', 'endpoint_retirement', 'session_name', 'typing', 'control_ack', 'receipt', 'send', 'outcome', 'directory', 'history', 'profile', 'connections', 'link', 'other']);
function operation(path, method) {
  const route = path.split('?')[0];
  if (route.startsWith('runtime-endpoints')) return route.endsWith('/display-metadata') ? 'session_name' : method === 'DELETE' ? 'endpoint_retirement' : method === 'POST' ? 'registration' : route === 'runtime-endpoints' ? 'endpoint_list' : 'endpoint_read';
  if (route === 'runtime/typing') return 'typing';
  if (route === 'runtime/control-ack') return 'control_ack';
  if (route === 'runtime/receipts') return 'receipt';
  if (route === 'messages') return 'send';
  if (route.startsWith('messages/') || route.startsWith('sending-attempts/')) return 'outcome';
  if (route.startsWith('runtime/icm-profile')) return 'profile';
  if (route.startsWith('me/connection')) return 'connections';
  if (route.startsWith('cli-handoff/')) return 'link';
  if (route.startsWith('discovery/') || route.startsWith('runtime/member-send') || route.startsWith('runtime/undispatched') || route.startsWith('runtime/dispatch')) return 'directory';
  if (route === 'runtime/session-conversations' || route === 'runtime/session-conversation-history') return 'history';
  if (route === 'me/identity' || route === 'whoami') return 'identity';
  return 'other';
}
export function requestDiagnostics(error) {
  const value = error?.diagnostics;
  if (error?.code !== 'services_timeout' || !OPERATIONS.has(value?.operation) || !['elapsed_ms', 'deadline_ms'].every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0)) return undefined;
  return { operation: value.operation, elapsed_ms: value.elapsed_ms, deadline_ms: value.deadline_ms };
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
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Refusal('services_time_unreadable');
  return value;
}
function optionalText(value) {
  return typeof value === 'string' && value.trim() && value.isWellFormed() ? value : undefined;
}
function optionalInstant(value) {
  try { return instant(value); } catch { return undefined; }
}
function declarationMatches(value, expected) {
  for (const [key, item] of Object.entries(expected ?? {})) {
    if (key === 'runtime_capabilities') {
      if (!Array.isArray(value[key]) || value[key].some((cap) => typeof cap !== 'string') ||
          JSON.stringify([...value[key]].sort()) !== JSON.stringify([...item].sort())) return false;
    } else if (value[key] !== item) return false;
  }
  return true;
}

export function contentDigest(content) {
  if (typeof content !== 'string' || !content.isWellFormed()) throw new Refusal('message_content_unreadable');
  const hash = createHash('sha256');
  for (const item of ['masons/icm/content/v1', content]) {
    const bytes = Buffer.from(item, 'utf8'), size = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    hash.update(size); hash.update(bytes);
  }
  return hash.digest('base64url');
}

function participant(raw) {
  record(raw);
  if (raw.kind !== 'node' && raw.kind !== 'session') throw new Refusal('participant_kind_unknown');
  const result = { kind: raw.kind, participant_ref: text(raw.participant_ref) };
  const key = raw.kind === 'session' ? 'parent_node' : 'node';
  if (raw[key] !== undefined) {
    const node = record(raw[key]);
    result[key] = { kind: text(node.kind), mstpAddress: text(node.mstpAddress) };
    for (const field of ['handle', 'displayName', 'avatarUrl']) {
      const value = optionalText(node[field]);
      if (value !== undefined) result[key][field] = value;
    }
  }
  if (raw.kind === 'session') {
    if (raw.unresolved === true || ['name', 'host_label'].some((field) => raw[field] !== undefined && optionalText(raw[field]) === undefined)) {
      result.unresolved = true;
    } else {
      for (const field of ['name', 'host_label']) if (raw[field] !== undefined) result[field] = raw[field];
    }
    if (/^[a-f0-9]{6}$/.test(raw.pick_code ?? '')) result.pick_code = raw.pick_code;
  } else {
    for (const field of ['nickname', 'handle', 'avatar_url']) {
      const value = optionalText(raw[field]);
      if (value !== undefined) result[field] = value;
    }
  }
  return result;
}

export function publicParty(value) {
  const parsed = participant(value), result = {};
  for (const key of ['kind', 'nickname', 'name', 'host_label', 'handle', 'pick_code', 'unresolved', 'node', 'parent_node', 'avatar_url']) {
    if (parsed[key] !== undefined) result[key] = parsed[key];
  }
  return result;
}

export function parseSubject(raw, { allowWaiting = false } = {}) {
  record(raw);
  const waiting = allowWaiting && raw.kind === 'waiting';
  if (!waiting && (raw.kind !== 'conversation' || !['session_conversation', 'node_conversation'].includes(raw.conversation_kind)))
    throw new Refusal('message_subject_unknown');
  if (!Array.isArray(raw.participants) || raw.participants.length !== (waiting ? 1 : 2)) throw new Refusal('message_participants_unreadable');
  const parties = raw.participants.map(participant), self = text(raw.self_participant_ref);
  if (new Set(parties.map((p) => p.participant_ref)).size !== parties.length || parties.filter((p) => p.participant_ref === self).length !== 1)
    throw new Refusal('message_self_unreadable');
  if (!waiting && ((raw.conversation_kind === 'node_conversation') !== parties.every((p) => p.kind === 'node')))
    throw new Refusal('message_conversation_grain_mismatch');
  return waiting ? { kind: 'waiting', message_ref: text(raw.message_ref), self_participant_ref: self, participants: parties } :
    { kind: 'conversation', conversation_kind: raw.conversation_kind, conversation_ref: text(raw.conversation_ref), self_participant_ref: self, participants: parties };
}

export function parseMessage(raw) {
  record(raw);
  if (raw.type !== 'message' || raw.version !== 1) throw new Refusal('message_version_unknown');
  const message = text(raw.message_ref), recipient = record(raw.recipient);
  if (Object.hasOwn(recipient, 'runtime_session_id') === Object.hasOwn(recipient, 'node_id')) throw new Refusal('message_recipient_unreadable');
  const grain = Object.hasOwn(recipient, 'runtime_session_id') ? 'runtime_session_id' : 'node_id';
  const envelope = record(raw.envelope);
  if (envelope.type !== 'masons.remote_message.v1' || envelope.message_ref !== message ||
      typeof envelope.content !== 'string' || !envelope.content.isWellFormed()) throw new Refusal('message_envelope_unreadable');
  if (Buffer.byteLength(envelope.content, 'utf8') > MAX_CONTENT_BYTES) throw new Refusal('message_content_too_large');
  const digest = contentDigest(envelope.content);
  if (raw.content_digest !== digest) throw new Refusal('message_digest_mismatch');
  const subject = parseSubject(raw.subject), speaker = participant(raw.speaker);
  const member = subject.participants.find((p) => p.participant_ref === speaker.participant_ref);
  if (!member || member.kind !== speaker.kind || speaker.participant_ref === subject.self_participant_ref) throw new Refusal('message_speaker_mismatch');
  const result = { type: 'message', version: 1, message_ref: message, endpoint_id: text(raw.endpoint_id),
    recipient: { [grain]: text(recipient[grain]) }, content_type: text(raw.content_type), content_digest: digest,
    envelope: { type: envelope.type, message_ref: message, content: envelope.content }, subject, speaker };
  const sentAt = optionalInstant(envelope.sent_at);
  if (sentAt !== undefined) result.envelope.sent_at = sentAt;
  if (envelope.sender && typeof envelope.sender === 'object' && !Array.isArray(envelope.sender)) {
    const sender = {}, fields = ['address', 'display_name', 'handle'];
    if (!fields.some((key) => envelope.sender[key] !== undefined && optionalText(envelope.sender[key]) === undefined)) {
      for (const key of fields) if (envelope.sender[key] !== undefined) sender[key] = envelope.sender[key];
      result.envelope.sender = sender;
    }
  }
  const seat = raw.seat;
  if (seat && typeof seat === 'object' && optionalInstant(seat.seated_at) !== undefined && seat.chosen_by && typeof seat.chosen_by === 'object') {
    const chooser = seat.chosen_by;
    if (chooser.kind === 'owner' || chooser.kind === 'self') result.seat = { seated_at: seat.seated_at, chosen_by: { kind: chooser.kind } };
    else if (chooser.kind === 'session') {
      const portrayal = Object.fromEntries(['name', 'host_label'].filter((key) => optionalText(chooser[key]) !== undefined).map((key) => [key, chooser[key]]));
      const invalid = ['name', 'host_label'].some((key) => chooser[key] !== undefined && optionalText(chooser[key]) === undefined);
      result.seat = { seated_at: seat.seated_at, chosen_by: chooser.unresolved === true || invalid || !Object.keys(portrayal).length ?
        { kind: 'session', unresolved: true } : { kind: 'session', ...portrayal } };
    }
  }
  return result;
}

export function parseSendOutcome(raw) {
  record(raw);
  const common = { projection_etag: text(raw.projection_etag), outcome_at: instant(raw.outcome_at) };
  if (Object.hasOwn(raw, 'attempt_ref')) {
    const attempt = text(raw.attempt_ref);
    if (Object.hasOwn(raw, 'message_ref') || !['refused', 'dispatch_pending', 'acceptance_unconfirmed'].includes(raw.outcome)) throw new Refusal('sending_outcome_unknown');
    const result = { ...common, attempt_ref: attempt, outcome: raw.outcome };
    if (raw.outcome === 'refused') {
      if (raw.refusal_code !== 'remote_definitive_refusal' || instant(raw.local_outcome_recorded_at) !== common.outcome_at)
        throw new Refusal('sending_refusal_unreadable');
      Object.assign(result, { refusal_code: raw.refusal_code, remote_refusal_decided_at: instant(raw.remote_refusal_decided_at), local_outcome_recorded_at: raw.local_outcome_recorded_at });
    }
    return result;
  }
  if (raw.placement !== 'placed' || !PROGRESS.has(raw.progress)) throw new Refusal('message_placement_unknown');
  return { ...common, message_ref: text(raw.message_ref), subject: parseSubject(raw.subject, { allowWaiting: true }), placement: 'placed', progress: raw.progress };
}

function endpoint(session, { retained = false } = {}) {
  if ((!retained && session.state !== 'active') || !session.response) throw new Refusal('registration_unavailable');
  return { endpoint_id: text(session.response.endpoint_id), endpoint_nonce: text(session.nonce) };
}

export function directoryNode(raw) {
  record(raw, 'node_card_unreadable');
  const kind = text(raw.kind, 'node_card_unreadable'), address = text(raw.canonicalAddress, 'node_card_unreadable');
  const handle = text(raw.handle, 'node_card_unreadable'), host = text(raw.host, 'node_card_unreadable');
  let url;
  try { url = new URL(address); } catch { throw new Refusal('node_card_unreadable'); }
  if (url.protocol !== 'mstps:' || url.username || url.password || url.search || url.hash || url.host !== host || url.pathname !== '/' + handle) throw new Refusal('node_card_identity_mismatch');
  const name = optionalText(raw.displayName), avatar = optionalText(raw.avatarUrl), update = optionalText(raw.update);
  return { kind, canonicalAddress: address, host, handle, ...(name && { displayName: name }),
    ...(avatar && { avatarUrl: avatar }), ...(update && { update }) };
}
export function directoryRoom(raw) {
  record(raw, 'room_unreadable');
  const result = { wait_ref: text(raw.wait_ref, 'room_unreadable'), party: participant(raw.party) };
  const preview = raw.last_message;
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    const excerpt = optionalText(preview.excerpt), at = optionalInstant(preview.sent_at);
    if (at && excerpt) result.last_message = { excerpt, sent_at: at,
      ...(typeof preview.excerpt_truncated === 'boolean' && { excerpt_truncated: preview.excerpt_truncated }) };
  }
  if (Number.isSafeInteger(raw.pending_root_count) && raw.pending_root_count >= 0) result.pending_root_count = raw.pending_root_count;
  const at = optionalInstant(raw.arrived_at); if (at) result.arrived_at = at;
  return result;
}
export function dispatchAnswer(raw, key) {
  record(raw, 'room_dispatch_unconfirmed');
  if (raw.idempotency_key !== key || typeof raw.accepted !== 'boolean' || raw.resolved_conversation_ref?.kind !== 'session_conversation') throw new Refusal('room_dispatch_unconfirmed');
  const result = { idempotency_key: key, accepted: raw.accepted, emitted_at: instant(raw.emitted_at),
    resolved_conversation_ref: { kind: 'session_conversation', id: text(raw.resolved_conversation_ref.id) } };
  if (raw.resume !== undefined) {
    const resume = raw.resume;
    if (resume && typeof resume === 'object' && !Array.isArray(resume) && resume.outcome === 'started') result.resume = { outcome: 'started' };
    else if (resume && typeof resume === 'object' && !Array.isArray(resume) && resume.outcome === 'not_resumed' && ['no_machine', 'not_supported', 'rate_limited', 'machine_offline', 'not_on_this_machine', 'no_history', 'failed'].includes(resume.reason)) result.resume = { outcome: 'not_resumed', reason: resume.reason };
  }
  return result;
}

function namingFacts(value) {
  const result = { ...value };
  const name = value.session_naming?.name;
  if (typeof name === 'string' && name.trim() && name.isWellFormed() && Array.from(name).length <= 80) result.session_naming = { name };
  else delete result.session_naming;
  if (value.dropped !== undefined) {
    if (Array.isArray(value.dropped) && value.dropped.every((v) => typeof v === 'string' && v.length)) result.dropped = [...value.dropped];
    else delete result.dropped;
  }
  return result;
}

export class Services {
  constructor({ api, credential, fetch: fetchImpl = globalThis.fetch, createSocket, assertCurrent = () => {}, requestTimeoutMs = 15000 }) {
    const url = new URL(api);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Refusal('services_origin_invalid');
    this.api = url.origin;
    this.credential = credential?.token === undefined && credential?.node === undefined ? {} : { token: text(credential.token), node: text(credential.node) };
    this.fetch = fetchImpl;
    this.createSocket = createSocket ?? ((target, options) => new globalThis.WebSocket(target, options));
    this.assertCurrent = assertCurrent;
    this.requestTimeoutMs = requestTimeoutMs;
    this.serverTime = undefined;
  }

  async request(path, body, { method = 'POST', headers = {}, auth = true, expected, signal } = {}) {
    this.assertCurrent();
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..') || path.includes('#') || /^[a-z]+:/i.test(path)) throw new Refusal('services_path_invalid');
    const url = new URL(`${this.api}/v1/${path}`);
    if (url.origin !== this.api || !url.pathname.startsWith('/v1/')) throw new Refusal('services_path_invalid');
    const merged = new Headers(headers);
    if (!merged.has('Accept')) merged.set('Accept', 'application/json');
    if (body !== undefined && !merged.has('Content-Type')) merged.set('Content-Type', 'application/json');
    if (auth) merged.set('Authorization', `Bearer ${text(this.credential.token, 'link_required')}`);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const started = performance.now(), timer = setTimeout(abort, this.requestTimeoutMs); timer.unref?.();
    try {
      const response = await this.fetch(url, { method, headers: merged, redirect: 'manual', signal: controller.signal,
        ...(body !== undefined && { body: JSON.stringify(body) }) });
      const declared = Number(response.headers.get('Content-Length'));
      if (declared > MAX_RESPONSE_BYTES) throw new Refusal('services_response_too_large', response.status);
      const date = response.headers.get('Date');
      if (date && Number.isFinite(Date.parse(date))) this.serverTime = new Date(date).toISOString();
      const chunks = [], reader = response.body?.getReader();
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
        } finally { reader.releaseLock(); }
      }
      this.assertCurrent();
      let value;
      try { value = size ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) : null; }
      catch { throw new Refusal('services_response_unreadable', response.status); }
      if (response.status >= 300) {
        const code = /^[a-z][a-z0-9_]{0,127}$/.test(value?.error ?? '') ? value.error : 'services_request_refused';
        throw new Refusal(code, response.status);
      }
      if (expected !== undefined && response.status !== expected) throw new Refusal('services_status_unconfirmed', response.status);
      return value;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      if (controller.signal.aborted) {
        const failure = new Refusal(signal?.aborted ? 'operation_aborted' : 'services_timeout');
        if (!signal?.aborted) failure.diagnostics = { operation: operation(path, method), elapsed_ms: Math.max(0, Math.round(performance.now() - started)), deadline_ms: this.requestTimeoutMs };
        throw failure;
      }
      throw new Refusal('services_network_unconfirmed');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
  }

  async reportName(session, name, { signal } = {}) {
    const ep = endpoint(session);
    const value = record(await this.request(`runtime-endpoints/${encodeURIComponent(ep.endpoint_id)}/display-metadata`, { host_session_name: name }, { signal }));
    if (value.endpoint_id !== ep.endpoint_id) throw new Refusal('name_report_unconfirmed');
    const ack = record(value.host_session_name, 'name_report_unconfirmed');
    if (ack.accepted === true) return { accepted: true };
    if (ack.accepted === false && ['invalid', 'rate_limited', 'display_unassigned', 'stale_incarnation'].includes(ack.reason)) return { accepted: false, reason: ack.reason };
    throw new Refusal('name_report_unconfirmed');
  }
  typing(session, conversation, { signal } = {}) {
    return this.request('runtime/typing', { conversation_ref: text(conversation), ...endpoint(session) }, { signal, expected: 204 });
  }

  async discoverNodes(action, q, limit, { signal } = {}) {
    if (!['nodes', 'agents'].includes(action)) throw new Refusal('discovery_action_invalid');
    const query = new URLSearchParams({ q, limit: String(limit) });
    const value = record(await this.request(`discovery/nodes${action === 'agents' ? '/search' : ''}?${query}`, undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.results) || value.results.length > limit || (action === 'nodes' && typeof value.hasMore !== 'boolean')) throw new Refusal('search_results_unreadable');
    const results = value.results.map(directoryNode);
    if (new Set(results.map((r) => r.canonicalAddress)).size !== results.length) throw new Refusal('search_results_unreadable');
    return { results, ...(action === 'nodes' && { hasMore: value.hasMore }), recall: 'bounded', permission: 'not_established' };
  }
  async resolveNode(handle, { signal } = {}) {
    const value = record(await this.request(`discovery/resolve?${new URLSearchParams({ handle })}`, undefined, { method: 'GET', signal }));
    const resolved = directoryNode(value.resolved);
    if (resolved.handle !== handle) throw new Refusal('node_card_identity_mismatch');
    return { resolved, permission: 'not_established' };
  }
  async vacantRooms(cursor, { signal } = {}) {
    const query = new URLSearchParams({ limit: '100', ...(cursor !== undefined && { continuation_ref: cursor }) });
    const value = record(await this.request(`runtime/undispatched?${query}`, undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.items) || value.items.length > 100 || (Object.hasOwn(value, 'continuation_ref') && (typeof value.continuation_ref !== 'string' || !value.continuation_ref || value.continuation_ref.length > 8192))) throw new Refusal('room_page_unreadable');
    return { items: value.items.map(directoryRoom), ...(value.continuation_ref !== undefined && { continuation_ref: value.continuation_ref }) };
  }
  async dispatchRoom(body, { signal } = {}) { return dispatchAnswer(await this.request('runtime/dispatch', body, { signal }), body.idempotency_key); }

  async connectionList({ signal } = {}) {
    const value = record(await this.request('me/connections', undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.connections) || !Number.isSafeInteger(value.total) || value.total < value.connections.length) throw new Refusal('connections_unreadable');
    return { total: value.total, connections: value.connections.map((row) => {
      record(row);
      if (!['mutual', 'inbound', 'outbound'].includes(row.access)) throw new Refusal('connections_unreadable');
      return { counterparty: managementNode(row.counterparty), access: row.access,
        ...(typeof row.counterpartyProfile?.update === 'string' && { update: row.counterpartyProfile.update }),
        ...(typeof row.presence === 'string' && { presence: row.presence }) };
    }) };
  }
  async connectionRequests(handle, cursor, { signal } = {}) {
    const query = new URLSearchParams({ limit: '100', ...(handle && { counterparty: handle }), ...(cursor !== undefined && { cursor }) });
    const value = record(await this.request(`me/connection-requests?${query}`, undefined, { method: 'GET', signal }));
    if (!Array.isArray(value.items) || value.items.length > 100 || (value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor || value.nextCursor.length > 4096))) throw new Refusal('connection_page_unreadable');
    return { items: value.items.map(managementRequest), nextCursor: value.nextCursor };
  }
  createConnectionRequest(body, { signal } = {}) { return this.request('me/connection-requests', body, { signal }); }
  async connectionOperation(id, { signal } = {}) {
    return managementOperation(await this.request(`me/connection-operations/${encodeURIComponent(id)}`, undefined, { method: 'GET', signal }), id);
  }
  async decideConnectionRequest(id, action, { signal } = {}) {
    if (!['accept', 'ignore', 'withdraw'].includes(action)) throw new Refusal('connection_action_invalid');
    const value = record(await this.request(`me/connection-requests/${encodeURIComponent(id)}/${action}`, undefined, { signal }));
    return managementRequest(value.request);
  }
  async readProfile({ signal } = {}) { return managementProfile(await this.request('runtime/icm-profile', undefined, { method: 'GET', signal })); }
  async patchProfile(body, { signal } = {}) { return managementProfile(await this.request('runtime/icm-profile', body, { method: 'PATCH', signal })); }

  async identity() {
    const identity = record(await this.request('me/identity', undefined, { method: 'GET' }));
    const principal = record(await this.request('whoami', undefined, { method: 'GET' }));
    if (principal.subjectType !== 'agent-runtime' || principal.carrier !== 'runtime-api-key' || principal.subjectId !== this.credential.node) throw new Refusal('link_principal_mismatch');
    const node = record(identity.node);
    return { node: this.credential.node, handle: text(node.handle), address: text(node.mstpAddress) };
  }

  async ensure(intent, { startedAt } = {}) {
    instant(startedAt);
    const value = record(await this.request('runtime-endpoints/ensure', intent, { headers: { 'x-registration-started-at': startedAt } }));
    if (value.node_id !== this.credential.node || !['active', 'retired', 'superseded', 'expired'].includes(value.registration_outcome)) throw new Refusal('registration_answer_unreadable');
    if (value.registration_outcome === 'expired')
      throw Object.assign(new Refusal('registration_expired'), { registration: { node_id: value.node_id, registration_outcome: 'expired' } });
    text(value.endpoint_id); instant(value.registered_at);
    const expected = Object.fromEntries(['runtime_capabilities', 'execution_surface', 'background_exchange_mode', 'natural_boundary_presentation_contract_id', 'node_recipient_admission_contract_id'].filter((key) => intent[key] !== undefined).map((key) => [key, intent[key]]));
    if (!declarationMatches(value, expected)) throw new Refusal('registration_declaration_mismatch');
    if (value.registration_outcome !== 'active') throw Object.assign(new Refusal(`registration_${value.registration_outcome}`), { registration: value });
    return namingFacts(value);
  }

  async owned(session, { signal } = {}) {
    const ep = endpoint(session, { retained: true });
    const value = record(await this.request(`runtime-endpoints/${encodeURIComponent(ep.endpoint_id)}?as=${encodeURIComponent(this.credential.node)}`, undefined,
      { method: 'GET', headers: { 'X-Endpoint-Nonce': ep.endpoint_nonce }, signal }));
    if (value.endpoint_id !== ep.endpoint_id || value.node_id !== this.credential.node || value.runtime_session_id !== session.root ||
        value.runtime_kind !== 'oh-my-pi' || value.is_self !== true) throw new Refusal('registration_inactive');
    if (Object.hasOwn(value, 'superseded_by_endpoint_id')) {
      text(value.superseded_by_endpoint_id, 'registration_answer_unreadable');
      throw Object.assign(new Refusal('registration_superseded'), { registration: value });
    }
    if (Object.hasOwn(value, 'retired_at')) {
      instant(value.retired_at);
      throw Object.assign(new Refusal('registration_retired'), { registration: value });
    }
    if (!declarationMatches(value, session.declaration)) throw new Refusal('registration_declaration_mismatch');
    return namingFacts(value);
  }

  async receipt(session, item) {
    const ep = endpoint(session);
    if (ep.endpoint_id !== item.endpoint || ep.endpoint_nonce !== item.nonce) throw new Refusal('receipt_registration_changed');
    if (!['delivered', 'presented'].includes(item.act)) throw new Refusal('receipt_act_unknown');
    return this.request('runtime/receipts', { ...ep, act: item.act, items: [{ message_ref: text(item.message), content_digest: text(item.digest) }] }, { expected: 204 });
  }

  async resolve(session, query, continuation, { signal } = {}) {
    const page = record(await this.request('runtime/member-send', { type: 'list_runtime_session_targets', version: 3, ...endpoint(session), query,
      ...(continuation !== undefined && { continuation }) }, { signal }));
    const source = record(page.acting_source);
    if (page.contract_version !== 3 || source.kind !== 'exact_session') throw new Refusal('target_page_unreadable');
    text(source.session_ref);
    const echo = record(page.query);
    if (echo.kind !== query.kind) throw new Refusal('target_query_mismatch');
    if (query.kind === 'node_match') {
      if (page.status !== 'runtime_node_target_resolution' || echo.match !== 'canonical_handle_exact' || echo.handle !== query.match.handle ||
          !['zero', 'one'].includes(page.outcome) || !Array.isArray(page.nodes) || page.nodes.length !== (page.outcome === 'one' ? 1 : 0)) throw new Refusal('target_node_resolution_unreadable');
    } else if (query.kind === 'node_sessions') {
      if (echo.node_ref !== query.node_ref || record(page.node).node_ref !== query.node_ref || !Array.isArray(page.sessions)) throw new Refusal('target_session_resolution_unreadable');
      if (query.match) {
        if (page.status !== 'runtime_node_session_target_resolution' || echo.match !== 'approved_display_exact' || echo.label !== query.match.label ||
            echo.pick_code !== query.match.pick_code || !['not_applicable', 'zero', 'one', 'many'].includes(page.outcome)) throw new Refusal('target_session_resolution_unreadable');
        if ((page.outcome === 'one' && page.sessions.length !== 1) || (['zero', 'not_applicable'].includes(page.outcome) && page.sessions.length !== 0) ||
            (page.outcome === 'many' && page.sessions.length < 2)) throw new Refusal('target_session_count_mismatch');
      } else if (page.status !== 'runtime_node_session_target_page') throw new Refusal('target_session_page_unknown');
      for (const row of page.sessions) { text(row.target_ref); text(record(row.display).label); if (query.match) text(row.display.name); }
      if (page.sessions.length > 12 || new Set(page.sessions.map((row) => row.target_ref)).size !== page.sessions.length) throw new Refusal('target_session_count_mismatch');
    } else if (query.kind !== 'browse_nodes' || page.status !== 'runtime_node_target_page' || !Array.isArray(page.nodes)) throw new Refusal('target_page_unknown');
    if (page.nodes) {
      if (page.nodes.length > 12) throw new Refusal('target_page_unreadable');
      for (const row of page.nodes) { text(row.node_ref); text(record(row.display).label); }
    }
    return page;
  }

  async conversations(session, continuation) {
    return record(await this.request('runtime/session-conversations', { type: 'runtime_session_conversations', version: 1, ...endpoint(session), limit: 20,
      ...(continuation !== undefined && { continuation_ref: continuation }) }));
  }

  async history(session, lookup, continuation) {
    return record(await this.request('runtime/session-conversation-history', { type: 'runtime_session_conversation_history', version: 2, ...endpoint(session), ...lookup, limit: 5,
      ...(continuation !== undefined && { continuation_ref: continuation }) }));
  }

  async send(session, id, intent, { signal } = {}) {
    const raw = await this.request('messages', { ...intent, ...endpoint(session), send_request_id: text(id) }, { headers: { Accept: SEND_MEDIA, 'Content-Type': SEND_MEDIA }, signal });
    const result = parseSendOutcome(raw);
    if (result.subject && result.subject.self_participant_ref !== intent.acting_source?.session_ref) throw new Refusal('send_outcome_source_mismatch');
    if (intent.requested_conversation_ref && result.subject?.conversation_ref !== intent.requested_conversation_ref) throw new Refusal('send_outcome_conversation_mismatch');
    return result;
  }

  async outcome(session, path) {
    if (!/^(messages|sending-attempts)\/[^/?#]+$/.test(path)) throw new Refusal('outcome_path_invalid');
    const ep = endpoint(session);
    const result = parseSendOutcome(await this.request(`${path}/outcome?version=2`, undefined,
      { method: 'GET', headers: { Accept: SEND_MEDIA, 'X-Endpoint-Id': ep.endpoint_id, 'X-Endpoint-Nonce': ep.endpoint_nonce } }));
    let resource;
    try { resource = decodeURIComponent(path.slice(path.indexOf('/') + 1)); } catch { throw new Refusal('outcome_path_invalid'); }
    const key = path.startsWith('messages/') ? 'message_ref' : 'attempt_ref';
    if ((key === 'message_ref' || result.attempt_ref) && result[key] !== resource) throw new Refusal('outcome_resource_mismatch');
    return result;
  }

  retire(session) {
    return this.request(`runtime-endpoints/${encodeURIComponent(endpoint(session, { retained: true }).endpoint_id)}?as=${encodeURIComponent(this.credential.node)}`, undefined, { method: 'DELETE' });
  }

  controlAck(id) {
    return this.request('runtime/control-ack', { idempotency_key: text(id), status: 'applied' });
  }

  stream(onFrame, { signal, onOpen = () => {} } = {}) {
    this.assertCurrent(); text(this.credential.token, 'link_required'); text(this.credential.node, 'link_required');
    if (signal?.aborted) return Promise.resolve();
    const url = new URL(`${this.api}/v1/runtime/control-events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('agent_id', this.credential.node);
    return new Promise((resolve, reject) => {
      let socket, stopped = false, opened = false, timer, chain = Promise.resolve(), pendingBytes = 0, pendingFrames = 0;
      const finish = (error) => {
        if (stopped) return;
        stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        try { socket?.close(); } catch { /* The connection is already unusable. */ }
        if (error) reject(error instanceof Refusal ? error : new Refusal('stream_consumer_failed')); else resolve();
      };
      // Bun answers WebSocket protocol pings without emitting a data message.
      // Services owns the heartbeat deadline; message idleness is not a failure.
      const arm = (ms) => { timer = setTimeout(() => finish(new Refusal('stream_open_timeout')), ms); timer.unref?.(); };
      const abort = () => finish();
      signal?.addEventListener('abort', abort, { once: true });
      try { socket = this.createSocket(url.href, { headers: { Authorization: `Bearer ${this.credential.token}` } }); }
      catch { finish(new Refusal('stream_open_failed')); return; }
      arm(this.requestTimeoutMs);
      socket.addEventListener('open', () => {
        if (stopped) return;
        opened = true; clearTimeout(timer);
        chain = chain.then(() => { this.assertCurrent(); return onOpen(); }).catch(finish);
      });
      socket.addEventListener('message', (event) => {
        if (stopped) return;
        if (!opened || typeof event.data !== 'string' || !event.data.isWellFormed()) { finish(new Refusal('stream_unreadable')); return; }
        const bytes = Buffer.byteLength(event.data, 'utf8');
        pendingBytes += bytes; pendingFrames++;
        if (bytes > MAX_FRAME_BYTES || pendingBytes > MAX_FRAME_BYTES || pendingFrames > 256) { finish(new Refusal('stream_backlog_exceeded')); return; }
        chain = chain.then(async () => {
          if (stopped) return;
          this.assertCurrent();
          let raw;
          try { raw = JSON.parse(event.data); } catch { throw new Refusal('stream_unreadable'); }
          record(raw, 'stream_unreadable');
          const known = ['message', 'caught_up', 'typing', 'force_unregister', 'registration_retired', 'session_name_changed', 'session_resume'];
          if (['force_unregister', 'registration_retired', 'session_name_changed', 'session_resume'].includes(raw.type)) {
            if (raw.version !== 1 || !Number.isFinite(raw.emitted_at)) throw new Refusal('stream_control_unreadable');
            text(raw.idempotency_key, 'stream_control_unreadable');
            text(raw.type === 'session_resume' ? raw.runtime_session_id : raw.endpoint_id, 'stream_control_unreadable');
          }
          if (raw.type === 'caught_up' || raw.type === 'typing') text(raw.endpoint_id, 'stream_frame_unreadable');
          if (raw.type === 'typing') text(raw.conversation_ref, 'stream_frame_unreadable');
          if (known.includes(raw.type)) await onFrame(raw.type === 'message' ? parseMessage(raw) : raw);

          this.assertCurrent();
        }).catch(finish).finally(() => { pendingBytes -= bytes; pendingFrames--; });
      });
      socket.addEventListener('error', () => finish(new Refusal('stream_error')));
      socket.addEventListener('close', (event) => finish(signal?.aborted ? undefined : new Refusal(event.code === 1008 ? 'credential_ended' : 'stream_closed', event.code === 1008 ? 401 : undefined)));
    });
  }
}

export function managementNode(value, { requireHandle = true } = {}) {
  record(value);
  if (value.tombstone !== undefined && typeof value.tombstone !== 'boolean') throw new Refusal('connection_node_unreadable');
  if (value.tombstone === true) return { tombstone: true };
  const address = text(value.mstpAddress), url = new URL(address);
  if (url.protocol !== 'mstps:' || url.username || url.password || url.search || url.hash) throw new Refusal('connection_node_unreadable');
  const handle = value.handle, readableHandle = typeof handle === 'string' && /^[a-z0-9][a-z0-9_-]{1,63}$/u.test(handle);
  if (requireHandle && !readableHandle) throw new Refusal('connection_node_unreadable');
  return { kind: text(value.kind), ...(readableHandle && { handle }), mstpAddress: address,
    ...(typeof value.displayName === 'string' && { displayName: value.displayName }) };
}
export function managementRequest(value) {
  record(value);
  if (!['awaiting-your-decision', 'awaiting-counterparty', 'accepted', 'ignored', 'withdrawn'].includes(value.status) ||
      (value.shadowed !== undefined && typeof value.shadowed !== 'boolean')) throw new Refusal('connection_request_unreadable');
  const createdAt = optionalInstant(value.createdAt), resolvedAt = optionalInstant(value.resolvedAt);
  const row = { id: text(value.id), counterparty: managementNode(value.counterparty), status: value.status,
    ...(createdAt && { createdAt }), ...(resolvedAt && { resolvedAt }), shadowed: value.shadowed === true };
  if (value.initialNote !== undefined) {
    try {
      const note = record(value.initialNote);
      if (typeof note.text !== 'string' || !note.text || !note.text.isWellFormed() || Array.from(note.text).length > 300) throw new Refusal('connection_note_unreadable');
      const author = managementNode(note.author, { requireHandle: false }), noteTime = optionalInstant(note.createdAt);
      row.initialNote = { author, text: note.text, ...(noteTime && { createdAt: noteTime }) };
    } catch { row.initialNote = { status: 'unreadable' }; }
  }
  return row;
}
export function managementOperation(value, id) {
  record(value); const operation = record(value.operation);
  if (operation.id !== id || !['admitted', 'completed', 'superseded'].includes(operation.state) ||
      (operation.revision !== undefined && (!Number.isSafeInteger(operation.revision) || operation.revision < 0))) throw new Refusal('connection_operation_unreadable');
  const answer = { operation: { id, state: operation.state, ...(operation.revision !== undefined && { revision: operation.revision }) } };
  if (operation.state === 'completed') {
    const result = record(value.result);
    if (!['created', 'existing', 'crossing-accepted', 'policy-accepted', 'already_connected'].includes(result.outcome)) throw new Refusal('connection_operation_unreadable');
    answer.result = { outcome: result.outcome, ...(result.outcome === 'already_connected' ? { counterparty: managementNode(result.counterparty) } : { request: managementRequest(result.request) }) };
    if (result.note_status !== undefined) {
      if (!['saved', 'not_added'].includes(result.note_status)) throw new Refusal('connection_operation_unreadable');
      answer.result.note_status = result.note_status;
    }
  }
  return answer;
}
export function managementProfile(value) {
  record(value); const card = record(value.profile), revision = text(value.profileRevision);
  if (revision.length > 128 || typeof card.displayName !== 'string' || !card.displayName ||
      (card.update !== null && typeof card.update !== 'string') || (card.avatarUrl !== null && typeof card.avatarUrl !== 'string')) throw new Refusal('profile_answer_unreadable');
  const node = managementNode({ kind: card.kind, handle: card.handle, mstpAddress: card.canonicalAddress });
  return { profileRevision: revision, profile: { kind: node.kind, handle: node.handle, canonicalAddress: node.mstpAddress, displayName: card.displayName, update: card.update, avatarUrl: card.avatarUrl } };
}
