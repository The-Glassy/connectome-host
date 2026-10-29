- The Web UI's rollback, suppress, pin and settings changes on this host are
  made only in the session they were chosen in. Each carries the session whose
  messages, pins or settings the operator chose it from, as the host stamped
  it on that data, and the host refuses one chosen in a session other than the
  one whose framework is open, naming both sessions and saying nothing
  changed. Before, a rollback or suppress confirmed in a dialog opened before a
  session switch, or chosen in a Context view still showing the old session,
  an armed quiesce-and-retry that fired after a switch, or a pin removal
  clicked as the switch's welcome arrived, acted on whichever of the open
  session's messages or pins had the same ids, since ids count from the start
  in each session's store. A fleet child's pins and settings aren't covered:
  the page knows no child's session, so those changes carry none and aren't
  checked.
- The welcome names the session whose framework is open. Before, a welcome
  sent while a switch was making the next session's framework named that next
  session beside the old session's messages.
- On a session switch the page now drops an open rollback or suppress dialog,
  its pending retry and result, the selected messages, a pending history
  page, and this process's pin and settings panels' state and forms (a
  selected fleet child's panels are kept), asks for the panels again, and
  reloads the Context view. It keeps a history page, and this process's pins
  list, settings state and Context view, only when the session stamped on it
  is the one it shows.
- The Web UI protocol is now v3. `rollback` and `suppress` require
  `sessionId`. `pin-add`, `pin-remove`, `settings-update`, `settings-reset`
  and `settings-cancel-transition` require it unless their `scope` names a
  fleet child, and with such a scope carry none. A client that leaves it out
  where it's required, or includes one on a change whose scope names a fleet
  child, is answered "unknown message shape". `history-page`, this process's
  `pins-list` and `settings-state`, and the `/debug/context` answer carry
  `sessionId`, the session whose framework produced them. A page from before
  this release shows its protocol mismatch banner.
