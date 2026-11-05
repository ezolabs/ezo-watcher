/**
 * Resolve a token-derived duration (for example `--duration-ack`) to milliseconds, so no design number lives in code.
 * It reads `transition-delay`, which the reduced-motion rule leaves alone, so the value is the token's even then.
 */
export function readMs(name: string): number {
  const probe = document.createElement('div')
  probe.style.cssText = `position:absolute;visibility:hidden;transition-delay:var(${name})`
  document.body.appendChild(probe)
  const text = getComputedStyle(probe).transitionDelay
  probe.remove()
  const n = parseFloat(text)
  if (Number.isNaN(n)) return 0
  return text.endsWith('ms') ? n : n * 1000
}
