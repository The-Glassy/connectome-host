- `agent.strategy.recoverLiteralThinkingWrappedCompression` in recipes (off by
  default) is passed through to context-manager's autobiographical strategy,
  which then keeps a compression answer that a model without native reasoning
  wrote entirely inside one closed literal `<thinking>…</thinking>` wrapper, as
  the prose inside it, instead of stripping it to nothing. Takes effect with a
  context-manager that has the option; an earlier one ignores it.
