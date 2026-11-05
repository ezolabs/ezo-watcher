# Sources

A source is one system the Watcher reads (polled) or is pushed by. It returns observations; the Watcher's engine owns incidents. Add each one with `watcher add <kind> --id <id> …` — the CLI validates the whole config through the server's own validator and refuses to write an invalid one.

```bash
watcher add <kind> --id <id> [kind flags] [common flags] [--dry-run]
watcher add <kind> --help        # the authoritative flag list for this kind
```

`--dry-run` prints the config it would write and changes nothing. `watcher add` stamps a `_meta` hash of what it wrote; if someone hand-edits `.watcher/config.json` afterwards, `watcher doctor` reports `config.hand-edited` as a warning (hand edits are allowed, just reported). `watcher add … --replace` rewrites an entry with the same id through the same validator; `watcher rm <id>` removes a source or channel (a removed channel is taken out of every route that named it), so an install never has to hand-edit an id.

## Common flags

| Flag | Meaning |
| --- | --- |
| `--id <id>` | Stable source id. Part of every alert key and cell id: renaming it replaces them |
| `--service <name>` | The wall tile its alerts land on; defaults to the source id |
| `--poll-sec <n>` | Seconds between polls (kind default where it has one) |
| `--fail-after <n>` | Consecutive failed polls before the incident fires; before that the cell reads pending |
| `--found-at <file:line>` | Where in the project the signal lives (provenance) |
| `--read "<text>"` | What the route/job proves — one line, shown next to the source |
| `--token-env <NAME>` | The env var holding this source's credential. The value goes in `.watcher/.env`; config stores only the name. `heartbeat` and `webhook` mint a value there when the name has none yet |
| `--secret-value <value>` | Write the credential into `.watcher/.env` (0600) in the same step, instead of minting one. There is no inline secret flag besides this |
| `--stale-after-sec <sec>` | For push sources: silence longer than this is an incident |
| `--optional` | Its credential may be absent on this host: `watcher doctor` then reports `source.credential-skip` (skip) instead of failing `ok` |
| `--replace` | Rewrite the source or channel that already has this id, through the validator, instead of refusing a duplicate |
| `--dry-run` | Print the write, change nothing |

A source is **asserted** when it carries a predicate that can flip — an `expectJson` path with a non-null literal, a TCP connect, an on-time heartbeat, an expiry date, a host threshold. A bare status-200 source is *liveness only*, and `watcher doctor --live` says so with `source.bare-200`. The install gate (`watcher doctor --live --prove`) requires at least one asserted source whose predicate actually flips under mutation; an assertion that is vacuous fails with `source.assertion-vacuous`. `--prove` moves the source's own reading past its threshold for `http-probe`, `heartbeat`, `host`, `tcp-probe` and `domain-expiry`; a kind whose alert is a sender's (grafana, vmalert, sentry, netdata, feed, webhook) is a named `source.prove-unsupported` skip, never a failure.

## Which kind

| You have | Kind |
| --- | --- |
| An HTTP route you can GET, with JSON worth asserting | `http-probe` |
| A socket with no HTTP on it (database, cache, MQTT, a published compose port) | `tcp-probe` |
| A scheduled job — cron, timer, workflow, a worker loop | `heartbeat` |
| A sender you cannot poll (Stripe, GitHub, a collector) pushing to you | `webhook` |
| A sender that serves its push body over HTTP | `feed` |
| Sentry projects | `sentry` |
| Grafana alerts and rule health | `grafana` |
| Netdata Cloud alerts and host metrics | `netdata-cloud` (and the `netdata-fleet` add-on) |
| VictoriaMetrics/vmalert rule health | `vmalert` |
| A domain that must not lapse | `domain-expiry` |
| The machine the Watcher runs on, with nothing installed | `host` |

## http-probe

GETs each target every poll, follows no redirect, and checks the status and JSON paths. `ProbeDown` pages after `--fail-after` failures in a row; `ProbeSlow` warns on a slow answer; `CertExpiring` warns at 14 days and pages at 3 for an https target (configurable per target).

Config: `{ id, type:'http-probe', pollSec, failAfter, targets:[{ id, service, url, expectStatus?, expectJson?, timeoutMs?, slowMs?, certWarnDays?, certPageDays? }] }`. A target's `service` defaults to the source id.

```bash
watcher add http-probe --id app --url https://app.example.com/readyz \
  --expect-json '{"db.ok":true}' --expect-status 200 --slow-ms 2000 \
  --poll-sec 60 --fail-after 3 \
  --found-at src/server/routes/ready.ts:42 \
  --read "readiness reads the primary database and 503s when it is down"
```

