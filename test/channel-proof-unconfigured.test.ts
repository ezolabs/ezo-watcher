// The channel proof strip (/api/state `channels`, /api/notifications `channels`): a Web Push test that found nobody subscribed reads
// `unconfigured` with lastTestOk null, so neither the Notifications view nor the failure audit (watch/channel/<id>/test_failed keys on
// lastTestOk === false) calls it a failed test. A real failure, on Web Push or any other channel, still reads failed.

import { describe, expect, it } from 'vitest'
import type { WatchConfig } from '../src/server/config.ts'
import { openDb } from '../src/server/db.ts'
import { Engine } from '../src/server/engine.ts'

const T0 = Date.parse('2026-10-15T18:32:00Z')

const cfg: WatchConfig = {
  baseUrl: 'https://watch.test',
  port: 0,
  host: '127.0.0.1',
  dataDir: ':memory:',
  historyHours: 24,
  staleAfterMisses: 3,
  sources: [],
  serviceMap: [],
  channels: [
    { id: 'webpush', type: 'webpush', publicKeyEnv: 'VAPID_PUB', privateKeyEnv: 'VAPID_PRIV', subject: 'mailto:ops@example.com' },
    { id: 'ntfy', type: 'ntfy', server: 'https://ntfy.sh', topicEnv: 'NTFY_TOPIC' }
  ],
  routes: [],
  quietHours: null
}

function setup() {
  const engine = new Engine(openDb(':memory:'), cfg, () => T0)
  const test = (channel: string, ok: boolean, status: string, at = T0) =>
    engine.db
      .prepare('INSERT INTO results (at, incident_key, route_id, channel_id, kind, ok, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(at, '-', '-', channel, 'test', ok ? 1 : 0, status, 3)
  const proof = (id: string) => engine.channelProofs().find((c) => c.id === id)
  return { engine, test, proof }
}

describe('channel proofs', () => {
  it('reads a Web Push test with no subscribers as unconfigured, not failed, and leaves it out of the failing channels', () => {
    const { engine, test, proof } = setup()
    test('webpush', false, 'no subscribers')
    test('ntfy', false, '500')
    expect(proof('webpush')).toEqual({ id: 'webpush', type: 'webpush', enabled: true, lastTestAt: '2026-10-15T18:32:00.000Z', lastTestOk: null, lastTest: 'unconfigured' })
    expect(proof('ntfy')).toMatchObject({ lastTestOk: false, lastTest: 'failed' })
    // the failure audit's watch_alert filter (ops-intake.sh): an enabled channel whose lastTestOk is false
    expect(engine.channelProofs().filter((c) => c.enabled && c.lastTestOk === false).map((c) => c.id)).toEqual(['ntfy'])
    // the wall's state carries the same proofs
    expect(engine.wall().channels.find((c) => c.id === 'webpush')).toMatchObject({ lastTestOk: null, lastTest: 'unconfigured' })
  })

  it('keeps a Web Push test with a subscriber as before: passed when one accepted, failed when none did', () => {
    const { test, proof } = setup()
    test('webpush', true, '1 of 1 accepted')
    expect(proof('webpush')).toMatchObject({ lastTestOk: true, lastTest: 'passed' })
    test('webpush', false, '0 of 1 accepted', T0 + 1000)
    expect(proof('webpush')).toMatchObject({ lastTestOk: false, lastTest: 'failed', lastTestAt: '2026-10-15T18:32:01.000Z' })
  })

  it('says null for a channel never tested', () => {
    expect(setup().proof('ntfy')).toMatchObject({ lastTestAt: null, lastTestOk: null, lastTest: null })
  })
})
