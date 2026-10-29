import { describe, expect, test } from 'bun:test';
import { buildFrameworkAgentConfig } from '../src/framework-agent-config.js';
import { validateRecipe } from '../src/recipe.js';

const base = (value?: unknown) => ({
  name: 'speculative-channel-chunks',
  agent: {
    systemPrompt: 'sys',
    ...(value === undefined ? {} : { speculativeChannelChunks: value }),
  },
});

describe('speculativeChannelChunks recipe wiring', () => {
  test('is off by omission and composes a boolean into AgentConfig', () => {
    const absent = validateRecipe(base());
    expect(absent.agent.speculativeChannelChunks).toBeUndefined();
    expect((buildFrameworkAgentConfig(absent, 'a', 'm', { kind: 's' } as never) as { speculativeChannelChunks?: boolean }).speculativeChannelChunks).toBeUndefined();

    const enabled = validateRecipe(base(true));
    expect((buildFrameworkAgentConfig(enabled, 'a', 'm', { kind: 's' } as never) as { speculativeChannelChunks?: boolean }).speculativeChannelChunks).toBe(true);

    const disabled = validateRecipe(base(false));
    expect((buildFrameworkAgentConfig(disabled, 'b', 'm', { kind: 's' } as never) as { speculativeChannelChunks?: boolean }).speculativeChannelChunks).toBe(false);
  });

  test('rejects non-boolean values', () => {
    for (const value of ['true', 1, null, {}]) {
      expect(() => validateRecipe(base(value))).toThrow(/speculativeChannelChunks/);
    }
  });
});
