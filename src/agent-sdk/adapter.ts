// `claude-agent-sdk` provider: membrane completions served by the Claude
// Code CLI through the official Claude Agent SDK, instead of the host calling
// the Messages API itself. EXPERIMENTAL — a spike; read
// docs/claude-agent-sdk-provider.md before pointing a resident at it.
//
// Why: on a Claude subscription the SDK is the sanctioned client. The
// `anthropic` provider's OAuth path imitates Claude Code's identity block by
// hand (logging-adapter.ts); this one lets the CLI be the client.
//
// The CLI wants to own the agent loop; connectome owns context. Each membrane
// call therefore runs one short-lived CLI process that is told exactly what
// to send, and is checked:
//
//   1. planCall() splits the request into session history (loaded through
//      the SDK's SessionStore), the newest plain user turn (the prompt), and
//      any assistant tool rounds after it (played back by the proxy).
//   2. The CLI's ANTHROPIC_BASE_URL is a loopback proxy (proxy.ts). Every
//      request it makes is compared with what membrane asked for — messages,
//      system text, tool definitions. A mismatch fails the call; nothing the
//      CLI rewrote reaches the model. The only tolerated additions are the
//      CLI's own `<system-reminder>` blocks on user turns (reported in raw).
//   3. Played-back rounds are answered locally from the recorded assistant
//      turn; the CLI then "runs" the tools through an in-process MCP server
//      that returns the recorded results. Membrane's host executes tools,
//      never the CLI: a tool call outside a played-back round is denied.
//   4. The final request is forwarded byte-for-byte; its SSE stream feeds
//      membrane's callbacks as it arrives, and the process is stopped once
//      the response is complete.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MembraneError,
  abortError,
  errorFromHttpResponse,
  errorFromProviderStatus,
  unsupportedError,
} from '@animalabs/membrane';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderRequestOptions,
  ProviderResponse,
  StreamCallbacks,
} from '@animalabs/membrane';
import { modelAcceptsAdaptiveThinking, modelAcceptsEffort, type ReasoningGetter } from '../logging-adapter.js';
import { LoopbackProxy, SseAccumulator, jsonError, replayResponse, type CallHandler } from './proxy.js';
import {
  TOOL_SERVER,
  UnrepresentableRequest,
  attachmentsForPrompt,
  renderedCount,
  checkWireMessages,
  checkWireSystem,
  checkWireTools,
  expectedAtRound,
  planCall,
  prefixKeys,
  systemTexts,
  toMcpResult,
  transcriptRows,
  type Block,
  type CallPlan,
  type WireMessage,
} from './transcript.js';

export const AGENT_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';

/** The slice of the SDK this adapter uses (the package is an optional peer). */
export interface AgentSdk {
  query(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }): AsyncIterable<Record<string, any>>;
}

export type AgentSdkAuth = { apiKey: string } | { oauthToken: string };

export interface ClaudeAgentSdkAdapterConfig {
  auth: AgentSdkAuth;
  /** Where forwarded requests go. Default ANTHROPIC_BASE_URL, else the API. */
  upstreamBaseURL?: string;
  /** Working directory the CLI runs in (its environment reminder names it). */
  cwd?: string;
  /** CLAUDE_CONFIG_DIR for the CLI, kept apart from an operator's ~/.claude. */
  configDir?: string;
  /** CLI binary, when the SDK's platform package cannot be resolved. */
  pathToClaudeCodeExecutable?: string;
  /** Live reasoning settings (SettingsModule), applied like the anthropic provider does. */
  getReasoning?: ReasoningGetter;
  /** No upstream request within this long after spawn fails the call. */
  startupTimeoutMs?: number;
  /** Test seam: an SDK stand-in. Default: import the installed package. */
  sdk?: AgentSdk;
}

/**
 * Environment the CLI runs with. Most of these are CLI internals, not SDK
 * API, and may change under a CLI upgrade — which is why the proxy checks
 * every request rather than trusting them. Measured on CLI 2.1.299.
 */
