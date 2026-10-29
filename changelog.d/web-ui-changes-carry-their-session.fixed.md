- The Web UI's rollback, suppress, pin and settings changes are made only in
  the session they were chosen in. Each now carries the session the page
  showed, and the host refuses one chosen in a session that isn't the open
  one now, saying nothing changed. Before, a rollback or suppress confirmed
  in a dialog opened before a session switch, an armed quiesce-and-retry that
  fired after one, or a pin removal clicked as the switch's welcome arrived,
  acted on whichever of the open session's messages or pins had the same
  ids, since ids count from the start in each session's store. On a session
  switch the page now also drops an open rollback or suppress dialog, its
  pending retry, the selected messages and the pin and settings panels' state.
- The Web UI protocol is now v3: `rollback`, `suppress`, `pin-add`,
  `pin-remove`, `settings-update`, `settings-reset` and
  `settings-cancel-transition` require `sessionId` unless their `scope` names
  a fleet child, and carry none when it does. A client that sends one without
  it is refused, and a page from before this release shows its protocol
  mismatch banner.
