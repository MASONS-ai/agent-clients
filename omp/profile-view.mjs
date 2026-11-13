import { fault } from './store.mjs';

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const folded = (v) => v.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
function handle(value) {
  if (!/^@[a-z][a-z0-9_-]{2,14}$/iu.test(value)) throw fault('unresolved_target');
  return value.slice(1).toLowerCase();
}
export function profileTarget(input, config) {
  const target = input?.target;
  if (!object(input) || Object.keys(input).some((k) => !['target', 'observation'].includes(k)) || !object(target) ||
      !['node', 'session'].includes(target.kind) || Object.keys(target).some((k) => !['kind', 'self', 'to'].includes(k)) ||
      (Object.hasOwn(target, 'self') ? target.self !== true || Object.hasOwn(target, 'to') : !Object.hasOwn(target, 'to'))) throw fault('invalid_request');
  if (input.observation !== undefined && (!['conversation', 'directory'].includes(input.observation) || target.kind !== 'session' || target.self)) throw fault('invalid_request');
  if (target.self) return { kind: target.kind, self: true };
  if (typeof target.to !== 'string' || !target.to.isWellFormed() || !target.to.trim() || target.to.trim().length > 512) throw fault('invalid_request');
  const to = target.to.trim();
  if (target.kind === 'node') {
    if (to.startsWith('@')) return { kind: 'node', handle: handle(to) };
    let address;
    try { address = new URL(to); } catch { throw fault('unresolved_target'); }
    if (address.protocol !== 'mstps:' || address.host !== new URL(config.web).host || address.username || address.password || address.search || address.hash) throw fault('unresolved_target');
    return { kind: 'node', handle: handle('@' + address.pathname.slice(1)) };
  }
  const coded = /^([\s\S]*\S)\s*\[([0-9a-f]{6})\]$/iu.exec(to);
  const match = /^([\s\S]*?)@([a-z][a-z0-9_-]{2,14})$/iu.exec(coded ? coded[1].trim() : to);
  if (!match || !match[1].trim()) throw fault('unresolved_target');
  return { kind: 'session', name: match[1], handle: match[2].toLowerCase(), ...(coded && { pick_code: coded[2].toLowerCase() }), ...(input.observation && { observation: input.observation }) };
}

export function observedProfileTarget(client, target) {
  if (target.self) return { kind: 'session', self: true };
  const candidates = new Map();
  const matches = (name, handle, code) => typeof name === 'string' && folded(name) === folded(target.name) &&
    handle === target.handle && (!target.pick_code || code === target.pick_code);
  for (const conversation of target.observation === 'directory' ? [] : client.read().conversations) {
    for (const party of conversation.participants) {
      if (party.kind !== 'session' || party.unresolved || party.participant_ref === conversation.self_participant_ref ||
          !matches(party.name, party.parent_node?.handle, party.pick_code)) continue;
      candidates.set('participant:' + party.participant_ref, { target: { kind: 'session', conversation_ref: conversation.conversation_ref, participant_ref: party.participant_ref },
        to: `${party.name}@${party.parent_node.handle}${party.pick_code ? ` [${party.pick_code}]` : ''}`, observation: 'conversation' });
    }
  }
  const listed = client.directory.state().sessions;
  if (target.observation !== 'conversation' && listed && listed.epoch === client.directory.epoch && listed.registration === client.directory.registration(client.read().registration) && listed.to === target.handle) {
    for (const row of listed.rows ?? []) {
      if (!matches(row.display?.name, listed.to, row.pick_code)) continue;
      candidates.set('listed:' + row.target_ref, { target: { kind: 'session', target_ref: row.target_ref }, to: `${row.display.name}@${listed.to} [${row.pick_code}]`, observation: 'directory' });
    }
  }
  if (candidates.size === 1) return [...candidates.values()][0].target;
  if (!candidates.size) throw fault('unresolved_target');
  return { error: 'target_selection_required', reason: new Set([...candidates.values()].map((c) => c.observation)).size > 1 ? 'observation_context_required' : 'target_item_required',
    candidates: [...candidates.values()].map(({ to, observation }) => ({ to, observation })) };
}

export function presentProfile(view) {
  const note = (value, about) => ({ ...value, about, attribution: "Your user's private note" });
  if (view.subject.kind === 'node') return { remoteData: true, ...view, private_notes: { node: note(view.private_notes.node, 'node') } };
  const { participant_ref, ...subject } = view.subject;
  return { remoteData: true, ...view, subject, private_notes: { session: note(view.private_notes.session, 'session'), node: note(view.private_notes.node, 'node') } };
}
