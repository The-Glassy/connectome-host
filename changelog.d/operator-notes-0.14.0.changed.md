- **Operators:** 0.14.0's step to agent-framework 0.27.0, context-manager
  0.22.1 and membrane 0.7.2 also changed what follows, which its notes didn't
  say.
  - **A recipe's `agent.retry` no longer applies to an agent's turns.**
    agent-framework now retries a turn itself, on membrane's default
    schedules: a 529 up to 7 tries over five to ten minutes, each wait between
    half and all of a step that doubles from 10 s to 5 minutes; a rate limit
    up to 5 tries; and any other retryable failure, such as a 5xx or a dropped
    connection, up to 3 tries, 1 s then 2 s apart. Under 0.13 releases,
    agent-framework retried a failed turn up to three times, 1, 2 and 4 s
    apart, and each try went through the host's own retries, up to three
    sends with a 529 retried as any other failure. `agent.retry` still
    applies to the agent's other provider calls through the host, such as
    compression, retrieval and session naming. Its documentation in the
    recipe still describes it applying to turns.
  - **A live-image limit of 0 no longer turns the limit off.** A recipe's
    `agent.strategy.maxLiveImages` of 0 now keeps up to 500 live images, and a
    `maxLiveImageBytes` of 0 up to 24 MiB. These are context-manager's image
    ceilings, and a value above one is held to it. This host doesn't pass the
    ceilings, so a recipe can't raise them. The recipe documentation still
    says 0 turns a limit off. A recipe that sets neither keeps the defaults, 6
    images and 20 MiB, as before.
  - **A pin or document mark on a long message now covers the whole
    message.** Under adaptive resolution, which this host turns on unless a
    recipe sets `adaptiveResolution: false`, a pin or mark the Pins panel made
    on a single message the store keeps in parts covered only its first part;
    it now covers every part. So the first compile after upgrading rewrites
    the request once, from that message on, or from earlier where older history
    folds further to make room for it. Where the whole message doesn't fit,
    the compile refuses as over budget, as for any pin the budget can't hold.
    Compression requests after the message carry it whole, so they cost more.
    A mark made as a long message arrived can leave parts no chunk holds,
    which compression requests carry without counting them against
    `compressionContextBudgetTokens`. Where those come to more than that
    budget, a summarizer with a smaller window would refuse those requests,
    and compression would stop making progress for that store unless
    `compressionSourceOnly` or `compressionSourceOnlyFallback` is set.
    Unpinning lets later requests leave them out, though a chunk already
    quarantined for them can stay quarantined.
  - **A channel an agent put in mentions mode before upgrading reads as one it
    closed itself.** agent-framework before 0.27.0 recorded the channel-mode
    module's close as the agent's own. So the agent's words there carry a note
    that it closed the channel and that `channel_open` opens it, which would
    undo only part of mentions mode. Calling `channel-mode--set_channel_mode`
    with `mode: "mentions"` for that channel again records the close as the
    module's, and the note stops.
  - **An MCPL server's `inference/request` is refused,** with a log line once
    per server naming `inferenceRouting`, which this host doesn't set and a
    recipe can't. 0.13 releases sent such a request to the provider under the
    model name `default`.
  - **One-time costs at upgrading.** agent-framework 0.27.0 changes the
    `channel_close` and `agent_settings` tool definitions, so each agent given
    either tool has its whole cached prompt written again at its first call.
    For an agent given `agent_settings`, that is the same write as the one
    0.14.0's notes give for `reasoning_display`'s description. With
    `modules.history.semantic`, each branch's summaries are embedded again
    under a new key, one embedding per summary; until a branch's summaries
    have been sent again, a search on it can miss one, and going back to a
    0.13 release leaves those out of its searches until the index is rebuilt.
