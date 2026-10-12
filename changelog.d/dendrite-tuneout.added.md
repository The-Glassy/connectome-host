- Tune-out mk2 recipe surface (agent-framework Dendrite branch): `subconscious.reader: 'forks'`
  runs the tune-out reader as a succession of forks of the resident (`model`
  and `voice` required; the host supplies the per-fork strategy factory the
  way it does for `conversations`); top-level `speech.locus` (`delivery` |
  `latest-inbound`) chooses where plain prose lands when nothing names a
  destination; top-level `tuneOut.enabled` offers `tune_out` / `focus` without
  a reader (a silent hold). Needs agent-framework ≥ the `feat/dendrite`
  branch; an older framework ignores the new fields.
