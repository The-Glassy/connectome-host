#!/usr/bin/env bun
// Spike bench for the claude-agent-sdk provider (src/agent-sdk/). Runs the
// real adapter, the real Agent SDK and the real Claude Code CLI against a
// local stand-in for the Messages API, and reports what reached "the API":
//
//   - spawn cost: time from call to the CLI's first request, and to response;
//   - fidelity: whether the forwarded messages are the requested ones;
//   - cache-prefix stability: whether turn k's request starts with exactly
//     the bytes turn k-1 sent (the precondition for a prompt-cache hit);
//   - tool rounds: a request ending in tool results, played back locally;
//   - hygiene: CLI processes and temp dirs left behind.
//
// No credential or network is needed; nothing leaves the machine.
//
//   npm install --no-save @anthropic-ai/claude-agent-sdk   # once
//   bun scripts/agent-sdk-spike.ts [--runs 5] [--json out.json]
//
// AGENT_SDK_MODULE=/path/to/sdk.mjs points at an SDK installed elsewhere.

import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { ProviderRequest } from '@animalabs/membrane';
import { ClaudeAgentSdkAdapter, AGENT_SDK_PACKAGE, type AgentSdk, type AgentSdkAuth } from '../src/agent-sdk/adapter.js';
import { normalizeMessage, prefixToolName, stableJson } from '../src/agent-sdk/transcript.js';

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf('--runs') + 1] ?? 5) || 5;
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined;
const MODEL = 'claude-opus-4-6';

// --- Stand-in upstream -----------------------------------------------------

type Captured = { path: string; headers: Record<string, string>; body: any };
const captured: Captured[] = [];
let reply: (body: any) => { blocks: any[]; stop: string } = () => ({ blocks: [{ type: 'text', text: 'ok' }], stop: 'end_turn' });
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = await req.json().catch(() => null);
    captured.push({ path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body });
    if (url.pathname !== '/v1/messages') return new Response('{}', { status: 404 });
    const { blocks, stop } = reply(body);
    const out: string[] = [];
    const ev = (type: string, data: any) => out.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: { id: 'msg_up', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    blocks.forEach((b, i) => {
      if (b.type === 'text') {
        ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        for (const piece of b.text.match(/[\s\S]{1,6}/g) ?? []) ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: piece } });
      } else if (b.type === 'thinking') {
        ev('content_block_start', { index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
        ev('content_block_delta', { index: i, delta: { type: 'thinking_delta', thinking: b.thinking } });
        ev('content_block_delta', { index: i, delta: { type: 'signature_delta', signature: b.signature } });
      } else if (b.type === 'tool_use') {
        ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
      }
      ev('content_block_stop', { index: i });
    });
    ev('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } });
    ev('message_stop', {});
    return new Response(out.join(''), { headers: { 'content-type': 'text/event-stream' } });
  },
});
const UPSTREAM = `http://127.0.0.1:${upstream.port}`;

async function loadSdk(): Promise<AgentSdk> {
  const spec = process.env.AGENT_SDK_MODULE ?? AGENT_SDK_PACKAGE;
  return (await import(spec)) as AgentSdk;
}
const sdk = await loadSdk();

const roots: string[] = [];
function adapter(auth: AgentSdkAuth): ClaudeAgentSdkAdapter {
  const root = mkdtempSync(join(tmpdir(), 'agent-sdk-spike-'));
  roots.push(root);
  return new ClaudeAgentSdkAdapter({ auth, upstreamBaseURL: UPSTREAM, cwd: join(root, 'cwd'), configDir: join(root, 'config'), sdk });
}
const API_KEY: AgentSdkAuth = { apiKey: 'sk-ant-api03-spike' };
const OAUTH: AgentSdkAuth = { oauthToken: 'sk-ant-oat01-spike' };

