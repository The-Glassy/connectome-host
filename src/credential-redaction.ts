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
 *  double quote, masked. What ends it and closes text around the url stays
 *  out of the mask: a `)` while the value holds more `)` than `(`, and a
 *  `'` that is the value's only one. Any other parenthesis or apostrophe is
 *  part of the value. Counted once, so a long value costs linear time. */
function maskQueryValue(_match: string, name: string, value: string): string {
  let opens = 0;
  let closes = 0;
  let quotes = 0;
  for (const c of value) {
    if (c === '(') opens++;
    else if (c === ')') closes++;
    else if (c === "'") quotes++;
  }
  let end = value.length;
  for (;;) {
    if (value[end - 1] === ')' && closes > opens) { end--; closes--; }
    else if (value[end - 1] === "'" && quotes === 1) { end--; quotes--; }
    else break;
  }
  return `${name}${MASK}${value.slice(end)}`;
}

export function redactCredentials(text: string): string {
  return text
    // A query parameter: after `?` or `&`, so `monkey=` is left alone.
    .replace(/([?&](?:token|access_token|key)=)([^&#\s"<>]*)/gi, maskQueryValue)
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
    // A url's user and password, through the authority's last `@`; an
    // apostrophe can be part of them.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"<>]*@/gi, `$1${MASK}@`);
}

/** A stream's write, in the overloads process.stderr.write takes. */
export type StreamWrite = (
  chunk: string | Uint8Array,
  encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
) => boolean;

/** A partial line this long is masked and written as it stands. */
const PARTIAL_LINE_MAX = 1024 * 1024;

/**
 * Where a credential the masked text runs into the end of goes on in the
 * next write, as the pattern that ends it there; null when none does. An
 * Authorization header's value runs to the end of the line; a query value
 * or a bearer credential to a space, quote or the next parameter; an
 * authority that may still turn out to hold a user and password to the
 * path, query or fragment.
 */
function openCredentialEnd(text: string): RegExp | null {
  // Only the line the cut falls in: a header an earlier line closed is done.
  text = text.slice(text.lastIndexOf('\n') + 1);
  // A header value still open at the cut: unquoted (to the end of the
  // line), or quoted without its closing quote yet.
  if (/\bauthorization["']?\s*[:=]\s*(?:[^"'\s][^\r\n]*)?$/i.test(text)) return /\n/;
  if (/\bauthorization["']?\s*[:=]\s*(?:"(?:[^"\\\r\n]|\\.)*|'(?:[^'\\\r\n]|\\.)*)$/i.test(text)) return /["'\n]/;
  if (/(?:[?&](?:token|access_token|key)=[^&#\s"<>]*|\bBearer\s+[A-Za-z0-9\-._~+/]*=*)$/i.test(text)) return /[&#\s"<>]/;
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#"<>]*$/i.test(text)) return /[/?#\s"<>]/;
  return null;
}

/** A redacting write, and how to write out the line it holds. */
export type RedactingWrite = StreamWrite & { flush(): void };

/**
 * `write`, masking credentials (redactCredentials) a line at a time, so one
 * split across writes is masked whole. A line with no newline yet is held
 * until the write that ends it, or until `flush()`, which an owner calls
 * before it closes the destination and at exit. A write's callback is
 * called once its text has gone to `write`. A line that outgrows
 * PARTIAL_LINE_MAX is written as it stands; a credential it cuts off is
 * masked on into the next write too (openCredentialEnd). Bytes are decoded
 * as UTF-8 across writes. A string in another encoding (`hex`, `base64`) is
 * no text to mask: it is written as it came, after the held line.
 */
export function redactingWrite(write: StreamWrite): RedactingWrite {
  const decoder = new TextDecoder();
  let held = '';
  let carry: RegExp | null = null;
  let waiting: Array<(err?: Error | null) => void> = [];
  // The callbacks of the writes whose text goes out now, as one.
  const settle = (callback?: (err?: Error | null) => void): ((err?: Error | null) => void) | undefined => {
    const all = callback ? [...waiting, callback] : waiting;
    waiting = [];
    return all.length > 0 ? (err) => { for (const done of all) done(err); } : undefined;
  };
  const flush = (): void => {
    const line = held;
    held = '';
    const done = settle();
    if (line) write(redactCredentials(line), done);
    else done?.();
  };
  const redactingWriter = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
    if (typeof chunk === 'string' && encoding && !/^utf-?8$/i.test(encoding)) {
      flush();
      return write(chunk, encoding, callback);
    }
    let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    if (carry) {
      // The rest of a credential the last write cut off: masked (dropped,
      // its mask is written) up to where it ends. A write that is all of
      // it is done: its mask went out with the write before.
      const at = text.search(carry);
      if (at < 0) {
        if (callback) queueMicrotask(() => callback());
        return true;
      }
      text = text.slice(at);
      carry = null;
    }
    text = held + text;
    let end = text.lastIndexOf('\n') + 1;
    let cut = false;
    if (text.length - end > PARTIAL_LINE_MAX) { end = text.length; cut = true; }
    held = text.slice(end);
    if (end === 0) {
      if (callback) waiting.push(callback);
      return true;
    }
    let out = redactCredentials(text.slice(0, end));
    if (cut) {
      carry = openCredentialEnd(text);
      if (carry && carry.source.startsWith('[/?#')) out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#"<>]*$/i, `$1${MASK}`);
    }
    return write(out, settle(callback));
  };
  return Object.assign(redactingWriter, { flush });
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
    // Each wrapper calls the method it was made for, so code that keeps the
    // masked method and assigns one calling it gets a chain, not a loop.
    const mask = (inner: (...args: unknown[]) => void) => (...args: unknown[]): void => {
      inner.call(target, redactCredentials(consoleLine(args)));
    };
    let masked = mask(target[method] as (...args: unknown[]) => void);
    Object.defineProperty(target, method, {
      configurable: true,
      enumerable: true,
      get: Object.assign(() => masked, { [MASKING]: true as const }),
      set: (next: (...args: unknown[]) => void) => { masked = mask(next); },
    });
  }
}

/**
 * Mask credentials in what this process writes to stderr from now on: every
 * `process.stderr.write`, a line at a time (redactingWrite, its held line
 * written at exit), and
 * `console.error` / `console.warn` (redactConsole). The TUI and headless
 * modes then send `process.stderr.write` to their own log files through a
 * redactingWrite of their own (they replace this write, not wrap it).
 */
export function redactStderr(): void {
  const write = redactingWrite(process.stderr.write.bind(process.stderr) as StreamWrite);
  process.once('exit', write.flush);
  process.stderr.write = write as typeof process.stderr.write;
  redactConsole();
}

/** What a status line names a live server by: its command, else its url
 *  with any credential in it masked. */
export function serverTarget(server: { command?: string; url?: string }): string | undefined {
  return server.command ?? (server.url ? redactCredentials(server.url) : undefined);
}
