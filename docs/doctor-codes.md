# `watcher` doctor codes

Every check `watcher doctor` emits, and every error a verb can exit with. Codes are dotted and
stable: a transcript, a script or an agent matches on them. `next` (on `fail` and `warn`) is the
exact command or edit that repairs the finding.

## How this CLI runs

From a repo checkout, `bin/watcher.mjs` imports `src/cli/main.ts` and lets Node's native type
stripping execute it. That is why `src/` stays inside the strip-only TypeScript subset (no `enum`, no
constructor parameter properties): type stripping is unflagged from Node 22.18 and 23.6, and Node 24
or newer is the supported line (`engines` in `package.json`). An installed package
(`npm i -g --install-links github:ezolabs/ezo-watcher`, a tarball or `npx`) runs the esbuild bundles instead —
`dist/cli/main.mjs` and `dist/server/main.mjs` — because Node refuses type stripping under
`node_modules`; the package's `prepack` builds them. From the checkout `watcher run` loads
`.watcher/.env` with `process.loadEnvFile` and then imports `src/server/main.ts` directly; if the web
bundle is missing it is built once with vite and the run says so. Docker runs `dist/server/main.mjs`
too.

## Exit codes and output

| exit | meaning |
|---|---|
| 0 | the verb succeeded, or doctor found no failure (warnings and skips are not failures) |
| 1 | a check failed, or a write was refused by the validator |
| 64 | a usage mistake (unknown verb/flag, missing value, bad `--output`) |

`--output json|md|table` (`--json` is `--output json`) sets the shape of every read verb. In json
mode an error is one document: `{"ok":false,"error":{"code","message","next?"}}`. No verb prompts.

The doctor JSON:

```json
{
  "ok": true,
  "target": "local",
  "live": false,
  "checks": [{ "code": "config.valid", "status": "pass", "message": "…" }]
}
```

`status` is `pass`, `fail`, `warn` or `skip`. `ok` is false when any check failed, and also when a
**required** source was skipped for a missing credential. The third verdict, documented below, is
`{"ok":true,"live":false,"reason":"no-runtime-surface"}`.

## Doctor checks, in order

