// The Cloudflare API calls deploy.mjs and query.mjs share: auth from the environment, the D1 database found by name.
//
// Auth is CLOUDFLARE_ACCOUNT_ID plus either CLOUDFLARE_API_TOKEN (a token with D1 and Workers edit) or CLOUDFLARE_EMAIL +
// CLOUDFLARE_API_KEY (a global key). Nothing is read from a file and nothing is written.

export const DATABASE_NAME = 'ezo-watcher-telemetry'
const API = 'https://api.cloudflare.com/client/v4'

export function accountId() {
  const id = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!id) throw new Error('CLOUDFLARE_ACCOUNT_ID is not set')
  return id
}

function authHeaders() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_EMAIL: email, CLOUDFLARE_API_KEY: key } = process.env
  if (token) return { authorization: `Bearer ${token}` }
  if (email && key) return { 'x-auth-email': email, 'x-auth-key': key }
  throw new Error('set CLOUDFLARE_API_TOKEN, or CLOUDFLARE_EMAIL and CLOUDFLARE_API_KEY')
}

export async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) }
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || !body?.success) {
    const errors = body?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${res.status}`
    throw new Error(`${init.method ?? 'GET'} ${path}: ${errors}`)
  }
  return body.result
}

/** The database's id, or null when the account has none by that name. */
export async function findDatabase(name = DATABASE_NAME) {
  const list = await cf(`/accounts/${accountId()}/d1/database?name=${encodeURIComponent(name)}`)
  const db = (list ?? []).find((d) => d.name === name)
  return db ? db.uuid : null
}

export async function createDatabase(name = DATABASE_NAME) {
  const db = await cf(`/accounts/${accountId()}/d1/database`, { method: 'POST', body: JSON.stringify({ name }) })
  return db.uuid
}

/** Run SQL against the database; the rows of the last statement. */
export async function query(databaseId, sql, params = []) {
  const results = await cf(`/accounts/${accountId()}/d1/database/${databaseId}/query`, { method: 'POST', body: JSON.stringify({ sql, params }) })
  const last = results[results.length - 1]
  return last?.results ?? []
}
