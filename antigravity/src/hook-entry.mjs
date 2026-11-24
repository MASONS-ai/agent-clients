import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG } from './build-config.mjs';
import {
  canonicalizePath,
  defaultBrainRoots,
  evaluateTurnAuthority,
  isPathRelated,
  isPathUnder,
  locateTranscriptPath,
  markRemoteTaint,
} from './caller.mjs';
import { canonicalStateRoot } from './channel.mjs';
import { antigravityDeclaration } from './declaration.mjs';
import { readSettings } from './owner.mjs';
import { computeReplyTo, renderInboundEnvelope, verifyPresentedInTranscript } from './presentation.mjs';
import { Services, closeSharedAgents } from './services.mjs';
import { StateStore } from './store.mjs';

const MAX_PRESENTATION_ATTEMPTS = 3;
const HOOK_REQUEST_TIMEOUT_MS = 3000;
const HOOK_RECONCILE_BUDGET_MS = 4500;
const DEFAULT_PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const READONLY_MASONS_TOOLS = new Set([
  'masons_send',
  'masons_look',
  'masons_status',
]);
const READONLY_CONNECTION_OPS = new Set(['list', 'list_requests']);
const OWNER_ONLY_MASONS_TOOLS = new Set([
  'masons_link',
  'masons_choose_session',
  'masons_connections',
]);
const BUILTIN_FS_AND_SHELL_TOOLS = new Set([
  'run_command',
  'read_file',
  'view_file',
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'list_dir',
  'find_by_name',
  'grep_search',
]);
const WRITE_AND_SHELL_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'run_command',
]);
const SHELL_PROTECTED_RE = /\.?masons-antigravity|masons_rt_v1_|transcript(?:_full)?\.jsonl|tainted\.flag|hooks-active|\.agents[/\\]+(?:\.[/\\]+)*(?:hooks|mcp_config)\.json|\.gemini[/\\]+(?:config|antigravity(?:-cli)?)[/\\]+(?:hooks|mcp_config|plugins)|\.system_generated[/\\]+logs|PLUGIN_ROOT/iu;
const SHELL_HOME_OBFUSCATION_RE = /\$(?:\{?HOME\}?|~)|~\/|\b(?:homedir|expanduser)\s*\(|\b(?:cat|head|tail|less|more|grep|rg|awk|sed|dd|cp|rm|mv|tee|jq|find|tar|base64|xxd|od|python3?|node|perl|ruby|sh|zsh|bash)\b.*(?:\.masons|\.gemini|\.agents)|(?:^|[;&|\n])\s*cd\s*(?:$|[;&|\n])/isu;

function parseMasonsArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function extractMasonsTool(toolCall, config) {
  const name = toolCall?.name;
  const args = toolCall?.args ?? {};
  const serverName = `${config.identity}_${config.serverKey}`;
  const eagerPrefix = `mcp_${serverName}_`;

  if (typeof name === 'string' && name.startsWith(eagerPrefix)) {
    return { tool: name.slice(eagerPrefix.length), args: parseMasonsArgs(args) };
  }
  if (name === 'call_mcp_tool' && args?.ServerName === serverName && typeof args?.ToolName === 'string') {
    return { tool: args.ToolName, args: parseMasonsArgs(args.Arguments ?? {}) };
  }
  return null;
}

function resolveCandidatePath(raw, { cwd, home }) {
  if (typeof raw !== 'string') return null;
  let trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('file://')) {
    try { trimmed = fileURLToPath(trimmed); } catch { return null; }
  }
  if (trimmed === '~') return resolve(home);
  if (trimmed.startsWith('~/')) return resolve(join(home, trimmed.slice(2)));
  if (trimmed.startsWith('/')) return resolve(trimmed);
  if (cwd) return resolve(cwd, trimmed);
  return null;
}

// Keys that carry pure document/edit/query body text rather than filesystem paths.
// Every other key at any nesting depth is scanned as a potential path (fail-closed).
const CONTENT_ARG_KEYS = new Set([
  'CodeContent', 'Content', 'content',
  'ReplacementContent', 'TargetContent', 'Target', 'Replacement',
  'old_string', 'new_string', 'OldString', 'NewString', 'old_text', 'new_text',
  'Query', 'query', 'Summary', 'Description', 'Instruction', 'text', 'toolSummary',
]);
const SEARCH_DIR_TOOLS = new Set(['list_dir', 'find_by_name', 'grep_search']);

