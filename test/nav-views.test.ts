// The nav shows a view only when this Watcher's server backs it (src/server/instance.ts `featuresOf`, src/web/lib/instance.ts `navFor`). With
// config/watch.example.json the nav is the wall, fleet, history, notifications and sources; a Watcher with no fleet source shows the four every
// Watcher has, and the address of a hidden view says it is not configured instead of drawing a page with nothing behind it.
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NAV, NotConfigured } from '../src/web/App.tsx'
import { loadConfig } from '../src/server/config.ts'
import type { WatchConfig } from '../src/server/config.ts'
import { featuresOf, instanceInfo } from '../src/server/instance.ts'
import { ALL_FEATURES, fullInstance, parseInstance } from '../src/shared/instance.ts'
import { ALWAYS_VIEWS, navFor, viewShown } from '../src/web/lib/instance.ts'
import { VIEWS } from '../src/web/lib/route.ts'

const EVERY_VIEW = ['wall', 'fleet', 'history', 'notifications', 'sources']

/** A Watcher with no fleet source: the bare shape. */
const bare = (over: Partial<WatchConfig> = {}): WatchConfig => ({
  brand: { name: 'Infra Wall', shortName: 'Infra' },
  baseUrl: 'https://watch.example.com',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [{ id: 'webhook', type: 'webhook', tokenEnv: 'INGEST_TOKEN' }],
  serviceMap: [],
  channels: [{ id: 'hook', type: 'webhook', urlEnv: 'HOOK_URL' }],
  routes: [],
  quietHours: null,
  ...over
})

describe('config/watch.example.json', () => {
  const cfg = loadConfig('config/watch.example.json')

  it('backs no optional view without a fleet source', () => {
    expect(featuresOf(cfg)).toEqual([])
  })

  it('shows the four views every Watcher has, under the default name', () => {
    const info = instanceInfo(cfg)
    expect(info.brand).toEqual({ name: 'EZO Watcher', shortName: 'Watcher' })
    expect(navFor(NAV, info.features).map((n) => n.view)).toEqual(ALWAYS_VIEWS)
    expect(navFor(NAV, info.features).map((n) => n.label)).toEqual(['Wall', 'History', 'Notifications', 'Sources'])
    for (const v of VIEWS) expect(viewShown(v, info.features), v).toBe(ALWAYS_VIEWS.includes(v))
  })

  it('shows the fleet view when a netdata-fleet source is configured', () => {
    const fleet = instanceInfo({ ...cfg, sources: [...cfg.sources, { id: 'netdata-fleet', type: 'netdata-fleet', url: 'https://app.netdata.cloud', tokenEnv: 'T', spaceId: 's', roomId: 'r', pollSec: 60, fleetNodes: ['node-1'] }] })
    expect(fleet.features).toEqual(['fleet'])
    expect(navFor(NAV, fleet.features).map((n) => n.view)).toEqual(EVERY_VIEW)
  })

  it('is what a page with no meta shows until its server answers (the dev server)', () => {
    expect(navFor(NAV, fullInstance().features).map((n) => n.view)).toEqual(EVERY_VIEW)
    expect(fullInstance().brand.name).toBe('EZO Watcher')
  })
})

describe('a Watcher with no fleet source', () => {
  it('backs no optional view and shows the four every Watcher has, under its own name', () => {
    const info = instanceInfo(bare())
    expect(info).toEqual({ brand: { name: 'Infra Wall', shortName: 'Infra' }, features: [] })
    expect(navFor(NAV, info.features).map((n) => n.view)).toEqual(['wall', 'history', 'notifications', 'sources'])
    expect([...ALWAYS_VIEWS]).toEqual(['wall', 'history', 'notifications', 'sources'])
    expect(viewShown('fleet', info.features)).toBe(false)
  })

  it('gains the fleet view from its own backing and from nothing else', () => {
    const one = (over: Partial<WatchConfig>) => featuresOf(bare(over))
    expect(one({ sources: [...bare().sources, { id: 'netdata-fleet', type: 'netdata-fleet', url: 'https://app.netdata.cloud', tokenEnv: 'T', spaceId: 's', roomId: 'r', pollSec: 60, fleetNodes: ['node-1'] }] })).toEqual(['fleet'])
    expect(one({ sources: [...bare().sources, { id: 'webhook', type: 'webhook', tokenEnv: 'INGEST_TOKEN' }] })).toEqual([])
  })

  it('answers the address of a hidden view with one sentence and the way back to the wall', () => {
    const html = renderToStaticMarkup(createElement(NotConfigured, { view: 'fleet' }))
    expect(html).toContain('<h1 class="page-title">Fleet</h1>')
    expect(html).toContain('<p>Fleet is not configured on this Watcher.</p>')
    expect(html).toMatch(/<a class="btn" href="#\/">Open the wall<\/a>/)
  })
})

describe('what the page reads', () => {
  it('keeps the features it knows, in nav order, and drops the rest', () => {
    expect(parseInstance({ brand: { name: 'Infra Wall' }, features: ['teleport', 'fleet'] })).toEqual({ brand: { name: 'Infra Wall', shortName: 'Infra Wall' }, features: ['fleet'] })
  })

  it('refuses what is not an instance, so the page keeps what it had', () => {
    for (const bad of [null, [], 'x', { features: [] }, { brand: { name: '' }, features: [] }, { brand: { name: 'ok' } }, { brand: { name: 'ok' }, features: 'fleet' }]) expect(parseInstance(bad), JSON.stringify(bad)).toBeNull()
  })

  it('takes a hidden view off the keyboard too, and the fleet strip off the wall and the embed where there is no fleet', () => {
    const app = readFileSync('src/web/App.tsx', 'utf8')
    expect(app).toMatch(/if \(go\[e\.key\] && viewShown\(go\[e\.key\], features\)\) location\.hash/)
    expect(app).toContain("{viewShown('fleet', features) && <FleetStrip nowMs={nowMs} />}")
    expect(app).toContain('{navFor(NAV, features).map((n) => (')
    expect(readFileSync('src/web/views/Embed.tsx', 'utf8')).toContain("{viewShown('fleet', features) && <FleetStrip nowMs={nowMs} />}")
  })
})
