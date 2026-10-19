/**
 * A WebSocket MCPL server's url can carry a credential (a `token` or `key`
 * query value, a user and password), and agent-framework's dial errors name
 * the url they dialed. The lines the host writes about a connection mask it:
 * the mcpl-stderr lifecycle log, stderr, and the server targets status lines
 * show.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { McplServerConnection } from '@animalabs/agent-framework';
import { redactCredentials, redactingWrite, serverTarget } from '../src/credential-redaction.js';
import { buildMcplSnapshot } from '../src/web/panel-data.js';
import { formatMcplLifecycleLine } from '../src/mcpl-lifecycle-log.js';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** An HTTP server that refuses every WebSocket upgrade with `status`. */
function refusingServer(status: number): string {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('refused', { status }) });
  servers.push(server);
  return `ws://127.0.0.1:${server.port}/mcpl`;
}

describe('the mcpl-stderr lifecycle log', () => {
  test("a reconnect error's line masks the credential in the url the framework names", async () => {
    // A token written into the url itself: the framework's error names the
    // url it dialed, query and all.
    const url = refusingServer(502);
    const error = await McplServerConnection.connect(
      { id: 'tools', url: `${url}?token=s3cret&room=a` } as Parameters<typeof McplServerConnection.connect>[0],
      {} as Parameters<typeof McplServerConnection.connect>[1],
    ).then(async (c) => { await c.close(); return ''; }, (err: Error) => err.message);
    expect(error).toContain('token=s3cret');

    const line = formatMcplLifecycleLine({ type: 'mcpl:server-connect-failed', serverId: 'tools', error, attempt: 3, willRetry: true });
    expect(line).toStartWith('[host] connect failed (attempt 3, will retry): ');
    expect(line).toContain(`${url}?token=***&room=a`);
    expect(line).not.toContain('s3cret');
    expect(formatMcplLifecycleLine({ type: 'mcpl:server-stderr', serverId: 'tools', line: 'GET /mcpl?access_token=abc' }))
      .toBe('GET /mcpl?access_token=***');
    expect(formatMcplLifecycleLine({ type: 'mcpl:unrelated' })).toBeNull();
  });
});

