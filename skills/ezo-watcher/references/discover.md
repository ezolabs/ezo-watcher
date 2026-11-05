# Discover

Discovery is the agent's job: the scan gives you candidates, the code tells you what actually has to page. Read this before you run `watcher add` for the first time.

## What the deterministic scan sees

```bash
watcher scan --json          # { project, signals:[…], suggestedCommands:[…] }
watcher scan --output md     # the same for a human
```

Each signal carries `evidence:[{file,line}]`, a suggested kind and args, a confidence and a `needs` (`none`, `credential`, `judgment`). `suggestedCommands` are ready to run, but they are **proposals**: the scan never writes config. It walks the project once (bounded, skips `node_modules`, `.git`, build output and vendor trees), reads manifests, lockfile names, `.env*` **names only**, Dockerfiles, compose, k8s manifests, workflow files, health-route literals and config URLs.

An early prototype of this scan (not the shipped `watcher scan`, which has not been scored) was run against four repositories whose watch points had been labelled by hand from their source, 29 points in all. It found:

- 15 of the 19 HTTP/TLS points (servers, routes, certs, vhosts to ports);
- 2 of the 10 silence points (scheduled jobs, collectors, inbound webhooks);
- nothing on a separate repository with neither a server nor a schedule (it abstained).

Four repositories, one labeller and a prototype built from one of them make this a rough estimate, not a benchmark, but the gap is wide enough to plan around: **the scan finds servers; you find silence.** Treat everything below as work you owe after the scan.

## The ranking: what to watch, in order

Pick sources in this order. Stop at the first rung that applies, and only then go wider.

1. **The production process's deepest readiness route**, asserting a field that changes when a dependency is down — a database, a queue, an upstream. Never a route that returns a hardcoded `{ "ok": true }` or `{ "status": "ok" }`; that is liveness, and it cannot go red for the failure that matters.
2. **A readiness probe the platform already declares**: `/readyz`, `/health/ready`, a compose `healthcheck`, a Kubernetes `readinessProbe`, a `fly.toml`/`railway`/`render` health path. Mirror it from outside with the same path and port.
3. **No server** — then one heartbeat per scheduled job. Silence is the signal: the job that stops running is invisible to every port.
4. **No server and no scheduled job** — add `watcher add host --id host`: the machine the Watcher runs on, read locally with nothing installed (load per core, memory available, free space per mount, optionally one pid file). It is a real assertion that can go red, and `watcher doctor --live --prove` proves it. Only a project with **no server, no scheduled job and no host to watch** reports `NO_RUNTIME_SURFACE`: run `watcher doctor --no-runtime-surface --json`; it answers `{ ok: true, live: false, reason: "no-runtime-surface" }`. A configured source always wins over `--no-runtime-surface`. Do not invent a source to make the install look green.
5. **Then, and only then**, the systems that already exist: Sentry, Grafana, Netdata, an inbound webhook sender. These are credential-bound: a missing credential is a **named skip** with a code and a `next`, never a silent pass.

A project with any scheduled job must reach `live: true` through its heartbeats; a project with no server, no scheduled job and no host to watch is the only legitimate `live: false`.

## The readiness-route rule

A health route that returns a literal is **liveness-only**. It proves the process accepted a connection, not that the product works: with the database down, the queue stuck or the upstream gone, `{ "ok": true }` still answers 200.

Before you assert on a route, read its handler:

- **Depth matters, not the path.** `/healthz` that reads a dependency is better than `/readyz` that returns a literal.
- **Find the deepest existing route.** In a Next app look under `app/**/route.ts`, `pages/api/**`; in Hono/Express look for `get('/health…`, `get('/ready…`; in Go/Rust/Django look for the health handler; in k8s read `readinessProbe.httpGet.path`. Follow what the handler actually reads.
- **If only a literal exists, add a readiness route.** Editing the project is allowed — you are the agent writing the file. The contract:

```
GET /readyz  ->  200 {"db":{"ok":true}}    when the dependency answers
             ->  503 {"db":{"ok":false}}   when it does not
```

  It must return a **non-200** and a **changed JSON field** on failure, and it must not leak a credential or an internal address. A six-line example (same contract in any framework):

