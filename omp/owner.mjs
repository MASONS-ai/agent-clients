import { generateKeyPairSync, privateDecrypt, constants, createDecipheriv, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Services } from './services.mjs';
import { Store, fault, fingerprint } from './store.mjs';

export function dataRoot(config, base = process.env.MASONS_OMP_DATA_DIR || join(homedir(), '.local', 'share')) {
  return join(base, config.identity, 'omp');
}
export const settings = (store) => store.read('settings.json', { credential: null, candidate: null });
export function decryptHandoff(privateKey, envelope) {
  if (!envelope || !['wrapped_key', 'iv', 'ciphertext'].every((k) => typeof envelope[k] === 'string')) throw fault('link_payload_unreadable');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.wrapped_key, 'base64url'));
  const iv = Buffer.from(envelope.iv, 'base64url'), ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
  if (key.length !== 32 || iv.length !== 12 || ciphertext.length < 16) throw fault('link_payload_unreadable');
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(ciphertext.subarray(-16));
  const value = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'));
  if (!value?.token?.startsWith('masons_rt_v1_') || typeof value.agent?.agentId !== 'string' || typeof value.agent?.handle !== 'string') throw fault('link_payload_unreadable');
  return { token: value.token, node: value.agent.agentId, handle: value.agent.handle };
}

export class Owner {
  constructor(config, { store = new Store(dataRoot(config)), makeServices = (credential) => new Services({ api: config.api, credential }), now = Date.now } = {}) {
    this.config = config; this.store = store; this.makeServices = makeServices; this.now = now;
  }
  async begin(expected) {
    if (expected !== undefined && !/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(expected.replace(/^@/u, '').toLowerCase())) throw fault('link_handle_invalid');
    expected = expected?.replace(/^@/u, '').toLowerCase();
    const old = settings(this.store);
    if (old.candidate) return { status: old.candidate.state, ...(old.candidate.url && { url: old.candidate.url }) };
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const candidate = { id: randomUUID(), state: 'starting', previous: old.credential ? fingerprint(old.credential) : null, expected,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), expires: this.now() + 600_000 };
    this.store.update('settings.json', (value) => {
      value ??= { credential: null, candidate: null };
      if (value.candidate || (value.credential ? fingerprint(value.credential) : null) !== candidate.previous) throw fault('link_state_changed');
      return { ...value, candidate };
    });
    const api = this.makeServices(old.credential ?? {});
    try {
      const body = { cli_pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'), session_topology: 'multi_session' };
      let response;
      try { response = await api.request('cli-handoff/init', body, { auth: Boolean(old.credential) }); }
      catch (error) {
        if (!old.credential || error.status !== 401 || error.code !== 'unauthorized') throw error;
        response = await api.request('cli-handoff/init', body, { auth: false });
      }
      const url = new URL(response.owner_choice_url);
      if (url.origin !== new URL(this.config.web).origin || url.protocol !== 'https:' || url.username || url.password || url.hash || typeof response.session_id !== 'string') throw fault('link_url_untrusted');
      this.store.update('settings.json', (value) => {
        if (value.candidate?.id !== candidate.id) throw fault('link_state_changed');
        return { ...value, candidate: { ...candidate, state: 'pending', session: response.session_id, url: url.href } };
      });
      return { status: 'pending', url: url.href };
    } catch (error) {
      this.store.update('settings.json', (value) => value.candidate?.id === candidate.id ? { ...value, candidate: { ...candidate, state: 'unconfirmed' } } : value);
      throw error;
    }
  }
  async poll() {
    const held = settings(this.store), candidate = held.candidate;
    if (!candidate || candidate.state !== 'pending') return { status: candidate?.state ?? (held.credential ? 'linked' : 'not_linked') };
    if (candidate.expires <= this.now()) {
      this.store.update('settings.json', (value) => value.candidate?.id === candidate.id ? { ...value, candidate: { ...candidate, state: 'expired' } } : value);
      return { status: 'expired' };
    }
    const api = this.makeServices({});
    const response = await api.request(`cli-handoff/${encodeURIComponent(candidate.session)}/poll`, undefined, { method: 'GET', auth: false });
    if (response?.status === 'pending') return { status: 'pending' };
    if (response?.status !== 'completed') throw fault('link_poll_unconfirmed');
    // Persist the one-time encrypted response before validation or any further request.
    this.store.update('settings.json', (value) => {
      if (value.candidate?.id !== candidate.id) throw fault('link_state_changed');
      return { ...value, candidate: { ...candidate, state: 'received', envelope: response.payload } };
    });
    return this.qualify();
  }
  async qualify() {
    const candidate = settings(this.store).candidate;
    if (!candidate || candidate.state !== 'received') return { status: candidate?.state ?? 'not_pending' };
    const credential = decryptHandoff(candidate.privateKey, candidate.envelope);
    const identity = await this.makeServices(credential).identity();
    if (identity.handle !== credential.handle || (candidate.expected && identity.handle !== candidate.expected)) throw fault('link_wrong_node');
    this.store.update('settings.json', (value) => {
      if (value.candidate?.id !== candidate.id) throw fault('link_state_changed');
      return { ...value, candidate: { ...candidate, state: 'verified', credential } };
    });
    return { status: 'verified', receiver: 'waiting_for_native_registration' };
  }
  promote(id, nativeRegistration) {
    if (!nativeRegistration?.response?.endpoint_id || nativeRegistration.state !== 'active') throw fault('link_registration_unconfirmed');
    this.store.update('settings.json', (value) => {
      const candidate = value.candidate;
      if (candidate?.id !== id || candidate.state !== 'verified' || (value.credential ? fingerprint(value.credential) : null) !== candidate.previous) throw fault('link_state_changed');
      return { credential: candidate.credential, candidate: null };
    });
  }
  cancel(id) {
    this.store.update('settings.json', (value) => {
      if (value?.candidate?.id !== id) throw fault('link_state_changed');
      return { ...value, candidate: null };
    });
    return { status: 'cancelled' };
  }
}
