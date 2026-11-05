// Who is acknowledging. Watch has no login, so the first acknowledge from a browser asks for a name once and keeps it in localStorage;
// the name rides each acknowledge, silence and unacknowledge as the `by` of the request and is stored with it. A person who skips is
// "this browser", never "wall". The Notifications page changes it later. The rules for a name (length, control characters) are
// src/shared/who.ts, the same ones the server applies.

import { FALLBACK_NAME, cleanName } from '../../shared/who.ts'

export const NAME_KEY = 'watch-name'
export const SKIPPED_KEY = 'watch-name-skipped'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** localStorage, or null where a browser refuses it (a private window), in which case nothing is kept and the name is asked each time. */
function browserStore(): Store | null {
  try {
    return localStorage
  } catch {
    return null
  }
}

/** The name this browser gave, or null. */
export function savedName(store: Store | null = browserStore()): string | null {
  const name = cleanName(store?.getItem(NAME_KEY))
  return name === '' ? null : name
}

/** True once the person chose "this browser" instead of a name: the prompt is not shown again. */
export function nameSkipped(store: Store | null = browserStore()): boolean {
  return store?.getItem(SKIPPED_KEY) === '1'
}

/** The first acknowledge asks, once: when there is neither a name nor a recorded skip. */
export function needsName(store: Store | null = browserStore()): boolean {
  return savedName(store) === null && !nameSkipped(store)
}

/** Keep a name. An empty one forgets it and counts as a skip, so the person is "this browser" and is not asked again. Returns what was kept. */
export function saveName(raw: string, store: Store | null = browserStore()): string | null {
  const name = cleanName(raw)
  if (name === '') {
    store?.removeItem(NAME_KEY)
    store?.setItem(SKIPPED_KEY, '1')
    return null
  }
  store?.setItem(NAME_KEY, name)
  store?.removeItem(SKIPPED_KEY)
  return name
}

/** Choose "this browser": no name, and no more asking. */
export function skipName(store: Store | null = browserStore()): void {
  store?.removeItem(NAME_KEY)
  store?.setItem(SKIPPED_KEY, '1')
}

/** The name the server is sent as `by`. */
export function actorBy(store: Store | null = browserStore()): string {
  return savedName(store) ?? FALLBACK_NAME
}

// ---- the prompt ---------------------------------------------------------------------------------------------------------------
// One prompt at a time, a tiny store the dialog in App.tsx reads (useSyncExternalStore), so no handler holds React state for it.

let pending: Promise<boolean> | null = null
let settle: ((go: boolean) => void) | null = null
const listeners = new Set<() => void>()

export function subscribePrompt(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const promptOpen = (): boolean => pending !== null

function emit(): void {
  for (const l of listeners) l()
}

/** Open the prompt. Resolves true when the person saved a name or chose this browser, false when they cancelled. */
export function askName(): Promise<boolean> {
  if (pending) return pending
  pending = new Promise<boolean>((resolve) => {
    settle = resolve
  })
  emit()
  return pending
}

/** Close the prompt with the person's choice. */
export function answerName(choice: { save: string } | 'skip' | 'cancel'): void {
  if (choice === 'skip') skipName()
  else if (choice !== 'cancel') saveName(choice.save)
  const done = settle
  pending = null
  settle = null
  emit()
  done?.(choice !== 'cancel')
}

/** True once there is a name to send or the person chose not to give one; asks first when neither is so. */
export function ensureName(): Promise<boolean> {
  return needsName() ? askName() : Promise.resolve(true)
}
