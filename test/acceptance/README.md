# Acceptance harness

Two runs over the same fixture, measuring the claim in the README: an agent installs the Watcher from one prompt and proves it
works.

| Run | Who drives it | What it proves | When |
| --- | --- | --- | --- |
| `run.mjs` | a script, no model | the command sequence `SKILL.md` teaches still reaches `{"ok": true, "live": true}` | every CI run |
| the real-agent run (below) | Claude Code or Codex, given the README prompt | an agent that has never seen this repo can do it from the prompt alone | before a release, periodically |

## The deterministic transcript

```bash
node test/acceptance/run.mjs              # uses this tree's bin/watcher.mjs
node test/acceptance/run.mjs --cli /path/to/bin/watcher.mjs   # or another checkout's CLI
node test/acceptance/run.mjs --from-tarball   # npm pack, install it into a temp prefix, use that bin
node test/acceptance/run.mjs --from-git git+file:///path/to/ezo-watcher.git   # a git install, into a temp prefix
```

`--from-tarball` is the release path: it runs `npm pack` in this tree, installs the tarball the way
`npm i -g <tgz>` does, and runs the whole transcript with the installed bin. Use it before a release:
a package that only works from a checkout fails there, and nowhere else.

`--from-git <spec>` is the same idea for the documented one-liner: it runs `npm i -g --install-links <spec>` (a temp
prefix and cache) and the whole transcript with that bin. It refuses a package that arrived as a symlink into npm's
cache — the npm 11 defect where a git dependency with a build script is linked to the clone npm then deletes, leaving
`<prefix>/bin/watcher` dangling. Point it at a local bare mirror of a commit you have not pushed:

```bash
git clone --bare --no-local . .tmp/mirror.git   # run from the repository root
node test/acceptance/run.mjs --from-git "git+file://$PWD/.tmp/mirror.git"
```

After landing, the release check against the real remote is
`node test/acceptance/run.mjs --from-git github:ezolabs/ezo-watcher`.

Every mode copies [`fixture/`](fixture/) to a temp project under `.tmp/`, starts the fixture app, and then runs exactly what
[`skills/ezo-watcher/SKILL.md`](../skills/ezo-watcher/SKILL.md) tells an agent to run:

1. `watcher init` — the install exists, the secrets file is 0600;
2. `watcher scan --json` — the scan finds the readiness route and the crontab;
3. `watcher add http-probe` on `/readyz` asserting `db.ok`, and `watcher add heartbeat` for the job in the crontab;
4. `watcher add channel webhook` pointing at the fixture, so a page can be observed end to end;
5. `watcher run --detach`, then the job pings its heartbeat;
6. `watcher doctor --live --prove --json` → `{"ok": true, "live": true}`;
7. `/api/state` shows the source asserted something and records `discovered.foundAt`;
8. `git status` in the project shows writes only under `.watcher/` — nothing a person had to type;
9. [`negative.mjs`](negative.mjs) flips the fixture's `db.ok` flag: the incident fires, `watcher incidents --json` lists it, the
   page reaches the channel, and both clear when the flag recovers;
10. a probe pointed at the Watcher's own `/healthz` is named `source.self-probe`.

Every assertion prints `PASS` or `FAIL`; the run exits 1 if any failed. Set `KEEP_ACCEPTANCE=1` to keep the temp project (the
script prints its path) for inspection after a failure.

The fixture is deliberately small: `GET /healthz` answers a constant (the decoy — a probe there proves liveness only),
`GET /readyz` derives `db.ok` from a file beside the script and answers 200 or 503, `job.mjs` pings its heartbeat after a
successful run, and `crontab` is the schedule the scan must find. The CLI builds its web bundle on first `watcher run` if
`dist/web` is absent, so the first transcript on a fresh checkout takes a little longer; that is the real install path.

If `bin/watcher.mjs` is not in the tree (the CLI ships separately), the transcript prints `SKIP` and exits 0. A green run of
this script without the CLI proves nothing — read the SKIP line.

## The real-agent run

This is the release gate: a coding agent, given only the README prompt, installs the Watcher into a project it has never seen.
It is not run in CI (a model in the loop is not deterministic and not cheap).

1. Copy `fixture/` to a fresh directory and `git init` it, so the agent starts where a user does.
2. Start a headless agent in that directory with the prompt from the README's "Give this to your agent", unchanged.
   For Claude Code:

   ```bash
   claude -p "$(sed -n '/^## Give this to your agent/,/^## What it sets up/p' README.md | sed '1d;$d')" \
     --allowedTools 'Bash,Read,Write,Edit' --max-turns 60
   ```

   (Run from the repository root first to export the prompt, or paste the block from the README by hand.)
3. Score the run with the same assertions the transcript makes:

   ```bash
   node test/acceptance/negative.mjs --project <the agent's project> \
     --base http://127.0.0.1:<the port its .watcher/.env names> --token <WATCHER_ADMIN_TOKEN from .watcher/.env>
   ```

   plus `cd <the agent's project> && watcher doctor --live --prove --json` from the installed CLI.

Passing means `ok:true live:true`, the negative run's four assertions, and a `git status` that shows nothing outside `.watcher/`
and the agent's own source edits (a real project's changes are the agent's work; the fixture's are not). Record the run's
transcript next to the release notes — a claim of "one-prompt install" is only worth what the last measurement says.

The periodic run exists because the model, the skill and the CLI drift independently. Run it before tagging a release, and
after any change to `SKILL.md`, `README.md`'s prompt or the CLI's verbs.
