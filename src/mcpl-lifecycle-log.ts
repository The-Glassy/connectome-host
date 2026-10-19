/**
 * Lines for a server's mcpl-stderr log (`<storePath>/mcpl-stderr/<id>.log`),
 * from the framework's mcpl:server-* traces.
 */

import { redactCredentials } from './credential-redaction.js';

/** Render an mcpl:server-* connection-lifecycle trace as a log line, or null
 *  for trace types this sink doesn't record. Lifecycle lines are prefixed
 *  `[host]` to stand apart from the server's own stderr output. A
 *  credential in the line (a dial error names the url it dialed, query
 *  included) is masked (redactCredentials). */
export function formatMcplLifecycleLine(event: { type: string } & Record<string, unknown>): string | null {
  const line = lifecycleLine(event);
  return line === null ? null : redactCredentials(line);
}

function lifecycleLine(event: { type: string } & Record<string, unknown>): string | null {
  switch (event.type) {
    case 'mcpl:server-stderr':
      return String(event.line);
    case 'mcpl:server-connect-failed':
      return `[host] connect failed (attempt ${event.attempt}, ${event.willRetry ? 'will retry' : 'NO RETRY — server unavailable until restart'}): ${event.error}`;
    case 'mcpl:server-reconnected':
      return `[host] reconnected after ${event.attempts} attempt(s)`;
    case 'mcpl:server-closed':
      return `[host] connection closed (code=${event.code}, signal=${event.signal}${event.willReconnect ? ', reconnect scheduled' : ''})`;
    case 'mcpl:server-error':
      return `[host] connection error: ${event.error}`;
    default:
      return null;
  }
}
