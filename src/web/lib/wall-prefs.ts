// The Group toggle's stored choice (docs/design.md, "Wall groups"): whether the wall's incidents sit under their category headings. One boolean in localStorage,
// on by default, read by the full app (its toolbar button and its C key write it) and by the wall itself, so the chat panel, which draws no toolbar, follows the same
// choice (the panel's frame and Watch share one site, so they share one localStorage) and a flip in another tab reaches an open panel through the storage event.

import { useCallback, useSyncExternalStore } from 'react'

/** The localStorage key. `0` is off; anything else, or nothing, is on. */
export const GROUPED_KEY = 'watch-grouped'

type Reader = Pick<Storage, 'getItem'>
type Writer = Pick<Storage, 'setItem'>

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // storage blocked (a private window, a sandboxed frame): the choice is the default and lives only until the page closes
    return null
  }
}

/** The stored choice: on unless it was turned off. */
export function readGrouped(storage: Reader | null = browserStorage()): boolean {
  try {
    return storage?.getItem(GROUPED_KEY) !== '0'
  } catch {
    return true
  }
}

/** Store the choice (on is stored as `1`, so a later reader can tell a choice from nothing). */
export function writeGrouped(on: boolean, storage: Writer | null = browserStorage()): void {
  try {
    storage?.setItem(GROUPED_KEY, on ? '1' : '0')
  } catch {
    // nothing to do: the choice holds for this page only
  }
}

const listeners = new Set<() => void>()
let memory: boolean | null = null

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  const onStorage = (e: StorageEvent): void => {
    if (e.key === null || e.key === GROUPED_KEY) {
      memory = null
      onChange()
    }
  }
  addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    removeEventListener('storage', onStorage)
  }
}

const snapshot = (): boolean => (memory ??= readGrouped())

/** The Group toggle's value and its setter: the setter stores the choice and tells every wall on the page. */
export function useGrouped(): [boolean, (on: boolean) => void] {
  const grouped = useSyncExternalStore(subscribe, snapshot, () => true)
  const set = useCallback((on: boolean) => {
    memory = on
    writeGrouped(on)
    for (const l of listeners) l()
  }, [])
  return [grouped, set]
}