- `--expect-json` is a JSON object of dotted paths to values; each must **equal** its literal. Use it for state (`"db.ok": true`), not for thresholds.
- Plain `http://` targets are allowed only for loopback, RFC 1918 and CGNAT addresses; everything else must be https.
- One target per source in v0. A redirect is a failure unless `--expect-status` names the 3xx.
- Every target must be a real assertion or a 200 that proves a dependency. Never point it at the Watcher's own `/healthz` (`source.self-probe`).

## tcp-probe

Opens a connection and closes it; with `--tls` it also reads the peer certificate and reports expiry like `http-probe`. Use it where a port must accept connections and there is no HTTP to GET.

Config: `{ id, type:'tcp-probe', pollSec, failAfter, targets:[{ id, service, host, port, tls?, timeoutMs?, slowMs?, failAfter? }] }`. A target's `service` defaults to the source id.

```bash
watcher add tcp-probe --id postgres --host db.example.com --port 5432 \
  --poll-sec 60 --fail-after 3 \
  --found-at compose.yaml:21 --read "the job database's published port"
```

Asserts `tcp:connect`. gRPC health checks are out of scope in v0: probe the TCP port, or add a small HTTP health route to the service instead.

## heartbeat

A push source for one scheduled job. The job pings `POST /ingest/heartbeat/<id>` on success (also `GET`); `/start` marks it running, `/fail` and `/<exit-code>` mark it failed immediately, and a later ok ping resolves. A missed ping — now past `every + grace`, or past the next cron tick plus grace — raises an incident named for the job. One heartbeat source is **one job**, so a project with four schedules gets four sources and four distinct pages.

Config: `id`, `name`, `every` (a duration such as `24h`) or `schedule` (a five-field cron), optional `timezone`, `grace`, and `tokenEnv`.

```bash
watcher add heartbeat --id nightly-report --every 24h --grace 2h \
  --token-env WATCHER_HEARTBEAT_NIGHTLY_TOKEN \
  --found-at scripts/nightly.mjs:12 \
  --read "the report job runs nightly and pings only after a successful write"
```

```bash
watcher add heartbeat --id hourly-sync --schedule "0 * * * *" --timezone America/Chicago --grace 15m \
  --token-env WATCHER_HEARTBEAT_SYNC_TOKEN
```

- `--every` takes `30s`, `5m`, `6h`, `24h`; `--schedule` takes a five-field cron. `--grace` must exceed normal jitter, not the job's runtime.
- A run that never finishes is a failure too: `/start` moves the deadline to the next run, and an ok ping that never follows makes that run late and names the job.
- `watcher add heartbeat` mints the ping token into `.watcher/.env` (0600) when the named variable has no value yet — or writes the `--secret-value` you pass — and prints the exact URL, the token variable and the three `curl` forms (`/<id>`, `/<id>/fail`, `/<id>/<exit-code>`). Insert the ping from `watcher skills discover` at the job's success path.
- The heartbeat's alert key is the source id; renaming it orphans the monitor.

## webhook

A sender pushes to `POST /ingest/<id>` with `Authorization: Bearer <tokenEnv's value>`. The body is an Alertmanager v4 `alerts` list and/or a `checks` object (below). Silence can be watched with `--stale-after-sec`; the default is no staleness, which is right for a sender that only pushes when something changes.

Config: `{ id, type:'webhook', tokenEnv, staleAfterSec?, presenceTtlSec?, recheckRequests?{pickupWithinSec}, verify?{scheme,secretEnv,header?}, netdata?{…} }`.

```bash
watcher add webhook --id grafana-alerts --token-env WATCHER_INGEST_GRAFANA_TOKEN --stale-after-sec 3600
```

- `--stale-after-sec` raises a `SourceStale` incident on silence; for a push source the default severity is a page. Put it above the sender's longest normal gap.
- The push token is the CLI's to mint: when `.watcher/.env` has no value for `--token-env`, `watcher add webhook` generates one and says so. Copy that value from `.watcher/.env` into the sender; a token the Watcher only reads (Sentry, Grafana, Netdata, a feed) is never minted.
- `presenceTtlSec` (a config key; `watcher add webhook --help` shows its flag) is how long an alert stays firing without a resend. Absent means 6 h.
- `recheckRequests: { pickupWithinSec: 30..3600 }` lets the wall's Re-check and the MCP `recheck` tool ask the sender to run again; the sender reads `GET /ingest/<id>/recheck-requests` and answers `POST /ingest/<id>/recheck-requests/<request id>`.
- Signed senders that cannot send `Authorization: Bearer`: `verify.scheme` is `github` (`X-Hub-Signature-256`), `stripe` (`Stripe-Signature`) or `hmac-sha256` (a header you name). The secret lives in the env var `verify.secretEnv`.
- One webhook source = one sender identity. Do not collapse an ingress dispatcher into ten sources, and do not split one sender across two ids.

