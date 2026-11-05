// A session that lapsed behind WATCHER_ADMIN_TOKEN: an /api read answers 401 (src/server/app.ts), and the page sends the browser to the server's
// sign-in once, keeping the exact place (path, query and fragment: the fragment carries the open incident) for after the sign-in. The embed view
// is the exception: the frame in a chat panel has no login form to show, so it keeps its error state. Proved with a stub fetch and a stub location,
// since the page's own polls and JSON calls share the one `read`.

import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Page {
  pathname: string
  search: string
  hash: string
  assign: ReturnType<typeof vi.fn>
}

function page(pathname: string, search = '', hash = ''): Page {
  return { pathname, search, hash, assign: vi.fn() }
}

/** Fresh module state for each test: `sentToLogin` lives for one page load, and that is the lifetime under test. */
async function loadApi(): Promise<typeof import('../src/web/lib/api.ts')> {
  vi.resetModules()
  return import('../src/web/lib/api.ts')
}

function answer(status: number): void {
  // 304 is a null-body status: the Response constructor refuses a body for it.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(status === 304 ? null : '{}', { status })))
}

beforeEach(() => {
  vi.stubGlobal('location', page('/'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a 401 from an /api read goes to the login page with this exact place', () => {
  it('builds the login href with the path, the query and the fragment encoded into next', async () => {
    const { loginHref } = await loadApi()
    expect(loginHref(page('/i', '?theme=dark', '#/i/abc'))).toBe('/login?next=%2Fi%3Ftheme%3Ddark%23%2Fi%2Fabc')
  })

  it('sends api() to the login once and still throws the error the caller shows', async () => {
    const here = page('/wall', '?x=1', '#/i/abc')
    vi.stubGlobal('location', here)
    answer(401)
    const { api } = await loadApi()
    await expect(api('/api/state')).rejects.toThrow('401')
    expect(here.assign).toHaveBeenCalledTimes(1)
    expect(here.assign).toHaveBeenCalledWith('/login?next=%2Fwall%3Fx%3D1%23%2Fi%2Fabc')
  })

  it('asks only once per page load, however many polls fail before the navigation lands', async () => {
    const here = page('/', '', '#/')
    vi.stubGlobal('location', here)
    answer(401)
    const { api } = await loadApi()
    await expect(api('/api/state')).rejects.toThrow('401')
    await expect(api('/api/state')).rejects.toThrow('401')
    await expect(api('/api/incidents/x')).rejects.toThrow('401')
    expect(here.assign).toHaveBeenCalledTimes(1)
  })

  it('redirects from a fresh page load again (the once is per load, not per tab)', async () => {
    const here = page('/')
    vi.stubGlobal('location', here)
    answer(401)
    const first = await loadApi()
    await expect(first.api('/api/state')).rejects.toThrow('401')
    const second = await loadApi()
    await expect(second.api('/api/state')).rejects.toThrow('401')
    expect(here.assign).toHaveBeenCalledTimes(2)
  })
})

describe('the embed view keeps its error state instead of redirecting', () => {
  it('does not redirect the /embed page', async () => {
    const here = page('/embed', '', '#/i/abc')
    vi.stubGlobal('location', here)
    answer(401)
    const { api } = await loadApi()
    await expect(api('/api/state')).rejects.toThrow('401')
    expect(here.assign).not.toHaveBeenCalled()
  })

  it('does not redirect a page that asked for ?embed=1', async () => {
    const here = page('/', '?embed=1&theme=dark')
    vi.stubGlobal('location', here)
    answer(401)
    const { api } = await loadApi()
    await expect(api('/api/state')).rejects.toThrow('401')
    expect(here.assign).not.toHaveBeenCalled()
  })

  it('names the embed place for both forms and nothing else', async () => {
    const { inEmbed } = await loadApi()
    expect(inEmbed(page('/embed'))).toBe(true)
    expect(inEmbed(page('/embed/'))).toBe(true)
    expect(inEmbed(page('/', '?embed=1'))).toBe(true)
    expect(inEmbed(page('/'))).toBe(false)
    expect(inEmbed(page('/history', '?theme=dark'))).toBe(false)
  })
})

describe('no other status, and no page already on the login page, redirects', () => {
  it('leaves a 500, a 503 and a 304 alone', async () => {
    const here = page('/')
    vi.stubGlobal('location', here)
    answer(500)
    const { api } = await loadApi()
    await expect(api('/api/state')).rejects.toThrow('500')
    answer(503)
    await expect(api('/api/fleet')).rejects.toThrow('503')
    answer(304)
    await expect(api('/api/state')).rejects.toThrow('304')
    expect(here.assign).not.toHaveBeenCalled()
  })

  it('never redirects a page already on /login', async () => {
    const here = page('/login', '?next=%2F')
    vi.stubGlobal('location', here)
    answer(401)
    const { api } = await loadApi()
    await expect(api('/api/state')).rejects.toThrow('401')
    expect(here.assign).not.toHaveBeenCalled()
  })
})

describe('every read shares the one hand-off', () => {
  it('has a single fetch call in the module, inside read: the wall and fleet polls cannot bypass the 401 hand-off', () => {
    const src = readFileSync(new URL('../src/web/lib/api.ts', import.meta.url), 'utf8')
    expect(src.match(/await fetch\(/g)).toHaveLength(1)
    expect(src).toMatch(/async function read\(path: string, init\?: RequestInit\): Promise<Response> \{\n  const res = await fetch\(path, init\)\n  loginOn401\(res\.status\)/)
    expect(src.match(/await read\(/g)).toHaveLength(3) // api(), the wall's poll and the fleet's poll
  })
})
