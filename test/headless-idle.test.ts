import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectWhenAccepting } from './ipc-connect.ts';

const FIXTURE = join(import.meta.dir, 'mock-headless-self-restart-child.ts');
const CONFIRM_MS = 500;

function start(mode: 'quiet-exit' | 'quiet-idle' | 'text-exit', hold: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'headless-idle-')));
  const child = spawn(process.execPath, [FIXTURE, mode, hold], {
    cwd: dir, env: { ...process.env, DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12_000);
  let output = '';
  child.stdout!.on('data', (c) => { output += c; });
  child.stderr!.on('data', (c) => { output += c; });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal });
    });
  });
  return { dir, child, closed, output: () => output };
}

async function processedAt(dir: string): Promise<number> {
  while (!existsSync(join(dir, 'processed-at'))) await Bun.sleep(10);
  return Number(readFileSync(join(dir, 'processed-at'), 'utf8'));
}

function quietFrom(dir: string): number {
  return Number(readFileSync(join(dir, 'quiet-from'), 'utf8'));
}

async function client(dir: string, closed: Promise<unknown>) {
  let exited = false;
  void closed.then(() => { exited = true; });
  const socketPath = join(dir, 'ipc.sock');
  while (!existsSync(socketPath)) {
    if (exited) throw new Error('the fixture ended before it listened');
    await Bun.sleep(10);
  }
  const socket = await connectWhenAccepting(socketPath);
  const lines: Array<Record<string, unknown>> = [];
  const waiting: Array<() => void> = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    for (const wake of waiting.splice(0)) wake();
  });
  const next = async (phase: string, nth = 1): Promise<Record<string, unknown>> => {
    for (;;) {
      const found = lines.filter((e) => e.type === 'lifecycle' && e.phase === phase)[nth - 1];
      if (found) return found;
      if (exited) throw new Error(`the fixture ended before lifecycle ${phase}`);
      await new Promise<void>((wake) => { waiting.push(wake); setTimeout(wake, 100); });
    }
  };
  return {
    next,
    seen: (type: string) => lines.filter((e) => e.type === type).length,
    send: (...lines: object[]) => socket.write(lines.map((line) => `${JSON.stringify(line)}\n`).join('')),
    close: () => socket.destroy(),
  };
}

async function firstIdle(dir: string, closed: Promise<unknown>): Promise<number> {
  const watching = await client(dir, closed);
  await watching.next('ready');
  writeFileSync(join(dir, 'go'), '');
  const idle = await watching.next('idle');
  watching.close();
  return Number(idle.ts);
}

