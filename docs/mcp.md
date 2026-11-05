# The Watcher MCP server

Every EZO Watcher (Watch below) serves a Model Context Protocol endpoint at `/mcp` on its own origin. An agent
that speaks MCP can read the wall, find the incident that is on fire, and act on it (acknowledge it, silence it, park
it, comment on it, mark it resolved, ask the sources to check again) with no browser and one bearer token. The server
lives in `src/server/mcp/` and is built on `@modelcontextprotocol/sdk` 1.32.1, over Streamable HTTP (MCP spec
2025-11-25). The behaviour below is what the code does; the decisions behind it (who a write is attributed to, and
what an agent may not do) are in [design.md](design.md), Comments and agent writes.

## Reach and auth

- The endpoint is the wall's own origin plus `/mcp`: `http://127.0.0.1:7717/mcp` on the default bind
  (`WATCHER_HOST` 127.0.0.1, `WATCHER_PORT` 7717). The config's `baseUrl` is the public URL the server uses in links,
  not a second listener.
- Every request needs `Authorization: Bearer <WATCHER_MCP_TOKEN>`. A request with no header, with another token, or
  any request while the host has no token (or one under 32 characters) is a `401` with
  `WWW-Authenticate: Bearer realm="ezo-watcher-mcp"`. The check runs before the method, the body or the SDK is
  looked at, so a probe learns nothing from the difference between "no token configured" and "wrong token"
  (`src/server/mcp/auth.ts`).
- `WATCHER_MCP_TOKEN` is read from the process environment. 32 characters is the floor and `openssl rand -hex 32`
  makes 64; a shorter token is refused exactly like no token. `watcher init` writes one to `.watcher/.env` (mode
  0600, gitignored). The token is compared as a SHA-256 digest in constant time and is never logged, echoed or put
  into an error.
- Stateless and JSON: one `POST` in, one JSON-RPC body out. There is no session id and no server-to-client stream, so
  `GET` and `DELETE` answer `405` with `Allow: POST`. A request body over 64 KiB is refused before it is parsed, and
  one answer is cut at 100,000 characters with a final line that says it was cut, so a long incident cannot fill an
  agent's context.
- The token is the gate on `/mcp`. The rest of `/api` is same-origin and needs none, so bind the server where only
  the people and agents you mean to serve can reach it, and put TLS and a firewall in front if that is beyond this
  machine.

## Connecting a client

The package ships the `watcher` CLI (the `watcher` and `ezo-watcher` bin entries). It prints the exact way to add
this server for the client you name:

```
watcher mcp-config --client claude     # Claude Code
watcher mcp-config --client cursor     # Cursor
watcher mcp-config --client codex      # Codex
```

The command reads the config at `WATCHER_CONFIG` (default `.watcher/config.json`) and prints two forms: the stdio
bridge first (an add command for Claude Code, or the JSON or TOML block the client's MCP settings take, running
this CLI's own `bin/watcher.mjs mcp --dir <abs project path>`), and the HTTP endpoint second (`<baseUrl>/mcp`, for a Watcher
behind a Cloudflare Tunnel — the self-hosted remote MCP). The stdio form needs no token in the client's config: the
bridge reads `WATCHER_MCP_TOKEN` from `.watcher/.env`. A browser request to `/mcp` must carry the Watcher's own `Origin` (or a configured `embedOrigins` entry); one from another site is a 403, the MCP Streamable HTTP defence against DNS rebinding (spec 2025-06-18, Transports → Security Warning). A request with no `Origin` — a CLI or an agent — is unaffected. The HTTP form prints a reference to `WATCHER_MCP_TOKEN`, never
the token itself; `--show-secret` prints the value from `.watcher/.env` as well, for a client that cannot read the
environment. The JSON answer carries the stdio form under `stdio` and both forms, with their kind, under `forms`.

