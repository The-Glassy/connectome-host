# The `claude-agent-sdk` provider (experimental spike)

`agent.provider: "claude-agent-sdk"` serves a resident's model calls through
the Claude Code CLI, driven by the official
[Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview),
instead of the host calling the Messages API itself. It is a spike: it works
end to end against a stand-in API, it has **never been run against the real
API**, and it exists to answer "is this worth doing?" with measurements
rather than guesses.

Why look at it: on a Claude subscription the SDK is the sanctioned client. The
`anthropic` provider's subscription path recreates Claude Code's identity
block by hand (`src/logging-adapter.ts`) and refreshes OAuth tokens itself;
that breaks whenever the endpoint's expectations move. Here the CLI is the
client. Whether a given deployment may use a subscription this way is a
question for Anthropic's current terms, not something this code settles.

## The short answer

| Question | Answer (CLI 2.1.299, SDK 0.3.299) |
|---|---|
| Can connectome keep owning the context? | Yes. The history is loaded through the SDK's `SessionStore`, and every request the CLI makes is checked against the requested conversation before it is forwarded. |
| Does the conversation reach the API verbatim? | Yes for messages: text, signed thinking, tool calls and results, byte for byte. Tool *definitions* arrive NFKC-normalized (`…` → `...`). |
| Is the cached prefix stable from turn to turn? | Yes, in both auth modes: turn k's request starts with exactly the bytes turn k−1 sent. (Whether the API then *hits* the cache is unverified.) |
| What does it cost? | One short-lived CLI process per model call: **~0.45 s** from call to first upstream request (p50, n=10, this container). A five-round tool loop adds ~0.2 s. |
| What can't it do? | Prefill / `anthropic-xml` recipes; a user turn mixing tool results with other content; sampling parameters; the host's cache-marker placement and TTL; error tool results with images. |

## How a call runs

```
membrane request ──► planCall()                      src/agent-sdk/transcript.ts
                       history  → SessionStore rows (resume)
                       prompt   → the newest plain user turn
                       replay   → assistant tool rounds after it
                  ──► query() spawns the CLI          src/agent-sdk/adapter.ts
                       ANTHROPIC_BASE_URL = loopback proxy
                       tools = in-process MCP server "host"
                  ──► CLI request #0..n-1 ─► proxy: check, then answer locally
                                              with the recorded assistant turn;
                                              CLI "runs" the tools, MCP hands
                                              back the recorded results
                  ──► CLI request #n ─────► proxy: check, then forward upstream
                                              byte for byte; the SSE stream is
                                              teed into membrane's callbacks
                  ──► response complete → the CLI process is stopped
```

The proxy (`src/agent-sdk/proxy.ts`) is the safety net. Each CLI request is
compared with what membrane asked for: messages (after normalizing string vs
block content and dropping cache markers), the system text, the tool list,
the model, and the set of top-level fields (anything beyond `model`,
`messages`, `system`, `tools`, `metadata`, `max_tokens`, `thinking`,
`temperature`, `output_config` and `stream` is refused, so the CLI's
`context_management` or `safeguards` cannot come back unnoticed). Any other difference fails the membrane call with
`type: 'unsupported'` and the diff, and nothing goes upstream. The only
tolerated differences are:

- the CLI's own `<system-reminder>` blocks on user turns;
- the CLI's own system blocks ahead of the recipe's text;
- the CLI's sanitization of tool definitions.

All three are reported under `raw.agentSdk` in `llm-calls.jsonl`. This is
what lets the adapter lean on undocumented CLI environment variables: if a
CLI upgrade changes behaviour, calls start failing with a precise reason
instead of silently sending a different context.

Membrane's host always executes tools. In a played-back round the CLI's
`canUseTool` allows exactly the recorded calls, and the MCP server returns
their recorded results. Any other tool call is denied.

## What the CLI does on its own (measured)

Probed against a recording stand-in API. Each of these shaped the design:

