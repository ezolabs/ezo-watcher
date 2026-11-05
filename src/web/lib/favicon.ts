// The tab icon as a status light: the Status Eye's pupil is grey while nothing needs anyone, and the one coloured spot in the tab strip while a
// page fires that nobody has taken (danger red), else such a warning (warn amber). The icon is the mark's 16 px cut (three bars round the
// pupil: at 16 px the full mark's five bars run together); public/favicon.svg is this template with the grey pupil, the icon before any state.

import { useEffect } from 'react'
import type { WallState } from '../../shared/types.ts'

/** What the tab icon says: an unattended page, else an unattended warning, else nothing. */
export type FaviconStatus = 'page' | 'warning' | 'neutral'

/** The pupil per status, the theme's own colours (styles/tokens.css: --color-danger, --color-warn, the dark scheme's --color-fg). */
export const PUPIL: Record<FaviconStatus, string> = { page: '#f23f42', warning: '#f0b132', neutral: '#e6e8ee' }

/** The 16 px cut of the mark on the 64-unit tile: the bars notched and split by a ring round the pupil (r 8, the ring to 12). */
const BARS =
  'M15.03 16H48.97A2 2 0 0 1 50.51 16.73A24 24 0 0 1 52.44 19.43A3 3 0 0 1 49.89 24H41.59A1.5 1.5 0 0 1 40.53 23.56A12 12 0 0 0 23.47 23.56A1.5 1.5 0 0 1 22.41 24H14.11A3 3 0 0 1 11.56 19.43A24 24 0 0 1 13.49 16.73A2 2 0 0 1 15.03 16Z' +
  'M12 28H18.73A1.5 1.5 0 0 1 20.21 29.78A12 12 0 0 0 20.21 34.22A1.5 1.5 0 0 1 18.73 36H12A4 4 0 0 1 12 28Z' +
  'M52 28H45.27A1.5 1.5 0 0 0 43.79 29.78A12 12 0 0 1 43.79 34.22A1.5 1.5 0 0 0 45.27 36H52A4 4 0 0 0 52 28Z' +
  'M15.03 48H48.97A2 2 0 0 0 50.51 47.27A24 24 0 0 0 52.44 44.57A3 3 0 0 0 49.89 40H41.59A1.5 1.5 0 0 0 40.53 40.44A12 12 0 0 1 23.47 40.44A1.5 1.5 0 0 0 22.41 40H14.11A3 3 0 0 0 11.56 44.57A24 24 0 0 0 13.49 47.27A2 2 0 0 0 15.03 48Z'

/** The tab icon with a given pupil: the app tile (#0d0d0d, a #3a3b40 hairline, radius 16 of 64), the bars in the dark scheme's text colour. */
export function faviconSvg(pupil: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect x="0.5" y="0.5" width="63" height="63" rx="15.5" fill="#0d0d0d" stroke="#3a3b40"/>' +
    `<path fill="${PUPIL.neutral}" d="${BARS}"/><circle cx="32" cy="32" r="8" fill="${pupil}"/></svg>`
  )
}

/** The icon for a status as a data URL (the page's CSP allows `data:` images). */
export function faviconHref(status: FaviconStatus): string {
  return `data:image/svg+xml,${encodeURIComponent(faviconSvg(PUPIL[status]))}`
}

/** The status the wall's state gives the icon. Acked, silenced and parked incidents have someone or a verdict on them: they colour nothing, as they page no one. */
export function faviconStatus(state: WallState | null): FaviconStatus {
  const unattended = state?.incidents.filter((i) => i.state.attention === 'none') ?? []
  if (unattended.some((i) => i.severity === 'page')) return 'page'
  if (unattended.some((i) => i.severity === 'warning')) return 'warning'
  return 'neutral'
}

/**
 * Points the page's icon link at the status. Writes nothing when the link already shows it, so a poll that changes nothing leaves the DOM alone;
 * the link as index.html ships it (no `data-status`) shows the grey pupil. Returns whether it wrote.
 */
export function showFavicon(doc: Pick<Document, 'querySelector'>, status: FaviconStatus): boolean {
  const link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link || (link.dataset.status ?? 'neutral') === status) return false
  link.dataset.status = status
  link.setAttribute('href', faviconHref(status))
  return true
}

/** Keeps the tab icon on the wall's state while the app is mounted, and puts the grey pupil back when it unmounts. */
export function useStatusFavicon(state: WallState | null): void {
  const status = faviconStatus(state)
  useEffect(() => {
    showFavicon(document, status)
  }, [status])
  useEffect(
    () => () => {
      showFavicon(document, 'neutral')
    },
    []
  )
}
