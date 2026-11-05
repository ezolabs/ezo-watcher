#!/usr/bin/env node
// Read the telemetry the collector stored (D1 `ezo-watcher-telemetry`), through the Cloudflare API.
//
//   node deploy/telemetry/query.mjs doctor  [days]   top failing doctor check codes, by version
//   node deploy/telemetry/query.mjs errors  [days]   top internal error types (+ code and top frame), by version
//   node deploy/telemetry/query.mjs commands [days]  verbs by exit code, with the CliError code they ended on
//   node deploy/telemetry/query.mjs installs [days]  distinct installs by version, os and install method
//   node deploy/telemetry/query.mjs recent  [n]      the newest rows, whole
//   node deploy/telemetry/query.mjs sql "<SELECT …>"
//
// Add --json for the rows as JSON. Auth: the same env as deploy.mjs (see cloudflare.mjs).

import { DATABASE_NAME, findDatabase, query } from './cloudflare.mjs'

const since = (days) => `strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-${days} days')`

const PRESETS = {
  doctor: (days = 30) => `
    SELECT e.version, j.value AS code, COUNT(*) AS failures, COUNT(DISTINCT e.install_id) AS installs
    FROM events e, json_each(e.props, '$.failing') j
    WHERE e.name = 'doctor.result' AND e.received_at >= ${since(days)}
    GROUP BY e.version, j.value ORDER BY failures DESC LIMIT 30`,
  errors: (days = 30) => `
    SELECT version, json_extract(props, '$.where') AS origin, json_extract(props, '$.errorName') AS error,
      json_extract(props, '$.code') AS code, json_extract(props, '$.frames[0]') AS top_frame,
      COUNT(*) AS n, COUNT(DISTINCT install_id) AS installs
    FROM events WHERE name = 'error' AND received_at >= ${since(days)}
    GROUP BY version, origin, error, code, top_frame ORDER BY n DESC LIMIT 30`,
  commands: (days = 30) => `
    SELECT version, json_extract(props, '$.command') AS command, json_extract(props, '$.exitCode') AS exit_code,
      json_extract(props, '$.errorCode') AS error_code, COUNT(*) AS n, CAST(AVG(json_extract(props, '$.durationMs')) AS INTEGER) AS avg_ms
    FROM events WHERE name = 'cli.command' AND received_at >= ${since(days)}
    GROUP BY version, command, exit_code, error_code ORDER BY n DESC LIMIT 40`,
  installs: (days = 30) => `
    SELECT version, os, install, ci, COUNT(DISTINCT install_id) AS installs
    FROM events WHERE received_at >= ${since(days)}
    GROUP BY version, os, install, ci ORDER BY installs DESC LIMIT 40`,
  recent: (n = 10) => `SELECT * FROM events ORDER BY id DESC LIMIT ${Number(n)}`
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--json')
  const asJson = process.argv.includes('--json')
  const [preset = 'doctor', arg] = args
  let sql
  if (preset === 'sql') {
    if (!arg) throw new Error('sql needs a statement')
    sql = arg
  } else if (PRESETS[preset]) {
    if (arg !== undefined && !/^\d{1,4}$/.test(arg)) throw new Error(`${preset} takes a whole number, not ${JSON.stringify(arg)}`)
    sql = PRESETS[preset](arg === undefined ? undefined : Number(arg))
  } else {
    throw new Error(`unknown query ${JSON.stringify(preset)}: one of ${Object.keys(PRESETS).join(', ')}, sql`)
  }
  const id = await findDatabase()
  if (!id) throw new Error(`no D1 database named ${DATABASE_NAME} in this account: run deploy.mjs first`)
  const rows = await query(id, sql)
  if (asJson) console.log(JSON.stringify(rows, null, 2))
  else if (rows.length === 0) console.log('(no rows)')
  else console.table(rows)
}

main().catch((err) => {
  console.error(`query failed: ${err.message}`)
  process.exit(1)
})
