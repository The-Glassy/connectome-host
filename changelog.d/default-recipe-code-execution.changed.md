- **Code execution is on in the built-in default recipe, and the onboarding guide
  recommends it for every resident.** `DEFAULT_RECIPE` now carries
  `codeExecution: { enabled: true }`, so `bun src/index.ts` with no recipe offers
  agent-framework's `code_execution` tool (JavaScript scripts that call the agent's
  own tools in a QuickJS isolate; one more tool in the list). A recipe file is
  unchanged by this: one without `codeExecution` still has it off. The guide's recipe
  skeleton includes the setting, with a section on what it does and its defaults.
