- For agent-framework storing a module's `afterUser` injection where the
  compile placed it (context-manager #155 part 5), so that it no longer
  moves at each start and costs the replies after it their thinking:
  - Retrieval keeps each agent's lessons for the turn's opening message,
    the newest row someone other than the agent wrote to it. A later start
    of the same turn, such as a restart after a tool round, gets the same
    block with no model calls, an empty result included; a failed one is
    tried again. Rows marked `system` (clock rows, autoContinue's
    `[continue]`, the framework's notices and the host's `[host-notice]`),
    a self-wake's line and stored injections don't open a turn; a batched
    wake's `[Gate: …]` line, another agent's message, a subagent's result
    and the host's unmarked notes, such as a `[voice]` interruption, do.
    The block's heading names the
    message it was found for, and stored injections are left out of the
    conversation retrieval reads.
  - The fleet status shows each subagent's start and end as clock times in
    the recipe's `agent.timezone`, under "as of" the latest change, where
    it showed elapsed seconds. A completed run shows its call count; a
    failed or stopped one no longer shows "0calls", a count never taken.
  - A stored injection shows in the TUI's history replay and the Web UI as
    a labelled system row, such as `[retrieval, injected for alice]`, not
    as the user's or the agent's message. Session naming and a subagent's
    last-text fallback leave it out, and `/undo` steps back past it, so it
    ends where it did before the turn.
  - The instructions module, set off `system`, marks its injection to be
    placed at each compile as before, since instructions stored once would
    leave the context at a fold.
