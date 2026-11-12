import { randomUUID } from 'node:crypto';
import { fault } from './store.mjs';

const own = (v, k) => Object.hasOwn(v, k);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.length > 0;
const clocks = { setInterval, clearInterval, setTimeout, clearTimeout };
function valid(value) {
  if (!object(value) || value.version !== 1 || !text(value.incarnation) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !['own', 'reported', 'applied', 'pending', 'controls'].every((k) => own(value, k)) || !Array.isArray(value.controls)) throw fault('metadata_state_unreadable');
  for (const key of ['own', 'reported']) if (value[key] !== null && (!object(value[key]) || typeof value[key].name !== 'string' || !Number.isSafeInteger(value[key].sequence) || value[key].sequence < 0 || value[key].sequence > value.sequence)) throw fault('metadata_state_unreadable');
  for (const key of ['applied', 'pending']) if (value[key] !== null && (!object(value[key]) || !text(value[key].name))) throw fault('metadata_state_unreadable');
  if (value.pending !== null && (!text(value.pending.endpoint) || !text(value.pending.nonce) || !Number.isSafeInteger(value.pending.sequence) || value.pending.sequence < 0 || value.pending.sequence > value.sequence || typeof value.pending.set !== 'boolean')) throw fault('metadata_state_unreadable');
  const ids = new Set();
  for (const c of value.controls) {
    if (!object(c) || !text(c.id) || ids.has(c.id) || !text(c.endpoint) || typeof c.applied !== 'boolean' || typeof c.acked !== 'boolean' || (c.acked && !c.applied)) throw fault('metadata_state_unreadable');
    ids.add(c.id);
  }
  return value;
}

