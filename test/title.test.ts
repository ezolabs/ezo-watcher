import { describe, expect, it } from 'vitest'
import { breakSegments, fitWords } from '../src/web/lib/title.ts'

describe('where a tile title may break', () => {
  it('offers the joints of a hostname, a path and a CamelCase name, and nothing inside a word', () => {
    expect(breakSegments('chat.example.com')).toEqual(['chat.', 'example.', 'com'])
    expect(breakSegments('web-prod/scraper')).toEqual(['web-', 'prod/', 'scraper'])
    expect(breakSegments('IntakeContainerLogFailure')).toEqual(['Intake', 'Container', 'Log', 'Failure'])
    expect(breakSegments('ProbeDown')).toEqual(['Probe', 'Down'])
    expect(breakSegments('scraper')).toEqual(['scraper'])
    expect(breakSegments('HTTP502')).toEqual(['HTTP502'])
    expect(breakSegments('')).toEqual([])
  })

  it('keeps every letter: the pieces rejoin to the word', () => {
    for (const w of ['chat.example.com', 'api-internal.mas.gov', 'IntakeSinkStale', 's2_uptime:probe', 'mas.gov']) expect(breakSegments(w).join('')).toBe(w)
  })
})

describe('a title that does not fit', () => {
  const room = (max: number) => (candidate: string) => candidate.length <= max

  it('is left whole when it fits', () => {
    expect(fitWords('mas.gov status page', room(30))).toBe('mas.gov status page')
    expect(fitWords('watch.example.com', room(17))).toBe('watch.example.com')
  })

  it('ends after the last whole word that fits, with an ellipsis', () => {
    expect(fitWords('mas.gov status page for the public', room(20))).toBe('mas.gov status page…')
    expect(fitWords('mas.gov status page for the public', room(15))).toBe('mas.gov status…')
    expect(fitWords('mas.gov status page for the public', room(14))).toBe('mas.gov…')
  })

  it('ends a sentence after a whole word, and leaves the joints of a later word alone', () => {
    const headline = 'Helper error seen 819 times: node:Error:Module._resolveFilename(loader)'
    expect(fitWords(headline, room(40))).toBe('Helper error seen 819 times…')
    expect(fitWords(headline, room(20))).toBe('Helper error seen…')
    expect(fitWords('Edge event loop stalled 5 times', room(25))).toBe('Edge event loop stalled…')
  })

  it('cuts a hostname at a joint, never through a label', () => {
    expect(fitWords('api-internal.eu-west.mas.gov.example', room(26))).toBe('api-internal.eu-west.mas…')
    expect(fitWords('api-internal.eu-west.mas.gov.example', room(24))).toBe('api-internal.eu-west…')
    expect(fitWords('IntakeContainerLogFailure', room(16))).toBe('IntakeContainer…')
    expect(fitWords('watch.example.com', room(8))).toBe('watch…')
  })

  it('keeps the first piece when even it does not fit, and a lone unbreakable word whole', () => {
    expect(fitWords('mas.gov status page', room(2))).toBe('mas…')
    expect(fitWords('scraper', room(2))).toBe('scraper')
  })

  it('never ends in the middle of a word or a joint piece, whatever the room', () => {
    for (const text of ['chat.example.com failed its node-2 uptime check twice', 'api-internal.eu-west.mas.gov.example', 'IntakeContainerLogFailure retried']) {
      // every offset at which a piece ends: after a joint, or at the end of a word
      const ends = new Set<number>()
      let at = 0
      for (const w of text.split(' ')) {
        for (const seg of breakSegments(w)) ends.add((at += seg.length))
        at += 1
      }
      for (let max = 1; max <= text.length; max++) {
        const out = fitWords(text, room(max)).replace(/…$/, '')
        expect(text.startsWith(out)).toBe(true)
        expect(out).not.toMatch(/[./_:-]$/)
        // the cut is where a piece ends, or one joint character before it (the dot a cut drops)
        const cutAt = out.length
        expect(out === text || ends.has(cutAt) || (/[./_:-]/.test(text.charAt(cutAt)) && ends.has(cutAt + 1))).toBe(true)
      }
    }
  })
})
