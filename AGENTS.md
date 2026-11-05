# AGENTS.md

Instructions for a coding agent working **in this repository**. For setting up monitoring in some *other* project, you want the skill at [`skills/ezo-watcher/SKILL.md`](skills/ezo-watcher/SKILL.md) — that is the product surface, not this file.

## What this repo is

EZO Watcher: an alert wall and pager that a coding agent installs into a project. One Node process, config as code in `.watcher/`, no account, no external database (`node:sqlite`). The `watcher` CLI and the web wall are the two supported interfaces; the CLI is how config is written, and it goes through the server's own validator. The server owns incidents; sources only return observations.

Read [`docs/design.md`](docs/design.md) before changing product behaviour. The short version: the wall is one screen; tile area and weight follow severity; a page is the only thing that reaches a phone; the install is not done until `watcher doctor --live --prove` returns `ok: true, live: true`.

## Set up

```bash
npm ci
npm run build          # vite build for src/web + esbuild bundle for the server
npm run typecheck      # tsc --noEmit, twice (app and service worker)
```

Node 24 or newer (see `engines` in `package.json`). ESM throughout; imports end in `.ts`. From the checkout the server runs under Node's native type stripping, so do not use TypeScript features that need a transform — no `enum`, no parameter properties, no namespaces (a parameter property is what broke the first run once; keep it that way). An installed package runs the bundled `dist/cli/main.mjs` and `dist/server/main.mjs` instead (Node refuses type stripping under `node_modules`), which is what `npm run build` produces; the web app needs the vite build either way.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Server under `--experimental-strip-types --watch` |
| `npm run dev:web` | Vite dev server for the wall |
| `npm run build` | Web assets + server bundle into `dist/` |
| `npm run typecheck` | Both tsconfigs |
| `npm test` | Vitest, whole suite (CI does this; locally prefer scoped files) |
| `npx vitest run test/<file>.test.ts` | One test file — the normal loop |
| `watcher run` | Start the real CLI/server from the checkout |

## Layout

| Path | What lives there |
| --- | --- |
| `bin/watcher.mjs` | The `watcher` executable; everything else is imported from `src/cli/` |
| `src/cli/` | One file per verb or verb family, dispatched by `main.ts`: `init`, `scan` (+ `signals/`), `add`, `remove` (`rm`), `doctor`, `run` (+ `stop`), `service`, `status` (+ `incidents`, `test-alert`, `mcp-config`), `incident` (+ `recheck`), `mcp`, `hooks`, `skills`, `cloudflare`; `util.ts`, `output.ts` and `project.ts` are shared |
| `src/server/` | HTTP (`app.ts`, `main.ts`, `auth.ts`), the engine, sources, notify, MCP |
| `src/server/sources/` | One source kind per file; the `POLLED` record in `source-registry.ts` says which kinds the server polls |
| `src/shared/` | The alert model, the wall layout, the state function the wall and the pager share |
| `src/web/` | React + Tailwind wall, history, notifications, sources, embed |
| `skills/ezo-watcher/` | `SKILL.md` and `references/*.md` — the agent docs, shipped in the package |
| `addons/` | Optional packs (Netdata) |
| `deploy/` | Cloudflare Tunnel and the Containers beta template (`compose.yaml` and the `Dockerfile` sit at the root) |
| `docs/` | Design, MCP, embed, doctor codes |
| `test/` | Vitest; `test/fixtures/` holds recorded API answers |

## How to change things

- **Config goes through the validator.** `validateConfig(raw)` (exported from `src/server/config.ts`) is the only way a config becomes real; `watcher add` calls it before writing. Never hand-build config JSON in a command.
- **A new source kind is five touches, not one:** a `SourceKind` member, its config interface plus validator, a `POLLED` entry, its own file under `src/server/sources/`, and tests. Return observations; never raise incidents from a source — the engine does that.
- **A new CLI verb:** one file in `src/cli/`, registered in `src/cli/main.ts`, `--json` (or `--output json|md|table`) on every read/report verb, exit 0 / 1 / 64, no prompts.
- **The docs are a runtime surface.** `watcher skills <topic>` prints `skills/ezo-watcher/references/<topic>.md` from the installed package, so editing that file changes what every user's agent reads. Check a change from the checkout with `node bin/watcher.mjs skills <topic>`. Keep `SKILL.md` under 150 lines, keep its `name` equal to the directory name, and keep the `description` directive ("use when …") under 1024 characters. Reference files stay one level deep.
- **Do not rename a public verb or flag without changing the skill and the acceptance fixture in the same commit.** Agents have the old names memorised.
- **Auth is not optional off loopback.** `WATCHER_ADMIN_TOKEN` gates the wall and `/api`; `/healthz`, `/ingest/*` (per-source tokens), `/mcp` (`WATCHER_MCP_TOKEN`) and signed ack links keep their own auth. Anything that binds `0.0.0.0` without a token must refuse to start. A loopback server with no admin token still refuses a request that carries a proxy/tunnel header or a non-loopback Host — a hand-run tunnel must not open the wall. `/mcp` also validates a browser Origin (MCP Streamable HTTP, DNS rebinding) against the Watcher's own origin and `embedOrigins`.
- **No secret ever enters git.** Config holds env-var names; values live in `.watcher/.env`. Never log, echo or template a token value.

