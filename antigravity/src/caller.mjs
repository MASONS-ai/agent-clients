import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { UUID_RE, fault } from './store.mjs';

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const REMOTE_ENVELOPE_MARKER = '[MASONS INBOUND MESSAGE]';
export const SIDECAR_WAKE_PREFIX = '[MASONS WAKE]';
export const SIDECAR_WAKE_PROMPT = `${SIDECAR_WAKE_PREFIX} A new MASONS message arrived. Read the injected message and respond via masons_send if appropriate.`;

export function extractStepText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

export function hasSidecarWakeMarker(content) {
  const text = extractStepText(content);
  return typeof text === 'string' && /\\?\[MASONS WAKE\\?\]/u.test(text);
}

export function isSidecarWakeInput(content) {
  const text = extractStepText(content);
  return text === null || /\\?\[MASONS WAKE\\?\]/u.test(text);
}
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const normCase = (p) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

/**
 * Resolve symlinks via realpathSync, falling back to the nearest existing ancestor
 * when the target file does not exist yet (e.g. a proposed write_file target).
 */
export function canonicalizePath(targetPath) {
  const abs = resolve(targetPath);
  const trailing = [];
  let cursor = abs;
  while (true) {
    try {
      const real = realpathSync(cursor);
      return trailing.length ? join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      trailing.push(cursor.slice(parent.length).replace(/^[/\\]+/, ''));
      cursor = parent;
    }
  }
}

export function isPathUnder(candidate, root) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const c = normCase(canonicalizePath(candidate));
  const r = normCase(canonicalizePath(root));
  const rel = relative(r, c);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Returns true if candidate is strictly under protectedRoot, equals it,
 * OR is an ancestor directory containing protectedRoot (preventing recursive scans like grep_search on ~).
 */
export function isPathRelated(candidate, protectedRoot) {
  if (typeof candidate !== 'string' || !candidate) return false;
  return isPathUnder(candidate, protectedRoot) || isPathUnder(protectedRoot, candidate);
}

/**
 * Single fail-closed caller qualification from native Antigravity MCP params._meta.
 * Mechanically rejects subagents (parent_conversation_id present or conversation_id !== root_conversation_id).
 */
export function qualifyMcpCaller(meta) {
  if (!isPlainObject(meta)) throw fault('caller_unqualified', { reason: 'missing_meta' });
  const conversationId = meta['antigravity.google/conversation_id'];
  const rootConversationId = meta['antigravity.google/root_conversation_id'];
  const parentConversationId = meta['antigravity.google/parent_conversation_id'];
  const artifactsDir = meta['antigravity.google/artifacts_dir'];
  const progressToken = meta.progressToken;

  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) {
    throw fault('caller_unqualified', { reason: 'invalid_conversation_id' });
  }
  if (typeof rootConversationId !== 'string' || !UUID_RE.test(rootConversationId)) {
    throw fault('caller_unqualified', { reason: 'invalid_root_conversation_id' });
  }
  if ((parentConversationId !== undefined && parentConversationId !== null && parentConversationId !== '') ||
      conversationId.toLowerCase() !== rootConversationId.toLowerCase()) {
    throw fault('caller_subagent_refused', { reason: 'subagent_not_permitted' });
  }
  if (artifactsDir !== undefined &&
      (typeof artifactsDir !== 'string' || !artifactsDir.startsWith('/') || artifactsDir.includes('..') || /[\u0000-\u001f\u007f]/u.test(artifactsDir))) {
    throw fault('caller_unqualified', { reason: 'invalid_artifacts_dir' });
  }
  return {
    conversationId: conversationId.toLowerCase(),
    rootConversationId: rootConversationId.toLowerCase(),
    artifactsDir: typeof artifactsDir === 'string' ? resolve(artifactsDir) : undefined,
    progressToken: typeof progressToken === 'string' || typeof progressToken === 'number' ? String(progressToken) : undefined,
  };
}

export function defaultBrainRoots(home = homedir()) {
  return [
    resolve(join(home, '.gemini', 'antigravity', 'brain')),
    resolve(join(home, '.gemini', 'antigravity-cli', 'brain')),
  ];
}

function verifyRealLogsDir(candidatePath, root, id) {
  try {
    const realRoot = realpathSync(root);
    const expectedLogs = resolve(join(realRoot, id, '.system_generated', 'logs'));
    const realParent = realpathSync(dirname(candidatePath));
    return normCase(realParent) === normCase(expectedLogs);
  } catch {
    return false;
  }
}

