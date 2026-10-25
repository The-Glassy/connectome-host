- Per-server `toolHints` (the MCPL RFC-014 opt-in that turns on tool hints
  and toolsets for a server) in recipes and `mcpl-servers.json`, each
  validated as `true` or `false`, overridable by a recipe that names a server
  from `mcpl-servers.json`, and passed through to agent-framework. Takes
  effect with an agent-framework that implements RFC-014.