const TOOLS = [
  { name: 'send_message', description: 'Post to a channel.', input_schema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },
  { name: 'read_file', description: 'Read a file.', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
];
const SYSTEM = [{ type: 'text', text: 'You are Ada, a long-lived resident.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Be brief.' }];

function req(messages: any[], extra: Partial<ProviderRequest> = {}): ProviderRequest {
  return { model: MODEL, maxTokens: 2048, system: SYSTEM, tools: TOOLS, messages, ...extra } as ProviderRequest;
}

const lastApi = () => captured.filter((c) => c.path.startsWith('/v1/messages')).at(-1)!;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const report: Record<string, unknown> = {};
const lines: string[] = [];
const log = (s = '') => { lines.push(s); console.log(s); };

const claudePids = () => {
  try { return execSync('pgrep -f "claude-agent-sdk-.*/claude" || true').toString().trim().split('\n').filter(Boolean).length; } catch { return 0; }
};
const resumeDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('claude-resume-')).length;
const pidsBefore = claudePids();
const dirsBefore = resumeDirs();

// --- 1. Spawn cost ------------------------------------------------------------

for (const [label, auth] of [['api-key (bare mode)', API_KEY], ['subscription token', OAUTH]] as const) {
  const a = adapter(auth);
  const first: number[] = [];
  const total: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await a.stream(req([{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, { role: 'user', content: [{ type: 'text', text: `ping ${i}` }] }]), { onChunk: () => {} });
    const meta = (r.raw as any).agentSdk;
    first.push(meta.firstRequestMs);
    total.push(meta.totalMs);
  }
  a.dispose();
  report[`spawn:${label}`] = { firstRequestMs: { p50: pct(first, 50), max: Math.max(...first) }, totalMs: { p50: pct(total, 50), max: Math.max(...total) } };
  log(`spawn  ${label.padEnd(22)} first request p50 ${pct(first, 50)}ms (max ${Math.max(...first)}) · response p50 ${pct(total, 50)}ms (max ${Math.max(...total)}) · n=${RUNS}`);
}

// --- 2. Fidelity + cache-prefix stability across turns -------------------------

for (const [label, auth] of [['api-key (bare mode)', API_KEY], ['subscription token', OAUTH]] as const) {
  const a = adapter(auth);
  let messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Good morning, Ada.' }] }];
  const wires: any[][] = [];
  const injectedPerTurn: number[] = [];
  let i = 0;
  reply = () => ({ blocks: [{ type: 'thinking', thinking: `t${i}`, signature: `sig-${i}` }, { type: 'text', text: `reply ${i}` }], stop: 'end_turn' });
  for (; i < 4; i++) {
    const r = await a.stream(req(messages, { thinking: { type: 'adaptive' } }), { onChunk: () => {} });
    wires.push(lastApi().body.messages);
    injectedPerTurn.push((r.raw as any).agentSdk.cliInjectedReminders.length);
    messages = [...messages, { role: 'assistant', content: r.content }, { role: 'user', content: [{ type: 'text', text: `turn ${i + 1}` }] }];
  }
  a.dispose();
  const stable = wires.slice(1).map((w, k) => prefixEqualIgnoringCc(wires[k]!, w));
  const system = lastApi().body.system.map((b: any) => String(b.text).slice(0, 60));
  const billing = [...new Set(captured.slice(-4).map((c) => String(c.body.system?.[0]?.text)))];
  report[`prefix:${label}`] = { stableAcrossTurns: stable, injectedRemindersPerTurn: injectedPerTurn, system, billingHeaderValues: billing };
  log(`prefix ${label.padEnd(22)} turn k starts with turn k-1's bytes: ${stable.map((s) => (s ? 'yes' : 'NO')).join(' ')} · CLI reminders per turn: ${injectedPerTurn.join(' ')}`);
  log(`       system blocks on the wire: ${JSON.stringify(system)}`);
  log(`       billing-header values across the 4 turns: ${JSON.stringify(billing)}`);
}

function stripCc(m: any): any {
  return { ...m, content: Array.isArray(m.content) ? m.content.map(({ cache_control, ...b }: any) => b) : m.content };
}
function prefixEqualIgnoringCc(prev: any[], next: any[]): boolean {
  return stableJson(prev.map(stripCc)) === stableJson(next.slice(0, prev.length).map(stripCc));
}

