// Which Watcher this is: its name (config `brand`) and the optional views its server backs. Pure, so the server (config validation, the served page,
// the channels, the MCP server) and the web (the header, the nav, the title) read one definition. The server says it in two places: the
// `watch-instance` meta of every page it serves (so the first paint already has the right name and nav) and GET /api/instance (the dev server,
// which serves a page of its own, asks there).

import type { Brand, InstanceInfo, WatchFeature } from './types.ts'

/** What a config with no `brand` is called. */
export const DEFAULT_BRAND: Readonly<Required<Brand>> = { name: 'EZO Watcher', shortName: 'Watcher' }

export const BRAND_NAME_MAX = 40
export const BRAND_SHORT_MAX = 24

/** Every optional view, in nav order. */
export const ALL_FEATURES: readonly WatchFeature[] = ['fleet']

/** The meta tag the server writes into the page it serves. */
export const INSTANCE_META = 'watch-instance'

/** The name and the short name, defaults filled: no brand is EZO Watcher, a brand with no short name uses its name. */
export function resolveBrand(brand: Brand | undefined): Required<Brand> {
  if (!brand) return { ...DEFAULT_BRAND }
  return { name: brand.name, shortName: brand.shortName ?? brand.name }
}

const oneLine = (v: unknown, max: number): boolean => typeof v === 'string' && v.trim() !== '' && v === v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)

/** What is wrong with a config's `brand`, field-named; empty when it is right (or absent). */
export function brandProblems(raw: unknown): string[] {
  if (raw === undefined) return []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ['brand must be an object with name and optionally shortName']
  const { name, shortName, ...rest } = raw as { name?: unknown; shortName?: unknown }
  const out: string[] = []
  if (!oneLine(name, BRAND_NAME_MAX)) out.push(`brand.name must be one line of 1 to ${BRAND_NAME_MAX} characters with no leading or trailing space`)
  if (shortName !== undefined && !oneLine(shortName, BRAND_SHORT_MAX)) out.push(`brand.shortName must be one line of 1 to ${BRAND_SHORT_MAX} characters with no leading or trailing space`)
  for (const k of Object.keys(rest)) out.push(`brand.${k} is not a brand field (name, shortName)`)
  return out
}

/** What a page assumes until its server says otherwise (the dev server's page carries no meta): the default name and every view. */
export const fullInstance = (): InstanceInfo => ({ brand: { ...DEFAULT_BRAND }, features: [...ALL_FEATURES] })

/**
 * An InstanceInfo read from what the page or the server said, or null when it is not one: a name that is not a short line, a feature this build
 * does not know (dropped, never guessed) or a shape that is not the contract. Never throws.
 */
export function parseInstance(raw: unknown): InstanceInfo | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { brand, features } = raw as { brand?: unknown; features?: unknown }
  if (brandProblems(brand).length > 0 || brand === undefined) return null
  const b = brand as Brand
  if (!Array.isArray(features)) return null
  return { brand: resolveBrand(b), features: ALL_FEATURES.filter((f) => features.includes(f)) }
}
