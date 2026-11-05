// The notification log's key and the one question every reader of a row asks: is anything still owed on it.

import type { LogRow } from './types.ts'

/** `${incident}|${route}|${receiver}|${stage}`: stage is "alert", "esc0", "flap", "resolved", "digest", "summary", "sumesc0". */
export function logKey(incident: string, routeId: string, receiverId: string, stage: string): string {
  return `${incident}|${routeId}|${receiverId}|${stage}`
}

/** Delivered, or closed without a send (given up, no longer owed, coalesced): either way nothing is owed on this row until the repeat gate says so. */
export function isSettled(row: LogRow): boolean {
  return row.ok || row.closed !== undefined
}

/** The four parts of a log key, from the right (an incident key can hold a "|" itself; a route, receiver or stage never does). */
export function parseLogKey(key: string): { incident: string; routeId: string; receiverId: string; stage: string } | null {
  const parts = key.split('|')
  if (parts.length < 4) return null
  const stage = parts.pop() as string
  const receiverId = parts.pop() as string
  const routeId = parts.pop() as string
  return { incident: parts.join('|'), routeId, receiverId, stage }
}


/** A closed row whose alert went into a summary says so with these words, followed by the summary's id. */
export const COALESCED_PREFIX = 'coalesced into '
