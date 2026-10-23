/**
 * context-manager #155 part 5: agent-framework stores the fleet status where
 * the compile placed it, and stores it again when its text differs from what
 * the agent's last request held. So the status is built from state changes
 * alone: the subagents running or waiting, each started one with its start
 * as a clock time in the recipe's zone, under "as of" the latest start or
 * end, so the same state gives the same text at every start. A finished run
 * leaves the list, having reported in its launcher's conversation (Agnes-1009,
 * room-203 #196238, #197184).
 */
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { SubagentModule, type ActiveSubagent } from '../src/modules/subagent-module.js';

const T0 = Date.UTC(2026, 9, 23, 14, 5, 9);

function fleet(timeZone = 'UTC') {
  const mod = new SubagentModule({ provider: 'mock', timeZone });
  (mod as unknown as { ctx: unknown }).ctx = { getState: () => ({ hudEnabled: true }), setState: () => {} };
  const add = (name: string, fields: Partial<ActiveSubagent> = {}): ActiveSubagent => {
    const entry: ActiveSubagent = {
      name, type: 'spawn', task: `task for ${name}`, status: 'running',
      startedAt: T0, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0, ...fields,
    };
    mod.activeSubagents.set(`entry-${name}`, entry);
    mod.parentMap.set(name, 'resident');
    return entry;
  };
  const status = async (): Promise<string | undefined> =>
    ((await mod.gatherContext('resident'))[0]?.content[0] as { text: string } | undefined)?.text;
  return { mod, add, status };
}

afterEach(() => { setSystemTime(); });

describe('the fleet status', () => {
  test('a running subagent\'s status reads the same at every start', async () => {
    const f = fleet();
    f.add('scout');
    setSystemTime(new Date(T0 + 5_000));
    const first = await f.status();
    setSystemTime(new Date(T0 + 95_000));
    expect(await f.status()).toBe(first);
    expect(first).toBe('[Fleet Status, as of 14:05:09 UTC]\n  scout [spawn] running since 14:05:09 parent:resident "task for scout"');
  });

  test('a run that ends leaves the list, and its end moves the "as of"', async () => {
    const f = fleet();
    const scout = f.add('scout');
    f.add('miner', { startedAt: T0 + 60_000 });
    const before = await f.status();
    scout.status = 'completed';
    scout.completedAt = T0 + 125_000;
    scout.toolCallsCount = 7;
    const after = await f.status();
    expect(after).not.toBe(before);
    expect(after).toBe('[Fleet Status, as of 14:07:14 UTC]\n  miner [spawn] running since 14:06:09 parent:resident "task for miner"');
  });

  test('failed and stopped runs leave the list as a completed one does', async () => {
    const f = fleet();
    f.add('scout', { status: 'failed', completedAt: T0 + 3_000 });
    f.add('miner', { status: 'cancelled', completedAt: T0 + 4_000 });
    f.add('clerk');
    expect(await f.status()).toBe('[Fleet Status, as of 14:05:13 UTC]\n  clerk [spawn] running since 14:05:09 parent:resident "task for clerk"');
  });

  test('when the last run ends, the status says none is running, so no copy listing it is the newest', async () => {
    const f = fleet();
    const scout = f.add('scout');
    scout.status = 'completed';
    scout.completedAt = T0 + 30_000;
    expect(await f.status()).toBe('[Fleet Status, as of 14:05:39 UTC]\n  (none running)');
  });

  test('a fleet that never started a subagent has no status at all', async () => {
    expect(await fleet().status()).toBeUndefined();
  });

  test('however many runs have ended, the status lists only the running ones', async () => {
    const f = fleet();
    for (let i = 0; i < 300; i++) f.add(`done-${i}`, { status: 'completed', completedAt: T0 + i * 1000 });
    f.add('scout', { startedAt: T0 + 400_000 });
    const text = (await f.status())!;
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('scout [spawn] running since 14:11:49');
  });

  test('its clock times read in the recipe\'s zone, which the heading names', async () => {
    const f = fleet('Europe/Berlin');
    f.add('scout');
    expect(await f.status()).toStartWith('[Fleet Status, as of 16:05:09 Europe/Berlin]\n  scout [spawn] running since 16:05:09 ');
  });

  test('with only async handles pending, it has no time to be "as of"', async () => {
    const f = fleet();
    (f.mod as unknown as { asyncHandles: Map<string, unknown> }).asyncHandles.set('later', {});
    f.mod.parentMap.set('later', 'resident');
    expect(await f.status()).toBe('[Fleet Status]\n  later [async] pending');
  });

  test('an agent shown a status hears when what it listed ends before it started', async () => {
    const f = fleet();
    // A queued async run, waiting for a slot: no start yet, so no "as of".
    (f.mod as unknown as { asyncHandles: Map<string, unknown> }).asyncHandles.set('later', {});
    f.mod.parentMap.set('later', 'resident');
    expect(await f.status()).toBe('[Fleet Status]\n  later [async] pending');
    // Cancelled while it waited: its handle and its parent link go.
    (f.mod as unknown as { asyncHandles: Map<string, unknown> }).asyncHandles.delete('later');
    f.mod.parentMap.delete('later');
    expect(await f.status()).toBe('[Fleet Status]\n  (none running)');
    // Told once: its context's newest status says so, and nothing is kept
    // for it any more.
    expect(await f.status()).toBeUndefined();
    expect((f.mod as unknown as { fleetStatusListedFor: Set<string> }).fleetStatusListedFor.size).toBe(0);
  });
});