export class Metadata {
  constructor(client) {
    this.client = client; this.clock = client.host.clock ?? clocks;
    this.naming = typeof client.host.setName === 'function' && typeof client.host.subscribeName === 'function';
    this.typing = typeof client.host.subscribeRun === 'function';
    this.runSequence = 0;
  }
  initialize() {
    if (this.naming) {
      this.client.update((data) => { data.metadata = own(data, 'metadata') ? valid(data.metadata) : { version: 1, incarnation: randomUUID(), sequence: 0, own: null, reported: null, applied: null, pending: null, controls: [] }; return data; });
      this.changed(false); this.initialSequence = this.state().sequence;
      this.unname = this.client.host.subscribeName(() => { try { this.changed(); } catch (e) { this.client.problem(e); } });
    }
    if (this.typing) this.unrun = this.client.host.subscribeRun((event) => this.event(event));
  }
  state() { return valid(this.client.read().metadata); }
  change(run) { this.client.update((data) => { run(valid(data.metadata)); return data; }); }
  guard(held) {
    this.client.assert();
    if (held && (this.client.read().registration?.response?.endpoint_id !== held.response.endpoint_id || this.client.read().registration?.nonce !== held.nonce || this.client.read().registration?.state !== 'active')) throw fault('metadata_registration_changed');
  }
  raw() { const name = this.client.host.name(); return typeof name === 'string' && name.length ? name : undefined; }
  changed(schedule = true) {
    this.guard(); const name = this.raw(), value = this.state();
    if (name !== undefined && !(this.applying?.name === name) && !(value.pending?.set && value.pending.name === name) && name !== (value.applied?.name ?? value.own?.name)) {
      this.change((s) => { s.own = { name, sequence: ++s.sequence }; s.applied = null; });
    }
    if (schedule) void this.sync().catch((e) => this.client.problem(e));
  }
  registrationName() {
    if (!this.naming) return undefined;
    this.changed(false); const value = this.state(), raw = this.raw();
    return raw !== undefined && raw !== value.applied?.name && !(value.pending?.set && raw === value.pending.name) ? raw : undefined;
  }
  reportSnapshot(name) { return name === undefined ? undefined : { name, sequence: this.state().sequence, incarnation: this.state().incarnation }; }
  async registered(registration) {
    if (!this.naming) return;
    this.guard(); this.changed(false);
    const value = this.state(), report = registration.nameReport;
    if (value.own && registration.request?.host_session_name === value.own.name &&
        (report?.incarnation === value.incarnation ? report.sequence === value.own.sequence : value.reported === null && value.sequence === this.initialSequence)) {
      this.change((s) => { s.reported = { ...s.own }; });
    }
    await this.sync();
  }
  async cue(raw) {
    if (!this.naming) return;
    this.guard();
    if (raw.version !== 1 || !text(raw.idempotency_key)) throw fault('session_name_control_unreadable');
    this.change((s) => { if (!s.controls.some((c) => c.id === raw.idempotency_key)) s.controls.push({ id: raw.idempotency_key, endpoint: raw.endpoint_id, applied: false, acked: false }); });
    await this.sync();
  }
  sync() {
    if (!this.naming || this.stopped) return Promise.resolve();
    this.requested = true;
    if (this.work) return this.work;
    const run = async () => {
      for (let pass = 0; this.requested && !this.stopped && pass < 32; pass++) {
        this.requested = false;
        if (this.client.read().registration?.state !== 'active') return;
        await this.synchronize();
      }
    };
    this.work = run().finally(() => { this.work = undefined; if (this.requested && !this.stopped) queueMicrotask(() => { void this.sync().catch((e) => this.client.problem(e)); }); }); return this.work;
  }
  async synchronize() {
    this.guard(); this.changed(false);
    const held = this.client.read().registration;
    const before = this.state(), pendingOwn = before.own && before.own.sequence !== before.reported?.sequence;
    if (pendingOwn) {
      const report = before.own;
      const ack = await this.client.api.reportName(held, report.name, { signal: this.client.abort.signal }); this.guard(held);
      if (!ack.accepted && ack.reason !== 'invalid') return;
      this.change((s) => { s.reported = { ...report }; });
      this.changed(false);
      if (this.state().sequence !== report.sequence) { this.requested = true; return; }
    }
    const sequence = this.state().sequence, controls = this.state().controls.filter((c) => !c.applied).map((c) => c.id);
    const row = await this.client.api.owned(held, { signal: this.client.abort.signal }); this.guard(held);
    this.changed(false);
    if (this.state().sequence !== sequence) { this.requested = true; return; }
    const name = row.session_naming?.name;
    if (typeof name !== 'string' || !name || !name.isWellFormed()) return;
    const set = this.raw() !== name || this.state().applied?.name === name || (this.state().pending?.name === name && this.state().pending.set);
    this.change((s) => { s.pending = { name, endpoint: held.response.endpoint_id, nonce: held.nonce, sequence, set: Boolean(set) }; });
    if (this.raw() !== name) {
      this.applying = { name };
      try { this.guard(held); await this.client.host.setName(name); this.guard(held); }
      finally { this.applying = null; }
    }
    const readback = this.raw();
    if (this.state().sequence !== sequence) { this.requested = true; return; }
    if (readback !== name) { this.changed(false); return; }
    this.change((s) => { s.applied = set ? { name } : null; s.pending = null; for (const c of s.controls) if (controls.includes(c.id)) c.applied = true; });
    for (const c of this.state().controls.filter((v) => v.applied && !v.acked)) {
      this.guard(held); await this.client.api.controlAck(c.id); this.guard(held);
      this.change((s) => { s.controls.find((v) => v.id === c.id).acked = true; });
    }
  }
  event(event) {
    try {
      this.guard();
      if (event.type === 'agent_start') { this.stopRun(); this.nativeEpoch = ++this.runSequence; this.run = { epoch: this.nativeEpoch, composing: true, conversation: null, ambiguous: false }; }
      else if (event.type === 'native_idle') { if (this.nativeEpoch !== undefined) this.endingEpoch = this.nativeEpoch; this.pause(); }
      else if (event.type === 'agent_end') { const epoch = this.endingEpoch ?? this.nativeEpoch; this.endingEpoch = undefined; if (event.isTerminal !== false || event.yielded === true || event.awaitingAsyncWork === true) this.stopRun(epoch); }
      else if (event.type === 'turn_start' && this.run && !this.run.composing) { this.run.composing = true; this.startPulse(); }
    } catch { this.stopRun(); }
  }
  admitted(frame) {
    if (!this.typing || !this.run?.composing || this.run.ambiguous) return;
    const conversation = frame.subject.conversation_ref;
    if (this.run.conversation && this.run.conversation !== conversation) { this.run.ambiguous = true; this.pause(); return; }
    this.run.conversation = conversation; this.startPulse();
  }
  startPulse() {
    if (this.pulseTimer || !this.run?.composing || !this.run.conversation || this.run.ambiguous) return;
    const run = this.run, held = this.client.read().registration;
    if (held?.state !== 'active') return;
    this.pulseAbort = new AbortController();
    const pulse = async () => {
      if (this.pulsing === run || this.run !== run || !run.composing) return;
      try {
        this.guard(held); this.pulsing = run;
        await this.client.api.typing(held, run.conversation, { signal: this.pulseAbort.signal }); this.guard(held);
      } catch { if (this.run === run) this.stopRun(); }
      finally { if (this.pulsing === run) this.pulsing = null; }
    };
    this.pulseTimer = this.clock.setInterval(() => { void pulse(); }, 4000); this.pulseTimer.unref?.();
    void pulse();
  }
  pause() { if (this.run) this.run.composing = false; this.clock.clearInterval(this.pulseTimer); this.pulseTimer = null; this.pulseAbort?.abort(); }
  stopRun(epoch) { if (epoch !== undefined && this.run?.epoch !== epoch) return; this.pause(); this.run = null; }
  incoming(raw) {
    this.guard();
    if (!this.typing || raw.endpoint_id !== this.client.read().registration?.response?.endpoint_id || raw.recipient?.runtime_session_id !== this.client.root || Object.hasOwn(raw.recipient, 'node_id') || !text(raw.conversation_ref)) return;
    this.clearIncoming(); this.remote = raw.conversation_ref;
    this.client.host.typingStatus?.(`${this.client.config.label ?? 'MASONS'}: remote party is typing…`);
    const conversation = raw.conversation_ref;
    this.remoteTimer = this.clock.setTimeout(() => { if (this.remote === conversation) this.clearIncoming(); }, 6000); this.remoteTimer.unref?.();
  }
  clearIncoming(conversation) {
    if (conversation !== undefined && conversation !== this.remote) return;
    this.clock.clearTimeout(this.remoteTimer); this.remoteTimer = null; this.remote = null; this.client.host.typingStatus?.(undefined);
  }
  close() { this.stopped = true; this.unname?.(); this.unrun?.(); this.stopRun(); this.clearIncoming(); }
}
