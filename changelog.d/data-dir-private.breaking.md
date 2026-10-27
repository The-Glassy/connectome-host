- **Operators who read a data directory as another user that isn't
  root,** such as a backup run as its own user: a data directory that a
  host, a fleet launch, an import script or the evacuator creates from
  this version on is readable by its owner alone (`0700`), so that reader
  can't open it. That includes the data directory of a fleet child
  whose directory doesn't exist yet when it's launched, on an install that
  was already running. To keep such a reader working, run it as the
  agent's user or as root, or make the directory yourself before the host
  does, with the mode or the group you choose: a directory that's already
  there keeps its mode. Unchanged: every data directory made before this
  version, and what a reader running as the agent's user or as root can
  read.