1. **System prompt.** The CLI sends `x-anthropic-billing-header: …` and
   `You are a Claude agent, built on Anthropic's Claude Agent SDK.` ahead of
   the custom prompt, which it joins into one block. It places three cache
   breakpoints (identity block, system block, last user block). The billing
   line was constant across the turns of one conversation and differed
   between conversations.
2. **Extras on by default.** Server-side `context_management` (clear
   thinking), a `safeguards` classifier payload, `display: "updates"`
   thinking, and the `auto` permission mode, which makes **extra
   security-classifier API calls before every tool call**. These are off via
   `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and `permissionMode: 'default'`,
   and the wire check refuses a request that carries either field.
3. **Reminders.** Environment (cwd, platform), model identity and today's
   date arrive as `<system-reminder>` blocks prepended to the newest user
   turn, even with `verbatimPrompts`. Bare mode (`CLAUDE_CODE_SIMPLE=1`)
   removes them but accepts API keys only ("Not logged in" with an OAuth
   token). On a subscription they stay. They are delta attachments, though:
   the CLI skips them when the transcript already holds equivalent rows. The
   adapter keeps the rows the CLI mirrors through `SessionStore.append` and
   writes them back after the same user turn on later calls. The reminders
   then sit on the first user turn, identical every call, instead of moving
   and breaking the cached prefix each turn.
4. **Resume normalization.** A transcript ending in a `tool_use` gets a
   synthetic `[Tool call interrupted…]` result. One ending in a user turn
   gets a synthetic `No response requested.` assistant turn before the next
   prompt. Neither `--reply-on-resume` (REPL only) nor
   `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` (runs before the SDK delivers the
   system prompt and MCP servers) avoids this. Hence the playback design for
   requests that end in tool results.
5. **Tools.** In-process MCP tools reach the wire as `mcp__host__<name>`.
   The adapter prefixes `tool_use` names in history to match and strips the
   prefix from responses. Definitions (descriptions, schema strings) are
   NFKC-normalized with format characters removed (`…` → `...`, zero-width
   space dropped). Tool results and inputs are not touched.
6. **Tool results through MCP.** Success results come back as text/image
   blocks. An `is_error` result is flattened to a string and **its images
   are dropped**. The check catches this, so such a round is refused.
7. **Mid-turn messages.** A user message sent while tools run is folded into
   the last tool result as a "user sent a new message while you were
   working" reminder. A turn mixing tool results and text is therefore
   refused, not approximated.
8. **Compaction and clearing.** The CLI has auto-compaction and time-based
   "microcompact" (`[Old tool result content cleared]`). Both are disabled
   by environment, and the wire check would refuse either if it fired.

## Measurements

`bun scripts/agent-sdk-spike.ts` runs the real adapter, SDK and CLI against
a loopback stand-in API. It needs no credential or network:

```
spawn  api-key (bare mode)    first request p50 445ms (max 535) · response p50 447ms (max 536) · n=10
spawn  subscription token     first request p50 518ms (max 566) · response p50 520ms (max 569) · n=10
prefix api-key (bare mode)    turn k starts with turn k-1's bytes: yes yes yes · CLI reminders per turn: 0 0 0 0
prefix subscription token     turn k starts with turn k-1's bytes: yes yes yes · CLI reminders per turn: 3 3 3 3
tools  played-back rounds → response ms: 1:447 2:471 3:512 4:523 5:676 · one upstream request each, forwarded messages = requested: yes
hygiene CLI processes left running: 0 · /tmp/claude-resume-* dirs left: 0
```

"Reminders per turn: 3" means the same three remembered blocks on the first
user turn, re-sent unchanged. One api-key run once took 12.6 s to its first
request. That did not reproduce in later runs, including with the page cache
dropped (worst 852 ms), and is unexplained. A host-level run (`bun src/index.ts` in batch
mode with a `claude-agent-sdk` recipe) completed a plain turn, then a
two-round tool loop on the host's real tools. That loop was three membrane
calls with 0, 1 and 2 rounds played back, one upstream request each, signed
thinking intact.

A probe that kept the CLI process alive across a tool round, with the MCP
handler waiting for the host's result, sent its next request **42 ms** after
the result arrived (vs ~450 ms for a fresh process). That is the obvious
next optimization (below).

## Using it

```bash
npm install @anthropic-ai/claude-agent-sdk   # optional peer, ~250 MB with the CLI binary
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…    # `claude setup-token`; or ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY
```

```json
{ "agent": { "provider": "claude-agent-sdk", "model": "claude-opus-4-6", "systemPrompt": "…" } }
```

- A subscription token wins over an API key, as on the `anthropic` provider.
  The CLI gets only that one credential, never the host's environment.
- `ANTHROPIC_BASE_URL` still names the upstream; the CLI is pointed at the
  loopback proxy (127.0.0.1, a random port, one path per call).
- `CLAUDE_AGENT_SDK_CLI_PATH` names the CLI binary when the SDK's platform
  package can't be resolved (e.g. a `bun build --compile` host).
- The CLI runs in `$DATA_DIR/agent-sdk/cwd` with `CLAUDE_CONFIG_DIR`
  `$DATA_DIR/agent-sdk/config`, never in an operator's `~/.claude`.
- Reasoning settings (`agent.thinking`, the agent's live reasoning/effort
  settings) map onto the SDK's `thinking` and `effort` options. Absent
  thinking is sent as disabled. When effort is unset, the CLI sends `high`.

### What you give up, versus `anthropic`

| | |
|---|---|
| Formatter | `native` only; `anthropic-xml` is rejected at recipe load. |
| Sampling | `temperature`, `top_p`, `top_k`, stop sequences are dropped with a one-time warning. |
| Caching | The CLI's three breakpoints and TTL; `agent.cacheTtl`, `promptCaching`, `cacheKeepalive` don't apply. |
| Accounting | No call ledger, quota meter or credential monitor yet; usage still lands in `llm-calls.jsonl`. |
| Model-visible | Tool names carry `mcp__host__`. Tool definitions are NFKC-normalized. On a subscription, the first user turn carries the CLI's environment/model/date reminders. Agent SDK identity block. |
| Shapes refused | Assistant prefill, tool results mixed with text, error results with images, playback of a tool the request no longer declares, non-text/image tool-result blocks. |
| Latency | ~0.45 s per call for the process. |

## Not verified

- **No call has reached the real API.** Unknown:
  - whether the subscription endpoint accepts this traffic (it is the
    SDK's own request shape, so it should);
  - real cache hit rates, and which TTL the CLI asks for;
  - rate-limit headers;
  - whether the API accepts signed thinking replayed through playback. It
    is byte-identical to what the transcript path sends, but untested here.
- Long runs: microcompact timers, date rollover (a new date reminder lands on
  the newest turn), many concurrent CLI processes, memory per process.
- After a host restart the remembered reminder rows are gone, so the first
  call puts fresh reminders on the newest turn: one prefix change, once.
- macOS and Windows. Only linux-x64 was exercised.
- The environment flags are CLI internals (`src/agent-sdk/adapter.ts`
  `FIDELITY_ENV`). A CLI upgrade can change them; the wire check is what
  turns that into a clear failure rather than a silent difference.

## Next steps, if this is worth continuing

1. One recipe on a real subscription for a day: read `cacheReadTokens` and
   `raw.agentSdk` in `llm-calls.jsonl`.
2. Keep the CLI process alive across a tool loop (42 ms vs ~450 ms a round),
   falling back to playback when the next request is not a continuation.
3. Persist the remembered reminder rows next to the session store, so a
   restart doesn't move them.
4. Wire `rate_limit_event` messages into the quota meter and auth failures
   into the credential monitor.
