#!/usr/bin/env node
// Deploy the telemetry collector: find or create the D1 database, apply schema.sql (idempotent), and `wrangler deploy` with a
// config generated from wrangler.jsonc plus the database id. The generated config and wrangler's scratch dir live in a temp
// dir, so the repo never holds the account-bound id.
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_EMAIL=… CLOUDFLARE_API_KEY=… node deploy/telemetry/deploy.mjs [--dry-run]
//
// --dry-run bundles the Worker (wrangler deploy --dry-run) and touches nothing in the account.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATABASE_NAME, createDatabase, findDatabase, query } from './cloudflare.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dryRun = process.argv.includes('--dry-run')

/** wrangler.jsonc with its whole-line `//` comments removed: the file keeps comments to full lines for this reason. */
function readConfig() {
  const text = readFileSync(join(here, 'wrangler.jsonc'), 'utf8')
  return JSON.parse(text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'))
}

async function main() {
  const config = readConfig()
  let databaseId = '00000000-0000-4000-8000-000000000000'
  if (!dryRun) {
    databaseId = await findDatabase()
    if (databaseId) console.log(`d1: ${DATABASE_NAME} exists`)
    else {
      databaseId = await createDatabase()
      console.log(`d1: created ${DATABASE_NAME}`)
    }
    await query(databaseId, readFileSync(join(here, 'schema.sql'), 'utf8'))
    console.log('d1: schema.sql applied')
  }

  const scratch = mkdtempSync(join(tmpdir(), 'ezo-watcher-telemetry-'))
  try {
    const generated = {
      ...config,
      main: resolve(here, config.main),
      d1_databases: config.d1_databases.map((d) => ({ ...d, database_id: databaseId }))
    }
    const configPath = join(scratch, 'wrangler.json')
    writeFileSync(configPath, JSON.stringify(generated, null, 2))
    const args = ['-y', 'wrangler@4', 'deploy', '--config', configPath, ...(dryRun ? ['--dry-run', '--outdir', join(scratch, 'out')] : [])]
    const result = spawnSync('npx', args, { stdio: 'inherit', cwd: scratch, env: process.env })
    if (result.status !== 0) process.exit(result.status ?? 1)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (!dryRun) console.log('collector: https://telemetry.ezolabs.io (POST /v1/events)')
}

main().catch((err) => {
  console.error(`deploy failed: ${err.message}`)
  process.exit(1)
})
