import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { Services } from './services.mjs';
import { fault } from './store.mjs';

export function readSettings(store) {
  return store.readJson('settings.json', { credential: null, candidate: null, lastLink: { status: 'none' } });
}

export function decryptHandoff(privateKey, envelope) {
  if (!envelope || !['wrapped_key', 'iv', 'ciphertext'].every((k) => typeof envelope[k] === 'string')) {
    throw fault('link_payload_unreadable');
  }
  try {
    const key = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      Buffer.from(envelope.wrapped_key, 'base64url'),
    );
    const iv = Buffer.from(envelope.iv, 'base64url');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
    if (key.length !== 32 || iv.length !== 12 || ciphertext.length < 16) {
      throw fault('link_payload_unreadable');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(ciphertext.subarray(-16));
    const value = JSON.parse(
      Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8'),
    );
    if (!value?.token?.startsWith('masons_rt_v1_') ||
        typeof value.agent?.agentId !== 'string' ||
        typeof value.agent?.handle !== 'string') {
      throw fault('link_payload_unreadable');
    }
    return { token: value.token, node: value.agent.agentId, handle: value.agent.handle };
  } catch (error) {
    if (error?.code === 'link_payload_unreadable') throw error;
    throw fault('link_payload_unreadable');
  }
}

function isTerminalQualifyError(error) {
  if (['link_payload_unreadable', 'link_wrong_node', 'link_principal_mismatch'].includes(error?.code)) return true;
  if (typeof error?.status === 'number' && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
    return true;
  }
  return false;
}

export class OwnerLink {
  constructor(config, { store, makeServices = (credential) => new Services({ api: config.api, credential }), now = Date.now }) {
    this.config = config;
    this.store = store;
    this.makeServices = makeServices;
    this.now = now;
  }

  syncMarker() {
    this.store.withFileLock('hooks-active', () => {
      const held = readSettings(this.store);
      const active = Boolean(held.credential || (held.candidate && ['starting', 'pending', 'received'].includes(held.candidate.state)));
      if (active) {
        this.store.writeJsonAtomic('hooks-active', { active: true, updatedAt: new Date(this.now()).toISOString() });
      } else {
        this.store.deleteFile('hooks-active');
      }
    });
  }

