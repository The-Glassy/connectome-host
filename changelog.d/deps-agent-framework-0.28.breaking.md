- **Operators, from agent-framework 0.28.0 (see its notes):** workspace mounts'
  `ignore` and `include` patterns now read the gitignore grammar only, and a
  pattern of any other form stops the workspace from being built, naming the
  mount and the pattern; on a disk that tells names apart, a name that differs
  from a nested mount's directory only in case is now read as that mount's; and
  a server with `toolHints: true` gets the reminder of its open toolsets at an
  agent's next start only when it's granted `pushEvents`.
