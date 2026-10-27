- The data directory (`DATA_DIR`, `./data` by default) is now created
  readable by its owner alone (`0700`), along with any directory above it
  that the same call creates, by whichever makes it first: a host, a
  fleet launch for a child's, an import script, or the evacuator. It holds
  the agent's history, its saved recipe and its call logs. The Codex
  importer makes its instance directory, which also holds a copy of the
  rollout, the same way. The evacuator creates the recipe it writes, whose
  system prompt can hold the claude.ai memories, readable and writable by
  its owner alone (`0600`), and any directory it makes for it `0700`.
  Before, these took the umask's default, commonly readable by every user
  on the machine. A directory or recipe file that's already there keeps
  its mode: to make one private, `chmod 700` the directory or `chmod 600`
  the file. The onboarding guide's setup now makes the data directory
  with `mkdir -p -m 700`.
