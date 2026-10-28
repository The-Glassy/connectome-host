- **Readline mode (`--no-tui` with stdin on a terminal):** from the prompt's
  first appearance until the host has stopped, what the process writes
  through `process.stderr.write`, `console.error` and `console.warn` goes to
  `data/readline-error.log` rather than into the conversation, where a
  library's diagnostic could land in the middle of the agent's reply.
  `[routeSpeech]`, `[routing]` and `[inference-failed]` lines go there too,
  so an operator who watched or redirected readline mode's stderr for them
  reads the log instead. What the person at the terminal needs still prints
  there, on stderr as before, each on a line of its own, with the prompt
  drawn again below it, keeping what was typed, if it was waiting: a turn's
  failure and how it ended, a slash command's failure, an update notice,
  the log's path at start, the credential state at start when it isn't ok,
  and ops alerts, worded as the TUI words them, which readline mode didn't
  show before. A crash still prints on the terminal. In readline mode,
  `/bug` now reads the log's current session, as it reads `tui-error.log` in
  the TUI. If the log can't be written, the host says so, and the lines it
  would have taken print on the terminal as before. Batch mode (stdin not a
  terminal) is unchanged, and a library's `console.log` lines still print in
  the conversation.
