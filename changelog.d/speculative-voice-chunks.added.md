- `agent.speculativeChannelChunks` (boolean, off when omitted): passes
  agent-framework's `speculativeChannelChunks` through, which streams a
  `channel_publish` call's text to a channel declaring
  `streaming: { speculative: true }` while the model writes it.
