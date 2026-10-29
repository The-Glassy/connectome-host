- The Web UI's rollback, suppress, pin and settings changes on this host are
  made only in the session they were chosen in. Each carries the session whose
  messages, pins or settings the operator chose it from, and the host refuses
  one chosen in a session that isn't the open one, naming both sessions and
  saying nothing changed. Before, a rollback or suppress confirmed in a dialog
  opened before a session switch, or chosen in a Context view still showing the
  old session, an armed quiesce-and-retry that fired after a switch, or a pin
  removal clicked as the switch's welcome arrived, acted on whichever of the
  open session's messages or pins had the same ids, since ids count from the
  start in each session's store. A fleet child's pins and settings aren't
  covered: the page knows no child's session, so those changes carry none and
  aren't checked.
- On a session switch the page now drops an open rollback or suppress dialog,
  its pending retry and result, the selected messages, and the pin and
  settings panels' state and forms, asks for the panels again, and reloads
  the Context view.
- The Web UI protocol is now v3. `rollback` and `suppress` require
  `sessionId`. `pin-add`, `pin-remove`, `settings-update`, `settings-reset`
  and `settings-cancel-transition` require it unless their `scope` names a
  fleet child, and then carry none. A client that sends one of these without
  it is answered "unknown message shape", and a page from before this release
  shows its protocol mismatch banner.