export function verifyTranscriptPath(conversationId, candidatePath, { brainRoots = defaultBrainRoots() } = {}) {
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) return null;
  if (typeof candidatePath !== 'string' || !candidatePath.startsWith('/')) return null;
  const normalized = resolve(candidatePath);
  const idVariants = new Set([conversationId.toLowerCase(), conversationId]);
  for (const root of brainRoots) {
    for (const id of idVariants) {
      const convDir = resolve(join(root, id));
      for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
        const allowed = resolve(join(convDir, '.system_generated', 'logs', file));
        if (normCase(normalized) === normCase(allowed) && verifyRealLogsDir(normalized, root, id)) {
          return normalized;
        }
      }
    }
  }
  return null;
}

export function locateTranscriptPath(conversationId, { transcriptPath, artifactsDir, brainRoots = defaultBrainRoots() } = {}) {
  if (typeof conversationId !== 'string' || !UUID_RE.test(conversationId)) return null;
  if (transcriptPath) {
    return verifyTranscriptPath(conversationId, transcriptPath, { brainRoots });
  }
  if (artifactsDir) {
    for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const candidate = join(artifactsDir, '.system_generated', 'logs', file);
      const verified = verifyTranscriptPath(conversationId, candidate, { brainRoots });
      if (verified) {
        try {
          const fd = openSync(verified, fsConstants.O_RDONLY | O_NOFOLLOW);
          closeSync(fd);
          return verified;
        } catch {}
      }
    }
  }
  const idLower = conversationId.toLowerCase();
  for (const root of brainRoots) {
    for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
      const candidate = join(root, idLower, '.system_generated', 'logs', file);
      if (!verifyRealLogsDir(candidate, root, idLower)) continue;
      try {
        const fd = openSync(candidate, fsConstants.O_RDONLY | O_NOFOLLOW);
        closeSync(fd);
        return candidate;
      } catch {}
    }
  }
  return null;
}

export function readTranscriptSteps(transcriptPath, { fromByteOffset = 0 } = {}) {
  if (!transcriptPath) return { ok: false, reason: 'transcript_missing', steps: [], byteLength: 0 };
  let fd;
  try {
    fd = openSync(transcriptPath, fsConstants.O_RDONLY | O_NOFOLLOW);
    const st = fstatSync(fd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!st.isFile() || st.nlink !== 1 || (uid !== null && st.uid !== uid)) {
      return { ok: false, reason: 'transcript_untrusted', steps: [], byteLength: 0 };
    }
    const buf = readFileSync(fd);
    let start = Math.max(0, Math.min(fromByteOffset, buf.length));
    // If preOffset landed mid-line during a concurrent flush, skip to the next newline boundary.
    if (start > 0 && start < buf.length && buf[start - 1] !== 0x0a) {
      const nextNl = buf.indexOf(0x0a, start);
      start = nextNl < 0 ? buf.length : nextNl + 1;
    }
    const slice = buf.subarray(start).toString('utf8');
    const lines = slice.split('\n');
    const steps = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (isPlainObject(parsed)) steps.push(parsed);
      } catch {
        // Only tolerate a partial trailing line being flushed; any mid-file corruption fails closed.
        if (i < lines.length - 1) {
          return { ok: false, reason: 'transcript_corrupt', steps: [], byteLength: buf.length };
        }
      }
    }
    return { ok: true, steps, byteLength: buf.length };
  } catch (error) {
    return { ok: false, reason: error?.code === 'ELOOP' ? 'transcript_symlink' : 'transcript_unreadable', steps: [], byteLength: 0 };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

export function stepNumber(step, fallbackIdx) {
  return Number.isSafeInteger(step?.step_index) ? step.step_index : fallbackIdx;
}

export function isRemoteTouchStep(step) {
  if (!isPlainObject(step)) return false;
  if (step.type === 'SYSTEM_MESSAGE') {
    const text = extractStepText(step.content);
    if (text && text.includes(REMOTE_ENVELOPE_MARKER)) return true;
  }
  if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT' && hasSidecarWakeMarker(step.content)) {
    return true;
  }
  return false;
}

/**
 * Mark a conversation turn as remote-tainted in durable state.
 */
export function markRemoteTaint(store, conversationId, { reason, transcriptPath, artifactsDir, brainRoots } = {}) {
  const located = locateTranscriptPath(conversationId, { transcriptPath, artifactsDir, brainRoots });
  const parsed = located ? readTranscriptSteps(located) : { ok: false, steps: [] };
  let highestStep = -1;
  if (parsed.ok && parsed.steps.length > 0) {
    highestStep = stepNumber(parsed.steps[parsed.steps.length - 1], parsed.steps.length - 1);
  }
  const nowIso = new Date().toISOString();
  store.updateChat(conversationId, (chat) => {
    const prev = chat.taint ?? { tainted: false, lastRemoteTouchStepIndex: -1, lastRemoteTouchAt: null, lastClearedUserStepIndex: -1, reason: null };
    chat.taint = {
      tainted: true,
      lastRemoteTouchStepIndex: Math.max(prev.lastRemoteTouchStepIndex ?? -1, highestStep),
      lastRemoteTouchAt: nowIso,
      lastClearedUserStepIndex: prev.lastClearedUserStepIndex ?? -1,
      reason: reason ?? 'remote_touch',
      ...(prev.activeWake === true && { activeWake: true }),
    };
    return chat;
  });
  store.syncTaintedFlag();
}

