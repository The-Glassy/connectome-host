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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MembraneError, type ProviderRequest } from '@animalabs/membrane';
import { ClaudeAgentSdkAdapter, type AgentSdk, type AgentSdkAuth } from '../src/agent-sdk/adapter.js';
import { TOOL_PREFIX } from '../src/agent-sdk/transcript.js';

// --- Stand-in Messages API ---------------------------------------------------

type Reply = {
  status?: number; headers?: Record<string, string>; error?: unknown; blocks?: any[]; stop?: string; delayMs?: number;
  /** Frame the stream with CRLF line endings. */
  crlf?: boolean;
  /** End a 200 stream with an `error` event instead of message_delta. */
  errorEvent?: { type: string; message: string };
  /** Deliver the whole stream, then keep the HTTP body open for a while. */
  holdOpenMs?: number;
};
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
    const stream = sse(r.blocks ?? [], r.stop ?? 'end_turn', body.model, r.errorEvent);
    const text = r.crlf ? stream.replace(/\n/g, '\r\n') : stream;
    if (r.holdOpenMs) {
      const held = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); setTimeout(() => { try { c.close(); } catch { /* already cancelled */ } }, r.holdOpenMs); } });
      return new Response(held, { headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  },
});
afterAll(() => upstream.stop(true));

function sse(blocks: any[], stop: string, model: string, errorEvent?: Reply['errorEvent']): string {
  const out: string[] = [];
  const ev = (type: string, data: any) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 } } });
  if (errorEvent) {
    ev('error', { error: errorEvent });
    return out.join('');
  }
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
   *  mirror its attachment row only after the call (as the SDK does).
   *  'split': two reminders, their rows mirrored in separate batches with
   *  no closing row. */
  reminders?: boolean | 'split';
  /** Extra top-level fields on every request body. */
  extraBody?: Record<string, unknown>;
  /** Send this max_tokens instead of the one in the environment (the CLI caps it). */
  maxTokens?: number;
  /** Send this `thinking` instead of the option (the CLI turns a budget adaptive). */
  thinking?: unknown;
  /** Send this effort instead of the option. */
  effort?: string;
  /** List the first tool twice / with an extra definition field. */
  duplicateTool?: boolean;
  extraToolField?: Record<string, unknown>;
  /** Ask the proxy for this route before the Messages request. */
  extraRoute?: string;
  /** Throw this from query() before anything runs (a spawn failure). */
  crash?: string;
}
const queryCalls: Array<{ options: Record<string, any> }> = [];
const toolCalls: string[] = [];
let behaviour: FakeCliBehaviour = {};
const REMINDER = '<system-reminder>\nToday is a test.\n</system-reminder>';
const REMINDER_2 = '<system-reminder>\nYou run in a test.\n</system-reminder>';
/** The CLI's model reminder names the model it runs; so does ours. */
const reminderFor = (model: string) => `<system-reminder>\nYou are powered by the model ${model}.\n</system-reminder>`;
const renderedText = (row: any): string => row.rendered?.[0]?.content ?? REMINDER;

