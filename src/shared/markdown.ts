// A small, safe Markdown reader for the prose of the incident sheet.
//
// It reads a subset, never HTML: paragraphs, bullet and numbered lists, **bold**, *italic*, `code`, fenced code blocks, headings (drawn as
// bold lines), [links](https://...) and bare http(s) addresses. The result is a tree of plain data; the sheet draws the tree as React
// elements, so nothing here ever becomes markup. A `<script>` in an alert reads as the text it is, a link whose address is not http(s)
// reads as the text it was written as, and no tag, attribute or entity is ever interpreted. No dependency: the subset is small, the text is
// written by machines and agents, and a parser that cannot emit HTML cannot be tricked into it.
//
// `scanOf` is the other half: it makes a paragraph of prose scannable without rewriting a word. The first sentence is the lead line, and when
// the whole text is longer than FOLD_AFTER characters the rest goes behind a "More" disclosure, one sentence to a line.
//
// `descriptionLead` is the third reader of the same tree: the lead of a description as ONE line of plain text, for the wall tile's line
// (story.ts) and the chat panel quote (the chat channel). It lives here, in shared, because the server and the browser both read it, and it
// reads the tree the sheet draws, so a tile and the sheet never disagree about what a Markdown description says.

import { webUrl } from './evidence-links.ts'
import { linkParts } from './link-parts.ts'

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'br' }

export interface ListItem {
  c: Inline[]
  /** Indented under the item before it. */
  sub: boolean
}

export type Block =
  | { t: 'p'; c: Inline[]; raw: string }
  | { t: 'h'; c: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'code'; v: string }

/** More than this many characters of text and everything after the lead sentence goes behind "More". */
export const FOLD_AFTER = 280
/** A lead sentence longer than this is cut at its first clause so the lead stays one glance. */
export const LEAD_MAX = 240
/** ... but never earlier than this, so a lead is a thought and not a word. */
export const LEAD_MIN = 40
/** Text past this is not read: an alert description is a paragraph or two, and a bound keeps every pass linear. */
export const MAX_INPUT = 20000
/** Emphasis inside emphasis inside emphasis stops here. */
const MAX_DEPTH = 3
/** A link label longer than this is not a label. */
const LABEL_MAX = 400
/** Delimiters tried to pair up per line of text: a bound, so a line of stray asterisks costs a fixed number of passes. */
const MAX_TRIES = 200

// ---- inline ---------------------------------------------------------------------------------------------------------

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch)
const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
const ESCAPABLE = new Set([...'\\`*_{}[]()#+-.!|<>'])

/** The index of the backtick run of exactly `run` characters at or after `from`, or -1. */
function closingTicks(s: string, from: number, run: number): number {
  let j = from
  while (j < s.length) {
    if (s[j] !== '`') {
      j += 1
      continue
    }
    let n = 1
    while (s[j + n] === '`') n += 1
    if (n === run) return j
    j += n
  }
  return -1
}

/** The index where a closing delimiter run of exactly `run` `ch`s starts, skipping code spans, or -1. */
function closingRun(s: string, from: number, ch: string, run: number): number {
  let j = from
  while (j < s.length) {
    const c = s[j]
    if (c === '`') {
      let n = 1
      while (s[j + n] === '`') n += 1
      const end = closingTicks(s, j + n, n)
      j = end < 0 ? j + n : end + n
      continue
    }
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === ch) {
      let n = 1
      while (s[j + n] === ch) n += 1
      const before = s[j - 1]
      const after = s[j + n]
      if (n === run && !isSpace(before) && (ch === '*' || !isWord(after))) return j
      j += n
      continue
    }
    j += 1
  }
  return -1
}

