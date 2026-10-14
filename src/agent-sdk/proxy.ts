// Loopback HTTP proxy between the Claude Code CLI and the Anthropic API, for
// the Agent SDK transport (adapter.ts). Each call gets a path prefix
// (`/c/<callId>`) that the CLI is pointed at through ANTHROPIC_BASE_URL; the
// call's handler decides, per request, whether to answer locally (a recorded
// tool round being played back) or forward upstream.
//
// Forwarding never edits the request body. The handler inspects it first and
// may refuse it (the CLI then gets a 400 and the membrane call fails with the
// reason), but what reaches the API is byte-for-byte what the CLI built. The
// upstream response is streamed back to the CLI unchanged while a copy feeds
// an SSE accumulator, so the membrane call streams at upstream speed and its
// response is the provider's own, not the CLI's rendering of it.

import { gunzipSync } from 'node:zlib';
import type { StreamCallbacks } from '@animalabs/membrane';
import { type Block, unprefixToolName } from './transcript.js';

export interface ProxiedRequest {
  method: string;
  /** Path after the call prefix, with query string (e.g. `/v1/messages?beta=true`). */
  path: string;
  headers: Headers;
  body: Uint8Array;
  /** Parsed JSON body, when it is JSON. */
  json: unknown;
}

export type ProxyDecision =
  | { kind: 'forward'; onResponse?: (response: Response) => Response | Promise<Response> }
  | { kind: 'respond'; response: Response };

export type CallHandler = (request: ProxiedRequest) => ProxyDecision | Promise<ProxyDecision>;

export class LoopbackProxy {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private readonly handlers = new Map<string, CallHandler>();

  constructor(private readonly upstream: () => string) {}

  /** Base URL for one call; the CLI appends `/v1/messages` etc. */
  register(callId: string, handler: CallHandler): string {
    this.start();
    this.handlers.set(callId, handler);
    return `http://127.0.0.1:${this.server!.port}/c/${callId}`;
  }

  unregister(callId: string): void {
    this.handlers.delete(callId);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private start(): void {
    if (this.server) return;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      // A thinking model can stream nothing for minutes; never cut the CLI off.
      idleTimeout: 0,
      fetch: (req) => this.handle(req),
    });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const match = /^\/c\/([^/]+)(\/.*)$/.exec(url.pathname);
    const handler = match ? this.handlers.get(match[1]!) : undefined;
    if (!match || !handler) return new Response('unknown call', { status: 404 });
    const body = new Uint8Array(await req.arrayBuffer());
    const proxied: ProxiedRequest = {
      method: req.method,
      path: match[2]! + url.search,
      headers: req.headers,
      body,
      json: parseBody(body, req.headers.get('content-encoding')),
    };
    let decision: ProxyDecision;
    try {
      decision = await handler(proxied);
    } catch (error) {
      return jsonError(500, 'api_error', `connectome proxy: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (decision.kind === 'respond') return decision.response;
    const headers = new Headers(req.headers);
    headers.delete('host');
    headers.delete('content-length');
    let upstream: Response;
    try {
      upstream = await fetch(this.upstream().replace(/\/+$/, '') + proxied.path, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
        signal: req.signal,
      });
    } catch (error) {
      const failed = jsonError(502, 'api_error', `connectome proxy: upstream unreachable: ${error instanceof Error ? error.message : String(error)}`);
      return decision.onResponse ? decision.onResponse(failed) : failed;
    }
    // fetch has already decoded the body; the framing headers no longer apply.
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
    const relayed = new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
    return decision.onResponse ? decision.onResponse(relayed) : relayed;
  }
}

function parseBody(body: Uint8Array, encoding: string | null): unknown {
  if (body.byteLength === 0) return undefined;
  try {
    const bytes = encoding === 'gzip' ? gunzipSync(body) : body;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

export function jsonError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// --- Replay ----------------------------------------------------------------

/** An SSE stream that delivers `content` as one assistant message. */
export function replayResponse(content: Block[], model: string): Response {
  const parts: string[] = [];
  const ev = (type: string, data: Record<string, unknown>) =>
    parts.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  ev('message_start', {
    message: { id: `msg_replay_${crypto.randomUUID().replace(/-/g, '')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage },
  });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index, delta: { type: 'text_delta', text: String(block.text ?? '') } });
    } else if (block.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (block.thinking) ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: String(block.thinking) } });
      if (block.signature) ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: String(block.signature) } });
    } else if (block.type === 'redacted_thinking') {
      ev('content_block_start', { index, content_block: { type: 'redacted_thinking', data: block.data } });
    } else if (block.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 0 } });
  ev('message_stop', {});
  return new Response(parts.join(''), {
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_connectome_replay' },
  });
}

// --- Accumulating the forwarded stream -------------------------------------

export interface AccumulatedMessage {
  content: Block[];
  model: string;
  stopReason: string;
  providerStopReason?: string;
  stopSequence?: string;
  stopDetails?: unknown;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
  rawUsage: Record<string, unknown>;
  sawTerminalEvent: boolean;
  /** An `error` event inside a 200 stream (e.g. overloaded_error). */
  error?: { type?: string; message?: string };
}