### A `checks` push

Beside (or instead of) alerts, a push may carry the sender's check list, as a top-level `checks` object with a `list`:

```json
{ "checks": {
    "staleAfterSec": 900,
    "complete": true,
    "list": [{ "id": "sync", "instance": "worker-1", "service": "sync", "state": "ok",
               "lastRunAt": "2026-11-04T03:00:00Z", "detail": "412 rows", "url": "https://example.com/jobs/412" }] } }
```

`state` is `ok`, `failing`, `pending` or `skipped`; `staleAfterSec` (60 s to 7 days, default 6 h) dashes a check whose `lastRunAt` is older; `complete: true` (the default) drops a check the sender stops listing. This is the right shape for a queue worker, a state-dir writability check or a per-job last-run time.

## feed

Polls a URL that answers what `POST /ingest/<id>` would take, with a bearer token. Each good answer is the sender's whole state, so an alert it stops listing resolves; a failed poll changes nothing and counts as a miss.

Config: `{ id, type:'feed', url, tokenEnv, origin?, pollSec?, timeoutMs? }`.

```bash
watcher add feed --id uptime --url https://status.example.com/api/alerts \
  --token-env UPTIME_READ_TOKEN --poll-sec 60 \
  --found-at src/server/status.ts:8 --read "the uptime service's own alert list"
```

Use it when the sender already exposes a JSON status endpoint; use `webhook` when it can push.

## sentry

Polls Sentry's REST API for issues and release health. Needs a read-only user token with `org:read project:read event:read team:read`.

Config: `{ id, type:'sentry', url, webUrl, org, tokenEnv, pollSec, projects:{<slug>:<service>}, environments?, pageEnvironments?, … }`.

```bash
watcher add sentry --id sentry \
  --url https://us.sentry.io --web-url https://<your-org>.sentry.io --org <your-org> \
  --token-env SENTRY_READ_TOKEN \
  --project web=frontend --project api=api --poll-sec 120 \
  --found-at .env.example:14 --read "the app's error tracker"
```

Defaults: `environments` is production + testflight; `pageEnvironments` is production only; a crash issue pages at 20 events/hour or 5 users/24 h; a release warns under a 98 % crash-free rate and pages under 95 %; an issue with no event for 6 h resolves. A project you do not list is never read — leave the API server to Grafana if Grafana already covers it.

## grafana

Polls Grafana's embedded Alertmanager v2 API and its rules API. Needs a Viewer service-account token.

Config: `{ id, type:'grafana', url, tokenEnv, publicUrl?, pollSec }`.

```bash
watcher add grafana --id grafana --url https://grafana.example.com \
  --token-env GRAFANA_VIEWER_TOKEN --poll-sec 10 --public-url https://grafana.example.com
```

One cell per rule: a rule that is enabled but has no data reads `no data`, so a rule that went quiet is visible with nothing firing. `--public-url` is what human links use when it differs from `--url`.

## netdata-cloud

Polls Netdata Cloud for the space's own alerts and node reachability, one proof-of-watch cell per context group.

Config: `{ id, type:'netdata-cloud', url, tokenEnv, spaceId, roomId, pollSec, fleetNodes, watchOnlyNodes?, ignoreNodes?, groups?, … }`.

```bash
watcher add netdata-cloud --id netdata --url https://app.netdata.cloud \
  --token-env NETDATA_CLOUD_TOKEN --space-id <space> --room-id <room> \
  --fleet-nodes host-a,host-b --poll-sec 60
```

Use a token with `scope:grafana-plugin`; it is read-only. `--fleet-nodes` are the nodes a full disk or an unreachable node may page for; every other room node is a warning at most. Never query `*` contexts — a whole-room query is tens of megabytes. The `netdata-fleet` kind (same token, same space and room) adds the per-node CPU/memory/load view and its rules; see `watcher skills netdata`.

## host

