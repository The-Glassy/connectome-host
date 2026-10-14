- `llm-calls.jsonl` records written by the generic provider logging wrapper (`openrouter`,
  `openai-compatible`, `openai-codex`, `claude-agent-sdk`) now carry as `rawRequest` the body
  the adapter reported through the request hook — what reached the provider — when the adapter
  reports one, as the bedrock records already did; otherwise the membrane request, as before.
