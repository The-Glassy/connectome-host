/**
 * Masking credentials in text the host writes about a connection: the
 * mcpl-stderr logs, stderr and the log files the TUI and headless modes send
 * it to, and the status lines that name a server's url. A WebSocket MCPL
 * server's url can carry a credential of its own (a `token` or `key` query
 * value, a user and password), and agent-framework's dial errors, which name
 * the url they dialed, keep it; a reconnect loop then writes it into every
 * failure line.
 */

import { format, inspect } from 'node:util';

const MASK = '***';

/** A query value, everything up to the next parameter, fragment, space or
 *  quote, masked. A `)` it ends with stays out of the mask when the value
 *  holds more `)` than `(`, since that one closes prose around the url; any
 *  other parenthesis is part of the value. */
function maskQueryValue(_match: string, name: string, value: string): string {
  let closing = '';
  while (value.endsWith(')') && value.split('(').length < value.split(')').length) {
    value = value.slice(0, -1);
    closing = `)${closing}`;
  }
  return `${name}${MASK}${closing}`;
}

/**
 * `text` with every credential it recognizes replaced by `***`: the value of
 * a `token`, `access_token` or `key` query parameter, an `Authorization`
 * header's whole value, a bare `Bearer` credential, and the user and
 * password of a url. Recognized by shape, so a credential spelled any other
 * way passes; the masks are for text the host writes about a connection
 * (urls, errors, headers), not a scrubber for arbitrary output.
 */
export function redactCredentials(text: string): string {
  return text
    // A query parameter: after `?` or `&`, so `monkey=` is left alone.
    .replace(/([?&](?:token|access_token|key)=)([^&#\s"'<>]*)/gi, maskQueryValue)
    // A header's whole value, its scheme and parameters included: to its
    // closing quote when it's quoted (JSON, an inspected object), which
    // stays, else to the end of the line.
    .replace(/(\bauthorization["']?\s*[:=]\s*)(?:"(?:[^"\\\r\n]|\\.)*"|'(?:[^'\\\r\n]|\\.)*'|[^\r\n]*)/gi,
      (match: string, name: string) => {
        const quote = match[name.length];
        return quote === '"' || quote === "'" ? `${name}${quote}${MASK}${quote}` : `${name}${MASK}`;
      })
    // A bearer credential on its own, with the scheme as it is sent.
    .replace(/\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g, `$1${MASK}`)
    // A url's user and password, through the authority's last `@`.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'<>]*@/gi, `$1${MASK}@`);
}

/** A stream's write, in the overloads process.stderr.write takes. */
export type StreamWrite = (
  chunk: string | Uint8Array,
  encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
) => boolean;

/** How long a line with no newline yet waits for the rest of it. */
const PARTIAL_LINE_WAIT_MS = 25;
/** A partial line longer than this is masked and written as it stands. */
const PARTIAL_LINE_MAX = 64 * 1024;

/**
 * `write`, masking credentials (redactCredentials) a line at a time, so one
 * split across two writes is masked whole. A line with no newline yet is
 * held for the write that ends it, for at most PARTIAL_LINE_WAIT_MS or
 * PARTIAL_LINE_MAX characters, and written at exit; a credential whose
 * halves are written further apart than that isn't joined. Bytes are
 * decoded as UTF-8 across writes. A string in another encoding (`hex`,
 * `base64`) is no text to mask: it is written as it came, after the held
 * line.
 */
export function redactingWrite(write: StreamWrite): StreamWrite {
  const decoder = new TextDecoder();
  let held = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!held) return;
    const line = held;
    held = '';
    write(redactCredentials(line));
  };
  process.once('exit', flush);
  return (chunk, encodingOrCb, cb) => {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    if (typeof chunk === 'string' && encoding && !/^utf-?8$/i.test(encoding)) {
      flush();
      return write(chunk, encoding, callback);
    }
    if (timer) { clearTimeout(timer); timer = null; }
    const text = held + (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    let end = text.lastIndexOf('\n') + 1;
    if (text.length - end > PARTIAL_LINE_MAX) end = text.length;
    held = text.slice(end);
    if (held) {
      timer = setTimeout(flush, PARTIAL_LINE_WAIT_MS);
      timer.unref?.();
    }
    if (end === 0) {
      if (callback) queueMicrotask(() => callback());
      return true;
    }
    return write(redactCredentials(text.slice(0, end)), callback);
  };
}

/** The console methods agent-framework reports connections with. */
const CONSOLE_METHODS = ['error', 'warn'] as const;
const MASKING = Symbol('masking');

/** A console call's arguments as the one line it prints: a format string
 *  substituted, and any other value inspected as Bun prints it (util.format
 *  inspects a Headers object as `Headers {}`; Bun prints its entries). */
function consoleLine(args: unknown[]): string {
  if (typeof args[0] === 'string' && /%[sdifjoOc%]/.test(args[0])) return format(...args);
  const show = (globalThis as { Bun?: { inspect(value: unknown): string } }).Bun?.inspect ?? inspect;
  return args.map((arg) => (typeof arg === 'string' ? arg : show(arg))).join(' ');
}

/**
 * Mask credentials in `console.error` and `console.warn` of the current
 * console object, which Bun writes to descriptor 2 directly, past
 * `process.stderr.write`: agent-framework reports a failed connect or
 * reconnect with `console.error`, naming the url it dialed. Each call is
 * passed on as one line, formatted (consoleLine) and masked. A method
 * assigned later, as OpenTUI's console overlay assigns its own, stays behind
 * the mask; a console object put in place of this one doesn't, so call this
 * again after one is (it's a no-op on a console already masked).
 */
export function redactConsole(): void {
  const target = console as unknown as Record<string, unknown>;
  for (const method of CONSOLE_METHODS) {
    const getter = Object.getOwnPropertyDescriptor(target, method)?.get as { [MASKING]?: true } | undefined;
    if (getter?.[MASKING]) continue;
    let inner = target[method] as (...args: unknown[]) => void;
    const masked = (...args: unknown[]): void => { inner.call(target, redactCredentials(consoleLine(args))); };
    Object.defineProperty(target, method, {
      configurable: true,
      enumerable: true,
      get: Object.assign(() => masked, { [MASKING]: true as const }),
      set: (next: (...args: unknown[]) => void) => { inner = next; },
    });
  }
}

/**
 * Mask credentials in what this process writes to stderr from now on: every
 * `process.stderr.write`, a line at a time (redactingWrite), and
 * `console.error` / `console.warn` (redactConsole). The TUI and headless
 * modes then send `process.stderr.write` to their own log files through a
 * redactingWrite of their own (they replace this write, not wrap it).
 */
export function redactStderr(): void {
  process.stderr.write = redactingWrite(process.stderr.write.bind(process.stderr) as StreamWrite) as typeof process.stderr.write;
  redactConsole();
}

/** What a status line names a live server by: its command, else its url
 *  with any credential in it masked. */
export function serverTarget(server: { command?: string; url?: string }): string | undefined {
  return server.command ?? (server.url ? redactCredentials(server.url) : undefined);
}
