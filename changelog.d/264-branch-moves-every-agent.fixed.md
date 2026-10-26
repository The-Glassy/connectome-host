- `/undo`, `/redo`, `/restore`, `/checkout` and `/branchto` move the branch
  through the framework, so every agent sharing the store is re-initialized
  for the new branch, not only the first agent. Before, another agent on an
  `AutobiographicalStrategy` (a conversation fork, for one) failed every
  compile with "requires reinitialization for the current branch generation"
  until a restart (#264).
- They are refused while any agent sharing the store is mid-turn, naming it,
  the subconscious included. A move the framework refuses leaves the branch,
  the branches, the session's undo and redo history and its checkpoints as
  they were (a branch made for the move is removed), says this command moved
  nothing, and, when the store is busy, to try again once what it names has
  finished. A `/redo` whose branch no longer exists drops that step and says
  so.
