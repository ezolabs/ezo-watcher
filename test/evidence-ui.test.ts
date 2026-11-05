import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ChatLine, InstanceLinks, LinkControl, Terminal } from '../src/web/components/Evidence.tsx'
import { Inline } from '../src/web/components/StorySheet.tsx'
import { evidenceLinks } from '../src/shared/evidence-links.ts'
import { sortLinks } from '../src/shared/story.ts'

const TOPIC = 'https://chat.example.com/#narrow/channel/8-triage/topic/sweep.202026-10-15'
const node5 = {
  annotations: {
    summary: 'node-5 disk / 81% (175 GB free, full in ~8h)',
    report_url: `${TOPIC}/near/82`,
    triage: TOPIC,
    evidence: "ssh node-5 'df -h /; du -xh --max-depth=1 / | sort -h | tail'",
    evidence_url: 'https://chat.example.com/user_uploads/2/ab/df-node-5.txt',
    runbook_url: 'https://wiki.example.com/runbooks/disk-fill'
  }
}

describe('the command and its output', () => {
  const html = renderToStaticMarkup(createElement(Terminal, { command: "ssh node-5 'df -h /'", output: 'Filesystem  Use%\n/dev/sda1   81%' }))

  it('shows the whole command with one Copy button, and the output under it in the same block', () => {
    expect(html).toContain('<code class="term__text">ssh node-5 &#x27;df -h /&#x27;</code>')
    expect(html.match(/>Copy</g)).toHaveLength(1)
    expect(html.indexOf('term__cmd')).toBeLessThan(html.indexOf('term__out'))
    expect(html).toContain('Filesystem  Use%\n/dev/sda1   81%')
  })

  it('makes the output a focusable, named region so a scrolling block can be reached by keyboard', () => {
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Captured output"')
    expect(html).toContain('tabindex="0"')
  })

  it('draws only what it was given: output with no command has no Copy button, and a cut output says so', () => {
    const out = renderToStaticMarkup(createElement(Terminal, { output: 'exit code: 1', clipped: true }))
    expect(out).not.toContain('Copy')
    expect(out).toContain('Output cut at 4 KB')
    expect(renderToStaticMarkup(createElement(Terminal, { command: 'x' }))).not.toContain('term__out')
  })
})

describe('the link controls', () => {
  const sorted = sortLinks(evidenceLinks(node5))

  it('sorts the chat links away from the controls, so no report or topic link can become a button', () => {
    expect(sorted.chat.map((l) => l.label)).toEqual(['Report in #triage', 'Topic in #triage'])
    expect(sorted.runbook.map((l) => l.label)).toEqual(['Runbook'])
    expect(sorted.evidence.map((l) => l.label)).toEqual(['Open the evidence'])
  })

  it('draws a control as a bordered, never inverse, link with an icon, a label and a new-tab note', () => {
    const html = renderToStaticMarkup(createElement(LinkControl, { link: sorted.runbook[0] }))
    expect(html).toContain('class="btn"')
    expect(html).not.toContain('data-variant')
    expect(html).toContain('<svg')
    expect(html).toContain('<span>Runbook</span>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('(opens in a new tab)')
  })
})

describe('Also in the chat panel', () => {
  it('is one small line of text links, with no button in it', () => {
    const html = renderToStaticMarkup(createElement(ChatLine, { links: sortLinks(evidenceLinks(node5)).chat }))
    expect(html).toContain('Also in the chat panel:')
    expect(html).toContain('class="link"')
    expect(html).toContain('Report in #triage')
    expect(html).toContain(' and ')
    expect(html).toContain('Topic in #triage')
    expect(html).not.toContain('class="btn"')
    expect(html).not.toContain('data-variant')
  })

  it('renders nothing when the alert has no chat link, so the page ends on what it knows', () => {
    expect(renderToStaticMarkup(createElement(ChatLine, { links: [] }))).toBe('')
  })
})

describe('an instance row', () => {
  it('gives each instance its own evidence link and a Copy command button named for it, and leaves the chat report to its own page', () => {
    const html = renderToStaticMarkup(createElement(InstanceLinks, { source: node5, name: 'node-5' }))
    expect(html).toContain('<span>Evidence</span>')
    expect(html).toContain('aria-label="Open the evidence for node-5 (opens in a new tab)"')
    expect(html).toContain('Copy command')
    expect(html).toContain('aria-label="Copy command for node-5"')
    expect(html).not.toContain('Report')
    expect(html).not.toContain('runbook')
    expect(evidenceLinks(node5).filter((l) => l.kind === 'runbook')).toHaveLength(1)
  })

  it('renders nothing for an instance with no links', () => {
    expect(renderToStaticMarkup(createElement(InstanceLinks, { source: { annotations: { summary: 'x' } }, name: 'x' }))).toBe('')
  })
})

describe('a command inside a sentence', () => {
  it('draws a backticked run as inline code and leaves the rest as text', () => {
    const html = renderToStaticMarkup(createElement(Inline, { text: 'Run `intake.sh 6 --source sink_stale` to list the stale tables.' }))
    expect(html).toBe('Run <code>intake.sh 6 --source sink_stale</code> to list the stale tables.')
  })

  it('draws plain text, and an unpaired backtick, untouched', () => {
    expect(renderToStaticMarkup(createElement(Inline, { text: 'Restart the Helper.' }))).toBe('Restart the Helper.')
    expect(renderToStaticMarkup(createElement(Inline, { text: 'a ` b' }))).toBe('a ` b')
  })
})