describe('the hud setting', () => {
  test('stays on across a lifecycle transition, whose state write replaces the module\'s state', async () => {
    const mod = new SubagentModule({ provider: 'mock', timeZone: 'UTC' });
    let state: Record<string, unknown> = {};
    (mod as unknown as { ctx: unknown }).ctx = {
      getState: () => state,
      setState: (next: Record<string, unknown>) => { state = next; },
    };
    await mod.handleToolCall({ id: 't1', name: 'hud', input: { enabled: true } } as never);
    mod.activeSubagents.set('entry-scout', {
      name: 'scout', type: 'spawn', task: 'task for scout', status: 'running',
      startedAt: T0, lastActivityAt: T0, toolCallsCount: 0, findingsCount: 0,
    });
    mod.parentMap.set('scout', 'resident');
    (mod as unknown as { persistState: () => void }).persistState();
    expect(state.hudEnabled).toBe(true);
    const text = ((await mod.gatherContext('resident'))[0]?.content[0] as { text: string } | undefined)?.text;
    expect(text).toContain('scout [spawn] running since');
  });
});

describe('an async run\'s result', () => {
  function delivering(registered: string[]) {
    const mod = new SubagentModule({ provider: 'mock', timeZone: 'UTC', parentAgentName: 'resident' });
    const written: Array<{ text: string; forAgent?: string }> = [];
    (mod as unknown as { ctx: unknown }).ctx = {
      getAgents: () => registered.map((name) => ({ name, model: 'mock', status: 'idle' })),
      addMessage: (_participant: string, content: Array<{ text: string }>, _metadata?: unknown, opts?: { forAgent?: string }) => {
        // As agent-framework's module write: a name it doesn't list throws.
        if (opts?.forAgent !== undefined && !registered.includes(opts.forAgent)) throw new Error(`Unknown agent: "${opts.forAgent}"`);
        written.push({ text: content[0]!.text, ...(opts?.forAgent !== undefined ? { forAgent: opts.forAgent } : {}) });
        return 'm1';
      },
      pushEvent: () => {},
    };
    const deliver = mod as unknown as {
      deliverAsyncResult: (name: string, result: { summary: string }, launcher: string | undefined) => void;
      deliverAsyncError: (name: string, err: unknown, launcher: string | undefined) => void;
    };
    return { written, deliver };
  }

  test('lands in the window of the agent that launched it, naming a launcher that isn\'t the primary', () => {
    const d = delivering(['resident', 'fork-y']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, 'fork-y');
    d.deliver.deliverAsyncError('miner', new Error('broke'), 'fork-y');
    d.deliver.deliverAsyncResult('lead', { summary: 'mine' }, 'resident');
    expect(d.written).toEqual([
      { text: "[Subagent 'scout' returned, for 'fork-y']\n\ndone", forAgent: 'fork-y' },
      { text: "[Subagent 'miner' failed, for 'fork-y']\n\nError: broke", forAgent: 'fork-y' },
      { text: "[Subagent 'lead' returned]\n\nmine", forAgent: 'resident' },
    ]);
  });

  test('whose launcher has ended lands in the residents\' slot, naming whom it was for', () => {
    const d = delivering(['resident']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, 'fork-y');
    expect(d.written).toEqual([{ text: "[Subagent 'scout' returned, for 'fork-y', which has ended]\n\ndone" }]);
  });

  test('with no launcher named lands in the residents\' slot as before', () => {
    const d = delivering(['resident']);
    d.deliver.deliverAsyncResult('scout', { summary: 'done' }, undefined);
    expect(d.written).toEqual([{ text: "[Subagent 'scout' returned]\n\ndone" }]);
  });

  test('a write that fails for another reason throws, as before', () => {
    const d = delivering(['resident', 'fork-y']);
    (d.deliver as unknown as { ctx: { addMessage: () => never } }).ctx.addMessage = () => { throw new Error('store unavailable'); };
    expect(() => d.deliver.deliverAsyncResult('scout', { summary: 'done' }, 'fork-y')).toThrow('store unavailable');
  });
});
