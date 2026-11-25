import { extractStepText, hasSidecarWakeMarker, isRemoteTouchStep, stepNumber } from './caller.mjs';

const MAX_SCAN_CHARS = 2048;
const MAX_EXTRACT_CHARS = 8192;
const DEFAULT_MAX_CODE_POINTS = 160;

const WRAPPER_BLOCKS_RE = /<(CONTEXT_SUMMARY|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>[\s\S]*?<\/\1>/giu;
const PEM_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/giu;
const URL_CREDS_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/giu;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token|ApiKey)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const KNOWN_TOKEN_RE = /\b(?:masons_rt_v1_[A-Za-z0-9_-]{6,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}|whsec_[0-9A-Za-z]{16,}|AIza[0-9A-Za-z_-]{35}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/gu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const KV_SECRET_RE = /(["']?)([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|csrf[_-]?token|secret|password|passwd|private[_-]?key|token)[A-Za-z0-9_.-]*)\1\s*([=:])\s*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|\S+)/giu;

export function isActivityReportingDisabled(env = process.env) {
  for (const key of ['MASONS_ANTIGRAVITY_ACTIVITY', 'TASK_HINT']) {
    const val = env?.[key];
    if (typeof val === 'string' && ['0', 'false', 'off', 'no'].includes(val.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Extract the human-authored request from Antigravity's transcript USER_INPUT wrapper.
 * Strips surrounding system wrapper blocks BEFORE matching <USER_REQUEST> so summarized
 * remote content in <CONTEXT_SUMMARY> can never hijack extraction.
 */
export function extractUserRequestText(rawContent) {
  const full = extractStepText(rawContent) ?? '';
  if (!full) return '';
  const stripped = full.replace(WRAPPER_BLOCKS_RE, ' ');
  const bounded = stripped.length > MAX_EXTRACT_CHARS ? stripped.slice(0, MAX_EXTRACT_CHARS) : stripped;
  const openMatch = /<USER_REQUEST>\s*/iu.exec(bounded);
  if (openMatch) {
    const afterOpen = bounded.slice(openMatch.index + openMatch[0].length);
    const closeIdx = afterOpen.toLowerCase().lastIndexOf('</user_request>');
    return (closeIdx >= 0 ? afterOpen.slice(0, closeIdx) : afterOpen).trim();
  }
  return bounded;
}

/**
 * Redact likely secrets/tokens and cap to 160 Unicode code points (matching peer clients).
 */
export function redactActivityText(raw, maxCodePoints = DEFAULT_MAX_CODE_POINTS) {
  if (typeof raw !== 'string' || !raw.isWellFormed()) return null;
  const bounded = raw.length > MAX_SCAN_CHARS ? raw.slice(0, MAX_SCAN_CHARS) : raw;
  const scrubbed = bounded
    .replace(PEM_KEY_RE, '[REDACTED]')
    .replace(URL_CREDS_RE, '$1[REDACTED]@')
    .replace(AUTH_SCHEME_RE, '$1 [REDACTED]')
    .replace(KNOWN_TOKEN_RE, '[REDACTED]')
    .replace(JWT_RE, '[REDACTED]')
    .replace(KV_SECRET_RE, '$1$2$1$3[REDACTED]')
    .replace(/[\u0000-\u001F\u007F]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!scrubbed) return null;
  const chars = [...scrubbed];
  if (chars.length <= maxCodePoints) return scrubbed;
  return `${chars.slice(0, Math.max(1, maxCodePoints - 1)).join('').trimEnd()}…`;
}

function normalizeIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Extract the latest principal-authored USER_INPUT and (when includeAssistantReply is true
 * and strictly after the latest owner turn + all wake/inbound boundaries) the latest final
 * PLANNER_RESPONSE/DONE content from transcript steps. Never reads step.thinking.
 */
export function extractTranscriptActivity(steps, { includeAssistantReply = true } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { latestUserPrompt: null, latestAssistantReply: null };
  }

  let latestOwnerStep = null;
  let latestOwnerStepIndex = -1;
  let latestRemoteBoundaryStepIndex = -1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== 'object') continue;
    const idx = stepNumber(step, i);

    if (isRemoteTouchStep(step)) {
      if (idx > latestRemoteBoundaryStepIndex) latestRemoteBoundaryStepIndex = idx;
      continue;
    }

    if (step.source !== 'USER_EXPLICIT' || step.type !== 'USER_INPUT') continue;
    if (hasSidecarWakeMarker(step.content)) {
      if (idx > latestRemoteBoundaryStepIndex) latestRemoteBoundaryStepIndex = idx;
      continue;
    }

    if (idx > latestOwnerStepIndex) {
      latestOwnerStepIndex = idx;
      latestOwnerStep = step;
    }
  }

  // Extract and redact ONLY the winning latest owner step (O(1) regex pass).
  let latestUserPrompt = null;
  if (latestOwnerStep) {
    const observedAt = normalizeIso(latestOwnerStep.created_at);
    const text = redactActivityText(extractUserRequestText(latestOwnerStep.content));
    if (text && observedAt) {
      latestUserPrompt = { stepIndex: latestOwnerStepIndex, text, observedAt };
    }
  }

  let latestAssistantReply = null;
  if (includeAssistantReply && latestOwnerStepIndex >= 0 && latestOwnerStepIndex > latestRemoteBoundaryStepIndex) {
    let winningReplyStep = null;
    let winningReplyIdx = -1;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== 'object') continue;
      if (step.type !== 'PLANNER_RESPONSE' || step.status !== 'DONE') continue;
      // Only final visible reply content; never read step.thinking or intermediate tool-call-only steps.
      if (typeof step.content !== 'string' || !step.content.trim()) continue;
      const idx = stepNumber(step, i);
      if (idx <= latestOwnerStepIndex || idx <= latestRemoteBoundaryStepIndex) continue;
      if (idx > winningReplyIdx) {
        winningReplyIdx = idx;
        winningReplyStep = step;
      }
    }
    if (winningReplyStep) {
      const text = redactActivityText(winningReplyStep.content);
      const floorMs = latestUserPrompt ? Date.parse(latestUserPrompt.observedAt) : 0;
      let observedAt = normalizeIso(winningReplyStep.created_at);
      if (!observedAt) {
        observedAt = latestUserPrompt?.observedAt ?? null;
      } else if (floorMs > 0 && Date.parse(observedAt) < floorMs) {
        observedAt = latestUserPrompt.observedAt;
      }
      if (text && observedAt) {
        latestAssistantReply = { stepIndex: winningReplyIdx, text, observedAt };
      }
    }
  }

  return { latestUserPrompt, latestAssistantReply };
}
