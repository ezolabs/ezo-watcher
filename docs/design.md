# EZO Watcher design

What the product is for: one screen on which an operator sees what is on fire, how bad, and since when,
reaches the evidence in at most three interactions, and is paged once on a channel that works. The one
metric is seconds to identify the worst problem. Research and decisions below were retrieved on 2026-10-14.

## What was taken from where

| Layer | Taken | From |
| --- | --- | --- |
| 1 vocabulary | alert group, fingerprint, repeat interval, nflog, high-performance HMI, standing alarm | Alertmanager, ISA-101, EEMUA 191 |
| 2 data model | labels, annotations, startsAt, endsAt, generatorURL, fingerprint, status{state, silencedBy, inhibitedBy, mutedBy} | prometheus/alertmanager `api/v2/openapi.yaml` (Apache-2.0, pushed 2026-10-13) |
| 2 data model | status noData, maintenance, firing counters, duplicate reason | keephq/keep `AlertDto` (read only: licence is NOASSERTION, so no code taken) |
| 3 algorithm | squarified treemap, with an ordered, stable variant | Bruls, Huizing, van Wijk 2000; Sondag, Speckmann, Verbeek 2018 (DOI 10.1109/TVCG.2017.2745140) |
| 3 algorithm | reach scaling `1 + floor(log2(1 + n))` | Sentry issue ordering (log-scaled events times log-scaled users); here the reach term is the instance count, `reach` in `src/shared/incident.ts` |
| 3 algorithm | group_wait, group_interval, repeat_interval, `continue`, mute time intervals, nflog key `group:receiver` | prometheus/alertmanager `docs/configuration.md`, `nflog/nflog.go`, `notify/dedup_stage.go` |
| 3 algorithm | quiet-hours digest, flap notice, first-success ladder | designed for this project (see Notifications) |
| 4 code | none. Fork or adopt of karma, alerta, keep, Apprise was declined at this layer | see below |

### Adopt, fork or build

karma (prymitive/karma, Apache-2.0, pushed 2026-10-12, v0.133) is the only open artifact that already draws an
Alertmanager wall, and it is the 80% for a read-only Alertmanager dashboard. It is a poor base for this job: it
is stateless and Alertmanager-only (no chat source, no history, no notification log, no PWA), and the part
that matters here, how a tile is sized, would replace its whole UI. So its concepts were taken (group cards,
age pills, one-click history, read-only mode) and no code. If the job were only "an Alertmanager wall",
deploying karma unchanged would be the answer.

alerta needs MongoDB or Postgres and re-deduplicates alerts Alertmanager already deduplicated (alerta issue
1911). keep is a full AIOps platform with a NOASSERTION licence. grafana/oncall was archived on 2026-03-24.
Apprise is Python; running it means the Django apprise-api sidecar (about 200 MB), too much for a 192 MB box.
Its one-URL-per-target idea was taken; each channel here is a small function with an injected fetch.

## Look plan

- Palette: the EZO Watcher neutrals. Dark: canvas `#0D0D0D`, raised `#1A1A1C`, hairline `#1E1E21`, control border
  `#3A3B40`, text `#E6E8EE`, muted `#AEB1BC`. Light: canvas `#FAF8F3`, raised `#F0EDE5`, hairline `#E3DFD6`,
  text `#141310`, muted `#5F5B52`. Source: `src/web/styles/tokens.css`, the one stylesheet
  that holds a hex literal, with a source key on every line.
