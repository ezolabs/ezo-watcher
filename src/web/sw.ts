// Service worker: Web Push receiver and a small offline shell. The API is never cached.
const sw = self as unknown as ServiceWorkerGlobalScope

const SHELL = 'watch-shell-v1'
const SHELL_FILES = ['/', '/manifest.webmanifest', '/favicon.svg']

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => sw.skipWaiting()))
})

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  )
})

sw.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== sw.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ingest/')) return
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/').then((r) => r ?? Response.error())))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(SHELL).then(async (c) => {
        const hit = await c.match(req)
        if (hit) return hit
        const res = await fetch(req)
        if (res.ok) void c.put(req, res.clone())
        return res
      })
    )
  }
})

interface PushPayload {
  title: string
  body: string
  url?: string
  tag?: string
  severity?: string
  requireInteraction?: boolean
  ackUrl?: string
}

const FALLBACK_TITLE = 'EZO Watcher'

/**
 * The title of a push that names none (empty, or not JSON): this Watch's own name. The server writes it into the manifest it serves per instance
 * (src/server/instance.ts), and the shell cached that manifest at install; EZO Watcher when neither answers.
 */
async function brandTitle(): Promise<string> {
  try {
    const res = (await caches.match('/manifest.webmanifest')) ?? (await fetch('/manifest.webmanifest'))
    const name = ((await res.json()) as { name?: unknown }).name
    return typeof name === 'string' && name.trim() !== '' ? name : FALLBACK_TITLE
  } catch {
    return FALLBACK_TITLE
  }
}

sw.addEventListener('push', (event) => {
  let p: Partial<PushPayload> = { body: 'An alert changed.' }
  try {
    if (event.data) p = { ...p, ...(event.data.json() as PushPayload) }
  } catch {
    if (event.data) p.body = event.data.text()
  }
  const show = async (): Promise<void> => {
    const title = typeof p.title === 'string' && p.title !== '' ? p.title : await brandTitle()
    await sw.registration.showNotification(title, {
      body: p.body,
      tag: p.tag,
      requireInteraction: p.requireInteraction === true,
      data: { url: p.url ?? '/', ackUrl: p.ackUrl },
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png'
    })
  }
  event.waitUntil(show())
})

sw.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/'
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => {
      for (const c of all) {
        if ('focus' in c) {
          void c.navigate(url)
          return c.focus()
        }
      }
      return sw.clients.openWindow(url)
    })
  )
})
