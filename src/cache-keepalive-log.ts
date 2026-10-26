// Every keepalive event goes to STDERR. The host's systemd unit routes
// `StandardError` to `<data>/service-stderr.log` and leaves stdout on the
// journal, and that file is where an operator looks.

import type { KeepaliveEvent } from '@animalabs/membrane';

export const KEEPALIVE_LOG_PREFIX = '[cache-keepalive]';

/** Render one event as a single log line. */
export function formatKeepaliveEvent(event: KeepaliveEvent): string {
  return `${KEEPALIVE_LOG_PREFIX} ${JSON.stringify(event)}`;
}

/**
 * Write one keepalive event to the operator-visible log.
 *
 * `sink` exists for tests; production always uses stderr via the default.
 */
export function logKeepaliveEvent(
  event: KeepaliveEvent,
  sink: (line: string) => void = (line) => console.error(line),
): void {
  sink(formatKeepaliveEvent(event));
}
