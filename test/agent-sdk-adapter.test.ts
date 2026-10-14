/**
 * claude-agent-sdk provider end to end, without the Claude Code binary: a
 * small stand-in for the CLI (it loads the SessionStore transcript, lists the
 * MCP tools, posts to ANTHROPIC_BASE_URL — the adapter's loopback proxy — and
 * runs tool calls through canUseTool + MCP like the CLI does) against a
 * stand-in Messages API. The stand-in can be told to rewrite what it sends,
 * the way the real CLI was measured to (microcompact, resume fillers), so the
 * proxy's refusal path is exercised.
 */
import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError, type ProviderRequest } from '@animalabs/membrane';
import { ClaudeAgentSdkAdapter, type AgentSdk, type AgentSdkAuth } from '../src/agent-sdk/adapter.js';
import { TOOL_PREFIX } from '../src/agent-sdk/transcript.js';

// --- Stand-in Messages API ---------------------------------------------------

type Reply = { status?: number; headers?: Record<string, string>; error?: unknown; blocks?: any[]; stop?: string; delayMs?: number };
let replies: Reply[] = [];
const upstreamBodies: any[] = [];
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = await req.json();
    upstreamBodies.push(body);
    const r = replies.shift() ?? { blocks: [{ type: 'text', text: 'ok' }] };
    if (r.status && r.status >= 400) {
      return new Response(JSON.stringify(r.error ?? { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
    }
    if (r.delayMs) await Bun.sleep(r.delayMs);
    return new Response(sse(r.blocks ?? [], r.stop ?? 'end_turn', body.model), { headers: { 'content-type': 'text/event-stream' } });
  },
});
afterAll(() => upstream.stop(true));

function sse(blocks: any[], stop: string, model: string): string {
  const out: string[] = [];
  const ev = (type: string, data: any) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
      for (const piece of b.text.match(/[\s\S]{1,3}/g) ?? []) ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    } else if (b.type === 'thinking') {
      ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature } });
    } else if (b.type === 'tool_use') {
      ev('content_block_start', { index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    }
    ev('content_block_stop', { index });
  });
  ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev('message_stop', {});
  return out.join('');
}

// --- Stand-in CLI --------------------------------------------------------------

interface FakeCliBehaviour {
  /** Edit the messages before each request, as a misbehaving CLI would. */
  rewrite?: (messages: any[], turn: number) => any[];
  /** Attach a reminder to the prompt unless history already has one, and
   *  mirror its attachment row only after the call (as the SDK does). */
  reminders?: boolean;
}
const queryCalls: Array<{ options: Record<string, any> }> = [];
const toolCalls: string[] = [];
let behaviour: FakeCliBehaviour = {};
const REMINDER = '<system-reminder>\nToday is a test.\n</system-reminder>';

function parseSse(text: string): any[] {
  const content: any[] = [];
  let json = '';
  for (const frame of text.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data:'));
    if (!line) continue;
    const e = JSON.parse(line.slice(5));
    if (e.type === 'content_block_start') { content[e.index] = { ...e.content_block }; json = ''; }
    if (e.type === 'content_block_delta') {
      const b = content[e.index];
      if (e.delta.type === 'text_delta') b.text += e.delta.text;
      if (e.delta.type === 'thinking_delta') b.thinking += e.delta.thinking;
      if (e.delta.type === 'signature_delta') b.signature += e.delta.signature;
      if (e.delta.type === 'input_json_delta') json += e.delta.partial_json;
    }
    if (e.type === 'content_block_stop' && content[e.index].type === 'tool_use') content[e.index].input = json ? JSON.parse(json) : {};
  }
  return content;
}

