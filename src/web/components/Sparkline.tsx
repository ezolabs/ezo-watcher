// A sparkline: one inline SVG, no chart library. The box is `(n - 1) x PERCENT_SCALE` user units with a non-scaling stroke, so the CSS (the
// stroke width and colour, the width and height tokens) decides how it draws and the geometry stays a plain path. Width and height are explicit
// attributes read from the tokens, so the row's box is the same before and after the stylesheet and the first paint.

import { PERCENT_SCALE, sparkPath, tokenPx } from '../lib/fleet.ts'

export function Sparkline({
  values,
  label,
  size,
  mark
}: {
  /** One point a minute, oldest first, null for a minute with no reading. */
  values: ReadonlyArray<number | null>
  /** What a screen reader hears: "CPU over the last 60 min, low 41%, high 55%, now 55%". */
  label: string
  /** Which token pair sizes it: the page's, the disk cell's (the compact width) or the strip's. */
  size: 'page' | 'disk' | 'strip'
  /** A threshold to draw as a hairline across the box (the CPU rule's warnAbove), in the same percent scale. */
  mark?: number | null
}) {
  const w = tokenPx(size === 'page' ? '--fleet-spark-w' : size === 'disk' ? '--fleet-disk-spark-w' : '--fleet-strip-spark-w')
  const h = tokenPx(size === 'strip' ? '--fleet-strip-spark-h' : '--fleet-spark-h')
  const last = Math.max(1, values.length - 1)
  const d = sparkPath(values)
  return (
    <svg
      className="spark"
      data-size={size}
      width={w || undefined}
      height={h || undefined}
      viewBox={`0 0 ${last} ${PERCENT_SCALE}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {typeof mark === 'number' && <line className="spark__mark" x1={0} x2={last} y1={PERCENT_SCALE - mark} y2={PERCENT_SCALE - mark} />}
      {d && <path className="spark__line" d={d} />}
    </svg>
  )
}
