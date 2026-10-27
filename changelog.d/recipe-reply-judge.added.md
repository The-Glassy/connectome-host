- `modules.wake.judge` in recipes configures agent-framework's reply judge,
  the small model that `judge` wake rules ask before they wake the agent
  (`GateOptions.judge`: `enabled`, `model`, `maxInputTokens`, `timeoutMs`,
  `onError`, `effort`, `cacheTtl`). Each key is validated at load, and a bad
  one stops the load, naming the key and what it must be. The starting rules
  (`policies`, `default`) are passed to the gate without it. Takes effect with
  an agent-framework that has the reply judge; with today's it's passed
  through and ignored. docs/ATTENTION-AND-GATING.md documents `judge` rules
  for agents and the recipe keys for hosts.
