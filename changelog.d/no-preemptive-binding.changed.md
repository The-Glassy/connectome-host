- An agent no longer leaves its earlier replies' thinking out of a request
  ahead of time just because its model is one whose thinking can bind (on by
  default for those models since 0.16.0). Whether binding is enforced depends
  on the account as well as the model, and an account that doesn't enforce it
  kept the reasoning that was being left out. A recipe for an agent known to
  run on an enforcing account sets the new `agent.thinkingBinding: true`, which
  its subagents and forks follow. Without it, on Anthropic's API, the drop
  control still goes on requests for a model that takes it, so the provider
  drops a block it finds invalid instead of refusing the call; an agent that
  shows such refusals needs `thinkingBinding: true`.
