- **Operators and residents, from agent-framework 0.31.0 (see its notes):**
  `@animalabs/agent-framework` is now `^0.31.0` (was `^0.30.0`);
  `package-lock.json` and `bun.lock` move that package and nothing else. An
  install that npm updates onto this release moves its context-manager to
  0.24.2 as well (see its notes); one that bun updates keeps the
  context-manager it has. What changes for residents:
  - A model call that stops making progress is cut. On the `anthropic` and
    `bedrock` providers, a resident's streamed call ends 60 seconds after its
    send if no content has come, or, once a thinking block has started, at
    its `max_tokens` at 87 tokens a second if that's later, and 150 seconds
    after its last provider event once content has begun. An SSE keepalive
    isn't progress. A cut call gets one fresh call a second later; if that is
    cut too, the turn ends with an `[inference-failed]` note that names the
    bound and says that a reply still owed from that turn can be given now.
    Before, such a call ended only at the Anthropic adapter's own 600-second
    watchdogs, the SDK's request timeout or a fetch timeout, and one kept
    open with keepalives didn't end.
    **Migration:** to give calls longer, raise the bounds with the recipe's
    new `inferenceBounds`, or set it to `false` for none of them.
    **Unchanged:** a call that keeps making progress runs as long as it
    needs.
  - A turn keeps the messages it opened to answer raw until it ends, where
    compression could fold them before. Their tokens count against the
    budget; a compile refused as over budget drops that hold and runs once
    more.
  - `save_recent_image`, which the workspace module brings, takes null for a
    selector the agent isn't using, and its `index` and `count` are integers.
    Its description and parameters change, so where prompt caching is on, the
    first request after the update of an agent with the workspace module
    (the default recipe has it) writes its cache in full.
  - Importing agent-framework no longer loads discord.js, which it now loads
    when a Discord client is made. This host's own code makes none, so it
    starts without loading it unless an extension makes one.
