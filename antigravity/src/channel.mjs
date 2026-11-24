import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const CHANNELS = new Set(['preview', 'production']);

export function assertChannelConfig(config) {
  if (!config || typeof config !== 'object' || !CHANNELS.has(config.channel)) {
    throw Object.assign(new Error('channel_config_invalid'), { code: 'channel_config_invalid' });
  }
  if (typeof config.identity !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(config.identity) ||
      typeof config.stateDirName !== 'string' || !/^[a-z0-9_-]+$/u.test(config.stateDirName)) {
    throw Object.assign(new Error('channel_identity_mismatch'), { code: 'channel_identity_mismatch' });
  }
  const api = new URL(config.api);
  const web = new URL(config.web);
  if (api.protocol !== 'https:' || web.protocol !== 'https:' ||
      api.username || api.password || web.username || web.password) {
    throw Object.assign(new Error('channel_origin_mismatch'), { code: 'channel_origin_mismatch' });
  }
  return config;
}

export function canonicalStateRoot(config, { home = homedir(), overrideRoot } = {}) {
  assertChannelConfig(config);
  if (overrideRoot) return resolve(overrideRoot);
  return resolve(join(home, '.masons-antigravity', config.stateDirName));
}