- Accent: none in chrome. The one high-emphasis control is a neutral inverse fill. Hue is a data channel for
  severity (page is the tokens' danger red, warning its warning amber; info, healthy and resolved are neutral) and, with
  one more value, for the parked state (`--color-parked`, a slate blue, see Parked): a state hue, not an accent and not a severity.
- Type: SF Pro Rounded, ui-rounded, Inter, system-ui for chrome; a tabular monospace for values, counts and
  durations. No font file ships.
- Radius: 8 px controls, 16 px tiles, sheets and cards. The pill radius only on the status cells, the host badge and the chips.
- The one bold thing: the wall. Tile area and colour weight scale with severity, reach and unattended age, so one
  page-level problem physically dominates the screen and healthy services recede to quiet tiles.

References opened first: Supabase observability "Service Health" (per-service tiles, quiet when healthy),
incident.io Home (one severity gets the fill, the rest are outlined), Customer.io "Workspace Performance"
(a healthy state that still lists what is being watched), shadcn `dashboard-01` (sidebar and data table shell,
restated without Radix). For the summarised cells (retrieved 2026-10-15): Datadog's Monitor
Summary widget (https://docs.datadoghq.com/dashboards/widgets/monitor_summary/): status counts for the monitors that match, with the statuses and
names of the monitors listed beside them. Taken: a count for the many that are fine beside the named few that are not. Not taken: a colour per status
(hue is the severity channel here).

## The wall

- **The tier rule: tile area follows severity** (`footprintOf`, `allotWall`, `src/shared/layout.ts`; the Supabase observability "Service Health" and Statuspage component grids: a dense grid of small cells, each with its status dots and a one-line summary, problems first and sized by severity). The wall is a grid of small cells
  (`--wall-cell-min-w` 128 by `--wall-cell-min-h` 74, 8 columns at 1440 x 900), and a tile's footprint in cells is set by its tier. A healthy service is one cell (`--wall-cell-*`), two or three wide only when it has more
  dots than one cell holds (`healthySpan`; Regression sweep with 16 dots is two wide). A warning, an acknowledged one and a silenced one are a block of `--wall-warning-cols` by `--wall-warning-rows` (2 by 2: about 282 x 156, a
  quarter of the 530 x 290 warning tile an earlier layout drew, where four warnings took 70% of the wall), four to a row at 1440. An unattended page is a block `--wall-page-share` (half) of the columns wide and `--wall-page-rows` (3) tall, top-left; an acknowledged one is
  `--wall-page-rows-attended` (2) tall. Tiles are placed in order into the first free space (a dense CSS grid): pages, unattended warnings by weight, acknowledged ones, silenced ones, the healthy services that need a look, the
  rest; so the problems lead and take the first rows, and the small cells pack around and below them. A row grows to `--wall-cell-max-h` (1.25 times the minimum) when the wall has room to spare and the wall
  grows (`wallHeight`, the page scrolls) when the cells need more rows than it has, never a cell shrinking past its minimum. A wall with nothing firing is the same cells alone. Proof, 1440 x 900, 1300 x 900 and 1024 x 768, for
  4 warnings, 1 page and 3 warnings, 1 warning and 10 warnings, each next to 35 healthy services: `test/wall-allotment.test.ts`. Measured on the live state (4 warnings, 38 healthy cells): the warnings hold 27% of the wall, no
  scrolling at 1440 x 900.
- **Healthy cells keep their dots and summary.** A cell is the service's name (one line, the full name on hover), then the proof-of-watch strip below: a dot for each rule that is not ok, worst first, then "All 70 ok" or "107 ok". A
  cell that needs a look keeps a stronger border and a heavier name, with no hue of its own. On a phone the cells are two to a row, a wide one takes the row.
- **Warning tiles are compact.** A warning shows its badge row, its title in three lines (two once it also says who has it; never fewer than two, `--wall-warning-title-lines`), the unattended age in one small line (the page's age
  is the large figure, the same words), and the receipt footer. The full title is the tile's accessible name, its hover text and the sheet. The page keeps the large tile: display title when it holds, the big age, the instances and Acknowledge.
  `src/shared/title-room.ts` only counts lines now (`wrapLines`, `titleHolds`, `titleShown`, `warningTitleLines`); a tile no longer grows to hold a title.
- **Tier is severity, not a factor.** Footprint is a function of the tier alone, so quantity and age cannot buy a warning past a page: reach and age order the tiles of a tier (the weight, `tileWeight`, still sorts them) and tint them
  (the age bands). Page > warning > healthy in area at every width (`test/wall-allotment.test.ts`).
- **Age counts only while unattended.** One pure function, `incidentState`, is read by the wall and by the
  notifier. An ack freezes the age band and halves the weight, so an ack is visible as a smaller tile. Band edges
  (10 minutes, 1 hour, 24 hours) are also the escalation edges.
- **Layout.** The grid above: columns as many as the width holds at the cell's minimum width, tiles packed first-fit in a fixed order (tier, unattended before acknowledged before silenced, the services that need a look, weight, id), so tiles move only on a real step. The squarified treemap (Bruls, Huizing, van Wijk 2000) is kept in `layout.ts` for the geometry tests and a caller that gives no tier rule.
- **Proof of watch.** A quiet tile is a service with a cell for every rule or check that is **not ok**, no hue, then one muted
  count for the rest. Solid is evaluating, half is pending, dashed is no data, error or stale, dotted is seen only in the alert
  history. The non-ok cells come worst first (firing, error, stale, no data, pending, history only; `splitCells` in
  `src/web/lib/cells.ts`), then "99 ok" in the tabular monospace beside one solid cell, or "All 15 ok" when every rule is ok (a lone
  rule reads "1 ok"). So 99 healthy rules cost one word and the 23 that need a look are the ones in sight; a service with 122 rules no
  longer paints 122 cells. A source that stops answering raises its own `source-stale` incident, dashes the cells it feeds, and
  replaces the "0 firing" claim: a warning for a polled kind, a page for a webhook that promised `staleAfterSec` (`staleSeverity`,
  page by default) and for a heartbeat whose run is late. An all clear has to be earned.
- **The strip never clips.** A tile is a fixed box, so `useFit` gives up what does not fit in a fixed order and never cuts through a
  line: the footer ("Oldest evaluation"), the meta line, then the strip's own count, then the strip's cells for the one line that counts
  them ("23 not ok"). The non-ok cells are never given up before the count, and a quiet tile never loses its strip whole, so it always
  says how many rules need a look. A tile under `--tile-two-line-h` gets the compact padding. A large tile lists the non-ok rules by
  name and state instead (a name wraps only at its joints), sheds those rows from the last ("+14 more"), and its "N ok" row first. The
  phone stack has no fixed height, so nothing is shed there. Measured on the live state at 1440 x 900, 1024 x 768, 390 x 844 and
  320 x 640 in both schemes, and on quiet walls of 4 to 10 services (so large, medium and small tiles): no element of any quiet
  tile leaves its box.
- **The legend.** One line under the status line, drawn with the cells themselves: "Solid: evaluating. Half: pending. Dashed: no
  data, error or stale. Dotted: an alert with this name fired in the last 30 days, but no rule reports on it now." (`CELL_LEGEND`;
  one line at 1440 px, wrapping between items below that; the swatch and its shape word never part). A firing cell is a full fill,
  which the legend does not name: firing cells sit on incident tiles, whose colour already says it.
- **Each cell in words, per source.** The service sheet lists every rule or check, the ones that need a look first, with its state in
  the words of its source and, when the source sent one, its reason after a colon (`cellLine`): "skipped: no credential (GRAFANA_AUTH)",
  "pending, read in part: 2 yellow, not an alert: node-4 disk / 89.3%". Pending reads differently for each source: a Grafana or vmalert
  rule is "pending, inside its for-window", a prober check "pending, waiting before declaring down", a sweep check "pending, read in
  part". A check that could not run is "skipped" (a rule with no data is "no data"), and a stale check says how long it may be silent
  ("not run in the last 10 h", from its `staleAfterSec`). The same words are each drawn cell's hover text and accessible name.
- **Netdata.** A poll of Netdata Cloud (outbound only) gives the `Netdata` tile one real cell per alert group, and its disk alerts join Grafana's host-disk incidents; see `src/server/sources/netdata-cloud.ts`.
- **Tile content by size.** Tiles show more as they grow. Every incident tile is the same four lines, told by its worst instance
  (the Story layout, below): a host badge and a breadcrumb, a plain-sentence headline, the rule class as a muted caption, and one line
  of proof. Then, as the tile grows, the count and age, the proof-of-watch cells, the unattended age, the notification receipt and
  an Acknowledge button.
- **Titles and captions never break a word.** A tile headline wraps only between words and, inside a hostname or a CamelCase name, only at
  its own joints (`src/web/lib/title.ts`); past its line limit it ends after a whole piece with an ellipsis. An incident split per
  instance (config `splitIncidents`) that has only an alertname to go on leads with its instance (`chat.example.com: probe down`); the
  full text is the aria-label, the sheet and History. The breadcrumb (system / service / component) is one line that sheds whole parts, the
  system first and the service last, and takes its own line when it does not fit beside the badge, so it is dropped only when the tile
  is too short for it. An incident tile that is acked, silenced or below page keeps at least `--wall-incident-min-w` (180 px) by
  `--wall-incident-min-h` (120 px) in the layout; a tile still shorter than `--tile-two-line-h` (96 px) keeps a one-line headline, tighter
  padding and no corner count. An unacked page keeps its own geometry. No part of a tile shrinks (`.tile > *` has `flex-shrink: 0`): when
  the box is short `useFit` sheds whole optional rows, in order the instance rows, the cells, the evidence line, the time since, the
  rule class and the breadcrumb, so a line is never squeezed to a sliver or cut.
- **Drill.** Tile, then a sheet that tells the story of the worst instance (below), then the instances of the incident, then one
  instance with its own story. A single-instance incident opens the instance directly. The page is self-sufficient: the command,
  its captured output, the firing values and the labels are all in the sheet, and its report and topic are one small text-link
  line at the bottom, never a button.
- **Phone.** Under the sm breakpoint the grid becomes one column: page tiles tall, warnings compact and full width, healthy cells two to a row (a cell with many dots takes the row).
## Wall groups

The wall files its alerting tiles under a few major categories, as
status pages do for their components (Atlassian Statuspage and Better Stack: a labelled group heading with a roll-up count above its components, problems first). Borrowed: the heading
with its count, and problems before the rest. Not borrowed: a card or a collapse around a group (a group is a heading and a run of tiles on the same grid, never a card in a card), and
a colour per group (hue stays the severity channel). The grouping is for the firing tiles only, because a category is worth a heading for what is firing and adds nothing to the
healthy cells, and it can be turned off, because the flat wall it replaced reads well too.

- **Defined once.** The config's `wallGroups`, an ordered list of `{ id, label, services }` (`test/fixtures/watch.config.json` carries a full one; `test/wall-groups.test.ts` holds a config to it). `src/server/config.ts` `checkWallGroups` validates it at load (`src/shared/wall-groups.ts` `wallGroupProblems`): a service in two groups, or twice in one, fails and names both
  places; so do an empty group, a bad or repeated id or label, and the reserved "Other". Names compare without case or separators ("Node disk", "node-disk"). A service no group lists
  is not an error: it falls into **Other**, last. A name no service has is caught against a roster (`known`): the config cannot know the services a Grafana rule's label names,
  so a test can hold a recorded roster (a service list read from `/api/state`) against the list, and a service on the live wall that lands in Other fails it. The state
  carries the list (`WallState.wallGroups`), so the wall and the server never keep two.
- **The groups** on one live wall: **Product** (API, API edge, router, desktop, helper, mobile, Edge, Router, Helper, desktop app, mobile app, Docs, prod/docs,
  prod/scraper (the deployment's docs site and scraper), Chat, Client link), **Reliability signals** (the five operations panels, Error clusters, Error breadth, New errors, Regression sweep), **Infrastructure** (Host disks,
  Node disk, Fleet load, Netdata, ClickHouse, Postgres, Backups, Metrics store, Metrics pipeline, Ingest, Gateway, Alert pipeline, Cloud computers, Watch sources, Watch self-test),
  **External and vendors** (Gateway, Vendors and billing, Uptime), then Other. They drive the incident sections and the breadcrumb below; the healthy cells do not use them.
- **The Group toggle.** A button "Group" in the wall toolbar beside By service and By host (the same segmented control; only By service has groups, so By host does not draw it), stored in
  `localStorage` `watch-grouped` (`src/web/lib/wall-prefs.ts`; on unless stored as `0`), **on by default**. The C key flips it (Enter, A, S, G and the view keys w, f, h, n, o, e are
  taken), and the footer hint says so. On: the incidents sit in sections (next). Off: the incident band is one flat band, exactly the wall as it was before there were groups (the healthy
  cells pack around the incidents), and each incident tile still names its group in its breadcrumb. By host is unchanged either way. The chat panel draws no toolbar, so it
  follows the stored choice (`Wall` reads it itself; the panel's frame and Watch are one site, so they share one `localStorage`, and a flip in a Watch tab reaches an open panel through
  the `storage` event); the toggle is not drawn in the frame, so Embed.tsx is untouched.
- **Incidents in sections, the healthy cells one grid.** With the toggle on and something firing, the incidents (pages, warnings, acknowledged, silenced) are split into one section per
  group that has an incident, each starting on a fresh row with a heading, its tiles sized by the tier rule above and unchanged (`layout.ts` `LayoutOptions.groups`, `TierRule.head`,
  `incidentGroupOrder`). The sections run worst first (a group with a page before one with only warnings, an unattended one before an acknowledged one before a silenced one; the config's
  order between groups alike in severity). The healthy cells follow as ONE flat grid on the first row below the last section, with no heading among them, in the order they have always had (the ones
  that need a look first, then by weight, then by name), each with its dots and summary. With nothing firing the wall is the ungrouped wall to the pixel
  (`test/wall-groups.test.ts`).
- **The heading is a row of the grid.** Full width, `--wall-group-head-h` tall (`--tile-step`, 40), placed by the layout like a tile: the group's name at the title size, its incident counts
  in the mono face at the code size ("Infrastructure  2 firing", "Product  1 firing, 1 acknowledged", "External and vendors  1 firing, 1 silenced"), a hairline under it. Only a group with an incident has one.
- **An incident names its group.** The group is the first part of the tile's breadcrumb (`.tile__crumb--group`): quiet, never shed (the other parts go first; a label wider than the row ends in an
  ellipsis), and a tile that names one never drops its breadcrumb to a row of its own. It is in the tile's accessible name too ("In Infrastructure."), with the toggle on or off.
- **Headings and keys.** With sections, each group's heading is an `h2` and a tile's title under it an `h3`, and the healthy cells sit under an `h2` only a screen reader meets
  ("Healthy services, 35"); with no sections (toggle off, nothing firing, By host) a tile's title is an `h2` as before. The DOM is in reading order (each section, then the cells), so Tab and a
  screen reader meet a heading before its tiles. Left and Right step through the tiles in that order and so cross a row end and a section; Up and Down go to the next row above or below. Enter, A, S and G are
  unchanged; G still flips By service and By host.
- **The narrow wall (a phone, the chat panel from 20 to 40rem wide).** One column pair. An unattended page is as tall as its rows, up to a cap that follows the visible height
  (`--stack-page-max-h` = `--stack-page-share` 0.28 of it, never under `--stack-page-floor` 160: 234 px at the 835 a panel shows on a 900 px window, 196 at 700, 168 at 600). Its title is at the
  title step (never the headline or display step) in three lines, the full text being the link's name, its hover title and the sheet; the age stays the bold figure. When the cap is under what the
  roomy page needs (`--stack-page-roomy-h` 212: a panel under about 760 px tall) the wall goes dense (`data-dense`): the age's figure and its word share a row, the padding and gaps tighten, the title
  holds two lines, a group's heading takes the height of its own line (25 px, not 40), and the healthy cells take their own height. Measured in the panel with the real Fleet strip above the
  wall (129 px of bar and strip) and two unattended pages in two groups, the first row of healthy cells is in the first screen at 600, 700 and 835 px tall, at 533 and at 320 px wide: pages 156 px
  (26%) at 600, 178 px (25%) at 700, 220 px (26%) at 835. From 40 to 48rem the grid applies (a page is three of four columns by three cell rows, about 35% of the panel).

## The Story layout

One model (`src/shared/story.ts`) derives everything a person reads from one alert, with a stated fallback for every field, so a tile and a
sheet never show an empty section or the same text twice. It reads four live shapes: a sweep finding, a Grafana alert, a router
Alertmanager v4 alert and a node-2 prober transition.

| Field | First present wins |
| --- | --- |
| headline (the tile title, the sheet title) | annotation `headline`, `summary`, the alertname read as words plus `on <host>` |
| what happened (1 to 3 sentences, never truncated) | `what_happened`, `description`, `summary` when a `headline` replaced it, a sentence saying the source sent none |
| host badge | `host` label or `instance` without its port (a label set such as `a=b, c=d` is not a host; a pod name reads as its workload), `env`, `namespace`, `cluster`, then the system that raised it |
| breadcrumb system / service / component | label `system` else the source (`Grafana`, `sweep`); label `service` else the wall group; label `component`, `job` or `layer`; each shown once |
| where (the human location line) | annotation `where`, else the labels written out ("API edge, host prod-node-2, namespace prod. Raised by prod.") |
| evidence command and output | `evidence` (also `probe`, `command`) and `evidence_output` (up to 4 KB, cut on a line end) |
| firing values and threshold | `__values__` or the alert's value string; an annotation `threshold`, else the comparison the rule's own text states ("at least 80%") |
| what to do | `action` (one step per line, numbered by the sheet), else the runbook link alone; with neither, no section |
| the tile's one line of proof | first line of `evidence_output`, else the summary (when it is not the headline), else the command, the description, the value. A description is Markdown (the regression rules write a bold lead and a short list): its line is the first sentence of its lead block as plain text (`descriptionLead`, `src/shared/markdown.ts`, the sheet's own parser), never the `**` marks or the list flattened after it |

