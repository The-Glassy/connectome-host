/**
 * context-manager keeps render stats only for a strategy that keeps them, and
 * only from a live compile since the agent's context was loaded (the host's
 * start, a session or branch switch); a preview's dry compile leaves them as
 * they were. So where there are none, these say which of the two it is.
 */
import { healthEntry } from '@conhost/web/health-lookup';
import type { ContextComposition, HealthSnapshot } from './Health';

/** What an agent with no composition shows, by whether its strategy keeps
 *  render stats at all. */
export function noComposition(statsKept: boolean): string {
  return statsKept ? 'No live compile since its context was loaded.' : "This agent's strategy keeps no composition.";
}

/** An agent's composition as either view shows it: its stats as a block,
 *  or, where there are none, the line saying why. */
export type CompositionView<S> = { stats: S } | { line: string };

/** The composition's stats where there are any, else the line for an agent
 *  whose strategy keeps them or one whose strategy keeps none. */
export function compositionView<S>(stats: S | null | undefined, statsKept: boolean): CompositionView<S> {
  return stats ? { stats } : { line: noComposition(statsKept) };
}

/** What the Health view shows for an agent's composition, from `/healthz`:
 *  nothing where the `contextComposition` section is absent from the
 *  snapshot; nothing either where the agent's own read of it failed, which
 *  the view's failure line names; else
 *  its entry's stats, or the line, by whether `contextCompositionNotKept`
 *  names the agent. Each map is read by own key (healthEntry). */
export function healthComposition(
  health: Pick<HealthSnapshot, 'contextComposition' | 'contextCompositionNotKept' | 'readFailures'> | null | undefined,
  name: string,
): CompositionView<ContextComposition> | null {
  if (health?.contextComposition == null) return null;
  if (healthEntry(healthEntry(health.readFailures, name), 'contextComposition') !== undefined) return null;
  return compositionView(healthEntry(health.contextComposition, name), !(health.contextCompositionNotKept ?? []).includes(name));
}

/** The fields of `/debug/context/makeup` the Context page chooses by. */
export interface MakeupFigures<S> {
  stats: S | null;
  statsKept?: boolean;
  exactTotalTokens: number | null;
  countModel: string;
  countSource: string;
}

/** What the Context page shows from a makeup response: the next request's
 *  exact count and the model it was counted for, or why it wasn't counted;
 *  and the composition, its stats or the line. A response without
 *  `statsKept` is taken as a strategy that keeps them. */
export function contextPageView<S>(makeup: MakeupFigures<S>): {
  count: { tokens: number; model: string } | { reason: string };
  composition: CompositionView<S>;
} {
  return {
    count: makeup.exactTotalTokens != null
      ? { tokens: makeup.exactTotalTokens, model: makeup.countModel }
      : { reason: notCounted(makeup.countSource) },
    composition: compositionView(makeup.stats, makeup.statsKept !== false),
  };
}

/** As agent-framework reports them, each is kept until the next of its kind,
 *  so a failure stays after later inferences. */
export interface LastInference {
  startedAt?: number;
  endedAt?: number;
  failedAt?: number;
}

/** agent-framework stamps these in milliseconds, so a failure or an end in
 *  the latest start's millisecond can be that inference's or the one before's.
 *  An inference that fails before any request can fail in its own start's
 *  millisecond, so a tie is read as the latest inference's. */
export function lastInferenceState(last: LastInference | null | undefined): { word: 'failed' | 'started' | 'ended'; at: number } | null {
  const { startedAt, endedAt, failedAt } = last ?? {};
  if (failedAt !== undefined && (startedAt === undefined || failedAt >= startedAt)) return { word: 'failed', at: failedAt };
  if (startedAt === undefined) return null;
  if (endedAt === undefined || endedAt < startedAt) return { word: 'started', at: startedAt };
  return { word: 'ended', at: endedAt };
}

/** The Health view's last-inference line, with `ago` saying how long ago a
 *  time was, or null where the framework reports none. */
export function lastInferenceLine(last: LastInference | null | undefined, ago: (at: number) => string): string | null {
  const state = lastInferenceState(last);
  return state ? `last inference: ${state.word} ${ago(state.at)}` : null;
}

/** agent-framework sets `lastError` with `failedAt` and keeps both until the
 *  next failure, so after a later success it would be an old error. */
export function latestInferenceError(last: (LastInference & { lastError?: string }) | null | undefined): string | undefined {
  return lastInferenceState(last)?.word === 'failed' && last?.lastError ? last.lastError : undefined;
}

/** Why the Context page has no exact count of the next request, from the
 *  makeup endpoint's `countSource`. */
export function notCounted(countSource: string): string {
  if (countSource === 'count_tokens_unsupported_model') return "not counted: count_tokens doesn't take this agent's model";
  const failed = /^count_tokens_failed_(\d+)$/.exec(countSource);
  if (failed) return `not counted: count_tokens answered ${failed[1]}`;
  if (countSource === 'count_tokens_error') return 'not counted: the count_tokens call failed';
  if (countSource === 'count_tokens') return 'not counted: count_tokens answered with no count';
  return `not counted (${countSource})`;
}
