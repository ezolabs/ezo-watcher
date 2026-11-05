# Fix

An incident is a claim with evidence, not a notification. This topic is the loop from "something is on the wall" to "the source itself says it is well again", and the one rule that holds it together: **an incident is closed by its source, and a recheck is the only proof a fix landed.** Your own word is not proof, and neither is a green test you ran somewhere else.

Read the wall, work it, and let the source close it. Everything below is CLI or MCP; you never need a browser.

## The loop

1. **Read the wall.** `watcher incidents --output json` prints every firing incident with its `key`; `watcher status --json` adds the counts and the sources that are stale or erroring. Over MCP, `watch_state` is the same wall in one answer, and `list_incidents` filters it (`state: unattended`, `severity: page`, `source: netdata-cloud`).
2. **Open the incident.** MCP `get_incident { key }`: every alert it holds, with labels, annotations, its evidence links and commands, who reports it and when it last did, the park or silence on it, and the comments. `watcher incidents` gives the same keys for a human.
3. **Find what it is about.** `get_incident`'s `alerts[].evidence[]` carries the command the sender put on the alert (`annotations.evidence`), its runbook and report links, and the URL where the sender saw it (`via[].url`). The source's own provenance is in `list_sources`: `discovered.foundAt` is the file and line where the endpoint or job was found (`src/server/routes/ready.ts:42`), not a guess. `watcher doctor --json` prints the same trace, or warns `source.untraced` when a source records none.
4. **Reproduce it.** Run the alert's evidence command from the project root, or the equivalent (`curl -fsS http://127.0.0.1:3000/readyz`, `ps`, `df -h /data`). A fix you could not reproduce is a guess; say in the comment what you saw instead.
5. **Fix the cause, not the threshold.** Raise a threshold only when the number really was wrong, and say why in the comment. Deleting a check to clear the wall is the same lie in a cheaper shape.
6. **Deploy or restart the thing the alert watches.** A fix that is merged but not running is not a fix: it is a `park` (step 8).
7. **Verify with a recheck.** MCP `recheck { by, incident }` (or `alert` for one alert, or neither for every pull source) asks the source again, and answers what each alert is now. The wall's Re-check button is the same call, asking as `wall`. A pull source polls immediately (one poll per source per 10 seconds); a push source that declared `recheckRequests` is asked to run its check again and the answer says where that request stands; any other pusher answers with when it last reported and when it next will. **Do not mark anything resolved until the recheck shows the alert cleared.**
8. **Close it the source's way.**
   - The source resolved it: `confirm_resolution { key, by, note }` records that you checked and that it held.
   - The source cannot show it yet because the fix is merged and not deployed, or deployed and its evaluation window has not caught up: `park { key, state: "fixed_undeployed" | "awaiting_source", until, by, note, ref }`. At most 72 hours, and the note says what you are waiting for.
   - You fixed it and the source will not see it for hours: `resolve { key, by, reason }` marks it resolved by hand. If the source still reports the alert on its next poll or push, it reopens as a new firing; that is the design, not a failure.

While you work: `acknowledge { key, by }` stops the escalation and the unattended clock, `comment { key, by, text }` is the incident's memory (what you found, the commit, what you ruled out), and `silence { key, by, minutes, reason }` is only for known-expected noise, for at most 4 hours.

## Per kind, what "fixed" means

| The incident | Where to look | What resolves it |
| --- | --- | --- |
| `ProbeDown` / `ProbeSlow` (http-probe) | The URL, from the machine the Watcher runs on, then the app behind it | The target answering with its configured status and JSON again; a slow one back under `slowMs` for `failAfter` polls |
| `CertExpiring` | The certificate's subject and expiry (`openssl s_client -connect host:443`) | A renewed certificate; the next handshake reads it |
| `DomainExpiring` | The registrar's record for the domain | A renewal; the next RDAP lookup reads the new expiry |
| `HeartbeatDown` | The job's schedule, its last run's log, its ping path and token | An ok ping (`POST /ingest/heartbeat/<id>`), or a run that pings on time again |
| `HostDiskFree` (host) | `df -h <mount>` on the machine the Watcher runs on | Space freed (logs rotated, a volume grown), not a lower threshold |
| `HostMemoryFree` (host) | `ps aux --sort=-rss`, the service's memory graph | The leaking process restarted or fixed; memory available back above the threshold |
| `HostLoadHigh` (host) | `top`, the runaway process's log | The load back under the threshold per core: a stuck job killed, a build finished |
| `HostProcessDown` (host) | The pid file, then the process's own log and service manager | The process started again (its pid file rewritten) |
| A Netdata alarm (`Netdata: node unreachable (<node>)`, or Netdata's own alarm name) | Netdata's warning/critical text in the annotation, then the node in Netdata Cloud | Capacity or configuration, as above; Netdata clears its own alarm, and the incident resolves with it |
| Sentry issues (`SentryNewIssue`, `SentryRegression`, `SentrySpike`, `SentryCrashFreeLow`) | The issue permalink in the alert's evidence, then the culprit file and line, then the release | A release with the fix, and Sentry seeing no new event for `quietAfterSec` (6 h by default) |
| A webhook sender's alert | The sender's own dashboard; the `via[].url` | The sender pushing the resolved alert, or not reporting it until its presence TTL runs out |
| `source-stale` (origin `self`) | `list_sources`: the source it names, its `lastOk` and `error` | The source answering again (a poll or a push), which is the only thing that clears it |

The two watch-outs: a **Sentry** incident is closed by Sentry, not by merging, so the fix ships in a release and the issue goes quiet; and a **host/Netdata** incident is usually capacity, not code, so the fix is a configuration change or a cleanup that you are allowed to make only if the user said so.

## What not to do

- Do not mark an incident resolved to make the wall green. `resolve` without a fix reopens on the next report and records who did it.
- Do not silence a page to "look later" without saying so in a comment. The wall keeps the silence, a person keeps the surprise.
- Do not fix a probe by pointing it somewhere else, and do not weaken its assertion to `expectStatus: 200` with no body: the check then proves nothing but a socket.
- Do not stop at "the test passes". The gate is the source's own answer, which is what a recheck reads.

## When the Watcher itself is the problem

`watcher status` answers `down` when nothing is listening: start it with `watcher run --detach` (or `watcher service install`). `watcher doctor --live --json` reads the running server, every source's assertion and the channel. The Watcher cannot page on its own death: watch it from another machine (`watcher skills operate`, "Keeping the Watcher itself alive").
