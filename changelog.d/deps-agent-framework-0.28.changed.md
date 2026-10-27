- **Dependencies:** `@animalabs/agent-framework` ^0.28.0 (was ^0.27.0),
  `@animalabs/context-manager` ^0.23.1 (was ^0.22.1) and `@animalabs/membrane`
  ^0.8.0 (was ^0.7.2). `package-lock.json` and `bun.lock` move those three
  packages and nothing else. What operators and agents meet comes from those
  releases; see their changelogs. Among it: `modules.heartbeat` and
  `modules.wake.judge`, which this host already validates and passes through,
  take effect (agent-framework's own heartbeat in place of heartbeat-mcpl, and
  `judge` wake rules that ask a small model before waking the agent); a
  `chat:system` notice no longer decides where an agent's plain speech goes; a
  529 is retried for about as long as before 0.27.0; a response cut off at the
  output limit runs none of its last round's calls; workspace `ignore` and
  `include` patterns read the gitignore grammar only; and
  `agent.strategy.recoverLiteralThinkingWrappedCompression`, which this host
  passes through, takes effect.
