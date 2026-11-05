// Referencing an incident in the chat panel, from the embed view only (docs/embed.md, "Referencing an incident"). Two ways, one result: drag a tile (or the sheet's
// title) onto the chat's composer, or press "Reference in chat". Both put the incident's own link in the person's message; the chat panel unfurls it into a card.
//   drag   dragstart sets text/uri-list (the link) and text/plain ("<title> <link>"), the two types a cross-origin drop always carries.
//   press  posts { type: 'ezo-watcher:reference', key, url, title } to the page that framed us, to its exact origin.
// Neither exists outside a frame: opened on its own, the wall has nowhere to send a reference. A press and a drag only acknowledge themselves
// (a pressed state, a dimmed tile, a "Sent" label): the page that receives it does the work.

import { Check, MessageSquareQuote } from 'lucide-react'
import { useContext, useEffect, useRef, useState } from 'react'
import type { DragEvent, DragEventHandler } from 'react'
import { DRAG_TEXT, DRAG_URI, REFERENCE_MESSAGE, dragText, incidentLink } from '../../shared/card.ts'
import { EmbedContext, framed, tellParent } from '../lib/embed.ts'
import { readMs } from '../lib/tokens.ts'

/** True in the embed view when a page frames it: the only place a reference has somewhere to go. */
export function useReferenceable(): boolean {
  return useContext(EmbedContext) && framed()
}

/** The incident's own link as the page that frames us can open it: this origin, then `/#/i/<key>`. */
const linkOf = (key: string): string => incidentLink(location.origin, key)

/**
 * The props that make an element a drag source for one incident. Spread them only when `useReferenceable()` is true. A link inside the element
 * (the tile's stretched title link) is natively draggable and would drag its own relative href, so the data is cleared and set again here.
 */
export function referenceDrag(key: string, title: string): { draggable: true; onDragStart: DragEventHandler<HTMLElement>; onDragEnd: DragEventHandler<HTMLElement> } {
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      const el = e.currentTarget
      const drag = dragText(title, linkOf(key))
      e.dataTransfer.clearData()
      e.dataTransfer.setData(DRAG_URI, drag.uri)
      e.dataTransfer.setData(DRAG_TEXT, drag.text)
      e.dataTransfer.effectAllowed = 'copyLink'
      const at = el.getBoundingClientRect()
      e.dataTransfer.setDragImage(el, e.clientX - at.left, e.clientY - at.top)
      // the dim is applied after the browser has taken the drag image, so the image is the tile as it was
      requestAnimationFrame(() => el.setAttribute('data-dragging', 'true'))
    },
    onDragEnd: (e: DragEvent<HTMLElement>) => e.currentTarget.removeAttribute('data-dragging')
  }
}

/**
 * "Reference in chat": a real button with its text label. On a narrow footer the label is "Reference" and the rest ("in chat") joins it where
 * there is room (styles/embed.css); the accessible name is always the whole phrase. After a press it says "Sent" for the acknowledgement time.
 */
export function ReferenceButton({ incidentKey, title }: { incidentKey: string; title: string }) {
  const on = useReferenceable()
  const [sent, setSent] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  if (!on) return null
  const press = (): void => {
    tellParent({ type: REFERENCE_MESSAGE, key: incidentKey, url: linkOf(incidentKey), title })
    setSent(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setSent(false), readMs('--duration-ack'))
  }
  return (
    <>
      <button type="button" className="btn ref-btn" data-sent={sent ? 'true' : undefined} onClick={press} aria-label={sent ? 'Sent to chat' : 'Reference in chat'}>
        {sent ? <Check aria-hidden="true" /> : <MessageSquareQuote aria-hidden="true" />}
        <span>{sent ? 'Sent' : 'Reference'}</span>
        <span className="ref-btn__more">{sent ? ' to chat' : ' in chat'}</span>
      </button>
      <span className="sr-only" role="status">
        {sent ? 'Sent a reference to chat.' : ''}
      </span>
    </>
  )
}
