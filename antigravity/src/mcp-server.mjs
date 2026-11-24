import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './build-config.mjs';
import { qualifyMcpCaller } from './caller.mjs';
import { canonicalStateRoot } from './channel.mjs';
import { SessionRuntime } from './session-runtime.mjs';
import { StateStore } from './store.mjs';

const FOREGROUND_TIMEOUT_MS = 25_000;

const ERROR_HINTS = Object.freeze({
  conversation_owned_elsewhere:
    'This conversation is currently active in another Antigravity window or surface. Close the other window or start a fresh conversation to use MASONS here.',
  conversation_read_only:
    'This conversation is read-only because the counterparty Node speaks through Sessions. Start a new conversation addressed to a live Session instead.',
  link_required:
    'This Antigravity installation is not linked yet. Ask the owner to run masons_link.',
  profile_inspect_required:
    'Call masons_profile { "operation": "inspect" } first to load the current Profile before updating it.',
  unresolved_target:
    'Target could not be resolved on this MASONS network. Verify the handle or address belongs to this deployment.',
});

export function buildToolDefinitions(config) {
  const net = config.label;
  return [
    {
      name: 'masons_send',
      description: `${net}: Send a message to a remote agent, human, or Session on ${net}, or continue an existing conversation. Non-blocking; replies arrive automatically via idle wakeup on Antigravity Desktop and Antigravity CLI.`,
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Destination: a delivered message reply_to, a handle (@alice), an MSTP address (mstps://host/alice), or a Session (Name@handle or Name@handle [code]). Omit only when continuing this session\'s single bound conversation.',
          },
          message: {
            type: 'string',
            description: 'Plain-text message body (up to 40,960 UTF-8 bytes).',
          },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
    {
      name: 'masons_look',
      description: `${net}: Read what this session can see on ${net}: oversized inbound message body, conversations, history, vacant rooms, directory nodes, reachable sessions, passive profile view, self identity & siblings, send outcome, or link state.`,
      inputSchema: {
        type: 'object',
        properties: {
          at: {
            type: 'string',
            enum: ['message', 'conversations', 'history', 'rooms', 'nodes', 'agents', 'reachable', 'profile', 'me', 'outcome', 'link'],
          },
          to: { type: 'string', description: 'Optional party, Session, or handle filter for history, reachable, or profile.' },
          self: { type: 'boolean', description: 'Set true with at: "profile" to passively view your own Node or Session profile.' },
          kind: { type: 'string', enum: ['node', 'session'], description: 'Used with self: true on at: "profile" (defaults to "node").' },
          observation: { type: 'string', enum: ['conversation', 'directory'], description: 'Optional disambiguation when a Session name matches both a conversation and directory target.' },
          with: { type: 'string', description: 'Optional counterparty filter for at: "conversations".' },
          last_from: { type: 'string', enum: ['me', 'them'], description: 'Optional last-speaker filter for at: "conversations".' },
          since: { type: 'string', description: 'Optional ISO-8601 datetime with timezone (Z or ±HH:MM) filter for at: "conversations".' },
          q: { type: 'string', description: 'Search query for nodes or agents.' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          next: { type: 'boolean', description: 'Set true to fetch the next page when a prior call returned more: true.' },
        },
        required: ['at'],
        additionalProperties: false,
      },
    },
    {
      name: 'masons_status',
      description: `${net}: Report four-part MASONS status (Link before Presence; Identity, Presence, and Client freshly read from Services).`,
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'masons_profile',
      description: `${net}: Inspect or update this Node's own ICM Profile card (display_name, update/tagline, or avatar removal). Always inspect before updating.`,
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['inspect', 'update'] },
          display_name: { type: 'string', description: 'Display name (1-40 characters) for operation: "update".' },
          update: { type: ['string', 'null'], description: 'Single-line profile update/tagline (max 80 chars), or null to clear.' },
          avatar: { type: 'string', enum: ['keep', 'remove'], description: 'Keep existing avatar (default) or remove it.' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
    },
    {
      name: 'masons_link',
      description: `${net}: Owner-only. Start, poll, cancel, or replace linking this Antigravity installation to a ${net} Node.`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'poll', 'cancel'] },
          handle: { type: 'string', description: 'Optional expected handle when linking.' },
          replace: { type: 'boolean', description: 'Set true to replace an existing pending Link handoff with a fresh one.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'masons_connections',
      description: `${net}: List established connections or pending requests, or (owner-only) request/accept/ignore/withdraw a connection.`,
      inputSchema: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['list', 'list_requests', 'request', 'accept', 'ignore', 'withdraw'] },
          to: { type: 'string', description: 'Counterparty handle.' },
          note: { type: 'string', description: 'Optional note when sending a new request (max 300 chars).' },
          next: { type: 'boolean', description: 'Set true to fetch the next page of requests when more: true.' },
        },
        required: ['operation'],
        additionalProperties: false,
      },
    },
    {
      name: 'masons_choose_session',
      description: `${net}: Owner-only. Seat this Session or a named sibling Session in one of your Node's vacant rooms.`,
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'The room sender shown by masons_look { at: "rooms" }.' },
          session: { type: 'string', description: 'Optional target Session name; omit to seat this Session.' },
          pick_code: { type: 'string', description: 'Optional 6-hex disambiguation code.' },
        },
        required: ['room'],
        additionalProperties: false,
      },
    },
  ];
}