function collectStringValues(input, out = []) {
  if (typeof input === 'string') out.push(input);
  else if (Array.isArray(input)) for (const v of input) collectStringValues(v, out);
  else if (input && typeof input === 'object') for (const v of Object.values(input)) collectStringValues(v, out);
  return out;
}

function collectPathValues(toolName, args, effectiveCwd) {
  if (!args || typeof args !== 'object') return collectStringValues(args);
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      if (node.trim()) out.push(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (CONTENT_ARG_KEYS.has(k)) continue;
        walk(v);
      }
    }
  };
  walk(args);

  // Resolve traversal/path-like glob filters (Includes / Pattern) against explicit search dir too.
  const searchBase = typeof args.SearchDirectory === 'string' && args.SearchDirectory.trim()
    ? args.SearchDirectory.trim()
    : typeof args.SearchPath === 'string' && args.SearchPath.trim()
      ? args.SearchPath.trim()
      : null;
  if (searchBase) {
    for (const key of ['Includes', 'Pattern', 'includes', 'pattern']) {
      for (const item of collectStringValues(args[key])) {
        if (/[/\\~]|\.\./u.test(item)) {
          out.push(resolve(searchBase, item));
        }
      }
    }
  }

  // Directory/search tools default to cwd when no explicit path argument is given.
  if (SEARCH_DIR_TOOLS.has(toolName) && effectiveCwd) {
    const hasExplicitPath = ['Path', 'DirectoryPath', 'SearchPath', 'SearchDirectory', 'path', 'dir', 'directory', 'directory_path', 'search_path', 'search_directory']
      .some((k) => typeof args[k] === 'string' && args[k].trim());
    if (!hasExplicitPath) out.push(effectiveCwd);
  }
  return out;
}

function isSystemTranscriptLogPath(canon, brainRoots) {
  for (const br of brainRoots) {
    if (!isPathUnder(canon, br)) continue;
    const rel = canon.slice(br.length).replace(/^[/\\]+/u, '');
    if (!rel) return true; // Exact brainRoot itself
    // Match <convId>/.system_generated or <convId>/.system_generated/logs/...
    if (/^[^/\\]+[/\\]+\.system_generated(?:$|[/\\])/iu.test(rel)) return true;
  }
  return false;
}

