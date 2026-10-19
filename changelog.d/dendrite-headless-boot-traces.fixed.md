- Headless runs feed the agent tree and the socket from the boot on. The
  traces `create()` replays (registry restore, work a stop cut off, resumed
  tune-out epochs) are held across `framework.start()` for the headless sink
  instead of being dropped by it, and the first client to connect hears the
  events from before it connected, each marked `replay: true`. Derived agents
  (`dendrite:agent-created`) hang under the agent they were made from in the
  tree, without a tool call to infer the edge from.
