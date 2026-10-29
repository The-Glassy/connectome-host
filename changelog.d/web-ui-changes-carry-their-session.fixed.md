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
- When a new session's welcome reaches the page, the page now drops an open
  rollback or suppress dialog, its pending retry and result, the selected
  messages, a pending history page, the branch list, and this process's pin
  and settings panels' state and forms (a selected fleet child's panels are
  kept), closes the open panel, asks again for the settings, pins or MCP tab
  if it's the one open, and reloads the Context view. Until that welcome
  arrives the page shows the session before it, and a branch checked out
  from its list after the switch has finished, like any command then, runs
  in the session now open. It keeps a history page, and this process's pins
  list, settings state and Context view, only when the session stamped on it
  is the one it shows.
