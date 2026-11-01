# Vendored test build (branch cmtest-416-361 only)

A test build for one tenant (Junga), not a release: connectome-host v0.19.0 with
two upstream pull requests that target anima-research/context-manager#412
(over_budget). The tarballs are `npm pack` of these commits:

- `animalabs-context-manager-0.24.2-416-01f3a85.tgz`: anima-research/context-manager#416
  head (Anarchid:feat/415-liveness-headroom @ 01f3a85107de), which is context-manager
  0.24.2 (main fb4cf104) + #416: merges take their turn by relief, each adaptive compile
  reports its floor. `overrides` makes it the only context-manager in the tree.
- `animalabs-agent-framework-0.30.0-361-172ed7d8.tgz`: The-Glassy/agent-framework
  `cmtest/361-on-0.30.0` @ 172ed7d8 = v0.30.0 (the version v0.19.0 locks) + the net diff
  of anima-research/agent-framework#361 (nissa-seru:fix/304-budget-refusal-holds-turn
  @ d9d1ca63, against its base main 48f26ce5): a turn refused for budget waits while
  compression is pending, then runs. Five conflicts in src/framework.ts resolved; the
  commit message lists them.

`@animalabs/chronicle` goes from ^0.5.0 to ^0.5.1 because context-manager 0.24.2
requires it (one chronicle in the tree). chronicle 0.5.1 migrates nothing, and a store
it writes still opens on 0.5.0 (its CHANGELOG), so a rollback to v0.19.0 opens the store.
