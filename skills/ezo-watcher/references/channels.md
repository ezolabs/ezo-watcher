# Channels

A channel is where a page goes: a webhook, ntfy, email, SMS, web push or a local JSONL file. Sources can fill the wall with no channel at all, but nobody is paged until one exists — `watcher doctor` warns `channel.missing` when there is none.

```bash
watcher add channel <webhook|ntfy|email|sms|webpush|file> --id <id> [flags] [--dry-run]
watcher add channel <type> --help      # the authoritative flag list
```

`watcher add channel` also creates a default route to the new channel when no route exists, so the first channel works without hand-editing config. Every credential is an **env-var name** in config; its value goes in `.watcher/.env` (0600, gitignored). A channel whose secret is missing is a **named skip** with a code and a `next` — never a silent pass.

## webhook

POSTs the notification to a URL you control (an automation, a chat bridge, a local sink). Cheapest to test.

Config: `{ id, type:'webhook', urlEnv, headers? }`.

```bash
watcher add channel webhook --id hook --url-env WATCHER_WEBHOOK_URL
```

`headers` is a static map in config — never put a token there; use an env var and a template, or terminate the secret at the receiving end. The payload is the Watcher's notification JSON: title, severity, incident key, a link back to the wall, and the message.

## file

The credential-free fallback: one JSON line per notification appended to a file under the project. No token, no vendor, no network — it always works, so an install never ends with zero channels because every credential-bound one was skipped.

Config: `{ id, type:'file', path? }`; `path` defaults to `.watcher/data/alerts.jsonl` (gitignored with the rest of `.watcher/data/`).

```bash
watcher add channel file --id local
watcher test-alert --channel local     # appends a test line; `tail -f .watcher/data/alerts.jsonl` reads it
```

Each line is `{at, kind, title, body, severity, tag, url, ackUrl?}`. It is a record, not a pager: use it when the user has no phone/credential yet, has not chosen a vendor, or wants a local audit trail beside the wall. When a real credential arrives later, add that channel and route to both — or `watcher add channel <type> --id local --replace` to swap this id onto the new channel and keep the route.

## ntfy

The shortest path to a phone. Two targets:

- **Public server** (`https://ntfy.sh`): the topic is the secret. It carries a content-free notice — "EZO Watcher: page", "Open Watch for details", an opaque link — because the topic's operator can read everything published there.
- **Self-hosted** (`https://ntfy.example.com`): carries the whole alert, with the one-tap Acknowledge link, authenticated with an access token.

Config: `{ id, type:'ntfy', server, topicEnv, tokenEnv?, self?{urlEnv,topicEnv,tokenEnv}, primaryEnv? }`. `server` and `topicEnv` are **always the public server**; the self-hosted target is the `self` object, whose three values are env-var names.

```bash
watcher add channel ntfy --id ntfy --server https://ntfy.sh --topic-env WATCHER_NTFY_TOPIC
```

To add a self-hosted server as well, use the `self` flags printed by `watcher add channel ntfy --help` (they write `self.urlEnv`, `self.topicEnv`, `self.tokenEnv`); the public notice keeps going out meanwhile. Subscribe on the phone to the same server and topic. `primaryEnv` names an env var holding `public` or `self`: only that target's answer decides whether the channel succeeded (so web push can fire if the phone's own target failed); the other is best effort.

## email

Provider `resend` in v0.

Config: `{ id, type:'email', provider:'resend', apiKeyEnv, from, toEnv }`.

```bash
watcher add channel email --id email --provider resend --api-key-env RESEND_API_KEY \
  --from "watcher@example.com" --to-env WATCHER_EMAIL_TO
```

`from` must be a sender your provider has verified. `toEnv` names a comma-separated list, so recipients never enter git. Email is best for warnings and a record; it is not a pager.

## sms

Providers `telnyx` and `quo`.

Config: `{ id, type:'sms', provider, apiKeyEnv, fromEnv, toEnv }`.

```bash
watcher add channel sms --id sms --provider telnyx --api-key-env TELNYX_API_KEY \
  --from-env WATCHER_SMS_FROM --to-env WATCHER_SMS_TO
```

`fromEnv` is an E.164 number or a Quo phone-number id; `toEnv` is a comma-separated list of E.164 numbers. SMS costs money per page: route only `page` severity to it.

## web push

Browser push to the installed PWA, with the Watcher's own keys. Generate a VAPID key pair once and keep both halves in `.watcher/.env`.

Config: `{ id, type:'webpush', publicKeyEnv, privateKeyEnv, subject }`.

```bash
watcher add channel webpush --id push --public-key-env WATCHER_VAPID_PUBLIC \
  --private-key-env WATCHER_VAPID_PRIVATE --subject "mailto:ops@example.com"
```

`subject` must be a real `mailto:` or `https:` URI or Apple Push returns 403. Open the wall once on each device and allow notifications; a subscription is stored per device.

## Routes: who is told, how often

A route matches incidents and decides the channels. Config keys: `match{severity, origin, labels}`, `receivers`, `mode` (`ladder` = first receiver that succeeds, `all` = every receiver), `record`, `continue`, `groupWaitSec`, `groupIntervalSec`, `repeatIntervalSec`, `escalate[{afterSec, receivers}]`, `coalesce{maxPages, windowSec}`, `muteInQuietHours`, `sendResolved`.

- **`page`** is what reaches a phone. Route it to ntfy, SMS or web push.
- **`warning`** goes to a timeline (email, a chat webhook) and stays silent on phones.
- **`info`** is wall-only: an empty `receivers` list is a deliberate wall-only route and stops later routes matching.
- **Escalation**: `escalate` steps fire when an incident stays unattended (not acknowledged, not silenced) for `afterSec`; describe it in the config or let `watcher add channel` create the default route and hand-edit from there (hand edits are allowed; `watcher doctor` reports `config.hand-edited` as a warning).
- **Coalescing**: more than `maxPages` page notifications from one origin inside `windowSec` are held back and one summary goes out ("15 more pages in 10 min, see the wall"). Default 10 in 600 s; `maxPages: 0` disables it.
- **Quiet hours**: `quietHours{tz, start, end, days}` mutes routes that set `muteInQuietHours` and sends one digest when they end. Pages ignore quiet hours.

## Prove the channel

```bash
watcher test-alert
watcher test-alert --channel <id>     # one channel only
```

It POSTs the server's test-notify path (`POST /api/test-notify`, admin-authenticated) and sends a test message through every configured channel. Run it after adding the first channel and confirm the message arrived on the device that matters. An unconfigured channel is reported as a skip, not counted as delivered.

## Rules that keep the install honest

- **One working channel beats five configured ones.** Add one, prove it with `watcher test-alert`, then stop.
- **Never put a secret in `config.json`.** Config carries env-var names; `.watcher/.env` carries values. `watcher doctor` fails `env.not-ignored` when `.watcher/.env` is not gitignored in a git project.
- **A missing credential is a named skip.** `watcher doctor --json` shows `secret.missing` with the env var's name and a `next`; report it to the user as "not watched yet", never as green.
- **Do not duplicate a phone.** If the user already has an ntfy topic or a chat bridge for this project, route to that and do not add another pager.