export class McpStdioServer {
  constructor({
    config = CONFIG,
    runtime,
    input = process.stdin,
    output = process.stdout,
    foregroundTimeoutMs = FOREGROUND_TIMEOUT_MS,
  }) {
    this.config = config;
    this.runtime = runtime;
    this.input = input;
    this.output = output;
    this.foregroundTimeoutMs = foregroundTimeoutMs;
    this.tools = buildToolDefinitions(config);
    this.inflight = new Map();
    this.closed = false;
    this.shutdownPromise = null;
  }

  send(msg) {
    if (this.closed) return;
    try {
      this.output.write(JSON.stringify(msg) + '\n');
    } catch {}
  }

  sendResult(id, result) {
    this.send({ jsonrpc: '2.0', id, result });
  }

  sendError(id, code, message, data) {
    this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } });
  }

  notifyToolsListChanged() {
    this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  }

  async handleMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    const { id, method, params } = msg;

    if (id === undefined) {
      if (method === 'notifications/cancelled' && params?.requestId !== undefined) {
        const key = String(params.requestId);
        const ctrl = this.inflight.get(key);
        if (ctrl) ctrl.abort();
      }
      return;
    }

    if (method === 'server/discover') {
      this.sendResult(id, {
        protocolVersion: params?.protocolVersion ?? '2026-07-28',
        serverInfo: { name: this.config.identity, version: this.config.version },
        capabilities: { tools: { listChanged: true } },
        tools: this.tools,
      });
      return;
    }

    if (method === 'initialize') {
      const clientInfo = params?.clientInfo;
      if (clientInfo?.name || clientInfo?.version) {
        this.runtime.setHostVersion(`${clientInfo.name ?? 'antigravity'} ${clientInfo.version ?? ''}`.trim());
      }
      this.runtime.ensureStreamStarted();
      this.sendResult(id, {
        protocolVersion: params?.protocolVersion ?? '2025-11-25',
        serverInfo: { name: this.config.identity, version: this.config.version },
        capabilities: { tools: { listChanged: true } },
      });
      return;
    }

    if (method === 'ping') {
      this.sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      this.sendResult(id, { tools: this.tools });
      return;
    }

    if (method === 'tools/call') {
      const reqKey = String(id);
      const controller = new AbortController();
      this.inflight.set(reqKey, controller);
      const toolName = params?.name;
      const args = params?.arguments ?? {};

      const timer = setTimeout(() => controller.abort(), this.foregroundTimeoutMs);
      timer.unref?.();

      try {
        const caller = qualifyMcpCaller(params?._meta);
        let payload;
        if (toolName === 'masons_send') {
          payload = await this.runtime.send(caller, args, { signal: controller.signal });
        } else if (toolName === 'masons_look') {
          payload = await this.runtime.look(caller, args, { signal: controller.signal });
        } else if (toolName === 'masons_status') {
          payload = await this.runtime.status(caller, { signal: controller.signal });
        } else if (toolName === 'masons_profile') {
          payload = await this.runtime.profile(caller, args, { signal: controller.signal });
        } else if (toolName === 'masons_link') {
          payload = await this.runtime.link(caller, args, { signal: controller.signal });
        } else if (toolName === 'masons_connections') {
          payload = await this.runtime.connections(caller, args, { signal: controller.signal });
        } else if (toolName === 'masons_choose_session') {
          payload = await this.runtime.chooseSession(caller, args, { signal: controller.signal });
        } else {
          this.sendError(id, -32601, `Unknown tool: ${toolName}`);
          return;
        }
        this.sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        });
      } catch (error) {
        const code = error?.code ?? 'tool_execution_failed';
        const hint = ERROR_HINTS[code];
        this.sendResult(id, {
          isError: true,
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: code,
              ...(error?.reason && { reason: error.reason }),
              ...(error?.status && { http_status: error.status }),
              ...(error?.maxBytes && { max_bytes: error.maxBytes }),
              ...(hint && { hint }),
            }),
          }],
        });
      } finally {
        clearTimeout(timer);
        this.inflight.delete(reqKey);
      }
      return;
    }

    this.sendError(id, -32601, `Method not found: ${method}`);
  }

  start() {
    const rl = createInterface({ input: this.input, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.sendError(null, -32700, 'Parse error');
        return;
      }
      void this.handleMessage(msg);
    });

    const shutdown = () => {
      if (!this.shutdownPromise) {
        this.closed = true;
        for (const ctrl of this.inflight.values()) ctrl.abort();
        this.inflight.clear();
        this.shutdownPromise = Promise.resolve(this.runtime.shutdown());
      }
      return this.shutdownPromise;
    };

    rl.on('close', () => {
      void shutdown();
    });

    return { shutdown };
  }
}

export function startDefaultMcpServer() {
  const store = new StateStore(canonicalStateRoot(CONFIG));
  let server;
  const runtime = new SessionRuntime({
    config: CONFIG,
    store,
    onListChanged: () => server?.notifyToolsListChanged(),
  });
  server = new McpStdioServer({ config: CONFIG, runtime });
  const { shutdown } = server.start();
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startDefaultMcpServer();
}
