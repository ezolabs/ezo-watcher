// The fixture's scheduled job. It does its work, then pings its heartbeat — the ping is the success path, which is where
// the skill says a heartbeat belongs. Run it by hand (`node job.mjs`) or from the crontab beside it.
const url = process.env.WATCHER_HEARTBEAT_URL
const token = process.env.WATCHER_HEARTBEAT_TOKEN
if (!url || !token) {
  console.error('WATCHER_HEARTBEAT_URL and WATCHER_HEARTBEAT_TOKEN must be set (the CLI prints the URL and names the variable)')
  process.exit(64)
}

const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
if (!res.ok) {
  console.error(`the heartbeat ping answered HTTP ${res.status}`)
  process.exit(1)
}
console.log('job ran; heartbeat pinged')