| code | when | status | what it means |
|---|---|---|---|
| `node.version` | always | pass/fail | Node 24+ is required for native type stripping |
| `watcher.dir` | always | pass/fail | `.watcher/` exists; otherwise run `watcher init` |
| `config.valid` | always | pass/fail | `.watcher/config.json` parses and passes the server's `validateConfig` |
| `config.missing` | config absent | fail | no config file |
| `config.unreadable` / `config.invalid` | read/validate | fail | the file cannot be read or the validator refused it |
| `env.present` | always | pass | every env-var NAME a required source or a channel references is set |
| `env.missing` | a required secret is unset | fail | a required source's or a channel's credential, or the server's own secret, is missing (an optional source's is `source.credential-skip`, not this) |
| `env.mcp-token-missing` | `WATCHER_MCP_TOKEN` unset | warn | the server runs, but `/mcp` answers 401 |
| `env.not-ignored` | git work tree | pass/fail | `.watcher/.env` must be git-ignored; a committed secret is leaked |
| `data.writable` / `data.unwritable` | always | pass/fail | the resolved data dir can be written (never a bare `/data` unless the config says so) |
| `port.free` | nothing on the port | pass | the port is available |
| `server.up` | this Watcher answers | pass | the port already holds this Watcher (brand matches) |
| `port.in-use` | another process holds it | fail | the port is taken by something that is not this Watcher |
| `channel.missing` | no channel configured | warn | an incident reaches the wall and nobody else; add one |
| `channels.configured` | a channel is configured | pass | the channels a page can reach |
| `config.hand-edited` | `_meta` present | pass/warn | the sources/channels changed since `watcher add` wrote them; hand edits are allowed, just reported |
| `source.self-probe` | a source URL is the Watcher's own host:port | fail | the probe proves the Watcher answers, not the project |
| `source.credential-skip` | a source's `*Env` is unset | skip | the server will not poll it; a skipped **required** source makes `ok:false`, a skipped **optional** one does not |
| `source.untraced` | `discovered.foundAt` absent | warn | nothing says where the endpoint was found (the gate is `--prove`, not this) |
| `source.provenance-weak` | the foundAt file is missing or does not mention the URL path | warn | the provenance claim does not check out |
| `bundle.absent` | no built `dist/web` | skip | the API still runs; the wall answers "app not built" |
| `bundle.clean` | a built bundle exists | pass | no configured source host:port or env-var NAME appears in it |
| `bundle.config-leak` | a built bundle exists and carries one | fail | the web bundle contains server config |
| `server.down` | `--live`, nothing on `/healthz` | fail | start it with `watcher run --detach` |
| `server.healthz` | `--live` | pass | `/healthz` answered 200 |
| `server.auth` | `--live`, `/api/state` answers 401 | fail | `WATCHER_ADMIN_TOKEN` in `.env` does not match the server's |
| `auth.token-missing` | a request carries a proxy/tunnel header or a non-loopback Host and no admin token is set | 403 | the wall would be open through the tunnel; set `WATCHER_ADMIN_TOKEN` |
| `server.api` | `--live`, `/api/state` is not 200 JSON | fail | read the server log |
| `source.unverified` | `--live`, a source never polled (or a proof had no good answer) | fail | wait a poll interval, then re-run |
| `source.error` | `--live`, a source is erroring | fail | fix the URL or credential the error names |
| `source.stale` | `--live`, a source missed `staleAfterMisses` polls | fail | check the source; raise `staleAfterMisses` only if its cadence is legitimately slow |
| `source.bare-200` | `--live`, a polled source asserts only a nominal 200 | fail | add `--expect-json` with a dependency-gated path |
| `source.live` | `--live` | pass | the source is polled and asserts something |
| `source.proven` | `--prove` | pass | a mutation of the last good answer, or a reading moved past the rule's own threshold, turned the rule red |
| `source.assertion-not-red` | `--prove` | fail | a mutation left every assertion green: the assertion is a constant, or a kind's rule could not be made to fire |
| `source.assertion-vacuous` | `--prove`, no declared path present | fail | nothing an http-probe target asserts can fail (F10: a predicate must name a present path, compare a non-null literal, and flip) |
| `source.prove-unsupported` | `--prove`, a kind with no evaluator | skip | grafana, vmalert, sentry, netdata, feed and a webhook source's pushed alerts: the alert is what its sender reports, so there is nothing to mutate |
| `cloudflare.credentials` | `--target cloudflare` | fail | `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are both required |
| `cloudflare.token-valid` / `cloudflare.token-invalid` | `--target cloudflare` | pass/fail | `GET /user/tokens/verify` |
| `cloudflare.cloudflared` / `cloudflare.cloudflared-missing` | `--target cloudflare`, and `cloudflare quick/tunnel` | pass/fail | `cloudflared` must be on PATH to run the tunnel |
| `cloudflare.tunnel` | `--target cloudflare` | pass | the `watcher-<project>` tunnel exists and is healthy |
| `cloudflare.tunnel-missing` | `--target cloudflare` | skip | no tunnel yet; `watcher cloudflare tunnel --hostname` creates it |
| `cloudflare.tunnel-unhealthy` | `--target cloudflare` | fail | the tunnel exists but has no healthy connection |
| `cloudflare.hostname-missing` | `--target cloudflare` | skip | the tunnel has no hostname ingress yet |
| `cloudflare.zone-missing` | doctor or `cloudflare tunnel` | fail | the hostname's apex zone is not on this account |
| `cloudflare.dns` | `--target cloudflare` | pass/fail | a proxied CNAME to `<tunnel-id>.cfargotunnel.com` must exist |
| `cloudflare.ingress` | `--target cloudflare` | pass | the ingress maps the hostname to the local Watcher port |
| `doctor.no-runtime-surface-ignored` | `--no-runtime-surface`, and something to watch exists | warn | the flag is ignored: a configured source (any kind, `host` included) or a surface the scan finds makes the project watchable; the report is evaluated live normally |
| `doctor.scan-failed` | `--no-runtime-surface`, and the scan throws | warn | the scan could not run, so the flag cannot tell "nothing found" from "not scanned"; the row names the error and the verdict stays off |

The server's own `GET /api/doctor` rows (the running process knows its last probe answers) are
merged into the `--live` report verbatim. Its codes are part of the same dotted vocabulary:
`source.untraced`, `source.bare-200`, `source.self-probe` and `source.assertion-not-red` (the
only one of the four that fails). The CLI writes and documents the same names.

## The three verdicts

1. **Green**: `ok:true`, exit 0. No failure; warnings/skips allowed. `--prove` is the gate: a
   project with an http-probe source must have at least one predicate that can go red.
2. **Red**: `ok:false`, exit 1. A failing check; each carries `next`.
3. **No runtime surface**: `{"ok":true,"live":false,"reason":"no-runtime-surface"}`, exit 0. Only
   with `--no-runtime-surface`, only when the port is free, the config names no source at all (a
   configured source is something the Watcher judges, and a `host` reads this machine, so the scan
   cannot see it), and the scan finds no server, schedule or inbound webhook. A configured source or a
   scan signal always wins over the flag: the report gains a `doctor.no-runtime-surface-ignored` warn
   naming what is watchable and is evaluated live normally. A scan that throws gains a `doctor.scan-failed`
   warn naming the error, and the verdict stays off: "nothing found" and "not scanned" never read the same.
   A `heartbeat` source is the fallback that *can*
   go red: a project with any scheduled job must reach `live:true`.

`doctor --live` reads `/api/doctor` and `/api/state` and never instantiates a source. `--prove`
reads the server where it must (an http-probe mutates the last good answer the server recorded; there is no
second poll of a target to fall back on) and otherwise moves the source's own reading past its threshold:

| kind | the proof |
|---|---|
| `http-probe` | flip the status, then each asserted JSON path, in the last good answer |
| `heartbeat` | take a healthy ok ping at now and evaluate the schedule after the next due run plus the grace: `HeartbeatDown` must fire |
| `host` | a reading with a disk at 0% free, memory at 0% available, load above the per-core warning, and a dead pid file when one is configured: each rule must fire |
| `tcp-probe` | `failAfter` failed connects in a row: `ProbeDown` must fire |
| `domain-expiry` | an expiration inside `pageDays`: `DomainExpiring` must fire |

A kind whose alert is what its sender reports (grafana, vmalert, sentry, netdata, feed, webhook) has no
evaluator to mutate: `source.prove-unsupported` is a named skip, never a fail. `live` still needs at least
one source proven (`proven > 0`) and none failed, so a project with only a push source is not live.

## Error codes by verb

**Usage (exit 64, prefix `usage.`)**: `usage.unknown-verb`, `usage.unknown-flag`,
`usage.missing-value`, `usage.missing-flag`, `usage.bad-number`, `usage.bad-json`, `usage.bad-output`,
`usage.bad-target`, `usage.bad-duration` (a heartbeat `--every`/`--grace` must be `30s`/`5m`/`2h`/`1d`),
`usage.bad-cron` (five fields), `usage.bad-timezone` (an IANA zone), `usage.missing-kind`,
`usage.missing-sub`.

**`add`**: `add.bad-id`, `add.duplicate-id` (re-run with `--replace` to rewrite that entry), `add.unknown-channel`, `add.inline-secret` (a secret on
the command line is refused; `--secret-value` writes it to `.watcher/.env`), `add.token-env-needed`,
`add.heartbeat-needs-cadence`, `add.domain-needed`, `add.bad-pair`, `add.bad-set`, `add.bad-header`,
`add.optional-channel` (`--optional` is a source flag), `add.no-secret-slot`, `add.heartbeat-needs-cadence`,
`add.heartbeat-two-cadences`, `add.heartbeat-timezone`, `config.invalid` (the server's validator refused the
resulting document).

**`rm`**: `usage.missing-id`, `rm.unknown-id` (the message lists the configured ids), `config.invalid`.

**`run` / `stop`**: `run.no-env`, `run.missing-secret`, `run.already-running`, `run.not-up`,
`run.spawn-failed`, `stop.no-pid`, `stop.bad-pid`, `stop.not-watcher` (the pid file names a process whose
command line is not this Watcher: the pid was reused, and nothing is signalled), `stop.denied` (the process
exists but cannot be signalled: not a user's process, or EPERM; the pid file is kept), `port.in-use`.

**`service`**: `service.unsupported`, `service.bin-missing`, `service.exists`.

**Server read verbs**: `server.down`, `server.auth`, `server.http`, `server.api`,
`test-alert.no-channel`, `test-alert.unknown-channel`, `test-alert.failed`, `mcp-config.unknown-client`.

**`skills`**: `skills.missing`, `skills.topic-missing`, `skills.bad-topic`, `skills.bad-target`,
`skills.exists` (re-run with `--force`).

**`telemetry`**: `telemetry.unknown-action` (exit 64), `telemetry.unwritable`.

**`cloudflare`**: `cloudflare.token-missing`, `cloudflare.account-missing`,
`cloudflare.hostname-missing`, `cloudflare.cloudflared-missing`, `cloudflare.zone-missing`,
`cloudflare.zone-check`, `cloudflare.api`, `cloudflare.tunnel-list`, `cloudflare.tunnel-create`,
`cloudflare.tunnel-config`, `cloudflare.tunnel-token`, `cloudflare.dns-list`,
`cloudflare.dns-create`, `cloudflare.dns-update`, `cloudflare.access-app`,
`cloudflare.access-policy`, `cloudflare.admin-token-missing` (a quick tunnel is public).

**The HTTP gate**: `auth.token-missing` (a 403 body from a loopback Watcher with no
`WATCHER_ADMIN_TOKEN` when the request carries a proxy/tunnel header or a non-loopback Host; set the token)
and `mcp.origin-rejected` (a 403 from `/mcp` when a browser Origin is neither this Watcher nor a configured
`embedOrigins` entry).

**Anything else**: `internal.error` (an unexpected exception; run `watcher doctor` and include the
message if it repeats).
