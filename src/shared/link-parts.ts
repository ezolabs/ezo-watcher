// How a comment on an incident reads in the sheet. The text is markdown an agent or a person wrote; it is shown as written (line breaks kept)
// with the http(s) addresses in it made links. Nothing is parsed into HTML, so a comment can never inject markup, and only http(s) is linked.

import { webUrl } from './evidence-links.ts'

export interface TextPart {
  text: string
  /** Set on a part that is a link: a vetted http(s) URL. */
  href?: string
}

const URL_RUN = /https?:\/\/[^\s<>"'`]+/g
/** What may end a sentence right after an address and is not part of it. */
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}'])

/** The address without the punctuation that ends the sentence around it, cut from the end so a long run of it costs one pass. */
function trimTrailing(url: string): string {
  let end = url.length
  while (end > 0 && TRAILING.has(url[end - 1])) end -= 1
  return url.slice(0, end)
}

/** The text split into plain and link parts, in order, so joining the `text`s gives the original back. */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const m of text.matchAll(URL_RUN)) {
    const at = m.index ?? 0
    const url = trimTrailing(m[0])
    const href = webUrl(url)
    if (!href || url === '') continue
    if (at > last) parts.push({ text: text.slice(last, at) })
    parts.push({ text: url, href })
    last = at + url.length
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