// --- 3. Tool rounds (played back) ----------------------------------------------

{
  const a = adapter(API_KEY);
  reply = () => ({ blocks: [{ type: 'text', text: 'all sent' }], stop: 'end_turn' });
  const history: any[] = [{ role: 'user', content: [{ type: 'text', text: 'tell both channels' }] }];
  const rounds = 5;
  const timings: Array<{ rounds: number; firstRequestMs: number; totalMs: number; fidelity: boolean }> = [];
  for (let n = 1; n <= rounds; n++) {
    history.push(
      { role: 'assistant', content: [
        { type: 'thinking', thinking: `round ${n}`, signature: `sig-r${n}` },
        { type: 'tool_use', id: `toolu_${n}a`, name: 'send_message', input: { channel: 'a', text: `m${n}` } },
        { type: 'tool_use', id: `toolu_${n}b`, name: 'read_file', input: { path: `/f${n}` } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: `toolu_${n}a`, content: `delivered ${n}` },
        { type: 'tool_result', tool_use_id: `toolu_${n}b`, content: [{ type: 'text', text: `contents ${n}` }] },
      ] },
    );
    const before = captured.length;
    const r = await a.stream(req(history), { onChunk: () => {} });
    const wire = lastApi().body.messages;
    const expected = history.map((m) => ({ role: m.role, content: m.content.map((b: any) => (b.type === 'tool_use' ? { ...b, name: prefixToolName(b.name) } : b)) }));
    const fidelity = stableJson(wire.map(normalizeMessage)) === stableJson(expected.map(normalizeMessage));
    const meta = (r.raw as any).agentSdk;
    timings.push({ rounds: n, firstRequestMs: meta.firstRequestMs, totalMs: meta.totalMs, fidelity: fidelity && captured.length - before === 1 });
  }
  a.dispose();
  report.toolRounds = timings;
  log(`tools  played-back rounds → response ms: ${timings.map((t) => `${t.rounds}:${t.totalMs}`).join(' ')} · one upstream request each, forwarded messages = requested: ${timings.every((t) => t.fidelity) ? 'yes' : 'NO'}`);
}

// --- 4. Refused shapes ------------------------------------------------------------

{
  const a = adapter(API_KEY);
  const cases: Array<[string, any[]]> = [
    ['assistant prefill', [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Sure, ' }]],
    ['tool results + text in one turn', [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'x' }, { type: 'text', text: 'and also…' }] },
    ]],
  ];
  const refused: Record<string, string> = {};
  for (const [name, messages] of cases) {
    try {
      await a.stream(req(messages), { onChunk: () => {} });
      refused[name] = 'ACCEPTED';
    } catch (e: any) {
      refused[name] = `${e.type}: ${String(e.message).slice(0, 110)}`;
    }
  }
  a.dispose();
  report.refused = refused;
  for (const [k, v] of Object.entries(refused)) log(`refuse ${k.padEnd(32)} ${v}`);
}

await Bun.sleep(1500);
// Transcript files the CLI wrote under this run's config dirs and did not
// get removed (a fresh session writes one per call; the adapter deletes it).
const sessionFiles = () => roots
  .flatMap((root) => { const p = join(root, 'config', 'projects'); try { return readdirSync(p).flatMap((k) => readdirSync(join(p, k)).filter((f) => f.endsWith('.jsonl'))); } catch { return []; } })
  .length;
report.hygiene = { cliProcessesLeft: claudePids() - pidsBefore, resumeTempDirsLeft: resumeDirs() - dirsBefore, sessionFilesLeft: sessionFiles() };
log(`hygiene CLI processes left running: ${claudePids() - pidsBefore} · /tmp/claude-resume-* dirs left: ${resumeDirs() - dirsBefore} · transcript files left under config dirs: ${sessionFiles()}`);
upstream.stop(true);
if (JSON_OUT) await Bun.write(JSON_OUT, JSON.stringify(report, null, 2));
process.exit(0);
