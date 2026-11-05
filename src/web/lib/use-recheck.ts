// The state behind the re-check controls. A press only acknowledges: it marks the control busy (the pressed state and the spinner), and the
// request is queued behind the one settle seam (settle.ts), so it never runs while the sheet slides in or a chevron turns. The answer is
// kept for the words (lib/recheck.ts), and the wall's own state refresh (`onDone`) then shows whatever the poll changed.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AlertRecheck, WallRecheck } from '../../shared/recheck.ts'
import { api } from './api.ts'
import { afterSettle } from './settle.ts'

/** The whole wall: one control, one answer. */
export function useWallRecheck(onDone: () => void): { busy: boolean; result: WallRecheck | null; failed: boolean; press: () => void } {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<WallRecheck | null>(null)
  const [failed, setFailed] = useState(false)
  const running = useRef(false)
  const alive = useRef(true)
  const cancel = useRef<(() => void) | null>(null)
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      cancel.current?.()
    }
  }, [])

  const press = useCallback(() => {
    if (running.current) return
    running.current = true
    setBusy(true)
    cancel.current = afterSettle(() => {
      api<WallRecheck>('/api/recheck', { method: 'POST' })
        .then((r) => {
          if (!alive.current) return
          setResult(r)
          setFailed(false)
        })
        .catch(() => {
          if (alive.current) setFailed(true)
        })
        .finally(() => {
          running.current = false
          if (alive.current) setBusy(false)
          done.current()
        })
    })
  }, [])

  return { busy, result, failed, press }
}

export interface AlertRechecks {
  /** Alert keys with a re-check in flight. */
  busy: ReadonlySet<string>
  /** The latest answer for each alert that has had one. */
  results: ReadonlyMap<string, AlertRecheck>
  /** Alerts whose request did not get through. */
  failed: ReadonlySet<string>
  /** Alerts this sheet saw clear. Kept for the sheet's life, so a row that cleared stays on the page saying so. */
  cleared: ReadonlySet<string>
  /** The answers of the last press that asked for several alerts at once (the incident's control). */
  batch: ReadonlyArray<AlertRecheck> | null
  press: (keys: string[], asBatch?: boolean) => void
}

/** Re-check one or several alerts of an open sheet: the incident's control presses all of its firing alerts, a row presses its own. */
export function useAlertRechecks(onDone: () => void): AlertRechecks {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [results, setResults] = useState<ReadonlyMap<string, AlertRecheck>>(new Map())
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set())
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set())
  const [batch, setBatch] = useState<ReadonlyArray<AlertRecheck> | null>(null)
  const inflight = useRef(new Set<string>())
  const alive = useRef(true)
  const cancels = useRef(new Set<() => void>())
  const done = useRef(onDone)
  done.current = onDone

  useEffect(() => {
    alive.current = true
    const queued = cancels.current
    return () => {
      alive.current = false
      for (const c of queued) c()
    }
  }, [])

  const press = useCallback((keys: string[], asBatch = false) => {
    const todo = keys.filter((k) => !inflight.current.has(k))
    if (todo.length === 0) return
    for (const k of todo) inflight.current.add(k)
    setBusy(new Set(inflight.current))
    const cancel = afterSettle(() => {
      cancels.current.delete(cancel)
      void Promise.all(
        todo.map((k) =>
          api<AlertRecheck>(`/api/recheck/${encodeURIComponent(k)}`, { method: 'POST' })
            .then((r) => [k, r] as const)
            .catch(() => [k, null] as const)
        )
      ).then((pairs) => {
        for (const k of todo) inflight.current.delete(k)
        if (alive.current) {
          const got = pairs.filter((p): p is readonly [string, AlertRecheck] => p[1] !== null)
          setResults((prev) => new Map([...prev, ...got]))
          setFailed((prev) => {
            const next = new Set(prev)
            for (const [k, r] of pairs) (r ? next.delete(k) : next.add(k))
            return next
          })
          setCleared((prev) => {
            const next = new Set(prev)
            for (const [k, r] of got) {
              if (r.after === 'firing') next.delete(k)
              else if (r.before === 'firing') next.add(k)
            }
            return next
          })
          if (asBatch) setBatch(got.map(([, r]) => r))
          setBusy(new Set(inflight.current))
        }
        done.current()
      })
    })
    cancels.current.add(cancel)
  }, [])

  return { busy, results, failed, cleared, batch, press }
}
