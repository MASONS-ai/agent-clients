import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fault, fingerprint } from './store.mjs';
import { directoryRoom, dispatchAnswer, publicParty } from './services.mjs';

const own = (v, k) => Object.hasOwn(v, k);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const ref = (v) => typeof v === 'string' && v.length > 0 && v.length <= 8192 && v.isWellFormed();
const hash = (v) => fingerprint(JSON.stringify(v));
const terminal = (error) => error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
const handle = (v) => {
  if (typeof v !== 'string' || !/^@?[a-z][a-z0-9_-]{2,14}$/iu.test(v)) throw fault('canonical_handle_required');
  return v.replace(/^@/u, '').toLowerCase();
};
const targetView = (row) => ({ ...Object.fromEntries(['name', 'label', 'host_label'].filter((k) => typeof row.display?.[k] === 'string' && row.display[k].trim() && row.display[k].isWellFormed()).map((k) => [k, row.display[k]])),
  ...(/^[a-f0-9]{6}$/u.test(row.pick_code ?? '') && { pick_code: row.pick_code }) });
const partyName = (party) => {
  const node = party.kind === 'session' ? party.parent_node : party.node, h = party.handle ?? node?.handle;
  if (!h) return undefined;
  return party.kind === 'node' ? '@' + h : party.name && !party.unresolved ? `${party.name}@${h}${party.pick_code ? ` [${party.pick_code}]` : ''}` : undefined;
};
const roomView = (row) => ({ ...(partyName(row.party) && { party: partyName(row.party) }), participant: publicParty(row.party),
  ...(row.last_message && { preview: row.last_message }), ...(row.pending_root_count !== undefined && { pending_messages: row.pending_root_count }),
  ...(row.arrived_at && { arrived_at: row.arrived_at }) });
