- The data directory (`DATA_DIR`, `./data` by default) is now created
  readable by its owner alone (`0700`), along with any directory above it
  that the same call creates, by whichever makes it first: a host, a
  fleet launch for a child's, an import script, or the evacuator. It holds
  the agent's history, its saved recipe and its call logs. The `sessions`
  directory in it is made the same way, and so is the Codex importer's
  instance directory, which also holds a copy of the rollout. The
  evacuator's recipe and saved state, which can hold the claude.ai
  memories, are readable and writable by their owner alone (`0600`) after
  every write, and so is the copy it opens in your editor.
  Before, these took the umask's default, commonly readable by every user
  on the machine. A directory that's already there keeps its mode: to
  make one private, `chmod 700` it. The onboarding guide's setup now makes
  the data directory with `mkdir -p -m 700`.
