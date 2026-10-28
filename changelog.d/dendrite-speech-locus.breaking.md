- **Operators whose residents rely on where plain prose lands when nothing
  names a destination:** with the agent-framework release that carries
  agent-framework#546, such prose follows `speech.locus: 'delivery'`, the framework's new
  default. It lands in the channel of the delivery that woke the turn, a
  conversation fork's home channel, or a channel the agent opened this turn.
  A turn with none of these keeps its prose private, and a `[routing]`
  notice tells the agent so when it was last told its speech lands in a
  channel. Before, the most recent delivered inbound message was a fallback
  for every turn, so a turn a timer or a host's own request opened spoke
  where the last message came from, and an addressed message from another
  channel arriving mid-turn moved where the rest of the turn's prose went.
  Now incoming traffic never moves it, and a `[routing]` notice names who
  wrote from where. **Migration:** a recipe that wants the previous rule
  sets `"speech": { "locus": "latest-inbound" }`; a resident that relied on
  the fallback reaches someone with an explicit send. **Unchanged:** a turn
  a channel message wakes still speaks in that channel, and an explicit
  send reaches the channel it names.
