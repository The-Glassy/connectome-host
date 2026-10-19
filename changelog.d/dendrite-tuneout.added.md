- Tune-out mk2 recipe surface (agent-framework#546): `subconscious.reader: 'forks'`
  runs the tune-out reader as a succession of forks of the resident (`model`
  and `voice` required; the host supplies the per-fork strategy factory the
  way it does for `conversations`); top-level `speech.locus` (`delivery` |
  `latest-inbound`) chooses where plain prose lands when nothing names a
  destination; top-level `tuneOut.enabled` offers `tune_out` / `focus` without
  a reader (a silent hold). `subconscious.consent` is required for forks: the
  resident's public yes — who, when, where to read it, and the fork section
  as they saw it — and the recipe refuses a section that has changed since,
  naming the field; the framework carries the record on every fork and names
  it in each derivation notice, and the resident can withdraw with the
  `withdraw_consent` tool, after which no fork is derived and a tune-out is a
  silent hold until a later yes is recorded. The recipe fields are typed from
  the framework's own config and need the agent-framework release that
  carries #546; the dependency range rises with it.
- The framework's speech rule changes with that release: plain prose with
  nothing naming a destination lands by `delivery` (the waking delivery's
  channel, a fork's home channel, or a channel opened this turn; with none,
  the prose stays private and a `[routing]` notice says so). A recipe that
  leaves `speech.locus` unset gets the new rule; `"speech": { "locus":
  "latest-inbound" }` keeps the previous one.
