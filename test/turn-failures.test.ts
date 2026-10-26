import { describe, expect, test } from 'bun:test';
import { createPipedTurns } from '../src/piped-turns.js';
import { createTurnFailures, failureCountLine, turnEndedLine } from '../src/state/turn-failures.js';
import { failureHint } from '../src/failure-hint.js';
import type { Recipe } from '../src/recipe.js';

const recipe = (agent: Record<string, unknown> = {}) => ({ name: 'r', agent: { name: 'clerk', ...agent } }) as unknown as Recipe;

function batch(hint: (errorType: string | undefined) => string | undefined = () => undefined) {
  const err: string[] = [];
  const turns = createPipedTurns('clerk', { write: () => {}, log: () => {}, error: (line) => { err.push(line); } }, hint);
  const emit = (type: string, extra: Record<string, unknown> = {}, agentName = 'clerk') => turns.onTrace({ type, agentName, ...extra });
  const attempt = (error: string, agentName = 'clerk') => {
    emit('inference:started', {}, agentName);
    emit('inference:failed', { error }, agentName);
  };
  return { err, emit, attempt };
}

describe('a batch run\'s failed turn', () => {
  test('prints each failure once, and when the turn gives up, how many attempts it made and what to check', () => {
    const { err, emit, attempt } = batch((type) => (type === 'network' ? 'Check the network.' : undefined));
    attempt('Connection error.');
    attempt('Connection error.');
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'network' });
    expect(err).toEqual(['Error: Connection error.', 'Turn ended after 3 attempts. Check the network.']);
  });

  test('prints a failure with other words on a line of its own', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    attempt('overloaded');
    attempt('overloaded');
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'server' });
    expect(err).toEqual(['Error: Connection error.', 'Error: overloaded', 'Error: Connection error.', 'Turn ended after 4 attempts.']);
  });

  test('a retry that answers ends the turn with no count, and the next turn counts from one', () => {
    const { err, emit, attempt } = batch();
    attempt('Connection error.');
    emit('inference:started');
    emit('inference:completed');
    attempt('Connection error.');
    emit('inference:exhausted', { error: 'Connection error.' });
    expect(err).toEqual(['Error: Connection error.', 'Error: Connection error.', 'Turn ended after 1 attempt.']);
  });

  test('another agent\'s failures print once, and its giving up isn\'t the line\'s turn ending', () => {
    const { err, emit, attempt } = batch(() => 'Check the network.');
    attempt('Connection error.', 'spawn-a');
    attempt('Connection error.', 'spawn-a');
    emit('inference:exhausted', { error: 'Connection error.', errorType: 'network' }, 'spawn-a');
    expect(err).toEqual(['Error: Connection error.']);
  });
});

describe('the TUI\'s failure line', () => {
  test('a turn\'s repeated failure is one line, its count updated', () => {
    const failures = createTurnFailures();
    const steps = ['Connection error.', 'Connection error.', 'Connection error.']
      .map((error) => failures.onTrace({ type: 'inference:failed', agentName: 'clerk', error }));
    expect(steps).toEqual([
      { show: 'line', text: 'Connection error.' },
      { show: 'count', text: 'Connection error.', count: 2 },
      { show: 'count', text: 'Connection error.', count: 3 },
    ]);
    expect(failureCountLine('Connection error.', 1)).toBe('Error: Connection error.');
    expect(failureCountLine('Connection error.', 3)).toBe('Error (×3): Connection error.');
    expect(failures.onTrace({ type: 'inference:exhausted', agentName: 'clerk', errorType: 'network' }))
      .toEqual({ show: 'ended', attempts: 3, errorType: 'network' });
  });

  test('a turn stopped after a failure, or a lone end, says nothing of attempts', () => {
    const failures = createTurnFailures();
    failures.onTrace({ type: 'inference:failed', agentName: 'clerk', error: 'x' });
    expect(failures.onTrace({ type: 'inference:aborted', agentName: 'clerk' })).toBeNull();
    expect(failures.onTrace({ type: 'inference:exhausted', agentName: 'clerk', error: 'Stream aborted' })).toBeNull();
  });

  test('the give-up line counts one attempt as one', () => {
    expect(turnEndedLine(1, undefined)).toBe('Turn ended after 1 attempt.');
    expect(turnEndedLine(2, 'Check ANTHROPIC_API_KEY.')).toBe('Turn ended after 2 attempts. Check ANTHROPIC_API_KEY.');
  });
});