Codex's form is a `[mcp_servers.<name>]` table in `~/.codex/config.toml` (or a trusted project's
`.codex/config.toml`), with `url` and `bearer_token_env_var` among its keys; the shape this CLI prints was checked
against [developers.openai.com/codex/mcp](https://developers.openai.com/codex/mcp) on 2026-11-04.

Reload the client and the server appears under the Watcher's own name: `ezo-watcher` with the default brand, the
brand's name as a lower-case slug otherwise (`Infra Wall` configures as `infra-wall`).

Every client's settings can also be written by hand. The entry is an HTTP (Streamable HTTP) MCP server whose URL is
`<baseUrl>/mcp`, with the header `Authorization: Bearer <token>`. A client that expands the environment can keep the
reference; one that takes a static header needs the value in its config file.

### The stdio bridge

`watcher mcp [--dir <project>]` is an MCP server over stdio (`StdioServerTransport` from
`@modelcontextprotocol/sdk`). It exposes the same sixteen tools, with the same names, descriptions and input schemas,
as the HTTP `/mcp`: it registers the tool list from `src/server/mcp/tools.ts` and forwards each `tools/call` to the
project's running Watcher at `http://127.0.0.1:<port>/mcp` with `WATCHER_MCP_TOKEN` from `.watcher/.env`. State stays
single-writer: the bridge is a client of the wall, never a second engine.

If the Watcher is not running, the bridge still answers `initialize` and `tools/list` (the tool list is local), and
every `tools/call` answers with a clear error naming `watcher run --detach`. It never starts a second engine.

To prove the endpoint without a client:

```
curl -sS -X POST http://127.0.0.1:7717/mcp \
  -H "Authorization: Bearer $WATCHER_MCP_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Without the header the same call answers `401`. With the token it answers every tool with its title, description,
input schema and annotations.

Rotating the token is an environment change and a restart. Clients that reference `WATCHER_MCP_TOKEN` pick the new
value up; clients that hold a literal header must be given the new one (`watcher mcp-config` again).

## Tools

Six tools read, ten write. Every tool that writes takes `by`: who is doing it, as `agent: <who>` (`agent: ` is
added when left off, and the whole name is at most 64 characters). It is stored with the write and read back on the
tile ("Acknowledged by agent: claude"), in the incident sheet, in History and in `get_incident`. A write without it
is refused, and an agent's name can never read as a person's.

`get_fix_context` is the one read to start with when you are about to fix something rather than triage it: it gathers
the incident, its source and target config, the assertions that failed, the last good and last bad observation, and a
command that re-runs the check. `verify_fix` closes the loop: it re-checks, waits for the fresh observation, and
records the confirmation when the source has resolved the incident. The pair is the fix loop described under
["The fix loop"](#the-fix-loop).

| Tool | Does | Input | Hints (readOnly / destructive / idempotent / openWorld) |
| --- | --- | --- | --- |
| `watch_state` | the wall in one answer: counts (firing, unattended, acknowledged, silenced, parked, by severity), every incident as one row, and the sources that are stale, erroring or not started on this host (`sources.skipped`, with the reason). Start here | none | true / false / true / false |
| `list_incidents` | incidents, filtered. `state` firing (default: live, parked left out), unattended, acknowledged, silenced, parked, resolved (episodes that ended in `hours`), all (parked included); `severity`; `service` (substring); `source` (the system that raised it) | `state`, `severity`, `service`, `source`, `hours` (1 to 720, 24), `limit` (1 to 200, 50) | true / false / true / false |
| `get_incident` | one incident, whole: alerts with labels, annotations and evidence links, who acknowledged, silenced and parked it, how it ended, history with who, every comment, the pager's last sends. Raw payloads are left out | `key` | true / false / true / false |
| `get_fix_context` | the fix brief: incident (summary, severity, first and last seen, state), the source and target config (credentials as env-var NAMES, never values), `RuleCell.asserts` and which failed, `discovered.foundAt`/`read`, the last good beside the last bad observation (bodies cut), a `reproduce` block (the exact curl/nc/command), related open incidents on the service, evidence links (Sentry permalink and culprit, Netdata chart, Grafana links), and `next` (fix → restart/deploy → verify_fix) | `key` | true / false / true / false |
| `incident_history` | episodes that resolved in a range, and the acknowledgements, silences, parks, unparks, reopens, manual resolves and confirmations made in it (`actions`), with who. Watch keeps 30 days | `from`, `to` (ISO 8601), or `hours` back from now (24); `service`; `limit` (100) | true / false / true / false |
| `list_sources` | every source: kind, state (ok, error, stale, idle), last answer, the error, why this host did not start it (`skipped`: `missing <ENV>`; absent on a source that runs), how many alerts it reports firing, how many rules it lists, how many of its cells assert more than a 200 (`asserted`) and where its endpoint was found (`discovered`) | none | true / false / true / false |
| `acknowledge` | "I am working this": the tile reads acknowledged by `by`, its age stops counting as unattended, and the pager stops escalating it. It hides and resolves nothing | `key`, `by`, `note?` (500) | false / false / true / false |
| `unacknowledge` | takes the acknowledgement (and any silence) off, so the incident counts as unattended again and the pager resumes | `key`, `by`, `note?` (500) | false / true / true / false |
| `silence` | pauses the pager for one incident, for at most 240 minutes (4 hours; more is refused, not shortened). A silence hides a problem from the people who would act on it, so say why | `key`, `minutes` (1 to 240), `by`, `reason` (required, 500) | false / true / false / false |
| `park` | takes a firing incident, from any source, off the live wall into Parked once it is fixed or judged. At most 72 hours; more is refused, not shortened. A second park replaces the first, and the answer says so (`replaced`) | `key`, `state` (fixed_undeployed, awaiting_source, deferred), `until` (ISO 8601 with a zone, after now, at most 72 h ahead), `by`, `note` (required, 500), `ref?` (a ticket, PR or commit, 64) | false / true / false / false |
| `unpark` | ends a park set by hand now: the incident is back in its severity tier, unattended and paging as a new problem would, its clock starting at this moment. Refused for an incident that is not firing, one not parked by hand, and one whose park already ended | `key`, `by`, `note?` (500) | false / true / true / false |
| `comment` | a comment on an incident, firing or resolved: markdown, at most 4000 characters (longer is refused, not cut). It shows in the incident sheet with the author and the time, and is counted on the tile | `key`, `by`, `text` (4000) | false / false / false / false |
| `recheck` | asks the sources again instead of waiting for the next poll: one incident's alerts, one alert, or every pull source. At most one poll per source every 10 seconds; a repeat inside that is answered from the last poll. A pushing sender that takes requests is asked to re-run its check (below) | `by`, `incident?`, `alert?` | false / false / true / true |
| `verify_fix` | re-checks an incident's firing alerts, waits up to `timeoutSec` for the source's fresh answer, and answers `{ resolved, observation, asserts }`. When every alert is resolved by its source it records the confirmation (the `confirm_resolution` path) with the note "verified by agent", so History reads "resolution confirmed by <you>" and the incident closes attributed. Still firing: it resolves nothing and says which assertion failed and why. Never resolves an alert itself | `key`, `by`, `timeoutSec` (5 to 300, default 60) | false / false / true / true |
| `resolve` | marks an incident resolved by hand, with a required reason, for a fix the source cannot show yet. It reopens as a new firing if the source still reports the alert (below); `park` is the tool when it cannot show the fix at all | `key`, `by`, `reason` (500) | false / true / false / false |
| `confirm_resolution` | records "resolution confirmed by X" on an incident a source has already resolved, with an optional note (the fix commit, a PR, a link). It changes no state | `key`, `by`, `note?` (500) | false / false / false / false |

Hints are the MCP `ToolAnnotations`. Destructive is true only for what removes or suppresses something another person
or the source set (`silence`, `park`, `unacknowledge`, `unpark`, `resolve`); it is false for what only adds a record
(`acknowledge`, `comment`, `confirm_resolution`, `verify_fix`). `recheck` and `verify_fix` are the tools that talk to
the outside (the sources), and `verify_fix` writes only the confirmation event when the source's own answer is green. Every call answers one JSON value as text: the reads answer the
shapes below, a write answers `{"ok": true, ...}` with what it changed, and a refusal is one sentence with
`isError: true` and no state change.

### The key every write takes

`key` is an incident key exactly as `watch_state` or `list_incidents` print it: `<service>|<rule>`, or
`<service>|<rule>|<instance>` for a rule the config splits per instance. It is not an alert key. An alert key is
`<origin>:<8 hex>` (for example `grafana:1a2b3c4d`), and only `recheck` takes one, in its `alert` field. A tool that
is given a key the Watcher has never held refuses with a sentence pointing at `watch_state` or `list_incidents` for
the keys that do exist, never a guess.

### What the reads answer

- `watch_state`: `generatedAt`, one `text` line, `counts` (`firing`, `unattended`, `acknowledged`, `silenced`,
  `parked`, `page`, `warning`, `info`), `header`, `incidents` (one row each: key, title, summary, service, severity,
  attention, `ackedBy` and `ackedAt`, `silencedUntil` and `silencedBy`, `silenceCarried`, the `parked*` fields,
  `startsAt`, `ageSec`, `unattendedSec`, `instances`, `origins`, `hosts`, `comments`, `url`) and `sources` (`total`,
  `ok`, the `needAttention` rows, and `skipped`: one `{id, reason}` per configured source this host did not start, so
  `text` never says "Every source is answering" while one is skipped).
- `list_incidents`: `state`, `firing` (rows), `firingMatching`, `resolved` (history rows), `resolvedMatching`.
- `get_incident`: `key`, `state` (`firing` or `resolved`), `url`, `incident` (the row above), `acknowledgement`,
  `silence`, `park`, `resolution`, `evidence`, `alerts`, `history` (one sentence per event), `comments`, and
  `notifications` (the pager's last ten sends).
- `get_fix_context`: `key`, `title`, `summary`, `service`, `rule`, `severity`, `state`, `firstSeen`, `lastSeen`,
  `startsAt`, `ageSec`, `url`, `alerts`, `sources` (id, kind, state, last answer, config, the target this alert names,
  `discovered`), `asserts` (one block per alert: `cell`, `state`, `asserts`, `failed`, `failureDetail`),
  `observations` (`lastGood` with a cut body and a few headers, `lastBad`), `reproduce` (`command`, `expect`,
  `alternatives`, `watcher`, `note`), `related`, `evidence`, `sourceEvidence` (Sentry's permalink and culprit,
  Netdata's chart), and `next`. It carries no credential value: a config's `tokenEnv` or `secretEnv` is a name, and a
  literal secret field is dropped before the brief is built.
- `incident_history`: `from`, `to`, `resolved`, `resolvedMatching`, `actions`, `actionsMatching`.
- `list_sources`: `sources`, one row per source with `id`, `kind`, `state`, `lastOk`, `lastAttempt`, `error`,
  `skipped` (`missing <ENV>`: the source is configured but this host did not start it; absent on a source that runs),
  `firing`, `rules`, `misses`, `asserted` (how many of its cells assert more than that something answered) and
  `discovered` (`foundAt`, `read`, `at`: where its endpoint was found), and, for a pushing source that promised a
  schedule, `staleAfterSec`.

## Writing well

- Acknowledge an incident while you are actively working it, not to make it quiet. It is not a fix and a person can
  take it off.
- Comment your findings, links and fix commits. The optional `note` on a write is one line of context; a paragraph
  belongs in a comment.
- Silence only what is known to be expected right now (a deploy, a drill, a reboot), for the shortest time that
  covers it, and never to quiet a real problem. An agent may silence for at most 4 hours. If you are working the
  incident, acknowledge it instead.
- Park only after you fixed the incident or reached a verdict on it, and never to hide a live problem you have not
  looked at. Park for the shortest time that covers the fix; the refusal for a longer one names the latest time
  that is taken.
- You cannot resolve, delete or edit an alert itself: only its source does. `resolve` marks the incident resolved by
  hand and the engine reopens it the moment a source still reports it; `park` is the tool for a fix the source
  cannot show yet, and it never reopens. After a source resolves an incident, `confirm_resolution` records that you
  checked.
- Precedence is fixed: silenced, then acknowledged, then parked, then none. A park is recorded even while an
  acknowledge or silence outranks it, and the `park` answer carries a `warning` saying when that is the case.

## Parked incidents

An incident that is fixed or judged and not due back yet is `parked`. Its row carries `attention: "parked"` and the
`parkedState` (`deferred`, `fixed_undeployed` or `awaiting_source`), `parkedUntil` (ISO, when the park ends; at most
72 hours out), `parkedSince`, `parkedRef`, `parkedNote` and `parkedBy` (who parked it by hand; null for a park a
sender states). All are null on an incident that is not parked. `unattendedSec` is 0 while it is parked, and after
the park ends it counts from `parkedUntil`.

- `watch_state` counts it in `counts.parked` and in no other count (`firing`, `unattended`, `page`, `warning`,
  `info` are the live incidents); its row is still in `incidents`.
- `list_incidents` with `state: firing` leaves parked incidents out; `unattended` never includes one, `parked` keeps
  only them, and `all` keeps every incident.
- `get_incident` has a `park` block (the same fields, `by` included for a hand park) beside `silence`, its `history`
  has the park and unpark rows, and `incident_history` lists them in `actions`.
- Nothing is sent for a parked incident, and it is in no firing count: the summary's `firing` and `unattended`
  numbers, the severity counts and the tab badge all leave it out, and `counts.parked` is its only count there.

A park comes from one of two places:

- **A sender's annotations.** A push source can state a park on the alerts it sends: `parked_state` (`deferred` or
  `fixed_undeployed`), `parked_until` (ISO 8601 with a zone), `parked_since`, `parked_ref`, `parked_note`. The
  annotations are never part of an alert's key or its incident's key. A `parked_until` more than 72 hours out is not
  honoured and the incident reads unattended. `awaiting_source` is not an annotation state.
- **By hand.** The `park` and `unpark` tools, or the wall's API (below). Use it for any source, Grafana included,
  after a fix or a verdict. Before it, an agent could only `resolve`, which reopens as a new paging firing while
  the source still holds the alert open.

A park by hand follows these rules:

- **It covers only the alerts that were firing when it was set.** Their keys are stored with it (`park.alertKeys` in
  `get_incident`, `covers` in the `park` answer), and an alert that joins later (another host or instance, a rule
  that began after the park) ends the park and pages as a new problem.
- **It ends** when the episode resolves at the source; when an alert that is not covered joins the incident (the
  park's end is written as that moment, so the incident is back in its severity tier, unattended, with its clock
  from the join; a covered alert that resolves and fires again keeps the park); when `until` passes (back in its
  tier, unattended, the clock and the pager's group wait and escalation counting from `until`); on `unpark` (the
  park's end is rewritten to the moment of the unpark); or on a manual `resolve` (the park is removed, and if the
  source still reports the alert the reopen is a new firing with no park). A re-fire is a new episode with no park.
- **A park by hand outranks a sender's annotations** while it holds; after it ends, an annotation park that still
  holds can take over. An acknowledge or a silence still wins over both: the park is recorded and shows once those
  come off.
- **History** reads "Parked by agent: claude until Oct 17, 04:00 UTC (fix live, awaiting source, SB-4412). Note:
  `<why>`", "Unparked by agent: claude. Note: `<why>`", and, when a new alert ends the park, "Park by agent: claude
  ended. A new alert joined the incident (DiskFull on node-5)". This server tells the time in UTC because the
  sentence is shared by every reader's zone; the wall's sheet renders the same sentence in the viewer's zone.

Park or resolve? `resolve` is for a fix the source will show soon; if it does not, the incident reopens as a new
paging firing. `park` is for a fix or a verdict the source cannot show yet (a Grafana evaluation window, a push
source that repeats every few hours, a fix merged and not live): up to 72 hours, it never reopens, it shows who
parked it and why, and it comes back unattended at `until`. `silence` is for something expected right now (4 hours),
and `acknowledge` is for while you work.

## Manual resolve, reopen, confirmation

- `resolve` sets every firing alert of the incident resolved now. Each alert's event and the incident's own event
  carry `manual: true`, `by` and `reason`, so History, the sheet and the API tell it from a source's resolve. The
  incident's acknowledgement and silence end with it. The sources' presence rows are kept: they are how Watch knows
  the source never said the alert cleared.
- The next poll or push that still lists such an alert reopens it: a new firing, unacknowledged, with the
  incident's notification log cleared so the pager pages it again, and a `reopened` event ("reopened: source still
  firing after manual resolve by X"). A source that stops reporting it clears the hold quietly and the resolve
  stands. A manual resolve sends no "resolved" notice to phones (it is not the source's word).
- `confirm_resolution` is for an incident that is not firing and whose last resolve a source backs. It records a
  `confirmed` event (`by`, `note`, the resolve it confirms) and changes no state. It is refused while the incident
  fires, when it never resolved, and after a manual resolve while a source still reports the alert.
- A re-fired incident starts unacknowledged in every case. A silence is time-boxed and kept until it runs out; the
  incident carries `silenceCarried` and the sheet says it was set on the previous episode.

## The fix loop

An agent fixing an incident has two tool calls and one loop:

1. `get_fix_context` with the incident key. It answers the brief above: what is firing, which source and target raised
   it and how they are configured, what the rule asserted and which predicate the last run failed, where the endpoint
   was found, the last good answer beside the failing one, the command that re-runs the check, and the evidence links.
2. Fix the cause, then restart or redeploy so the fix is live.
3. `verify_fix` with the same key and `by`. It re-checks the sources now, waits up to `timeoutSec` for the source's
   fresh observation (one round no faster than every 10 seconds), and answers `resolved`, the `observation`, and the
   `asserts` of the incident. When every alert is resolved by its source it records the confirmation with the note
   "verified by agent": History reads "resolution confirmed by <you>", and the incident is closed with the attribution.
   When the source still reports an alert firing it resolves nothing and says which assertion failed, so the fix can be
   repaired rather than guessed at. It never resolves an alert itself: only the source (or a person's `resolve`) ends
   one.

The same loop from a terminal:

```
watcher incident '<service>|<rule>' --fix-context          # the brief
watcher incident '<service>|<rule>' --fix-context --output md
watcher recheck '<service>|<rule>' --wait --timeout 60     # one round, or the wait and the confirmation
```

`watcher incidents --open --json` lists the live incidents (parked ones left out) so an agent can find the key;
`watcher incident '<key>'` without `--fix-context` shows the incident itself. These commands read the running Watcher
over HTTP (`GET /api/incidents/:key/fix-context`, `POST /api/incidents/:key/recheck`, `POST /api/incidents/:key/verify`),
so the wall stays the single writer.

## Re-check

`recheck` runs the wall's own on-demand poll (`src/server/recheck.ts`), so a re-check resolves and keeps alerts
exactly as a scheduled poll does, and a failed poll changes no alert. One poll per source runs at a time (a call
during one joins it) and one per source runs in any 10 seconds; a call inside that gap polls nothing and answers
with the last poll's outcome. A re-check never raises a source-stale warning sooner than the scheduled polls would.

- With `incident`, it re-polls the sources of that incident's firing alerts. With `alert`, the same for one alert.
  With neither, it re-polls every pull source and says how many alerts cleared.
- A pushing sender cannot be polled. An alert from one carries the sender and its schedule in
  `GET /api/incidents/:key` (`alerts[].pushed`), so a reader can say when it next reports and when the alert clears
  if it stops.
- A pushing source with `recheckRequests` in its config takes requests. `pickupWithinSec` is how soon it promises to
  look for them, 30 to 3600 seconds. `recheck` on a firing alert of that source leaves one request per alert (an
  alert that already has an open one reuses it), and the answer's `pushed[].request` says where it stands. The
  request is only read by the sender, never pushed to it:

```json
{ "id": "sweep", "type": "webhook", "tokenEnv": "SWEEP_TOKEN", "staleAfterSec": 43200,
  "recheckRequests": { "pickupWithinSec": 90 } }
```

The sender reads its open requests with the same Bearer token it pushes with:

```
GET  /ingest/<source>/recheck-requests
POST /ingest/<source>/recheck-requests/<id>   {"outcome": "ran" | "dispatched" | "failed" | "unsupported", "note": "..."}
```

`GET` answers `{ "requests": [...] }`, oldest first, at most 20. Each is
`{ id, alertKey, fingerprint, alertname, labels, requestedAt, requestedBy, via, claimedAt }`; the first read that
returns a request claims it (`claimedAt`), and it comes back until it is answered or expires after 30 minutes. `POST`
answers `204` on success; an unknown id is `404`, a bad outcome is `400`. `ran` means the check ran, `dispatched` that it started a run it waits on, `failed`
that it could not, and `unsupported` that it cannot run this check on demand. A request that is picked up and never
answered reads "picked it up and has not reported back"; one nobody claims reads "did not pick the request up within
30 minutes".

## The same actions over HTTP

The wall's own API takes the same writes for a person or a script, same-origin and unauthenticated like the rest of
`/api`. `by` comes from the JSON body (at most 64 characters, control characters and runs of space folded), then from
the percent-encoded `x-watch-user` header, then "this browser". A body the Watcher refuses names the field.

| Method and path | Body | Answers |
| --- | --- | --- |
| `POST /api/incidents/:key/ack` | `{ by }` | `{ ok }`, or `404` when it is not firing |
| `POST /api/incidents/:key/unack` | `{ by }` | `{ ok: true }` |
| `POST /api/incidents/:key/silence` | `{ by, minutes }` (clamped to 1 to 1440) | `{ ok, minutes }`, or `404` when it is not firing |
| `POST /api/incidents/:key/park` | `{ by, state, until, note, ref? }` | `{ ok, key, by, state, until, replaced }`; `400` names the problem, `404` when it is not firing |
| `POST /api/incidents/:key/unpark` | `{ by, note? }` | `{ ok, key, at }`; `404` when not firing, `409` when it was not parked by hand or its park already ended |
| `POST /api/recheck` | none | a `WallRecheck`: `{ at, sources, cleared, stillFiring, pushed, requestable }` |
| `POST /api/recheck/:alertKey` | none | an `AlertRecheck`: `{ key, at, before, after, sources, pushed, rule, ... }`, or `404` |
| `GET /api/incidents/:key/fix-context` | none | the `get_fix_context` brief, or `404` for a key the Watcher never held |
| `POST /api/incidents/:key/recheck` | `{ by?, }` | one round: `{ key, at, alerts, resolved, stillFiring }` |
| `POST /api/incidents/:key/verify` | `{ by?, timeoutSec? }` (5 to 300) | a `VerifyResult`: `{ key, resolved, timedOut, rounds, observation, asserts, confirmation, confirmationError, next }` |

Reads for a script: `GET /api/state` (the whole wall, with an ETag), `GET /api/summary` (counts only),
`GET /api/incidents/:key` (the incident as the sheet reads it, `comments` and `alerts[].pushed` included) and
`GET /api/history?hours=24`. Comments are written only through the MCP `comment` tool; the wall draws them and
never composes one.

## Self-monitoring a coding session

`watcher status --brief` prints at most ten lines: one per open incident (severity, service, title, age, key) and a
closing line that names `watcher incident <key> --fix-context` and the MCP tool `get_fix_context`. It prints nothing
and exits 0 when every incident is green or when the Watcher is not running, so it can never block or fail a session.

`watcher hooks install --target claude [--dir <project>] [--dry-run]` merges a `SessionStart` hook into
`<project>/.claude/settings.json` that runs `watcher status --brief` when a session starts, resumes, is cleared,
compacts or forks. The shape is the one in the Claude Code hooks reference,
<https://code.claude.com/docs/en/hooks> (retrieved 2026-11-04):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact|fork",
        "hooks": [{ "type": "command", "command": "watcher status --brief", "timeout": 10 }]
      }
    ]
  }
}
```

It is idempotent (a second install finds the command and changes nothing) and it preserves every other setting and
hook in the file. `watcher hooks uninstall` removes exactly the handler it added, and an empty matcher group or event
with it. `--target codex` writes the same instruction into the project's `AGENTS.md` between
`<!-- ezo-watcher:start -->` and `<!-- ezo-watcher:end -->` ("At the start of a task, run `watcher status --brief`"),
because Codex has no session hook API; `hooks uninstall` removes exactly that block. `--dry-run` reports the change
without writing.

## Operating

- Every write is one operator-log line ("mcp: acknowledge agent: claude on `<key>`"). The token never appears in it.
- The server announces itself per request, with the Watcher's brand as its title and instructions that say the
  same rules as this page: read freely, write as yourself, acknowledge while you work, comment what you find, park
  only after a fix or a verdict.
- Tests: `test/mcp-server.test.ts` (the endpoint, the token gate, the tools over HTTP),
  `test/mcp-pure.test.ts` (auth and the pure shapes), `test/park-by-hand.test.ts` (the park and unpark tools and
  their routes), `test/recheck-requests.test.ts` (the sender's request protocol), `test/server/fix-tools.test.ts` (the
  fix brief, `verify_fix` and their routes), `test/cli/fix.test.ts` (`watcher incident` and `watcher recheck`),
  `test/cli/mcp-stdio.test.ts` (the stdio bridge), `test/cli/hooks.test.ts` (`status --brief` and `hooks install`).
