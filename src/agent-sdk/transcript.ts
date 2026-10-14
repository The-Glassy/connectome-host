// Pure request-shaping for the Claude Agent SDK transport (see adapter.ts and
// docs/claude-agent-sdk-provider.md). Nothing here spawns or fetches: it
// turns a membrane ProviderRequest's messages into the three things the CLI
// can be handed, and checks what the CLI sent back against what was asked.
//
//   transcript  — every message before the prompt, written as Claude Code
//                 session rows and loaded through the SDK's SessionStore;
//   prompt      — the newest plain user turn, sent as the query's message;
//   replay      — the assistant tool rounds after it, which the loopback
//                 proxy answers locally from the recorded turns while the
//                 MCP tools hand back the recorded results. The CLI's next
//                 request is then the real one.
//
// The CLI cannot simply resume a transcript that ends in tool results: on
// load it pairs a trailing tool_use with a synthetic "interrupted" result,
// and a trailing user turn gets a synthetic "No response requested."
// assistant turn before the next prompt (measured on CLI 2.1.299). The
// replay plan is the shape it does accept.

import { createHash, randomUUID } from 'node:crypto';

export type Block = { type: string; [key: string]: unknown };
export interface WireMessage {
  role: 'user' | 'assistant';
  content: Block[] | string;
}

/** A tool round the proxy plays back: the recorded assistant turn and the
 *  tool results the next user turn carried, keyed by tool_use id. */
export interface ReplayRound {
  assistant: WireMessage;
  results: Map<string, Block>;
}

export interface CallPlan {
  /** Messages loaded as session history (cache markers stripped, tool names prefixed). */
  transcript: WireMessage[];
  /** The plain user turn the query is started with. */
  prompt: WireMessage;
  replay: ReplayRound[];
  /** The whole conversation as the final upstream request must carry it. */
  expected: WireMessage[];
}

export class UnrepresentableRequest extends Error {}

/** In-process MCP server name: tools reach the wire as `mcp__<server>__<tool>`. */
export const TOOL_SERVER = 'host';
export const TOOL_PREFIX = `mcp__${TOOL_SERVER}__`;

export function prefixToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name : TOOL_PREFIX + name;
}

export function unprefixToolName(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function asBlocks(content: WireMessage['content']): Block[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function stripCacheControl(block: Block): Block {
  const { cache_control: _drop, ...rest } = block;
  if (rest.type === 'tool_result' && Array.isArray(rest.content)) {
    rest.content = (rest.content as Block[]).map(stripCacheControl);
  }
  return rest as Block;
}

/**
 * The message as the CLI should send it: membrane's request-time cache
 * markers removed (the CLI places its own three, and stored markers on top
 * of them exceed the API's four), and tool_use names given the MCP prefix
 * the tool definitions carry on the wire, so history and tools agree.
 */
export function shapeMessage(message: WireMessage): WireMessage {
  if (typeof message.content === 'string') return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: message.content.map((raw) => {
      const block = stripCacheControl(raw);
      return block.type === 'tool_use' && typeof block.name === 'string'
        ? { ...block, name: prefixToolName(block.name) }
        : block;
    }),
  };
}

function isToolResult(block: Block): boolean {
  return block.type === 'tool_result';
}

/** Split a request's messages into transcript, prompt and replay rounds. */
export function planCall(messages: unknown[], toolNames: ReadonlySet<string>): CallPlan {
  const shaped = (messages as WireMessage[]).map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) {
      throw new UnrepresentableRequest(`message role ${JSON.stringify((m as { role?: unknown })?.role)} is not user/assistant`);
    }
    return shapeMessage(m);
  });
  if (shaped.length === 0 || shaped[shaped.length - 1]!.role !== 'user') {
    throw new UnrepresentableRequest(
      'the request ends on an assistant turn (prefill); the Agent SDK only answers a user turn',
    );
  }
  const replay: ReplayRound[] = [];
  let i = shaped.length - 1;
  while (i >= 0 && asBlocks(shaped[i]!.content).some(isToolResult)) {
    const resultTurn = asBlocks(shaped[i]!.content);
    if (!resultTurn.every(isToolResult)) {
      throw new UnrepresentableRequest(
        'a trailing user turn mixes tool results with other content; the CLI can only return ' +
          'tool results through its tools (other blocks would be folded into a reminder)',
      );
    }
    const assistant = shaped[i - 1];
    if (!assistant || assistant.role !== 'assistant') {
      throw new UnrepresentableRequest('tool results do not follow an assistant turn');
    }
    const calls = asBlocks(assistant.content).filter((b) => b.type === 'tool_use');
    const results = new Map<string, Block>();
    for (const r of resultTurn) results.set(String(r.tool_use_id), r);
    for (const call of calls) {
      const bare = unprefixToolName(String(call.name));
      if (!toolNames.has(bare)) {
        throw new UnrepresentableRequest(
          `replaying tool call ${String(call.id)} needs tool "${bare}", which this request does not declare`,
        );
      }
      if (!results.has(String(call.id))) {
        throw new UnrepresentableRequest(`tool call ${String(call.id)} has no result in the next turn`);
      }
    }
    if (results.size !== calls.length) {
      throw new UnrepresentableRequest('a tool-result turn answers calls its assistant turn did not make');
    }
    for (const block of asBlocks(assistant.content)) {
      if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(block.type)) {
        throw new UnrepresentableRequest(`cannot replay a "${block.type}" block in an assistant tool round`);
      }
    }
    replay.unshift({ assistant, results });
    i -= 2;
  }
  if (i < 0) throw new UnrepresentableRequest('no plain user turn precedes the tool rounds');
  return { transcript: shaped.slice(0, i), prompt: shaped[i]!, replay, expected: shaped };
}

