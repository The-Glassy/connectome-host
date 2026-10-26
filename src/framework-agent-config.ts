import { AgentFramework } from '@animalabs/agent-framework';
import type { Recipe } from './recipe.js';
import { DEFAULT_RECIPE_CLOCK } from './recipe.js';

type AgentConfig = Parameters<typeof AgentFramework.create>[0]['agents'][number];

/** Compile budget for a recipe that omits `agent.contextBudgetTokens`. Sized
 *  for the 1M-window models; a recipe on a smaller window must set its own
 *  (budget + maxTokens has to fit under the window). */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 300_000;
const STREAM_HEADROOM_TOKENS = 20_000;
const FRAMEWORK_DEFAULT_MAX_STREAM_TOKENS = 150_000;

/** The model a recipe's agent runs: `envModel`, the environment's `MODEL`,
 *  when it's set, else the recipe's own, else its provider's default. */
export function recipeModel(recipe: Recipe, envModel: string | undefined): string {
  return envModel || recipe.agent.model ||
    (recipe.agent.provider === 'openai-codex' ? 'gpt-5.4' : 'claude-opus-4-6');
}

/** The compile budget the recipe configures: its own, else the default. A
 *  runtime override (agent settings) can still move the live budget. */
export function effectiveContextBudgetTokens(recipe: Recipe): number {
  return recipe.agent.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
}

/**
 * An agent-framework that predates `agent.autoContinue` (agent-framework#744)
 * passes the key through and builds the agent without it, so turns end as
 * before with no other sign. One that supports it gives the built agent
 * (framework.getAgent) `autoContinue`, resolved.
 */
export function autoContinueSupportWarning(recipe: Recipe, agent: object | undefined): string | undefined {
  if (!recipe.agent.autoContinue || !agent) return undefined;
  if ((agent as { autoContinue?: unknown }).autoContinue !== undefined) return undefined;
  return '[agent-settings] agent.autoContinue is set, but the installed agent-framework predates it ' +
    '(agent-framework#744): turns end as before, without continuing, until it is upgraded.';
}

export type FrameworkAgentConfig = AgentConfig & {
  // Forward recipe fields that newer Agent Framework releases understand
  // while remaining structurally compatible with older installs.
  refusalHandling?: Recipe['agent']['refusalHandling'];
  sameRoundThinkTextPolicy?: 'public' | 'private';
  autoContinue?: Recipe['agent']['autoContinue'];
};

/**
 * Prompt caching went GA on Bedrock in April 2025 for 3.5 Haiku, 3.7 Sonnet,
 * and Claude 4+, but not for 3.5 Sonnet (either version): 1022 ("3.6") was
 * in the Dec 2024 preview and was dropped at GA, and Bedrock refuses it with
 * an account-level "your request did not allow prompt caching".
 */
export function bedrockModelSupportsPromptCaching(model: string): boolean {
  const id = model.toLowerCase();
  if (!id.includes('claude')) return false;
  // (?![a-z0-9]) = family boundary: end of id, or a separator (-, ., :)
  // before a date/qualifier — matches the whole family, not one spelling.
  return !/claude-(v2|instant|3-(opus|sonnet|haiku)|3-5-sonnet)(?![a-z0-9])/.test(id);
}

export function resolvePromptCaching(recipe: Recipe, model: string): boolean | undefined {
  if (recipe.agent.promptCaching !== undefined) return recipe.agent.promptCaching;
  if (recipe.agent.provider === 'bedrock') return bedrockModelSupportsPromptCaching(model);
  return undefined; // membrane default (on)
}

/**
 * Callers inside the agent's strategy, such as context-manager's
 * autobiographical compression and merge, send requests that don't set
 * promptCaching, which membrane's defaultPromptCaching then decides, so a
 * recipe's override is set at both layers.
 */
export function membraneCachingOverride(
  recipe: Recipe,
  model: string,
): { defaultPromptCaching?: boolean } {
  const promptCaching = resolvePromptCaching(recipe, model);
  return promptCaching === undefined ? {} : { defaultPromptCaching: promptCaching };
}

