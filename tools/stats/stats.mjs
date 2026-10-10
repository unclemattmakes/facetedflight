// tools/stats/stats.mjs: `pnpm stats`, the gameplay statistics read back as
// totals. DEV-594; docs/stats.md, docs/plan/ANALYTICS.md section 5.
//
//   CF_ACCOUNT_ID=<id> CF_STATS_TOKEN=<token> pnpm stats [--days 7] [--preview]
//
// The token is an account API token with "Account Analytics: Read" and nothing
// else; neither value is ever written to the repository. Prints each table and
// writes one self-contained HTML report to docs/private/stats/ (gitignored).
//
// THE SMALL-CELL RULE (ANALYTICS.md section 1, and /privacy's promise): no
// total under STATS_SMALLEST rows is shown, anywhere. Groups are summed by the
// SQL and filtered here before printing, so a table says how many groups it
// hid rather than showing them. The one exception is a bug report, which a
// player SENT to be read (DEV-622); /privacy says so.
//
// Columns are named from the schema itself (src/net/stats-schema.ts, imported
// as TypeScript by Node), so a reordered field list cannot silently misname a
// column here: blob1 is the kind, blob2 the schema version, then each kind's
// text fields in order; its numbers from double1.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { columnOf, reach } from './columns.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const schema = await import(pathToFileURL(path.join(ROOT, 'src/net/stats-schema.ts')).href)
const { STATS_KINDS } = schema

const STATS_SMALLEST = 10

const args = process.argv.slice(2)
const days = Number(args[args.indexOf('--days') + 1]) || 7
const dataset = args.includes('--preview') ? 'ff10yr_stats_preview' : 'ff10yr_stats'
const account = process.env.CF_ACCOUNT_ID
const token = process.env.CF_STATS_TOKEN
if (!account || !token) {
  console.error(
    'pnpm stats needs CF_ACCOUNT_ID and CF_STATS_TOKEN in the environment.\n' +
      'Make the token at dash.cloudflare.com, My Profile, API Tokens: a custom token with\n' +
      '"Account Analytics: Read" on this account and nothing else. Never commit either value.',
  )
  process.exit(2)
}

const col = (kind, name) => columnOf(schema, kind, name)
const enumOf = (kind, name) => STATS_KINDS[kind].find((f) => f.name === name).values

const sql = async (query) => {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: query },
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`stats: ${res.status} ${text.slice(0, 300)}`)
  return JSON.parse(text).data ?? []
}

const since = `timestamp > NOW() - INTERVAL '${days}' DAY`
const W = 'SUM(_sample_interval)'

/** Keep the groups at or over the rule; say how many were hidden. */
const shown = (rows, key = 'n') => {
  const keep = rows.filter((r) => Number(r[key]) >= STATS_SMALLEST)
  return { rows: keep, hidden: rows.length - keep.length }
}

const tables = []
const table = (title, columns, { rows, hidden }, note = '') => {
  tables.push({ title, columns, rows, hidden, note })
  console.log(`\n${title}${note ? ` (${note})` : ''}`)
  if (rows.length === 0) console.log('  (nothing at or over the small-cell rule)')
  for (const r of rows) console.log(`  ${columns.map((c) => String(r[c])).join('  |  ')}`)
  if (hidden > 0) console.log(`  ${hidden} group(s) under ${STATS_SMALLEST} hidden`)
}

// ── Q1: does it load ───────────────────────────────────────────────────────
const stage = col('visit', 'stage')
const stageBefore = col('visit', 'stageBefore')
const xr = col('visit', 'xr')
const xrBefore = col('visit', 'xrBefore')
const visitGroups = await sql(
  `SELECT ${stage} AS stage, ${stageBefore} AS before, ${xr} AS xr, ${xrBefore} AS xrBefore, ${W} AS n
   FROM ${dataset} WHERE blob1 = 'visit' AND ${since} GROUP BY stage, before, xr, xrBefore`,
)
const visits = visitGroups
  .filter((g) => Number(g.before) === 0)
  .reduce((s, g) => s + Number(g.n), 0)
table('Visits', ['n'], shown([{ n: visits }]))
table(
  'How far visits got',
  ['step', 'n'],
  shown(reach(visitGroups, enumOf('visit', 'stage'), 'stage', 'before')),
)
table(
  'VR: how far it got',
  ['step', 'n'],
  shown(reach(visitGroups, enumOf('visit', 'xr'), 'xr', 'xrBefore')),
)

const firstRows = (field, label = field) =>
  sql(
    `SELECT ${col('visit', field)} AS ${label}, ${W} AS n FROM ${dataset}
     WHERE blob1 = 'visit' AND ${stageBefore} = 0 AND ${since} GROUP BY ${label} ORDER BY n DESC`,
  )
table('Boot gate', ['gate', 'n'], shown(await firstRows('gate')))
table('Seconds to the title', ['toTitle', 'n'], shown(await firstRows('toTitle')))
table('Device', ['device', 'n'], shown(await firstRows('device')))
table('Why VR was unavailable', ['xrBlocker', 'n'], shown(await firstRows('xrBlocker')))
table('Country', ['country', 'n'], shown(await firstRows('country')))

// ── Q2: what real hardware does ────────────────────────────────────────────
const byDevice = (field) =>
  sql(
    `SELECT ${col('visit', 'device')} AS device, ${col('visit', field)} AS ${field}, ${W} AS n
     FROM ${dataset} WHERE blob1 = 'visit' AND ${col('visit', field)} != 'none' AND ${since}
     GROUP BY device, ${field} ORDER BY device, n DESC`,
  )
