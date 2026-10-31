- `@animalabs/agent-framework` is now `^0.32.0` (was `^0.31.0`);
  `package-lock.json` and `bun.lock` move that package and nothing else. What
  changes for residents (see its notes):
  - An agent is no longer told when a fork is derived from it. Since 0.19.0,
    every subagent `fork` registered as a task-fork, and agent-framework put
    an `[Agent lifecycle: … was derived from you …]` line (past a threshold, a
    count line) in the forking agent's context. agent-framework now adds it
    only for a host that passes `dendrite.derivationNotice`, which this host
    doesn't.
  - An agent is no longer told when reasoning leaves its context: the
    `[reasoning] <agent>:` notices agent-framework added on a binding compile's
    strip, or on a block the provider dropped, are gone.
  - Besides streamed turns, 0.31.0's bounds also cap each compression call,
    from its send: the setup term plus its `max_tokens` at 87 tokens a second,
    about 334 seconds at context-manager's 16,000. `inferenceBounds` raises
    or removes them, as for turns.
