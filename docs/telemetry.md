# Telemetry

The `watcher` CLI and the Watcher server send anonymous usage events to EZO Labs, so we can see which doctor checks fail
most, which commands exit non-zero, and which internal errors a release brings, and fix those first. It is on by
default after a one-time notice, it carries no value from your project, and one command turns it off.

## Turn it off (or on)

```bash
watcher telemetry status      # on or off, why, the anonymous id, the config file
watcher telemetry disable     # stored in the config file; nothing is sent from then on
watcher telemetry enable
```

Or set either variable in the environment (your shell profile, CI, a container, or the project's `.watcher/.env`):

```bash
export DO_NOT_TRACK=1                # the cross-tool convention
export WATCHER_TELEMETRY_DISABLED=1  # this tool only
```

Who decides, first match wins:

| | state |
|---|---|
| `DO_NOT_TRACK` set (any value but `0`, `false`, `no`, `off`, empty) | off |
| `WATCHER_TELEMETRY_DISABLED` set (same rule) | off |
| a test runner (`VITEST`, `NODE_ENV=test`, `JEST_WORKER_ID`) | off |
| the config file says `"enabled": false` (`watcher telemetry disable`) | off |
| the config file exists but does not parse | off (left as it is until `watcher telemetry enable` or `disable` rewrites it) |
| otherwise | on |

An environment variable can only turn telemetry off: `watcher telemetry enable` while `DO_NOT_TRACK` is set stores the
choice and says the variable still wins. `watcher telemetry` itself never sends anything.

In Docker, pass `-e DO_NOT_TRACK=1` (or mount a config dir); a container that starts fresh each time gets a fresh id and
logs the notice once per start.

## The notice

The first run that would send prints this once, on stderr (the server writes it to its log instead), and records in the
config file that it was shown:

```text
EZO Watcher collects anonymous telemetry to find failures and improve the tool: the command run (flag names only),
its exit code and duration, doctor check codes, internal error types with package stack frames, and a daily server
heartbeat of counts. Never paths, hostnames, URLs, config or env values, incident text or error messages.
Opt out: `watcher telemetry disable`, or DO_NOT_TRACK=1. Details: https://github.com/ezolabs/ezo-watcher/blob/main/docs/telemetry.md
```

If the config file cannot be written (a read-only home), nothing is sent: there would be no record that you were told.

## What is sent

One JSON batch per CLI run, posted when the run ends, and from a running server one heartbeat a day plus an event when an
internal error happens. Every batch carries:

| field | example | what it is |
|---|---|---|
| `id` | `00000000-0000-4000-8000-0000000000a1` | a random v4 UUID made on first run; derived from nothing (not the machine, the user or the project) |
| `version` | `0.1.0` | the ezo-watcher version |
| `node`, `os`, `arch` | `24.11.0`, `linux`, `x64` | the runtime |
| `ci` | `false` | whether a CI variable (`CI`, `GITHUB_ACTIONS`, …) was set |
| `install` | `npm` | `npm`, `checkout` (a git clone), `docker`, or `unknown` |

and one or more of four events:

| event | fields |
|---|---|
| `cli.command` | `command` (the verb, or `unknown`: never the word you typed), `sub` (`service install`), `flags` (names the verb declares, never values), `exitCode`, `durationMs`, `errorCode` (our own code, e.g. `usage.unknown-flag`) |
| `doctor.result` | `ok`, `live`, `target`, `checks` (how many ran), `failing` and `warning` (check codes such as `source.error`, never their messages) |
| `error` | `where` (`cli`/`server`), `command`, `errorName` (`TypeError`), `code` (`ENOENT`, `ERR_INVALID_ARG_TYPE`, or ours), `frames` (stack frames inside this package as `src/cli/project.ts:70:27`; frames anywhere else are dropped) |
| `server.heartbeat` | `uptime` bucket (`<1h`, `1-24h`, `1-7d`, `>7d`), sources and channels counted by kind, firing incidents counted by severity, `mcp` (whether the MCP endpoint is on) |

A real batch, from `watcher doctor` in an empty directory (printed with `WATCHER_TELEMETRY_DEBUG=1`; the id replaced):

```json
{"schema":1,"context":{"id":"00000000-0000-4000-8000-0000000000a1","version":"0.1.0","node":"26.13.0","os":"darwin","arch":"arm64","ci":false,"install":"checkout"},"events":[{"name":"cli.command","at":"2026-11-05T10:44:23.343Z","command":"doctor","sub":null,"flags":["dir","output"],"exitCode":1,"durationMs":2,"errorCode":null},{"name":"doctor.result","at":"2026-11-05T10:44:23.345Z","ok":false,"live":false,"target":"local","checks":2,"failing":["watcher.dir"],"warning":[]}]}
```

An internal error and a heartbeat, as they travel:

```json
{"name":"error","at":"2026-11-05T10:44:23.345Z","where":"cli","command":"status","errorName":"TypeError","code":null,"frames":["src/cli/project.ts:70:27"]}
{"name":"server.heartbeat","at":"2026-11-05T10:44:23.345Z","uptime":"1-7d","sources":{"http-probe":2,"self":1,"sentry":1},"channels":{"ntfy":1},"incidents":{"page":0,"warning":1,"info":0},"mcp":true}
```

To see exactly what your own runs send, set `WATCHER_TELEMETRY_DEBUG=1`: each payload is printed to stderr, prefixed
`[telemetry]`, and **not sent**. It works with telemetry off too, so you can read the payload before deciding.

## What is never sent

- file paths, project names, directory names
- hostnames, URLs, IP addresses, ports
- source, channel and incident ids, names, titles or messages
- config values, environment variables or their values, secrets
- error messages and stack frames outside this package (yours, Node's, dependencies')
- the arguments you typed: an unknown verb is recorded as `unknown`, a flag's value is never read

This is enforced in code, not by convention. [src/shared/telemetry-schema.ts](../src/shared/telemetry-schema.ts) is the
whole wire format: every string field has a pattern a path, a URL, a hostname or free text cannot satisfy (codes must
start with one of our own prefixes, kinds must be ones the config knows, frames must be package-relative). A value that
does not fit is sent as `other`. The collector checks every batch with the same `parseBatch` function and stores only
the fields it names, so a field the schema does not list never reaches storage. A test feeds the builders hundreds of
seeded runs full of paths, URLs, hosts, IPs and tokens and checks none of them reaches a payload
(`test/telemetry-schema.test.ts`).

## How it behaves

- **Never in the way.** The CLI posts once, after the command has finished and printed, with a 1.5 s timeout; a failed or
  slow send is dropped. A send that gets no answer at all (offline, or a firewall that drops the packets) pauses sending
  for an hour, so such a machine does not wait out the timeout on every command; debug mode says when sends are paused.
  Telemetry never changes a command's exit code, and the CLI never
  writes it to stdout: the notice and debug lines go to stderr, so `--json` output and the MCP stdio stream stay clean.
- **The server** sends one heartbeat a day per machine (the day is tracked in the config file, so restarts do not add
  more), and an `error` event when its tick fails, once per distinct error per process. An uncaught exception is written
  to the config file as it happens and sent by the next run.
- **The config file** is `$XDG_CONFIG_HOME/ezo-watcher/telemetry.json` (default `~/.config/ezo-watcher/telemetry.json`),
  mode 0600. It holds the id, your choice, when the notice was shown, the last heartbeat time, the end of a send pause
  and at most five pending crash events. Delete it to get a new id (and the notice again).

## Where it goes

Batches are posted to `https://telemetry.ezolabs.io/v1/events`, a Cloudflare Worker whose whole source is in
[deploy/telemetry/](../deploy/telemetry/): `src/index.ts` (the handler), `schema.sql` (the one table) and
`wrangler.jsonc`. It stores one row per event with the fields above, plus the two-letter country Cloudflare derives from
the connection. It does not store your IP address, request headers or user agent, and the Worker's own request logs
(Workers Logs) are off. Cloudflare, as the network in front of the Worker, handles the connection like any HTTPS host.

Rows are kept for 400 days; a daily scheduled run deletes older ones. The data is read by the EZO Labs maintainers to
decide what to fix, and is not sold or shared. Questions or a deletion request for an id: open an issue on the repository.

## For maintainers

Deploy (finds or creates the D1 database `ezo-watcher-telemetry`, applies `schema.sql`, deploys the Worker to the custom
domain; the database id is looked up at deploy time, never committed):

```bash
CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_EMAIL=… CLOUDFLARE_API_KEY=… node deploy/telemetry/deploy.mjs
node deploy/telemetry/deploy.mjs --dry-run   # bundle only
```

Read it (same env; `--json` for rows as JSON):

```bash
node deploy/telemetry/query.mjs doctor 30    # top failing doctor codes by version, last 30 days
node deploy/telemetry/query.mjs errors       # internal error types, code and top frame, by version
node deploy/telemetry/query.mjs commands     # verbs by exit code and error code
node deploy/telemetry/query.mjs installs     # distinct installs by version, os, install method
node deploy/telemetry/query.mjs recent 20
node deploy/telemetry/query.mjs sql "SELECT name, COUNT(*) FROM events GROUP BY name"
```

The `doctor` query, for reference:

```sql
SELECT e.version, j.value AS code, COUNT(*) AS failures, COUNT(DISTINCT e.install_id) AS installs
FROM events e, json_each(e.props, '$.failing') j
WHERE e.name = 'doctor.result' AND e.received_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-30 days')
GROUP BY e.version, j.value ORDER BY failures DESC LIMIT 30;
```

A new event or field is a change to `telemetry-schema.ts` (bump `TELEMETRY_SCHEMA` for a breaking one), this page, and a
redeploy of the collector before the client release that sends it: the collector drops an event it does not know.