async function idleAfterQuiet(hold: string): Promise<void> {
  const { dir, child, closed } = start('quiet-idle', hold);
  try {
    const idleAt = await firstIdle(dir, closed);
    expect(idleAt - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}

async function exitAfterQuiet(hold: string): Promise<void> {
  const { dir, closed, output } = start('quiet-exit', hold);
  const result = await closed;
  expect({ code: result.code, signal: result.signal, output: result.code === 0 ? '' : output() })
    .toEqual({ code: 0, signal: null, output: '' });
  expect(readFileSync(join(dir, 'stopped'), 'utf8')).toBe('idle');
  expect(readFileSync(join(dir, 'headless.log'), 'utf8')).toContain('shutdown: exit-when-idle');
}

const HOLDS = [
  ['turn', 'a turn the framework still counts alive, as one waiting to retry'],
  ['gated', 'a gated wake'],
  ['script', 'a running background script'],
  ['queue', 'an event not yet taken off the queue'],
  ['subagent-active', 'a subagent run holding a slot'],
  ['subagent-queued', 'a queued subagent run'],
  ['wake-gap', "a subagent's end, with its wake a loop pass behind,"],
] as const;

for (const [hold, what] of HOLDS) {
  if (hold !== 'script') {
    test.concurrent(`${what} holds lifecycle idle back until it has been over for the quiet's 500 ms, though every agent reads idle`,
      () => idleAfterQuiet(hold), 15_000);
  }

  test.concurrent(`under --exit-when-idle, ${what} holds the exit back until it has been over for 500 ms`,
    () => exitAfterQuiet(hold), 15_000);
}

test.concurrent('a background script left running doesn\'t hold lifecycle idle: it comes 500 ms after the turn, while the script runs', async () => {
  const { dir, child, closed } = start('quiet-idle', 'script-until-released');
  try {
    const idleAt = await firstIdle(dir, closed);
    expect(idleAt - Number(readFileSync(join(dir, 'turn-ended'), 'utf8'))).toBeGreaterThanOrEqual(CONFIRM_MS);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('with nothing in flight, lifecycle idle comes, no sooner than 500 ms after the turn has ended, and --exit-when-idle exits 0 then',
  async () => {
    await idleAfterQuiet('none');
    await exitAfterQuiet('none');
  }, 15_000);

test.concurrent('a turn that starts and ends between two of the host\'s polls starts the quiet\'s 500 ms again', async () => {
  await idleAfterQuiet('blip');
  await exitAfterQuiet('blip');
}, 15_000);

test.concurrent('ready tells a client connecting whether the host has said idle since its last inference started', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const before = await client(dir, closed);
    expect(await before.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'go'), '');
    await before.next('idle');
    before.close();
    const after = await client(dir, closed);
    expect(await after.next('ready')).toMatchObject({ idle: true });
    after.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('ready says idle only while the host is still quiet: an event queued after the idle makes it say not idle, and a new idle follows', async () => {
  const { dir, child, closed } = start('quiet-idle', 'late-queue');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.close();
    writeFileSync(join(dir, 'queue-go'), '');
    const during = await client(dir, closed);
    expect(await during.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'release-queue'), '');
    expect(await during.next('idle')).toMatchObject({ texts: 0 });
    during.close();
    const after = await client(dir, closed);
    expect(await after.next('ready')).toMatchObject({ idle: true });
    after.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('ready says idle while only a background script left running goes on after the idle', async () => {
  const { dir, child, closed } = start('quiet-idle', 'script-until-released');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.close();
    const during = await client(dir, closed);
    expect(await during.next('ready')).toMatchObject({ idle: true });
    during.close();
    writeFileSync(join(dir, 'release-script'), '');
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text the agent is given no turn for counts as activity: an idle that covers it comes 500 ms after it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    expect(await watching.next('idle')).toMatchObject({ texts: 0 });
    watching.send({ type: 'text', content: 'declined' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('under --exit-when-idle, a host whose only text is given no turn exits 500 ms after it', async () => {
  const { dir, closed, output } = start('text-exit', 'none');
  const watching = await client(dir, closed);
  await watching.next('ready');
  watching.send({ type: 'text', content: 'declined' });
  const result = await closed;
  expect({ code: result.code, output: result.code === 0 ? '' : output() }).toEqual({ code: 0, output: '' });
  expect(readFileSync(join(dir, 'stopped'), 'utf8')).toBe('idle');
}, 15_000);

test.concurrent('after a session switch whose new framework starts a turn at once, the socket hears its start and idle comes again after it', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    expect(watching.seen('inference:started')).toBe(1);
    writeFileSync(join(dir, 'switch-busy'), '');
    await watching.next('idle', 2);
    expect(watching.seen('inference:started')).toBe(2);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text received on an old connection whose turn hasn\'t started yet keeps ready.idle false on the next', async () => {
  const { dir, child, closed } = start('quiet-idle', 'text-queued');
  try {
    const first = await client(dir, closed);
    await first.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await first.next('idle');
    first.send({ type: 'text', content: 'queued' });
    while (!existsSync(join(dir, 'texts-taken'))) await Bun.sleep(10);
    first.close();
    const second = await client(dir, closed);
    expect(await second.next('ready')).toMatchObject({ idle: false });
    writeFileSync(join(dir, 'release-queue'), '');
    expect(await second.next('idle')).toMatchObject({ texts: 0 });
    second.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text whose processing outlasts the quiet\'s 500 ms is covered only by an idle 500 ms after its processing ends', async () => {
  const { dir, child, closed } = start('quiet-idle', 'text-slow');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'slow to process' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text the framework refuses to queue, as when it has stopped, isn\'t left in flight', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    const refusedAt = Date.now();
    watching.send({ type: 'text', content: 'throws' });
    const second = await watching.next('idle', 2);
    expect(second).toMatchObject({ texts: 1 });
    expect(Number(second.ts) - refusedAt).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('after the host\'s framework is replaced, as a session switch does, its texts still end in an idle', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'switch' });
    expect(await watching.next('idle', 2)).toMatchObject({ texts: 1 });
    watching.send({ type: 'text', content: 'after the switch' });
    const third = await watching.next('idle', 3);
    expect(third).toMatchObject({ texts: 2 });
    expect(Number(third.ts) - quietFrom(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text that comes right behind a framework\'s replacement, still processing, isn\'t dropped from flight', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'switch' }, { type: 'text', content: 'slow' });
    const idle = await watching.next('idle', 2);
    expect(idle).toMatchObject({ texts: 2 });
    expect(Number(idle.ts) - await processedAt(dir)).toBeGreaterThanOrEqual(CONFIRM_MS);
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);

test.concurrent('a text the replaced framework was still processing leaves flight with it, so the host goes quiet on the new one', async () => {
  const { dir, child, closed } = start('quiet-idle', 'none');
  try {
    const watching = await client(dir, closed);
    await watching.next('ready');
    writeFileSync(join(dir, 'go'), '');
    await watching.next('idle');
    watching.send({ type: 'text', content: 'stuck' });
    while (!existsSync(join(dir, 'texts-taken'))) await Bun.sleep(10);
    watching.send({ type: 'text', content: 'switch' });
    expect(await watching.next('idle', 2)).toMatchObject({ texts: 2 });
    watching.close();
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
}, 15_000);
