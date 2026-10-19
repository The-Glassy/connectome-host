/**
 * A WebSocket MCPL server's url can carry a credential (a `token` or `key`
 * query value, a user and password), and agent-framework's dial errors name
 * the url they dialed. The lines the host writes about a connection mask it:
 * the mcpl-stderr lifecycle log, stderr, and the server targets status lines
 * show.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { McplServerConnection } from '@animalabs/agent-framework';
import { redactChunk, redactCredentials, serverTarget } from '../src/credential-redaction.js';
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

  test('leaves other text alone', () => {
    for (const text of ['wss://h/mcpl?monkey=1&room=a', 'token=abc', 'a bearer token', 'ws://h:3101/mcpl']) {
      expect(redactCredentials(text)).toBe(text);
    }
    const bytes = new TextEncoder().encode('plain line\n');
    expect(redactChunk(bytes)).toBe(bytes);
    expect(Buffer.from(redactChunk(new TextEncoder().encode('?token=abc'))).toString()).toBe('?token=***');
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
    `], { stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(stderr).not.toContain('s3cret');
    expect(stderr).toContain('MCPL server "tools" reconnect failed: connect failed (ws://h/mcpl?token=***)');
    expect(stderr).toContain('ws://h/mcpl?key=***');
    expect(stderr).toContain('plain 1');
  });
});

describe('serverTarget', () => {
  test("names a server by its command, else its url with the url's credentials masked", () => {
    expect(serverTarget({ url: 'wss://h/mcpl?token=abc' })).toBe('wss://h/mcpl?token=***');
    expect(serverTarget({ url: 'ws://user:pw@h/mcpl' })).toBe('ws://***@h/mcpl');
    expect(serverTarget({ command: 'node', url: 'wss://h/?token=abc' })).toBe('node');
    expect(serverTarget({})).toBeUndefined();
  });
});