table(
  'Typical frame (p50) by device',
  ['device', 'frameP50', 'n'],
  shown(await byDevice('frameP50')),
)
table('Slow frames (p95) by device', ['device', 'frameP95', 'n'], shown(await byDevice('frameP95')))
table('Quality in force by device', ['device', 'quality', 'n'], shown(await byDevice('quality')))
table(
  'Failures',
  ['contextLosses', 'shaderFailures', 'errors', 'n'],
  shown(
    await sql(
      `SELECT SUM(${col('visit', 'contextLosses')} * _sample_interval) AS contextLosses,
              SUM(${col('visit', 'shaderFailures')} * _sample_interval) AS shaderFailures,
              SUM(${col('visit', 'errors')} * _sample_interval) AS errors, ${W} AS n
       FROM ${dataset} WHERE blob1 = 'visit' AND ${since}`,
    ),
  ),
  'n is rows',
)

// ── Q4: courses ────────────────────────────────────────────────────────────
const mission = col('attempt', 'mission')
table(
  'Goes by course and how they ended',
  ['mission', 'ending', 'n'],
  shown(
    await sql(
      `SELECT ${mission} AS mission, ${col('attempt', 'ending')} AS ending, ${W} AS n
       FROM ${dataset} WHERE blob1 = 'attempt' AND ${since}
       GROUP BY mission, ending ORDER BY mission, n DESC`,
    ),
  ),
)
table(
  'Where quits happen: the last ring reached',
  ['mission', 'lastRing', 'n'],
  shown(
    await sql(
      `SELECT ${mission} AS mission, ${col('attempt', 'lastRing')} AS lastRing, ${W} AS n
       FROM ${dataset} WHERE blob1 = 'attempt' AND ${col('attempt', 'ending')} = 'quit' AND ${since}
       GROUP BY mission, lastRing ORDER BY mission, lastRing`,
    ),
  ),
)
table(
  'Medals on a first go',
  ['mission', 'medal', 'n'],
  shown(
    await sql(
      `SELECT ${mission} AS mission, ${col('attempt', 'medal')} AS medal, ${W} AS n
       FROM ${dataset} WHERE blob1 = 'attempt' AND ${col('attempt', 'ending')} = 'finished'
         AND ${col('attempt', 'attemptNo')} = '1' AND ${since}
       GROUP BY mission, medal ORDER BY mission, n DESC`,
    ),
  ),
)

// ── Q5: where people crash ─────────────────────────────────────────────────
table(
  'Crash squares, busiest first',
  ['mission', 'cause', 'cell', 'altitude', 'n'],
  shown(
    await sql(
      `SELECT ${col('crash', 'mission')} AS mission, ${col('crash', 'cause')} AS cause,
              ${col('crash', 'cell')} AS cell, ${col('crash', 'altitude')} AS altitude, ${W} AS n
       FROM ${dataset} WHERE blob1 = 'crash' AND ${since}
       GROUP BY mission, cause, cell, altitude ORDER BY n DESC LIMIT 60`,
    ),
  ),
)

// ── Q8: what breaks ────────────────────────────────────────────────────────
table(
  'Errors, commonest first',
  ['source', 'message', 'frame', 'n'],
  shown(
    await sql(
      `SELECT ${col('error', 'source')} AS source, ${col('error', 'message')} AS message,
              ${col('error', 'frame')} AS frame, ${W} AS n
       FROM ${dataset} WHERE blob1 = 'error' AND ${since}
       GROUP BY source, message, frame ORDER BY n DESC LIMIT 40`,
    ),
  ),
)

// ── Bug reports: sent by a player to be read, so listed one by one ────────
const bugs = await sql(
  `SELECT timestamp, index1 AS id, ${col('bug', 'build')} AS build, ${col('bug', 'screen')} AS screen,
          ${col('bug', 'mission')} AS mission, ${col('bug', 'device')} AS device,
          ${col('bug', 'error1')} AS error1, ${col('bug', 'error2')} AS error2,
          ${col('bug', 'error3')} AS error3
   FROM ${dataset} WHERE blob1 = 'bug' AND ${since} ORDER BY timestamp DESC LIMIT 100`,
)
table(
  'Bug reports',
  ['timestamp', 'id', 'build', 'screen', 'mission', 'device', 'error1', 'error2', 'error3'],
  { rows: bugs, hidden: 0 },
  'each one sent by a player to be read',
)

// ── The report ─────────────────────────────────────────────────────────────
const esc = (v) =>
  String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gameplay statistics</title>
<style>
:root { color-scheme: light dark; --fg: #1d2330; --bg: #f6f4ef; --muted: #5a6273; --rule: #d9d5cc; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8e6e1; --bg: #12151c; --muted: #a3a9b6; --rule: #2c313c; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 60rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .4rem; } p.note { color: var(--muted); margin: 0 0 .4rem; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
td, th { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid var(--rule); vertical-align: top; }
.wrap { overflow-x: auto; }
</style></head><body><main>
<h1>Gameplay statistics</h1>
<p class="note">${esc(dataset)}, the last ${days} days, made ${esc(new Date().toISOString())}.
No total under ${STATS_SMALLEST} rows is shown; bug reports are the one exception.</p>
${tables
  .map(
    (t) => `<h2>${esc(t.title)}</h2>${t.note ? `<p class="note">${esc(t.note)}</p>` : ''}
<div class="wrap"><table><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>
${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('\n')}
</table></div>${t.hidden > 0 ? `<p class="note">${t.hidden} group(s) under ${STATS_SMALLEST} hidden</p>` : ''}`,
  )
  .join('\n')}
</main></body></html>`
const out = path.join(ROOT, 'docs/private/stats')
fs.mkdirSync(out, { recursive: true })
const file = path.join(out, `report-${dataset}-${new Date().toISOString().slice(0, 10)}.html`)
fs.writeFileSync(file, html)
console.log(`\nreport: ${path.relative(ROOT, file)}`)
