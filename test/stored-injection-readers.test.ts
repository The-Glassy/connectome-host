/**
 * context-manager #155 part 5: agent-framework stores a module's `afterUser`
 * injection in the agent's store, marked `metadata.contextInjection:
 * { agent, namespace }`, with participant `system_context:<namespace>`. A
 * reader that answers "what did someone say" leaves such a row out; a reader
 * that shows the transcript labels it as injected.
 */
import { describe, expect, test } from 'bun:test';
import { storedInjectionLabel, storedInjectionOf } from '../src/stored-injection.js';
import { namingSummary } from '../src/synesthete.js';
import { historyInjectionLine } from '../src/tui.js';
import { toWireEntry } from '../src/modules/web-ui-module.js';
import { handleCommand, createBranchState } from '../src/commands.js';
import { SubagentModule } from '../src/modules/subagent-module.js';

const lessonsRow = (agent = 'alice') => ({
  id: 'inj1',
  participant: 'system_context:retrieval',
  content: [{ type: 'text', text: '## Retrieved Knowledge, for the message beginning "hello"\n- [90%] a lesson' }],
  metadata: { contextInjection: { agent, namespace: 'retrieval', contentHash: 'h1' } },
});

describe('the mark', () => {
  test('reads agent-framework\'s mark, and a partial one as no mark, as the compile does', () => {
    const whole = { agent: 'alice', namespace: 'retrieval', contentHash: 'h1' };
    expect(storedInjectionOf({ contextInjection: whole })).toEqual(whole);
    for (const metadata of [undefined, null, 'x', {}, { contextInjection: true }, { contextInjection: null },
      { contextInjection: { namespace: 'retrieval', contentHash: 'h1' } },
      { contextInjection: { agent: 'alice', contentHash: 'h1' } },
      { contextInjection: { agent: 'alice', namespace: 'retrieval' } },
      { contextInjection: { ...whole, agent: 7 } },
      { system: true, kind: 'clock' }]) {
      expect(storedInjectionOf(metadata)).toBeUndefined();
    }
  });

  test('its label names the namespace and the agent', () => {
    expect(storedInjectionLabel({ agent: 'alice', namespace: 'retrieval', contentHash: 'h1' })).toBe('[retrieval, injected for alice]');
  });
});

describe('readers that answer "what did someone say" leave stored injections out', () => {
  test('session naming reads the conversation, not the first turn\'s lessons block', () => {
    const summary = namingSummary([
      { participant: 'user', content: [{ type: 'text', text: 'Let us plan the migration.' }] },
      lessonsRow(),
      { participant: 'alice', content: [{ type: 'text', text: 'Here is a plan.' }] },
    ]);
    expect(summary).toBe('user: Let us plan the migration.\nalice: Here is a plan.');
  });

  test('a subagent whose last act was a tool call doesn\'t report a stored injection as its answer', () => {
    const mod = new SubagentModule({ provider: 'mock' });
    const extract = (mod as unknown as { extractLastAssistantText: (cm: unknown) => string }).extractLastAssistantText.bind(mod);
    const messages = [
      { participant: 'user', content: [{ type: 'text', text: 'Find the file.' }] },
      { participant: 'scout', content: [{ type: 'text', text: 'It is in src/.' }] },
      { participant: 'scout', content: [{ type: 'tool_use', id: 't1', name: 'look', input: {} }] },
      { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
      lessonsRow('scout'),
    ];
    expect(extract({ getAllMessages: () => messages })).toBe('It is in src/.');
  });
});

describe('readers that show the transcript label stored injections', () => {
  test('the TUI\'s history replay shows one dim line under its label', () => {
    expect(historyInjectionLine(lessonsRow()))
      .toBe('[retrieval, injected for alice] ## Retrieved Knowledge, for the message beginning "hello" - [90%] a lesson');
    const long = { ...lessonsRow(), content: [{ type: 'text', text: 'x'.repeat(300) }] };
    const line = historyInjectionLine(long)!;
    expect(line).toHaveLength(118);
    expect(line.endsWith('…')).toBe(true);
    expect(historyInjectionLine({ ...lessonsRow(), content: [] })).toBe('[retrieval, injected for alice]');
    expect(historyInjectionLine({ content: [{ type: 'text', text: 'hi' }] })).toBeUndefined();
  });

  test('the Web UI shows a labelled system row, not the agent\'s message', () => {
    const entry = toWireEntry(lessonsRow(), 4);
    expect(entry.participant).toBe('system');
    expect(entry.text).toBe('[retrieval, injected for alice]\n## Retrieved Knowledge, for the message beginning "hello"\n- [90%] a lesson');
    expect(entry.blocks[0]).toEqual({ kind: 'text', text: '[retrieval, injected for alice]' });
    // Without the mark, the same participant is the agent's, as before.
    const unmarked = toWireEntry({ ...lessonsRow(), metadata: undefined }, 4);
    expect(unmarked.participant).toBe('assistant');
    expect(unmarked.text).not.toContain('injected');
  });
});

describe('/undo steps back past stored injections', () => {
  interface Row { id: string; participant: string; content: unknown[]; metadata?: unknown }
  function world(rows: Row[]) {
    const branches = new Map<string, Row[]>([['main', rows]]);
    let current = 'main';
    const cm = {
      currentBranch: () => ({ id: current, name: current, head: branches.get(current)!.length }),
      queryMessages: () => ({ messages: branches.get(current)! }),
      branchAt: (id: string, name: string): string => {
        const msgs = branches.get(current)!;
        const at = msgs.findIndex(m => m.id === id);
        if (at === -1) throw new Error(`Message not found: ${id}`);
        branches.set(name, msgs.slice(0, at + 1));
        return name;
      },
      switchBranch: async (name: string) => { current = name; },
    };
    const app = {
      framework: { getAgent: () => undefined, getAllAgents: () => [{ getContextManager: () => cm }], getAllModules: () => [] },
      branchState: createBranchState(),
      userMessageCount: 0,
    } as never;
    return { app, ids: async () => { return branches.get(current)!.map(m => m.id); } };
  }
  const injection = (id: string): Row => ({ id, participant: 'system_context:retrieval', content: [], metadata: { contextInjection: { agent: 'alice', namespace: 'retrieval', contentHash: 'h1' } } });

  test('after a turn, it undoes to the row before the turn\'s stored block', async () => {
    const w = world([
      { id: 'u1', participant: 'user', content: [] },
      { id: 'a1', participant: 'alice', content: [] },
      { id: 'u2', participant: 'user', content: [] },
      injection('i2'),
      injection('f2'),
      { id: 'a2', participant: 'alice', content: [] },
    ]);
    await handleCommand('/undo', w.app).asyncWork;
    expect(await w.ids()).toEqual(['u1', 'a1', 'u2']);
  });

  test('a stored block after the agent\'s last reply isn\'t taken for it', async () => {
    const w = world([
      { id: 'u1', participant: 'user', content: [] },
      injection('i1'),
      { id: 'a1', participant: 'alice', content: [] },
      { id: 'u2', participant: 'user', content: [] },
      injection('i2'),
    ]);
    await handleCommand('/undo', w.app).asyncWork;
    expect(await w.ids()).toEqual(['u1']);
  });

  test('with only stored blocks before the reply, there\'s nothing to undo to', () => {
    const w = world([injection('i1'), { id: 'a1', participant: 'alice', content: [] }]);
    expect(handleCommand('/undo', w.app).lines[0]!.text).toBe('Nothing to undo (no agent messages found).');
  });
});
