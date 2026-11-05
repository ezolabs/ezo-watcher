// What a press on Acknowledge, Remove acknowledgement or Silence sends. The press only acknowledges itself in the control; the request
// waits behind the one settle seam (settle.ts) so it never runs while the sheet slides in, and it carries who is acting as `by`.

import { api } from './api.ts'
import { afterSettle } from './settle.ts'
import { actorBy, ensureName } from './who.ts'

/** POST to an incident action as the person using this browser. Resolves true when Watch took it. */
export function sendAs(path: string, body: Record<string, unknown> = {}): Promise<boolean> {
  return new Promise((resolve) => {
    afterSettle(() => {
      api(path, { method: 'POST', body: JSON.stringify({ ...body, by: actorBy() }) }).then(
        () => resolve(true),
        () => resolve(false)
      )
    })
  })
}

const incidentPath = (key: string, action: string): string => `/api/incidents/${encodeURIComponent(key)}/${action}`

/** Acknowledge an incident. The first time from a browser it asks for a name; cancelling the prompt acknowledges nothing. */
export async function acknowledge(incidentKey: string): Promise<boolean> {
  if (!(await ensureName())) return false
  return sendAs(incidentPath(incidentKey, 'ack'))
}

export const unacknowledge = (incidentKey: string): Promise<boolean> => sendAs(incidentPath(incidentKey, 'unack'))

export const silence = (incidentKey: string, minutes: number): Promise<boolean> => sendAs(incidentPath(incidentKey, 'silence'), { minutes })
