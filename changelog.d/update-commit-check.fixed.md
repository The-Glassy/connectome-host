- When an installed host refuses a start before any agent starts, it now
  gives the refusal as the plain sentence it is, in its log and in the trial's
  lines `/update` shows after a release on trial went back. Such a refusal is
  a release on trial whose MCPL server didn't connect, an install with no
  `current`, or a `current` that couldn't be read, moved or synced. Before,
  each came as `Fatal error:` with a stack, which read as a crash.
- Installing a release, on an install where no switch has taken a copy yet,
  no longer says the copy's label "was lost".
