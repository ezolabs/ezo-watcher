# Netdata add-on

Two ways to put Netdata's health alerts on the Watcher wall. Both end at the same source id, `netdata`, and both are additive: nothing else in the
Watcher changes.

| You run | Where the alerts come from | What it needs |
| --- | --- | --- |
| A Netdata Agent on each host | the agent POSTs to `/ingest/netdata` when a health alarm changes state | the agent's `health_alarm_notify.conf`, and a token |
| Netdata Cloud (agents claimed into a room) | the Watcher polls the Cloud API every minute | a Cloud API token and the room's ids |

Choose the agent webhook if you do not use Netdata Cloud, or if the Watcher and the agents are on the same private network. Choose the Cloud source
if you already have the agents claimed: it is one configuration instead of one per host, and it adds reachability (a node Cloud cannot reach is an
alert). The two can run together; each alert keeps the source it arrived through.

## Option A: a local Netdata Agent

### 1. Create the webhook source

```
watcher add webhook --id netdata --token-env WATCHER_INGEST_TOKEN --secret-value "$(openssl rand -hex 24)"
```

That adds a `webhook` source with id `netdata` to `.watcher/config.json` and writes its Bearer token into `.watcher/.env` (the command prints the
variable name it used). Keep that file at mode 0600: the token is the credential, not a setting. If you write the config by hand, the source is:

```json
{
  "id": "netdata",
  "type": "webhook",
  "tokenEnv": "WATCHER_INGEST_TOKEN",
  "staleAfterSec": 86400
}
```

`staleAfterSec` is optional. An agent pushes only when an alarm changes state, so leave it out unless your agents also send a heartbeat; with a
value, a quiet day reads as a stale source on the Sources page.

### 2. Send the agent's alarms to it

Edit `health_alarm_notify.conf` on the agent (`sudo ./edit-config health_alarm_notify.conf` from the Netdata install directory, or edit
`/etc/netdata/health_alarm_notify.conf` and restart the agent). Set the custom sender and give every role you want to hear from a recipient called
`watch`:

```bash
SEND_CUSTOM="YES"
DEFAULT_RECIPIENT_CUSTOM="watch"

# The token from .watcher/.env. Keep this file 0600; it is read by the netdata user.
WATCHER_INGEST_TOKEN="paste-the-token-here"

custom_sender() {
  # The fields the Watcher's Netdata adapter reads. host, name and chart are identifiers, so this body needs no JSON escaping.
  local body
  body=$(printf '{"host":"%s","alert":"%s","severity":"%s","chart":"%s","context":"%s","date":"%s","duration":"%s"}' \
    "${host}" "${name}" "${status}" "${chart}" "${context}" "${when}" "${duration}")
  curl -fsS --max-time 10 -X POST "https://watch.example.com/ingest/netdata" \
    -H "Authorization: Bearer ${WATCHER_INGEST_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "${body}" >/dev/null
}
```

Then make each alarm role that should reach the wall name it, in the `to:` line of the health configuration:

```yaml
# /etc/netdata/health.d/example.conf
to: watch
```

`DEFAULT_RECIPIENT_CUSTOM` covers every role that names no recipient of its own. The `custom_sender` runs as the `netdata` user, so the token must
be readable by it and by nobody else.

### 3. Prove it

```
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://watch.example.com/ingest/netdata \
  -H "Authorization: Bearer $WATCHER_INGEST_TOKEN" -H 'content-type: application/json' \
  -d '{"host":"node-1","alert":"disk_space_usage","severity":"warning","chart":"disk_space./","context":"disk.space","date":"2026-01-01T00:00:00Z"}'
```

`200` means the wall took it; the Sources page now shows `netdata` as heard, and the wall carries the alert. Send `"severity":"clear"` to resolve
it again. A `401` means the token differs between the agent and the Watcher; a `404` means no source with id `netdata` is in the config.

## Option B: Netdata Cloud

```
watcher add netdata-cloud --id netdata --space-id <space> --room-id <room> \
  --fleet-nodes node-1,node-2 --token-env NETDATA_CLOUD_TOKEN --secret-value '<the API token>'
```