```ts
app.get('/readyz', async (c) => {
  const dbOk = await db.ping().then(() => true, () => false)
  return c.json({ db: { ok: dbOk } }, dbOk ? 200 : 503)
})
```

  Then assert on it: `watcher add http-probe --id app --url https://app.example.com/readyz --expect-json '{"db.ok":true}' --found-at src/server/app.ts:<line> --read "readiness reads the primary database"`.
- **Never point a source at the Watcher's own `/healthz`.** `watcher doctor` rejects it with `source.self-probe`: the Watcher watching itself proves nothing about the project.

## Silence first: the checklist the scan misses

These six classes are where a file-glob scan loses recall. Work through them by **reading code**, not by globbing filenames. Each item becomes a `watcher add heartbeat` (push) or a `watcher add webhook --stale-after-sec` (a sender you don't control).

### 1. Schedules generated at install time

Look in `install.sh`, `install.mjs`, `setup.*`, `bootstrap`, a `Makefile`, any heredoc (`<<EOF`, `cat > … .plist`), and for `launchctl load`, `systemctl enable`, `crontab` writes. A plist or unit that is written by an installer never exists as a file to glob.

```bash
watcher add heartbeat --id nightly-sweep --every 24h --grace 1h \
  --found-at install.sh:41 --read "install.sh writes the 03:00 sweep plist"
```

### 2. launchd / systemd / cron created at runtime

Look for `OnCalendar=`, `StartInterval`, `KeepAlive`, `launchd`, `.plist` templates, crontab strings in code, `node-cron`, `schedule(`, `setInterval` around a job, `APScheduler`, `celery beat`. Add one heartbeat per job, with the schedule it really runs on (`--schedule "<cron>"` or `--every <dur>` plus a `--grace` above its normal jitter). One heartbeat source is one job: N jobs means N sources, so a missed run names the job that missed.

### 3. Pull-queue workers

Look for `worker`, `queue`, `bullmq`, `sqs`, `claim`, `lease`, `dequeue`, a `for (;;)` loop, a render or sync worker. Its failure mode is **queue depth or no progress**, not a closed port. Add a heartbeat at the success path; if the worker can report depth, have it push a `checks.list` entry (`POST /ingest/<source>` with a `checks` object) — a depth threshold is not an `--expect-json` assertion, because `expectJson` compares for equality.

### 4. Staleness declared in the product's own config

Look for `staleAfterSec`, `presenceTtlSec`, `maxAge`, `ttl`, `refreshInterval`, `lastRunAt`, `last_run` in the product's JSON/YAML/TS config. If the product already declares how long silence is allowed, the Watcher should enforce the same window:

```bash
watcher add webhook --id collector --token-env WATCHER_INGEST_COLLECTOR_TOKEN --stale-after-sec 3600
```

Silence now raises a `SourceStale` incident (a page for a push source with `--stale-after-sec`). Set `presenceTtlSec` above the sender's longest normal gap so its alerts do not flap off between pushes.

### 5. State-directory writability

Look for `mkdir`, `state/`, `data/`, `tmp`, `writeFile`, a sqlite path, a lock file. A disk that goes read-only or full breaks the product before any port does. The check belongs where the write happens: have the code that writes ping a heartbeat only after a successful write, or push a `checks` entry with `state: failing` on a write error. A bare `test -w` on the host is not a Watcher source.

### 6. Dependency endpoints held as code constants

Look for `process.env.X ?? 'https://…'`, `new URL('…')`, host:port literals, `clickhouse`, `postgres://`, a gRPC target, an LLM API base. A URL in code is invisible to a config scan:

```bash
watcher add http-probe --id llm --url https://api.example.com/health --found-at src/llm.ts:18 --read "the model client's hardcoded base URL"
watcher add tcp-probe  --id cache --host cache.example.com --port 6379 --found-at src/cache.ts:9 --read "the cache client's constant endpoint"
```

### 7. Routes dispatched through a variable

An inbound route chosen by a table lookup or `if route == "…"` (a handler map, a bridge) hides its path from a literal scan. If an external sender pushes to it, add a webhook source with `--stale-after-sec` and the expected cadence, so a sender that stops is a page.

### The ping

Every heartbeat needs the ping at the job's **success** path. `watcher add heartbeat` mints the token into `.watcher/.env` (0600) when the named variable has no value yet — or writes the `--secret-value` you give it — and prints the exact URL, the token variable and the three forms. The shape is `POST /ingest/heartbeat/<id>`, with `/fail` for a failed run and `/<exit-code>` for a specific one (`$NIGHTLY_TOKEN` below is the name it picks for `--id nightly`; a `--token-env` you pass is the variable it prints instead):

```sh
set -a; . .watcher/.env
curl -fsS -m 10 "${WATCHER_URL:-http://127.0.0.1:7717}/ingest/heartbeat/<id>?token=$NIGHTLY_TOKEN"                 # after a successful run
curl -fsS -m 10 "${WATCHER_URL:-http://127.0.0.1:7717}/ingest/heartbeat/<id>/fail?token=$NIGHTLY_TOKEN"            # after a failed run
curl -fsS -m 10 "${WATCHER_URL:-http://127.0.0.1:7717}/ingest/heartbeat/<id>/<exit-code>?token=$NIGHTLY_TOKEN"     # with the job's exit code
```

```js
await fetch(`${process.env.WATCHER_URL ?? 'http://127.0.0.1:7717'}/ingest/heartbeat/<id>?token=${process.env.NIGHTLY_TOKEN}`)
```

```py
import os, urllib.request
req = urllib.request.Request(f"{os.environ.get('WATCHER_URL', 'http://127.0.0.1:7717')}/ingest/heartbeat/<id>?token={os.environ['NIGHTLY_TOKEN']}", method="POST")
urllib.request.urlopen(req, timeout=5).read()
```

The token as `Authorization: Bearer $NIGHTLY_TOKEN` is accepted too; the query form is what `add` prints, and it is the one a job that only has a URL can send.

Put the ping after the job's own work, not before it: a job that throws before reaching the ping is a missed run, which is exactly what you want to see.

## The signal catalogue

D = deterministic (the scan can emit it). A = needs judgment (you, reading code). The "Watch it with" column names the Watcher check; `--found-at` on every row is what makes the source traceable.

| # | Signal (where it is) | What it means | Watch it with | D/A |
| --- | --- | --- | --- | --- |
| 1 | `package.json` dependency `next` | There is a running web app; a health route likely exists at `/api/health` or `/healthz` | `http-probe` | D for "HTTP app"; A for the path |
| 2 | dependency `express`, `hono`, `fastify`, `koa` | Same, plus mount paths in source | `http-probe` | A (the route is code, not config) |
| 3 | dependency `prisma`, `pg`, `postgres`, `mysql2`, `mongoose` | The app needs a database; DB up is app up | `http-probe` with `--expect-json '{"db.ok":true}'` | A (only if the readiness route reports it) |
| 4 | dependency `redis`, `ioredis`, `bullmq`, `@upstash/redis` | A cache or queue; a stalled queue is invisible to a GET | `heartbeat` from the worker, or a `checks` push | A |
| 5 | dependency `stripe` | Payments; webhooks must be received | `webhook` + an `http-probe` on the endpoint (expect 400 without a signature) | D for presence; A for the expected status |
| 6 | env `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Webhook verification is configured | `webhook` source with `--stale-after-sec`; key rotation is out of scope | D (name match only) |
| 7 | env `DATABASE_URL`, `REDIS_URL`, `MONGO_URL`, `PG*` | A managed service is in the path | `tcp-probe` on host:port, or a `netdata-cloud` source | D for host/port; A for reachability |
| 8 | env `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` | Error tracking already exists; read it, do not duplicate it | `sentry` | D |
| 9 | dependency `@sentry/*` | Same | `sentry` | D |
| 10 | env `*_WEBHOOK_SECRET` | An inbound webhook exists; silence means the integration is dead | `webhook` with `--stale-after-sec` | D |
| 11 | `Dockerfile` `HEALTHCHECK … CMD curl -f http://localhost<path>` | The container already declares what "healthy" means | `http-probe` with the path and port lifted from it | D; A if the command is a script |
| 12 | `compose.y*ml` `services.<n>.healthcheck.test` | Same, per service | `http-probe` | D |
| 13 | `compose.y*ml` `services.<n>.ports` | Published ports are candidate endpoints | `http-probe`, or `tcp-probe` for a port with no HTTP | D for the port; A for the path |
| 14 | compose `depends_on.<svc>.condition: service_healthy` | A hard dependency | Probe the dependency first | D |
| 15 | k8s `livenessProbe` / `readinessProbe` / `startupProbe` `httpGet.path` + `port` | The manifest names the health route | `http-probe` with the same path | D |
| 16 | k8s `tcpSocket` / `grpc` probe | A port that must accept connections | `tcp-probe` for `tcpSocket`; a gRPC health check is a gap in v0 | D |
| 17 | Health-route literals `/health`, `/healthz`, `/health/live`, `/health/ready`, `/api/health`, `/api/healthz`, `/status` | The app's own health contract | `http-probe` with the route's real JSON | A (confirm it answers 200 and is not a literal) |
| 18 | `vercel.json` `crons:[{path,schedule}]` | A scheduled job that must run | `heartbeat` (`--schedule`, grace ≈ 2× period) | D for the schedule; A for the grace |
| 19 | `wrangler.toml` `[triggers] crons=[…]` | Same | `heartbeat` | D |
| 20 | k8s `CronJob.spec.schedule` + `startingDeadlineSeconds` | Same | `heartbeat` | D |
| 21 | `.github/workflows/*.yml` `on.schedule[].cron` | A scheduled CI job | `heartbeat` + a CI status feed | D |
| 22 | systemd `.timer` `OnCalendar=` firing a `.service` | Same | `heartbeat` | D |
| 23 | systemd `.service` `Restart=`, `ExecStart=` | A long-running unit that must stay up | `netdata-cloud` `systemdunits`, or a `checks` push | D; A for "should it page" |
| 24 | `.github/workflows/*.yml` (any) | CI is the deploy gate | `feed` polling `gh run list --branch main --limit 1` | D |
| 25 | Webhook receivers in source (`/api/webhooks/*`, `/webhooks/*`) | An inbound integration that can silently stop | `webhook` with `--stale-after-sec` | D for the path; A for the cadence |
| 26 | Domains in config (`baseUrl`, `APP_URL`, `NEXTAUTH_URL`, `route.pattern`, nginx `server_name`, fly app name) | TLS and DNS expiry | `http-probe` (CertExpiring 14 d warn / 3 d page) + `domain-expiry` | D for the domain; A for apex vs subdomain |
| 27 | `wrangler.toml` route / `workers_dev` | The Worker's public hostname | `http-probe` | D |
| 28 | `fly.toml` `[http_service] internal_port` + `[[http_service.checks]] path` | The platform already runs a check; mirror it | `http-probe` | D |
| 29 | `railway.json` / `railway.toml` `deploy.healthcheckPath` | Same | `http-probe` | D |
| 30 | `netlify.toml`, `render.yaml` `healthCheckPath` | Same | `http-probe` | D |
| 31 | Netdata present on the host (agent dir, `netdata` service, `app.netdata.cloud` in config) | Host metrics already exist; do not duplicate them | `netdata-cloud` / `netdata-fleet` (see `watcher skills netdata`) | D |
| 32 | Prometheus/VictoriaMetrics endpoint in config | Rules already exist | `vmalert` + `grafana` | D |
| 33 | Grafana URL + API token env | Dashboards and alerts already exist | `grafana` | D |
| 34 | `*.tf` with `aws_db_instance`, `google_sql_database_instance` | Managed infra with its own health | The provider's own metrics (out of scope in v0) | A |
| 35 | compose service with no healthcheck | The app has no health contract | Synthetic HTTP/TCP probe, or add a readiness route | A (invent one) |

## What not to watch

- **The Watcher itself.** `source.self-probe` is rejected by `watcher doctor`.
- **The same signal twice.** If Grafana already pages for a rule, do not add an HTTP probe of the same URL; watch the silences Grafana cannot see.
- **A liveness-only route as the only source.** The install is not green until one source carries a predicate that can flip.
- **Dev, test and QA manifests as production.** A held-out corpus had a k8s QA namespace that replicated the production shapes and looked real. Scope by path and by environment.
- **`.env` values.** Read key names only. A secret in the config is a leak; every credential is an env-var name.

## After discovery: write down why

Every `watcher add` takes `--found-at <file:line>` and `--read "<what this proves>"`. `watcher doctor` warns `source.untraced` when they are missing and `source.provenance-weak` when the named file does not mention the URL path or job. The install gate rests on `watcher doctor --prove`, not on provenance — but a source nobody can trace is a source the next agent will delete.