function argsFor(tool, input) {
  const discovery = tool === 'discovery', keys = discovery ? ['action', 'q', 'to', 'session', 'pick_code', 'limit', 'more'] : ['action', 'party', 'session', 'pick_code', 'more'];
  if (!object(input) || Object.keys(input).some((k) => !keys.includes(k)) || !(discovery ? ['nodes', 'agents', 'resolve', 'sessions'] : ['list', 'select']).includes(input.action)) throw fault('directory_arguments_invalid');
  const args = { ...input };
  if (args.more !== undefined && typeof args.more !== 'boolean') throw fault('directory_arguments_invalid');
  if (args.session !== undefined && (!ref(args.session) || args.session !== args.session.trim() || args.session.length > 256)) throw fault('session_name_required');
  if (args.pick_code !== undefined && (args.session === undefined || !/^[a-f0-9]{6}$/u.test(args.pick_code))) throw fault('session_pick_code_invalid');
  const allowed = discovery ? ['nodes', 'agents'].includes(args.action) ? ['action', 'q', 'limit'] : args.action === 'resolve' ? ['action', 'to'] : ['action', 'to', 'session', 'pick_code', 'more'] : args.action === 'list' ? ['action', 'more'] : ['action', 'party', 'session', 'pick_code'];
  if (Object.keys(args).some((k) => !allowed.includes(k))) throw fault('directory_arguments_invalid');
  if (discovery && ['nodes', 'agents'].includes(args.action)) {
    if (typeof args.q !== 'string' || !args.q.isWellFormed()) throw fault('search_query_invalid');
    args.q = args.q.trim();
    if (args.action === 'nodes') {
      args.q = args.q.replace(/^@/u, '').trim();
      if (args.q.startsWith('@') || Array.from(args.q).length > 40) throw fault('search_query_invalid');
    }
    args.limit ??= 10;
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 50) throw fault('search_limit_invalid');
  }
  if (discovery && ['resolve', 'sessions'].includes(args.action)) args.to = handle(args.to);
  if (!discovery && args.action === 'select' && !ref(args.party)) throw fault('room_party_required');
  return args;
}
function state(value, client) {
  if (!object(value) || value.version !== 1 || !ref(value.epoch) || !Array.isArray(value.calls) || !Array.isArray(value.operations) || !own(value, 'rooms') || !own(value, 'sessions')) throw fault('directory_state_unreadable');
  const ids = new Set();
  for (const call of value.calls) {
    if (!object(call) || !ref(call.id) || ids.has(call.id) || !ref(call.epoch) || !['discovery', 'rooms'].includes(call.tool) || hash({ tool: call.tool, args: argsFor(call.tool, call.args) }) !== call.digest) throw fault('directory_state_unreadable');
    ids.add(call.id);
  }
  for (const call of value.calls) {
    for (const key of ['blockedBy', 'forward']) if (call[key] !== undefined && (!ref(call[key]) || !value.operations.some((op) => op.callId === call[key] && call.id !== op.callId && call.tool === 'rooms' && call.args.action === 'select' && call.args.party === op.args?.party && (key !== 'forward' || isDeepStrictEqual(call.args, op.args))))) throw fault('directory_state_unreadable');
  }
  if (value.rooms !== null) {
    const r = value.rooms;
    if (!object(r) || r.epoch !== value.epoch || !Array.isArray(r.rows) || !Number.isSafeInteger(r.offset) || r.offset < 0 || r.offset > r.rows.length || !ref(r.registration)) throw fault('directory_state_unreadable');
    r.rows.forEach(directoryRoom);
  }
  if (value.sessions !== null) {
    const s = value.sessions;
    if (!object(s) || s.epoch !== value.epoch || !object(s.query) || !object(s.source) || !object(s.traversal) || !Array.isArray(s.cursors) || !Array.isArray(s.seen) || !ref(s.registration)) throw fault('directory_state_unreadable');
  }
  const ops = new Set();
  for (const op of value.operations) {
    const call = value.calls.find((c) => c.id === op?.callId);
    if (!object(op) || !call || call.tool !== 'rooms' || call.args.action !== 'select' || ops.has(op.callId) || op.digest !== call.digest || !object(op.scope) ||
        op.scope.root !== client.root || op.scope.credential !== fingerprint(client.credential) || op.scope.epoch !== call.epoch ||
        !['pending', 'confirmed', 'refused'].includes(op.state) || !object(op.body) || !ref(op.body.wait_ref) || !ref(op.body.endpoint_id) || !ref(op.body.endpoint_nonce) ||
        !ref(op.body.idempotency_key) || op.body.idempotency_key.includes(':') || Object.keys(op.body).some((k) => !['wait_ref', 'endpoint_id', 'endpoint_nonce', 'idempotency_key', 'target_selection_ref'].includes(k)) ||
        (op.body.target_selection_ref !== undefined && !ref(op.body.target_selection_ref)) || op.registration !== hash({ endpoint: op.body.endpoint_id, nonce: op.body.endpoint_nonce }) || op.args.party !== call.args.party || !isDeepStrictEqual(op.args, call.args)) throw fault('directory_state_unreadable');
    if (op.state === 'confirmed') dispatchAnswer(op.response, op.body.idempotency_key);
    if (op.state === 'refused' && !ref(op.refusal)) throw fault('directory_state_unreadable');
    ops.add(op.callId);
  }
  return value;
}