/** The closing `]` of a link label that opens at `open`, allowing one level of brackets inside; or -1. */
function labelEnd(s: string, open: number): number {
  let depth = 0
  for (let j = open; j < s.length && j - open <= LABEL_MAX; j += 1) {
    if (s[j] === '\\') {
      j += 1
    } else if (s[j] === '[') {
      depth += 1
    } else if (s[j] === ']') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  return -1
}

/** The word a delimiter sits in, up to the whitespace before it: an address keeps its own underscores and asterisks. */
function insideAddress(s: string, at: number): boolean {
  let start = at
  while (start > 0 && !/\s/.test(s[start - 1])) start -= 1
  return /^[("'[]*https?:\/\//i.test(s.slice(start, at))
}

/** A line of text as inline nodes. Text nodes carry no markup; a bare http(s) address becomes a link node. */
export function parseInline(src: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = []
  let text = ''
  let tries = 0
  const flush = (): void => {
    if (text === '') return
    if (inLink) {
      out.push({ t: 'text', v: text })
    } else {
      for (const p of linkParts(text)) out.push(p.href ? { t: 'link', href: p.href, c: [{ t: 'text', v: p.text }] } : { t: 'text', v: p.text })
    }
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length && ESCAPABLE.has(src[i + 1])) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i += 1
      continue
    }
    if (ch === '`') {
      let run = 1
      while (src[i + run] === '`') run += 1
      const end = closingTicks(src, i + run, run)
      if (end > i + run) {
        flush()
        let v = src.slice(i + run, end).replace(/\n/g, ' ')
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim() !== '') v = v.slice(1, -1)
        out.push({ t: 'code', v })
        i = end + run
        continue
      }
      text += '`'.repeat(run)
      i += run
      continue
    }
    if (ch === '[' && !inLink && depth < MAX_DEPTH && tries++ < MAX_TRIES) {
      const close = labelEnd(src, i)
      if (close > i && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2)
        const href = end > 0 ? webUrl(src.slice(close + 2, end)) : undefined
        if (href && !/\s/.test(src.slice(close + 2, end))) {
          flush()
          out.push({ t: 'link', href, c: parseInline(src.slice(i + 1, close), depth + 1, true) })
          i = end + 1
          continue
        }
      }
    }
    if ((ch === '*' || ch === '_') && depth < MAX_DEPTH && !insideAddress(src, i)) {
      let run = 1
      while (src[i + run] === ch) run += 1
      const before = src[i - 1]
      const after = src[i + run]
      if (run <= 3 && !isSpace(after) && (ch === '*' || !isWord(before)) && tries++ < MAX_TRIES) {
        const end = closingRun(src, i + run, ch, run)
        if (end > i + run) {
          flush()
          const inner = parseInline(src.slice(i + run, end), depth + 1, inLink)
          out.push(run === 1 ? { t: 'em', c: inner } : run === 2 ? { t: 'strong', c: inner } : { t: 'strong', c: [{ t: 'em', c: inner }] })
          i = end + run
          continue
        }
      }
      text += ch.repeat(run)
      i += run
      continue
    }
    text += ch
    i += 1
  }
  flush()
  return out
}

/** The words of some inline nodes with the markup taken off; a line break reads as a space. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes
    .map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : inlineText(n.c)))
    .join('')
}

// ---- blocks ----------------------------------------------------------------------------------------------------------

const FENCE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/

/** The text as blocks. A single line break inside a paragraph is kept as a line break: machines write one fact to a line. */
export function parseMarkdown(src: string): Block[] {
  const lines = src.slice(0, MAX_INPUT).replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  let list: { ordered: boolean; base: number; items: ListItem[]; open: string[] } | null = null

  const closeItem = (): void => {
    if (list && list.open.length > 0) {
      const last = list.items[list.items.length - 1]
      last.c = parseInline(list.open.join(' '))
      list.open = []
    }
  }
  const endList = (): void => {
    if (!list) return
    closeItem()
    blocks.push({ t: 'list', ordered: list.ordered, items: list.items })
    list = null
  }
  const endPara = (): void => {
    if (para.length === 0) return
    const raw = para.join('\n').trim()
    if (raw !== '') blocks.push({ t: 'p', c: parseInline(raw), raw })
    para = []
  }

  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n]
    const fence = FENCE.exec(line)
    if (fence) {
      endPara()
      endList()
      const mark = fence[1][0]
      const body: string[] = []
      n += 1
      const closes = (l: string): boolean => {
        const t = l.trim()
        return t.length >= fence[1].length && t === mark.repeat(t.length)
      }
      while (n < lines.length && !closes(lines[n])) {
        body.push(lines[n])
        n += 1
      }
      blocks.push({ t: 'code', v: body.join('\n') })
      continue
    }
    if (line.trim() === '') {
      endPara()
      endList()
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      endPara()
      endList()
      blocks.push({ t: 'h', c: parseInline(heading[1]) })
      continue
    }
    const item = ITEM.exec(line)
    if (item) {
      endPara()
      const indent = item[1].replace(/\t/g, '  ').length
      const ordered = /\d/.test(item[2])
      if (list && list.ordered !== ordered && indent <= list.base) endList()
      if (!list) list = { ordered, base: indent, items: [], open: [] }
      closeItem()
      list.items.push({ c: [], sub: indent >= list.base + 2 })
      list.open = [item[3].trim()]
      continue
    }
    if (list) {
      // a wrapped line of the item above: it continues that item
      list.open.push(line.trim())
      continue
    }
    para.push(line)
  }
  endPara()
  endList()
  return blocks
}

// ---- scanning: the lead line and the rest ----------------------------------------------------------------------------------------

