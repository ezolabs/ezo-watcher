import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validateConfig } from '../../src/server/config.ts'
import { ADD_SPEC, runAdd } from '../../src/cli/add.ts'
import { INIT_SPEC, runInit } from '../../src/cli/init.ts'
import { CliError } from '../../src/cli/util.ts'
import { managedHash, writeEnvVars } from '../../src/cli/project.ts'
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
  const code = await runInit(parse(['init', '--dir', dir, '--port', String(await freePort())], INIT_SPEC), capture('json').out)
  expect(code).toBe(0)
  return dir
}

async function add(dir: string, argv: string[]): Promise<{ code: number; json: Record<string, unknown>; text: string }> {
  const cap = capture('json')
  const code = await runAdd(parse(['add', '--dir', dir, ...argv], ADD_SPEC), cap.out)
  return { code, json: JSON.parse(cap.stdout()) as Record<string, unknown>, text: cap.stdout() }
}

describe('watcher add', () => {
  it('writes an http-probe source through validateConfig, with the target id/service defaulted and the provenance stamped', async () => {
    const dir = await seeded('add-http')
    const r = await add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/healthz', '--expect-json', '{"status":"ok"}', '--poll-sec', '30', '--fail-after', '2', '--found-at', 'src/server.ts:42', '--read', 'the health route reports the dependency'])
    expect(r.code).toBe(0)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    const sources = config.sources as Array<Record<string, unknown>>
    expect(sources).toHaveLength(1)
    const source = sources[0]
    expect(source.type).toBe('http-probe')
    expect(source.pollSec).toBe(30)
    expect(source.failAfter).toBe(2)
    expect(source.discovered).toEqual({ foundAt: 'src/server.ts:42', read: 'the health route reports the dependency' })
    const targets = source.targets as Array<Record<string, unknown>>
    expect(targets[0]).toMatchObject({ id: 'api', service: 'api', url: 'https://api.example.com/healthz', expectJson: { status: 'ok' } })
    const meta = config._meta as { writer: string; sha256: string; version: string }
    expect(meta.writer).toBe('watcher')
    expect(meta.sha256).toBe(managedHash(config))
    expect(validateConfig(config).ok).toBe(true)
  })

  it('adds a channel with --secret-value into .watcher/.env (0600) and never into the config, and creates one default route', async () => {
    const dir = await seeded('add-channel')
    const r = await add(dir, ['channel', 'ntfy', '--id', 'ntfy', '--topic-env', 'WATCHER_NTFY_TOPIC', '--secret-value', 'topic-s3cret'])
    expect(r.code).toBe(0)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    const channels = config.channels as Array<Record<string, unknown>>
    expect(channels[0]).toMatchObject({ id: 'ntfy', type: 'ntfy', topicEnv: 'WATCHER_NTFY_TOPIC' })
    expect(JSON.stringify(config)).not.toContain('topic-s3cret')
    const envPath = join(dir, '.watcher', '.env')
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(envPath, 'utf8')).toContain('WATCHER_NTFY_TOPIC=topic-s3cret')
    const routes = config.routes as Array<Record<string, unknown>>
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ id: 'default', receivers: ['ntfy'] })

    // A second channel does not add a second default route.
    const r2 = await add(dir, ['channel', 'webhook', '--id', 'hook', '--url-env', 'WATCHER_HOOK_URL'])
    expect(r2.code).toBe(0)
    const config2 = readJson(join(dir, '.watcher', 'config.json'))
    expect((config2.routes as unknown[]).length).toBe(1)
  })

  it('accepts the kinds the sources root ships later, because the validator is the gate', async () => {
    const dir = await seeded('add-kinds')
    for (const argv of [
      ['tcp-probe', '--id', 'db-port', '--host', '127.0.0.1', '--port', '5432'],
      ['heartbeat', '--id', 'nightly', '--every', '1d', '--grace', '1h'],
      ['domain-expiry', '--id', 'domains', '--domain', 'example.com'],
      ['netdata-fleet', '--id', 'fleet', '--space-id', 'space', '--room-id', 'room', '--fleet-nodes', 'host1,host2', '--token-env', 'NETDATA_TOKEN'],
      ['made-up-kind', '--id', 'future', '--set', 'pollSec=60']
    ]) {
      const r = await add(dir, argv)
      expect(r.code, `adding ${argv[0]}`).toBe(0)
    }
    const config = readJson(join(dir, '.watcher', 'config.json'))
    const ids = (config.sources as Array<{ id: string; type: string }>).map((s) => `${s.id}:${s.type}`)
    expect(ids).toContain('db-port:tcp-probe')
    expect(ids).toContain('nightly:heartbeat')
    expect(ids).toContain('domains:domain-expiry')
    expect(ids).toContain('fleet:netdata-fleet')
    expect(ids).toContain('future:made-up-kind')
    expect(validateConfig(config).ok).toBe(true)
  })

  it('writes heartbeat every/grace as DURATION STRINGS, or schedule+timezone, the shape the server reads', async () => {
    const dir = await seeded('add-heartbeat')
    expect(await add(dir, ['heartbeat', '--id', 'nightly', '--every', '24h', '--grace', '5m', '--token-env', 'NIGHTLY_TOKEN']).then((r) => r.code)).toBe(0)
    expect(await add(dir, ['heartbeat', '--id', 'cleanup', '--schedule', '0 4 * * *', '--timezone', 'America/Chicago', '--name', 'Nightly cleanup', '--token-env', 'CLEANUP_TOKEN']).then((r) => r.code)).toBe(0)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    const sources = config.sources as Array<Record<string, unknown>>
    const nightly = sources.find((s) => s.id === 'nightly')
    expect(nightly).toMatchObject({ type: 'heartbeat', every: '24h', grace: '5m', tokenEnv: 'NIGHTLY_TOKEN' })
    expect(nightly).not.toHaveProperty('everySec')
    expect(nightly).not.toHaveProperty('graceSec')
    const cleanup = sources.find((s) => s.id === 'cleanup')
    expect(cleanup).toMatchObject({ type: 'heartbeat', schedule: '0 4 * * *', timezone: 'America/Chicago', name: 'Nightly cleanup', tokenEnv: 'CLEANUP_TOKEN' })
    expect(cleanup).not.toHaveProperty('every')
  })

  it('refuses a heartbeat cadence without a unit, two cadences, and a timezone without a schedule', async () => {
    const dir = await seeded('add-heartbeat-bad')
    await expect(add(dir, ['heartbeat', '--id', 'a', '--every', '86400'])).rejects.toMatchObject({ code: 'usage.bad-duration' })
    await expect(add(dir, ['heartbeat', '--id', 'b', '--every', '24h', '--schedule', '0 4 * * *'])).rejects.toMatchObject({ code: 'add.heartbeat-two-cadences' })
    await expect(add(dir, ['heartbeat', '--id', 'c', '--every', '24h', '--timezone', 'UTC'])).rejects.toMatchObject({ code: 'add.heartbeat-timezone' })
  })

  it('mints the heartbeat ping token into .watcher/.env (0600) and prints the three ping forms', async () => {
    const dir = await seeded('add-heartbeat-mint')
    const cap = capture('table')
    const code = await runAdd(parse(['add', '--dir', dir, 'heartbeat', '--id', 'nightly', '--every', '24h'], ADD_SPEC), cap.out)
    expect(code).toBe(0)

    const envPath = join(dir, '.watcher', '.env')
    const envText = readFileSync(envPath, 'utf8')
    const minted = /^NIGHTLY_TOKEN=([0-9a-f]{64})$/m.exec(envText)
    expect(minted, 'the ping token is generated, not left empty').not.toBeNull()
    expect(statSync(envPath).mode & 0o777).toBe(0o600)

    // The value lives in .watcher/.env only: the config names the variable.
    const configText = readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')
    const config = JSON.parse(configText) as Record<string, unknown>
    expect((config.sources as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'heartbeat', tokenEnv: 'NIGHTLY_TOKEN' })
    expect(configText).not.toContain((minted as RegExpExecArray)[1])

    const text = cap.stdout()
    expect(text).toContain('NIGHTLY_TOKEN generated and written to .watcher/.env (0600)')
    expect(text).toContain('/ingest/heartbeat/nightly?token=$NIGHTLY_TOKEN"')
    expect(text).toContain('/ingest/heartbeat/nightly/fail?token=$NIGHTLY_TOKEN"')
    expect(text).toContain('/ingest/heartbeat/nightly/<exit-code>?token=$NIGHTLY_TOKEN"')
    expect(text.match(/curl -fsS -m 10 "/g)).toHaveLength(3)
  })

  it('reports the minted token and the three ping URLs in --json', async () => {
    const dir = await seeded('add-heartbeat-mint-json')
    const r = await add(dir, ['heartbeat', '--id', 'nightly', '--every', '24h'])
    expect(r.code).toBe(0)
    expect(r.json.secretEnv).toBe('NIGHTLY_TOKEN')
    expect(r.json.secretGenerated).toBe(true)
    expect(String(r.json.ping)).toMatch(/\/ingest\/heartbeat\/nightly\?token=\$NIGHTLY_TOKEN$/)
    expect(String(r.json.pingFail)).toMatch(/\/ingest\/heartbeat\/nightly\/fail\?token=\$NIGHTLY_TOKEN$/)
    expect(String(r.json.pingExit)).toMatch(/\/ingest\/heartbeat\/nightly\/<exit-code>\?token=\$NIGHTLY_TOKEN$/)
  })

  it('keeps a ping token .watcher/.env already holds', async () => {
    const dir = await seeded('add-heartbeat-keep')
    writeEnvVars(join(dir, '.watcher', '.env'), { NIGHTLY_TOKEN: 'already-here' })
    const r = await add(dir, ['heartbeat', '--id', 'nightly', '--every', '24h'])
    expect(r.code).toBe(0)
    expect(r.json.secretEnv).toBeUndefined()
    expect(r.json.secretGenerated).toBeUndefined()
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).toContain('NIGHTLY_TOKEN=already-here')
    expect(r.text).not.toContain('already-here')
  })

  it('mints a webhook push token, but leaves a vendor credential to the vendor', async () => {
    const dir = await seeded('add-mint-webhook')
    const hook = await add(dir, ['webhook', '--id', 'hooks', '--token-env', 'HOOKS_TOKEN'])
    expect(hook.code).toBe(0)
    expect(hook.json.secretEnv).toBe('HOOKS_TOKEN')
    expect(hook.json.secretGenerated).toBe(true)
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).toMatch(/^HOOKS_TOKEN=[0-9a-f]{64}$/m)

    // A token the CLI only READS belongs to the vendor: minting one would not be the value Sentry knows.
    const sentry = await add(dir, ['sentry', '--id', 'sentry', '--org', 'acme', '--projects', 'web=web', '--token-env', 'SENTRY_READ_TOKEN'])
    expect(sentry.code).toBe(0)
    expect(sentry.json.secretEnv).toBeUndefined()
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).not.toContain('SENTRY_READ_TOKEN')
  })

  it('--dry-run announces a minted token without writing it', async () => {
    const dir = await seeded('add-mint-dry')
    const envPath = join(dir, '.watcher', '.env')
    const envBefore = readFileSync(envPath, 'utf8')
    const cap = capture('table')
    const code = await runAdd(parse(['add', '--dir', dir, '--dry-run', 'heartbeat', '--id', 'nightly', '--every', '24h'], ADD_SPEC), cap.out)
    expect(code).toBe(0)
    expect(readFileSync(envPath, 'utf8')).toBe(envBefore)
    expect(cap.stderr()).toContain('would write NIGHTLY_TOKEN (generated) to .watcher/.env (0600)')
  })

  it('writes --secret-value instead of minting, and --replace does not rotate it', async () => {
    const dir = await seeded('add-heartbeat-secret')
    const first = await add(dir, ['heartbeat', '--id', 'nightly', '--every', '24h', '--secret-value', 'chosen-value'])
    expect(first.code).toBe(0)
    expect(first.json.secretEnv).toBe('NIGHTLY_TOKEN')
    expect(first.json.secretGenerated).toBeUndefined()
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).toContain('NIGHTLY_TOKEN=chosen-value')
    const replaced = await add(dir, ['heartbeat', '--id', 'nightly', '--every', '12h', '--replace'])
    expect(replaced.code).toBe(0)
    expect(replaced.json.secretEnv).toBeUndefined()
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).toContain('NIGHTLY_TOKEN=chosen-value')
  })

  it('refuses a document the server validator rejects and leaves the config untouched', async () => {
    const dir = await seeded('add-invalid')
    const before = readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')
    await expect(add(dir, ['feed', '--id', 'feed', '--token-env', 'FEED_TOKEN', '--url', 'not-a-url'])).rejects.toMatchObject({ code: 'config.invalid' })
    expect(readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')).toBe(before)
  })

  it('refuses a duplicate id', async () => {
    const dir = await seeded('add-dup')
    await add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/healthz'])
    await expect(add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/other'])).rejects.toMatchObject({ code: 'add.duplicate-id' })
  })

  it('--replace rewrites the entry in place through the validator and re-stamps _meta', async () => {
    const dir = await seeded('add-replace')
    expect((await add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/one', '--found-at', 'src/a.ts:1'])).code).toBe(0)
    expect((await add(dir, ['http-probe', '--id', 'keep', '--url', 'https://keep.example.com/healthz'])).code).toBe(0)
    const replaced = await add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/two', '--expect-json', '{"ok":true}', '--replace'])
    expect(replaced.code).toBe(0)
    expect(replaced.json.replaced).toBe(true)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    const sources = config.sources as Array<Record<string, unknown>>
    // In place: the replaced entry keeps its index, and the unrelated source is untouched.
    expect(sources[0].id).toBe('api')
    expect((sources[0].targets as Array<Record<string, unknown>>)[0].url).toBe('https://api.example.com/two')
    expect(sources[0]).not.toHaveProperty('discovered')
    expect(sources[1].id).toBe('keep')
    const meta = config._meta as { sha256: string }
    expect(meta.sha256).toBe(managedHash(config))
    expect(validateConfig(config).ok).toBe(true)
  })

  it('--replace can swap a channel for another type under the same id, and the route keeps working', async () => {
    const dir = await seeded('add-replace-channel')
    expect((await add(dir, ['channel', 'ntfy', '--id', 'pager', '--topic-env', 'WATCHER_NTFY_TOPIC'])).code).toBe(0)
    const r = await add(dir, ['channel', 'file', '--id', 'pager', '--replace'])
    expect(r.code).toBe(0)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    expect(config.channels).toEqual([{ id: 'pager', type: 'file' }])
    expect((config.routes as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'default', receivers: ['pager'] })
    expect(validateConfig(config).ok).toBe(true)
  })

  it('--optional writes optional:true, and the validator refuses a non-boolean', async () => {
    const dir = await seeded('add-optional')
    expect((await add(dir, ['sentry', '--id', 'sentry', '--org', 'acme', '--projects', 'web=web', '--token-env', 'SENTRY_TOKEN', '--optional'])).code).toBe(0)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    expect((config.sources as Array<Record<string, unknown>>)[0].optional).toBe(true)
    expect(validateConfig(config).ok).toBe(true)
    expect(validateConfig({ ...config, sources: [{ ...(config.sources as Array<Record<string, unknown>>)[0], optional: 'yes' }] }).ok).toBe(false)
  })

  it('adds a credential-free file channel with no env var and creates the default route', async () => {
    const dir = await seeded('add-file-channel')
    const r = await add(dir, ['channel', 'file', '--id', 'local'])
    expect(r.code).toBe(0)
    expect(r.json.wrote).toBe('channel')
    const config = readJson(join(dir, '.watcher', 'config.json'))
    expect(config.channels).toEqual([{ id: 'local', type: 'file' }])
    expect((config.routes as Array<Record<string, unknown>>)[0]).toMatchObject({ receivers: ['local'] })
    expect(validateConfig(config).ok).toBe(true)
    // --optional is a source flag; on a channel it is a usage error, not a silent no-op.
    await expect(add(dir, ['channel', 'file', '--id', 'local-2', '--optional'])).rejects.toMatchObject({ code: 'add.optional-channel', exitCode: 64 })
  })

  it('writes the file channel path when --path is given, and refuses a path with a control character', async () => {
    const dir = await seeded('add-file-path')
    expect((await add(dir, ['channel', 'file', '--id', 'local', '--path', 'var/alerts.jsonl'])).code).toBe(0)
    const config = readJson(join(dir, '.watcher', 'config.json'))
    expect((config.channels as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'local', type: 'file', path: 'var/alerts.jsonl' })
    expect(validateConfig({ ...config, channels: [{ id: 'bad', type: 'file', path: 'a\nb' }] }).ok).toBe(false)
  })

  it('refuses an inline secret and points at --secret-value', async () => {
    const dir = await seeded('add-inline')
    try {
      await add(dir, ['webhook', '--id', 'hook', '--token-env', 'HOOK_TOKEN', '--token', 'abc123'])
      throw new Error('expected a refusal')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('add.inline-secret')
      expect((err as CliError).exitCode).toBe(64)
      expect((err as CliError).next).toContain('--secret-value')
    }
    expect(readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')).not.toContain('abc123')
  })

  it('--dry-run validates and prints but changes nothing', async () => {
    const dir = await seeded('add-dry')
    const configBefore = readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')
    const envBefore = readFileSync(join(dir, '.watcher', '.env'), 'utf8')
    const r = await add(dir, ['--dry-run', 'http-probe', '--id', 'api', '--url', 'https://api.example.com/healthz', '--found-at', 'src/a.ts:1'])
    expect(r.code).toBe(0)
    expect(r.json.dryRun).toBe(true)
    expect(readFileSync(join(dir, '.watcher', 'config.json'), 'utf8')).toBe(configBefore)
    expect(readFileSync(join(dir, '.watcher', '.env'), 'utf8')).toBe(envBefore)
  })

  it('rejects a bad --expect-json as a usage error', async () => {
    const dir = await seeded('add-badjson')
    await expect(add(dir, ['http-probe', '--id', 'api', '--url', 'https://api.example.com/healthz', '--expect-json', '{oops'])).rejects.toMatchObject({ code: 'usage.bad-json' })
  })

  it('requires --id and a token-env name for a credential-bound kind', async () => {
    const dir = await seeded('add-required')
    await expect(add(dir, ['http-probe', '--url', 'https://api.example.com/healthz'])).rejects.toMatchObject({ code: 'usage.missing-flag' })
    await expect(add(dir, ['webhook', '--id', 'hook'])).rejects.toMatchObject({ code: 'add.token-env-needed' })
    expect(existsSync(join(dir, '.watcher', 'config.json'))).toBe(true)
  })
})
