import { useEffect, useState } from 'react'
import { api, useFetch } from '../lib/api.ts'
import type { NotificationsInfo } from '../lib/api.ts'
import { agoText, durationText } from '../lib/format.ts'
import { outcomeWords, receiverWords, subjectWords } from '../lib/receivers.ts'
import { Chip, Empty, SkeletonRows } from '../components/ui.tsx'
import { NameField } from '../components/Who.tsx'
import { href } from '../lib/route.ts'
import { useInstance } from '../lib/instance.ts'

const TYPE_TEXT: Record<string, string> = {
  ntfy: 'ntfy push',
  webpush: 'Web push to browsers and installed apps',
  sms: 'SMS',
  email: 'Email',
  file: 'JSONL file on this host (no credential)',
  webhook: 'Generic webhook'
}

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function routeSentence(r: NotificationsInfo['routes'][number]): string {
  const sev = r.match.severity?.length ? r.match.severity.join(' and ') : ''
  const subject = sev ? `${sev.charAt(0).toUpperCase()}${sev.slice(1)} alerts` : 'All alerts'
  const from = r.match.origin?.length ? ` from ${r.match.origin.join(' and ')}` : ''
  if (r.receivers.length === 0) return `${subject}${from} stay on the wall. Nobody is notified.`
  const to = r.receivers.join(r.mode === 'ladder' ? ', then ' : ' and ')
  const parts = [
    `${subject}${from} go to ${to}${r.mode === 'ladder' ? ' (first one that answers)' : ''}.`,
    `First notification after ${durationText(r.groupWaitSec)}, a change after ${durationText(r.groupIntervalSec)}, a reminder every ${durationText(r.repeatIntervalSec)}.`
  ]
  for (const e of r.escalate ?? []) parts.push(`Unacknowledged for ${durationText(e.afterSec)} adds ${e.receivers.join(' and ')}.`)
  if (r.record?.length) parts.push(`${r.record.join(' and ')} keeps a record.`)
  if (r.match.severity?.includes('page') && r.coalesce?.maxPages !== 0) {
    const max = r.coalesce?.maxPages ?? 10
    const window = r.coalesce?.windowSec ?? 600
    parts.push(`More than ${max} pages from one origin in ${durationText(window)} are held back and told in one summary.`)
  }
  if (r.muteInQuietHours) parts.push('Held during quiet hours, then one digest.')
  else if (r.match.severity?.includes('page')) parts.push('Ignores quiet hours.')
  return parts.join(' ')
}

