import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fault, fingerprint } from './store.mjs';
import { managementNode, managementRequest, managementOperation, managementProfile } from './services.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const ref = (v) => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const hash = (v) => fingerprint(JSON.stringify(v));
const knownRefusal = (error) => error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
const handle = (value) => {
  if (typeof value !== 'string' || !/^@?[a-z0-9][a-z0-9_-]{1,63}$/iu.test(value)) throw fault('canonical_handle_required');
  return value.replace(/^@/u, '').toLowerCase();
};
const actions = (row) => row.shadowed || row.counterparty.tombstone ? [] : row.status === 'awaiting-your-decision' ? ['accept', 'ignore'] : row.status === 'awaiting-counterparty' ? ['withdraw'] : [];
const nodeView = (node) => node.tombstone ? { tombstone: true } : { kind: node.kind, handle: node.handle, address: node.mstpAddress,
  ...(node.displayName !== undefined && { display_name: node.displayName }) };
const requestView = (value) => {
  const row = managementRequest(value);
  return { counterparty: nodeView(row.counterparty), ...(!row.counterparty.tombstone && { with: '@' + row.counterparty.handle }),
    status: row.status, ...(row.createdAt && { created_at: row.createdAt }), ...(row.resolvedAt && { resolved_at: row.resolvedAt }),
    ...(row.shadowed && { shadowed: true }), actions: actions(row),
    ...(row.initialNote && { initial_note: row.initialNote.status === 'unreadable' ? { status: 'unreadable' } : {
      ...(row.initialNote.author.tombstone ? { author_tombstone: true } : { author: nodeView(row.initialNote.author) }),
      text: row.initialNote.text, ...(row.initialNote.createdAt && { created_at: row.initialNote.createdAt }) } }) };
};
const profileView = (value) => ({ ...nodeView({ ...value.profile, mstpAddress: value.profile.canonicalAddress }), display_name: value.profile.displayName, update: value.profile.update, avatar_url: value.profile.avatarUrl });
const draftView = (value) => ({ display_name: value.profile.displayName, update: value.profile.update, avatar: 'keep' });
function connectionArgs(input) {
  if (!object(input) || !['list', 'list_requests', 'request', 'accept', 'ignore', 'withdraw'].includes(input.action) ||
      Object.keys(input).some((key) => !['action', 'with', 'note', 'more'].includes(key))) throw fault('connections_arguments_invalid');
  const read = ['list', 'list_requests'].includes(input.action);
  if ((input.action === 'list' && (input.with !== undefined || input.more !== undefined)) ||
      (!read && (input.with === undefined || input.more !== undefined)) ||
      (input.note !== undefined && input.action !== 'request') ||
      (input.more !== undefined && typeof input.more !== 'boolean')) throw fault('connections_arguments_invalid');
  let note;
  if (input.note !== undefined) {
    if (typeof input.note !== 'string' || !input.note.isWellFormed() || Array.from(input.note.trim()).length > 300) throw fault('connection_note_invalid');
    note = input.note.trim() || undefined;
  }
  return { action: input.action, ...(input.with !== undefined && { with: handle(input.with) }),
    ...(note !== undefined && { note }), ...(input.action === 'list_requests' && { more: input.more === true }) };
}
function profileArgs(input) {
  if (!object(input) || !['inspect', 'update'].includes(input.action) || Object.keys(input).some((k) => !['action', 'draft'].includes(k))) throw fault('profile_arguments_invalid');
  if (input.action === 'inspect') { if (input.draft !== undefined) throw fault('profile_arguments_invalid'); return { action: 'inspect' }; }
  const d = input.draft;
  if (!object(d) || Object.keys(d).sort().join(',') !== 'avatar,display_name,update' || typeof d.display_name !== 'string' ||
      !d.display_name.isWellFormed() || !d.display_name.trim() || Array.from(d.display_name.trim()).length > 40 ||
      (d.update !== null && typeof d.update !== 'string') || !['keep', 'remove'].includes(d.avatar)) throw fault('profile_draft_invalid');
  const update = d.update?.trim() || null;
  if (update && (!update.isWellFormed() || Array.from(update).length > 80 || /[\r\n\u2028\u2029]/u.test(update))) throw fault('profile_draft_invalid');
  return { action: 'update', draft: { display_name: d.display_name.trim(), update, avatar: d.avatar } };
}
function validateState(value, client) {
  if (!object(value) || value.version !== 1 || !ref(value.epoch) || !Array.isArray(value.calls) || !Array.isArray(value.operations) ||
      !own(value, 'selection') || !own(value, 'inspection')) throw fault('business_state_unreadable');
  const ids = new Set();
  for (const call of value.calls) {
    if (!object(call) || (call.forward !== undefined && (!ref(call.forward) || call.forward === call.id)) || !ref(call.id) || ids.has(call.id) || !ref(call.epoch) || !/^[a-f0-9]{64}$/u.test(call.digest)) throw fault('business_state_unreadable');
    ids.add(call.id);
  }
  if (value.selection !== null) {
    const s = value.selection;
    if (!object(s) || s.epoch !== value.epoch || (s.with !== null && handle(s.with) !== s.with) || !Array.isArray(s.rows) ||
        !Number.isSafeInteger(s.offset) || s.offset < 0 || s.offset > s.rows.length || typeof s.complete !== 'boolean' || s.complete !== (s.offset === s.rows.length)) throw fault('business_state_unreadable');
    s.rows.forEach(managementRequest);
  }
  if (value.inspection !== null) {
    if (!object(value.inspection) || value.inspection.epoch !== value.epoch) throw fault('business_state_unreadable');
    managementProfile(value.inspection.value);
  }
  const operations = new Set();
  for (const op of value.operations) {
    const call = value.calls.find((row) => row.id === op?.callId);
    if (!object(op) || !call || operations.has(op.callId) || call.digest !== op.digest || !['request', 'decision', 'profile'].includes(op.kind) ||
        !['selected', 'pending', 'confirmed', 'refused', 'conflict'].includes(op.state) || !object(op.scope) ||
        op.scope.root !== client.root || op.scope.credential !== fingerprint(client.credential) || op.scope.epoch !== call.epoch) throw fault('business_state_unreadable');
    operations.add(op.callId);
    const args = op.kind === 'profile' ? profileArgs(op.args) : connectionArgs(op.args);
    if (hash({ tool: op.kind === 'profile' ? 'profile' : 'connections', args }) !== op.digest) throw fault('business_state_unreadable');
    if (op.kind === 'request') {
      if (args.action !== 'request' || !ref(op.operationId) || !isDeepStrictEqual(op.body, { targetHandle: args.with, operationId: op.operationId, ...(args.note !== undefined && { note: args.note }) })) throw fault('business_state_unreadable');
      if (op.response !== undefined) { managementOperation(op.response, op.operationId); if (op.state === 'confirmed' && op.response.operation.state === 'admitted') throw fault('business_state_unreadable'); }
    } else if (op.kind === 'decision') {
      managementRequest(op.request);
      if (!ref(op.request.id) || op.request.counterparty.handle !== args.with || !['accept', 'ignore', 'withdraw'].includes(args.action)) throw fault('business_state_unreadable');
      if (op.response !== undefined) managementRequest(op.response);
    } else {
      if (args.action !== 'update' || !object(op.body) || !ref(op.body.profileRevision) || !isDeepStrictEqual(op.body, { profileRevision: op.body.profileRevision,
        displayName: args.draft.display_name, update: args.draft.update, ...(args.draft.avatar === 'remove' && { avatarUrl: null }) })) throw fault('business_state_unreadable');
      if (op.response !== undefined) managementProfile(op.response);
    }
    if ((op.state === 'confirmed' && op.response === undefined) || (['refused', 'conflict'].includes(op.state) && !ref(op.refusal))) throw fault('business_state_unreadable');
  }
  if (value.calls.some((call) => call.forward !== undefined && !operations.has(call.forward))) throw fault('business_state_unreadable');
  return value;
}

