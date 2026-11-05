# Netdata (add-on)

Netdata already collects host and service metrics and evaluates its own alerts. The Watcher's job is to read them — not to duplicate them. This add-on adds one or both of:

- **Cloud poll** (`netdata-cloud` + `netdata-fleet`): the Watcher polls `app.netdata.cloud` for the space's alerts, node reachability and the fleet's CPU/memory/load series. No Netdata-side configuration, no firewall rule, one read-only token.
- **Agent or Cloud webhook** (`webhook`): Netdata pushes each alarm to `POST /ingest/netdata`. Works offline, from a single node, with no Cloud account.

Pick the poll when the hosts report to Netdata Cloud; pick the webhook when they do not, or when the user wants Netdata's own alarm text on the wall with no polling delay.

## Without Netdata: the `host` source

Before reaching for Netdata, know the zero-install option: `watcher add host --id host` reads the machine the Watcher runs on with nothing installed. Load average per core, memory available, free space per configured mount and, if wanted, one process by its pid file; no agent, no token, no network (`watcher skills sources` has the config and the thresholds).

Use it when there is one host and the user does not want another agent on it. Move to Netdata when there is more than one host, or when the question is a service's own metrics rather than the box's capacity: the add-on below brings every Netdata context, its evaluated alerts, the per-node fleet view and its history, and its official install is one line (learn.netdata.cloud, "Install Netdata with kickstart.sh", read 2026-11-04):

```bash
curl https://get.netdata.cloud/kickstart.sh > /tmp/netdata-kickstart.sh && sh /tmp/netdata-kickstart.sh
```

It prompts for the release channel, auto-updates and whether to connect the node to Netdata Cloud; add `--non-interactive` for a script. Neither source is a substitute for the project's own readiness route and heartbeats: the host checks prove the machine, not the app.

## Cloud poll

You need a Netdata Cloud API token with `scope:grafana-plugin` (read-only), the space id and the room id (both in the room's URL: `/spaces/<space-slug>-<space-id>/rooms/<room-slug>-<room-id>`), and the names of the nodes that must page. The token goes in `.watcher/.env` as an env var; the config holds only the name.

```bash
watcher add netdata-cloud --id netdata \
  --url https://app.netdata.cloud --token-env NETDATA_CLOUD_TOKEN \
  --space-id <space-id> --room-id <room-id> \
  --fleet-nodes host-a,host-b --poll-sec 60
```

What it proves:

- one cell per context group (disk space, disk inodes, RAID/NVMe, Docker, host basics by default), so a rule that went quiet is visible with nothing firing;
- a full disk or an unreachable **fleet** node is a page; the same on a watch-only node is a warning;
- `ignoreNodes` (name → one-line reason) drops a node from every count, the same way `quietAlerts` drops noisy alert names.

Rules of thumb:

- Never query a `*` context: a whole-room query is tens of megabytes. Scope `groups` to `disk.space`, `clickhouse.*` and the like.
- Keep `pollSec` at 60 or more; Netdata evaluates every few seconds to a minute and the API is shared.
- `netdataHosts`/`grafanaDiskHosts` join a Netdata disk alert to a Grafana rule of the same tier when both exist, so one disk is one incident, not two.

Add the fleet view — per-node CPU, memory, load and root disk, plus the `HostCpuHot`, `HostMemoryHot` and `HostLoadHigh` rules — with the companion kind, using the same token, space and room:

```bash
watcher add netdata-fleet --id fleet \
  --url https://app.netdata.cloud --token-env NETDATA_CLOUD_TOKEN \
  --space-id <space-id> --room-id <room-id> \
  --fleet-nodes host-a,host-b --poll-sec 60
```

The fleet view is opt-in: without it the wall shows Netdata's alerts and cells, and no capacity trend.

## Push from an agent or from Cloud

A push source keeps Netdata's own alarm text and needs no API token on the Watcher side, only an ingest token:

```bash
watcher add webhook --id netdata --token-env NETDATA_INGEST_TOKEN --stale-after-sec 3600
```

Then point Netdata at the Watcher:

- **Netdata Agent**: use a custom notification that POSTs to `http://127.0.0.1:<WATCHER_PORT>/ingest/netdata` (or the public URL when the Watcher is hosted), with `Authorization: Bearer <NETDATA_INGEST_TOKEN>`. The exact `health_alarm_notify.conf` lines are in `addons/netdata/README.md` in this repository.
- **Netdata Cloud**: add a webhook integration to the same URL and token.

`--stale-after-sec 3600` makes silence itself an incident: Netdata's alarm notifier only speaks when something changes, so the add-on must also send a periodic heartbeat, or the Watcher will page on a quiet system when the notifier dies. The add-on README's snippet includes that heartbeat, and `--stale-after-sec` is what turns its absence into a page.

## Do not duplicate

If Netdata already pages the user for a full disk, do not add an `http-probe` for the same thing. Use the Netdata source for what Netdata owns, and spend the Watcher's own sources on what Netdata cannot see: the app's readiness route, the scheduled jobs, the inbound integrations. Two systems paging for one disk is how a wall loses trust.

## Verify

```bash
watcher doctor --json                       # the source validates and its token env var is set
watcher doctor --live --prove --json        # the source polled, and its assertion can go red
```

A `secret.missing` check names `NETDATA_CLOUD_TOKEN` or `NETDATA_INGEST_TOKEN` and puts the fix in `next`. A Netdata source that is configured but cannot reach the cloud reports `error` with the HTTP status; a token without `scope:grafana-plugin` is the usual cause.

The full add-on write-up, including the agent-side snippet, lives in `addons/netdata/README.md`.
