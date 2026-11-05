// `watcher rm <id>`: take a source or channel out of the config, and take a removed channel out of
// every route that named it. A route that still named the channel would fail the validator, and a
// hand edit is exactly how a removed id leaves the config invalid.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADD_SPEC, runAdd } from '../../src/cli/add.ts'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { RM_SPEC, runRm } from '../../src/cli/remove.ts'
import { validateConfig } from '../../src/server/config.ts'
import { managedHash } from '../../src/cli/project.ts'
import { EnvGuard, WATCHER_KEYS, capture, freePort, parse, readJson, rmTemp, tempDir } from './helpers.ts'

const guards: Array<() => void> = []
const dirs: string[] = []

function guard(): EnvGuard {
  const g = new EnvGuard(WATCHER_KEYS)
  guards.push(() => g.restore())
  return g
}

afterEach(() => {
  for (const restore of guards.splice(0)) restore()
  for (const dir of dirs.splice(0)) rmTemp(dir)
})

async function seeded(prefix: string): Promise<string> {
  const g = guard()
  g.set({ WATCHER_ACK_SECRET: undefined, WATCHER_ADMIN_TOKEN: undefined, WATCHER_MCP_TOKEN: undefined })
  const dir = tempDir(prefix)
  dirs.push(dir)
  expect(await runInit(parse(['init', '--dir', dir, '--port', String(await freePort())], INIT_SPEC), capture('json').out)).toBe(0)
  return dir
}

async function add(dir: string, argv: string[]): Promise<void> {
  expect(await runAdd(parse(['add', '--dir', dir, ...argv], ADD_SPEC), capture('json').out)).toBe(0)
}

async function rm(dir: string, id: string, extra: string[] = []): Promise<{ code: number; json: Record<string, unknown> }> {
  const cap = capture('json')
  const code = await runRm(parse(['rm', '--dir', dir, ...extra, id], RM_SPEC), cap.out)
  return { code, json: JSON.parse(cap.stdout()) as Record<string, unknown> }
}

describe('watcher rm', () => {
  it('removes a source, re-stamps _meta and leaves the channels alone', async () => {
    const dir = await seeded('rm-source')
    await add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/healthz'])
    await add(dir, ['http-probe', '--id', 'keep', '--url', 'https://keep.example.com/healthz'])
    await add(dir, ['channel', 'file', '--id', 'local'])
    const r = await rm(dir, 'api')
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, removed: 'source', id: 'api' })
    const config = readJson(join(dir, '.watcher', 'config.json'))
    expect((config.sources as Array<{ id: string }>).map((s) => s.id)).toEqual(['keep'])
    expect((config.channels as Array<{ id: string }>).map((c) => c.id)).toEqual(['local'])
    expect((config._meta as { sha256: string }).sha256).toBe(managedHash(config))
    expect(validateConfig(config).ok).toBe(true)
  })

  it('removes a channel and the route that existed only to deliver to it', async () => {
    const dir = await seeded('rm-channel-route')
    await add(dir, ['channel', 'file', '--id', 'local'])
    expect((readJson(join(dir, '.watcher', 'config.json')).routes as Array<{ id: string }>).map((x) => x.id)).toEqual(['default'])
    const r = await rm(dir, 'local')
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, removed: 'channel', id: 'local' })
    expect((r.json as { routesRemoved: string[] }).routesRemoved).toEqual(['default'])
    const config = readJson(join(dir, '.watcher', 'config.json'))
    expect(config.channels).toEqual([])
    expect(config.routes).toEqual([])
    expect(validateConfig(config).ok).toBe(true)
  })

  it('drops a removed channel from a route that has other receivers, keeping the route', async () => {
    const dir = await seeded('rm-channel-mixed')
    await add(dir, ['channel', 'file', '--id', 'local'])
    // A second channel and a route naming both, edited as an operator would.
    const path = join(dir, '.watcher', 'config.json')
    const raw = readJson(path)
    ;(raw.channels as Array<Record<string, unknown>>).push({ id: 'hook', type: 'webhook', urlEnv: 'WATCHER_HOOK_URL' })
    ;(raw.routes as Array<Record<string, unknown>>)[0].receivers = ['local', 'hook']
    ;(raw.routes as Array<Record<string, unknown>>)[0].record = ['local']
    ;(raw.routes as Array<Record<string, unknown>>)[0].escalate = [{ afterSec: 300, receivers: ['local', 'hook'] }]
    raw._meta = { writer: 'watcher', version: '0.1.0', sha256: managedHash(raw) }
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`)
    const r = await rm(dir, 'local')
    expect(r.code).toBe(0)
    expect((r.json as { routesChanged: string[] }).routesChanged).toEqual(['default'])
    const config = readJson(join(dir, '.watcher', 'config.json'))
    const route = (config.routes as Array<Record<string, unknown>>)[0]
    expect(route.receivers).toEqual(['hook'])
    expect(route.record).toEqual([])
    expect(route.escalate).toEqual([{ afterSec: 300, receivers: ['hook'] }])
    expect(validateConfig(config).ok).toBe(true)
  })

  it('refuses an unknown id and names the configured ones', async () => {
    const dir = await seeded('rm-unknown')
    await add(dir, ['channel', 'file', '--id', 'local'])
    await expect(rm(dir, 'nope')).rejects.toMatchObject({ code: 'rm.unknown-id' })
  })

  it('--dry-run validates and changes nothing', async () => {
    const dir = await seeded('rm-dry')
    await add(dir, ['channel', 'file', '--id', 'local'])
    const before = readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')
    const r = await rm(dir, 'local', ['--dry-run'])
    expect(r.code).toBe(0)
    expect(r.json.dryRun).toBe(true)
    expect(readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')).toBe(before)
  })
})