/**
 * Anthropic SSE → content blocks, with membrane's paired onContentBlock
 * convention (once at start, once finished), text/thinking deltas on
 * onChunk, and signatures as they accumulate. Tool names lose the MCP
 * prefix on the way out. Mirrors AnthropicAdapter.stream's accumulation.
 */
export class SseAccumulator {
  private buffer = '';
  private readonly blocks: Block[] = [];
  private current = -1;
  private open = -1;
  private text = '';
  private json = '';
  private thinkingTagOpen = false;
  readonly message: AccumulatedMessage = {
    content: this.blocks, model: '', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 }, rawUsage: {}, sawTerminalEvent: false,
  };

  constructor(private readonly callbacks: StreamCallbacks, private readonly wrapThinkingTags = false) {}

  push(chunk: string): void {
    // SSE allows CRLF line endings. Normalizing the accumulated buffer (not
    // the chunk) also joins a CR and LF that arrive in different chunks.
    this.buffer = (this.buffer + chunk).replace(/\r\n/g, '\n');
    let cut: number;
    while ((cut = this.buffer.indexOf('\n\n')) >= 0) {
      const frame = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try {
        this.event(JSON.parse(data));
      } catch {
        // a non-JSON frame (ping comment etc.) carries nothing for us
      }
    }
  }

  /** Close a block still open when the stream ended (truncated tool call). */
  finish(): AccumulatedMessage {
    if (this.open >= 0) this.finalize(this.open, false);
    this.open = -1;
    return this.message;
  }

  private finalize(index: number, sawStop: boolean): void {
    const block = this.blocks[index];
    if (block) {
      if (block.type === 'text') block.text = this.text;
      else if (block.type === 'thinking') {
        block.thinking = this.text;
        if (this.thinkingTagOpen) {
          this.callbacks.onChunk('</thinking>\n');
          this.thinkingTagOpen = false;
        }
      } else if (block.type === 'tool_use') {
        if (!sawStop) block.unparseableInput = this.json;
        else if (this.json) {
          try {
            block.input = JSON.parse(this.json);
          } catch {
            block.unparseableInput = this.json;
          }
        }
      }
    }
    this.callbacks.onContentBlock?.(index, this.blocks[index]);
  }

  private event(event: Record<string, any>): void {
    const m = this.message;
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage ?? {};
        m.model = event.message?.model ?? '';
        m.rawUsage = { ...usage };
        m.usage.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
        if (typeof usage.cache_creation_input_tokens === 'number') m.usage.cacheCreationTokens = usage.cache_creation_input_tokens;
        if (typeof usage.cache_read_input_tokens === 'number') m.usage.cacheReadTokens = usage.cache_read_input_tokens;
        break;
      }
      case 'content_block_start': {
        const start = { ...event.content_block } as Block;
        if (start.type === 'tool_use' && typeof start.name === 'string') start.name = unprefixToolName(start.name);
        this.current = event.index;
        this.open = event.index;
        this.text = '';
        this.json = '';
        this.blocks[event.index] = start;
        this.callbacks.onContentBlock?.(event.index, { ...start });
        break;
      }
      case 'content_block_delta': {
        const d = event.delta ?? {};
        if (d.type === 'text_delta') {
          this.text += d.text;
          this.callbacks.onChunk(d.text);
        } else if (d.type === 'thinking_delta') {
          this.text += d.thinking;
          if (this.wrapThinkingTags && !this.thinkingTagOpen) {
            this.callbacks.onChunk('<thinking>');
            this.thinkingTagOpen = true;
          }
          this.callbacks.onChunk(d.thinking);
        } else if (d.type === 'signature_delta') {
          const block = this.blocks[this.current];
          if (block?.type === 'thinking' && d.signature) {
            block.signature = String(block.signature ?? '') + d.signature;
            this.callbacks.onThinkingSignature?.(this.current, String(block.signature));
          }
        } else if (d.type === 'input_json_delta') {
          this.json += d.partial_json;
        }
        break;
      }
      case 'content_block_stop':
        this.finalize(event.index, true);
        this.open = -1;
        break;
      case 'message_delta': {
        const delta = event.delta ?? {};
        const usage = event.usage ?? {};
        m.stopReason = delta.stop_reason ?? 'end_turn';
        m.providerStopReason = delta.stop_reason ?? undefined;
        m.stopSequence = delta.stop_sequence ?? undefined;
        m.stopDetails = delta.stop_details ?? undefined;
        m.sawTerminalEvent = true;
        m.usage.outputTokens = usage.output_tokens ?? 0;
        if (usage.cache_creation_input_tokens != null) m.usage.cacheCreationTokens = usage.cache_creation_input_tokens;
        if (usage.cache_read_input_tokens != null) m.usage.cacheReadTokens = usage.cache_read_input_tokens;
        m.rawUsage = { ...m.rawUsage, ...usage };
        break;
      }
      case 'error':
        m.error = event.error ?? { type: 'api_error', message: 'stream error event' };
        break;
      default:
        break;
    }
  }
}
