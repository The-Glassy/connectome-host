import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';
import { sessionMarker } from './session-marker.js';

export const READLINE_LOG = 'readline-error.log';
const LOG_CLOSE_LIMIT_MS = 2_000;

export interface ReadlineTerminal {
  logPath: string;
  say(line: string): void;
  end(): Promise<void>;
}

type StdWrite = typeof process.stdout.write;

export interface ShownPrompt {
  showing(): boolean;
  redraw(): void;
}

export function openReadlineTerminal(dataDir: string, prompt: ShownPrompt): ReadlineTerminal {
  const logPath = join(dataDir, READLINE_LOG);
  const log = createWriteStream(logPath, { flags: 'a' });
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
  let atLineStart = true;
  let logFailed = false;
  let ended = false;

  const toTerminal = (text: string): void => { stderrWrite.call(process.stderr, text); };
  const toLog = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    if (logFailed) return (stderrWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, encodingOrCb, cb);
    return typeof encodingOrCb === 'function'
      ? log.write(chunk, encodingOrCb)
      : log.write(chunk, encodingOrCb as BufferEncoding, cb);
  };

  function say(line: string): void {
    const atPrompt = !ended && prompt.showing();
    if (atPrompt && process.stdout.isTTY) stdoutWrite.call(process.stdout, '\r\x1b[K');
    else if (!ended && !atLineStart) stdoutWrite.call(process.stdout, '\n');
    toTerminal(`${line}\n`);
    atLineStart = true;
    if (atPrompt) prompt.redraw();
  }

  log.on('error', (error) => {
    if (logFailed) return;
    logFailed = true;
    say(`[host] ${logPath} can't be written (${error.message}), so the host's diagnostics print here instead`);
  });
  log.write(`\n${sessionMarker(new Date())}\n`);

  process.stdout.write = function (this: unknown, chunk: string | Uint8Array, ...rest: unknown[]): boolean {
    if (chunk.length > 0) {
      atLineStart = typeof chunk === 'string' ? chunk.endsWith('\n') : chunk[chunk.length - 1] === 0x0a;
    }
    return (stdoutWrite as (...args: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  } as StdWrite;
  process.stderr.write = function (
    this: unknown,
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    return toLog(chunk, encodingOrCb, cb);
  } as StdWrite;
  // Bun's console writes to descriptors 1 and 2 itself, not through the
  // methods above: its stderr lines are sent to the log here, and its stdout
  // lines, which always end their line, are noted as having done so.
  console.error = (...args: unknown[]) => { toLog(`${format(...args)}\n`); };
  console.warn = (...args: unknown[]) => { toLog(`${format(...args)}\n`); };
  for (const method of ['log', 'info', 'debug'] as const) {
    const print = saved[method];
    console[method] = (...args: unknown[]) => { print(...args); atLineStart = true; };
  }

  async function end(): Promise<void> {
    if (ended) return;
    ended = true;
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    Object.assign(console, saved);
    if (logFailed) return;
    await new Promise<void>((done) => {
      const limit = setTimeout(() => {
        console.error(`[host] ${READLINE_LOG} hadn't taken its last lines after ${LOG_CLOSE_LIMIT_MS / 1000} s, so readline mode ends without them`);
        done();
      }, LOG_CLOSE_LIMIT_MS);
      log.end(() => { clearTimeout(limit); done(); });
    });
  }

  return { logPath, say, end };
}
