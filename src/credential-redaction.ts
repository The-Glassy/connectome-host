/**
 * Masking credentials in text the host writes about a connection: the
 * mcpl-stderr logs, stderr and the log files the TUI and headless modes send
 * it to, and the status lines that name a server's url. A WebSocket MCPL
 * server's url can carry a credential of its own (a `token` or `key` query
 * value, a user and password), and agent-framework's dial errors, which name
 * the url they dialed, keep it; a reconnect loop then writes it into every
 * failure line.
 */

import { format } from 'node:util';

const MASK = '***';

/**
 * `text` with every credential it recognizes replaced by `***`: the value of
 * a `token`, `access_token` or `key` query parameter, an `Authorization`
 * header's value (scheme included), a bare `Bearer` credential, and the user
 * and password of a url. Recognized by shape, so a credential spelled any
 * other way passes; the masks are for text the host writes about a
 * connection (urls, errors, headers), not a scrubber for arbitrary output.
 */
export function redactCredentials(text: string): string {
  return text
    // A query parameter: after `?` or `&`, so `monkey=` is left alone. The
    // value ends where a url does in prose, JSON, or a parenthesis.
    .replace(/([?&](?:token|access_token|key)=)[^&#\s"'<>()]*/gi, `$1${MASK}`)
    // A header, as written in a log line or as JSON.
    .replace(/(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;)}]+/gi, `$1${MASK}`)
    // A bearer credential on its own, with the scheme as it is sent.
    .replace(/\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g, `$1${MASK}`)
    // A url's user and password.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi, `$1${MASK}@`);
}

/** redactCredentials for a chunk written to a stream: text comes back as
 *  text, bytes as bytes, and a chunk with nothing to mask as itself. */
export function redactChunk(chunk: string | Uint8Array): string | Uint8Array {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  const redacted = redactCredentials(text);
  if (redacted === text) return chunk;
  return typeof chunk === 'string' ? redacted : Buffer.from(redacted, 'utf8');
}

/**
 * Mask credentials in what this process writes to stderr from now on: every
 * `process.stderr.write`, and `console.error` / `console.warn`, which Bun
 * writes to descriptor 2 directly, past `process.stderr.write`.
 * agent-framework reports a failed connect or reconnect with
 * `console.error`, naming the url it dialed. A console line with nothing to
 * mask is passed on as it came; one with a credential is formatted, masked
 * and passed on as one string. The TUI and headless modes then send
 * `process.stderr.write` to their own log files, which mask it again (they
 * replace this write, not wrap it).
 */
export function redactStderr(): void {
  const write = process.stderr.write.bind(process.stderr) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    write(redactChunk(chunk), ...rest)) as typeof process.stderr.write;
  for (const method of ['error', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const text = format(...args);
      const redacted = redactCredentials(text);
      if (redacted === text) original(...args);
      else original(redacted);
    };
  }
}

/** What a status line names a live server by: its command, else its url
 *  with any credential in it masked. */
export function serverTarget(server: { command?: string; url?: string }): string | undefined {
  return server.command ?? (server.url ? redactCredentials(server.url) : undefined);
}
