/**
 * Every recipe number that must be positive or non-negative must also be
 * finite. JSON has no Infinity, but `1e309` parses to it, and such a value
 * passed the sign checks; saveRecipe() then wrote it back as `null`, and the
 * next load, from the saved recipe the host resumes with, refused the field
 * that had been accepted the day before. Refuse it at the first load.
 */
import { describe, test, expect } from 'bun:test';
import { validateRecipe } from '../src/recipe.js';

const OVERFLOW = JSON.parse('1e309') as number; // Infinity, as JSON gives it

function recipe(agent: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return { name: 'finite-test', agent: { systemPrompt: 'sys', ...agent }, ...top };
}

describe('recipe numbers must be finite', () => {
  const cases: Array<[string, (value: number) => Record<string, unknown>, RegExp]> = [
    ['agent.maxStreamTokens', (v) => recipe({ maxStreamTokens: v }), /maxStreamTokens must be a positive number/],
    ['agent.thinking.budgetTokens', (v) => recipe({ thinking: { enabled: true, budgetTokens: v } }), /budgetTokens must be a positive number/],
    ['agent.responses.compactThreshold', (v) => recipe({ responses: { compactThreshold: v } }), /compactThreshold must be a positive number/],
    ['agent.cacheKeepalive.refreshAfterMinutes', (v) => recipe({ cacheKeepalive: { refreshAfterMinutes: v } }), /refreshAfterMinutes must be a positive number/],
    ['agent.cacheKeepalive.maxIdleHours', (v) => recipe({ cacheKeepalive: { maxIdleHours: v } }), /maxIdleHours must be a positive number/],
    ['modules.fleet.readyTimeoutMs', (v) => recipe({}, { modules: { fleet: { readyTimeoutMs: v } } }), /readyTimeoutMs must be a non-negative number/],
    ['codeExecution.scriptTimeoutMs', (v) => recipe({}, { codeExecution: { enabled: true, scriptTimeoutMs: v } }), /scriptTimeoutMs must be a non-negative number/],
  ];

  for (const [field, build, message] of cases) {
    test(`${field}: Infinity and an overflowing JSON number are refused by name; a finite value is kept`, () => {
      for (const bad of [Infinity, OVERFLOW, Number.NaN]) {
        expect(() => validateRecipe(build(bad))).toThrow(message);
      }
      expect(() => validateRecipe(build(1))).not.toThrow();
    });
  }

  test('what passes validation survives the save-and-resume round trip', () => {
    // The failure this guards against: a value accepted once, written as null
    // by JSON.stringify, refused on resume. With Infinity refused up front,
    // every accepted recipe re-parses to the same numbers.
    const accepted = validateRecipe(recipe({ maxStreamTokens: 80_000, thinking: { enabled: true, budgetTokens: 1024 } }));
    const resumed = JSON.parse(JSON.stringify(accepted)) as Record<string, unknown>;
    expect(() => validateRecipe(resumed)).not.toThrow();
    expect(JSON.stringify(Infinity)).toBe('null'); // why the round trip would otherwise refuse
  });
});
