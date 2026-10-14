/**
 * claude-agent-sdk provider, pure parts: how a membrane request is split into
 * session history / prompt / played-back tool rounds, and how the CLI's
 * outgoing request is checked against it. The shapes the planner refuses are
 * the ones the CLI was measured to rewrite (docs/claude-agent-sdk-provider.md).
 */
import { describe, test, expect } from 'bun:test';
import {
  TOOL_PREFIX,
  UnrepresentableRequest,
  attachmentsForPrompt,
  renderedCount,
  checkWireMessages,
  checkWireSystem,
  checkWireTools,
  expectedAtRound,
  planCall,
  prefixKeys,
  shapeMessage,
  toMcpResult,
  transcriptRows,
  type WireMessage,
} from '../src/agent-sdk/transcript.js';

const TOOLS = new Set(['send', 'read']);
const user = (...content: unknown[]): WireMessage => ({ role: 'user', content: content as never });
const assistant = (...content: unknown[]): WireMessage => ({ role: 'assistant', content: content as never });
const text = (t: string, extra: Record<string, unknown> = {}) => ({ type: 'text', text: t, ...extra });
const call = (id: string, name = 'send', input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown = 'ok', extra: Record<string, unknown> = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });

describe('planCall', () => {
  test('a plain conversation is history + the last user turn as the prompt', () => {
    const plan = planCall([user(text('a')), assistant(text('b')), user(text('c'))], TOOLS);
    expect(plan.transcript).toHaveLength(2);
    expect(plan.prompt).toEqual(user(text('c')));
    expect(plan.replay).toHaveLength(0);
  });

  test('trailing tool rounds are planned for playback back to the last plain user turn', () => {
    const messages = [
      user(text('go')),
      assistant(text('first'), call('t1')),
      user(result('t1')),
      assistant({ type: 'thinking', thinking: 'hm', signature: 'sig' }, call('t2', 'read'), call('t3')),
      user(result('t2', [text('file')]), result('t3', 'sent')),
    ];
    const plan = planCall(messages, TOOLS);
    expect(plan.transcript).toHaveLength(0);
    expect(plan.prompt).toEqual(user(text('go')));
    expect(plan.replay).toHaveLength(2);
    expect([...plan.replay[1]!.results.keys()]).toEqual(['t2', 't3']);
    // The CLI must send the prompt alone first, then one more round per playback.
    expect(expectedAtRound(plan, 0)).toHaveLength(1);
    expect(expectedAtRound(plan, 1)).toHaveLength(3);
    expect(expectedAtRound(plan, 2)).toHaveLength(5);
  });

  test('tool rounds inside the history stay in the transcript', () => {
    const plan = planCall([user(text('go')), assistant(call('t1')), user(result('t1')), assistant(text('done')), user(text('next'))], TOOLS);
    expect(plan.transcript).toHaveLength(4);
    expect(plan.replay).toHaveLength(0);
  });

  test('membrane cache markers are stripped and tool_use names get the MCP prefix', () => {
    const plan = planCall([user(text('a', { cache_control: { type: 'ephemeral' } })), assistant(call('t1')), user(result('t1', [text('r', { cache_control: { type: 'ephemeral' } })]))], TOOLS);
    expect(JSON.stringify(plan.expected)).not.toContain('cache_control');
    expect((plan.expected[1]!.content as Array<{ name: string }>)[0]!.name).toBe(`${TOOL_PREFIX}send`);
    expect(shapeMessage(assistant(call('x', `${TOOL_PREFIX}send`))).content).toEqual([call('x', `${TOOL_PREFIX}send`)]);
  });

  const refuses = (messages: WireMessage[], pattern: RegExp) => {
    expect(() => planCall(messages, TOOLS)).toThrow(UnrepresentableRequest);
    expect(() => planCall(messages, TOOLS)).toThrow(pattern);
  };

  test('refuses an assistant prefill', () => refuses([user(text('a')), assistant(text('Sure, '))], /prefill/));
  test('refuses a turn mixing tool results with text', () =>
    refuses([user(text('go')), assistant(call('t1')), user(result('t1'), text('and also'))], /mixes tool results/));
  test('refuses playback of a tool the request does not declare', () =>
    refuses([user(text('go')), assistant(call('t1', 'gone')), user(result('t1'))], /does not declare/));
  test('refuses a tool call left unanswered', () =>
    refuses([user(text('go')), assistant(call('t1'), call('t2')), user(result('t1'))], /has no result/));
  test('refuses results with no plain user turn before them', () =>
    refuses([assistant(call('t1')), user(result('t1'))], /no plain user turn|does not follow/));
});