/** The messages the CLI must send on its `round`-th request (0 = after the prompt). */
export function expectedAtRound(plan: CallPlan, round: number): WireMessage[] {
  return plan.expected.slice(0, plan.transcript.length + 1 + round * 2);
}

/** A recorded tool_result as the MCP CallToolResult that makes the CLI rebuild it. */
export function toMcpResult(result: Block): { content: Array<Record<string, unknown>>; isError?: boolean } {
  const raw = result.content;
  const blocks: Block[] = raw === undefined || raw === null ? [] : typeof raw === 'string' ? [{ type: 'text', text: raw }] : (raw as Block[]);
  const content = blocks.map((b) => {
    if (b.type === 'text') return { type: 'text', text: String(b.text ?? '') };
    const source = b.source as { type?: string; data?: string; media_type?: string; mediaType?: string } | undefined;
    if (b.type === 'image' && source?.type === 'base64') {
      return { type: 'image', data: String(source.data), mimeType: String(source.media_type ?? source.mediaType ?? 'image/png') };
    }
    throw new UnrepresentableRequest(`a "${b.type}" block in a tool result cannot pass through an MCP tool`);
  });
  return result.is_error === true ? { content, isError: true } : { content };
}

// --- Session rows ----------------------------------------------------------

export interface TranscriptRowsInput {
  messages: WireMessage[];
  sessionId: string;
  cwd: string;
  model: string;
  /** CLI attachment rows remembered for the user turn ending a given prefix. */
  attachmentsAfter?: (prefixKey: string) => Array<Record<string, unknown>> | undefined;
  /** Seed for the prefix keys (see prefixKeys). */
  keySeed?: string;
}

/**
 * Claude Code session rows for `messages`, chained by parentUuid. Only the
 * fields the CLI's loader reads are written. Remembered attachment rows
 * (the CLI's own environment/model/date reminders from an earlier call) go
 * back after the user turn they were attached to, so the CLI renders that
 * turn exactly as it sent it before and does not attach them again.
 */