const fakeSdk: AgentSdk = {
  async *query({ prompt, options }) {
    queryCalls.push({ options });
    const env = options.env as Record<string, string>;
    const signal = (options.abortController as AbortController).signal;
    const server = options.mcpServers.host.instance;
    const waiting = new Map<number, (m: any) => void>();
    let nextId = 1;
    const transport: any = { send: async (m: any) => waiting.get(m.id)?.(m), start: async () => {} };
    await server.connect(transport);
    const rpc = (method: string, params: unknown) => new Promise<any>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      transport.onmessage({ jsonrpc: '2.0', id, method, params });
    });
    await rpc('initialize', { protocolVersion: '2025-06-18' });
    const tools = (await rpc('tools/list', {})).result.tools;

    const rows: any[] = options.resume ? await options.sessionStore.load({ projectKey: 'p', sessionId: options.resume }) : [];
    const messages: any[] = [];
    let hadReminder = false;
    for (const row of rows) {
      if (row.type === 'attachment') {
        hadReminder = true;
        const last = messages.at(-1);
        last.content = [{ type: 'text', text: REMINDER }, ...last.content];
      } else if (row.type === 'user' || row.type === 'assistant') {
        messages.push({ role: row.message.role, content: typeof row.message.content === 'string' ? [{ type: 'text', text: row.message.content }] : [...row.message.content] });
      }
    }
    const first = await (prompt as AsyncIterable<any>)[Symbol.asyncIterator]().next();
    const raw = first.value.message;
    const promptMessage = { role: 'user', content: typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : raw.content };
    const injectReminder = behaviour.reminders && !hadReminder;
    messages.push(injectReminder ? { role: 'user', content: [{ type: 'text', text: REMINDER }, ...promptMessage.content] } : promptMessage);
    if (injectReminder) {
      // The CLI writes the rows before its request; the SDK mirrors them later.
      setTimeout(() => {
        void options.sessionStore.append({}, [
          { type: 'user', message: promptMessage },
          { type: 'attachment', uuid: 'a1', attachment: { type: 'date' } },
          { type: 'assistant', message: {} },
        ]);
      }, 50);
    }
    yield { type: 'system', subtype: 'init' };

    for (let turn = 0; turn < options.maxTurns; turn++) {
      const system = [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=test;' },
        { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
        ...(options.systemPrompt.prompt.length ? [{ type: 'text', text: options.systemPrompt.prompt.join('\n\n'), cache_control: { type: 'ephemeral' } }] : []),
      ];
      const sent = behaviour.rewrite ? behaviour.rewrite(structuredClone(messages), turn) : messages;
      const body = {
        model: options.model,
        max_tokens: Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS),
        system,
        tools: tools.map((t: any) => ({ name: `${TOOL_PREFIX}${t.name}`, description: t.description, input_schema: t.inputSchema })),
        messages: sent,
        stream: true,
      };
      let res: Response;
      try {
        res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      } catch {
        return;
      }
      if (!res.ok) {
        yield { type: 'result', subtype: 'error_during_execution', errors: [`API Error: ${res.status}`] };
        return;
      }
      const content = parseSse(await res.text());
      messages.push({ role: 'assistant', content });
      const calls = content.filter((b) => b.type === 'tool_use');
      if (calls.length === 0) break;
      const results: any[] = [];
      for (const c of calls) {
        const verdict = await options.canUseTool(c.name, c.input, { toolUseID: c.id, signal });
        if (verdict.behavior !== 'allow') {
          yield { type: 'result', subtype: 'error_max_turns', errors: ['denied'] };
          return;
        }
        toolCalls.push(c.id);
        const r = (await rpc('tools/call', { name: c.name.slice(TOOL_PREFIX.length), arguments: c.input, _meta: { 'claudecode/toolUseId': c.id } })).result;
        results.push({ tool_use_id: c.id, type: 'tool_result', content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    yield { type: 'result', subtype: 'success' };
  },
};

// --- Helpers -------------------------------------------------------------------

const TOOLS = [
  { name: 'send', description: 'Send a message.', input_schema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'read', description: 'Read a file.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
];
function makeAdapter(auth: AgentSdkAuth = { apiKey: 'sk-ant-api03-test' }, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-sdk-test-'));
  return new ClaudeAgentSdkAdapter({ auth, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, cwd: join(root, 'cwd'), configDir: join(root, 'cfg'), sdk: fakeSdk, ...extra });
}
const request = (messages: any[], extra: Partial<ProviderRequest> = {}): ProviderRequest =>
  ({ model: 'claude-opus-4-6', maxTokens: 777, system: [{ type: 'text', text: 'You are Ada.', cache_control: { type: 'ephemeral' } }], tools: TOOLS, messages, ...extra }) as ProviderRequest;
const strip = (messages: any[]) => JSON.parse(JSON.stringify(messages, (k, v) => (k === 'cache_control' ? undefined : v)));

beforeEach(() => {
  replies = [];
  upstreamBodies.length = 0;
  queryCalls.length = 0;
  toolCalls.length = 0;
  behaviour = {};
});

describe('claude-agent-sdk adapter', () => {
  test('streams the upstream response and forwards exactly the requested conversation', async () => {
    const adapter = makeAdapter();
    replies = [{ blocks: [{ type: 'thinking', thinking: 'mm', signature: 'SIG' }, { type: 'text', text: 'Hello there' }] }];
    const chunks: string[] = [];
    const blocks: Array<[number, any]> = [];
    const signatures: string[] = [];
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hey' }] },
      { role: 'user', content: [{ type: 'text', text: 'how are you?' }] },
    ];
    const response = await adapter.stream(request(history), {
      onChunk: (c) => chunks.push(c),
      onContentBlock: (i, b) => blocks.push([i, structuredClone(b)]),
      onThinkingSignature: (_i, s) => signatures.push(s),
    });
    adapter.dispose();

    expect(upstreamBodies).toHaveLength(1);
    expect(strip(upstreamBodies[0].messages)).toEqual(strip(history));
    expect(response.rawRequest).toEqual(upstreamBodies[0]);
    expect(response.content).toEqual([{ type: 'thinking', thinking: 'mm', signature: 'SIG' }, { type: 'text', text: 'Hello there' }]);
    expect(chunks.join('')).toBe('mmHello there');
    expect(blocks.map(([i, b]) => `${i}:${b.type}:${b.text ?? b.thinking ?? ''}`)).toEqual(['0:thinking:', '0:thinking:mm', '1:text:', '1:text:Hello there']);
    expect(signatures).toEqual(['SIG']);
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 5, cacheReadTokens: 7, cacheCreationTokens: 3 });
    expect(response.stopReason).toBe('end_turn');
    expect((response.raw as any).agentSdk.cliSystemBlocks[1]).toContain('Agent SDK');
  });

  test('passes model, max tokens, system, reasoning and auth to the CLI', async () => {
    const oauth = makeAdapter({ oauthToken: 'sk-ant-oat01-x' }, { getReasoning: () => ({ enabled: true, budgetTokens: 0, display: 'omitted', effort: 'low' }) });
    await oauth.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} });
    oauth.dispose();
    const key = makeAdapter();
    await key.complete(request([{ role: 'user', content: 'hi' }], { thinking: { type: 'enabled', budget_tokens: 2000 } }));
    key.dispose();

    const [o, k] = queryCalls.map((c) => c.options);
    expect(o!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-x');
    expect(o!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o!.env.CLAUDE_CODE_SIMPLE).toBeUndefined();
    expect(o!.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(o!.effort).toBe('low');
    expect(k!.env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
    expect(k!.env.CLAUDE_CODE_SIMPLE).toBe('1');
    expect(k!.thinking).toEqual({ type: 'enabled', budgetTokens: 2000 });
    expect(k!.effort).toBeUndefined();
    for (const opts of [o!, k!]) {
      expect(opts.model).toBe('claude-opus-4-6');
      expect(opts.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('777');
      expect(opts.systemPrompt).toEqual({ type: 'custom', prompt: ['You are Ada.'], snapshot: false });
      expect(opts.tools).toEqual([]);
      expect(opts.settingSources).toEqual([]);
      expect(opts.permissionMode).toBe('default');
      expect(opts.env.PATH).toBe(process.env.PATH);
      expect(opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    }
  });

  test('a tool call comes back under its own name and the CLI is not let run it', async () => {
    const adapter = makeAdapter();
    replies = [{ blocks: [{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'toolu_9', name: `${TOOL_PREFIX}send`, input: { text: 'x' } }], stop: 'tool_use' }];
    const starts: string[] = [];
    const response = await adapter.stream(request([{ role: 'user', content: 'send x' }]), {
      onChunk: () => {},
      onContentBlock: (_i, b: any) => { if (b.type === 'tool_use') starts.push(b.name); },
    });
    await Bun.sleep(50);
    adapter.dispose();
    expect(response.stopReason).toBe('tool_use');
    expect(response.content).toEqual([{ type: 'text', text: 'on it' }, { type: 'tool_use', id: 'toolu_9', name: 'send', input: { text: 'x' } }]);
    expect(starts).toEqual(['send', 'send']);
    expect(toolCalls).toEqual([]);
  });

  test('a request ending in tool results is played back: one upstream request, verbatim', async () => {
    const adapter = makeAdapter();
    const conversation = [
      { role: 'user', content: [{ type: 'text', text: 'do two things' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 'S1' }, { type: 'tool_use', id: 't1', name: 'send', input: { text: 'a' } }, { type: 'tool_use', id: 't2', name: 'read', input: { path: '/x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sent' }, { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'file body' }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'send', input: { text: 'b' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'failed', is_error: true }] },
    ];
    replies = [{ blocks: [{ type: 'text', text: 'done' }] }];
    const response = await adapter.stream(request(conversation), { onChunk: () => {} });
    adapter.dispose();
    expect(upstreamBodies).toHaveLength(1);
    const prefixed = conversation.map((m) => ({ ...m, content: m.content.map((b: any) => (b.type === 'tool_use' ? { ...b, name: TOOL_PREFIX + b.name } : b)) }));
    const normalize = (ms: any[]) => strip(ms).map((m: any) => ({ ...m, content: m.content.map((b: any) => (b.type === 'tool_result' && typeof b.content === 'string' ? { ...b, content: [{ type: 'text', text: b.content }] } : b)) }));
    expect(normalize(upstreamBodies[0].messages)).toEqual(normalize(prefixed));
    expect(toolCalls).toEqual(['t1', 't2', 't3']);
    expect((response.raw as any).agentSdk.replayedRounds).toBe(2);
    expect(response.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  test('a CLI that rewrites the conversation is refused before anything reaches the API', async () => {
    const adapter = makeAdapter();
    behaviour = {
      rewrite: (messages) => messages.map((m) => ({
        ...m,
        content: m.content.map((b: any) => (b.type === 'tool_result' ? { ...b, content: '[Old tool result content cleared]' } : b)),
      })),
    };
    const conversation = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a long file' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'read it' }] },
      { role: 'user', content: 'summarize' },
    ];
    const error = await adapter.stream(request(conversation), { onChunk: () => {} }).catch((e) => e);
    adapter.dispose();
    expect(error).toBeInstanceOf(MembraneError);
    expect(error.type).toBe('unsupported');
    expect(error.message).toContain('not the requested conversation');
    expect(upstreamBodies).toHaveLength(0);
  });

  test('an inserted turn is refused too', async () => {
    const adapter = makeAdapter();
    behaviour = { rewrite: (messages) => [...messages.slice(0, -1), { role: 'assistant', content: [{ type: 'text', text: 'No response requested.' }] }, messages.at(-1)] };
    const error = await adapter.stream(request([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]), { onChunk: () => {} }).catch((e) => e);
    adapter.dispose();
    expect(error.type).toBe('unsupported');
    expect(upstreamBodies).toHaveLength(0);
  });

  test('an upstream error is classified from the real HTTP response', async () => {
    const adapter = makeAdapter();
    replies = [{ status: 429, headers: { 'retry-after': '7' } }];
    const error = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} }).catch((e) => e);
    adapter.dispose();
    expect(error).toBeInstanceOf(MembraneError);
    expect(error.type).toBe('rate_limit');
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(429);
    expect(error.retryAfterMs).toBe(7000);
  });

  test('unrepresentable requests fail before any CLI is started', async () => {
    const adapter = makeAdapter();
    const prefill = await adapter.stream(request([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'Sure, ' }]), { onChunk: () => {} }).catch((e) => e);
    const mixed = await adapter.stream(request([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'send', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }, { type: 'text', text: 'also' }] },
    ]), { onChunk: () => {} }).catch((e) => e);
    adapter.dispose();
    expect(prefill.type).toBe('unsupported');
    expect(mixed.type).toBe('unsupported');
    expect(queryCalls).toHaveLength(0);
  });

  test("the CLI's reminders are kept on the turn they were added to, so the next request extends the last", async () => {
    const adapter = makeAdapter({ oauthToken: 'sk-ant-oat01-x' });
    behaviour = { reminders: true };
    let messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }];
    for (let i = 0; i < 3; i++) {
      replies = [{ blocks: [{ type: 'text', text: `r${i}` }] }];
      const r = await adapter.stream(request(messages), { onChunk: () => {} });
      messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: [{ type: 'text', text: `next ${i}` }] }];
    }
    adapter.dispose();
    const [a, b, c] = upstreamBodies.map((body) => strip(body.messages));
    expect(b.slice(0, a.length)).toEqual(a);
    expect(c.slice(0, b.length)).toEqual(b);
    expect(JSON.stringify(c).split('<system-reminder>').length - 1).toBe(1);
  });

  test('an abort stops the call', async () => {
    const adapter = makeAdapter();
    replies = [{ blocks: [{ type: 'text', text: 'slow' }], delayMs: 2000 }];
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} }, { signal: controller.signal }).catch((e) => e);
    adapter.dispose();
    expect(error).toBeInstanceOf(MembraneError);
    expect(error.type).toBe('abort');
  });
});
