import { TURN_SETTLED_TRACES, traceError } from './turn-trace.js';

export type FailureStep =
  | { show: 'line'; text: string }
  | { show: 'count'; text: string; count: number }
  | { show: 'ended'; attempts: number; errorType?: string };

export interface TurnFailures {
  onTrace(event: { type: string; agentName?: unknown; error?: unknown; errorType?: unknown }): FailureStep | null;
}

export function createTurnFailures(): TurnFailures {
  const runs = new Map<string, { text: string; count: number; attempts: number }>();
  return {
    onTrace(event) {
      const agent = typeof event.agentName === 'string' ? event.agentName : undefined;
      if (agent === undefined) return null;
      if (event.type === 'inference:failed') {
        const text = traceError(event);
        const run = runs.get(agent);
        if (run && run.text === text) {
          run.count++;
          run.attempts++;
          return { show: 'count', text, count: run.count };
        }
        runs.set(agent, { text, count: 1, attempts: (run?.attempts ?? 0) + 1 });
        return { show: 'line', text };
      }
      if (!TURN_SETTLED_TRACES.has(event.type)) return null;
      const run = runs.get(agent);
      runs.delete(agent);
      if (!run || event.type !== 'inference:exhausted') return null;
      return {
        show: 'ended',
        attempts: run.attempts,
        ...(typeof event.errorType === 'string' ? { errorType: event.errorType } : {}),
      };
    },
  };
}

export function failureCountLine(text: string, count: number): string {
  return count > 1 ? `Error (×${count}): ${text}` : `Error: ${text}`;
}

export function turnEndedLine(attempts: number, hint: string | undefined): string {
  return `Turn ended after ${attempts} attempt${attempts === 1 ? '' : 's'}.${hint ? ` ${hint}` : ''}`;
}
