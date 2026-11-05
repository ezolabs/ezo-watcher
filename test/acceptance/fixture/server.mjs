// The acceptance fixture: a tiny app with two health routes, one of them worth watching.
//
//   GET /healthz  answers a constant. It is the decoy: a probe here proves the process is up, not that the app works.
//   GET /readyz   answers `{ "db": { "ok": <flag> } }`, 200 or 503, from the `db.ok` file beside this script. That flag is
//                 what the negative run flips, and the field the probe asserts.
//   POST /alerts  records what the Watcher's webhook channel sends, so a run can prove a page left the building.
//
// No dependencies, no build step: the project an agent installs the Watcher into should be this small.
import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FLAG = join(HERE, 'db.ok')
const ALERTS = join(HERE, 'alerts.log')

const dbOk = () => {
  try {
    return readFileSync(FLAG, 'utf8').trim() !== 'false'
  } catch {
    return true
  }
}

const answer = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/healthz') return answer(res, 200, { status: 'ok' })
  if (req.method === 'GET' && url.pathname === '/readyz') {
    const ok = dbOk()
    // The status and the field move together: a probe that only reads the status would still pass a broken app that always
    // answers 200, which is why the transcript asserts on `db.ok`.
    return answer(res, ok ? 200 : 503, { db: { ok } })
  }
  if (req.method === 'POST' && url.pathname === '/alerts') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      appendFileSync(ALERTS, `${body}\n`)
      answer(res, 200, { received: true })
    })
    return
  }
  answer(res, 404, { error: 'not found' })
})

const port = Number(process.env.PORT ?? 0)
server.listen(port, '127.0.0.1', () => {
  // The harness reads this line to learn the port the OS gave us; port 0 means the fixture never collides with anything.
  console.log(`FIXTURE_PORT=${server.address().port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