export class Business {
  constructor(client) { this.client = client; this.epoch = randomUUID(); }
  initialize() {
    this.client.update((data) => {
      const value = own(data, 'business') ? validateState(data.business, this.client) : { version: 1, epoch: this.epoch, calls: [], operations: [], selection: null, inspection: null };
      value.epoch = this.epoch; value.selection = null; value.inspection = null;
      for (const op of value.operations) if (op.state === 'selected') { op.state = 'refused'; op.refusal = 'native_binding_changed'; }
      data.business = value; return data;
    });
  }
  state() { return validateState(this.client.read().business, this.client); }
  change(run) { this.client.update((data) => { run(validateState(data.business, this.client)); return data; }); }
  guard(signal) { this.client.assert(); if (signal?.aborted) throw fault('native_call_cancelled'); }
  bind(tool, args, id) {
    if (!ref(id)) throw fault('native_call_id_required');
    const digest = hash({ tool, args }), previous = this.state().calls.find((call) => call.id === id);
    if (previous && previous.digest !== digest) throw fault('native_call_arguments_changed');
    if (!previous) this.change((s) => { s.calls.push({ id, digest, epoch: this.epoch }); });
    return { callId: id, digest, args, scope: { root: this.client.root, credential: fingerprint(this.client.credential), epoch: previous?.epoch ?? this.epoch } };
  }
  save(op) {
    let saved;
    this.change((s) => {
      const index = s.operations.findIndex((row) => row.callId === op.callId), previous = s.operations[index];
      if (previous) {
        if (previous.digest !== op.digest || !isDeepStrictEqual(previous.scope, op.scope)) throw fault('business_state_unreadable');
        const oldRevision = previous.response?.operation?.revision, newRevision = op.response?.operation?.revision;
        if (['confirmed', 'refused', 'conflict'].includes(previous.state) ||
            (typeof oldRevision === 'number' && typeof newRevision === 'number' && newRevision < oldRevision)) { saved = previous; return; }
      }
      if (index < 0) s.operations.push(op); else s.operations[index] = op;
      saved = op;
    });
    return saved;
  }
  latest(op) { return this.state().operations.find((row) => row.callId === op.callId) ?? op; }
  output(op) {
    const extra = op.scope.epoch !== this.epoch ? { retained_previous_binding: true } : {};
    if (op.state === 'refused' || op.state === 'conflict') return { error: op.refusal, retry: false, ...extra };
    if (op.kind === 'request') {
      const value = op.response;
      if (!value || value.operation.state === 'admitted') return { status: value?.operation.state ?? 'unconfirmed', action: 'request', with: '@' + op.args.with, retry: false, ...extra };
      if (value.operation.state === 'superseded') return { status: 'superseded', action: 'request', retry: false, ...extra };
      return { status: value.result.outcome, ...(value.result.request ? { request: requestView(value.result.request) } : { counterparty: nodeView(value.result.counterparty) }),
        ...(value.result.note_status && { note_status: value.result.note_status }), ...extra };
    }
    if (op.kind === 'decision') return { status: op.response?.status ?? 'unconfirmed', action: op.args.action, with: '@' + op.args.with,
      ...(op.response && { request: requestView(op.response) }), retry: false, ...extra };
    return { status: op.state === 'confirmed' ? 'updated' : 'unconfirmed', ...(op.response && { profile: profileView(op.response) }), retry: false, ...extra };
  }
  async readRequests(withHandle, signal) {
    const rows = [], ids = new Set(), cursors = new Set(); let cursor;
    for (let page = 0; page < 32; page++) {
      this.guard(signal); const value = await this.client.api.connectionRequests(withHandle, cursor, { signal }); this.guard(signal);
      for (const row of value.items) {
        if (ids.has(row.id) || (withHandle && !row.counterparty.tombstone && row.counterparty.handle !== withHandle)) throw fault('connection_pagination_inconsistent');
        ids.add(row.id); rows.push(row);
      }
      if (value.nextCursor === null) return rows;
      if (cursors.has(value.nextCursor)) throw fault('connection_cursor_cycle');
      cursors.add(value.nextCursor); cursor = value.nextCursor;
    }
    throw fault('connection_page_budget_exceeded');
  }
  async recover(op, signal) {
    this.guard(signal);
    op = this.latest(op);
    if (['confirmed', 'refused', 'conflict'].includes(op.state)) return this.output(op);
    if (op.kind === 'profile') {
      const current = await this.client.api.readProfile({ signal }); this.guard(signal); this.checkSelf(current);
      return { ...this.output(this.latest(op)), current: profileView(current), evidence: 'current_state_only' };
    }
    if (op.kind === 'request') {
      try {
        const response = await this.client.api.connectionOperation(op.operationId, { signal }); this.guard(signal);
        const peer = response.result?.request?.counterparty ?? response.result?.counterparty;
        if (peer && !peer.tombstone && peer.handle !== op.args.with) throw fault('connection_operation_peer_mismatch');
        op = this.save({ ...op, response, state: response.operation.state === 'admitted' ? 'pending' : 'confirmed' });
      } catch (error) { this.guard(signal); if (!['operation_not_found', 'services_network_unconfirmed', 'services_timeout', 'operation_aborted'].includes(error.code) && !(error.status >= 500)) throw error; }
      return this.output(this.latest(op));
    }
    const rows = await this.readRequests(op.args.with, signal), original = rows.find((row) => row.id === op.request.id);
    if (original && this.sameIdentity(original, op.request) && original.status === { accept: 'accepted', ignore: 'ignored', withdraw: 'withdrawn' }[op.args.action] && !original.counterparty.tombstone && !original.shadowed) {
      op = this.save({ ...op, response: original, state: 'confirmed' });
      return { ...this.output(op), evidence: 'original_request_read', authorship: 'not_proven' };
    }
    return this.output(this.latest(op));
  }
  sameIdentity(a, b) { return a.id === b.id && ['kind', 'handle', 'mstpAddress', 'tombstone'].every((key) => a.counterparty[key] === b.counterparty[key]); }
  async connections(input, callId, signal) {
    this.guard(signal); const args = connectionArgs(input), call = this.bind('connections', args, callId);
    const forwarded = this.state().calls.find((row) => row.id === callId)?.forward;
    const retained = this.state().operations.find((op) => op.callId === (forwarded ?? callId));
    if (retained) {
      if (forwarded && (retained.kind === 'profile' || retained.args.with !== args.with)) throw fault('business_state_unreadable');
      return this.recover(retained, signal);
    }
    if (call.scope.epoch !== this.epoch) throw fault('native_binding_changed');
    if (args.action === 'list') {
      const value = await this.client.api.connectionList({ signal }); this.guard(signal);
      return { total: value.total, connections: value.connections.map((row) => ({ counterparty: nodeView(row.counterparty),
        ...(!row.counterparty.tombstone && { with: '@' + row.counterparty.handle }), access: row.access,
        ...(row.update !== undefined && { update: row.update }), ...(row.presence !== undefined && { presence: row.presence }) })) };
    }
    if (args.action === 'list_requests') {
      const previous = this.state().selection;
      if (!args.more) {
        this.change((s) => { s.selection = null; });
        const rows = await this.readRequests(args.with, signal);
        this.change((s) => { s.selection = { epoch: this.epoch, with: args.with ?? null, rows, offset: 0, complete: rows.length === 0 }; });
      } else if (!previous || previous.with !== (args.with ?? null) || previous.epoch !== this.epoch || previous.complete) throw fault('connection_continuation_unavailable');
      const selection = this.state().selection, items = selection.rows.slice(selection.offset, selection.offset + 20);
      this.change((s) => { s.selection.offset += items.length; s.selection.complete = s.selection.offset === s.selection.rows.length; });
      return { requests: items.map(requestView), more: !this.state().selection.complete, list: 'dynamic' };
    }
    const unresolved = this.state().operations.find((op) => op.kind !== 'profile' && op.args.with === args.with && op.args.action === args.action && op.state === 'pending');
    if (unresolved) { this.change((s) => { s.calls.find((row) => row.id === callId).forward = unresolved.callId; }); return this.recover(unresolved, signal); }
    if (args.action === 'request') {
      if (args.with === this.client.identity.handle) throw fault('connection_self_request');
      const operationId = randomUUID(), op = { ...call, kind: 'request', state: 'pending', operationId,
        body: { targetHandle: args.with, operationId, ...(args.note !== undefined && { note: args.note }) } };
      this.save(op); this.guard(signal);
      try { await this.client.api.createConnectionRequest(op.body, { signal }); this.guard(signal); }
      catch (error) {
        this.guard(signal);
        if (knownRefusal(error) && !['already_connected', 'operation_superseded'].includes(error.code)) {
          const refused = { ...op, state: 'refused', refusal: error.code }; this.save(refused); return this.output(refused);
        }
      }
      const result = await this.recover(op, signal);
      const stored = this.state().operations.find((row) => row.callId === callId), request = stored.response?.result?.request;
      if (request) this.change((s) => { s.selection = { epoch: this.epoch, with: args.with, rows: [request], offset: 1, complete: true }; });
      return result;
    }
    const selection = this.state().selection;
    if (!selection?.complete || selection.epoch !== this.epoch || (selection.with !== null && selection.with !== args.with)) throw fault('complete_request_read_required');
    const candidates = selection.rows.filter((row) => row.counterparty.handle === args.with && actions(row).includes(args.action));
    if (candidates.length !== 1) throw fault('connection_selection_required');
    let op = { ...call, kind: 'decision', state: 'selected', request: candidates[0] }; this.save(op);
    const fresh = (await this.readRequests(args.with, signal)).filter((row) => actions(row).includes(args.action));
    if (fresh.length !== 1 || !this.sameIdentity(fresh[0], op.request) || fresh[0].status !== op.request.status) {
      op = { ...op, state: 'refused', refusal: 'connection_selection_changed' }; this.save(op); return this.output(op);
    }
    op = this.save({ ...op, state: 'pending' });
    if (op.state !== 'pending') return this.output(op);
    this.guard(signal);
    try {
      const response = await this.client.api.decideConnectionRequest(op.request.id, args.action, { signal }); this.guard(signal);
      if (!this.sameIdentity(response, op.request) || response.status !== { accept: 'accepted', ignore: 'ignored', withdraw: 'withdrawn' }[args.action] || response.shadowed || response.counterparty.tombstone) throw fault('connection_decision_unconfirmed');
      op = { ...op, state: 'confirmed', response }; this.save(op); return this.output(op);
    } catch (error) {
      this.guard(signal);
      if (knownRefusal(error)) return this.output(this.save({ ...op, state: 'refused', refusal: error.code }));
      return this.recover(op, signal);
    }
  }
  checkSelf(value) {
    if (value.profile.handle !== this.client.identity.handle || value.profile.canonicalAddress !== this.client.identity.address) throw fault('profile_identity_mismatch');
  }
  async profile(input, callId, signal) {
    this.guard(signal); const args = profileArgs(input), call = this.bind('profile', args, callId);
    const retained = this.state().operations.find((op) => op.callId === callId);
    if (retained) return this.recover(retained, signal);
    if (call.scope.epoch !== this.epoch) throw fault('native_binding_changed');
    if (args.action === 'inspect') {
      const value = await this.client.api.readProfile({ signal }); this.guard(signal); this.checkSelf(value);
      this.change((s) => { s.inspection = { epoch: this.epoch, value }; });
      return { status: 'inspected', profile: profileView(value), draft: draftView(value) };
    }
    const selected = this.state().inspection;
    if (!selected || selected.epoch !== this.epoch) throw fault('profile_inspection_required');
    const op = { ...call, kind: 'profile', state: 'pending', body: { profileRevision: selected.value.profileRevision,
      displayName: args.draft.display_name, update: args.draft.update, ...(args.draft.avatar === 'remove' && { avatarUrl: null }) } };
    this.change((s) => { s.inspection = null; s.operations.push(op); }); this.guard(signal);
    try {
      const response = await this.client.api.patchProfile(op.body, { signal }); this.guard(signal); this.checkSelf(response);
      if (response.profile.displayName !== args.draft.display_name || response.profile.update !== args.draft.update ||
          (args.draft.avatar === 'remove' && response.profile.avatarUrl !== null)) throw fault('profile_write_unconfirmed');
      const confirmed = { ...op, state: 'confirmed', response }; this.save(confirmed); return this.output(confirmed);
    } catch (error) {
      this.guard(signal);
      if (error.code === 'profile_revision_conflict' || knownRefusal(error)) {
        const refused = { ...op, state: error.code === 'profile_revision_conflict' ? 'conflict' : 'refused', refusal: error.code }; this.save(refused); return this.output(refused);
      }
      return this.recover(op, signal);
    }
  }
}
