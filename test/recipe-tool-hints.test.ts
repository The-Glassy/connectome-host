/**
 * Per-server `toolHints` (MCPL RFC-014 opt-in): recipe validation,
 * mcpl-servers.json carrying it, the recipe's override of it for a server
 * from that file, and the server list the host hands agent-framework
 * keeping it as configured.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateRecipe } from '../src/recipe.js';
import {
  applyAgentOverlay,
  loadMcplServers,
  mergeRecipeServers,
  RECIPE_OVERRIDABLE_SERVER_FIELDS,
} from '../src/mcpl-config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function serversFile(servers: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-hints-'));
  dirs.push(dir);
  const path = join(dir, 'mcpl-servers.json');
  writeFileSync(path, JSON.stringify({ mcplServers: servers }));
  return path;
}

function recipe(server: Record<string, unknown>) {
  return { name: 'tool-hints-test', agent: { systemPrompt: 'sys' }, mcpServers: { surfaces: { command: 'node', ...server } } };
}

describe('recipe: mcpServers.*.toolHints', () => {
  test('takes true or false, and leaves it out when unset', () => {
    expect(validateRecipe(recipe({ toolHints: true })).mcpServers!.surfaces.toolHints).toBe(true);
    expect(validateRecipe(recipe({ toolHints: false })).mcpServers!.surfaces.toolHints).toBe(false);
    expect('toolHints' in validateRecipe(recipe({})).mcpServers!.surfaces).toBe(false);
  });

  test('refuses anything else, naming the server', () => {
    for (const toolHints of ['true', 1, null, {}, []]) {
      expect(() => validateRecipe(recipe({ toolHints }))).toThrow('mcpServers.surfaces.toolHints must be true or false');
    }
  });
});

describe('mcpl-servers.json: toolHints', () => {
  test('is carried for the server that sets it, and absent for one that does not', () => {
    const loaded = loadMcplServers(serversFile({ surfaces: { command: 'node', toolHints: true }, other: { command: 'node' } }));
    expect(loaded.find((s) => s.id === 'surfaces')!.toolHints).toBe(true);
    expect('toolHints' in loaded.find((s) => s.id === 'other')!).toBe(false);
  });

  test('refuses a value that is not true or false, naming the file and the server', () => {
    expect(() => loadMcplServers(serversFile({ surfaces: { command: 'node', toolHints: 'yes' } })))
      .toThrow('mcpl-servers.json: mcplServers.surfaces.toolHints must be true or false');
  });
});

describe('what the host hands agent-framework', () => {
  test('a recipe naming a file server may override toolHints; omitting it keeps the file\'s', () => {
    expect(RECIPE_OVERRIDABLE_SERVER_FIELDS).toContain('toolHints');
    const loaded = loadMcplServers(serversFile({ on: { command: 'node', toolHints: true }, kept: { command: 'node', toolHints: true } }));
    const merged = mergeRecipeServers({ on: { toolHints: false }, kept: {} }, loaded as never);
    expect(merged.find((s) => s.id === 'on')!.toolHints).toBe(false);
    expect(merged.find((s) => s.id === 'kept')!.toolHints).toBe(true);
  });

  test('a server the recipe defines itself keeps it as written, through the agent overlay\'s pass', () => {
    const merged = mergeRecipeServers({ surfaces: { url: 'ws://127.0.0.1:1/mcpl', toolHints: true } }, []);
    const final = applyAgentOverlay(merged, join(tmpdir(), 'no-such-dir', 'mcpl-servers.agent.json'));
    expect(final).toEqual([{ id: 'surfaces', url: 'ws://127.0.0.1:1/mcpl', toolHints: true }]);
  });
});
