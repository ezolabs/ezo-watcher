// The deterministic half of the one-prompt acceptance metric: run the exact command sequence SKILL.md teaches, with no
// model in the loop, against a tiny fixture app, and require the install to reach `{"ok": true, "live": true}`.
//
//   node test/acceptance/run.mjs [--cli <path to bin/watcher.mjs>] [--from-tarball] [--from-git <spec>]
//
// `--from-tarball` packs this tree (`npm pack`), installs the tarball into a temporary prefix the way
// `npm i -g <tgz>` does, and runs the transcript with the installed bin: the install path, not the
// checkout. Without it the transcript runs this tree's bin/watcher.mjs.
//
// `--from-git <spec>` installs a git ref the way the README's one-liner does — `npm i -g --install-links <spec>`
// into a temporary prefix and cache — and runs the transcript with that bin. Point it at a local bare mirror
// (`git+file:///path/to/repo.git`) or, once the branch is pushed, at `github:ezolabs/ezo-watcher`. It fails
// loudly when the installed package is a symlink into npm's cache, which is the npm 11 git-install defect
// `--install-links` avoids.
//
// What it proves, each line a PASS or a FAIL:
//   - the scan finds the readiness route and the scheduled job;
//   - `watcher add` writes the sources and one channel through the validator, and `watcher init` leaves a working install;
//   - `watcher doctor --live --prove` reaches ok:true live:true with the app answering and the assertion able to go red;
//   - /api/state says the source asserted something and recorded where it was found;
//   - the install wrote nothing a person had to type outside .watcher/ (git status);
//   - the negative run (negative.mjs): a red field fires an incident, pages the channel, and resolves when it recovers;
//   - a probe pointed at the Watcher itself is named `source.self-probe`.
//
// The live real-agent run (Claude Code or Codex given README's prompt) is the release gate; this transcript is the smoke
// test that keeps the skill's commands honest between those runs. See README.md.
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import {
  Checks,
  ROOT,
  cliPath,
  finishRun,
  freePort,
  gitStatus,
  httpJson,
  makeProject,
  readEnvFile,
  removeProject,
  run,
  runCli,
  runCliJson,
  sleep,
  tail,
  waitFor,
  workDir
} from './lib.mjs'
import { runNegative } from './negative.mjs'

