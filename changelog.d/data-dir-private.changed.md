- The data directory (`DATA_DIR`, `./data` by default) is now created
  readable by its owner alone (`0700`), along with any directory above it
  that the same call creates, by whichever makes it first: a host, a
  fleet launch for a child's, an import script, or the evacuator. It holds
  the agent's history, its saved recipe and its call logs. The Codex
  importer makes its instance directory, which also holds a copy of the
  rollout, the same way. Before, these took the umask's default, commonly
  readable by every user on the machine. A directory that's already there
  keeps its mode: to make one private, `chmod 700` it. The onboarding
  guide's setup now makes the data directory with `mkdir -m 700`. A
  process run as another user that reads it, such as a backup, can't read
  a newly created one unless it runs as root.
