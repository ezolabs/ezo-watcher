// Which Watcher this server is: its brand (config `brand`) and the optional views it can back. A view whose backing is not configured here is not in
// the nav at all (the web reads this, src/web/lib/instance.ts), so a second Watcher shows only what it watches.
//
// The server says it twice: GET /api/instance, and a `watch-instance` meta written into every page it serves, with the page title and the
// installed app's name set to the brand, so the first paint is already right (no name flash, no nav that grows or shrinks).

import { INSTANCE_META } from '../shared/instance.ts'
import type { Brand, InstanceInfo, WatchFeature } from '../shared/types.ts'
import type { WatchConfig } from './config.ts'
import { brandOf } from './config.ts'

/**
 * The optional views this server backs, in nav order: `fleet` needs a `netdata-fleet` source (GET /api/fleet answers 503 without one). The wall,
 * History, Notifications and Sources are on every Watcher and are never listed.
 */
export function featuresOf(cfg: Pick<WatchConfig, 'sources'>): WatchFeature[] {
  const has: Record<WatchFeature, boolean> = { fleet: cfg.sources.some((s) => s.type === 'netdata-fleet') }
  return (Object.keys(has) as WatchFeature[]).filter((f) => has[f])
}

export function instanceInfo(cfg: Pick<WatchConfig, 'brand' | 'sources'>): InstanceInfo {
  return { brand: brandOf(cfg), features: featuresOf(cfg) }
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/**
 * The built index.html as this Watcher serves it: the title is the brand's name, and the instance rides in a meta tag just before </head> (a meta, not
 * an inline script: the content security policy allows scripts from this origin only). A page with no </head> is served as it was.
 */
export function pageWithInstance(html: string, info: InstanceInfo): string {
  const meta = `<meta name="${INSTANCE_META}" content="${escapeHtml(JSON.stringify(info))}" />`
  const titled = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(info.brand.name)}</title>`)
  const at = titled.indexOf('</head>')
  return at < 0 ? titled : `${titled.slice(0, at)}  ${meta}\n  ${titled.slice(at)}`
}

/** The web app manifest with this Watcher's name and short name, so an installed copy is labelled for its instance. A file that is not JSON is served as it was. */
export function manifestWithBrand(text: string, brand: Required<Brand>): string {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return text
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return text
  const named = m as Record<string, unknown>
  // the file's own bytes when it already says so
  if (named.name === brand.name && named.short_name === brand.shortName) return text
  return `${JSON.stringify({ ...named, name: brand.name, short_name: brand.shortName }, null, 2)}\n`
}