const FIDELITY_ENV: Record<string, string> = {
  // No server-side context edits (clear_thinking), safeguard classifier
  // payloads or display-update thinking: request body stays plain.
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
  // No proactive/auto-mode reminders (environment, model and date remain).
  CLAUDE_CODE_DISABLE_ATTACHMENTS: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  // Context is the context manager's: no CLI compaction.
  DISABLE_COMPACT: '1',
  DISABLE_AUTO_COMPACT: '1',
  // Membrane owns retries and refusal handling, and the model is exactly
  // the one requested.
  CLAUDE_CODE_MAX_RETRIES: '0',
  CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1',
  CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
  CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
  CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP: '1',
  // Tools are listed in full, never deferred behind tool search, and their
  // played-back results are never truncated or time out.
  ENABLE_TOOL_SEARCH: 'false',
  MAX_MCP_OUTPUT_TOKENS: '100000000',
  MCP_TOOL_TIMEOUT: '86400000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_AUTOUPDATER: '1',
  CLAUDE_AGENT_SDK_CLIENT_APP: 'connectome-host',
};

/**
 * Top-level request fields the CLI may send. Anything else — notably the
 * CLI's default `context_management` (server-side thinking clearing) and
 * `safeguards`, which FIDELITY_ENV switches off — fails the call, so a CLI
 * that stops honoring those flags cannot change the context unnoticed.
 */
const WIRE_FIELDS = new Set(['model', 'messages', 'system', 'tools', 'metadata', 'max_tokens', 'thinking', 'temperature', 'output_config', 'stream']);

const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'USERPROFILE'];

/** Request fields the CLI offers no way to set; dropped with a warning. */
const UNSUPPORTED_PARAMS: Array<keyof ProviderRequest> = [
  'temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'repetitionPenalty', 'stopSequences',
];

const MAX_REMEMBERED_ATTACHMENTS = 512;
/** Longest a load waits for the previous call's attachment rows. */
const ATTACHMENT_CAPTURE_WAIT_MS = 2_000;