describe('toMcpResult', () => {
  test('text and base64 images pass; is_error is kept', () => {
    expect(toMcpResult(result('t', 'plain') as never)).toEqual({ content: [{ type: 'text', text: 'plain' }] });
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } };
    expect(toMcpResult(result('t', [text('a'), image], { is_error: true }) as never)).toEqual({
      content: [{ type: 'text', text: 'a' }, { type: 'image', data: 'AAA', mimeType: 'image/png' }],
      isError: true,
    });
  });
  test('other block types cannot pass through an MCP tool', () => {
    expect(() => toMcpResult(result('t', [{ type: 'document', source: {} }]) as never)).toThrow(UnrepresentableRequest);
  });
});

describe('checkWireMessages', () => {
  const expected = [user(text('a')), assistant(call('t1', `${TOOL_PREFIX}send`)), user(result('t1', 'out'))];

  test('accepts the same conversation with CLI cache markers and string/array content variants', () => {
    const wire = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [call('t1', `${TOOL_PREFIX}send`)] },
      { role: 'user', content: [{ tool_use_id: 't1', type: 'tool_result', content: [text('out')], cache_control: { type: 'ephemeral' } }] },
    ];
    expect(checkWireMessages(expected, wire)).toEqual({ ok: true, injected: [] });
  });

  test("tolerates and reports the CLI's reminder blocks on user turns", () => {
    const reminder = '<system-reminder>\nToday\'s date is 2026-10-14.\n</system-reminder>';
    const check = checkWireMessages([user(text('a'))], [{ role: 'user', content: [text(reminder), text('a')] }]);
    expect(check.ok).toBe(true);
    expect(check.injected).toEqual([reminder]);
  });

  test('refuses a cleared tool result (CLI microcompact)', () => {
    const wire = [expected[0], expected[1], user(result('t1', '[Old tool result content cleared]'))];
    const check = checkWireMessages(expected, wire);
    expect(check.ok).toBe(false);
    expect(check.diff).toContain('message 2');
  });

  test('refuses an inserted turn (the resume filler)', () => {
    const wire = [...expected, assistant(text('No response requested.')), user(text('(no content)'))];
    expect(checkWireMessages(expected, wire).ok).toBe(false);
  });

  test('refuses a reminder on an assistant turn and a repaired tool result', () => {
    expect(checkWireMessages([assistant(text('x'))], [assistant(text('<system-reminder>x</system-reminder>'), text('x'))]).ok).toBe(false);
    const repaired = [expected[0], expected[1], user(result('t1', '[Tool call interrupted: …]', { is_error: true }))];
    expect(checkWireMessages(expected, repaired).ok).toBe(false);
  });
});