describe('redactCredentials', () => {
  test('masks token, access_token and key parameters, Authorization headers, bearer credentials and url users', () => {
    expect(redactCredentials('wss://h/mcpl?token=abc&x=1')).toBe('wss://h/mcpl?token=***&x=1');
    expect(redactCredentials('wss://h/mcpl?x=1&ACCESS_TOKEN=abc#f')).toBe('wss://h/mcpl?x=1&ACCESS_TOKEN=***#f');
    expect(redactCredentials('failed (wss://h/?key=abc)')).toBe('failed (wss://h/?key=***)');
    expect(redactCredentials('Authorization: Bearer abc.def')).toBe('Authorization: ***');
    expect(redactCredentials('{"authorization":"Basic dXNlcjpwdw=="}')).toBe('{"authorization":"***"}');
    expect(redactCredentials('sent Bearer abc+/= upstream')).toBe('sent Bearer *** upstream');
    expect(redactCredentials('ws://user:pw@h/mcpl')).toBe('ws://***@h/mcpl');
  });

  test('masks a whole value: parentheses in a query value, every header scheme and parameter, a password with an @', () => {
    expect(redactCredentials('ws://h/?token=(s3cret)&x=1')).toBe('ws://h/?token=***&x=1');
    expect(redactCredentials('failed (ws://h/?token=s3(cr)et)')).toBe('failed (ws://h/?token=***)');
    expect(redactCredentials('Authorization: Digest username="alice", response="s3cret"')).toBe('Authorization: ***');
    expect(redactCredentials("{ authorization: 'Bearer s3cret', next: 1 }")).toBe("{ authorization: '***', next: 1 }");
    expect(redactCredentials('ws://user:pa@ss@host/mcpl')).toBe('ws://***@host/mcpl');
    expect(redactCredentials("ws://u:pa'ss@host/mcpl?token=ab'cd&x=1")).toBe('ws://***@host/mcpl?token=***&x=1');
    expect(redactCredentials("{ url: 'ws://h/mcpl?token=abcd' }")).toBe("{ url: 'ws://h/mcpl?token=***' }");
  });

  test('takes linear time over a long run of parentheses', () => {
    const started = performance.now();
    expect(redactCredentials(`?token=${')'.repeat(65_537)}`)).toBe(`?token=***${')'.repeat(65_537)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('leaves other text alone', () => {
    for (const text of ['wss://h/mcpl?monkey=1&room=a', 'token=abc', 'a bearer token', 'ws://h:3101/mcpl']) {
      expect(redactCredentials(text)).toBe(text);
    }
  });
});

describe('redactingWrite', () => {
  const lines = [
    'connect failed (ws://h/mcpl?token=s3cretvalue&room=a)\n',
    'Authorization: Bearer s3cretvalue\n',
    'dialing ws://user:s3cretvalue@h/mcpl\n',
  ];

  test('masks a credential split across two writes, wherever the split falls', () => {
    for (const line of lines) {
      for (let at = 1; at < line.length; at++) {
        const out: string[] = [];
        const write = redactingWrite((chunk) => { out.push(String(chunk)); return true; });
        write(line.slice(0, at));
        write(new TextEncoder().encode(line.slice(at)));
        expect(out.join('')).not.toContain('s3cret');
        expect(out.join('')).toContain('***');
      }
    }
  });

  test('holds a partial line, however long its rest takes, until the write that ends it or flush()', async () => {
    const out: string[] = [];
    const write = redactingWrite((chunk, cb) => { out.push(String(chunk)); (cb as (() => void) | undefined)?.(); return true; });
    const done: string[] = [];
    write('Authorization: Bearer firstHalf', () => done.push('first'));
    await Bun.sleep(60);
    expect(out).toEqual([]);
    // Its callback waits for its text too.
    expect(done).toEqual([]);
    write('SECRET_REMAINDER\n', () => done.push('second'));
    expect(out).toEqual(['Authorization: ***\n']);
    expect(done).toEqual(['first', 'second']);
    write('progress ?key=s3cretvalue');
    write.flush();
    expect(out[1]).toBe('progress ?key=***');
  });

  test('a line past the length cap is written, and a credential it cuts off is masked on into the next write', () => {
    for (const [head, tail, shown] of [
      ['?token=abc', 'def&room=a\n', '?token=***&room=a\n'],
      ['Authorization: Basic abc', 'def, more\nnext\n', 'Authorization: ***\nnext\n'],
      ['ws://user:pa', 'ss@host/mcpl\n', 'ws://***/mcpl\n'],
    ] as const) {
      const out: string[] = [];
      const write = redactingWrite((chunk) => { out.push(String(chunk)); return true; });
      const filler = 'x '.repeat(600 * 1024);
      write(`${filler}${head}`);
      write(tail);
      const text = out.join('').slice(filler.length);
      expect(text).toBe(shown);
    }
  });
});

describe('redactStderr', () => {
  test('masks console.error and console.warn, which Bun writes past process.stderr.write, and the write itself', async () => {
    const module = new URL('../src/credential-redaction.ts', import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, '-e', `
      const { redactStderr } = await import(${JSON.stringify(module)});
      redactStderr();
      console.error('MCPL server "tools" reconnect failed:', 'connect failed (ws://h/mcpl?token=s3cret)');
      console.warn({ authorization: 'Bearer s3cret' });
      process.stderr.write('ws://h/mcpl?key=s3cret\\n');
      console.error('plain', 1);
      console.warn(new Headers({ Authorization: 'Basic s3cret' }));
      process.stderr.write('split ws://h/?tok');
      process.stderr.write('en=s3cret\\n');
    `], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).not.toContain('s3cret');
    expect(stderr).toContain('MCPL server "tools" reconnect failed: connect failed (ws://h/mcpl?token=***)');
    expect(stderr).toContain('ws://h/mcpl?key=***');
    expect(stderr).toContain('plain 1');
    expect(stderr).toContain('split ws://h/?token=***');
  });

  test('keeps masking a console method assigned later, as the TUI console overlay assigns one, and a console object put in place', async () => {
    const module = new URL('../src/credential-redaction.ts', import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, '-e', `
      const { Console } = await import('node:console');
      const { redactConsole, redactStderr } = await import(${JSON.stringify(module)});
      redactStderr();
      // OpenTUI's TerminalConsole.overrideConsoleMethods, in short.
      console.error = (...args) => process.stdout.write('overlay: ' + args.join(' ') + '\\n');
      console.error('reconnect failed (ws://h/mcpl?token=s3cret)');
      // With OTUI_USE_CONSOLE it puts a Console of its own in place first.
      globalThis.console = new Console({ stdout: process.stdout, stderr: process.stdout });
      redactConsole();
      console.warn('reconnect failed (ws://h/mcpl?token=s3cret)');
      // Code that keeps the masked method and assigns one calling it.
      const saved = console.error;
      console.error = (...args) => saved('wrapped:', ...args);
      console.error('?token=s3cret');
    `], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(stdout).not.toContain('s3cret');
    expect(stdout).toContain('overlay: reconnect failed (ws://h/mcpl?token=***)');
    expect(stdout).toContain('\nreconnect failed (ws://h/mcpl?token=***)');
    expect(stdout).toContain('\nwrapped: ?token=***');
  });
});

describe('serverTarget', () => {
  test("names a server by its command, else its url with the url's credentials masked", () => {
    expect(serverTarget({ url: 'wss://h/mcpl?token=abc' })).toBe('wss://h/mcpl?token=***');
    expect(serverTarget({ url: 'ws://user:pw@h/mcpl' })).toBe('ws://***@h/mcpl');
    expect(serverTarget({ command: 'node', url: 'wss://h/?token=abc' })).toBe('node');
    expect(serverTarget({})).toBeUndefined();
  });

  test("the Web UI's MCP panel shows a live server's url masked", () => {
    const framework = { listMcplServers: () => [{ id: 'tools', connected: true, url: 'wss://h/mcpl?token=s3cret' }] };
    const snapshot = buildMcplSnapshot({ framework: framework as never, recipe: {} as never }) as { live: Array<{ target?: string }> };
    expect(snapshot.live[0]!.target).toBe('wss://h/mcpl?token=***');
  });
});
