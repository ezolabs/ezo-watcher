---
name: ezo-watcher
description: "Use this skill whenever the user asks to set up, add, check or fix monitoring, alerts, uptime checks or a Watcher for this project — 'monitor this', 'watch my app', 'page me when it breaks', 'why didn't the alert fire', or extending an existing .watcher/ setup. It drives the `watcher` CLI end to end: init the project, scan it for telemetry points (and read the code for the silence a scan cannot see), add sources and one channel, prove every check can go red with `watcher doctor --live --prove`, run the server, and host it locally or on Cloudflare."
---

EZO Watcher is an alert wall and pager installed into the **user's project**: config as code in `.watcher/`, one local Node process, no account. Your job is the whole install, proven — not a list of suggestions.

The CLI is the source of truth. Every topic below prints from it: **`watcher skills <topic>`** (topics: `install`, `discover`, `sources`, `channels`, `hosting`, `cloudflare`, `netdata`, `operate`, `fix`, `telemetry`), or read `references/<topic>.md` beside this file. Run every command as `watcher <verb>`, never the bare word (`doctor` collides with the host agent's own `/doctor`).

## Install the CLI

```bash
CI=1 npm_config_yes=true npm i -g ezo-watcher
watcher --version
```

No global install: `npx -y ezo-watcher <verb>` runs the same CLI. From a checkout: `npm ci && npm run build && npm link`.
Node 24+. Full detail, including the latest-main install from GitHub: `watcher skills install`.

## The loop

If `.watcher/` already exists, run `watcher doctor --json` and `watcher scan --json` first, then add only what the ranking says is missing; do not re-init over a working install.

1. **Init.** `watcher init` in the project root. Idempotent, never prompts; writes `.watcher/config.json`, `.watcher/.env` (0600), `.watcher/data/`, gitignores the last two, picks a free port from 7717, prints a first doctor summary.
2. **Scan.** `watcher scan --json` → `{signals, suggestedCommands}`. On a small hand-labelled sample its prototype found 15 of 19 HTTP/TLS points but only 2 of 10 silence points (`watcher skills discover`): treat its commands as candidates, then do the silence-first pass below by reading code.
3. **Choose by the ranking** (next section). One source per real point; never invent a source to look green.
4. **Add.** For each chosen source: `watcher add <kind> --id <id> … --found-at <file:line> --read "<what it proves>"`. The `--found-at`/`--read` are provenance and `watcher doctor` warns without them. `--dry-run` previews. Then one channel: `watcher add channel <type> --id <id> …` (see `watcher skills channels`). If no credential is available — a headless box, no vendor account, a user who has not chosen a pager — add the credential-free fallback, `watcher add channel file --id local`: it writes one JSON line per notification under `.watcher/data/` and is a real, testable channel, not a stub. `watcher add … --replace` rewrites an existing id; `watcher rm <id>` removes one.
5. **Doctor loop.** `watcher doctor --json`; if `ok:false`, fix the **first** `fail` via its `next` and re-run. If `channel.missing` warns and the user wants a phone to ring, do step 8's channel now and come back. Exit 0 passes, 1 fails, 64 is usage.
6. **Run.** `watcher run --detach` (or `watcher service install` so it survives reboot). Then `watcher doctor --live --json` to read the running server.
7. **Prove.** `watcher doctor --live --prove --json` until it returns `{"ok": true, "live": true}`. `--prove` moves each source's own reading past its threshold and fails unless the rule actually flips (`source.assertion-not-red`; a vacuous http-probe assertion fails `source.assertion-vacuous`): an http-probe answer is mutated, a heartbeat is evaluated after a missed run plus its grace, a host reading is moved past its disk/memory/load thresholds, a tcp connect fails, an expiry falls inside `pageDays`. A kind whose alert is what its sender reports (grafana, vmalert, sentry, netdata, feed, webhook) is a named `source.prove-unsupported` skip, never a fail. If the project has **no server and no scheduled job**, add `watcher add host --id host` — the machine itself, read locally with nothing installed — and prove it. Only a project with **no server, no scheduled job and no host to watch** runs `watcher doctor --no-runtime-surface --json` → `{"ok": true, "live": false, "reason": "no-runtime-surface"}`, reported plainly; a configured source always wins over `--no-runtime-surface` (the report then warns `doctor.no-runtime-surface-ignored`). Do not call an unproven install done.
8. **Page.** Add one channel and run `watcher test-alert`; confirm it arrived on the device that matters. A missing credential is a named skip, never a pass.
9. **Host (optional).** The ladder is local → service → Docker/VPS → Cloudflare Tunnel (default for "host it with my Cloudflare key") → Containers beta. `watcher skills hosting`, `watcher skills cloudflare`.
10. **Install the skill for next time.** `watcher skills install --target all --dir .` writes it into the project. In Claude Code run **`/reload-skills`** afterwards — a top-level skills directory created mid-session is not picked up otherwise.

Day two — read the wall, acknowledge, comment, silence, park, re-check — is `watcher skills operate`.

## When something breaks

An incident is a claim with evidence, not a notification. The loop, in full, is `watcher skills fix`:

1. `watcher status --brief` for one line, or `watcher incidents --output json` for the keys (MCP: `watch_state`, then `list_incidents`).
2. `get_fix_context { key }` (CLI: `watcher incident <key> --fix-context`): the incident, the source and target config with credentials as env-var names, the rule's asserts and the one that failed, where the endpoint was found, the last good beside the last bad observation, the exact command that re-runs the check, and `next`.
3. Reproduce it from that command. A threshold is not a cause.
4. Fix the cause, redeploy or restart so the fix is live.
5. `verify_fix { key, by }` (CLI: `watcher recheck <key> --wait`): it re-checks, waits for the source's fresh answer, and records the confirmation when every alert is resolved — or says which assertion still fails, so the fix can be repaired. Never mark an incident resolved before a recheck is green; `park` is for a fix that is merged and not live yet, `confirm_resolution` for one the source already closed.
6. `comment` what you found on the way. A silent fix leaves the next person nothing.

## Ranking: what to watch, in order

1. **The production process's deepest readiness route**, asserting a field that changes when a dependency is down. Never a hardcoded `{"ok": true}` / `{"status": "ok"}` — that is liveness, and it cannot go red for the failure that matters.
2. **A readiness probe the platform already declares**: `/readyz`, `/health/ready`, a compose `healthcheck`, a Kubernetes `readinessProbe`, a fly/railway/render health path. Mirror it from outside with the same path and port.
3. **No server → one heartbeat per scheduled job.** Silence is the signal.
4. **No server and no scheduled job →** `watcher add host --id host` (load, memory, free space, optionally a pid file; nothing installed) and prove it. Only **no server, no scheduled job and no host to watch** → `watcher doctor --no-runtime-surface --json`, report `NO_RUNTIME_SURFACE`, stop. A configured source always wins over `--no-runtime-surface`. Never invent a source.
5. **Then the systems that already exist** — Sentry, Grafana, Netdata, an inbound sender — **credential-bound**. A missing credential is a named skip with a code and a `next`, never a silent pass.

## Silence first (the scan misses these)

Read the code for these six classes; each becomes a `watcher add heartbeat` or a `watcher add webhook --stale-after`:

1. **Schedules generated at install time** — heredocs in `install.sh`/`setup.*` that write a plist, unit or crontab, `launchctl load`, `systemctl enable`, `crontab` writes.
2. **launchd/systemd/cron created at runtime** — `.plist` templates, `OnCalendar=`, `StartInterval`, `KeepAlive`, `node-cron`, `schedule(`, `setInterval` around a job, celery beat. One heartbeat per job (`--every`/`--schedule` + `--grace`); N jobs means N sources.
3. **Pull-queue workers** — `worker`, `queue`, `bullmq`, `sqs`, `claim`, `lease`, `dequeue`. Failure is queue depth or no progress, not a port: ping a heartbeat at the success path, or push a `checks.list` entry with `state: failing`.
4. **Staleness in the product's own config** — `staleAfterSec`, `presenceTtlSec`, `maxAge`, `ttl`, `refreshInterval`, `lastRunAt`. Enforce the same window: `watcher add webhook --id <sender> --token-env <ENV> --stale-after-sec <sec>`.
5. **State-directory writability** — `mkdir`, `state/`, `data/`, sqlite, lock files. Ping only after a successful write; a bare `test -w` is not a source.
6. **Dependency endpoints held as code constants** — `process.env.X ?? "https://…"`, host:port literals, gRPC/ClickHouse/LLM bases. `watcher add http-probe` (HTTPS GET) or `watcher add tcp-probe --host --port`, with `--found-at` the constant.

Put the ping at the job's **success** path — `POST /ingest/heartbeat/<id>`, with `/fail` for a failed run and `/<exit-code>` for a specific one. `watcher add heartbeat` mints the token into `.watcher/.env` (0600) when the named variable has no value yet, or writes the `--secret-value` you pass, and prints the exact lines (`$NIGHTLY_TOKEN` below is the name it picks for `--id nightly`; a `--token-env` you pass is the variable it prints instead):

```sh
set -a; . .watcher/.env
curl -fsS -m 10 "${WATCHER_URL:-http://127.0.0.1:7717}/ingest/heartbeat/<id>?token=$NIGHTLY_TOKEN"                 # after a successful run
curl -fsS -m 10 "${WATCHER_URL:-http://127.0.0.1:7717}/ingest/heartbeat/<id>/fail?token=$NIGHTLY_TOKEN"            # after a failed run
curl -fsS -m 10 "${WATCHER_URL:-http://127.0.0.1:7717}/ingest/heartbeat/<id>/<exit-code>?token=$NIGHTLY_TOKEN"     # with the job's exit code
```

A collector that is not one job pushes its whole list instead: `POST /ingest/<source>` with `{"checks":{"list":[{"id":"…","service":"…","state":"ok","lastRunAt":"…"}]}}` — the full shape and states are in `watcher skills sources`.

If a health route returns only a literal, **find a deeper one or add one**: `GET /readyz` → `200 {"db":{"ok":true}}` when the dependency answers, `503 {"db":{"ok":false}}` when it does not. Editing the user's project is allowed — you are the agent writing the file. Then assert on the changing field, never on `{"ok":true}`.

## Rules

- **Never point a source at the Watcher's own `/healthz`** — `source.self-probe` rejects it.
- **A source must assert something that can flip.** A bare 200 is liveness only (`source.bare-200`); `watcher doctor --live --prove` is the gate, `--found-at` is a warning (`source.untraced`).
- **Secrets are env-var names in config and values only in `.watcher/.env`.** Never read `.env` values during scanning, never commit `.watcher/.env` or `.watcher/data/`.
- **One working channel beats five configured.** Prove it with `watcher test-alert`. No credential at all? `watcher add channel file --id local` and prove that: the file is a real channel, and a missing credential is a named skip, never a pass.
- **Report what you proved** — sources added, command output, and every named skip. If the agent cannot finish a rung (missing credential, no zone), say which and why in one line.

More detail, when a step needs it: `watcher skills discover` (full signal catalogue and the silence checklist), `watcher skills sources` (every kind, flags, examples), `watcher skills channels`, `watcher skills hosting`, `watcher skills cloudflare`, `watcher skills netdata`, `watcher skills operate` (MCP tools and incident triage).