export function transcriptRows(input: TranscriptRowsInput): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let parent: string | null = null;
  const timestamp = new Date().toISOString();
  const keys = prefixKeys(input.messages, input.keySeed);
  input.messages.forEach((m, index) => {
    const uuid = randomUUID();
    const common = { uuid, parentUuid: parent, sessionId: input.sessionId, timestamp, isSidechain: false, userType: 'external', cwd: input.cwd };
    if (m.role === 'user') {
      rows.push({ type: 'user', ...common, message: { role: 'user', content: m.content } });
    } else {
      const blocks = asBlocks(m.content);
      rows.push({
        type: 'assistant',
        ...common,
        message: {
          id: `msg_replay_${uuid.replace(/-/g, '').slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          model: input.model,
          content: m.content,
          stop_reason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    parent = uuid;
    if (m.role === 'user') {
      for (const a of input.attachmentsAfter?.(keys[index]!) ?? []) {
        const id = randomUUID();
        rows.push({ ...a, uuid: id, parentUuid: parent, sessionId: input.sessionId });
        parent = id;
      }
    }
  });
  return rows;
}

/**
 * Rolling hash per message: key i names the conversation up to message i.
 * `seed` names what the messages hang off (model and system text), so two
 * conversations that open with the same words under different models or
 * prompts never share remembered attachment rows.
 */
export function prefixKeys(messages: WireMessage[], seed = ''): string[] {
  const keys: string[] = [];
  let acc = seed;
  for (const m of messages) {
    acc = createHash('sha256').update(acc).update(stableJson(normalizeMessage(m))).digest('hex');
    keys.push(acc);
  }
  return keys;
}

/**
 * The attachment rows the CLI wrote after the prompt's user row, from the
 * entries it has mirrored to the SessionStore so far. The SDK may deliver
 * them over several batches; `closed` says a later user/assistant row has
 * arrived, so no more of them can follow.
 */
export function attachmentsForPrompt(
  entries: Array<Record<string, unknown>>,
  prompt: WireMessage,
): { rows: Array<Record<string, unknown>>; closed: boolean } {
  const want = stableJson(normalizeMessage(prompt));
  const start = entries.findIndex((e) => e.type === 'user' &&
    stableJson(normalizeMessage({ role: 'user', content: (e.message as WireMessage | undefined)?.content ?? '' })) === want);
  if (start < 0) return { rows: [], closed: false };
  const rows: Array<Record<string, unknown>> = [];
  for (const e of entries.slice(start + 1)) {
    if (e.type === 'attachment') rows.push(e);
    else if (e.type === 'user' || e.type === 'assistant') return { rows, closed: true };
  }
  return { rows, closed: false };
}

/** How many reminder blocks these attachment rows render to on the wire. */
export function renderedCount(rows: Array<Record<string, unknown>>): number {
  return rows.reduce((n, r) => n + (Array.isArray(r.rendered) ? r.rendered.length : 0), 0);
}

// --- Verification ----------------------------------------------------------

/** Canonical form for comparison: string content as one text block, no
 *  cache markers, `is_error: false` dropped, tool_result string content as a
 *  text block. Key order is handled by stableJson. */
export function normalizeMessage(m: WireMessage): WireMessage {
  return {
    role: m.role,
    content: asBlocks(m.content).map((raw) => {
      const block = stripCacheControl(raw);
      if (block.type === 'tool_result') {
        const { is_error, content, ...rest } = block;
        return {
          ...rest,
          ...(is_error === true ? { is_error: true } : {}),
          content: content === undefined ? [] : typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        } as Block;
      }
      return block;
    }),
  };
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

const REMINDER = '<system-reminder>';

export interface WireCheck {
  ok: boolean;
  /** Reminder blocks the CLI added to user turns (tolerated, reported). */
  injected: string[];
  /** First difference, when not ok. */
  diff?: string;
}

/**
 * Whether the CLI's request carries exactly the expected conversation. The
 * only tolerated difference is a `<system-reminder>` text block the CLI
 * prepends to a user turn (its environment/model/date context); anything
 * else — a rewritten or cleared tool result, an inserted turn, changed text
 * — fails the call rather than reaching the model.
 */
export function checkWireMessages(expected: WireMessage[], wire: unknown): WireCheck {
  const injected: string[] = [];
  if (!Array.isArray(wire)) return { ok: false, injected, diff: 'request has no messages array' };
  if (wire.length !== expected.length) {
    return { ok: false, injected, diff: `expected ${expected.length} messages, CLI sent ${wire.length}` };
  }
  for (let i = 0; i < expected.length; i++) {
    const want = normalizeMessage(expected[i]!);
    const got = normalizeMessage(wire[i] as WireMessage);
    if (got.role !== want.role) return { ok: false, injected, diff: `message ${i}: role ${got.role}, expected ${want.role}` };
    const wantBlocks = want.content as Block[];
    const wantTexts = new Set(wantBlocks.filter((b) => b.type === 'text').map((b) => String(b.text)));
    const gotBlocks = (got.content as Block[]).filter((b) => {
      if (got.role === 'user' && b.type === 'text' && String(b.text).startsWith(REMINDER) && !wantTexts.has(String(b.text))) {
        injected.push(String(b.text));
        return false;
      }
      return true;
    });
    const a = stableJson(gotBlocks);
    const e = stableJson(wantBlocks);
    if (a !== e) {
      return { ok: false, injected, diff: `message ${i} (${want.role}) differs: sent ${a.slice(0, 300)} … expected ${e.slice(0, 300)}` };
    }
  }
  return { ok: true, injected };
}

/** Tool definitions as the CLI should list them, for comparison. */
export function expectedTools(tools: unknown[] | undefined): Array<{ name: string; description: unknown; input_schema: unknown }> {
  return ((tools ?? []) as Array<{ name: string; description?: unknown; input_schema?: unknown }>).map((t) => ({
    name: prefixToolName(t.name),
    description: t.description ?? '',
    input_schema: t.input_schema ?? { type: 'object', properties: {} },
  }));
}

/**
 * What the CLI does to MCP tool definitions: every string in the description
 * and input schema is NFKC-normalized and stripped of format characters (an
 * ellipsis becomes "...", a zero-width space vanishes). Tool results, tool
 * inputs and the system prompt are not touched. Measured on CLI 2.1.299.
 */
export function cliSanitize<T>(value: T): T {
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\p{Cf}/gu, '') as T;
  if (Array.isArray(value)) return value.map(cliSanitize) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cliSanitize(v)])) as T;
  }
  return value;
}

export interface ToolCheck {
  diff?: string;
  /** Tools whose definitions reached the wire only in the CLI's sanitized form. */
  sanitized: string[];
}

/**
 * Whether the CLI listed exactly the request's tools. A definition may differ
 * only by the CLI's own sanitization (cliSanitize), which is deterministic, so
 * the prompt prefix stays stable across calls; those tools are reported.
 */
/** Tool-definition fields the CLI may add: its own cache marker, nothing else
 *  (a `defer_loading` or `strict` would change how the model sees the tool). */
const TOOL_FIELDS = new Set(['name', 'description', 'input_schema', 'cache_control']);

export function checkWireTools(tools: unknown[] | undefined, wire: unknown): ToolCheck {
  const sanitized: string[] = [];
  const want = new Map(expectedTools(tools).map((t) => [t.name, t]));
  const list = (Array.isArray(wire) ? wire : []) as Array<{ name: string; description?: unknown; input_schema?: unknown }>;
  const sent = new Map(list.map((t) => [t.name, { name: t.name, description: t.description ?? '', input_schema: t.input_schema }]));
  if (sent.size !== list.length) {
    const seen = new Set<string>();
    const dup = list.map((t) => t.name).find((n) => seen.has(n) || (seen.add(n), false));
    return { sanitized, diff: `tool ${dup} is listed more than once` };
  }
  for (const t of list) {
    const fields = Object.keys(t).filter((k) => !TOOL_FIELDS.has(k));
    if (fields.length) return { sanitized, diff: `tool ${t.name} carries ${fields.join(', ')}, which the definition did not` };
  }
  const extra = [...sent.keys()].filter((n) => !want.has(n));
  const missing = [...want.keys()].filter((n) => !sent.has(n));
  if (extra.length || missing.length) {
    return { sanitized, diff: `tool list differs: ${extra.length ? `added ${extra.join(', ')}` : ''}${extra.length && missing.length ? '; ' : ''}${missing.length ? `missing ${missing.join(', ')}` : ''}` };
  }
  for (const [name, exact] of want) {
    const s = sent.get(name)!;
    const asSent = stableJson({ d: s.description, i: s.input_schema });
    if (asSent === stableJson({ d: exact.description, i: exact.input_schema })) continue;
    const t = cliSanitize(exact);
    if (asSent === stableJson({ d: t.description, i: t.input_schema })) {
      sanitized.push(unprefixToolName(name));
      continue;
    }
    if (stableJson(s.description) !== stableJson(t.description)) {
      return { sanitized, diff: `tool ${name}: description differs (sent ${String(s.description).length} chars, expected ${String(t.description).length}; sent …${JSON.stringify(String(s.description).slice(-80))})` };
    }
    return { sanitized, diff: `tool ${name}: input_schema differs: sent ${stableJson(s.input_schema).slice(0, 200)} … expected ${stableJson(t.input_schema).slice(0, 200)}` };
  }
  return { sanitized };
}

/** The system text the request asks for, as the SDK's custom prompt joins it. */
export function systemTexts(system: unknown): string[] {
  if (typeof system === 'string') return system ? [system] : [];
  if (!Array.isArray(system)) return [];
  return (system as Block[]).filter((b) => b?.type === 'text').map((b) => String(b.text));
}

/**
 * The CLI sends its own blocks first (a billing-header line and the Agent SDK
 * identity); the request's system text must be what follows them, joined.
 */
export function checkWireSystem(texts: string[], wire: unknown): { ok: boolean; cliBlocks: string[]; diff?: string } {
  const blocks = (typeof wire === 'string' ? [{ type: 'text', text: wire }] : Array.isArray(wire) ? wire : []) as Block[];
  const sent = blocks.map((b) => String(b.text ?? ''));
  const want = texts.join('\n\n');
  if (!want) return { ok: true, cliBlocks: sent };
  const last = sent[sent.length - 1];
  if (last !== want) return { ok: false, cliBlocks: sent.slice(0, -1), diff: `system prompt differs: last block ${JSON.stringify(String(last).slice(0, 200))}` };
  return { ok: true, cliBlocks: sent.slice(0, -1) };
}

/** The thinking and effort the adapter asked the SDK for. */
export interface AskedReasoning {
  thinking: { type?: string; budgetTokens?: number };
  effort?: string;
}

/**
 * Whether the request carries the reasoning that was asked for. The CLI
 * decides these from its options and the model: measured on 2.1.299, a fixed
 * budget on an adaptive model goes out as `adaptive`, and `display` is never
 * sent (the API default applies). What was not asked for — the CLI's own
 * default effort — is reported, not refused.
 */
export function checkWireReasoning(asked: AskedReasoning, body: Record<string, unknown>): { diff?: string; cliEffort?: string } {
  const wire = body.thinking as Record<string, unknown> | undefined;
  const want = asked.thinking.type === 'enabled'
    ? { type: 'enabled', ...(asked.thinking.budgetTokens ? { budget_tokens: asked.thinking.budgetTokens } : {}) }
    : { type: asked.thinking.type ?? 'disabled' };
  const { display: _display, ...got } = wire ?? {};
  if (stableJson(got) !== stableJson(want)) {
    const hint = asked.thinking.type === 'enabled' ? ' (the CLI sends adaptive thinking on a model that supports it; ask for thinking type adaptive)' : '';
    return { diff: `thinking ${JSON.stringify(wire)}, requested ${JSON.stringify(want)}${hint}` };
  }
  const cliEffort = (body.output_config as { effort?: string } | undefined)?.effort;
  if (asked.effort && cliEffort !== asked.effort) return { diff: `effort ${String(cliEffort)}, requested ${asked.effort}` };
  return asked.effort ? {} : { cliEffort };
}