The links keep the evidence-link model's classification and are sorted into the sheet: the Grafana panel, "Open in Grafana" and an evidence
URL are secondary controls inside Evidence; the runbook and any other URL are secondary controls inside What to do; the chat report
and topic (`report_url`, the older `triage`) become "Also in the chat panel", a text-link line at the bottom of the sheet.

The sheet, top to bottom: severity pill and source line, the headline, Acknowledge (the one neutral inverse fill) with Silence 1 h and
Silence 4 h, the error hero (the sheet now leads with the error itself: large, in the monospaced face, on the raised surface, hue on its hairline only), What happened (Markdown: one lead line, the rest behind a More fold), Where (a host, service and environment chip row, then the location line), Evidence (the command with Copy and its
output in one monospaced block that scrolls past 12 lines; the values and threshold of a Grafana alert; when it started and who saw it;
the source links), What to do, the instances when there are several, Labels (n) and Raw (n) as closed disclosures (labels, annotations
as sent and the fingerprint; the payload each source delivered), What your agent sees (a closed disclosure: the `get_fix_context` call,
the exact brief it returns in the monospaced face with Copy, and the CLI equivalent; `#/i/<key>/agent` opens it), History, Notifications, and last Also in the chat panel.

The host badge and the chips are the one dark pill in both schemes (`--badge-fill`, `--badge-ink`): neutral, because hue is the severity
channel. Fixtures for all four shapes are in `test/story.test.ts`, run through the pure story functions the sheet, the tile and the email share.