/** Reminder blocks on the wire's `sent` turn that the requested turn lacks. */
function addedReminders(sent: { content?: unknown } | undefined, requested: WireMessage): number {
  const own = new Set((typeof requested.content === 'string' ? [{ type: 'text', text: requested.content }] : requested.content)
    .filter((b) => b.type === 'text').map((b) => String(b.text)));
  return Array.isArray(sent?.content)
    ? (sent.content as Array<{ type?: string; text?: unknown }>)
        .filter((b) => b.type === 'text' && String(b.text).startsWith('<system-reminder>') && !own.has(String(b.text))).length
    : 0;
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export class ClaudeAgentSdkAdapter implements ProviderAdapter {
  readonly name = 'claude-agent-sdk';
  readonly usageCacheConvention = 'cache-excluded' as const;

  private readonly proxy: LoopbackProxy;
  private readonly cwd: string;
  private readonly configDir: string;
  private sdk: Promise<AgentSdk> | null = null;
  private readonly warned = new Set<string>();
  /** CLI attachment rows per conversation prefix (see transcriptRows). */
  private readonly attachments = new Map<string, Array<Record<string, unknown>>>();
  /** Captures still in flight: the SDK mirrors a call's rows after the call
   *  has returned, so the next call's load waits for them (bounded). */
  private readonly pendingCaptures = new Set<Promise<void>>();

  constructor(private readonly config: ClaudeAgentSdkAdapterConfig) {
    this.proxy = new LoopbackProxy(() => config.upstreamBaseURL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com');
    this.cwd = config.cwd ?? join(tmpdir(), 'connectome-agent-sdk', 'cwd');
    this.configDir = config.configDir ?? join(tmpdir(), 'connectome-agent-sdk', 'config');
    if (config.sdk) this.sdk = Promise.resolve(config.sdk);
  }

  supportsModel(modelId: string): boolean {
    return modelId.startsWith('claude-');
  }

  dispose(): void {
    this.proxy.stop();
  }

  complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.run(request, { onChunk: () => {} }, options, 'complete');
  }

  stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return this.run(request, callbacks, options, 'stream');
  }

  private loadSdk(): Promise<AgentSdk> {
    this.sdk ??= (async () => {
      const specifier = AGENT_SDK_PACKAGE;
      try {
        return (await import(specifier)) as AgentSdk;
      } catch (error) {
        this.sdk = null;
        throw new MembraneError({
          type: 'unsupported',
          message: `claude-agent-sdk: ${AGENT_SDK_PACKAGE} is not installed (npm install ${AGENT_SDK_PACKAGE}): ${error instanceof Error ? error.message : String(error)}`,
          retryable: false,
          rawError: error,
        });
      }
    })();
    return this.sdk;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[claude-agent-sdk] ${message}`);
  }

  private async run(
    request: ProviderRequest,
    callbacks: StreamCallbacks,
    options: ProviderRequestOptions | undefined,
    kind: 'complete' | 'stream',
  ): Promise<ProviderResponse> {
    if (options?.signal?.aborted) throw abortError(undefined, request);
    const t0 = performance.now();
    const tools = (request.tools ?? []) as Array<{ name: string; description?: string; input_schema?: unknown }>;
    let plan: CallPlan;
    let mcpResults: Map<string, ReturnType<typeof toMcpResult>>;
    try {
      plan = planCall(request.messages, new Set(tools.map((t) => t.name)));
      mcpResults = new Map(plan.replay.flatMap((r) => [...r.results].map(([id, b]) => [id, toMcpResult(b)] as const)));
    } catch (error) {
      if (error instanceof UnrepresentableRequest) throw unsupportedError(`claude-agent-sdk: ${error.message}`, request);
      throw error;
    }
    for (const key of UNSUPPORTED_PARAMS) {
      if (request[key] !== undefined && !(Array.isArray(request[key]) && (request[key] as unknown[]).length === 0)) {
        this.warnOnce(`param:${key}`, `${key} cannot be set through the Agent SDK; dropped`);
      }
    }
    const sdk = await this.loadSdk();
    // Listeners added below never fire for a signal that aborted during the
    // await, so check again before anything is spawned.
    if (options?.signal?.aborted) throw abortError(undefined, request);
    const sys = systemTexts(request.system);
    const { thinking, effort } = this.reasoningFor(request, kind);
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });

    const callId = randomUUID();
    const sessionId = randomUUID();
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort();
    options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const outcome = deferred<{ message: ReturnType<SseAccumulator['finish']> }>();
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      outcome.reject(error);
    };
    const injected: string[] = [];
    let cliBlocks: string[] = [];
    let sanitizedTools: string[] = [];
    let finalWire: Record<string, unknown> | undefined;
    let firstRequestMs: number | undefined;
    let round = 0;
    let activeRound = -1;

    const promptKey = prefixKeys([...plan.transcript, plan.prompt]).at(-1)!;
    const mirrored: Array<Record<string, unknown>> = [];
    let captured: (() => void) | undefined;
    // Reminder blocks the CLI put on the prompt, known once the final request
    // is seen; the remembered rows are complete when they render that many.
    let promptReminders = Number.POSITIVE_INFINITY;
    let attachmentsComplete = false;
    const remember = () => {
      const { rows, closed } = attachmentsForPrompt(mirrored, plan.prompt);
      if (rows.length === 0) return;
      // Rows may arrive over several batches: keep the longest set seen.
      if ((this.attachments.get(promptKey)?.length ?? 0) < rows.length) {
        this.attachments.delete(promptKey);
        this.attachments.set(promptKey, rows);
        if (this.attachments.size > MAX_REMEMBERED_ATTACHMENTS) this.attachments.delete(this.attachments.keys().next().value!);
      }
      if (closed || renderedCount(rows) >= promptReminders) {
        attachmentsComplete = true;
        captured?.();
      }
    };

    const accumulator = new SseAccumulator(callbacks, options?.wrapThinkingTags === true);
    const idleMs = options?.idleTimeoutMs ?? 600_000;
    const firstEventMs = options?.firstEventTimeoutMs ?? Math.max(idleMs, 600_000);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (ms: number, what: string) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        fail(new MembraneError({ type: 'timeout', message: `claude-agent-sdk: ${what} within ${ms}ms`, retryable: true, rawError: undefined, rawRequest: finalWire }));
        abort.abort();
      }, ms);
    };
    armIdle(this.config.startupTimeoutMs ?? 120_000, 'the CLI made no request');

    const handler: CallHandler = (req) => {
      if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(req.path)) return { kind: 'forward' };
      const body = req.json as Record<string, unknown> | undefined;
      firstRequestMs ??= Math.round(performance.now() - t0);
      const refuse = (reason: string) => {
        fail(unsupportedError(`claude-agent-sdk: CLI request ${round} is not the requested conversation — ${reason}`, body));
        return { kind: 'respond' as const, response: jsonError(400, 'invalid_request_error', 'refused by connectome: request differs from the conversation') };
      };
      if (!body) return refuse('unreadable request body');
      if (round > plan.replay.length) return refuse('the CLI made a request after the final one');
      const messages = checkWireMessages(expectedAtRound(plan, round), body.messages);
      if (!messages.ok) return refuse(messages.diff!);
      const system = checkWireSystem(sys, body.system);
      if (!system.ok) return refuse(system.diff!);
      const toolCheck = checkWireTools(tools, body.tools);
      if (toolCheck.diff) return refuse(toolCheck.diff);
      for (const name of toolCheck.sanitized) {
        this.warnOnce(`sanitized:${name}`, `the CLI sends tool ${name}'s definition NFKC-normalized (e.g. "…" as "...")`);
      }
      sanitizedTools = toolCheck.sanitized;
      if (body.model !== request.model) return refuse(`model ${String(body.model)}, expected ${request.model}`);
      const unexpected = Object.keys(body).filter((k) => !WIRE_FIELDS.has(k));
      if (unexpected.length) return refuse(`request carries ${unexpected.join(', ')}, which the conversation did not ask for`);
      injected.push(...messages.injected);
      cliBlocks = system.cliBlocks;
      if (round < plan.replay.length) {
        activeRound = round;
        const assistant = plan.replay[round]!.assistant;
        round++;
        return { kind: 'respond', response: replayResponse(assistant.content as Block[], request.model) };
      }
      round++;
      activeRound = -1;
      finalWire = body;
      promptReminders = addedReminders((body.messages as Array<{ content?: unknown }>)[plan.transcript.length], plan.prompt);
      remember();
      try { options?.onRequest?.(body); } catch { /* a caller's hook never fails the call */ }
      armIdle(firstEventMs, 'no response event arrived');
      return {
        kind: 'forward',
        onResponse: async (response) => {
          if (!response.ok) {
            const text = await response.text();
            let parsed: unknown = text;
            try { parsed = JSON.parse(text); } catch { /* keep the text */ }
            fail(errorFromHttpResponse('anthropic', response, parsed, finalWire));
            return new Response(text, { status: response.status, headers: response.headers });
          }
          if (!response.body) {
            fail(new MembraneError({ type: 'network', message: 'claude-agent-sdk: upstream response has no body', retryable: true, rawError: undefined, rawRequest: finalWire }));
            return response;
          }
          const [toCli, toUs] = response.body.tee();
          void (async () => {
            const reader = toUs.getReader();
            const decoder = new TextDecoder();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                armIdle(idleMs, 'the response stream went idle');
                accumulator.push(decoder.decode(value, { stream: true }));
              }
              const message = accumulator.finish();
              if (message.error) {
                throw errorFromProviderStatus({
                  provider: 'anthropic',
                  body: { type: 'error', error: message.error },
                  message: message.error.message,
                  rawRequest: finalWire,
                });
              }
              if (!message.sawTerminalEvent) throw new MembraneError({ type: 'network', message: 'claude-agent-sdk: response stream ended before message_delta', retryable: true, rawError: undefined, rawRequest: finalWire });
              if (!settled) { settled = true; outcome.resolve({ message }); }
            } catch (error) {
              fail(error instanceof MembraneError ? error : new MembraneError({ type: 'network', message: `claude-agent-sdk: response stream failed: ${String(error)}`, retryable: true, rawError: error, rawRequest: finalWire }));
            }
          })();
          return new Response(toCli, { status: response.status, headers: response.headers });
        },
      };
    };

    const baseUrl = this.proxy.register(callId, handler);
    let stderrTail = '';
    const sdkErrors: string[] = [];
    let finished!: () => void;
    const promptDone = new Promise<void>((resolve) => { finished = resolve; });
    const prompt = (async function* () {
      yield { type: 'user', message: plan.prompt, parent_tool_use_id: null };
      await promptDone;
    })();

    const mcpServer = {
      connect: async (transport: { onmessage?: (m: any) => void; send(m: unknown): Promise<void> | void; start?(): Promise<void> }) => {
        transport.onmessage = (msg: any) => {
          const reply = (result: unknown) => transport.send({ jsonrpc: '2.0', id: msg.id, result });
          if (msg.method === 'initialize') {
            return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'connectome-host', version: '0' } });
          }
          if (msg.method === 'tools/list') {
            return reply({
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description ?? '',
                inputSchema: t.input_schema ?? { type: 'object', properties: {} },
                _meta: { 'anthropic/alwaysLoad': true },
              })),
            });
          }
          if (msg.method === 'tools/call') {
            const id = String(msg.params?._meta?.['claudecode/toolUseId'] ?? '');
            const result = activeRound >= 0 && plan.replay[activeRound]!.results.has(id) ? mcpResults.get(id) : undefined;
            if (result) return reply(result);
            return reply({ content: [{ type: 'text', text: 'connectome executes tools itself' }], isError: true });
          }
          if (msg.id !== undefined) transport.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
        };
        await transport.start?.();
      },
    };

    const store = {
      load: async (key: { sessionId: string }) => {
        if (key.sessionId !== sessionId) return null;
        if (this.pendingCaptures.size > 0) await Promise.all([...this.pendingCaptures]);
        return transcriptRows({ messages: plan.transcript, sessionId, cwd: this.cwd, model: request.model, attachmentsAfter: (k) => this.attachments.get(k) });
      },
      append: async (_key: unknown, entries: Array<Record<string, unknown>>) => {
        mirrored.push(...entries);
        remember();
      },
    };

    const queryOptions: Record<string, unknown> = {
      cwd: this.cwd,
      env: this.childEnv(baseUrl, request.maxTokens),
      model: request.model,
      systemPrompt: { type: 'custom', prompt: sys, snapshot: false },
      tools: [],
      settingSources: [],
      permissionMode: 'default',
      verbatimPrompts: true,
      // replayed rounds + the final request, with a margin: the proxy refuses
      // any request past the final one, so the CLI cannot run further.
      maxTurns: plan.replay.length + 2,
      thinking,
      ...(effort ? { effort } : {}),
      mcpServers: { [TOOL_SERVER]: { type: 'sdk', name: TOOL_SERVER, instance: mcpServer } },
      canUseTool: async (_name: string, input: Record<string, unknown>, o: { toolUseID?: string }) =>
        activeRound >= 0 && o.toolUseID && plan.replay[activeRound]!.results.has(o.toolUseID)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'connectome executes tools itself', interrupt: true },
      sessionStore: store,
      sessionStoreFlush: 'eager',
      // A first turn has no history to load: the CLI refuses to resume an
      // empty session, so it starts a fresh one (still mirrored, for its
      // attachment rows).
      ...(plan.transcript.length > 0 ? { resume: sessionId } : {}),
      abortController: abort,
      stderr: (data: string) => { stderrTail = (stderrTail + data).slice(-4000); },
      ...(this.config.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.config.pathToClaudeCodeExecutable } : {}),
    };

    const drain = (async () => {
      for await (const m of sdk.query({ prompt, options: queryOptions })) {
        if (m.type === 'assistant' && m.error) sdkErrors.push(`assistant error: ${m.error}`);
        if (m.type === 'result' && m.subtype !== 'success') sdkErrors.push(...((m.errors as string[] | undefined) ?? [m.subtype]));
      }
    })().then(
      () => fail(this.exitError('the CLI finished without a forwarded response', sdkErrors, stderrTail, finalWire)),
      (error) => fail(abort.signal.aborted && options?.signal?.aborted ? abortError(undefined, finalWire ?? request)
        : this.exitError(`the SDK query failed: ${error instanceof Error ? error.message : String(error)}`, sdkErrors, stderrTail, finalWire, error)),
    );

    let onAbortReject: (() => void) | undefined;
    try {
      const { message } = await Promise.race([
        outcome.promise,
        new Promise<never>((_, reject) => {
          onAbortReject = () => reject(abortError(undefined, finalWire ?? request));
          options?.signal?.addEventListener('abort', onAbortReject, { once: true });
        }),
      ]);
      remember();
      // The CLI attached reminders to this prompt: hold the next load until
      // all their rows are mirrored, so that load renders this turn as sent.
      if (promptReminders > 0 && !attachmentsComplete) {
        const capture = new Promise<void>((resolve) => {
          captured = resolve;
          setTimeout(resolve, ATTACHMENT_CAPTURE_WAIT_MS);
        }).then(() => { this.pendingCaptures.delete(capture); });
        this.pendingCaptures.add(capture);
      }
      return {
        content: message.content,
        stopReason: message.stopReason,
        providerStopReason: message.providerStopReason,
        stopSequence: message.stopSequence,
        usage: message.usage,
        model: message.model || request.model,
        rawRequest: finalWire,
        raw: {
          content: message.content,
          stop_reason: message.stopReason,
          stop_sequence: message.stopSequence ?? null,
          stop_details: message.stopDetails ?? null,
          model: message.model,
          usage: message.rawUsage,
          agentSdk: {
            firstRequestMs,
            totalMs: Math.round(performance.now() - t0),
            replayedRounds: plan.replay.length,
            cliSystemBlocks: cliBlocks,
            cliInjectedReminders: injected,
            cliSanitizedTools: sanitizedTools,
          },
        },
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      options?.signal?.removeEventListener('abort', onExternalAbort);
      if (onAbortReject) options?.signal?.removeEventListener('abort', onAbortReject);
      finished();
      abort.abort();
      this.proxy.unregister(callId);
    }
  }

  private exitError(what: string, sdkErrors: string[], stderr: string, rawRequest: unknown, rawError?: unknown): MembraneError {
    const detail = [...sdkErrors, stderr.trim().split('\n').slice(-3).join(' | ')].filter(Boolean).join('; ');
    const auth = /not logged in|authentication|invalid api key|oauth/i.test(detail);
    return new MembraneError({
      type: auth ? 'auth' : 'unknown',
      message: `claude-agent-sdk: ${what}${detail ? ` (${detail.slice(0, 600)})` : ''}`,
      retryable: false,
      rawError,
      rawRequest,
    });
  }

  private childEnv(baseUrl: string, maxTokens: number): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of INHERITED_ENV) if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, FIDELITY_ENV);
    env.CLAUDE_CONFIG_DIR = this.configDir;
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
    if ('apiKey' in this.config.auth) {
      env.ANTHROPIC_API_KEY = this.config.auth.apiKey;
      // Bare mode: no environment/model/date reminders at all. It accepts
      // API keys only, so a subscription token runs in default mode.
      env.CLAUDE_CODE_SIMPLE = '1';
    } else {
      env.CLAUDE_CODE_OAUTH_TOKEN = this.config.auth.oauthToken;
    }
    return env;
  }

  /** Thinking and effort as SDK options, from the request or the live settings. */
  private reasoningFor(request: ProviderRequest, kind: 'complete' | 'stream'): { thinking: Record<string, unknown>; effort?: string } {
    const extra = request.extra as { thinking?: Record<string, unknown>; output_config?: { effort?: string } } | undefined;
    let t = (request.thinking ?? extra?.thinking) as { type?: string; budget_tokens?: number; display?: string } | undefined;
    const r = this.config.getReasoning?.();
    if (!t && r?.enabled && modelAcceptsAdaptiveThinking(request.model)) t = { type: 'adaptive', display: r.display ?? 'summarized' };
    const display = t?.display ? { display: t.display } : {};
    const thinking = t?.type === 'adaptive'
      ? { type: 'adaptive', ...display }
      : t?.type === 'enabled'
        ? { type: 'enabled', ...(t.budget_tokens ? { budgetTokens: t.budget_tokens } : {}), ...display }
        : { type: 'disabled' };
    let effort = extra?.output_config?.effort;
    if (!effort && kind === 'stream' && r?.effort && r.effort !== 'default' && modelAcceptsEffort(request.model, r.effort)) effort = r.effort;
    return { thinking, ...(effort ? { effort } : {}) };
  }
}