/** Words whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'etc', 'approx', 'cf', 'fig', 'no', 'st', 'dr', 'inc', 'ltd'])
/** What a sentence may start with: a capital, a digit, a code span, markup or an opening quote or bracket. */
const OPENER = /[\p{Lu}\p{N}`*_[("'‘“]/u

/** The index just after the sentence that starts at `from`: after its closing punctuation (and the markup or quote that closes with it). */
function sentenceEnd(raw: string, from: number): number {
  let depth = 0
  let code = false
  for (let i = from; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch === '\n' && !code) return i
    if (ch === '`') {
      code = !code
      continue
    }
    if (code) continue
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if ((ch === '.' || ch === '!' || ch === '?') && depth === 0) {
      let end = i + 1
      while (end < raw.length && '*_"\'’”]'.includes(raw[end])) end += 1
      if (end >= raw.length) return raw.length
      if (!/\s/.test(raw[end])) continue
      let next = end
      while (next < raw.length && /[^\S\n]/.test(raw[next])) next += 1
      if (next >= raw.length || raw[next] === '\n') return end
      if (!OPENER.test(raw[next])) continue
      const word = /([\p{L}.]+)$/u.exec(raw.slice(Math.max(from, i - 12), i))?.[1]?.toLowerCase() ?? ''
      if (ch === '.' && (ABBREVIATIONS.has(word) || /^\p{Lu}$/u.test(raw.slice(Math.max(from, i - 1), i)))) continue
      return end
    }
  }
  return raw.length
}

/** Where to cut a sentence that runs past LEAD_MAX: its last clause end (comma, semicolon, colon) or the start of a parenthesis, outside any parenthesis. */
function clauseCut(raw: string, end: number): number {
  let depth = 0
  let code = false
  let best = -1
  for (let i = 0; i < end && i <= LEAD_MAX; i += 1) {
    const ch = raw[i]
    if (ch === '`') code = !code
    if (code) continue
    if (ch === '(') {
      if (depth === 0 && raw[i - 1] === ' ' && i - 1 >= LEAD_MIN) best = i - 1
      depth += 1
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0 && (ch === ',' || ch === ';' || ch === ':') && /\s/.test(raw[i + 1] ?? '') && i + 1 >= LEAD_MIN) {
      best = i + 1
    }
  }
  if (best > 0) return best
  // no clause to cut at: the last word that fits
  const word = raw.lastIndexOf(' ', LEAD_MAX)
  return word >= LEAD_MIN ? word : -1
}

/** The end of the lead of a paragraph: its first sentence, or the first clause of it when the sentence is longer than a glance. */
export function leadEnd(raw: string): number {
  const end = sentenceEnd(raw, 0)
  if (end <= LEAD_MAX) return end
  const cut = clauseCut(raw, end)
  return cut > 0 ? cut : end
}

/** The sentences of some prose, one to a line, in order; nothing is dropped and nothing is reworded. */
export function sentencesOf(raw: string): string[] {
  const out: string[] = []
  let at = 0
  while (at < raw.length) {
    const end = sentenceEnd(raw, at)
    const one = raw.slice(at, end).trim()
    if (one !== '') out.push(one)
    at = Math.max(end, at + 1)
  }
  return out
}

export interface Scan {
  /** The first sentence of the text, drawn as the lead line; null when the text starts with a list, a heading or code (those are already scannable). */
  lead: Block | null
  /** Everything after the lead, in order. */
  rest: Block[]
  /** The rest sits behind a "More" disclosure: the text is longer than FOLD_AFTER and there is a rest. */
  fold: boolean
}

function paragraph(raw: string): Block {
  return { t: 'p', c: parseInline(raw), raw }
}

/** Plain text length of every block, for the fold threshold. */
export function textLength(blocks: readonly Block[]): number {
  let n = 0
  for (const b of blocks) {
    if (b.t === 'p' || b.t === 'h') n += inlineText(b.c).length
    else if (b.t === 'code') n += b.v.length
    else for (const it of b.items) n += inlineText(it.c).length
  }
  return n
}

/**
 * The lead of an alert's description as one line of plain text: the first block only (the first paragraph, or the first item when the text
 * opens with a list, or a heading's words, or the first line of a code block), read by the parser above with the markup taken off: bold,
 * italics, backticks and link syntax are gone, a link keeps its words, a line break inside the block reads as a space. Everything after
 * the first block (the bullets, the "How it decides" paragraph) is left out. Empty when the text has no block.
 */
export function descriptionLead(src: string): string {
  const first = parseMarkdown(src)[0]
  if (!first) return ''
  const text =
    first.t === 'list' ? inlineText(first.items[0]?.c ?? []) : first.t === 'code' ? (first.v.split('\n').find((l) => l.trim() !== '') ?? '') : inlineText(first.c)
  return text.replace(/\s+/g, ' ').trim()
}

export function scanOf(src: string): Scan {
  const blocks = parseMarkdown(src)
  if (blocks.length === 0) return { lead: null, rest: [], fold: false }
  const first = blocks[0]
  if (first.t !== 'p') return { lead: null, rest: blocks, fold: false }
  const total = textLength(blocks)
  const end = leadEnd(first.raw)
  const leadRaw = first.raw.slice(0, end).trim()
  const remainder = first.raw.slice(end).trim()
  const fold = total > FOLD_AFTER && (remainder !== '' || blocks.length > 1)
  // folded, the rest of the prose is one sentence to a line; open, it stays as the paragraph it was
  const restFirst: Block[] = remainder === '' ? [] : fold ? sentencesOf(remainder).map(paragraph) : [paragraph(remainder)]
  return { lead: paragraph(leadRaw), rest: [...restFirst, ...blocks.slice(1)], fold }
}
