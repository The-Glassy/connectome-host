- `/auth status`, and the credential state the Web UI and `GET /credential`
  read, now show the credential's own expiry after a refresh the host made
  by itself, where they kept the expiry from when the state was entered.
  Whether the host can refresh the credential now follows a pasted token
  too.