Reads the machine the Watcher runs on: load average per core, memory available, free space on each configured mount, and optionally one process by its pid file. Nothing to install, no network and no credential (node:os and fs.statfs), so it is the floor under the Netdata add-on: right for a laptop, a fresh VPS or a box nobody put an agent on. Netdata stays the richer one (every other context, its own evaluated alerts, the fleet view).

Config: `{ id, type:'host', pollSec?, service?, mounts?, pidFile?, thresholds? }`.

```bash
watcher add host --id host --set 'mounts=["/","/data"]' --set pidFile=/run/app.pid
```

`--set` takes a path and a JSON value, which is how the mount list goes in: `--set 'mounts=["/","/data"]'`. A bare `watcher add host --id host` watches `/` only.

Defaults: every 60 s; a disk under 10 % free warns and under 5 % pages; memory available under 10 % warns; load5 over 2 per core warns. `thresholds` overrides any of them (`diskFreeWarnPct`, `diskFreePagePct`, `memAvailableWarnPct`, `loadPerCoreWarn`).

- One cell per mount, plus memory, load and the pid file; each asserts its predicate (`disk:/ free>5%`, `mem:available>10%`, `load:5m/core<2`, `pid:/run/app.pid running`), so the tile is proof of watch, not of a running poll.
- Alerts: `HostDiskFree` (per mount, warning or page), `HostMemoryFree`, `HostLoadHigh` (warnings) and `HostProcessDown` (a page: the pid file is gone or names no running process).
- Load is the kernel's own five-minute average per core, so the five-minute window is the reading, not a damping streak. Memory is MemAvailable on Linux (page cache included), the platform's free memory elsewhere, and the cell says which. Free disk is what an unprivileged user can still write (`bavail`).
- A reading that cannot be taken leaves that cell without data and fires nothing: a failed statfs is not a full disk. A poll that read every check is complete, so a mount or pid file taken out of the config resolves.
- A pid file that is missing pages: a process that died without cleaning up is exactly what the check is for. Point `pidFile` at the path the service really writes (systemd's `RuntimeDirectory`, a launchd `PIDFile`, the app's own file).
- With no server and no scheduled job, this is the source that still proves the install: the machine itself. Only when there is no server, no scheduled job and no host to watch either does `watcher doctor --no-runtime-surface` answer `{ ok: true, live: false, reason: "no-runtime-surface" }`; a configured source always wins over that flag.
- Like every source, it wants `--found-at <file:line> --read "<why this machine>"` (the compose file, the deploy doc): without it `watcher doctor` warns `source.untraced`, and the warning is the record that the tile is not a guess.

## vmalert

Reads vmalert's own metrics from VictoriaMetrics, one cell per rule. It carries no alerts: whether a rule fires still reaches the Watcher through the Alertmanager webhook.

Config: `{ id, type:'vmalert', url, pollSec, errorWindowSec?, knownWindowSec? }`.

```bash
watcher add vmalert --id router-rules --url http://127.0.0.1:8428 --poll-sec 30
```

A rule whose error counter rose within `errorWindowSec` (default 300) reads `error`; a rule with no series for `knownWindowSec` (default 3600) reads `no data`.

## domain-expiry

Reads a domain's registration expiry over RDAP (`https://rdap.org/domain/<domain>`, the `expiration` event), every 12 h. Warns at 30 days, pages at 7 (configurable) — the certificate can look fine while the domain lapses.

Config: `{ id, type:'domain-expiry', domains:[…], pollSec, warnDays?, pageDays? }`.

```bash
watcher add domain-expiry --id domains --domain example.com --domain app.example.com \
  --warn-days 30 --page-days 7 \
  --found-at .env.example:3 --read "the public hostname users open"
```

Asserts `rdap:expires>7d`. RDAP coverage is per TLD; a TLD with no RDAP endpoint is a named skip, not a pass.

## Source states

Each source reports `ok`, `error`, `stale` or `idle`. `stale` means a push source has been silent past its `staleAfterSec`; `error` means its own poll fails. A configured optional source whose credential is absent from this host is not started: it reads `idle` with `skipped` (`missing <ENV>`), raises no stale alert, and `watch_state` names it in `sources.skipped`. A source that has gone quiet or was not started means an all clear is not earned — read `list_sources` (MCP) or the Sources view before declaring the project healthy.

## Adding a channel instead

Channels are not sources: `watcher add channel <webhook|ntfy|email|sms|webpush|file> --id …`; see `watcher skills channels`. `watcher rm <id>` removes a source or channel by id.
