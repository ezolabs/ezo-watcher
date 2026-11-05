# The embed view

`/embed` is the wall without the app around it, for a page that frames it: a chat app's side panel, a dashboard, an
ops screen. It is the same wall, the same drill sheets and the same acknowledge flow as the full app, so an incident
opens inside the frame and Acknowledge works there. The page is `src/web/views/Embed.tsx`, the protocol it speaks is
`src/web/lib/embed.ts`, and `src/web/styles/embed.css` adds only the bar, the Fleet strip's chevron and the Fleet
layer. The look plan is the app's own ([design.md](design.md)).

## What it shows

One bar, the Fleet strip (when the server backs the Fleet view) and the wall. The bar is the status line ("4 firing,
1 acknowledged, 1 parked. 290 rules watched.", or the stale sentence when a source stopped answering). Opened on
its own, the bar also has one link, "Open full Watch", which opens the full app at the same place. A page that
frames it gets no such link from the frame: the panel's own header carries the one "Open Watch", and the frame
tells it where it is (`ezo-watcher:route`, below), so an incident open in the frame opens in the app.

The wall is the app's `Wall`, grouped by service, drawn without a sidebar, a view switch, a legend or a scheme
switch. A tile, its Acknowledge, its Silence and its drill sheet (incident, instance, host, service) work exactly as
they do in the app. A sheet in the frame has no Close of its own, because the panel around it already has one, so its
exit reads "Back to wall". With no source reporting, the empty state's one action is "Check again" when framed and
"Open full Watch" (Sources) on its own; with the server unreachable it is "Try again". Loading is the wall's
skeleton.

## Configure the origins

A page may frame `/embed` and read its cross-origin endpoints only if it is named in the config. `embedOrigins` is
the field that decides it; `baseUrl` is the public URL the frame's links use. The rest of the file is the sources,
routes and channels that `config/watch.example.json` shows:

```json
{
  "baseUrl": "https://watch.example.com",
  "embedOrigins": ["https://chat.example.com"]
}
```

`embedOrigins` is a list of exact origins: scheme and host only, no path, no wildcard. An entry that is not an
origin is refused at load, naming the entry. The environment variable `WATCHER_EMBED_ORIGINS` (comma separated)
adds more, for a local proof; the two lists are merged. Absent, the list is empty: no other page may frame the view
or read it cross-origin (the Watcher itself still may).

The list widens exactly two things:

- The content security policy's `frame-ancestors 'self' <origins>`. `'self'` always stays: a Watcher may frame its
  own page.
- The CORS allowlist of `GET /api/summary` and `GET /api/incident-card/:ref`: `Access-Control-Allow-Origin` is the
  caller's origin when it is on the list, with `Vary: Origin`, `Cache-Control: no-store` and no credentials, on a
  `404` too. Any other origin is served the body with no allow header, so its scripts cannot read it.

Both endpoints return counts or one small card, never the wall. A page that is not on the list can still link to
`/embed`; it just cannot frame it.

A Watcher with `WATCHER_ADMIN_TOKEN` set gates `/embed` and both endpoints behind the sign-in cookie, like every other
page: a page on another site sends no such cookie, so a token-protected Watcher needs its framing page on the same
site (or no token at all). There is no separate embed token.

A session that lapses while the frame is open is not sent to the login page: the `/api` reads answer `401` and the frame
keeps its error state ("Connection lost" over the last wall, or "Watch cannot reach its server" on a first load), because a
framed page has no login form to show. The Watcher's own page, opened from the panel on the same site and with the same
cookie, is where a person signs in again; the frame's next poll then carries the restored session and the error clears.

## Routes

| URL | Shows |
| --- | --- |
| `/embed` | the wall |
| `/embed#/i/<incident>` | the wall with that incident's sheet open |
| `/embed#/i/<incident>/a/<alert>` | the same, with one instance of the incident open |
| `/embed#/h/<host>` | the wall with a host sheet open |
| `/embed#/s/<service>` | the wall with a service sheet open |
| `/embed#/fleet` | the Fleet view over the wall (below) |
| `/a/<origin>:<fp8>?embed=1` | a redirect to `/embed#/i/<incident>` for the alert's own link; `&theme=dark\|light` is carried over |

`?theme=dark|light` sets the scheme before first paint (`public/theme.js`), so the frame never flashes the other
one. A message from the parent changes it later; with neither it follows the system.

## The frame protocol

The frame posts to the page that framed it, and only then (`window.parent !== window`). It posts to that page's
exact origin: `location.ancestorOrigins[0]` where the browser exposes it, and where it does not, the origin of
`document.referrer` in `src/web/lib/embed.ts` (the framing page, which `frame-ancestors` already let through). It
never posts to `*`, and a page that names neither origin gets no message rather than one sent to a guess.

| Message | When |
| --- | --- |
| `{ type: 'ezo-watcher:status', v: 1, firing, unattended, acknowledged, parked, worst, bySeverity, unattendedBySeverity, stale }` | when the wall changes, and as a heartbeat every 15 seconds |
| `{ type: 'ezo-watcher:route', hash }` | when the place changes: `''`, `#/`, `#/i/<incident>`, `#/h/<host>`, `#/s/<service>`, `#/fleet`. A sheet open over the Fleet view goes out as its own `#/i/...` form, so the panel's one link can open the same place in the app |
| `{ type: 'ezo-watcher:escape' }` | Escape on the wall with no sheet open, because a key pressed in the frame never reaches the page that framed it. In the Fleet view Escape goes back to the wall and sends nothing, so it never closes the panel |
| `{ type: 'ezo-watcher:reference', key, url, title }` | a person presses "Reference in chat" on an incident (below). `url` is the incident's own link on this origin, `title` its headline |

The frame accepts one message, and `theme` is `dark` or `light`:

```json
{ "type": "watcher:theme", "theme": "dark" }
```

It accepts it only from `window.parent` and only from one of the origins above. Any other message, sender or theme
value is ignored. The query's scheme is the first paint; a `watcher:theme` message then wins, and with neither the
frame follows the system.

## The status object

`ezo-watcher:status` carries the same object as `GET /api/summary`, built by `summaryOf` in
`src/shared/summary.ts`: counts and one severity word, no incident text, no host, no label.

```json
{ "v": 1, "firing": 5, "unattended": 4, "acknowledged": 1, "parked": 2, "worst": "page",
  "bySeverity": { "page": 1, "warning": 4, "info": 0 },
  "unattendedBySeverity": { "page": 1, "warning": 3, "info": 0 },
  "stale": false }
```

| Field | Meaning |
| --- | --- |
| `v` | the shape's version, always `1`; the per-severity and `parked` fields were added without bumping it |
| `firing` | incidents firing now, acknowledged and silenced ones included, parked ones left out |
| `unattended` | firing incidents nobody has acknowledged or silenced |
| `acknowledged` | firing incidents someone has acknowledged |
| `parked` | incidents parked (an open triage verdict that is not due yet, [design.md](design.md) Parked): in none of the other counts, and never paged |
| `worst` | the worst severity among the firing incidents: `page`, `warning`, `info`, or `none` when nothing fires |
| `bySeverity` | `{ page, warning, info }`: the firing incidents of each severity, acknowledged and silenced included, so the three add up to `firing` |
| `unattendedBySeverity` | `{ page, warning, info }`: of those, the unattended ones of each severity, so the three add up to `unattended`; `bySeverity` minus this is what is acknowledged or silenced |
| `stale` | a source stopped answering, so "nothing firing" cannot be trusted as an all clear |

All three keys of each per-severity object are always present, each a whole number of 0 or more. `parked` and the
per-severity objects are additive: a reader that predates them ignores them, and a reader of them must treat their
absence (an older Watcher does not send them) as "not reported" rather than as zeros. Severity words are the
Watcher's own: a sender's `critical` is read as `page` and `warn` as `warning` before anything is counted.

## The incident card

`GET /api/incident-card/:ref` is the small object a panel draws under a message that links to an incident. `:ref` is
an incident key or an alert id (`<origin>:<fp8>`, the id of an alert post's link). It answers, and only this
(`src/shared/card.ts`):

```json
{ "v": 1, "key": "api|APIProbeDown", "title": "API probe down on node-2", "severity": "page",
  "state": "firing", "service": "api", "since": "2026-10-15T23:34:50.050Z",
  "url": "https://watch.example.com/#/i/api%7CAPIProbeDown" }
```

| Field | Meaning |
| --- | --- |
| `v` | the shape's version, always `1` |
| `key` | the incident key |
| `title` | the headline the wall's tile shows, cut at 200 characters |
| `severity` | `page`, `warning` or `info` |
| `state` | `firing`, `acknowledged`, `silenced`, `parked` or `resolved` (an incident that has cleared is still a card, as long as the Watcher holds a record of it) |
| `service` | the service the incident is filed under |
| `since` | ISO time the incident began |
| `ackedBy` | present only for an acknowledgement that names someone |
| `parkedUntil` | present only for `parked`: an ISO time, when the park ends. It says when, never why |
| `url` | the incident's own link on the wall, `<baseUrl>/#/i/<encoded key>` |

No label, annotation, description, host, value, source link or raw payload is in it. An unknown ref is a `404`
`{ "error": "not found" }`, with the CORS headers so the page can tell. CORS is exactly `/api/summary`'s, above.

## Referencing an incident

An incident goes from the wall into a message in one gesture or one press. Both exist only in the frame; opened on
its own, the wall has nowhere to send a reference and draws neither.

| Way | What it does |
| --- | --- |
| Drag | an incident tile, or the sheet's title, is a drag source. `dragstart` clears the data and sets `text/uri-list` (the incident's link) and `text/plain` (`<title> <link>`), the two types a cross-document drop always carries. The tile dims while it is dragged |
| Press | a button labelled "Reference in chat" (on a narrow tile footer the visible text is "Reference", the accessible name always the whole phrase). It posts `ezo-watcher:reference` to the parent's exact origin and says "Sent" for the acknowledgement time |

The page that receives a reference adds `url` to its composer on its own line and focuses it; a panel that draws
cards under sent messages can then read `/api/incident-card/:ref` for the same link. The frame does no more than
hand over the link.

## The Fleet strip and view

When the server backs the Fleet view (it has a `netdata-fleet` source), the strip sits under the status line: one
row, the lead cell (the label "Fleet" with a chevron, how many hosts are hot, and the row names CPU and Disk) held at
the left edge while the band scrolls, then one cell per host with its CPU now, a tiny 60 minute sparkline and the
fullest disk's used percentage. It reads `GET /api/fleet` at its own `pollSec`; no endpoint is added for it.

In the frame the hottest host comes first at any width (a hot CPU, memory or load, then a hot disk, then a warm node,
then a warm disk, the API's order inside a tier and for every quiet host), because the band scrolls sideways there
and the one that matters must never be off screen. The full app keeps the API's order. No fleet metrics, or no servers, shows one sentence and one action that works
in a frame ("Check again" framed, "Open full Watch" on a bare embed page).

`#/fleet` opens the Fleet view in the frame: a layer over the whole frame with one way back fixed above the table,
"Back to wall" (a link to `#/`, so Enter, a tap and a click all work). The wall stays mounted under it and is
`inert` (out of the tab order and the accessibility tree), so Back, and Escape, land on the same scroll position
with nothing saved or restored. Escape steps back to the wall; a second Escape on the wall asks the panel to close.
Focus moves into the layer's Back link when the view opens and home to the strip when it closes, never on first
paint. `/embed#/fleet` opens the frame on the view, and the browser's own Back works too, since each step is a hash
change.

## A minimal host page

This page frames a Watcher, shows its firing count, keeps one "Open Watch" link on the frame's place, accepts a
reference and closes on Escape. The origin in `WATCH` must be one of the Watcher's `embedOrigins`.

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Ops panel</title></head>
  <body>
    <section id="panel">
      <header>
        <a id="open-watch" href="https://watch.example.com/">Open Watch</a>
        <span id="count"></span>
        <button id="close" type="button">Close</button>
      </header>
      <iframe id="watch" src="https://watch.example.com/embed?theme=dark"
              title="EZO Watcher" style="width: 100%; height: 80vh; border: 0"></iframe>
    </section>
    <textarea id="composer" rows="2" aria-label="Message" placeholder="Message"></textarea>
    <script>
      const WATCH = 'https://watch.example.com'
      const frame = document.querySelector('#watch')
      const origin = new URL(WATCH).origin

      addEventListener('message', (event) => {
        if (event.origin !== origin || event.source !== frame.contentWindow) return
        const message = event.data
        if (message?.type === 'ezo-watcher:status') {
          document.querySelector('#count').textContent =
            message.firing === 0 ? 'Nothing firing' : message.firing + ' firing, worst ' + message.worst
        }
        if (message?.type === 'ezo-watcher:route') {
          document.querySelector('#open-watch').href = origin + '/' + message.hash
        }
        if (message?.type === 'ezo-watcher:escape') {
          document.querySelector('#panel').hidden = true
        }
        if (message?.type === 'ezo-watcher:reference') {
          const composer = document.querySelector('#composer')
          composer.value = composer.value === '' ? message.url : composer.value + '\n' + message.url
          composer.focus()
        }
      })

      document.querySelector('#close').addEventListener('click', () => {
        document.querySelector('#panel').hidden = true
      })

      frame.addEventListener('load', () => {
        frame.contentWindow.postMessage({ type: 'watcher:theme', theme: 'dark' }, origin)
      })
    </script>
  </body>
</html>
```

## The closed-panel status

A panel that shows a status pill while the frame is closed can read `GET /api/summary` instead of running the
whole wall in a hidden frame. It is the same object as `ezo-watcher:status`, with the same CORS allowlist, and costs
one small read. It carries counts only, so a page on the list learns how much is firing and nothing about what.

## Security

- `frame-ancestors` is the real gate: a page not on `embedOrigins` cannot frame the view at all. The parent-origin
  check on messages is the second gate, so another page cannot talk to a frame it does not own.
- The frame sends data only, to one exact origin. It reads no parent DOM, sets no cookie and asks for no
  credentials, and the two cross-origin reads (`/api/summary`, `/api/incident-card/:ref`) are the only endpoints
  that answer CORS at all.
- `Referrer-Policy: no-referrer` is on every response; the frame's own content security policy allows scripts from
  its origin only.