export class Directory {
  constructor(client) { this.client = client; this.epoch = randomUUID(); this.tail = Promise.resolve(); }
  initialize() {
    this.client.update((data) => {
      const v = own(data, 'directory') ? state(data.directory, this.client) : { version: 1, epoch: this.epoch, calls: [], operations: [], rooms: null, sessions: null };
      v.epoch = this.epoch; v.rooms = null; v.sessions = null; data.directory = v; return data;
    });
  }
  state() { return state(this.client.read().directory, this.client); }
  change(run) { this.client.update((data) => { run(state(data.directory, this.client)); return data; }); }
  guard(signal) { this.client.assert(); if (signal?.aborted) throw fault('native_call_cancelled'); }
  registration(held) { return hash({ endpoint: held.response?.endpoint_id, nonce: held.nonce }); }
  check(held, signal) { this.guard(signal); if (this.registration(this.client.read().registration) !== this.registration(held)) throw fault('directory_registration_changed'); }
  call(tool, input, id, signal) {
    const run = () => this.perform(tool, input, id, signal), result = this.tail.then(run, run);
    this.tail = result.catch(() => {}); return result;
  }
  async perform(tool, input, id, signal) {
    this.guard(signal); const args = argsFor(tool, input), digest = hash({ tool, args });
    if (!ref(id)) throw fault('native_call_id_required');
    let previous = this.state().calls.find((c) => c.id === id);
    if (previous && previous.digest !== digest) throw fault('native_call_arguments_changed');
    if (!previous) { previous = { id, digest, tool, args, epoch: this.epoch }; this.change((s) => s.calls.push(previous)); }
    const retained = this.state().operations.find((op) => op.callId === id);
    if (retained) return this.dispatch(retained, signal, true);
    if (previous.forward) return this.dispatch(this.state().operations.find((op) => op.callId === previous.forward), signal, true);
    if (previous.blockedBy) {
      const original = this.state().operations.find((op) => op.callId === previous.blockedBy);
      return original.state === 'confirmed' ? this.dispatchView(original, { retained_original_operation: true }) : original.state === 'refused' ? { error: original.refusal, retry: false } : { status: 'unconfirmed', selection: 'retained_original_room', retry: false };
    }
    if (previous.epoch !== this.epoch) throw fault('native_binding_changed');
    if (tool === 'discovery') return this.discovery(args, signal);
    if (args.action === 'list') {
      if (!args.more) {
        this.change((s) => { s.rooms = null; });
        const held = await this.client.authority({ signal }); this.check(held, signal);
        const rows = await this.readRooms(held, signal); this.check(held, signal);
        this.change((s) => { s.rooms = { epoch: this.epoch, rows, offset: 0, registration: this.registration(held) }; });
      }
      const selection = this.state().rooms;
      if (!selection || selection.epoch !== this.epoch || selection.registration !== this.registration(this.client.read().registration) || (args.more && selection.offset === selection.rows.length)) throw fault('room_continuation_unavailable');
      const rows = selection.rows.slice(selection.offset, selection.offset + 20);
      this.change((s) => { s.rooms.offset += rows.length; });
      return { rooms: rows.map(roomView), more: this.state().rooms.offset < selection.rows.length, list: 'snapshot' };
    }
    const unresolved = this.state().operations.find((op) => op.state === 'pending' && op.args.party === args.party);
    if (unresolved) {
      const sameArgs = isDeepStrictEqual(args, unresolved.args);
      this.change((s) => { s.calls.find((c) => c.id === id)[sameArgs ? 'forward' : 'blockedBy'] = unresolved.callId; });
      if (sameArgs) return this.dispatch(unresolved, signal, true);
      return { status: 'unconfirmed', selection: 'retained_original_room', retry: false };
    }
    const selection = this.state().rooms;
    if (!selection || selection.offset !== selection.rows.length || selection.epoch !== this.epoch) throw fault('complete_room_read_required');
    const candidates = selection.rows.filter((row) => partyName(row.party) === args.party);
    if (candidates.length !== 1) throw fault('room_selection_required');
    const held = await this.client.authority({ signal }); this.check(held, signal);
    if (selection.registration !== this.registration(held)) throw fault('directory_registration_changed');
    let target;
    if (args.session) {
      const result = await this.sessionQuery({ action: 'sessions', to: this.client.identity.handle, session: args.session, ...(args.pick_code && { pick_code: args.pick_code }) }, held, signal);
      if (result.outcome !== 'one') return { status: 'selection_required', outcome: result.outcome, sessions: result.sessions.map(targetView) };
      target = result.sessions[0].target_ref;
    }
    this.check(held, signal);
    const op = { callId: id, digest, args, scope: { root: this.client.root, credential: fingerprint(this.client.credential), epoch: this.epoch }, registration: this.registration(held), state: 'pending',
      body: { wait_ref: candidates[0].wait_ref, ...(target && { target_selection_ref: target }), endpoint_id: held.response.endpoint_id, endpoint_nonce: held.nonce, idempotency_key: randomUUID() } };
    this.change((s) => { s.operations.push(op); s.rooms = null; });
    return this.dispatch(op, signal, false);
  }
  async readRooms(held, signal) {
    for (let restart = 0; restart < 3; restart++) {
      const rows = [], ids = new Set(), cursors = new Set(); let cursor;
      try {
        for (let page = 0; page < 64; page++) {
          this.check(held, signal); const value = await this.client.api.vacantRooms(cursor, { signal }); this.check(held, signal);
          for (const row of value.items) { if (ids.has(row.wait_ref)) throw fault('room_pagination_inconsistent'); ids.add(row.wait_ref); rows.push(row); }
          if (value.continuation_ref === undefined) return rows;
          if (cursors.has(value.continuation_ref)) throw fault('room_cursor_cycle');
          cursors.add(value.continuation_ref); cursor = value.continuation_ref;
        }
        throw fault('room_page_budget_exceeded');
      } catch (error) { if (error.code !== 'snapshot_restart_required') throw error; }
    }
    throw fault('room_snapshot_unavailable');
  }
  async dispatch(op, signal, replay) {
    this.guard(signal);
    const extra = op.scope.epoch !== this.epoch ? { retained_previous_binding: true } : {};
    if (op.state === 'refused') return { error: op.refusal, retry: false, ...extra };
    if (op.state === 'confirmed') return this.dispatchView(op, extra);
    const held = await this.client.authority({ signal }); this.check(held, signal);
    if (this.registration(held) !== op.registration || held.response.endpoint_id !== op.body.endpoint_id || held.nonce !== op.body.endpoint_nonce) return { status: 'unconfirmed', reason: 'original_registration_unavailable', retry: false, ...extra };
    try {
      const response = await this.client.api.dispatchRoom(op.body, { signal }); this.check(held, signal);
      this.change((s) => { const current = s.operations.find((v) => v.callId === op.callId); current.response = response; current.state = 'confirmed'; });
      return this.dispatchView({ ...op, state: 'confirmed', response }, extra);
    } catch (error) {
      this.guard(signal);
      if (!replay && terminal(error)) { this.change((s) => { const current = s.operations.find((v) => v.callId === op.callId); current.state = 'refused'; current.refusal = error.code; }); return { error: error.code, retry: false }; }
      return { status: 'unconfirmed', retry: false, ...extra };
    }
  }
  dispatchView(op, extra) { return { status: 'selected', party: op.args.party, target: op.args.session ? { session: op.args.session, ...(op.args.pick_code && { pick_code: op.args.pick_code }) } : 'calling_session',
    selection: op.response.accepted ? 'accepted' : 'original_selection_confirmed', ...(op.response.resume && { resume: op.response.resume }), reception: 'not_proven', ...extra }; }
  async sessionQuery(args, held, signal) {
    const node = await this.client.api.resolve(held, { kind: 'node_match', match: { kind: 'canonical_handle_exact', handle: args.to } }, undefined, { signal }); this.check(held, signal);
    if (node.outcome !== 'one') return { outcome: 'zero', sessions: [] };
    const query = { kind: 'node_sessions', node_ref: node.nodes[0].node_ref, ...(args.session && { match: { kind: 'approved_display_exact', label: args.session, ...(args.pick_code && { pick_code: args.pick_code }) } }) };
    const page = await this.client.api.resolve(held, query, undefined, { signal }); this.check(held, signal);
    if (!isDeepStrictEqual(page.acting_source, node.acting_source)) throw fault('target_source_mismatch');
    if (!['exact_sessions_complete', 'exact_sessions_not_applicable'].includes(page.node?.coverage) ||
        (page.node.coverage === 'exact_sessions_not_applicable' && (page.sessions.length !== 0 || (page.outcome !== undefined && page.outcome !== 'not_applicable')))) throw fault('target_disclosure_unreadable');
    for (const row of page.sessions) if (!/^[a-f0-9]{6}$/u.test(row.pick_code ?? '')) throw fault('target_disclosure_unreadable');
    return { ...page, query, source: node.acting_source };
  }
  async discovery(args, signal) {
    if (['nodes', 'agents'].includes(args.action)) {
      const result = await this.client.api.discoverNodes(args.action, args.q, args.limit, { signal }); this.guard(signal); return result;
    }
    if (args.action === 'resolve') { const result = await this.client.api.resolveNode(args.to, { signal }); this.guard(signal); return result; }
    const held = await this.client.authority({ signal }); this.check(held, signal);
    if (args.more && args.session) throw fault('session_continuation_unavailable');
    let page, original;
    if (args.more) {
      original = this.state().sessions;
      if (!original || original.to !== args.to || original.registration !== this.registration(held) || original.traversal.complete) throw fault('session_continuation_unavailable');
      page = await this.client.api.resolve(held, original.query, original.traversal.continuation, { signal }); this.check(held, signal);
      if (!isDeepStrictEqual(page.acting_source, original.source)) throw fault('target_source_mismatch');
      if (page.node?.coverage !== 'exact_sessions_complete' || page.sessions.some((r) => !/^[a-f0-9]{6}$/u.test(r.pick_code ?? ''))) throw fault('target_disclosure_unreadable');
    } else {
      this.change((s) => { s.sessions = null; });
      page = await this.sessionQuery(args, held, signal);
      if (page.outcome !== undefined) {
        this.change((s) => { s.sessions = { epoch: this.epoch, to: args.to, query: page.query ?? {}, source: page.source ?? {}, traversal: { complete: true },
          registration: this.registration(held), cursors: [], seen: page.sessions.map((r) => r.target_ref), rows: page.sessions }; });
        return { to: '@' + args.to, outcome: page.outcome, sessions: page.sessions.map(targetView) };
      }
    }
    const t = page.traversal;
    if (!object(t) || !ref(t.traversal_ref) || !Number.isSafeInteger(t.page) || t.page !== (original?.traversal.page ?? 0) + 1 || t.page_bound !== 12 || t.entry_count !== page.sessions.length || t.choice_count !== page.sessions.length || typeof t.complete !== 'boolean' || t.complete === own(t, 'continuation') ||
        (original && t.traversal_ref !== original.traversal.traversal_ref) || typeof t.expires_at !== 'string' || !Number.isFinite(Date.parse(t.expires_at)) || new Date(t.expires_at).toISOString() !== t.expires_at) throw fault('session_traversal_unreadable');
    const cursors = original?.cursors ?? [], seen = original?.seen ?? [];
    if ((!t.complete && (!ref(t.continuation) || cursors.includes(t.continuation))) || page.sessions.some((r) => seen.includes(r.target_ref))) throw fault('session_cursor_cycle');
    this.change((s) => { s.sessions = { epoch: this.epoch, to: args.to, query: page.query ?? original.query, source: page.source ?? original.source, traversal: t,
      registration: this.registration(held), cursors: [...cursors, ...(!t.complete ? [t.continuation] : [])], seen: [...seen, ...page.sessions.map((r) => r.target_ref)], rows: [...(original?.rows ?? []), ...page.sessions] }; });
    return { to: '@' + args.to, sessions: page.sessions.map(targetView), more: !t.complete };
  }
}
