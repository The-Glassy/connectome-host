- **Operators running a resident on the built-in default recipe** (no recipe
  argument and no saved recipe, or `--no-recipe`): the default recipe now turns
  code execution on (`codeExecution: { enabled: true }`), so after the upgrade
  the agent offers agent-framework's `code_execution` tool: JavaScript scripts
  that call the agent's own tools in a QuickJS isolate, with nothing else in
  reach. The tool list gains one tool, so the first request after the restart
  misses the prompt cache from the tool block on, one full cache write.
  **Migration:** to keep such a resident without it, start it with a recipe
  file that sets `"codeExecution": { "enabled": false }` (the default recipe
  itself has no setting to change). **Unchanged:** a recipe file without
  `codeExecution` still has code execution off; the default recipe is never
  merged into one. The onboarding guide's recipe skeleton now includes the
  setting, with a section on what it does and its defaults, and recommends it
  for every resident.
