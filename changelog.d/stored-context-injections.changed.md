- For agent-framework storing a module's `afterUser` injection where the
  compile placed it (context-manager #155 part 5), so that it no longer
  moves at each start and costs the replies after it their thinking:
  - Retrieval reads each agent's own window, a fork's or a subagent's
    included, where it read the primary's for every agent. A
    subconscious's window is its own store, its summaries and tool rounds,
    which holds no message of anyone else's, so its lessons are found once
    per process from those and kept for the session, where they followed
    the residents' conversation. It keeps each agent's lessons for the
    turn's opening message, the newest row someone other than the agent
    wrote to it. A later start of the same turn, such as a restart after a
    tool round, gets the same block with no model calls, an empty result
    included, within one process; a retrieval that failed, or whose
    concept step answered with something that isn't a list, is tried
    again. Rows marked `system` (clock rows, autoContinue's `[continue]`,
    the framework's notices and the host's `[host-notice]`), rows under
    participant `system`, a self-wake's line and stored injections don't
    open a turn; a batched wake's `[Gate: …]` line, another agent's
    message, a subagent's result, a script's wake and the host's unmarked
    notes, such as a `[voice]` interruption, do. The block's heading names
    the message it was found for, and stored injections are left out of
    the conversation retrieval reads.
  - Retrieval's block fits under the strategy's per-message cap
    (`maxMessageTokens`, 10,000 by default), which would cut a stored
    message mid-text: it keeps whole lessons, most relevant first, leaves
    out any that doesn't fit, a single lesson over the cap included, and
    says how many it left out. With none that fits, nothing is injected.
  - The fleet status lists the running subagents and pending async
    handles, each started subagent with its start as a clock time in the
    recipe's `agent.timezone`, under "as of" the latest start or end,
    where it listed every subagent the session had started, with elapsed
    seconds and call counts. A finished one, which has reported in the
    conversation, leaves the list, and when the last one ends the status
    says none is running. The `hud` tool's text says that turning it off
    stops new statuses, and leaves one already in the context there.
  - A stored injection shows in the TUI's history replay and the Web UI as
    a labelled system row, such as `[retrieval, injected for alice]`, not
    as the user's or the agent's message. Session naming, a subagent's
    last-text fallback, a subagent's last message in `peek`, a fork's seed
    from its parent and the frontdesk strategy's open questions leave it
    out, and `/undo` steps back past one right before the reply it undoes.
    The `--audit-stores` check opens a store with agent-framework's view,
    which leaves out another agent's stored injections.
  - The instructions module, set off `system`, marks its injection to be
    placed at each compile as before, since instructions stored once would
    leave the context at a fold.