That adds a `netdata-cloud` source. It polls the Cloud API over outbound HTTPS, so the Watcher needs no open inbound port for it and no firewall rule
changes. Fill in:

```json
{
  "id": "netdata-cloud",
  "type": "netdata-cloud",
  "url": "https://app.netdata.cloud",
  "tokenEnv": "NETDATA_CLOUD_TOKEN",
  "spaceId": "<space id>",
  "roomId": "<room id>",
  "pollSec": 60,
  "fleetNodes": ["node-1", "node-2"]
}
```

Create the API token in Netdata Cloud (Space settings, API tokens; the `scope:grafana-plugin` scope is enough to read alerts and nodes) and put it in
`.watcher/.env` as `NETDATA_CLOUD_TOKEN`. `spaceId` and `roomId` are the ids in the room's URL. `fleetNodes` lists the hosts whose alerts may page;
a node in the room that is not listed reaches the wall as a warning only. An `ignoreNodes` map drops nodes entirely, each with the one-line reason
you will see in the Sources page.

The same token and room also feed the optional fleet view (`netdata-fleet`), which shows CPU, memory, load and root disk per node and raises the
HostCpuHot, HostMemoryHot and HostLoadHigh rules. It is a separate source; add it only if you want those figures on the wall.

## What reaches the phone

Netdata sends a `warning`, a `critical` or a `clear`. The Watcher keeps its own severity rules, and they are the same for both options:

- a **disk** alarm (`disk_space_usage`, `out_of_disk_space_time`, `disk_inode_usage`, `out_of_disk_inodes_time`) at critical is a page;
- an unreachable node from Cloud is a page, after a three minute hold so an agent restart does not wake anyone;
- every other critical is a warning on the wall, with `netdata_demoted` in its annotations saying why;
- `clear` resolves.

Set the routes in `.watcher/config.json` as for any other source (the `routes` list): a `page` route with your phone channels,
and a warning route that is wall-only. Nothing in this add-on sends a notification by itself.

## Keep the tokens out of the config

`tokenEnv` and `secretEnv` name environment variables; the values live in `.watcher/.env` (0600) or the host's secret store. No token is written to
`config.json`, a log line or the wall. Rotating one means changing both ends and restarting the server (`watcher stop && watcher run --detach`), which invalidates every
session it was used for.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The Sources page says `netdata` was never heard | no push has arrived: check the URL, the token, and that the agent's `custom_sender` is called (run `alarm-notify.sh test` on the agent and read its stderr) |
| A push answers 401 | the Bearer token the agent sends is not the one the source's `tokenEnv` names on this host |
| A push answers 400 `payload has no alerts list` | the body is not one of the shapes the adapter reads; use the `printf` body above (it needs `alert`, `severity` and either `chart` or `alert_url`), or the Cloud webhook |
| A push answers 404 | no `webhook` source with id `netdata` is in the config |
| An alert says `unknown host` | the body carried no `host`. The adapter reads `host`, `hostname`, `node_name` or `node`; the body above sends `host` |
| Alerts resolve after a day | `presenceTtlSec` (default 6 h, or what the source sets) dropped a `clear` that never arrived. Raise it above the sender's longest quiet gap |

## Notes

- The adapter reads the body Netdata Cloud's webhook integration sends. A local agent's `custom_sender` sends the same shape, which is why one adapter
  serves both. Its `where` line says "Raised through Netdata Cloud"; the labels (`netdata_host_from`, `netdata_severity`) are what tell an operator
  which door the alert came through.
- Netdata Cloud's webhook integration is configured in Netdata, not here: Space settings, Alerts & Notifications, add a Webhook configuration, point
  it at `https://<your-watcher>/ingest/netdata` with the Bearer token, and press Test. Cloud sends a body carrying a `token`; the Watcher writes it to
  its process log and raises no alert. Paste it back into Cloud to finish the test.
- A `webhook` source can also authenticate a sender that signs its body instead of sending a Bearer token (GitHub, Stripe, or a relay with an
  HMAC header). That is the `verify` block in `skills/ezo-watcher/references/sources.md`, and it does not change this add-on.
