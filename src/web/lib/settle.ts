// The one settle seam of the wall (docs/design.md, Motion and heavy work; the ui-responsiveness rule).
//
// An input handler only acknowledges: it paints the pressed state and starts whatever animates. Work a press triggers (a fetch, a write, a
// heavy mount) never runs while something is animating. It is queued here and released once, on the REAL end of every finite animation in the
// document (the sheet sliding in, a chevron turning), plus one idle slot. A newer animation that starts while we wait supersedes the older
// one: the loop looks again before it releases. An endless animation (the re-check spinner) is the acknowledgement itself, never a thing to
// wait for, so it is skipped. If an end event is lost, the animation's own remaining length plus a token margin releases the wait.

import { readMs } from './tokens.ts'

type Job = () => void

const queue = new Set<Job>()
let draining = false

/** Animations and transitions that will end: not paused, not endless. */
function finiteRunning(): Animation[] {
  return document.getAnimations().filter((a) => {
    if (a.playState !== 'running') return false
    const t = a.effect?.getComputedTiming()
    return !!t && Number.isFinite(t.endTime)
  })
}

/** How long one animation has left, from its own timing. */
function remainingMs(a: Animation): number {
  const t = a.effect?.getComputedTiming()
  const end = typeof t?.endTime === 'number' ? t.endTime : 0
  const at = typeof a.currentTime === 'number' ? a.currentTime : 0
  return Math.max(0, end - at)
}

/** One idle slot: the browser's idle callback, else the frame after the next one. Bounded by a token duration so a busy page still releases. */
function idleSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(() => resolve(), { timeout: readMs('--duration-250') })
      return
    }
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

/** Settles when `a` really ends, or when its remaining length plus a margin has gone, whichever comes first. */
function ended(a: Animation): Promise<unknown> {
  const margin = readMs('--duration-100')
  // the fallback the seam is allowed: the animation's own remaining length plus a token margin, for an end event that never comes
  return Promise.race([a.finished.catch(() => undefined), new Promise((resolve) => window.setTimeout(resolve, remainingMs(a) + margin /* settle-seam */))])
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    for (;;) {
      for (let live = finiteRunning(); live.length > 0; live = finiteRunning()) await Promise.all(live.map(ended))
      await idleSlot()
      // a newer animation may have started during the idle slot: it supersedes this release
      if (finiteRunning().length === 0) break
    }
    const jobs = [...queue]
    queue.clear()
    for (const job of jobs) job()
  } finally {
    draining = false
  }
}

/** Run `job` once nothing finite is animating. Returns a cancel for a caller that unmounts first. */
export function afterSettle(job: Job): () => void {
  queue.add(job)
  void drain()
  return () => {
    queue.delete(job)
  }
}