function checkProtectedPaths(toolName, args, {
  home,
  cwd,
  workspacePaths = [],
  pluginRoot,
  brainRoots,
  tainted,
}) {
  const effectiveCwd = cwd || workspacePaths[0] || '';
  const values = toolName === 'run_command' ? collectStringValues(args) : collectPathValues(toolName, args, effectiveCwd);
  const masonsRoot = resolve(home, '.masons-antigravity');
  const isWriteOrShell = WRITE_AND_SHELL_TOOLS.has(toolName);
  const allBrainRoots = (brainRoots ?? defaultBrainRoots(home)).map((br) => canonicalizePath(br));
  const resolvedPluginRoot = pluginRoot ? canonicalizePath(pluginRoot) : canonicalizePath(DEFAULT_PLUGIN_ROOT);

  if (toolName === 'run_command') {
    for (const val of values) {
      if (SHELL_PROTECTED_RE.test(val)) {
        return 'Protected MASONS state, transcripts, and hook/MCP/plugin config cannot be accessed via shell commands.';
      }
      if (tainted && SHELL_HOME_OBFUSCATION_RE.test(val)) {
        return 'Shell access targeting home dot-directories is blocked on remote-tainted turns.';
      }
    }
    return null;
  }

  const alwaysProtectedWriteRoots = [
    canonicalizePath(resolve(home, '.gemini', 'config', 'plugins')),
    canonicalizePath(resolve(home, '.gemini', 'antigravity', 'plugins')),
    canonicalizePath(resolve(home, '.gemini', 'config', 'hooks.json')),
    canonicalizePath(resolve(home, '.gemini', 'config', 'mcp_config.json')),
    canonicalizePath(resolve(home, '.gemini', 'antigravity', 'hooks.json')),
    canonicalizePath(resolve(home, '.gemini', 'antigravity', 'mcp_config.json')),
    canonicalizePath(resolve(home, '.gemini', 'antigravity-cli', 'hooks.json')),
    canonicalizePath(resolve(home, '.gemini', 'antigravity-cli', 'mcp_config.json')),
    resolvedPluginRoot,
  ];
  const taintedWorkspaceConfigPaths = [];
  for (const ws of workspacePaths) {
    if (typeof ws === 'string' && ws.startsWith('/')) {
      taintedWorkspaceConfigPaths.push(canonicalizePath(resolve(ws, '.agents', 'hooks.json')));
      taintedWorkspaceConfigPaths.push(canonicalizePath(resolve(ws, '.agents', 'mcp_config.json')));
    }
  }
  if (effectiveCwd) {
    taintedWorkspaceConfigPaths.push(canonicalizePath(resolve(effectiveCwd, '.agents', 'hooks.json')));
    taintedWorkspaceConfigPaths.push(canonicalizePath(resolve(effectiveCwd, '.agents', 'mcp_config.json')));
  }

  for (const raw of values) {
    // Always protect MASONS token store from reads/writes and system transcripts/plugins from writes.
    if (/\.masons-antigravity/iu.test(raw)) {
      return 'Protected MASONS state directory (~/.masons-antigravity) cannot be accessed.';
    }
    if (/^~[^/\\]+(?:$|[/\\])/u.test(raw.trim())) {
      return 'Tilde-user home paths are blocked for protected-path safety.';
    }
    const resolved = resolveCandidatePath(raw, { cwd: effectiveCwd, home });
    if (resolved) {
      const canon = canonicalizePath(resolved);
      if (isPathRelated(canon, masonsRoot)) {
        return 'Protected MASONS state directory (~/.masons-antigravity) cannot be accessed.';
      }
      // Always block writes/edits into Antigravity .system_generated logs (prevents USER_EXPLICIT forgery)
      // while allowing normal Artifacts (task.md, implementation_plan.md, scratch/) under brain/<convId>/.
      if (isWriteOrShell && isSystemTranscriptLogPath(canon, allBrainRoots)) {
        return 'Antigravity conversation transcript directories cannot be modified by tool calls.';
      }
      // Always block writes/edits to installed plugin files and global hook/MCP configs.
      if (isWriteOrShell) {
        for (const cfg of alwaysProtectedWriteRoots) {
          if (isPathUnder(canon, cfg) || isPathUnder(cfg, canon)) {
            return 'Protected plugin, hook, or MCP configuration files cannot be modified by tool calls.';
          }
        }
      }
      if (tainted) {
        // Block scanning ~ or brainRoot ancestors or .system_generated logs on tainted turns; allow normal Artifacts.
        if (isSystemTranscriptLogPath(canon, allBrainRoots) || allBrainRoots.some((br) => isPathUnder(br, canon))) {
          return 'Antigravity system transcript directories cannot be scanned or modified on remote-tainted turns.';
        }
        if (isWriteOrShell) {
          for (const cfg of taintedWorkspaceConfigPaths) {
            if (isPathUnder(canon, cfg) || isPathUnder(cfg, canon)) {
              return 'Protected hook or MCP configuration files cannot be modified on remote-tainted turns.';
            }
          }
          if (/(?:^|[/\\])\.agents(?:[/\\]+(?:\.[/\\]+)*)(?:hooks|mcp_config)\.json$/iu.test(canon)) {
            return 'Hook and MCP configuration files (.agents/hooks.json, .agents/mcp_config.json) cannot be modified on remote-tainted turns.';
          }
        }
      }
    } else {
      if (isWriteOrShell && /(?:^|[\s/"'])(?:\.gemini|\.system_generated)(?:$|[/\\])/iu.test(raw)) {
        return 'Protected Antigravity configuration or transcript paths cannot be modified by tool calls.';
      }
      if (tainted && isWriteOrShell && /(?:^|[\s/"'])\.agents[/\\]+(?:\.[/\\]+)*(?:hooks|mcp_config)\.json/iu.test(raw)) {
        return 'Hook and MCP configuration files (.agents/hooks.json, .agents/mcp_config.json) cannot be modified on remote-tainted turns.';
      }
    }
  }

  return null;
}

function fileSizeOrZero(path) {
  if (!path) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

async function postPresentedReceipt(config, store, conversationId, row, makeServices, { signal } = {}) {
  const held = readSettings(store);
  const chat = store.readChat(conversationId);
  const reg = chat.registration;
  if (!held.credential?.token || !held.credential?.node || reg?.state !== 'active' || !reg.response?.endpoint_id) {
    return false;
  }
  const expectedEpId = reg.response.endpoint_id;
  // Post presented under the Session's current active registration even after endpoint rotation.
  const api = makeServices(held.credential);
  try {
    await api.postReceipt(reg, {
      act: 'presented',
      messageRef: row.frame.message_ref,
      contentDigest: row.frame.content_digest,
      endpointId: expectedEpId,
      endpointNonce: reg.nonce,
    }, { signal });
    return true;
  } catch (error) {
    if (error?.status === 409 && (error?.code === 'not_driver' || error?.code === 'endpoint_unavailable')) {
      try {
        const declaration = antigravityDeclaration({
          idleWakeup: reg.response?.background_exchange_mode === 'adapter_managed_turn',
        });
        await api.inspectEndpoint(reg, { declaration, signal });
      } catch (inspectErr) {
        if (inspectErr?.code === 'registration_superseded') {
          store.updateChat(conversationId, (c) => {
            // Only fence if the inspected endpoint is still the active registration (never clobber a newer rotation).
            if (c.registration?.response?.endpoint_id === expectedEpId) {
              c.registration = { ...c.registration, state: 'fenced', reason: 'registration_superseded' };
            }
            return c;
          });
        } else if (inspectErr?.code === 'registration_retired') {
          store.updateChat(conversationId, (c) => {
            if (c.registration?.response?.endpoint_id === expectedEpId && c.registration.state !== 'fenced') {
              c.registrationHistory ??= [];
              c.registrationHistory.push({ ...c.registration, terminalOutcome: inspectErr.registration });
              c.registration = null;
            }
            return c;
          });
        }
      }
    }
    return false;
  }
}

/**
 * Reconcile any in_flight inbox rows using JSONL transcript verification, and retry any
 * previously stranded unacked presented receipts within the hook's strict time budget.
 */
export async function reconcileInFlight({
  config,
  store,
  conversationId,
  transcriptPath,
  artifactsDir,
  brainRoots,
  makeServices = (cred) => new Services({ api: config.api, credential: cred, requestTimeoutMs: HOOK_REQUEST_TIMEOUT_MS }),
}) {
  const budgetSignal = AbortSignal.timeout(HOOK_RECONCILE_BUDGET_MS);
  const chat = store.readChat(conversationId);
  const inFlight = (chat.inbox ?? []).filter((r) => r.phase === 'in_flight');
  const located = inFlight.length > 0
    ? locateTranscriptPath(conversationId, { transcriptPath, artifactsDir, brainRoots })
    : null;
  const cred = readSettings(store).credential;

  for (const row of inFlight) {
    const check = located
      ? verifyPresentedInTranscript(located, {
        preOffset: row.preOffset ?? 0,
        expectedText: row.renderedText,
        requirePlannerComplete: true,
      })
      : { verified: false, sawSystemMessage: false };

    if (check.verified) {
      if (row.oversized) {
        store.updateChat(conversationId, (c) => {
          const item = c.inbox.find((r) => r.frame.message_ref === row.frame.message_ref);
          if (item && item.phase === 'in_flight' && item.preOffset === row.preOffset) {
            item.phase = 'awaiting_full_read';
            delete item.renderedText;
          }
          return c;
        });
        continue;
      }

      // Commit phase='presented' atomically BEFORE posting receipt to prevent concurrent double-reconcile.
      let claimed = false;
      store.updateChat(conversationId, (c) => {
        const item = c.inbox.find((r) => r.frame.message_ref === row.frame.message_ref);
        if (item && item.phase === 'in_flight' && item.preOffset === row.preOffset) {
          item.phase = 'presented';
          item.presentedAcked = false;
          delete item.renderedText;
          claimed = true;
        }
        return c;
      });
      if (!claimed) continue;

      if (cred?.node) store.recordDedupe(cred.node, row.frame.message_ref);
      if (!budgetSignal.aborted) {
        const posted = await postPresentedReceipt(config, store, conversationId, row, makeServices, { signal: budgetSignal });
        if (posted) {
          store.updateChat(conversationId, (c) => {
            const item = c.inbox.find((r) => r.frame.message_ref === row.frame.message_ref);
            if (item) item.presentedAcked = true;
            return c;
          });
        }
      }
    } else {
      store.updateChat(conversationId, (c) => {
        const item = c.inbox.find((r) => r.frame.message_ref === row.frame.message_ref);
        if (!item || item.phase !== 'in_flight' || item.preOffset !== row.preOffset) return c;
        item.attempts = (item.attempts ?? 0) + 1;
        // Mark possibleRepeat only if the system message may have been placed.
        item.possibleRepeat = Boolean(item.possibleRepeat || check.sawSystemMessage);
        delete item.renderedText;
        if (item.attempts >= MAX_PRESENTATION_ATTEMPTS) {
          item.phase = 'dead_letter';
          item.deadLetterNoticed = false;
        } else {
          item.phase = 'pending';
        }
        return c;
      });
    }
  }

  // Opportunistically retry any previously stranded unacked presented receipts within remaining hook budget.
  if (!budgetSignal.aborted) {
    const unacked = (store.readChat(conversationId).inbox ?? [])
      .filter((r) => r.phase === 'presented' && !r.presentedAcked)
      .slice(-4);
    for (const row of unacked) {
      if (budgetSignal.aborted) break;
      const posted = await postPresentedReceipt(config, store, conversationId, row, makeServices, { signal: budgetSignal });
      if (posted) {
        store.updateChat(conversationId, (c) => {
          const item = c.inbox.find((r) => r.frame.message_ref === row.frame.message_ref);
          if (item) item.presentedAcked = true;
          return c;
        });
      }
    }
  }
}

function isConversationOrAncestorTainted(store, payload, { brainRoots }) {
  const ids = [
    payload?.conversationId,
    payload?.parentConversationId,
    payload?.rootConversationId,
  ].filter((id) => typeof id === 'string' && id.trim()).map((id) => id.toLowerCase());

  if (ids.length === 0) {
    // Fail closed if tainted.flag is active and caller has no identifiable conversationId.
    return Boolean(store.readJson('tainted.flag', null)?.tainted);
  }

  // If any conversation in the lineage (self, parent, or root) is tainted, inherit taint.
  for (const id of new Set(ids)) {
    const chat = store.readChat(id);
    if (chat.taint?.tainted === true || chat.taint?.activeWake === true) {
      const auth = evaluateTurnAuthority(store, id, {
        transcriptPath: id === payload?.conversationId?.toLowerCase() ? payload.transcriptPath : undefined,
        artifactsDir: id === payload?.conversationId?.toLowerCase() ? payload.artifactDirectoryPath : undefined,
        brainRoots,
      });
      if (auth.tainted) return true;
    }
  }

  // If tainted.flag exists and caller looks like a subagent without a rootConversationId, fail closed.
  if (store.readJson('tainted.flag', null)?.tainted === true &&
      payload?.parentConversationId && !payload?.rootConversationId) {
    return true;
  }

  return false;
}

export async function handleHookEvent(event, payload, {
  config = CONFIG,
  store,
  brainRoots,
  home = homedir(),
  pluginRoot = process.env.PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT,
  makeServices = (cred) => new Services({ api: config.api, credential: cred, requestTimeoutMs: HOOK_REQUEST_TIMEOUT_MS }),
} = {}) {
  const conversationId = typeof payload?.conversationId === 'string'
    ? payload.conversationId.toLowerCase()
    : '';
  const transcriptPath = payload?.transcriptPath;
  const artifactsDir = payload?.artifactDirectoryPath;

  if (event === 'pre-tool-use') {
    const toolCall = payload?.toolCall ?? {};
    const masonsCall = extractMasonsTool(toolCall, config);
    if (masonsCall) {
      // Refuse subagents mechanically in PreToolUse as well (defense-in-depth with MCP qualifyMcpCaller).
      const rootId = typeof payload?.rootConversationId === 'string' ? payload.rootConversationId.toLowerCase() : '';
      if (payload?.parentConversationId || (rootId && conversationId && rootId !== conversationId)) {
        return { decision: 'deny', reason: 'Subagents are not permitted to invoke MASONS tools.' };
      }
      if (READONLY_MASONS_TOOLS.has(masonsCall.tool)) {
        return { decision: 'auto_approve' };
      }
      if (masonsCall.tool === 'masons_profile') {
        if (!masonsCall.args || !['inspect', 'update'].includes(masonsCall.args.operation)) {
          return { decision: 'deny', reason: 'Malformed masons_profile arguments.' };
        }
        if (masonsCall.args.operation === 'inspect') {
          return { decision: 'auto_approve' };
        }
        if (!conversationId) {
          return { decision: 'deny', reason: 'Cannot verify owner authority without conversationId.' };
        }
        const auth = evaluateTurnAuthority(store, conversationId, { transcriptPath, artifactsDir, brainRoots });
        if (auth.authority !== 'owner') {
          return {
            decision: 'deny',
            reason: `Owner-only MASONS action (masons_profile update) is blocked on remote-tainted or unverified turns (${auth.reason}).`,
          };
        }
        return { decision: 'auto_approve' };
      }
      if (masonsCall.tool === 'masons_connections' && masonsCall.args &&
          READONLY_CONNECTION_OPS.has(masonsCall.args.operation)) {
        return { decision: 'auto_approve' };
      }
      if (OWNER_ONLY_MASONS_TOOLS.has(masonsCall.tool)) {
        if (!conversationId) {
          return { decision: 'deny', reason: 'Cannot verify owner authority without conversationId.' };
        }
        if (masonsCall.tool === 'masons_connections' && !masonsCall.args) {
          return { decision: 'deny', reason: 'Malformed masons_connections arguments.' };
        }
        const auth = evaluateTurnAuthority(store, conversationId, { transcriptPath, artifactsDir, brainRoots });
        if (auth.authority !== 'owner') {
          return {
            decision: 'deny',
            reason: `Owner-only MASONS action (${masonsCall.tool}) is blocked on remote-tainted or unverified turns (${auth.reason}).`,
          };
        }
        // Clean verified owner turn: auto-approve to avoid redundant MCP confirmation friction
        // (masons_link still requires explicit owner confirmation in the browser handoff page).
        return { decision: 'auto_approve' };
      }
      // Fail closed on unknown MASONS tools.
      return { decision: 'deny', reason: `Unknown MASONS tool (${masonsCall.tool}).` };
    }

    if (BUILTIN_FS_AND_SHELL_TOOLS.has(toolCall.name)) {
      const parsedArgs = parseMasonsArgs(toolCall.args ?? {});
      if (typeof toolCall.args === 'string' && !parsedArgs) {
        return { decision: 'deny', reason: 'Malformed tool arguments.' };
      }
      const effectiveArgs = parsedArgs ?? toolCall.args ?? {};
      const tainted = isConversationOrAncestorTainted(store, payload, { brainRoots });
      const violation = checkProtectedPaths(toolCall.name, effectiveArgs, {
        home,
        cwd: payload?.cwd,
        workspacePaths: Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [],
        pluginRoot,
        brainRoots,
        tainted,
      });
      if (violation) {
        return { decision: 'deny', reason: violation };
      }
      // On remote-tainted turns, require explicit owner approval for unsandboxed shell commands.
      if (tainted && toolCall.name === 'run_command' && effectiveArgs?.BypassSandbox === true) {
        return { decision: 'ask', reason: 'Unsandboxed shell command requested on a remote-tainted turn.' };
      }
    }
    return { decision: 'allow' };
  }

  if (!conversationId) return {};

  if (event === 'pre-invocation') {
    await reconcileInFlight({ config, store, conversationId, transcriptPath, artifactsDir, brainRoots, makeServices });

    const located = locateTranscriptPath(conversationId, { transcriptPath, artifactsDir, brainRoots });
    const preOffset = fileSizeOrZero(located);

    // Check for any unannounced dead-lettered messages first so the principal is notified.
    let deadLetterNotice = null;
    let claimed = null;
    store.updateChat(conversationId, (c) => {
      const dead = (c.inbox ?? []).find((r) => r.phase === 'dead_letter' && r.deadLetterNoticed === false);
      if (dead) {
        dead.deadLetterNoticed = true;
        deadLetterNotice = `[MASONS NOTICE]\nAn inbound ${config.label} message could not be confirmed as delivered into context after ${MAX_PRESENTATION_ATTEMPTS} attempts and has been set aside. Inform your principal.\n[END MASONS NOTICE]`;
      }

      const pending = (c.inbox ?? []).find((r) => r.phase === 'pending');
      if (!pending) return c;
      const conv = (c.conversations ?? []).find((x) => x.conversation_ref === pending.frame.subject.conversation_ref);
      const replyTo = computeReplyTo(pending.frame, conv);
      const rendered = renderInboundEnvelope(pending.frame, {
        networkLabel: config.label,
        replyTo,
        possibleRepeat: pending.possibleRepeat === true,
      });
      pending.phase = 'in_flight';
      pending.preOffset = preOffset;
      pending.oversized = rendered.oversized;
      pending.renderedText = rendered.text;
      claimed = rendered;
      return c;
    });

    if (claimed) {
      const remaining = (store.readChat(conversationId).inbox ?? []).some((r) => r.phase === 'pending');
      if (!remaining) store.clearWakeTrigger(conversationId);
    }

    const injectSteps = [];
    if (deadLetterNotice) {
      injectSteps.push({ systemMessage: { systemMessage: deadLetterNotice } });
    }
    if (claimed) {
      markRemoteTaint(store, conversationId, {
        reason: 'pre_invocation_inbound',
        transcriptPath: located ?? undefined,
        artifactsDir,
        brainRoots,
      });
      // Strictly plain systemMessage with NO metadata field.
      injectSteps.push({ systemMessage: { systemMessage: claimed.text } });
    }
    return injectSteps.length > 0 ? { injectSteps } : {};
  }

  if (event === 'post-invocation') {
    await reconcileInFlight({ config, store, conversationId, transcriptPath, artifactsDir, brainRoots, makeServices });
    return {};
  }

  if (event === 'stop') {
    await reconcileInFlight({ config, store, conversationId, transcriptPath, artifactsDir, brainRoots, makeServices });

    const held = readSettings(store);
    if (!held.credential?.token) return {};

    const chat = store.readChat(conversationId);
    if (chat.registration?.state === 'fenced') return {};

    const hasPending = (chat.inbox ?? []).some((r) => r.phase === 'pending');
    if (payload?.terminationReason !== 'NO_TOOL_CALL' || payload?.executionNum !== 0) {
      // Turn is ending without continuation (e.g. >=3-message burst or Stop(ERROR) revert):
      // re-arm host-scoped wake trigger so Sidecar wakes a fresh turn for remaining pending messages.
      if (hasPending && chat.hostProvenance?.hostPid) {
        try {
          store.writeWakeTrigger(conversationId, { queuedAt: Date.now(), ...chat.hostProvenance });
        } catch {}
      }
      return {};
    }

    if (hasPending) {
      markRemoteTaint(store, conversationId, {
        reason: 'stop_continue_inbound',
        transcriptPath,
        artifactsDir,
        brainRoots,
      });
      return {
        decision: 'continue',
        reason: 'New inbound MASONS message arrived during generation; delivering it now.',
      };
    }

    return {};
  }

  return {};
}

async function runCli() {
  const event = process.argv[2] ?? '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      if (event === 'pre-tool-use') {
        process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'hook_input_invalid' }) + '\n');
        return;
      }
      process.stdout.write('{}\n');
      return;
    }
  }
  const store = new StateStore(canonicalStateRoot(CONFIG));
  try {
    const result = await handleHookEvent(event, payload, { config: CONFIG, store });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    if (event === 'pre-tool-use') {
      process.stdout.write(JSON.stringify({ decision: 'deny', reason: error?.code ?? 'hook_error' }) + '\n');
    } else {
      process.stdout.write('{}\n');
    }
  } finally {
    closeSharedAgents();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runCli();
}