const value = (argv, name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

/** The line in a file that carries `needle`, for `--found-at`. */
function lineOf(file, needle) {
  const lines = readFileSync(file, 'utf8').split('\n')
  const at = lines.findIndex((line) => line.includes(needle))
  return at >= 0 ? at + 1 : 1
}

function startFixture(project) {
  const child = spawn(process.execPath, [join(project, 'server.mjs')], {
    cwd: project,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const ready = new Promise((done, fail) => {
    let buffered = ''
    const timer = setTimeout(() => fail(new Error(`the fixture app did not report a port in 10 s: ${stderr}`)), 10_000)
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      const m = /FIXTURE_PORT=(\d+)/.exec(buffered)
      if (m) {
        clearTimeout(timer)
        done({ port: Number(m[1]), child })
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      fail(new Error(`the fixture app exited ${code}: ${stderr}`))
    })
  })
  return ready
}

/**
 * Pack this tree and install the tarball the way `npm i -g <tgz>` does, then return the installed bin.
 * A failure is a FAIL line and `null`: the transcript has nothing to measure without a CLI.
 */
async function installTarball(checks) {
  const work = workDir('tarball-')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const pack = await run('npm', ['pack', '--pack-destination', work], { cwd: ROOT, timeoutMs: 300_000 })
  const tgz = join(work, `${pkg.name}-${pkg.version}.tgz`)
  if (pack.code !== 0 || !existsSync(tgz)) {
    checks.fail('the tree packs into a tarball', `${tailText(pack)}${existsSync(tgz) ? '' : ` (no ${tgz})`}`)
    return { work, cli: null }
  }
  checks.pass('the tree packs into a tarball', tgz)
  const prefix = join(work, 'prefix')
  const install = await run('npm', ['install', '-g', '--prefix', prefix, tgz, '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: ROOT, timeoutMs: 300_000 })
  const installed = join(prefix, 'lib', 'node_modules', pkg.name, 'bin', 'watcher.mjs')
  if (install.code !== 0 || !existsSync(installed)) {
    checks.fail('the tarball installs into a temp prefix', `${tailText(install)}${existsSync(installed) ? '' : ` (no ${installed})`}`)
    return { work, cli: null }
  }
  checks.pass('the tarball installs into a temp prefix', installed)
  const probe = await runCli(installed, ['--version'], { cwd: ROOT })
  if (probe.code !== 0) {
    checks.fail('the installed CLI answers --version', `exit ${probe.code}: ${namedFailure(probe) || tailText(probe)}`)
    return { work, cli: null }
  }
  checks.pass('the installed CLI answers --version', `${probe.stdout.trim()} from ${installed}`)
  return { work, cli: installed }
}

/**
 * Install a git ref the way the README's one-liner does, into a temporary prefix and cache, and return the
 * installed bin. The symlink check is the point of the mode: on npm 11 a git dependency with a build script was
 * reified as a symlink to npm's cache temp clone, which npm deletes when the install ends, so the global bin
 * dangles. `--install-links` makes npm pack the prepared clone instead; a mode that did not check would report a
 * green run from the *checkout* CLI while the installed one was broken.
 */
async function installFromGit(spec, checks) {
  const work = workDir('git-')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const prefix = join(work, 'prefix')
  const cache = join(work, 'cache')
  const install = await run(
    'npm',
    ['install', '--global', '--install-links', '--prefix', prefix, '--cache', cache, '--no-audit', '--no-fund', spec],
    { cwd: work, env: { CI: '1', npm_config_yes: 'true', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 900_000 }
  )
  const dir = join(prefix, 'lib', 'node_modules', pkg.name)
  const installed = join(dir, 'bin', 'watcher.mjs')
  if (install.code !== 0 || !existsSync(installed)) {
    checks.fail('the git spec installs into a temp prefix', `${spec}: exit ${install.code}: ${tailText(install)}${existsSync(installed) ? '' : ` (no ${installed})`}`)
    return { work, cli: null }
  }
  let stat = null
  try {
    stat = lstatSync(dir)
  } catch {
    stat = null
  }
  if (stat?.isSymbolicLink()) {
    let target = ''
    try {
      target = readlinkSync(dir)
    } catch {
      target = '(unreadable)'
    }
    checks.fail('the installed package is a real directory, not a link into npm\'s cache', `${spec}: ${dir} -> ${target}${existsSync(dir) ? '' : ' (dangling: npm deleted the clone)'}`)
    return { work, cli: null }
  }
  checks.pass('the git spec installs into a temp prefix', `${spec} -> ${installed}`)
  const probe = await runCli(installed, ['--version'], { cwd: ROOT })
  if (probe.code !== 0) {
    checks.fail('the installed CLI answers --version', `exit ${probe.code}: ${namedFailure(probe) || tailText(probe)}`)
    return { work, cli: null }
  }
  checks.pass('the installed CLI answers --version', `${probe.stdout.trim()} from ${installed}`)
  return { work, cli: installed }
}

/** `git status --porcelain`, with the fixture committed first, so only the install's own writes can appear. */
async function commitFixture(project) {
  const init = await run('git', ['init', '-q'], { cwd: project })
  if (init.code !== 0) return false
  await run('git', ['config', 'user.email', 'acceptance@example.invalid'], { cwd: project })
  await run('git', ['config', 'user.name', 'acceptance'], { cwd: project })
  await run('git', ['add', '-A'], { cwd: project })
  const commit = await run('git', ['commit', '-q', '-m', 'fixture'], { cwd: project })
  return commit.code === 0
}

async function main(argv) {
  const checks = new Checks()
  const fromTarball = argv.includes('--from-tarball')
  const gitSpec = value(argv, 'from-git')
  const modes = [Boolean(value(argv, 'cli')), fromTarball, argv.includes('--from-git')].filter(Boolean).length
  if (modes > 1) {
    console.error('acceptance: use one of --cli, --from-tarball or --from-git <spec>')
    return 64
  }
  if (argv.includes('--from-git') && !gitSpec) {
    console.error('acceptance: --from-git needs a git spec, e.g. --from-git git+file:///path/to/repo.git')
    return 64
  }
  const installed = fromTarball ? await installTarball(checks)
    : gitSpec ? await installFromGit(gitSpec, checks)
    : { work: null, cli: cliPath(value(argv, 'cli')) }
  const cli = installed.cli
  if (!cli) {
    if (installed.work && !process.env.KEEP_ACCEPTANCE) rmSync(installed.work, { recursive: true, force: true })
    return finishRun(checks)
  }
  if (installed.work) {
    try {
      return await measure(cli, checks)
    } finally {
      if (!process.env.KEEP_ACCEPTANCE) rmSync(installed.work, { recursive: true, force: true })
    }
  }
  return measure(cli, checks)
}

async function measure(cli, checks) {
  if (!cli || !existsSync(cli)) {
    checks.skip('the CLI is in this tree', `${cli} is missing: the transcript runs once the CLI lands (bin/watcher.mjs, src/cli/)`)
    console.log('')
    console.log('acceptance: skipped — this tree has no bin/watcher.mjs')
    return 0
  }
  // The server imports hono and the other runtime dependencies from this tree. A checkout snapshot
  // without `npm ci` cannot start it, and the failure would surface as a 120 s /healthz timeout: say so
  // in one line instead (CI installs before this step; a fresh worker worktree often does not).
  if (cli === join(ROOT, 'bin', 'watcher.mjs') && !existsSync(join(ROOT, 'node_modules'))) {
    checks.fail('this tree has its dependencies installed', `no node_modules in ${ROOT}: run \`npm ci\` first`)
    return finishRun(checks)
  }

  const major = Number(process.versions.node.split('.')[0])
  if (major >= 24) checks.pass('node is 24 or newer', process.version)
  else {
    checks.fail('node is 24 or newer', `${process.version}: the CLI runs TypeScript sources with native type stripping`)
    return finishRun(checks)
  }

  const { work, project } = makeProject()
  let fixture = null
  let serverStarted = false
  const watcherPort = await freePort()
  const logPath = join(project, '.watcher', 'data', 'watcher.log')

  try {
    const committed = await commitFixture(project)
    if (!committed) checks.skip('the zero-hand-edit check', 'git is unavailable, so the fixture cannot be committed for a status diff')

    fixture = await startFixture(project)
    checks.pass('the fixture app answers', `http://127.0.0.1:${fixture.port}`)

    // 1. init ----------------------------------------------------------------------------------------
    const init = await runCli(cli, ['init', '--port', String(watcherPort)], { cwd: project })
    if (init.code === 0) checks.pass('watcher init', `port ${watcherPort}`)
    else checks.fail('watcher init', `exit ${init.code}: ${tailText(init)}`)
    const envPath = join(project, '.watcher', '.env')
    const configPath = join(project, '.watcher', 'config.json')
    if (existsSync(configPath)) checks.pass('init wrote .watcher/config.json')
    else checks.fail('init wrote .watcher/config.json')
    if (existsSync(envPath)) {
      const mode = statSync(envPath).mode & 0o777
      if (mode === 0o600) checks.pass('the secrets file is 0600')
      else checks.fail('the secrets file is 0600', `mode is ${mode.toString(8)}`)
    } else checks.fail('init wrote .watcher/.env')

    // 2. scan ----------------------------------------------------------------------------------------
    const scan = await runCliJson(cli, ['scan'], { cwd: project })
    if (scan.code === 0 && scan.json) {
      const signals = Array.isArray(scan.json.signals) ? scan.json.signals : []
      const ready = signals.find((s) => s?.kind === 'http-probe' && JSON.stringify(s?.suggests ?? {}).includes('/readyz'))
      const cron = signals.find((s) => s?.kind === 'heartbeat' && (s?.evidence ?? []).some((e) => String(e?.file ?? '').endsWith('crontab')))
      if (ready) checks.pass('the scan finds the readiness route', String(ready.suggests?.args?.url ?? '/readyz'))
      else checks.fail('the scan finds the readiness route', `signals: ${signals.map((s) => s?.kind).join(', ') || 'none'}`)
      if (cron) checks.pass('the scan finds the scheduled job', String(cron.note ?? cron.id ?? 'crontab'))
      else checks.fail('the scan finds the scheduled job', `signals: ${signals.map((s) => s?.kind).join(', ') || 'none'}`)
      // A heartbeat suggestion is agent judgement (the cadence is in the crontab line), so it is a signal, not a runnable command.
      if (cron?.suggests?.kind === 'heartbeat') checks.pass('the scan proposes a heartbeat for the job', JSON.stringify(cron.suggests.args ?? {}))
      else checks.fail('the scan proposes a heartbeat for the job', JSON.stringify(cron?.suggests ?? null))
    } else {
      checks.fail('watcher scan --json answers a signal list', `exit ${scan.code}: ${tailText(scan)}`)
    }

    // 3. add: the source, the job, the channel -------------------------------------------------------
    const readyLine = lineOf(join(project, 'server.mjs'), "'/readyz'")
    const addProbe = await runCli(
      cli,
      [
        'add', 'http-probe', '--id', 'app',
        '--url', `http://127.0.0.1:${fixture.port}/readyz`,
        '--expect-json', '{"db.ok":true}',
        '--poll-sec', '2', '--fail-after', '1',
        '--found-at', `server.mjs:${readyLine}`,
        '--read', 'readiness reads the database flag and answers 503 when it is false'
      ],
      { cwd: project }
    )
    if (addProbe.code === 0) checks.pass('watcher add http-probe')
    else checks.fail('watcher add http-probe', `exit ${addProbe.code}: ${tailText(addProbe)}`)

    const heartbeatToken = `acceptance-${watcherPort}-token`
    const addHeartbeat = await runCli(
      cli,
      [
        'add', 'heartbeat', '--id', 'nightly',
        '--every', '1h', '--grace', '5m',
        '--token-env', 'WATCHER_HEARTBEAT_TOKEN',
        '--secret-value', heartbeatToken,
        '--found-at', 'crontab:2',
        '--read', 'the nightly job pings only after a successful run'
      ],
      { cwd: project }
    )
    if (addHeartbeat.code === 0) checks.pass('watcher add heartbeat')
    else checks.fail('watcher add heartbeat', `exit ${addHeartbeat.code}: ${tailText(addHeartbeat)}`)

    const addChannel = await runCli(
      cli,
      ['add', 'channel', 'webhook', '--id', 'accept', '--url-env', 'WATCHER_ACCEPT_URL', '--secret-value', `http://127.0.0.1:${fixture.port}/alerts`],
      { cwd: project }
    )
    if (addChannel.code === 0) checks.pass('watcher add channel webhook')
    else checks.fail('watcher add channel webhook', `exit ${addChannel.code}: ${tailText(addChannel)}`)

    // 4. run -----------------------------------------------------------------------------------------
    const start = await runCli(cli, ['run', '--detach'], { cwd: project, timeoutMs: 60_000 })
    const base = `http://127.0.0.1:${watcherPort}`
    if (start.code === 0) {
      serverStarted = true
      checks.pass('watcher run --detach')
    } else {
      checks.fail('watcher run --detach', `exit ${start.code}: ${tailText(start)}`)
    }
    const env = readEnvFile(envPath)
    const adminToken = env.WATCHER_ADMIN_TOKEN ?? ''
    if (adminToken) checks.pass('init generated an admin token')
    else checks.fail('init generated an admin token')

    try {
      await waitFor(async () => (await httpJson(`${base}/healthz`)).status === 200, { timeoutMs: 120_000, intervalMs: 500, label: `${base}/healthz to answer 200` })
      checks.pass('the Watcher answers /healthz', base)
    } catch (err) {
      checks.fail('the Watcher answers /healthz', `${err.message}\n${tail(logPath, 30)}`)
      return finishRun(checks)
    }

    // 5. the job pings its heartbeat ------------------------------------------------------------------
    const ping = await run(process.execPath, [join(project, 'job.mjs')], {
      cwd: project,
      env: { WATCHER_HEARTBEAT_URL: `${base}/ingest/heartbeat/nightly`, WATCHER_HEARTBEAT_TOKEN: heartbeatToken }
    })
    if (ping.code === 0) checks.pass('the job pings its heartbeat')
    else checks.fail('the job pings its heartbeat', `exit ${ping.code}: ${ping.stderr.trim()}`)

    // 6. doctor --live --prove, retried until the first polls and the notifier settle ------------------
    const doctor = await waitFor(
      async () => {
        const r = await runCliJson(cli, ['doctor', '--live', '--prove'], { cwd: project, timeoutMs: 120_000 })
        return r.json && r.json.ok === true && r.json.live === true ? r : false
      },
      { timeoutMs: 90_000, intervalMs: 2000, label: 'doctor --live --prove to answer ok:true live:true' }
    ).catch(async (err) => {
      const last = await runCliJson(cli, ['doctor', '--live', '--prove'], { cwd: project, timeoutMs: 120_000 })
      checks.fail('watcher doctor --live --prove is green', `${err.message}; last: ${failedChecks(last.json)}`)
      return null
    })
    if (doctor) checks.pass('watcher doctor --live --prove is green', '{"ok":true,"live":true}')

    const green = doctor?.json
    if (green) {
      const bare200 = (green.checks ?? []).find((c) => /source\.bare-200/.test(String(c.code)) && c.status === 'fail')
      if (!bare200) checks.pass('no source passes on a bare 200')
      else checks.fail('no source passes on a bare 200', bare200.message)
    }

    // 7. /api/state: the source asserted something and says where it was found ------------------------
    const state = await httpJson(`${base}/api/state`, { headers: { Authorization: `Bearer ${adminToken}` } })
    const sources = Array.isArray(state.json?.sources) ? state.json.sources : []
    const appSource = sources.find((s) => s?.id === 'app')
    if (appSource) {
      checks.pass('the app source is in the wall state', `state=${String(appSource.state)}`)
      if (typeof appSource.asserted === 'number' && appSource.asserted >= 1) checks.pass('the app source asserts something that can flip', `asserted=${appSource.asserted}`)
      else checks.fail('the app source asserts something that can flip', `asserted=${String(appSource.asserted)}`)
      const foundAt = appSource.discovered?.foundAt
      if (typeof foundAt === 'string' && foundAt.startsWith('server.mjs:')) checks.pass('the app source records where it was found', foundAt)
      else checks.fail('the app source records where it was found', JSON.stringify(appSource.discovered ?? null))
    } else {
      checks.fail('the app source is in the wall state', `sources: ${sources.map((s) => s?.id).join(', ') || 'none'}`)
    }
    const nightly = sources.find((s) => s?.id === 'nightly')
    if (nightly) checks.pass('the heartbeat source is in the wall state', `state=${String(nightly.state)}`)
    else checks.fail('the heartbeat source is in the wall state')

    // 8. zero hand edits ------------------------------------------------------------------------------
    if (committed) {
      const status = await gitStatus(project)
      const lines = status.stdout.split('\n').filter((line) => line.trim() !== '')
      const outside = lines.filter((line) => !/^\?\?\s+\.watcher\//.test(line) && !/^[ ?MADRC]{2}\s+\.gitignore$/.test(line))
      if (outside.length === 0) checks.pass('the install needed no hand edits outside .watcher/', `${lines.length} writes, all the CLI's own`)
      else checks.fail('the install needed no hand edits outside .watcher/', outside.join('; '))
    }

    // 9. the negative run -----------------------------------------------------------------------------
    await runNegative({ cli, project, base, adminToken, checks })

    // 10. the Watcher's own /healthz is refused as a source -------------------------------------------
    const addSelf = await runCli(cli, ['add', 'http-probe', '--id', 'watcher-self', '--url', `${base}/healthz`, '--expect-json', '{"status":"ok"}'], { cwd: project })
    if (addSelf.code !== 0) {
      checks.fail('a self-probe source can be added for the check', `exit ${addSelf.code}: ${tailText(addSelf)}`)
    } else {
      await runCli(cli, ['stop'], { cwd: project })
      await runCli(cli, ['run', '--detach'], { cwd: project, timeoutMs: 60_000 })
      try {
        await waitFor(async () => (await httpJson(`${base}/healthz`)).status === 200, { timeoutMs: 60_000, intervalMs: 500, label: 'the restarted Watcher' })
        const selfDoctor = await waitFor(
          async () => {
            const r = await runCliJson(cli, ['doctor', '--live'], { cwd: project, timeoutMs: 120_000 })
            return r.json && (r.json.checks ?? []).some((c) => /self[-_]probe/i.test(String(c.code))) ? r.json : false
          },
          { timeoutMs: 60_000, intervalMs: 2000, label: 'a source.self-probe check' }
        ).catch(() => null)
        const row = (selfDoctor?.checks ?? []).find((c) => /self[-_]probe/i.test(String(c.code)))
        if (row) checks.pass('a probe pointed at the Watcher itself is named', `${row.code} (${row.status})`)
        else checks.fail('a probe pointed at the Watcher itself is named', 'no self-probe check appeared in doctor --live')
      } catch (err) {
        checks.fail('a probe pointed at the Watcher itself is named', err.message)
      }
    }
  } finally {
    if (serverStarted) await runCli(cli, ['stop'], { cwd: project, timeoutMs: 30_000 })
    fixture?.child.kill('SIGTERM')
    await sleep(200)
    removeProject(work)
  }

  return finishRun(checks)
}

function tailText(result) {
  const text = `${result.stdout}\n${result.stderr}`.trim()
  return text.split('\n').slice(-3).join(' | ')
}

/** The first line of a crashed run that names the failure (an Error class or ERR_ code), not a stack frame. */
function namedFailure(result) {
  const lines = `${result.stderr}\n${result.stdout}`.split('\n').map((line) => line.trim())
  return lines.find((line) => /^[A-Za-z]*Error\b/.test(line)) ?? lines.find((line) => line.includes('ERR_')) ?? ''
}

function failedChecks(report) {
  if (!report || !Array.isArray(report.checks)) return 'no JSON report'
  const failed = report.checks.filter((c) => c.status === 'fail')
  return failed.map((c) => c.code).join(', ') || 'no failed checks'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