describe('system and tools', () => {
  test("the request's system text must be the block after the CLI's own", () => {
    const wire = [text('x-anthropic-billing-header: cc_version=…'), text("You are a Claude agent, built on Anthropic's Claude Agent SDK."), text('A\n\nB')];
    expect(checkWireSystem(['A', 'B'], wire)).toEqual({ ok: true, cliBlocks: [String(wire[0]!.text), String(wire[1]!.text)] });
    expect(checkWireSystem(['A'], wire).ok).toBe(false);
  });

  test('tool definitions must arrive verbatim under the prefix', () => {
    const tools = [{ name: 'send', description: 'Send.', input_schema: { type: 'object', properties: { c: { enum: ['a'] } } } }];
    const wire = [{ name: `${TOOL_PREFIX}send`, description: 'Send.', input_schema: { properties: { c: { enum: ['a'] } }, type: 'object' } }];
    expect(checkWireTools(tools, wire)).toEqual({ sanitized: [] });
    expect(checkWireTools(tools, [{ ...wire[0], description: 'Send. (truncated)' }]).diff).toContain('description differs');
    expect(checkWireTools(tools, [...wire, { name: 'Bash', description: '', input_schema: {} }]).diff).toContain('added Bash');
  });

  test("the CLI's NFKC sanitization of tool definitions is tolerated and reported, nothing else", () => {
    const tools = [{ name: 'see', description: 'Pick one… or none\u200b.', input_schema: { type: 'object', properties: { q: { type: 'string', description: 'ﬁle name²' } } } }];
    const sanitizedWire = [{ name: `${TOOL_PREFIX}see`, description: 'Pick one... or none.', input_schema: { type: 'object', properties: { q: { type: 'string', description: 'file name2' } } } }];
    expect(checkWireTools(tools, sanitizedWire)).toEqual({ sanitized: ['see'] });
    expect(checkWireTools(tools, [{ ...sanitizedWire[0], description: 'Pick one... or none' }]).diff).toContain('description differs');
  });
});

describe('session rows', () => {
  test('rows chain by parentUuid and remembered attachments follow their user turn', () => {
    const messages = [user(text('a')), assistant(text('b')), user(text('c'))];
    const keys = prefixKeys(messages);
    const attachment = { type: 'attachment', uuid: 'old', parentUuid: 'old-parent', sessionId: 'old-session', attachment: { type: 'date' } };
    const rows = transcriptRows({ messages, sessionId: 's', cwd: '/w', model: 'claude-x', attachmentsAfter: (k) => (k === keys[0] ? [attachment] : undefined) });
    expect(rows.map((r) => r.type)).toEqual(['user', 'attachment', 'assistant', 'user']);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.parentUuid).toBe(rows[i - 1]!.uuid);
    expect(rows[1]!.uuid).not.toBe('old');
    expect(rows[1]!.sessionId).toBe('s');
    expect((rows[2]!.message as { stop_reason: string }).stop_reason).toBe('end_turn');
  });

  test('the prefix key names the conversation, not just the message', () => {
    const [k1] = prefixKeys([user(text('ok'))]);
    const k2 = prefixKeys([user(text('hi')), assistant(text('?')), user(text('ok'))])[2];
    expect(k1).not.toBe(k2);
  });

  test("the CLI's attachment rows for the prompt are the ones between its user row and the reply", () => {
    const entries = [
      { type: 'queue-operation' },
      { type: 'user', message: { role: 'user', content: [text('hello')] } },
      { type: 'attachment', attachment: { type: 'environment' } },
      { type: 'attachment', attachment: { type: 'date' } },
      { type: 'assistant', message: {} },
      { type: 'attachment', attachment: { type: 'later' } },
    ];
    const found = attachmentsForPrompt(entries, user(text('hello')));
    expect(found.rows.map((e) => (e.attachment as { type: string }).type)).toEqual(['environment', 'date']);
    expect(found.closed).toBe(true);
    expect(attachmentsForPrompt(entries, user(text('other')))).toEqual({ rows: [], closed: false });
  });

  test('rows still arriving are reported open, and counted by what they render', () => {
    const partial = [
      { type: 'user', message: { role: 'user', content: [text('hello')] } },
      { type: 'attachment', attachment: { type: 'environment' }, rendered: [{ content: '<system-reminder>env</system-reminder>' }] },
      { type: 'attachment', attachment: { type: 'session_context' } },
    ];
    const found = attachmentsForPrompt(partial, user(text('hello')));
    expect(found).toMatchObject({ closed: false });
    expect(found.rows).toHaveLength(2);
    expect(renderedCount(found.rows)).toBe(1);
  });
});
