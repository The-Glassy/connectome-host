- Subagents are Dendrite agents. A fork is derived from its parent by the
  framework (`deriveAgent`, copy mode): the parent's compiled context becomes
  the fork's own, the parent's tool round in flight is reproduced with this
  call's result in it, so the fork sees the call that made it and never
  meets a dangling `tool_use`; a call the parent had stored before the
  launch is answered after the copy, its siblings with the framework's
  "no result yet" note, and a launch with no call gets the pair the fallback
  always made. A spawn is a registered worker. Both records name who spawned
  the subagent and where its result goes, and carry the launch (`metadata`).
  An async result returns by that route — attributed mail under the
  subagent's own name, held for a caller that has ended until it is adopted,
  never lost — where before it was a line in the primary's context whatever
  became of the caller. The orientation, the launch refusal and the
  concurrency, retry, cancel and time-limit rules are unchanged.
- Five tools over the registry: `subagent--list` (every launch, running,
  ended or orphaned, with its spawner, task and route), `subagent--stop`
  (a run cancelled children-first, task work it spawned orphaned and offered
  for adoption), `subagent--message` (a message in a running subagent's
  context under the sender's name, waking it), `subagent--adopt` (an
  orphan's new parent, its result following), and `subagent--resume` (an
  ended subagent continued from the context it left, under the same name,
  its result delivered as a message). The agent tree shows the edges from
  `dendrite:agent-created`.
