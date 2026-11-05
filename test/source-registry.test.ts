// The source registry is the one place that says which SourceKind this process polls. The Record is compile-exhaustive
// (a new kind fails tsc until it is given a factory or declared pushed); these tests hold it against the configs, which are
// the other half no compiler sees: a configured source with no factory would be silently never started. The configs are every
// Watcher this repository ships (config/watch.example.json).
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/server/config.ts'
import { POLLED } from '../src/server/source-registry.ts'
import type { SourceKind } from '../src/shared/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const shipped = ['config/watch.example.json', 'test/fixtures/watch.config.json']
const configured = new Set<string>(shipped.flatMap((f) => loadConfig(resolve(here, '..', f)).sources.map((s) => s.type)))

describe('source registry', () => {
  it('reads the example config and the full fixture config', () => {
    for (const f of shipped) expect(loadConfig(resolve(here, '..', f)).sources.length).toBeGreaterThan(0)
  })

  it('decides every source the config starts: a factory, or an explicit pushed/app-driven null', () => {
    for (const kind of configured) expect(Object.hasOwn(POLLED, kind), `${kind} is configured but the registry ignores it`).toBe(true)
  })

  it('has no factory for a kind the config never starts', () => {
    for (const [kind, factory] of Object.entries(POLLED)) {
      if (factory) expect(configured.has(kind as SourceKind), `${kind} has a factory but no source in any shipped config (${shipped.join(', ')})`).toBe(true)
    }
  })

  it('leaves the pushed and app-driven kinds without a factory, and the polled ones with one', () => {
    for (const kind of ['webhook', 'self', 'zulip'] as const) expect(POLLED[kind], kind).toBeNull()
    for (const kind of ['grafana', 'vmalert', 'netdata-cloud', 'netdata-fleet', 'sentry', 'http-probe', 'feed'] as const) {
      expect(POLLED[kind], kind).toBeTypeOf('function')
    }
  })
})
