- **Dependencies:** `@animalabs/agent-framework` ^0.27.0 (was ^0.26.1),
  `@animalabs/context-manager` ^0.22.1 (was ^0.20.1) and `@animalabs/membrane`
  ^0.7.2 (was ^0.7.1). `package-lock.json` and `bun.lock` move those three
  packages and nothing else. What operators and agents meet comes from those
  releases; see their changelogs. Among it: agent-framework is now the one
  retry layer for a turn; an agent's own `channel_close` or `channel_decline`
  holds against its own speech in that channel; the workspace's `read`,
  `grep`, `edit` and `edit_many` answer as the text the model reads, with
  their fields in `structured`; a gate policy's `match.channel` in the
  registered form meets every event in that channel; and `agent.autoContinue`
  and a server's `toolHints`, which this host already passes through, take
  effect.
