// tests/unit/helpers/known-red-rows.ts: read the rows of docs/testing/KNOWN-RED.md and
// decide which have expired (DEV-965). Pure: the clock is a parameter.

export const KNOWN_RED_MAX_AGE_DAYS = 14

export interface KnownRedRow {
  id: string
  owner: string
  /** `YYYY-MM-DD`, or `rig` for a test that needs the headset rig and is not a defect. */
  confirmed: string
}

/** Rows have id, test, first error, since, owner, confirmed (six cells). */
export const parseKnownRedRows = (markdown: string): KnownRedRow[] => {
  const rows: KnownRedRow[] = []
  for (const line of markdown.split('\n')) {
    if (!/^\| KR-\d{2} \|/.test(line)) continue
    const cells = line
      .slice(1, line.lastIndexOf('|'))
      .split('|')
      .map((c) => c.trim())
    rows.push({ id: cells[0] ?? '', owner: cells[4] ?? '', confirmed: cells[5] ?? '' })
  }
  return rows
}

const DAY_MS = 86_400_000

/** Whole days from `confirmed` to `today` (both read as UTC dates); NaN for a malformed date. */
export const ageDays = (confirmed: string, today: Date): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(confirmed)) return Number.NaN
  const start = Date.parse(`${confirmed}T00:00:00Z`)
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.round((end - start) / DAY_MS)
}

/** One line per problem row, each naming the id and its owner, empty when every row is fresh. */
export const expiredRows = (rows: KnownRedRow[], today: Date): string[] =>
  rows.flatMap((r) => {
    if (r.confirmed === 'rig') return []
    const age = ageDays(r.confirmed, today)
    if (Number.isNaN(age)) {
      return [
        `${r.id} (owner: ${r.owner}): confirmed "${r.confirmed}" is not a YYYY-MM-DD date or "rig"`,
      ]
    }
    if (age <= KNOWN_RED_MAX_AGE_DAYS) return []
    return [
      `${r.id} (owner: ${r.owner}): last confirmed red ${r.confirmed}, ${age} days ago (limit ${KNOWN_RED_MAX_AGE_DAYS}). ` +
        `Fix the test and delete its row and knownRed call, or run E2E_KNOWN_RED=${r.id} and write today's date.`,
    ]
  })
