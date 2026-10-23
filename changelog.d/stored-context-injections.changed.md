- For agent-framework storing a module's `afterUser` injection where the
  compile placed it (context-manager #155 part 5), so that it no longer
  moves at each start and costs the replies after it their thinking:
  - Retrieval reads each agent's own window, a fork's or a subagent's
    included, where it read the primary's for every agent. A
    subconscious's window is its own store, its summaries and tool rounds,
    which holds no message of anyone else's, so its lessons are found from
    those and kept, as any agent's are, while its entry is among the 64
    most recently used, where they followed the residents' conversation.
    It keeps each agent's lessons for the turn's opening message, the
    newest row someone other than the agent wrote to it. A later start of
    the same turn, such as a restart after a tool round, gets the same
    block with no model calls, an empty result of those calls included,
    within one process; a start that a later start of the agent's overtook
    keeps nothing; a retrieval that failed, or whose concept step answered
    with something that isn't a list, is tried again. Rows marked `system`
    (clock rows, autoContinue's `[continue]`, the framework's notices and
    the host's `[host-notice]`), rows under participant `system`, a
    self-wake's line and stored injections don't open a turn; a batched
    wake's `[Gate: …]` line, another agent's message, a subagent's result,
    a script's wake and the host's unmarked notes, such as a `[voice]`
    interruption, do. The block's heading names the message it was found
    for, and stored injections are left out of the conversation retrieval
    reads.
  - Retrieval's block fits under the smallest per-message cap of the
    windows it gathers for, which would cut a stored message mid-text: the
    strategy's (`maxMessageTokens`, 10,000 by default, none for
    passthrough or a cap that isn't a positive number) and, with the
    subagent module on, a subagent's or a fork's, 10,000. When every
    lesson fits, the block holds them all; otherwise it keeps whole
    lessons, most relevant first, leaves out any that doesn't fit, a
    single lesson over the cap included, and says how many it left out.
    With none that fits, nothing is injected.
  - The fleet status lists the subagents running or waiting for a slot,
    each started subagent with its start as a clock time in the recipe's
    `agent.timezone`, under "as of" the latest start or end, where it
    listed every subagent the session had started, with elapsed seconds
    and call counts. A finished one, which has reported in its launcher's
    conversation, leaves the list, and once none is running or waiting, an
    agent whose newest stored status lists a run is told so, once. The
    `hud` tool's text says when the status is added again, and that
    turning it off stops new statuses and leaves one already in the
    context there. The `hud` setting now stays on across a subagent's
    start or end, which turned it off before.
  - An async subagent's result, `[Subagent '…' returned]` or `[… failed]`,
    lands in the window of the agent that launched it, a fork's or a
    subagent's own, through agent-framework's `addMessage` with
    `forAgent`, where it landed in the residents' slot for every launcher.
    Its line names a launcher that isn't the primary, as `[Subagent
    'scout' returned, for 'fork-y']`. One whose launcher has ended lands
    in the residents' slot, its line adding `, which has ended`. One whose
    launcher's window is let go without reading it, a fork's or a
    subagent's run, or a conversation agent closed, agent-framework passes
    to the residents' slot, where its line names whom it was for. None of
    these wakes the primary.
  - A stored injection shows in the TUI's history replay and the Web UI as
    a labelled system row, such as `[retrieval, injected for alice]`, not
    as the user's or the agent's message. Session naming, a subagent's
    last-text fallback, a subagent's last message and message count in
    `peek`, a fork's seed from its parent and the frontdesk strategy's
    open questions leave it out, and `/undo` steps back past one right
    before the reply it undoes. The `--audit-stores` check opens a store,
    and its subconscious's, with agent-framework's views, which leave out
    another agent's stored injections.
  - The instructions module, set off `system`, marks its injection to be
    placed at each compile as before, since stored instructions would
    drift back into history as the conversation grew past them.
