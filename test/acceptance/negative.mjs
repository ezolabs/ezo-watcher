// The negative half of the acceptance transcript: make the readiness field go red and prove the install notices.
//
//   1. flip the fixture's `db.ok` flag to false — its /readyz now answers 503 `{db:{ok:false}}`;
//   2. within one poll plus the notifier's tick, an incident fires, `watcher incidents --json` lists it, and the page
//      reaches the configured webhook channel (the fixture records it; the message kind for a firing notice is `alert`);
//   3. flip the flag back and prove the incident clears. The resolve notice itself is held 10 minutes by the notifier's
//      own design, so its delivery belongs to the notifier's tests, not to a smoke test with a wall clock.
//
// Run through `run.mjs`; it can also be run alone when a project from a run is still up (KEEP_ACCEPTANCE=1):
//   node test/acceptance/negative.mjs --project <dir> --base http://127.0.0.1:<port> --token <admin token>
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cliPath, firingIncidents, httpJson, runCliJson, waitFor } from './lib.mjs'

const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '') : [])

const safeJson = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** @param {{cli: string, project: string, base: string, adminToken: string, checks: import('./lib.mjs').Checks}} input */
export async function runNegative({ cli, project, base, adminToken, checks }) {
  const flag = join(project, 'db.ok')
  const alerts = join(project, 'alerts.log')
  const headers = adminToken ? { Authorization: `Bearer ${adminToken}` } : {}
  const before = lines(alerts).length
  const restore = () => writeFileSync(flag, 'true\n')

  writeFileSync(flag, 'false\n')
  try {
    await expectOutage({ cli, project, base, headers, checks, before, alerts })
  } finally {
    // The fixture must never be left red: a failure above is this run's, not the next one's.
    restore()
  }
  await expectRecovery({ base, headers, alerts, before, checks })
}

async function expectOutage({ cli, project, base, headers, checks, before, alerts }) {
  let incident
  try {
    incident = await waitFor(
      async () => {
        const state = await httpJson(`${base}/api/state`, { headers })
        if (state.status !== 200) return false
        // The wall names a service with its display case ("App"); compare the identity, not the casing.
        return firingIncidents(state.json).find((i) => /^ProbeDown$/i.test(String(i.rule)) && String(i.service ?? '').toLowerCase() === 'app') ?? false
      },
      { timeoutMs: 25_000, label: 'a firing incident after the readiness flag went red' }
    )
    checks.pass('the incident fires when the readiness field goes red', `${String(incident.rule)} on ${String(incident.service)}`)
  } catch (err) {
    checks.fail('the incident fires when the readiness field goes red', err.message)
    return
  }

  const listed = await runCliJson(cli, ['incidents'], { cwd: project })
  const count = typeof listed.json?.count === 'number' ? listed.json.count : 0
  if (listed.code === 0 && count >= 1) {
    checks.pass('`watcher incidents --json` lists the open incident', `${count} shown`)
  } else {
    const why = listed.json?.error?.message ?? listed.stderr.trim().split('\n')[0] ?? `exit ${listed.code}`
    checks.fail('`watcher incidents --json` lists the open incident', `exit ${listed.code}, count ${count}: ${why}`)
  }

  try {
    const delivered = await waitFor(
      () => {
        const now = lines(alerts)
        return now.length > before ? safeJson(now[now.length - 1]) : false
      },
      { timeoutMs: 30_000, label: 'a notification delivered to the configured channel' }
    )
    if (delivered?.kind === 'alert') {
      checks.pass('the page reaches the configured channel', `alert: ${String(delivered.title ?? '').slice(0, 90)}`)
    } else {
      checks.fail('the page reaches the configured channel', `a delivery arrived but it was ${JSON.stringify(delivered?.kind ?? 'unparseable')}`)
    }
  } catch (err) {
    checks.fail('the page reaches the configured channel', err.message)
  }
}

async function expectRecovery({ base, headers, alerts, before, checks }) {
  try {
    await waitFor(
      async () => {
        const state = await httpJson(`${base}/api/state`, { headers })
        if (state.status !== 200) return false
        return firingIncidents(state.json).length === 0
      },
      { timeoutMs: 25_000, label: 'the incident to clear after the readiness field recovered' }
    )
    checks.pass('the incident clears when the field recovers')
  } catch (err) {
    checks.fail('the incident clears when the field recovers', err.message)
  }

  // A resolved notice is held for RESOLVED_STABLE_SEC (10 minutes, src/server/notify/plan.ts) before it is sent, so a smoke
  // test cannot wait for it without owning the clock. The resolve itself is what this transcript asserts; the delivery is the
  // notifier's own test.
}

// ---- a standalone run against a project a previous transcript kept -----------------------------------------------

async function main(argv) {
  const value = (name) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const project = value('project')
  const base = value('base')
  const token = value('token') ?? ''
  if (!project || !base) {
    console.error('usage: node test/acceptance/negative.mjs --project <dir> --base <url> [--token <admin token>] [--cli <path>]')
    return 64
  }
  const { Checks, finishRun } = await import('./lib.mjs')
  const checks = new Checks()
  await runNegative({ cli: cliPath(value('cli')), project, base, adminToken: token, checks })
  return finishRun(checks)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