describe('what to check names where this host sends its calls', () => {
  test('a network or timeout failure names the provider\'s base URL setting, not set', () => {
    const hint = failureHint(recipe(), {});
    expect(hint('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (not set, so the default).');
    expect(hint('timeout')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (not set, so the default).');
  });

  test('a setting that is set is named by its host only', () => {
    const env = { ANTHROPIC_BASE_URL: 'https://key:secret@gate.example.com:8443/anthropic?token=t' };
    expect(failureHint(recipe(), env)('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (set to gate.example.com:8443).');
    expect(failureHint(recipe(), { ANTHROPIC_BASE_URL: 'gate' })('network')).toBe('Check the network, any proxy, and ANTHROPIC_BASE_URL (set, but not to a URL).');
  });

  test('each provider\'s own setting', () => {
    const net = (agent: Record<string, unknown>, env: Record<string, string> = {}) => failureHint(recipe(agent), env)('network');
    expect(net({ provider: 'openai-responses' })).toBe('Check the network, any proxy, and OPENAI_BASE_URL (not set, so the default).');
    expect(net({ provider: 'bedrock' }, { BEDROCK_BASE_URL: 'https://gate.example.com/bedrock/x' })).toBe('Check the network, any proxy, and BEDROCK_BASE_URL (set to gate.example.com).');
    expect(net({ provider: 'openai-codex' })).toBe('Check the network, any proxy, and CODEX_BASE_URL (not set, so the default).');
    expect(net({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe("Check the network, any proxy, and the recipe's agent.baseUrl (set to localhost:11434).");
    expect(net({ provider: 'openrouter' })).toBe('Check the network and any proxy.');
    expect(net({ provider: 'mock' })).toBeUndefined();
  });

  test('an auth failure names the credential the host used', () => {
    const auth = (agent: Record<string, unknown>, env: Record<string, string> = {}) => failureHint(recipe(agent), env)('auth');
    expect(auth({})).toBe('Check ANTHROPIC_API_KEY.');
    expect(auth({}, { ANTHROPIC_AUTH_TOKEN: 't' })).toBe('Check ANTHROPIC_AUTH_TOKEN.');
    expect(auth({}, { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_OAUTH_CREDENTIALS_FILE: '/c.json' })).toBe('Check ANTHROPIC_OAUTH_CREDENTIALS_FILE.');
    expect(auth({ provider: 'openai-responses' })).toBe('Check OPENAI_API_KEY.');
    expect(auth({ provider: 'openrouter' })).toBe('Check OPENROUTER_API_KEY.');
    expect(auth({ provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' })).toBe('Check OPENAI_COMPATIBLE_API_KEY.');
    expect(auth({ provider: 'bedrock' })).toBe('Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    expect(auth({ provider: 'openai-codex' })).toBe('Check the ChatGPT login.');
    expect(auth({ provider: 'openai-codex' }, { CODEX_GATE_TOKEN: 'g' })).toBe('Check CODEX_GATE_TOKEN.');
  });

  test('any other kind gets nothing to check', () => {
    const hint = failureHint(recipe(), {});
    for (const kind of ['rate_limit', 'server', 'invalid_request', 'context_length', 'safety', 'unsupported', 'unknown', undefined]) {
      expect(hint(kind)).toBeUndefined();
    }
  });
});
