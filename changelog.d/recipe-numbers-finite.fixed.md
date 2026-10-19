- A recipe number that must be positive or non-negative must also be finite:
  `agent.maxStreamTokens`, `agent.thinking.budgetTokens`,
  `agent.responses.compactThreshold`, `agent.cacheKeepalive`'s
  `refreshAfterMinutes` and `maxIdleHours`, `modules.fleet`'s four timeouts
  and `codeExecution`'s three. JSON `1e309` parses to `Infinity`, which
  passed the sign check; `saveRecipe()` then wrote it back as `null`, and the
  next start, resuming from the saved recipe, refused a field it had accepted
  the day before. The first load refuses it now, naming the field.
