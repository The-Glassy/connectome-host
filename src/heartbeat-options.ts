/**
 * agent-framework's heartbeat options (`FrameworkConfig.heartbeat`) for a
 * recipe's `modules.heartbeat`: off unless the recipe turns it on. Paths the
 * recipe gives are read relative to the install directory, as the host reads
 * its other files, so agent-framework gets absolute ones. validateRecipe has
 * checked the rest, which is passed on as written.
 */
import { resolve } from 'node:path';
import type { RecipeModules } from './recipe.js';

/** The value for FrameworkConfig.heartbeat, or undefined when the recipe leaves the heartbeat off. */
export function heartbeatOptionsFor(heartbeat: RecipeModules['heartbeat']): Record<string, unknown> | undefined {
  if (heartbeat === undefined || heartbeat === false) return undefined;
  if (heartbeat === true) return {};
  const from = heartbeat.importFrom;
  return {
    ...(heartbeat.statePath !== undefined ? { statePath: resolve(heartbeat.statePath) } : {}),
    ...(heartbeat.defaults !== undefined ? { defaults: { ...heartbeat.defaults } } : {}),
    ...(from !== undefined ? {
      importFrom: {
        ...(from.configPath !== undefined ? { configPath: resolve(from.configPath) } : {}),
        ...(from.remindersPath !== undefined ? { remindersPath: resolve(from.remindersPath) } : {}),
      },
    } : {}),
  };
}
