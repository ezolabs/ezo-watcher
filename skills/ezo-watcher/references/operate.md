# Operate

Day two is smaller than day one: read the wall, acknowledge what you are working, and keep the Watcher's own sources honest. Everything below is CLI (`watcher …`) or MCP tools; nothing needs a browser.

## The everyday commands

```bash
watcher status                      # summary: firing by severity, parked, stale sources
watcher incidents --output json     # the incidents themselves (also md, table)
watcher doctor --live --json        # is the running server healthy and every source asserted?
```

`watcher status` and `watcher incidents` read the running server with `WATCHER_ADMIN_TOKEN`; they never start a second poller. `--output table` is for a person, `--output json` for an agent, `--output md` to paste into a ticket.

## Connect an agent over MCP

```bash
watcher mcp-config --client claude      # also: cursor, codex
```

It prints three forms: the stdio form first — `node <this install's bin/watcher.mjs> mcp --dir <project>` — which starts a small bridge in the project that reads `WATCHER_MCP_TOKEN` from `.watcher/.env` (no secret in the registration); then the HTTP form, `<baseUrl>/mcp` with `Authorization: Bearer <WATCHER_MCP_TOKEN>`, for use behind your Tunnel. The token value is never printed unless you pass `--show-secret`; a token under 32 characters is refused at every request, and a miss answers exactly like a wrong token, so a probe learns nothing.

To brief the agent at each session start, install the CLI's hook instead of writing one yourself: `watcher hooks install --target claude` writes a `SessionStart` hook that runs `watcher status --brief` (one line: firing by severity, the sources that went quiet); `--target codex` writes the same instruction into `AGENTS.md`. `watcher hooks uninstall` takes it back out.

The MCP server is stateless: every request is one JSON answer, no session, no stream. A restart loses nothing.

### The 16 tools

| Tool | Use it for |
| --- | --- |
| `watch_state` | Start here. Firing counts by severity and attention, parked count, one row per incident with its `key`, and the sources that are stale, erroring or not started on this host (`sources.skipped`) |
| `list_incidents` | Filter by `state` (`firing`, `unattended`, `acknowledged`, `silenced`, `parked`, `resolved`, `all`), `severity`, `service`, `source`, `hours` |
| `get_incident` | One incident in full: instances, evidence links, recent actions |
| `get_fix_context` | **The one read before a fix**: the incident, the source and target config (credentials as env-var names), the rule's asserts and the one that failed, `discovered`, the last good beside the last bad observation, the command that re-runs the check, evidence links, and `next` |
| `incident_history` | The incident's actions over the last `hours` — who acknowledged, silenced, parked, commented, resolved |
| `list_sources` | Every source: kind, state, last answer, error, `skipped` (`missing <ENV>`) when this host did not start it, alerts firing, rules listed, `asserted` and `discovered`. A quiet or skipped source means an all clear is not earned |
| `acknowledge` | You are actively working it. Stops unattended age and escalation |
| `unacknowledge` | Take your acknowledgement off |
| `silence` | Known-expected noise, for at most 4 hours |
| `park` | After a fix or a verdict that the source cannot show yet, for at most 72 hours, with a reason |
| `unpark` | End a park now |
| `comment` | Findings, links, a fix commit — the incident's memory |
| `recheck` | Ask the source to run its check again (a pull source polls now; a sender that declares `recheckRequests` is asked to run; any other pusher says when it next reports) |
| `verify_fix` | **The one write after a fix**: re-checks, waits up to `timeoutSec` for the source's fresh answer, and records the confirmation when every alert is resolved; still firing, it says which assertion failed |
| `resolve` | Mark resolved by hand; the Watcher reopens it if the source still reports it |
| `confirm_resolution` | Record that you checked after the source resolved it |

The fix loop in two calls: `get_fix_context { key }`, fix and redeploy, `verify_fix { key, by }`. From a terminal it is `watcher incident <key> --fix-context`, then `watcher recheck <key> --wait` (the full loop is `watcher skills fix`).

### Etiquette (what the tool descriptions enforce)

- **Read freely; write as yourself.** Every write takes `by: "agent: <who>"` and is shown on the tile, in the incident sheet and in History.
- **Acknowledge while you are actively working.** It does not fix, hide or resolve anything, and a person can take it off.
- **Comment what you found.** A one-line note is context; a comment is the record.
- **Silence only what is known-expected**, for at most 4 hours, never to quiet a real problem.
- **Park only after a fix or a verdict**, for at most 72 hours, saying why. Never to hide a live problem.
- **You cannot resolve, delete or edit an alert — only its source can.** `resolve` is a by-hand mark; `park` survives a source that cannot show the fix yet.

## The incident lifecycle

An incident is firing, then optionally acknowledged, silenced or parked, then resolved. A source resolving it closes the episode; a hand `resolve` closes it too but reopens on the next report. Repeats, escalations and quiet hours are route policy (`watcher skills channels`): a page repeats until acknowledged, an escalation step fires when nobody has it after `afterSec`, and a route marked `muteInQuietHours` sends one digest when quiet hours end.

## Triage runbook

1. `watch_state` — find the worst firing incident and its `key`.
2. `get_incident` — read instances, evidence and the last actions.
3. `acknowledge` with `by: "agent: <who>"` while you work.
4. `comment` what you found (a log line, a commit, a repro).
5. `recheck` if the source can run now; otherwise `list_sources` to see when it next reports.
6. When the fix is in, let the source resolve it and `confirm_resolution`; if the source cannot show it, `park` with the reason and the verification you need.

## Re-check

`recheck` asks a source to run its check now. It works only for a source that declares `recheckRequests` with `pickupWithinSec` (30 to 3600): the sender reads `GET /ingest/<id>/recheck-requests` and answers `POST /ingest/<id>/recheck-requests/<request id>`. For a source that cannot be asked, the tool says when it next reports instead of pretending.

## Keeping the Watcher itself alive

The Watcher is the thing that pages when something is down, so it must not be the single silent point of failure:

- Run it under `watcher service install` (or a container with `restart: unless-stopped`), not a terminal.
- `watcher doctor --live --json` checks the running server, every source's assertion and the channel (`channel.missing`, a warn, when there is none).
- Do not point a source at the Watcher's own `/healthz` — `source.self-probe` rejects it. If the Watcher's own death must page, watch it from **another** machine: a second Watcher, or the user's existing uptime service, on the public `baseUrl` + `/healthz`.
- `.watcher/data/` holds the sqlite database and the log; it keeps 30 days of history. Back it up if the history matters; the config itself is in git.

## When a source goes quiet

`list_sources` says `ok`, `error`, `stale` or `idle`. A `stale` push source means it stopped sending (its `staleAfterSec` expired) — an incident already exists for it. An `error` source means the Watcher's own poll failed: its credential expired, the URL moved, or the upstream is down. Both are findings to report, not noise to silence: the wall is only as good as the sources still talking to it. A configured optional source this host did not start reads `idle` with `skipped` (`missing <ENV>`): it watches nothing until that value is set, raises no stale alert, and is named in `watch_state`'s `sources.skipped` — a third finding, not an all clear.