export function buildFrameworkAgentConfig(
  recipe: Recipe,
  agentName: string,
  model: string,
  strategy: FrameworkAgentConfig['strategy'],
): FrameworkAgentConfig {
  const promptCaching = resolvePromptCaching(recipe, model);
  let thinking: FrameworkAgentConfig['thinking'];
  if (recipe.agent.thinking) {
    // Effort is a host setting sent as output_config.effort, never as thinking.effort.
    const { effort: _hostEffort, ...providerThinking } = recipe.agent.thinking;
    thinking = providerThinking;
  }
  return {
    name: agentName,
    ...(recipe.agent.toolPresentation ? {toolPresentation: recipe.agent.toolPresentation} : {}),
    model,
    systemPrompt: recipe.agent.systemPrompt,
    ...(recipe.agent.allowedTools !== undefined
      ? { allowedTools: recipe.agent.allowedTools }
      : {}),
    maxTokens: recipe.agent.maxTokens ?? 16384,
    // An omitted maxStreamTokens follows the budget (+20k) only when the
    // budget is the host default too. A recipe that sets its own budget may be
    // on a 200k-window model, where budget + 20k would let a stream grow past
    // the window; it keeps the framework's historical 150k.
    maxStreamTokens: recipe.agent.maxStreamTokens
      ?? (recipe.agent.contextBudgetTokens === undefined
        ? DEFAULT_CONTEXT_BUDGET_TOKENS + STREAM_HEADROOM_TOKENS
        : FRAMEWORK_DEFAULT_MAX_STREAM_TOKENS),
    contextBudgetTokens: effectiveContextBudgetTokens(recipe),
    // Bedrock offers only the default 5m cache, so cacheTtl isn't forwarded
    // there. agent-framework sends its own default ('1h') when the host omits it.
    ...(recipe.agent.cacheTtl && recipe.agent.provider !== 'bedrock'
      && { cacheTtl: recipe.agent.cacheTtl }),
    ...(promptCaching !== undefined && { promptCaching }),
    // Prefill scaffold (anthropic-xml formatter), e.g. chapterx CLI-sim's
    // '<cmd>cat untitled.txt</cmd>' — part of migrating prefill-era bots.
    ...(recipe.agent.prefillUserMessage && { prefillUserMessage: recipe.agent.prefillUserMessage }),
    ...((recipe.agent.provider === 'openai-responses' || recipe.agent.provider === 'openai-codex') && {
      providerParams: {
        reasoning: {
          effort: recipe.agent.responses?.reasoningEffort ?? 'high',
          context: recipe.agent.responses?.reasoningContext ?? 'all_turns',
        },
        ...(recipe.agent.provider === 'openai-responses' ? {
          ...(recipe.agent.responses?.serviceTier ? {
            service_tier: recipe.agent.responses.serviceTier,
          } : {}),
          ...(recipe.agent.responses?.compactThreshold ? {
            context_management: [{
              type: 'compaction',
              compact_threshold: recipe.agent.responses.compactThreshold,
            }],
          } : {}),
        } : {}),
      },
    }),
    strategy,
    ...(thinking && { thinking }),
    ...(recipe.agent.refusalHandling && { refusalHandling: recipe.agent.refusalHandling }),
    ...(recipe.agent.sameRoundThinkTextPolicy !== undefined
      ? { sameRoundThinkTextPolicy: recipe.agent.sameRoundThinkTextPolicy }
      : {}),
    ...(recipe.agent.proseRouting !== undefined
      ? { proseRouting: recipe.agent.proseRouting }
      : {}),
    ...(recipe.agent.toolWrapperProseGuard !== undefined
      ? { toolWrapperProseGuard: recipe.agent.toolWrapperProseGuard }
      : {}),
    ...(recipe.agent.autoContinue !== undefined
      ? { autoContinue: recipe.agent.autoContinue }
      : {}),
    // Ten-minute clock rows unless the recipe names its own or turns them off (false).
    ...(recipe.agent.clock === false ? {} : { clock: recipe.agent.clock ?? { ...DEFAULT_RECIPE_CLOCK } }),
  };
}