function parseSse(text: string): any[] {
  const content: any[] = [];
  let json = '';
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
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
    if (behaviour.crash) throw new Error(behaviour.crash);
    const env = options.env as Record<string, string>;
    const signal = (options.abortController as AbortController).signal;
    if (!options.resume) {
      // A fresh session: the CLI writes its own transcript under the config dir.
      const dir = join(env.CLAUDE_CONFIG_DIR!, 'projects', '-cwd');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${options.sessionId}.jsonl`), '{"type":"user"}\n');
      writeFileSync(join(env.CLAUDE_CONFIG_DIR!, '.claude.json'), '{}');
    }
    if (behaviour.extraRoute) await fetch(`${env.ANTHROPIC_BASE_URL}${behaviour.extraRoute}`).catch(() => {});
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
    const rendered = new Map<any, number>();
    for (const row of rows) {
      if (row.type === 'attachment') {
        hadReminder = true;
        // Like the CLI: a turn's attachments render ahead of its own text, in row order.
        const last = messages.at(-1);
        const at = rendered.get(last) ?? 0;
        last.content.splice(at, 0, { type: 'text', text: renderedText(row) });
        rendered.set(last, at + 1);
      } else if (row.type === 'user' || row.type === 'assistant') {
        messages.push({ role: row.message.role, content: typeof row.message.content === 'string' ? [{ type: 'text', text: row.message.content }] : [...row.message.content] });
      }
    }
    const first = await (prompt as AsyncIterable<any>)[Symbol.asyncIterator]().next();
    const raw = first.value.message;
    const promptMessage = { role: 'user', content: typeof raw.content === 'string' ? [{ type: 'text', text: raw.content }] : raw.content };
    const injectReminder = behaviour.reminders && !hadReminder;
    const split = behaviour.reminders === 'split';
    const modelReminder = reminderFor(options.model);
    const added = !injectReminder ? [] : split ? [REMINDER, REMINDER_2] : [modelReminder];
    messages.push({ role: 'user', content: [...added.map((t) => ({ type: 'text', text: t })), ...promptMessage.content] });
    if (injectReminder && !split) {
      // The CLI writes the rows before its request; the SDK mirrors them later.
      setTimeout(() => {
        void options.sessionStore.append({}, [
          { type: 'user', message: promptMessage },
          { type: 'attachment', uuid: 'a1', attachment: { type: 'model' }, rendered: [{ content: modelReminder }] },
          { type: 'assistant', message: {} },
        ]);
      }, 50);
    }
    if (injectReminder && split) {
      // One frame per batch, as with sessionStoreFlush 'eager', and no closing row.
      const batches = [
        [{ type: 'user', message: promptMessage }],
        [{ type: 'attachment', uuid: 'a1', attachment: { type: 'date' }, rendered: [{ content: REMINDER }] }],
        [{ type: 'attachment', uuid: 'a2', attachment: { type: 'environment' }, rendered: [{ content: REMINDER_2 }] }],
      ];
      batches.forEach((batch, i) => setTimeout(() => { void options.sessionStore.append({}, batch); }, 40 + i * 40));
    }
    yield { type: 'system', subtype: 'init' };

    for (let turn = 0; turn < options.maxTurns; turn++) {
      const system = [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=test;' },
        { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: 'ephemeral' } },
        ...(options.systemPrompt.prompt.length ? [{ type: 'text', text: options.systemPrompt.prompt.join('\n\n'), cache_control: { type: 'ephemeral' } }] : []),
      ];
      const sent = behaviour.rewrite ? behaviour.rewrite(structuredClone(messages), turn) : messages;
      const thinkingOpt = options.thinking as { type: string; budgetTokens?: number };
      const thinking = behaviour.thinking ?? (thinkingOpt.type === 'enabled'
        ? { type: 'enabled', ...(thinkingOpt.budgetTokens ? { budget_tokens: thinkingOpt.budgetTokens } : {}) }
        : { type: thinkingOpt.type });
      const wireTools = tools.map((t: any) => ({ name: `${TOOL_PREFIX}${t.name}`, description: t.description, input_schema: t.inputSchema, ...behaviour.extraToolField }));
      const body = {
        model: options.model,
        max_tokens: behaviour.maxTokens ?? Number(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS),
        system,
        tools: behaviour.duplicateTool && wireTools.length ? [wireTools[0], ...wireTools] : wireTools,
        messages: sent,
        thinking,
        // Like the CLI: the default temperature travels only without thinking.
        ...((thinking as { type: string }).type === 'disabled' ? { temperature: 1 } : {}),
        output_config: { effort: behaviour.effort ?? options.effort ?? 'high' },
        stream: true,
        ...behaviour.extraBody,
      };
      let res: Response;
      try {
        res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20' }, body: JSON.stringify(body), signal });
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
let lastConfigDir = '';
function makeAdapter(auth: AgentSdkAuth = { apiKey: 'sk-ant-api03-test' }, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-sdk-test-'));
  lastConfigDir = join(root, 'cfg');
  return new ClaudeAgentSdkAdapter({ auth, upstreamBaseURL: `http://127.0.0.1:${upstream.port}`, cwd: join(root, 'cwd'), configDir: lastConfigDir, sdk: fakeSdk, ...extra });
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
    // `display` is not passed on: the CLI never sends it (measured), so the
    // option would promise what the wire cannot keep.
    expect(o!.thinking).toEqual({ type: 'adaptive' });
    expect(o!.effort).toBe('low');
    expect(upstreamBodies[0].thinking).toEqual({ type: 'adaptive' });
    expect(upstreamBodies[0].output_config).toEqual({ effort: 'low' });
    expect(upstreamBodies[1].thinking).toEqual({ type: 'enabled', budget_tokens: 2000 });
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

  test('a CRLF-framed stream is read like an LF one', async () => {
    const adapter = makeAdapter();
    replies = [{ crlf: true, blocks: [{ type: 'text', text: 'over CRLF' }] }];
    const chunks: string[] = [];
    const response = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: (c) => chunks.push(c) });
    adapter.dispose();
    expect(response.content).toEqual([{ type: 'text', text: 'over CRLF' }]);
    expect(chunks.join('')).toBe('over CRLF');
    expect(response.stopReason).toBe('end_turn');
  });

  test('an error event inside a 200 stream keeps its type (overloaded → 529)', async () => {
    const adapter = makeAdapter();
    replies = [{ errorEvent: { type: 'overloaded_error', message: 'Overloaded' } }];
    const error = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} }).catch((e) => e);
    adapter.dispose();
    expect(error).toBeInstanceOf(MembraneError);
    expect(error.type).toBe('server');
    expect(error.httpStatus).toBe(529);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('Overloaded');
  });

  test('server-side context edits on the request are refused, not forwarded', async () => {
    for (const extraBody of [
      { context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] } },
      { safeguards: [{ type: 'dangerous_tool_use' }] },
    ]) {
      const adapter = makeAdapter();
      behaviour = { extraBody };
      const error = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} }).catch((e) => e);
      adapter.dispose();
      expect(error.type).toBe('unsupported');
      expect(error.message).toContain(Object.keys(extraBody)[0]!);
    }
    expect(upstreamBodies).toHaveLength(0);
  });

  test('an abort that lands while the SDK loads starts no CLI', async () => {
    const adapter = makeAdapter();
    const controller = new AbortController();
    const pending = adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} }, { signal: controller.signal });
    controller.abort();
    const error = await pending.catch((e) => e);
    adapter.dispose();
    expect(error).toBeInstanceOf(MembraneError);
    expect(error.type).toBe('abort');
    expect(queryCalls).toHaveLength(0);
    expect(upstreamBodies).toHaveLength(0);
  });

  test('a finished call leaves no listener on a signal its caller keeps', async () => {
    const adapter = makeAdapter();
    const signal = new AbortController().signal;
    let live = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((type: string, fn: any, o?: any) => { live++; add(type, fn, o); }) as typeof signal.addEventListener;
    signal.removeEventListener = ((type: string, fn: any, o?: any) => { live--; remove(type, fn, o); }) as typeof signal.removeEventListener;
    for (let i = 0; i < 3; i++) await adapter.stream(request([{ role: 'user', content: `hi ${i}` }]), { onChunk: () => {} }, { signal });
    adapter.dispose();
    expect(live).toBe(0);
  });

  test('attachment rows mirrored over several batches are all kept', async () => {
    const adapter = makeAdapter({ oauthToken: 'sk-ant-oat01-x' });
    behaviour = { reminders: 'split' };
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
    expect(JSON.stringify(c).split('<system-reminder>').length - 1).toBe(2);
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

  test('a request whose max_tokens, thinking or effort the CLI rewrote is refused, not forwarded', async () => {
    const cases: Array<[FakeCliBehaviour, Partial<ProviderRequest>, RegExp]> = [
      [{ maxTokens: 128_000 }, { maxTokens: 999_999 }, /max_tokens 128000, requested 999999/],
      [{ thinking: { type: 'adaptive' } }, { thinking: { type: 'enabled', budget_tokens: 2048 } }, /thinking .*adaptive.*requested .*budget_tokens.*2048.*adaptive/],
      [{ effort: 'max' }, { extra: { output_config: { effort: 'low' } } }, /effort max, requested low/],
      [{ duplicateTool: true }, {}, /listed more than once/],
      [{ extraToolField: { defer_loading: true } }, {}, /carries defer_loading/],
    ];
    for (const [cli, extra, message] of cases) {
      const adapter = makeAdapter();
      behaviour = cli;
      const error = await adapter.stream(request([{ role: 'user', content: 'hi' }], extra), { onChunk: () => {} }).catch((e) => e);
      adapter.dispose();
      expect(error.type).toBe('unsupported');
      expect(error.message).toMatch(message);
    }
    expect(upstreamBodies).toHaveLength(0);
  });

  test("the CLI's default effort and betas are reported when nothing was asked for", async () => {
    const adapter = makeAdapter();
    const response = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} });
    adapter.dispose();
    const meta = (response.raw as any).agentSdk;
    expect(meta.cliEffort).toBe('high');
    expect(meta.cliBetas).toBe('claude-code-20250219,oauth-2025-04-20');
    expect(upstreamBodies[0].max_tokens).toBe(777);
  });

  test('a completed stream settles the call even when the HTTP body stays open', async () => {
    const adapter = makeAdapter();
    replies = [{ blocks: [{ type: 'text', text: 'done early' }], holdOpenMs: 3000 }];
    const t0 = performance.now();
    const response = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} });
    const elapsed = performance.now() - t0;
    adapter.dispose();
    expect(response.content).toEqual([{ type: 'text', text: 'done early' }]);
    expect(response.usage.outputTokens).toBe(5);
    expect(elapsed).toBeLessThan(1500);
  });

  test('a fresh session leaves no transcript file behind; the rest of the config dir stays', async () => {
    const adapter = makeAdapter();
    await adapter.stream(request([{ role: 'user', content: 'first ever' }]), { onChunk: () => {} });
    adapter.dispose();
    // The CLI writes the file on exit, after the call settles; the adapter removes it once the query has ended.
    await Bun.sleep(100);
    expect(queryCalls[0]!.options.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(queryCalls[0]!.options.resume).toBeUndefined();
    expect(readdirSync(join(lastConfigDir, 'projects', '-cwd'))).toEqual([]);
    expect(existsSync(join(lastConfigDir, '.claude.json'))).toBe(true);
  });

  test('a CLI that dies before its request is retryable; a refused login is not', async () => {
    const cases: Array<[string, string, boolean]> = [
      ['spawn EAGAIN', 'unknown', true],
      ['Not logged in', 'auth', false],
    ];
    for (const [crash, type, retryable] of cases) {
      const adapter = makeAdapter();
      behaviour = { crash };
      const error = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} }).catch((e) => e);
      adapter.dispose();
      expect(error).toBeInstanceOf(MembraneError);
      expect(error.type).toBe(type);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toContain(crash);
    }
  });

  test('remembered reminders are kept apart by model: the same opening words under another model get their own', async () => {
    const adapter = makeAdapter({ oauthToken: 'sk-ant-oat01-x' });
    behaviour = { reminders: true };
    const opening = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
    const r1 = await adapter.stream(request(opening), { onChunk: () => {} });
    await adapter.stream(request([...opening, { role: 'assistant', content: r1.content }, { role: 'user', content: 'again' }]), { onChunk: () => {} });
    const r2 = await adapter.stream(request(opening, { model: 'claude-sonnet-4-5' }), { onChunk: () => {} });
    await adapter.stream(request([...opening, { role: 'assistant', content: r2.content }, { role: 'user', content: 'again' }], { model: 'claude-sonnet-4-5' }), { onChunk: () => {} });
    adapter.dispose();
    const firstTurnText = (body: any) => JSON.stringify(body.messages[0]);
    expect(firstTurnText(upstreamBodies[1])).toContain('claude-opus-4-6');
    expect(firstTurnText(upstreamBodies[3])).toContain('claude-sonnet-4-5');
    expect(firstTurnText(upstreamBodies[3])).not.toContain('claude-opus-4-6');
  });

  test('a route other than POST /v1/messages is answered 404 and reported, never forwarded', async () => {
    const adapter = makeAdapter();
    behaviour = { extraRoute: '/v1/models' };
    const response = await adapter.stream(request([{ role: 'user', content: 'hi' }]), { onChunk: () => {} });
    adapter.dispose();
    expect((response.raw as any).agentSdk.cliOtherRequests).toEqual(['GET /v1/models']);
    expect(upstreamBodies).toHaveLength(1);
  });
});