## Tests

- Vitest. Scope the run to the files you touched (`npx vitest run test/engine.test.ts test/whatever.test.ts`) — a broad run is slow and noisy. CI runs the whole suite.
- Unit tests inject `fetch` and a clock; they never touch the network. Use a temp directory, never `$HOME` or a fixed `$TMPDIR` name.
- Record an API answer into `test/fixtures/` rather than mocking a shape by hand.
- The one-prompt path has its own harness in `test/acceptance/` (a tiny fixture app, a deterministic command transcript, a negative run). If you change the CLI or `SKILL.md`'s loop, change the transcript with it.
- Bug fixes get a test that fails without the fix. Do not weaken an existing assertion to make a change pass.

## The leak gate

`node scripts/leak-scan.mjs` scans tracked files, commit messages and `dist/` for private IPv4, tailnet/CGNAT addresses, emails, absolute home paths, provider credential shapes, UUIDs that are not the fixture's synthetic shape and hostnames outside the allowlist; for each commit it reads, the author and committer names and emails too (GitHub's no-reply addresses pass tier 1; the login in one is tier 2's to judge). Tier 2 is a plain token list that never enters the tree: `LEAK_DENYLIST` (newlines) or `LEAK_DENYLIST_FILE` (a path), matched whole-word; an entry ending in `*` is a prefix (`abc*` also catches `AbcWedge` and `ABC_TOKEN`), which is how an internal naming family is listed without naming it here. `--require-denylist` makes a missing list exit 3 rather than passing; CI uses it on a push to main and a fork's pull request, which gets no secret, skips tier 2 with a printed note. `--history all|range|none` picks which commits (message and identities) are read: `all` (the local default), `range` (only the commits a push or pull request adds, from `--range` or `LEAK_HISTORY_RANGE`; a first push, whose before-sha is all zeros, reads all) or `none`. The config rule that catches a build-time config module in the client bundle reads `dist/web/**` only — `dist/cli/` and `dist/server/` are the process that reads that config.

Write for a stranger: no internal hostnames, no personal names, no customer data. The product name (EZO Watcher / ezo-watcher / ezolabs) is allowed; the infrastructure behind it is not.

### Public history

The repository is public. Its history starts at one squashed snapshot, because the private history before it named identifiers the scrubs removed. Commits are authored as `EZO Labs <352852198+ezo-labs[bot]@users.noreply.github.com>`; the leak scan reads every commit's message, author and committer, and the list lives only in the `LEAK_DENYLIST` repository secret (`gh secret set LEAK_DENYLIST -R ezolabs/ezo-watcher < <file>`), never in the tree.

## Voice and commits

- Human voice, terse, no AI attribution, no engagement bait. Comments explain why; the code says what.
- Commit subject imperative, at most 72 characters (`Keep trailing commas in parseList`), with a body that says what changed and why when the subject cannot. One concern per commit.
- Do not commit `.watcher/`, `dist/`, `node_modules/` or a `.env` file.

## Setting up monitoring somewhere else

The one prompt for another project is in [`README.md`](README.md#give-this-to-your-agent). It installs the CLI, installs this skill into that project, and runs the loop until `watcher doctor --live --prove --json` returns `ok: true, live: true`.

The documented install is the npm package: `npm i -g ezo-watcher`, or `npx -y ezo-watcher <verb>` with no install. The latest-main install from GitHub (`skills/ezo-watcher/references/install.md`) keeps `--install-links`. A git dependency with a build script makes npm 11 run a nested global install of its cache clone; with `install-links` off that install is a symlink to the clone, and npm deletes the clone when it finishes, leaving `<prefix>/lib/node_modules/ezo-watcher` and `<prefix>/bin/watcher` dangling. The flag is a workaround for npm's behaviour, not a preference: `test/acceptance/install-from-git.test.ts` fails a documented git install without it.

## Where to read more

- [`skills/ezo-watcher/SKILL.md`](skills/ezo-watcher/SKILL.md) — the install loop your users' agents run.
- [`skills/ezo-watcher/references/discover.md`](skills/ezo-watcher/references/discover.md) — the signal catalogue and the silence checklist.
- [`docs/design.md`](docs/design.md) — why the wall looks and behaves as it does.
- [`docs/mcp.md`](docs/mcp.md) — the MCP tools and their etiquette.
- [`docs/doctor-codes.md`](docs/doctor-codes.md) — every doctor code and its `next`.
- [`llms.txt`](llms.txt) — the index an agent reads first.