  async begin(expected, { replace = false, signal } = {}) {
    if (expected !== undefined) {
      if (typeof expected !== 'string') throw fault('link_handle_invalid');
      const normalized = expected.replace(/^@/u, '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(normalized)) throw fault('link_handle_invalid');
      expected = normalized;
    }
    const old = readSettings(this.store);
    if (!replace && old.candidate?.state === 'received') {
      if (expected !== undefined && old.candidate.expected !== expected) {
        throw fault('link_replace_required');
      }
      return this.qualify({ signal });
    }
    if (!replace && old.candidate && old.candidate.state === 'pending' && old.candidate.expires > this.now()) {
      if (expected !== undefined && old.candidate.expected !== expected) {
        throw fault('link_replace_required');
      }
      return {
        status: 'awaiting',
        verification_uri: old.candidate.url,
        expires_at: new Date(old.candidate.expires).toISOString(),
        started_at: old.candidate.startedAt,
      };
    }

    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const startedAt = new Date(this.now()).toISOString();
    const expires = this.now() + 600_000;
    const candidate = {
      id: randomUUID(),
      state: 'starting',
      expected,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      startedAt,
      expires,
    };

    this.store.updateJson('settings.json', (value) => {
      const base = value ?? { credential: null, candidate: null, lastLink: { status: 'none' } };
      return { ...base, candidate };
    });
    this.syncMarker();

    const api = this.makeServices(old.credential ?? {});
    try {
      // Closed request key set for POST /v1/cli-handoff/init.
      const body = {
        cli_pubkey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      };
      let response;
      try {
        response = await api.request('cli-handoff/init', body, { auth: Boolean(old.credential), signal });
      } catch (error) {
        if (!old.credential || error.status !== 401 || error.code !== 'unauthorized') throw error;
        response = await api.request('cli-handoff/init', body, { auth: false, signal });
      }
      const url = new URL(response.owner_choice_url);
      if (url.origin !== new URL(this.config.web).origin ||
          url.protocol !== 'https:' ||
          url.username || url.password || url.hash ||
          typeof response.session_id !== 'string') {
        throw fault('link_url_untrusted');
      }
      const expiresAt = new Date(expires).toISOString();
      this.store.updateJson('settings.json', (value) => {
        if (value.candidate?.id !== candidate.id) throw fault('link_state_changed');
        return {
          ...value,
          candidate: { ...candidate, state: 'pending', session: response.session_id, url: url.href },
          lastLink: { status: 'awaiting', verification_uri: url.href, expires_at: expiresAt, started_at: startedAt },
        };
      });
      this.syncMarker();
      return { status: 'awaiting', verification_uri: url.href, expires_at: expiresAt, started_at: startedAt };
    } catch (error) {
      this.store.updateJson('settings.json', (value) => value?.candidate?.id === candidate.id
        ? {
          ...value,
          candidate: null,
          lastLink: { status: 'error', code: error?.code ?? 'link_init_failed', started_at: startedAt },
        }
        : value);
      this.syncMarker();
      throw error;
    }
  }

  async poll({ signal } = {}) {
    const held = readSettings(this.store);
    const candidate = held.candidate;
    if (candidate?.state === 'received') {
      return this.qualify({ signal });
    }
    if (!candidate || candidate.state !== 'pending') {
      return { status: candidate?.state ?? (held.credential ? 'linked' : 'not_linked') };
    }
    if (candidate.expires <= this.now()) {
      this.store.updateJson('settings.json', (value) => value?.candidate?.id === candidate.id
        ? {
          ...value,
          candidate: null,
          lastLink: { status: 'expired', code: 'link_expired', started_at: candidate.startedAt },
        }
        : value);
      this.syncMarker();
      return { status: 'expired' };
    }
    const api = this.makeServices({});
    let response;
    try {
      response = await api.request(
        `cli-handoff/${encodeURIComponent(candidate.session)}/poll`,
        undefined,
        { method: 'GET', auth: false, signal },
      );
    } catch (error) {
      if (error?.status === 404 || error?.status === 410 ||
          error?.code === 'session_not_found' || error?.code === 'handoff_expired') {
        this.store.updateJson('settings.json', (value) => value?.candidate?.id === candidate.id
          ? {
            ...value,
            candidate: null,
            lastLink: { status: 'expired', code: 'link_expired', started_at: candidate.startedAt },
          }
          : value);
        this.syncMarker();
        return { status: 'expired' };
      }
      throw error;
    }
    if (response?.status === 'pending') {
      return {
        status: 'awaiting',
        verification_uri: candidate.url,
        expires_at: new Date(candidate.expires).toISOString(),
        started_at: candidate.startedAt,
      };
    }
    if (response?.status !== 'completed') throw fault('link_poll_unconfirmed');

    // Persist one-time encrypted payload before validation so transient errors can retry qualify().
    this.store.updateJson('settings.json', (value) => {
      if (value?.candidate?.id !== candidate.id) throw fault('link_state_changed');
      return { ...value, candidate: { ...candidate, state: 'received', envelope: response.payload } };
    });
    return this.qualify({ signal });
  }

  async qualify({ signal } = {}) {
    const held = readSettings(this.store);
    const candidate = held.candidate;
    if (!candidate || candidate.state !== 'received') {
      return { status: candidate?.state ?? 'not_pending' };
    }
    try {
      const credential = decryptHandoff(candidate.privateKey, candidate.envelope);
      const identity = await this.makeServices(credential).identity({ signal });
      if (identity.handle !== credential.handle || (candidate.expected && identity.handle !== candidate.expected)) {
        throw fault('link_wrong_node');
      }
      const completedAt = new Date(this.now()).toISOString();
      this.store.updateJson('settings.json', (value) => {
        if (value?.candidate?.id !== candidate.id) throw fault('link_state_changed');
        return {
          credential: { token: credential.token, node: credential.node, handle: identity.handle, address: identity.address },
          candidate: null,
          lastLink: {
            status: 'complete',
            handle: identity.handle,
            completed_at: completedAt,
            started_at: candidate.startedAt,
          },
        };
      });
      this.syncMarker();
      return { status: 'complete', handle: identity.handle, address: identity.address };
    } catch (error) {
      // Clear candidate & privateKey on terminal failure; preserve 'received' on transient network/5xx errors for retry.
      if (isTerminalQualifyError(error)) {
        this.store.updateJson('settings.json', (value) => value?.candidate?.id === candidate.id
          ? {
            ...value,
            candidate: null,
            lastLink: { status: 'error', code: error?.code ?? 'link_qualify_failed', started_at: candidate.startedAt },
          }
          : value);
        this.syncMarker();
      }
      throw error;
    }
  }

  cancel() {
    this.store.updateJson('settings.json', (value) => ({
      ...(value ?? { credential: null, candidate: null, lastLink: { status: 'none' } }),
      candidate: null,
    }));
    this.syncMarker();
    return { status: 'cancelled' };
  }
}