## Evidence links

One model feeds the sheet, the tile and the email, so a person sees the same link, with the same label, in all three.
It reads the alert's `generatorURL`, the adapter's links (panel, dashboard, explore, rule, silence), the annotations
`report_url`, `runbook_url`, `evidence_url` and `evidence` (a shell command, shown as a chip, never as a link), and the
older `triage` and `probe` that live sweep alerts can still carry. A label says what the link is ("Open in Grafana",
"Report in #triage", "Runbook"); the `probe` annotation is never confused with the `probe` label. A generatorURL that
is a chat message (a Zulip narrow link, from before the move to Chat) is a report, not a source, and an in-cluster generatorURL (no dot in its host) is dropped. Links
are deduplicated by URL and empty or non-http(s) ones dropped. Order is source, report, runbook, evidence, other. The email
keeps that order; the sheet sorts the same links by what they are (see The Story layout): the chat report is not a control there.

Borrowed for this: incident.io and Better Stack incident pages (the state and the actions sit in the header, beside
the title, not in a list under the body), Sentry's issue header (an icon on each control), Browserbase's run view (the command and its
output inline beside the step), Snowflake's service header (a small neutral badge and scope chips), and ezolabs.io (tight negative tracking on the title, the one-word outlined controls, the striped EZO mark).
ezolabs.io's blue and its pill buttons were not taken for the app: hue is the severity channel here, and controls are 8 px.

## Notifications

