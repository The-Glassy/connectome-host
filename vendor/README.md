# Vendored test builds (branch speculative-voice-chunks only)

This branch is a test build for one tenant (Glassy), not a release. It installs
two forks from the tarballs here instead of npm (`npm pack` of each fork at the
commit in the file name):

- `animalabs-agent-framework-0.30.0-speculative-e489edef.tgz`:
  The-Glassy/agent-framework `speculative-voice-chunks` @ e489edef
  (v0.30.0 + speculative channel chunks, docs/speculative-channel-chunks.md).
- `animalabs-membrane-0.8.0-speculative-f91d8e1.tgz`:
  The-Glassy/membrane `speculative-voice-chunks` @ f91d8e1
  (v0.8.0 + `emitToolInputDeltas`). `overrides` makes it the only membrane in
  the tree (context-manager and agent-framework share it).

The recipe key `agent.speculativeChannelChunks` (src/recipe.ts) turns the
feature on per agent. Upstream: anima-research/agent-framework#892.