/**
 * Fail-closed authority evaluation directly inside MCP server or hooks.
 * Defaults to untrusted whenever transcript cannot be verified or no fresh monotonic USER_EXPLICIT
 * step strictly newer than the last remote touch is present.
 */
export function evaluateTurnAuthority(store, conversationId, { transcriptPath, artifactsDir, brainRoots } = {}) {
  const chat = store.readChat(conversationId);
  const taint = chat.taint ?? { tainted: false, lastRemoteTouchStepIndex: -1, lastRemoteTouchAt: null, lastClearedUserStepIndex: -1 };
  if (taint.activeWake === true) {
    return { authority: 'untrusted', tainted: true, reason: 'acp_wake_in_progress' };
  }
  const located = locateTranscriptPath(conversationId, { transcriptPath, artifactsDir, brainRoots });
  if (!located) {
    return { authority: 'untrusted', tainted: true, reason: 'transcript_unavailable' };
  }
  const parsed = readTranscriptSteps(located);
  if (!parsed.ok) {
    return { authority: 'untrusted', tainted: true, reason: parsed.reason };
  }

  let latestUserStep = -1;
  let latestUserTime = null;
  let latestRemoteStep = taint.lastRemoteTouchStepIndex ?? -1;

  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const idx = stepNumber(step, i);
    if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT' && !isSidecarWakeInput(step.content)) {
      if (idx > latestUserStep) {
        latestUserStep = idx;
        latestUserTime = typeof step.created_at === 'string' ? step.created_at : null;
      }
    }
    if (isRemoteTouchStep(step)) {
      if (idx > latestRemoteStep) latestRemoteStep = idx;
    }
  }

  if (latestUserStep < 0) {
    return { authority: 'untrusted', tainted: true, reason: 'no_owner_input' };
  }

  if (latestRemoteStep >= latestUserStep) {
    if (!taint.tainted || latestRemoteStep > (taint.lastRemoteTouchStepIndex ?? -1)) {
      store.updateChat(conversationId, (c) => {
        c.taint = {
          ...(c.taint ?? {}),
          tainted: true,
          lastRemoteTouchStepIndex: latestRemoteStep,
          lastRemoteTouchAt: c.taint?.lastRemoteTouchAt ?? new Date().toISOString(),
          reason: c.taint?.reason ?? 'transcript_remote_touch',
        };
        return c;
      });
      store.syncTaintedFlag();
    }
    return { authority: 'untrusted', tainted: true, reason: 'remote_tainted_turn' };
  }

  // When previously tainted, fail closed unless BOTH monotonic step index AND valid timestamp prove a fresh owner turn.
  if (taint.tainted) {
    if (!latestUserTime || !taint.lastRemoteTouchAt) {
      return { authority: 'untrusted', tainted: true, reason: 'owner_input_timestamp_unverified' };
    }
    const userMs = Date.parse(latestUserTime);
    const remoteMs = Date.parse(taint.lastRemoteTouchAt);
    // Antigravity transcript timestamps use 1-second resolution; fail closed on equal truncated seconds.
    const remoteSecMs = Math.floor(remoteMs / 1000) * 1000;
    const isWholeSecondUser = userMs % 1000 === 0;
    const predates = isWholeSecondUser ? userMs <= remoteSecMs : userMs <= remoteMs;
    if (!Number.isFinite(userMs) || !Number.isFinite(remoteMs) || predates) {
      return { authority: 'untrusted', tainted: true, reason: 'owner_input_predates_remote_touch' };
    }
    let concurrentTaint = false;
    store.updateChat(conversationId, (c) => {
      const cur = c.taint ?? {};
      // Re-verify under lock so a concurrent markRemoteTaint() from a parallel tool call is never clobbered.
      if (cur.tainted === true &&
          ((cur.lastRemoteTouchStepIndex ?? -1) > (taint.lastRemoteTouchStepIndex ?? -1) ||
           (cur.lastRemoteTouchAt && cur.lastRemoteTouchAt !== taint.lastRemoteTouchAt))) {
        concurrentTaint = true;
        return c;
      }
      c.taint = {
        ...cur,
        tainted: false,
        lastClearedUserStepIndex: latestUserStep,
        reason: null,
      };
      return c;
    });
    if (concurrentTaint) {
      return { authority: 'untrusted', tainted: true, reason: 'remote_tainted_turn' };
    }
    store.syncTaintedFlag();
  }

  return { authority: 'owner', tainted: false, latestUserStepIndex: latestUserStep, steps: parsed.steps };
}
