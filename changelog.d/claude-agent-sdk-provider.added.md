- **Experimental `claude-agent-sdk` provider** (`agent.provider: "claude-agent-sdk"`): model
  calls are served by the Claude Code CLI through the Claude Agent SDK (an optional peer,
  `npm install @anthropic-ai/claude-agent-sdk`) instead of the host calling the Messages API.
  History is loaded through the SDK's `SessionStore`; requests that end in tool results are
  played back locally so the CLI's next request is the real one; every request the CLI makes
  is checked against the requested conversation by a loopback proxy and forwarded byte for
  byte, or the call fails with the difference. Auth from `CLAUDE_CODE_OAUTH_TOKEN` (else
  `ANTHROPIC_AUTH_TOKEN`, else `ANTHROPIC_API_KEY`). Native formatter only (`anthropic-xml`
  is rejected at load); sampling parameters, cache-marker placement and TTL are the CLI's.
  Not yet run against the real API — see `docs/claude-agent-sdk-provider.md`, and
  `scripts/agent-sdk-spike.ts` for the offline measurements.
