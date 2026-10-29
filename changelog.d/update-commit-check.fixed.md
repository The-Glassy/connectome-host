- When the commit at an installed host's start refuses, it now gives the
  refusal as the plain sentence it is, in the host's log and in the trial's
  lines `/update` shows after a release on trial went back. That covers a
  release on trial whose MCPL server didn't connect, and a `current` that is
  missing or couldn't be read, moved or synced. Before, each came as
  `Fatal error:` with a stack, which read as a crash.
- Installing a release where the copy's label is missing and the journal
  records no copy taken no longer says the label "was lost".
