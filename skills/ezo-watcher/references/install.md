# Install

EZO Watcher is one CLI (`watcher`) that runs one Node process and keeps its state in a `.watcher/` directory inside your project. There is no account, no hosted service and no database to install.

## What you need

- Node.js 24 or newer (`node --version`). An installed package runs bundled JavaScript (`dist/cli/main.mjs` and `dist/server/main.mjs`, built by the package's `prepack`); from a checkout the same files run as TypeScript under Node's type stripping. Either way there is no build step for you to run.
- npm 10+.
- Network access to the npm registry. The latest-main install below also needs git and github.com.

Not needed: Docker, a database, a browser, or any credential. A credential is needed only when a source or channel you choose has one.

## Install the CLI

```bash
CI=1 npm_config_yes=true npm i -g ezo-watcher
watcher --version
```

The prefixes matter when an agent runs it: `CI=1` and `npm_config_yes=true` answer npm's confirmation prompts.

Without a global install, `npx -y ezo-watcher <verb>` runs the same CLI from the registry:

```bash
CI=1 npm_config_yes=true npx -y ezo-watcher init
```

Latest main, straight from GitHub (unreleased changes; needs git):

```bash
CI=1 npm_config_yes=true GIT_TERMINAL_PROMPT=0 npm i -g --install-links github:ezolabs/ezo-watcher
```

`GIT_TERMINAL_PROMPT=0` makes a missing GitHub credential fail immediately instead of waiting for a username that no agent will type. `--install-links` is part of the git command, not a preference. A git dependency that declares a build script (`prepare`, `prepack`, `preinstall`, `build`, `install` or `postinstall` — this package has `prepare`) makes npm 11 run a nested global install of the clone it made under its cache, and with `install-links` off that nested install reifies the package as a symlink to the clone instead of packing it. npm deletes the clone when the install ends, so `<prefix>/lib/node_modules/ezo-watcher` is left a dangling symlink and `<prefix>/bin/watcher` with it. `--install-links` makes npm pack the prepared clone into a tarball and install a real package directory, which is what a global install should be.

From a checkout (contributing, or pinning a commit):

```bash
git clone https://github.com/ezolabs/ezo-watcher.git
cd ezo-watcher
CI=1 npm_config_yes=true npm ci
npm run build
CI=1 npm_config_yes=true npm link      # puts `watcher` on PATH
```

From a packed tarball — the path a release is tested through — or the repository without the registry:

```bash
CI=1 npm_config_yes=true npx -y ./ezo-watcher-0.1.0.tgz init     # a local `npm pack` artifact
CI=1 npm_config_yes=true npx -y github:ezolabs/ezo-watcher init  # straight from the repository
```

## First command in a project

```bash
cd /path/to/your/project
watcher init
```

`watcher init` is idempotent and never prompts: re-running it keeps existing secrets and config and reports what already exists. It writes:

```
.watcher/config.json     committed   brand, sources, channels, routes — monitoring as code
.watcher/.env            0600        generated secrets; gitignored
.watcher/.env.example    committed   the env-var names only, never values
.watcher/data/           gitignored  sqlite, logs, pid
```

It picks a free port starting at 7717 and writes `WATCHER_PORT` to `.watcher/.env`; the default bind is `127.0.0.1` (`WATCHER_HOST`). It appends `.watcher/.env` and `.watcher/data/` to the project's `.gitignore` (creating the file if absent) and verifies the ignore. Then it prints a doctor summary. Never commit `.watcher/.env` or `.watcher/data/`.

## Install the skill so future sessions know the loop

```bash
watcher skills install --target all --dir .
```

`--target` is `claude` (`.claude/skills/ezo-watcher/`), `codex`, `cursor` or `agents` (`.agents/skills/ezo-watcher/`), or `all`. Add `--force` to overwrite an older copy. The command's last line prints the host's reload step; in Claude Code run `/reload-skills`, because a top-level skills directory created mid-session is not picked up otherwise. Follow that step, then continue.

## Everyday commands

| Command | What it does |
| --- | --- |
| `watcher init` | Create or repair `.watcher/` |
| `watcher scan --json` | List candidate telemetry points in this project (read-only; never writes config) |
| `watcher add <kind> ...` | Add one source, validated; `--dry-run` previews, `--optional` skips it when its credential is absent, `--replace` rewrites an existing id |
| `watcher add channel <type> ...` | Add one alert channel and a default route to it if none exists; `file` needs no credential |
| `watcher rm <id>` | Remove one source or channel; a removed channel is taken out of every route that named it |
| `watcher doctor --json` | Check the config, secrets, data dir, port and (with `--live`) the running server |
| `watcher run --detach` | Start the server in the background; `watcher stop` ends it |
| `watcher service install` | Run it under launchd (macOS) or systemd --user (Linux) so it survives reboot |
| `watcher status` / `watcher incidents` | Read the running server; `--output json\|md\|table` |
| `watcher test-alert` | Send a test message through every configured channel |
| `watcher mcp-config --client claude\|cursor\|codex` | Print the MCP registration for this Watcher |
| `watcher skills [topic]` | Print a topic's documentation from this same install |
| `watcher cloudflare tunnel --hostname <h>` | Publish it on a hostname (see `watcher skills cloudflare`) |

Every read/report verb accepts `--json` (or `--output json|md|table`). Exit codes are `0` for a pass, `1` for a failed check and `64` for a usage error, so a script can branch on them.

## Upgrading, stopping, removing

```bash
CI=1 npm_config_yes=true npm i -g ezo-watcher@latest   # upgrade in place
watcher stop                                            # stop a detached run
watcher service uninstall                               # remove the service, if installed
```

Deleting `.watcher/` removes the project's monitoring config and its history; `.watcher/config.json` is meant to be committed so the config survives a lost host. `.watcher/data/` holds the 30-day incident history and can be backed up like any sqlite file.

## Troubleshooting the first run

- `watcher: command not found` — the global bin directory is not on `PATH`; check `npm prefix -g` (the bin is `<prefix>/bin`) or run through `npx`.
- `watcher` exists but fails with "the CLI source is missing", or `<prefix>/lib/node_modules/ezo-watcher` is a symlink into npm's cache (`_cacache/tmp/git-clone…`) — that is a git install made without `--install-links` on npm 11: npm linked the clone and then deleted it. Reinstall with `npm i -g ezo-watcher`, or the git form with `--install-links` shown above.
- npm asks to confirm an install — use the `CI=1 npm_config_yes=true` prefix shown above.
- `secret.missing` — a source or channel names an env var that `.watcher/.env` does not set. Run `watcher doctor --json` and read that check's `next`; it names the variable. An optional source (`--optional`) is a `source.credential-skip` instead and does not fail the report; add the line to `.watcher/.env` when the credential arrives.
- No credential for any channel — `watcher add channel file --id local` is the credential-free fallback, and `watcher test-alert --channel local` proves it.
- `port.in-use` — something other than this Watcher holds `WATCHER_PORT`; pick another port in `.watcher/.env` or stop the other process.
- `data.unwritable` — the check prints the resolved data directory; fix its permissions or point `WATCHER_DATA_DIR` at a writable path.
