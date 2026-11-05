# Telemetry

The CLI and the server send anonymous usage events (the verb run with flag names only, its exit code and duration, doctor
check codes, internal error types with package-relative stack frames, a daily server heartbeat of counts) to
`https://telemetry.ezolabs.io`. Never paths, hosts, URLs, ids, config or env values, incident text or error messages. The
full list, a real payload and the collector's source: `docs/telemetry.md` in the package.

```bash
watcher telemetry status      # on or off, and why
watcher telemetry disable     # the user's choice, stored in ~/.config/ezo-watcher/telemetry.json
watcher telemetry enable
```

`DO_NOT_TRACK=1` or `WATCHER_TELEMETRY_DISABLED=1` in the environment turns it off whatever is stored; it is already off
under a test runner. `WATCHER_TELEMETRY_DEBUG=1` prints each payload to stderr and sends nothing.

For an agent:

- The first run prints a one-time notice on **stderr**; it is not an error and never touches stdout, so `--json` output and
  the MCP stdio stream are unaffected. Mention it to the user once if they have not seen it; do not suppress it for them.
- Turning telemetry off is the user's decision. Run `watcher telemetry disable` only when the user asks; in CI or a
  container they own, suggest `DO_NOT_TRACK=1` in that environment.
- A failed send is silent and never changes an exit code: telemetry is never the cause of a failing verb.