export function Notifications({ nowMs, scheme, setScheme }: { nowMs: number; scheme: string; setScheme: (s: string) => void }) {
  const { data, reload } = useFetch<NotificationsInfo>('/api/notifications', 10000)
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Record<string, string>>({})
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off' | 'denied' | 'unsupported'>('unknown')
  const [install, setInstall] = useState<Event | null>(null)
  const { brand } = useInstance()

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushState('unsupported')
      return
    }
    void navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setPushState(s ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off'))
    const on = (e: Event): void => {
      e.preventDefault()
      setInstall(e)
    }
    addEventListener('beforeinstallprompt', on)
    return () => removeEventListener('beforeinstallprompt', on)
  }, [])

  const test = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      const r = await api<{ ok: boolean; status: string; latencyMs: number }>('/api/notifications/test', { method: 'POST', body: JSON.stringify({ channel: id }) })
      // "no subscribers" is the Web Push channel's NO_SUBSCRIBERS (src/server/notify/channels/webpush.ts): not configured, not a failed delivery.
      const said = r.ok ? `Delivered in ${(r.latencyMs / 1000).toFixed(1)} s` : r.status === 'no subscribers' ? 'Nobody to deliver to: no device has push turned on' : `Failed: ${r.status}`
      setOutcome((o) => ({ ...o, [id]: said }))
    } catch (e) {
      setOutcome((o) => ({ ...o, [id]: `Failed: ${(e as Error).message}` }))
    } finally {
      setBusy(null)
      reload()
    }
  }

  const enablePush = async (): Promise<void> => {
    if (!data?.push.publicKey) return
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') {
      setPushState('denied')
      return
    }
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.push.publicKey) })
    await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) })
    setPushState('on')
    reload()
  }

  const disablePush = async (): Promise<void> => {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })
      await sub.unsubscribe()
    }
    setPushState('off')
    reload()
  }

  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent)

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Notifications</h1>
          <p className="statusline">How Watch reaches people. Every channel below has to pass a real test before you rely on it.</p>
        </div>
      </div>

      <div className="section">
        <h2 className="section__title">Channels</h2>
        {!data && <SkeletonRows n={4} />}
        {data && data.channels.length === 0 && <Empty sentence="No notification channels are configured." action={<a className="btn" href={href({ view: 'wall' })}>Back to the wall</a>} />}
        {data && data.channels.length > 0 && (
          <div className="rows">
            {data.channels.map((c) => (
              <div key={c.id} className="row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span>
                  <span className="row__title">{TYPE_TEXT[c.type] ?? c.type}</span>
                  <br />
                  <span className="row__sub">
                    {c.id !== c.type ? `${c.id}. ` : ''}
                    {!c.enabled
                      ? 'Not configured on the host: its credential or recipient is missing.'
                      : c.lastTest === 'unconfigured'
                      ? `Not configured: the last test ${agoText(c.lastTestAt, nowMs)} found no device with push turned on. Turn it on under This device.`
                      : c.lastTestAt
                      ? `Last real test ${c.lastTestOk ? 'passed' : 'failed'} ${agoText(c.lastTestAt, nowMs)}.`
                      : 'Never tested.'}
                    {outcome[c.id] ? ` ${outcome[c.id]}.` : ''}
                  </span>
                </span>
                <span className="row__aside">
                  <button type="button" className="btn" disabled={busy !== null || !c.enabled} onClick={() => void test(c.id)}>
                    {busy === c.id ? 'Sending' : 'Send test'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h2 className="section__title">Routing</h2>
        {data && data.routes.length === 0 && <p className="note">No routes are configured, so nothing is sent.</p>}
        {data && data.routes.length > 0 && (
          <div className="rows">
            {data.routes.map((r) => (
              <div key={r.id} className="row" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
                <span>
                  <span className="row__title">{r.id}</span>
                  <br />
                  <span className="row__sub">{routeSentence(r)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {data?.quietHours && data.routes.some((r) => r.muteInQuietHours) && (
          <p className="note">
            Quiet hours run {data.quietHours.start} to {data.quietHours.end} in {data.quietHours.tz}. Pages ignore them.
          </p>
        )}
      </div>

      <div className="section">
        <h2 className="section__title">Recent sends</h2>
        {!data && <SkeletonRows n={4} />}
        {data && data.results.length === 0 && <Empty sentence="Nothing has been sent yet." action={<a className="btn" href={href({ view: 'wall' })}>Back to the wall</a>} />}
        {data && data.results.length > 0 && (
          <div className="rows">
            {data.results.slice(0, 15).map((r, k) => (
              <div key={`${r.at}-${k}`} className="row" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span>
                  <span className="row__title">{receiverWords(r.channel_id)}</span>
                  <br />
                  <span className="row__sub">
                    {r.kind}, {subjectWords(r.incident_key)}
                  </span>
                </span>
                <span className="row__aside">
                  <span className="num">{agoText(new Date(r.at).toISOString(), nowMs)}</span>
                  <span>{outcomeWords(r)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <h2 className="section__title">This device</h2>
        {pushState === 'unsupported' && <p className="note">This browser cannot receive web push.</p>}
        {ios && !standalone && <p className="note">On iPhone and iPad, add {brand.name} to the Home Screen first. Apple delivers web push only to installed apps.</p>}
        <div className="actions">
          {pushState === 'off' && (
            <button type="button" className="btn" data-variant="primary" onClick={() => void enablePush()} disabled={!data?.push.publicKey}>
              Turn on push for this device
            </button>
          )}
          {pushState === 'on' && (
            <button type="button" className="btn" onClick={() => void disablePush()}>
              Turn off push for this device
            </button>
          )}
          {pushState === 'denied' && <Chip muted>Notifications are blocked in this browser</Chip>}
          {install && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                const e = install as unknown as { prompt: () => Promise<void> }
                void e.prompt()
                setInstall(null)
              }}
            >
              Install {brand.name}
            </button>
          )}
        </div>
        {data && <p className="note">{data.push.subscribers} {data.push.subscribers === 1 ? 'device receives' : 'devices receive'} web push.</p>}
        <NameField />
        <div className="actions" role="group" aria-label="Colour scheme">
          <div className="seg">
            {['light', 'dark', 'auto'].map((s) => (
              <button key={s} type="button" aria-pressed={scheme === s} onClick={() => setScheme(s)}>
                {s === 'light' ? 'Light' : s === 'dark' ? 'Dark' : 'Match system'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