Routes are an ordered list (`continue` supported). Per route: `groupWaitSec`, `groupIntervalSec`,
`repeatIntervalSec`, escalation steps by unattended seconds, quiet-hours muting (pages ignore it), and a
`record` channel (Chat, `chat-alerts`, https://chat.example.com; Zulip until 2026-10-15) outside the ladder. The notification log is keyed `incident|route|receiver|stage` and
stores the last send time and a digest of the sorted firing fingerprints, so a send happens only when the set
changed after the group interval or the repeat interval elapsed (Alertmanager issue 2320 is the bug this
avoids). A failed send retries with exponential backoff. A ladder tries ntfy then web push with a 3 s timeout and
one retry each. Only a page reaches a phone, and a warning is posted to the chat panel #notifications and never to a phone: a warning is the
silent tier. A route may still hold its warnings overnight and send one digest, but no live route does. Three fire/resolve flips in 30 minutes send one
flapping notice and hold resolved notices until the incident is stable for 10 minutes (Alertmanager issues 1909
and 1546 were closed as not planned, so the smoothing lives here).

**Dev is never red.** A dev environment going offline is not an emergency, so a dev outage caps at warning. `severityCaps` in the config (`test/fixtures/watch.config.json` carries the set below) holds a class of
alert at a ceiling (`max`, warning or info), so a page from a dev environment is a warning everywhere it is read: the tile's tier and hue, the tab title's
and app badge's page count, the `GET /api/summary` counts, the route it matches and the pager. Each entry is a `match` (origin, rule and label values, RegExp sources not
anchored, as in `serviceMap`; at least one) and a one-line `note`; the lowest matching `max` holds. The engine applies it to each alert as it comes in
and again where a stored alert is read (`capSeverity`, `src/server/derive.ts`), before an incident's severity is taken as the worst of its alerts. So an
incident that also holds an alert no cap covers keeps that alert's page: ApiWedge on prod's web-2 beside dev's web-2-dev is a page, the pager speaks
for the prod alert alone, and its origin picks the route (before the cap the two pages tied, and a dev alert that sorted first sent the whole incident down the wall-only route). A cap
only lowers, and the capped alert says so in its `watch_capped` annotation ("Sent as page, shown as warning: <note>", like Netdata's `netdata_demoted`),
shown in the sheet's Labels fold under "Annotations as sent". A cap taken out of the config lets go on the next read. The caps in that set: origin `dev`;
a namespace ending `-dev` (as in `dev`, `web-dev` or `box-dev`); an `env` label naming dev; a router `backend` ending `-dev`; and the node-2 prober's dev and sandbox targets
(the sweep's `ProberTargetDown` and `ProberStateStale` by `service`, the prober's own `ProbeDown` by `instance`, a `dev` or `sandbox` part between
hyphens). "sandbox" is read only in a prober target's name, because a prod workload can carry it (agent-sandbox), and a `.dev` domain is never read as
dev (a production wall may serve a `.dev` domain). A capped dev or sweep alert still matches its wall-only route; any other capped alert takes the warning route, one post in
#notifications. History keeps the severity an episode was recorded with: dev episodes from before the cap stay red there.

The email is built from the same model and ranks instances the same way. Subject: severity, the worst instance's own
summary, "and N more hosts". Body: a severity band (the tokens' danger red for a page, warning amber for a warning),
the worst instance as the title, one status sentence, a worst-first table with each instance's value, report and
evidence, an "Open in EZO Watcher" table button, then source and runbook links. It is table markup with inline styles
(600 px, no images, no external CSS), declares `color-scheme` and `supported-color-schemes`, repaints for dark
clients, stays near 12 KB, and has a plain-text part with every URL in full. Its hex values are the tokens' light
values inline and the dark values in one `prefers-color-scheme` block; `test/notify-email.test.ts` fails on a hex
that is not in `tokens.css`. An incident that matches only a wall-only route (a route with no receivers) says so on its tile
("No notifications") and in its sheet ("Wall only, no notifications").

Instances are named the same way everywhere (`instanceLabels` in `src/shared/evidence-links.ts`): the host, the instance
label, the service label, the namespace and workload, the alert's own summary, and only last the alertname. A label that
two instances share, or that equals the incident's title, is skipped, so a sweep finding with no host is told apart by its
summary and no tile or row repeats the alertname it is titled with. In the email, a name that is only the summary leaves
the name column to the severity and the summary becomes the value.

A tile's footer is one line that keeps its height. Its copy fits the narrowest tile that shows a footer beside the
Acknowledge button, the receipt ellipsises as a last resort with its full text in the `title`,
and `useFit` in `Wall.tsx` sheds the optional rows above it whole (evidence links, instance rows from the last, rule
cells, summary) until the footer fits, so nothing is cut through a line.

Channels (each proven with one real send, see `skills/ezo-watcher/references/hosting.md`): ntfy, web push
(VAPID, RFC 8030/8291/8292), SMS (Telnyx), email (Resend), Chat (a record line through an incoming
webhook), generic webhook, and `file` (one JSON line per notification appended to a path under the project: no
credential, no network, no vendor, so a headless install is never left with zero channels). (A Zulip channel and a
Zulip alert-relay source existed until 2026-10-15.) The Quo
provider of the SMS channel exists in code but is not enabled: Quo's API answers `The organization is not approved
for A2P`.

## Re-check

A person who wants to know whether an alert has cleared does not wait for a poll interval: one control re-checks the whole wall, and one re-checks one
alert. Exemplars borrowed (retrieved 2026-10-15): GitHub Actions "Re-run job" and Grafana's alert rule "Test rule". Taken: the re-check sits next to the
status it re-checks and reports what it found, never a silent spinner. Not taken: a modal result, or a green "cleared" (hue is the severity channel).
For a sender that pushes (retrieved 2026-10-16): Devin's automation page, which writes the schedule in words beside "Trigger now" and confirms a manual run
at once ("will start shortly and appear in the history"); GitHub Actions "Re-run job" again, for a re-run that is a request which then reports its own result;
and healthchecks.io's "next ping expected", the time a periodic sender is due written on the check itself. Taken: the sender's schedule in plain words under the
control, and an immediate confirmation that says when the run will start. Not taken: Devin's modal toast (Watch answers inline, in the sheet, never in a modal).

- **Server.** `POST /api/recheck` re-polls every pull source (the sources main started: grafana, netdata-cloud, netdata-fleet, vmalert, sentry, http-probe and feed where configured) and
  answers `WallRecheck`; `POST /api/recheck/:alertKey` re-polls only the source that raised that alert (a source-stale warning asks the source it names)
  and answers `AlertRecheck` with the alert's fresh state. Both are same-origin and need nothing else, like the rest of `/api` ([mcp.md](mcp.md), Reach and auth).
- **One door.** The scheduled loop and a re-check poll through one `PollRunner` (`src/server/recheck.ts`): the source's `poll()`, `engine.ingest`,
  `engine.recordSource`. A re-check therefore resolves and keeps alerts exactly as a scheduled poll does, and the notifier sees the result on its own
  tick (a re-check only wakes that tick early, as a webhook ingest already does). A poll that fails changes no alert, from a click or a schedule. A failed click is
  told to the person and logged, and is not a missed poll, so a click can never raise the source-stale warning sooner than the scheduled polls would.
- **Limits.** One poll per source at a time (a click while one runs, scheduled or another click's, joins it) and one poll per source in any 10 s
  (`RECHECK_GAP_SEC`; the scheduled polls count, so clicks never hit a source faster than that). A click inside the gap polls nothing, is answered with the
  last poll's outcome, and says so: "Last polled 4 s ago. A source is polled again at most every 10 s."
- **Push senders cannot be polled** (a webhook, the regression sweep, the node-2 prober, the alert bridge). Their alerts get the sender and its schedule, and a sender
  whose source has `recheckRequests` is asked instead (the next bullet). The schedule is a standing sentence on the incident sheet, under the action row, for every
  firing alert whose sender pushes, whether or not anyone pressed Re-check: "sweep runs next at 16:07, in 1 h 35 min. If it stops sending this alert, it
  clears on its own at 11:09 tomorrow." The time is `nextReportAt` from the sender's last push (a time in the past reads "sweep was due to report at
  11:07 and has not yet."), without one "sweep last reported it at 11:09 and reports at least every 12 h." (`staleAfterSec`; the middle clause is dropped
  for a sender with no promise), and the clear time is `lastReportedAt` plus `presenceTtlSec` (else 6 h), "tomorrow" on the next day. The wall's all-sources Re-check
  asks no sender: it says the ones that push report on their own schedule, and names the ones an alert's Re-check can ask.
- **Asking a pushing sender.** Re-check on a firing alert of a source with `recheckRequests` leaves a request ([mcp.md](mcp.md), Re-check); the sender picks it up
  within `pickupWithinSec` and answers `ran`, `dispatched` (waiting on a CI run), `failed` or `unsupported`. The answer line under the control is where the request stands, in
  the sender's name: "Asked sweep to re-run this check at 14:32. It picks requests up within 90 s." (the immediate confirmation, with when), "sweep picked it
  up at 14:32 and is re-running it.", "sweep is waiting on <note>.", "sweep re-ran it at 14:33: still firing." or "...: cleared." (from the alert's state),
  "sweep could not re-run it: <note>.", "sweep cannot re-run this check on demand. It runs next at 16:07.", and "sweep did not pick the request up
  within 30 min." (one that was picked up and never answered says "picked it up at 14:32 and has not reported back"). Several alerts of one sender read as one sentence with a
  count ("re-ran 2 checks at 14:33: 1 cleared, 1 still firing."). The line moves with the sheet's own 5 s refresh (the sheet reads `alerts[].pushed`), so there is no timer of its own and
  a press only acknowledges, then waits for the settle seam like every other re-check. The standing sentence stays under the answer while a check runs and after it.
- **The words** (`src/web/lib/recheck.ts`; `scheduleText`, `requestText`, `whenAhead`, and `exactDurationText` in `lib/format.ts`, which reads a wait to the minute, "1 h 35 min", where
  `durationText` would round it to "2 h") are written from the facts, in the reader's clock: "Still firing, checked just now", "Cleared at 14:52",
  "Still clear, checked 8 s ago", "Firing again since 14:30", "Could not check, grafana did not answer: grafana returned HTTP 502.", and for the wall
  "3 sources checked, 1 alert cleared", "3 sources checked, none cleared, 4 still firing" or "3 sources checked, nothing firing". The wall's own line is
  "Checked 40 s ago": the age of the oldest answer of a polled source, the age an all clear is only as good as.
- **Where.** The wall header, beside the freshness line ("Re-check now"); the incident sheet's action row ("Re-check", which asks about the alert on the page or about every
  alert still firing, all through the same shared poll); and each alert row inside the sheet ("Re-check", its answer beside it). An alert this sheet saw clear
  stays in the list, marked cleared, until the sheet closes, so the answer is never a row that vanished.
- **Responsiveness.** A press paints the pressed fill and a turning glyph (`aria-busy`; the label does not change, so the control does not move) and queues the
  request behind the one settle seam (`src/web/lib/settle.ts`): it is released on the real end of every finite animation in the document (the sheet sliding
  in) plus one idle slot, skips the endless spinner, and falls back only to an animation's own remaining length plus a token margin. The answer arrives in a polite live
  region and the wall's own state refresh shows what the poll changed. Keyboard: the controls are plain buttons in the tab order with the global focus ring; a press during a check is
  ignored, never disabled, so focus is never dropped. Reduced motion: the spinner stops and the pressed fill and the word "Checking" remain.
- **Look.** No new hue, font or radius: the control is the ordinary 8 px `.btn`, the finding is full ink and the note muted, in the 12 px code size. New tokens:
  `--duration-spin` (4 x `--duration-300`) and `--turn-full`. The standing schedule sentence is a `.recheck__note` like any other (the one rule that hides an empty answer
  region now also keeps a region that has a note), so it adds no style, hue or number.

## Acknowledged

It has to be clear at a glance when a person has acknowledged an incident. An acknowledged tile used to keep the amber or red fill
of an unattended one, read "5 h until acknowledged" (a clock that looked still running), and its sheet said "Acknowledged by wall" (the actor was the screen,
because Watch has no login). Now:

- **The tile.** An acknowledged incident keeps its severity hue as the outline (the tier's own thickness: 4 px page, 2 px warning) on the raised surface instead of the fill, so
  the tiles still waiting for a person are the loud ones. Its glyph is a check-circle in the same hue, and one line under the headline says "Acknowledged by the user at 14:45"
  (`ackedLine`, `src/web/lib/ack.ts`; one line, an ellipsis last, the full text in its `title`). Severity still reads from the tile's tier, size and accessible name; the
  hue and the old dashed border are no longer what says "acknowledged". Silenced keeps its dotted border. No new hue, font or radius.
- **The order.** Inside a tier an acknowledged tile follows the unattended ones, whatever its weight (`LayoutItem.attended`, `src/shared/layout.ts`; the phone stack sorts the
  same way). A page still comes before an unattended warning: the tier decides first.
- **The big number counts what it says** (`heroOf`). Unattended: "9 h", "unattended", how long nobody has had it. Acknowledged: "25 min", "since acknowledged", how long ago
  someone took it; how long it has been firing stays in the caption ("since 09:30, 5 h"), which a large acknowledged tile now keeps. Silenced keeps "silenced".
- **The status line** counts the acknowledged beside the firing: "290 rules watched, 6 firing, 1 acknowledged." (`WallHeader.acknowledged`; left out at zero).
- **Who.** Watch has no login, so the first acknowledge from a browser asks once, in a modal ("Who is acknowledging?", a name field, "Save and acknowledge", "Skip, use this browser",
  "Cancel"; Escape cancels and acknowledges nothing). The name is kept in localStorage (`watch-name`; a skip is `watch-name-skipped`), changed on the Notifications page under This
  device ("Your name"), and sent as `by` with each acknowledge, silence and unacknowledge. A person who skips is stored as "this browser", never "wall", but no surface says it: a stored actor that names nobody
  ("this browser", the old "wall", "someone", empty) reads as no actor to everyone, the person who skipped included, on the tile, the sheet, History and the chat message
  ("Acknowledged at 16:47", "Silenced until 16:47", "acknowledged at `19:56 UTC`"; `shownName` is null, `byPhrase` is empty). A real name and "agent: <who>" read as stored. An acknowledge from a notification
  action reads "a notification action". The API takes `by` in the JSON body (at most 64 characters, control characters and runs of
  space folded) or the percent-encoded `x-watch-user` header, the body first, and keeps the existing paths (`POST /api/incidents/:key/ack`, `/unack`, `/silence`). The rules are
  `src/shared/who.ts`, the same on both ends.
- **Where the name shows.** The tile, the incident sheet (the chip "Acknowledged by the user at 14:45" with the check-circle, and its History timeline, "Acknowledged by the user"),
  History rows (the last ack of the episode, when it stayed acknowledged until it resolved: `HistoryRow.ackedBy`, `ackedAt`), and the Chat record's Resolved line ("Resolved after 5h,
  acknowledged by the user at 12:30 UTC", also the body of any other channel's resolved notice). Chat gets no line of its own at the moment of acknowledging: an acknowledged incident
  sends no updates, so the record names who had it when it clears.
- **Responsiveness.** The press only acknowledges itself (and, the first time, opens the prompt); the request waits behind the settle seam (`src/web/lib/act.ts`, `settle.ts`).

## Parked

A parked alert must not dirty the live issues, and none stays parked for a week: a park has a colour and a state of its own and lasts at most
`PARK_MAX_HOURS` (72 h). The regression sweep records a triage verdict for each finding, and a finding whose verdict is not due yet (`deferred:<date>`, or fixed and not deployed) used to sit on the wall as an amber or red unattended tile for days.
It is now its own attention state, `parked`, and never looks like a live problem. The sweep is not the only one who can state a park: an agent or a person can also park by hand, for
any source (By hand, below).

- **The contract** (the sweep pushes to `/ingest/sweep` with the same labels as before, so identity is unchanged, plus annotations): `parked_state` (`deferred` or
  `fixed_undeployed`; the annotation accepts only these two, `awaiting_source` is a state of a park by hand), `parked_until` (ISO 8601 with a zone, when the park ends), `parked_since`
  (ISO, when the sweep recorded the verdict), `parked_ref` (optional ticket id), `parked_note` (one short line). The annotations are never part of an alert's key or its incident's key (`makeAlert`, `incidentKeyOf` read labels only).
- **One derivation** (`incidentState`, `src/shared/incident.ts`). An incident is `parked` when every firing alert of it states a park and the park that ends first ends after now
  and no more than `PARK_MAX_HOURS` (72) after now, or when a park set by hand holds (By hand, below). Precedence: silenced, then acknowledged, then parked, then none. A park more than
  72 h out is not honoured (the incident shows unattended). Parked is the quiet tier at the quiet weight (R 1, like a silenced one), `firing: false`, no next escalation step. When the park ends, or a later push of the alert
  no longer carries the annotations (a push states the whole park: `mergedAnnotations`, `src/server/engine.ts`), the incident is back in its severity tier, unattended, and the
  unattended clock starts at `parked_until` (`IncidentState.unattendedSinceMs`), never at the first firing. Every consumer reads that state and none derives it again.
- **By hand.** The annotations only ever came from the sweep. An agent that fixed or triaged an incident from any other source (Grafana included) could only `resolve`, which reopens as a
  NEW paging firing while the source still holds the alert open. Now an agent (the MCP tools `park {key, state, until, by, note, ref?}` and `unpark {key, by, note?}`, [mcp.md](mcp.md)) or a
  person (`POST /api/incidents/:key/park` with `{by, state, until, note, ref?}` and `/unpark` with `{by, note?}`; `by` falls back to the `x-watch-user` header, then "this browser", like
  acknowledge and silence) parks a firing incident. `state` is `fixed_undeployed` (the fix is merged, not live yet), `awaiting_source` (the fix is live and the source's evaluation window has
  not caught up, so it still reports the alert) or `deferred` (a person chose a later date); `until` is ISO 8601 with a zone, after now and at most `PARK_MAX_HOURS` after it, and more is
  refused, not shortened (`checkPark`, `src/shared/agent.ts`); `note` is required (500 characters) and `ref` optional (64). The wall has no park button: agents and the API park. It is kept
  in table `parks` (`src/server/db.ts`: one row per incident, the same SQLite file as the acknowledgements and silences, so it survives a restart; the table is only ever added to: `alert_keys`, a nullable column, is added in place at start by `migrate`, which the release before still reads and writes, so deploy and rollback compatibility is unchanged), and a second park on the same incident replaces the first. `incidentState` reads it as `manualPark` (`governingPark`): while
  it holds it governs and outranks the annotations' park, and after it ends an annotation park that still holds can take over. Precedence is unchanged, so an acknowledge or a silence still
  wins over it: the park is recorded and shows once those come off. It covers the alerts that were firing when it was set (their keys are stored with it, `parks.alert_keys`) and no others, the sweep's rule "parked only when every firing alert states a park" read
  the same way. It ends when the episode resolves at the source; when an alert that is not one of them joins the incident (another host or instance, a rule that began after the park: the park's
  end is written as that moment, so the incident is back in its tier, unattended and paged as a new problem, with its clock from the join; a covered alert that resolves and fires again is the same
  key and keeps the park); when `until` passes (back in its severity tier, unattended, the clock and
  the pager's group wait and escalation counting from `until`, as for the sweep's); on `unpark`, which rewrites the park's end to that moment so the clock starts there and not at the first
  firing; or on a manual `resolve`, which removes it (if the source still reports the alert the reopen is a new firing with no park). A re-fire is a new episode with no park. History records `park` and `unpark` against the incident, with who, why and the ticket
  ("Parked by agent: claude until Oct 17, 04:00 UTC (fix live, awaiting source, SB-4412). Note: <why>", "Unparked by agent: claude. Note: <why>", and for a join "Park by agent: claude ended. A
  new alert joined the incident (DiskFull on node-5)"; "Note:" and the full stop follow the sheet's one-colon convention, see Comments and agent writes). The MCP server tells the park's end in UTC
  (the sentence is shared by every reader's zone); the sheet tells the same sentence in the viewer's zone ("until Oct 17, 04:00"), so the chip and the History row never give one end in two
  zones (`eventLine`'s `stamp` option, `src/shared/event-text.ts`).
- **Counts.** A parked incident is in no firing, unattended, acknowledged or severity count: not the wall's status line (`WallHeader.firing`), not `GET /api/summary`
  (`firing`, `unattended`, `bySeverity`, `worst`), not the tab badge, not the MCP counts. It has a count of its own (`WallHeader.parked`, `WatchSummary.parked`; the status line says
  "4 firing, 1 acknowledged, 2 parked").
- **The pager.** A parked incident is never sent, escalated, held for a digest or reopened with a note into the operator log (`planSends` reads only `attention: none`; the engine's own reopen note
  waits). When the park ends the pager counts it as a fresh episode (`NotifyView.freshSince`): group wait and every escalation step count from `parked_until` (the `until` of a park by hand), and a
  notification sent before the park does not hold the page back.
- **The tile.** Raised surface like an acknowledged one, one hairline outline in `--color-parked` (never amber or red), a pause in a circle (lucide `circle-pause`) in the same hue, and
  under the headline two lines in the acknowledged line's layout (`.tile__ack`): "Parked until Oct 17, 04:00" in the parked hue, then why and the ticket, "Fix not deployed, SB-4412",
  "Fix live, awaiting source, SB-4412" or "Deferred". A park by hand names who parked it on the first line, as an acknowledgement does: "Parked until Oct 17, 04:00 by agent: claude" (a stored
  actor that names nobody, "this browser", leaves "by" out). When the tile has room it also says "Parked since Oct 16, 09:00" and the sender's or parker's note; the whole park is in the
  tile's hover and accessible name. It reads differently from an acknowledged tile (thick severity outline, check) and a silenced one (dotted). The footer says "Notifications paused".
- **The section.** The parked incidents leave their category section for one headed "Parked" ("2 waiting"), after every group and before the healthy cells, soonest end first, under a
  hairline in the parked hue. With the Group toggle off, on the By host wall and on a phone the heading and its tiles still lead the parked ones (on the grid they are the last thing
  on the wall; on the phone's stack they come before the healthy cells). The id and the label are reserved: no configured wall group may use them.
- **The sheet.** A chip "Parked until Oct 17, 04:00" with the pause (a park by hand adds who: "Parked until Oct 17, 04:00 by agent: claude"), and a note: "Reason: fix not deployed. Ticket SB-4412.
  <the sender's line or the parker's note>. Parked since Oct 16, 09:00 by agent: claude. It is not paged while it is parked, and comes back unattended when the park ends." (the "by" is left out
  for a park the sweep states). Its History has the `park` and `unpark` rows. Acknowledge and Silence stay available (an acknowledge wins over a park).
- **Elsewhere.** MCP: [mcp.md](mcp.md) (`attention: parked`, `parkedUntil`, `parkedState`, `parkedBy`, the `parked` filter; `unattended` leaves it out; the `park` and `unpark` tools). The embed
  card: state `parked` with `parkedUntil` ([embed.md](embed.md)); unchanged by a park by hand.
- **Look plan.** One new token, `--color-parked`: dark `#7f9cc9` is 6.21:1 on `--color-raised` and 6.94:1 on `--color-bg`; light `#43669e` (the same hue, 216.5 degrees, darkened) is 4.94:1
  on the light raised and 5.45:1 on the light canvas, so its text clears 4.5:1 and its outline and glyph 3:1 in both. No new font, no new radius, no motion (the parked section uses the
  wall's own 250 ms transform and its existing reduced-motion rule), no glow, no nested card. The one bold thing stays the wall; a parked tile is the quietest incident on it.

## Comments and agent writes

Agents act on incidents through the MCP server ([mcp.md](mcp.md)), so the wall has to show who did what, in the same words for a person and an agent.

- **Look plan (no new hue, radius or font).** The neutrals of the plan above, no accent; a comment's author is the title weight, its time the muted mono the timeline already uses,
  its text full ink as written. The list is a hairline list like the rows (`.comments`, `.comment` in `wall.css`, tokens only, flush with the section headings), with no card, no
  avatar, no radius, no motion. The one bold thing stays the wall. No card in a card, no side-tab, no gradient or glow, no eyebrow, no middle-dot
  meta string, no "word, dash, fragment" label, no numbered marker, no emoji bullet, one radius family; every row has a title, a preview and a time, and no list renders empty.
- **Who.** An agent's name is "agent: <who>", written by the server and never changed by the UI, so it reads the same on the tile, in the sheet, in History and in the comments. The
  tile says it in two lines that each stay whole, the name and then the time ("Acknowledged by agent: claude, web-app" / "at 15:25", "Silenced by agent: claude" / "until 17:25"):
  the name wraps rather than ending in an ellipsis, the time is one piece (`.tile__ack-who`, `.tile__ack-when`). In the sheet it is one chip whose time never splits (`.chip__when`).
  A silence set on the previous episode of a re-fired incident says "carried over" on the tile and "set before this episode" in the sheet, and the sheet gives its reason on the line
  below the chip ("Reason: Planned failover rehearsal on node-13"), because a silence hides a problem from the pager. The button that takes it off reads "Remove silence", not "Remove acknowledgement".
- **Comments.** Between the labels and History, oldest first, each with author and time; the text is shown as written (line breaks kept) with http(s) addresses linked and nothing parsed into markup
  (`src/shared/link-parts.ts`). An incident with no comment has no Comments section: an empty list would need an action of its own, and adding a comment is the agents' job here.
- **History in the sheet.** Acknowledgements, silences (with the reason), parks and unparks (with the end, the state, the ticket and the note), manual resolves, reopens and confirmations read as one sentence each with who, as "<what> by <who>. Reason: <why>" or
  ". Note: <why>" (`src/shared/event-text.ts`, the same sentences the MCP server answers; two colons in one line read as a typo). They are written against the incident, so an alert's own page still
  lists them. A manual resolve is written against each alert and the incident; the list says it once. An incident that came back after a manual resolve says so in a chip ("Reopened after a
  manual resolve") and in its first history line.
- **History page.** A row carries who and nothing longer ("Marked resolved by agent: codex", "Resolution confirmed by agent: claude"); the free text is in the sheet. On a phone the time and
  the length drop under the sentence (`.row[data-stacked]`) instead of squeezing it to a third of the width.
- **Narrow walls stack.** The treemap cannot give every tile its minimum in a box under the phone breakpoint, and a tile squeezed to a badge hides what it is (found at 200% browser zoom, where a
  1440 px window is 720 px and its wall about 430). The wall stacks when the window is a phone's or the wall itself is narrower than `--bp-phone`; width only, so a stacked wall growing taller
  can never flip it back.
- **Not drawn.** A comment composer for people, a markdown renderer, and a hue for an agent write: hue is the severity channel here.

## Fleet view

Who runs hot or cold, at a glance: the Fleet page (`src/web/views/Fleet.tsx`) and a strip above the wall (`src/web/components/FleetStrip.tsx`), both reading `GET /api/fleet` (`src/server/sources/netdata-fleet.ts`). Sizes are in `tokens.css` under "the Fleet view"; the words, sort and sparkline geometry are `src/web/lib/fleet.ts`.

- **Look plan (no new hue, radius or font).** The neutrals of the plan above, no accent. Only a node whose heat is `hot` (the tokens' danger red) or `warm` (warning amber) takes colour: a tinted row or cell (`--overlay-data-wash`), a coloured sparkline and a coloured glyph on the chip; `ok`, `cold` and `unknown` stay neutral (cold is a muted chip, never blue). A disk has its own heat on the same two hues: under 80% used neutral, 80 to 89% warm (amber), 90% and up hot (red), and only the disk cell takes it (an outlined, tinted box and a thicker sparkline), never the row. Colour is never the only signal: the chip says Hot or Warm in words with its own glyph. Radius 16 on the table and the strip, 8 on the sort buttons, the strip's cells and the skeletons, the pill only on the status chip. No shadow, no animation. The one bold thing stays the wall; on the page it is the hot row.
- **The page.** A header line from the summary in plain words ("13 nodes, 2 hot: node-5 and node-13, 1 warm: node-6 at 74% CPU."), the fleet average and cold count under it, "Updated 20 s ago" and the wall's own Re-check now beside it. A table grouped Servers and Watch only: name with version and cores, CPU and memory (figure, then a 60 minute sparkline on one 0 to 100% scale, a hairline at the alert line), load5 with load per core, disk (below), status with the alerts firing, and a Netdata link per row (new tab, named for its node). A column header sorts (hottest or highest first, then reversed, then the API's order) inside each group; a node with no reading sinks last. A firing rule opens the incident sheet when the wall has that incident (`Fleet load` / `Host CPU hot (node-13)`), and is plain text otherwise.
- **Disk.** Every mount that matters, from the one data request (`/` always, any other real filesystem of at least 50 GiB; boot, snap, run, dev, sys, container runtime paths and tmpfs are never listed). The Disk column is the node's fullest mount: its used % to one decimal in tabular mono as the lead ("86.0%", the way Netdata's alert says it, so the figure and the 80 and 90 lines never disagree), a 60 minute sparkline on the same 0 to 100% scale with a hairline at 80%, the path in mono when it is not `/`, and "122 GiB free of 915 GiB" muted under it (free is what a user can still write, size counts what is reserved for root). Each other kept mount is one compact line under the row, right-aligned under CPU to disk: path, used %, free. A node with no disk columns says "no disk data"; a node with no fresh data shows "-" and its status says why. The header line names a warm or hot disk with its figure ("1 disk hot: node-13 91.3%, 3 disks warm: node-2 83.4%, node-4 86.0% and node-6 85.7%"), and Disk sorts by the fullest mount's figure. A warm or hot disk cell is outlined in its hue as well as tinted, so colour is never the only signal.
- **Honest about old data.** The whole feed `stale` (or a failed poll after a good one) says so in a sentence under the title with the age in words; a node with no fresh data says "no data for 4 min" (or "no data yet") in its status and keeps its last figures, quieter. `netdata-k8s-state` is a footnote, not a row: it is the Kubernetes state collector with no host metrics, and the table then matches the header's node count (`summary.nodes` excludes it).
- **States.** Loading is the real header and skeleton rows with the row's anatomy (the strip's skeleton keeps its height, so the wall does not move when it fills). A 503 or 404 is one sentence and one action (Open sources); a first read that failed is one sentence and Re-check now (the strip: Try again). Polling runs at the response's own `pollSec`, pauses while the tab is hidden and catches up when it shows; the last good view is kept for the page's life, so moving between the strip and the page paints at once.
- **The strip.** One flat band, three lines: a lead cell (Fleet and how many are hot or warm, then the labels CPU and Disk; it stays at the left edge while the band scrolls, so the labels never leave the figures) and one cell per host (name; CPU now with a tiny sparkline; the disk % of its fullest mount), the whole band one link to the Fleet page, one height (`--fleet-strip-h`, 72) whether it shows cells, skeletons or its sentence. The lead and 13 cells at 80 px fill a 1440 px window; a larger fleet, and a phone, scrolls sideways, and on a phone the hot and warm cells (CPU or disk) come first. A warm or hot disk is its own outlined, tinted figure in the third line; a hot or warm node still tints its whole cell. A host with no disk columns says "no disk".
- **Phone.** Under 60rem of the page's own width (a phone, or a 1024 px window) a row is name, CPU and memory with their sparklines, load, disk and the Netdata link on a second line, and the status on a third (left out for a quiet node). The phone's bottom bar scrolls sideways at 390 px as well as under 360 px, rather than cutting a label (`.nav` in `src/web/styles/wall.css`).
- **Responsiveness.** A press only acknowledges itself: a sort header marks itself sorted at once and the rows reorder behind the settle seam (`afterSettle`); the re-check is the wall's own control.
- **Not drawn.** A chart library, a per-metric detail page, thresholds editable in the UI, a disk alert from this view (the disk rules live in Grafana and Netdata's own alerts; the disk lines here are display only), a growth rate or time to full, and the k8s collector as a row.

## Look-plan conformance

Held by tests, not by review: a stylesheet a feature adds declares no hex literal and no number that is not a token (`test/sheet-detail.test.ts`,
`test/recheck-ui.test.ts`, `test/ack-ui.test.ts`, `test/embed-fleet.test.ts`), the email uses only the tokens' hex values and radii (`test/notify-email.test.ts`),
the parked hue clears its contrast floors and is never amber or red (`test/parked.test.ts`), and no copy holds an em dash (`test/ack-ui.test.ts`,
`test/parked.test.ts`, `test/recheck-ui.test.ts`, `test/notify-email.test.ts`).

## What was left out

Drag or resize layouts, per-user dashboards, on-call schedules, the 21-slot Nagios flap ring, grouping by
severity or source, a charts library, websockets (the client polls the state with an ETag every 5 s), ML
grouping, animation on healthy tiles. What would change the call: more than about 60 tiles (virtualise the
wall), a need for schedules and rotations (adopt a hosted on-call product for that one part), or a source with
no polling or webhook path.
