import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { migrate, openDb } from '../src/server/db.ts'
import { SqliteNotifyStore } from '../src/server/stores.ts'

describe('the notification log in SQLite: first failure and closed rows', () => {
  it('round-trips the two new fields and leaves them off a delivered row', () => {
    const store = new SqliteNotifyStore(openDb(':memory:'))
    store.putLog({ key: 'a|r1|ntfy|alert', sentAt: 5, digest: 'd', ok: true, attempts: 0, nextAttemptAt: null })
    expect(store.getLog('a|r1|ntfy|alert')).toEqual({ key: 'a|r1|ntfy|alert', sentAt: 5, digest: 'd', ok: true, attempts: 0, nextAttemptAt: null })
    store.putLog({ key: 'b|r1|ntfy|alert', sentAt: 0, digest: '', ok: false, attempts: 3, nextAttemptAt: 99, firstFailedAt: 40 })
    expect(store.getLog('b|r1|ntfy|alert')).toEqual({ key: 'b|r1|ntfy|alert', sentAt: 0, digest: '', ok: false, attempts: 3, nextAttemptAt: 99, firstFailedAt: 40 })
    store.putLog({ key: 'b|r1|ntfy|alert', sentAt: 100, digest: 'd', ok: false, attempts: 8, nextAttemptAt: null, firstFailedAt: 40, closed: 'abandoned: max attempts' })
    expect(store.getLog('b|r1|ntfy|alert')).toMatchObject({ closed: 'abandoned: max attempts', nextAttemptAt: null, firstFailedAt: 40 })
  })

  it('lists the rows still waiting on a retry: failed, and not closed', () => {
    const store = new SqliteNotifyStore(openDb(':memory:'))
    store.putLog({ key: 'delivered|r1|ntfy|alert', sentAt: 5, digest: 'd', ok: true, attempts: 0, nextAttemptAt: null })
    store.putLog({ key: 'failing|r1|ntfy|alert', sentAt: 0, digest: '', ok: false, attempts: 2, nextAttemptAt: 99, firstFailedAt: 1 })
    store.putLog({ key: 'waiting|r1|ntfy|alert', sentAt: 0, digest: '', ok: false, attempts: 0, nextAttemptAt: 500 })
    store.putLog({ key: 'closed|r1|ntfy|alert', sentAt: 9, digest: 'd', ok: false, attempts: 8, nextAttemptAt: null, closed: 'abandoned: max attempts' })
    store.putLog({ key: 'old|r1|ntfy|alert', sentAt: 0, digest: '', ok: false, attempts: 22, nextAttemptAt: 7 })
    expect(store.listPending().map((r) => r.key).sort()).toEqual(['failing|r1|ntfy|alert', 'old|r1|ntfy|alert', 'waiting|r1|ntfy|alert'])
    // a row written before the columns existed has no age and is not closed
    expect(store.getLog('old|r1|ntfy|alert')?.firstFailedAt).toBeUndefined()
  })

  it('adds the columns to a database from before them, and again without harm', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE nflog (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, digest TEXT NOT NULL, ok INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER)')
    db.exec('CREATE TABLE parks (incident_key TEXT PRIMARY KEY, state TEXT NOT NULL, until_at TEXT NOT NULL, parked_by TEXT NOT NULL, parked_at TEXT NOT NULL, ref TEXT, note TEXT NOT NULL, alert_keys TEXT)')
    db.exec('CREATE TABLE alerts (key TEXT PRIMARY KEY, state TEXT, incident_key TEXT)')
    db.prepare("INSERT INTO nflog VALUES ('x|r1|ntfy|alert', 0, '', 0, 22, 1000)").run()
    migrate(db)
    migrate(db)
    const cols = (db.prepare('PRAGMA table_info(nflog)').all() as unknown as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['first_failed_at', 'closed']))
    expect(new SqliteNotifyStore(db as never).listPending()).toEqual([{ key: 'x|r1|ntfy|alert', sentAt: 0, digest: '', ok: false, attempts: 22, nextAttemptAt: 1000 }])
  })
})
