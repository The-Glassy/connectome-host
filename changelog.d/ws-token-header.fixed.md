- A WebSocket MCPL server's credentials no longer reach the host's logs or
  status lines: `token`, `access_token` and `key` query values,
  `Authorization` headers and a url's user and password are masked as `***`
  in the per-server `mcpl-stderr` logs (connect and reconnect errors name the
  url they dialed, query included), on stderr (`console.error` and
  `console.warn` included) and in the TUI's and headless mode's log files,
  and in the server targets `mcpl_list` and the Web UI's MCP tab show.
