- A Web UI observer with the `ops` scope now gets the traces agent-framework
  already emits for gate.json's policy writes and shadowed rules, an MCPL
  server's channels, state, checkpoints and pushes, and channel tune-outs.
  A channel registered at its first push carries the label the push gives
  it, for a direct message the person's name, so that trace needs
  `messages` as well.
  The traces of inference an MCPL server asks for name the model it went
  to and, at the end, its token counts, so they need `health` as well.
  Without entries in the observers' trace table they reached full clients
  only.
