/**
 * Recipe surface for tune-out's subconscious resident (agent-framework#77):
 * schema validation of the `subconscious` block. The block passes through to
 * FrameworkConfig.subconscious verbatim, so validation is the host's whole
 * contribution — a typo'd key or a missing mode block must fail at recipe
 * load, not surface as a subconscious running on an empty system prompt.
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

function baseRecipe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Test',
    agent: { name: 'sherlock', systemPrompt: 'test' },
    ...extra,
  };
}

const MODE = 'You are the Subconscious. Watch tuned-out channels and report in second person.';

describe('validateRecipe — subconscious schema', () => {
  test('absent block is accepted', () => {
    expect(() => validateRecipe(baseRecipe())).not.toThrow();
    expect(validateRecipe(baseRecipe()).subconscious).toBeUndefined();
  });

  test('full valid block is accepted and passes through verbatim', () => {
    const block = {
      enabled: true,
      name: 'Subconscious',
      model: 'claude-sonnet-4-5',
      systemPrompt: MODE,
      allowChannelSpeech: false,
      reAnchorFraction: 0.5,
    };
    const recipe = validateRecipe(baseRecipe({ subconscious: block }));
    expect(recipe.subconscious).toEqual(block);
  });

  test('minimal block: enabled + systemPrompt', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE } }))).not.toThrow();
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: false, systemPrompt: MODE } }))).not.toThrow();
  });

  test('non-object block is refused', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: true }))).toThrow(/subconscious must be an object/);
    expect(() => validateRecipe(baseRecipe({ subconscious: [] }))).toThrow(/subconscious must be an object/);
  });

  test('enabled must be a boolean', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: 'yes', systemPrompt: MODE } })))
      .toThrow(/subconscious\.enabled must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { systemPrompt: MODE } })))
      .toThrow(/subconscious\.enabled must be a boolean/);
  });

  test('systemPrompt is required and non-empty — the mode block is the whole character', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true } })))
      .toThrow(/subconscious\.systemPrompt must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: '   ' } })))
      .toThrow(/subconscious\.systemPrompt must be a non-empty string/);
  });

  test('unknown fields are refused by name', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, cadence: 30 } })))
      .toThrow(/unknown field "cadence"/);
  });

  test('name and model must be non-empty strings when present', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, name: '' } })))
      .toThrow(/subconscious\.name must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, model: 7 } })))
      .toThrow(/subconscious\.model must be a non-empty string/);
  });

  test('allowChannelSpeech must be a boolean; reAnchorFraction must be in (0, 1]', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, allowChannelSpeech: 'no' } })))
      .toThrow(/allowChannelSpeech must be a boolean/);
    for (const bad of [0, 1.5, -0.2, 'half']) {
      expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, reAnchorFraction: bad } })))
        .toThrow(/reAnchorFraction must be a number in \(0, 1\]/);
    }
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, systemPrompt: MODE, reAnchorFraction: 1 } })))
      .not.toThrow();
  });

  test('reader "forks": model and voice are required; its keys are its own', () => {
    const forks = { enabled: true, reader: 'forks', model: 'claude-sonnet-4-5', voice: 'You are reading for sherlock.' };
    expect(validateRecipe(baseRecipe({ subconscious: forks })).subconscious).toEqual(forks);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', voice: 'v' } })))
      .toThrow(/subconscious\.model is required for reader "forks"/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'forks', model: 'm' } })))
      .toThrow(/subconscious\.voice must be a non-empty string/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, systemPrompt: MODE } })))
      .toThrow(/unknown field "systemPrompt".*for reader "forks"/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { ...forks, forkIdleTimeoutMs: 0 } })))
      .toThrow(/forkIdleTimeoutMs must be a positive number/);
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'elsewhere', systemPrompt: MODE } })))
      .toThrow(/reader must be "persistent" or "forks"/);
  });

  test('reader "persistent" may be stated and keeps the persistent schema', () => {
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', systemPrompt: MODE } }))).not.toThrow();
    expect(() => validateRecipe(baseRecipe({ subconscious: { enabled: true, reader: 'persistent', voice: 'v', model: 'm' } })))
      .toThrow(/unknown field "voice"/);
  });
});

describe('validateRecipe — speech and tuneOut (Dendrite admission options)', () => {
  test('speech.locus takes the two rules and nothing else', () => {
    expect(validateRecipe(baseRecipe({ speech: { locus: 'delivery' } })).speech).toEqual({ locus: 'delivery' });
    expect(validateRecipe(baseRecipe({ speech: { locus: 'latest-inbound' } })).speech).toEqual({ locus: 'latest-inbound' });
    expect(() => validateRecipe(baseRecipe({ speech: { locus: 'sticky' } }))).toThrow(/speech\.locus must be "delivery" or "latest-inbound"/);
    expect(() => validateRecipe(baseRecipe({ speech: { fallback: 'x' } }))).toThrow(/speech has unknown field "fallback"/);
    expect(() => validateRecipe(baseRecipe({ speech: 'delivery' }))).toThrow(/speech must be an object/);
  });

  test('tuneOut.enabled offers tune_out without a reader', () => {
    expect(validateRecipe(baseRecipe({ tuneOut: { enabled: true } })).tuneOut).toEqual({ enabled: true });
    expect(() => validateRecipe(baseRecipe({ tuneOut: { enabled: 'yes' } }))).toThrow(/tuneOut\.enabled must be a boolean/);
    expect(() => validateRecipe(baseRecipe({ tuneOut: { silent: true } }))).toThrow(/tuneOut has unknown field "silent"/);
  });

  test('tuneOut.announce turns the excepted-channel announcement off', () => {
    expect(validateRecipe(baseRecipe({ tuneOut: { enabled: true, announce: false } })).tuneOut).toEqual({ enabled: true, announce: false });
    expect(() => validateRecipe(baseRecipe({ tuneOut: { announce: 'no' } }))).toThrow(/tuneOut\.announce must be a boolean/);
  });
});
