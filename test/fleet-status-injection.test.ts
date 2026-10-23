/**
 * context-manager #155 part 5: agent-framework stores the fleet status where
 * the compile placed it, and stores it again only when its text changes. So
 * the status is built from state changes alone, each subagent's start and
 * end as clock times in the recipe's zone, and the same state gives the same
 * text at every start.
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
    expect(first).toBe('[Fleet Status, as of 14:05:09 UTC]\n  scout [spawn] running started 14:05:09 parent:resident "task for scout"');
  });

  test('an end changes it: the end\'s time, the calls of a completed run, and the "as of"', async () => {
    const f = fleet();
    const scout = f.add('scout');
    f.add('miner', { startedAt: T0 + 60_000 });
    const before = await f.status();
    scout.status = 'completed';
    scout.completedAt = T0 + 125_000;
    scout.toolCallsCount = 7;
    const after = await f.status();
    expect(after).not.toBe(before);
    expect(after).toBe(
      '[Fleet Status, as of 14:07:14 UTC]\n'
      + '  scout [spawn] completed started 14:05:09 ended 14:07:14 7calls parent:resident "task for scout"\n'
      + '  miner [spawn] running started 14:06:09 parent:resident "task for miner"',
    );
  });

  test('a failed or stopped run shows its end, and no call count, which was never taken', async () => {
    const f = fleet();
    f.add('scout', { status: 'failed', completedAt: T0 + 3_000 });
    f.add('miner', { status: 'cancelled', completedAt: T0 + 4_000 });
    const text = await f.status();
    expect(text).toContain('  scout [spawn] failed started 14:05:09 ended 14:05:12 parent:resident');
    expect(text).toContain('  miner [spawn] cancelled started 14:05:09 ended 14:05:13 parent:resident');
    expect(text).not.toContain('calls');
  });

  test('its clock times read in the recipe\'s zone, which the heading names', async () => {
    const f = fleet('Europe/Berlin');
    f.add('scout');
    expect(await f.status()).toStartWith('[Fleet Status, as of 16:05:09 Europe/Berlin]\n  scout [spawn] running started 16:05:09 ');
  });

  test('with only async handles pending, it has no time to be "as of"', async () => {
    const f = fleet();
    (f.mod as unknown as { asyncHandles: Map<string, unknown> }).asyncHandles.set('later', {});
    f.mod.parentMap.set('later', 'resident');
    expect(await f.status()).toBe('[Fleet Status]\n  later [async] pending');
  });
});
