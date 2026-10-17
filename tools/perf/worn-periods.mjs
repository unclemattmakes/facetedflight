// tools/perf/worn-periods.mjs: the worn traces' frame periods, as a test fixture. DEV-996.
//
//   node tools/perf/worn-periods.mjs [perf-out/worn-trace] [tests/unit/fixtures/worn-frame-periods.json]
//
// `render/eye-scale.ts`'s controller decides on one number per XR frame: the period since the
// previous one. Its unit test replays what six worn flights actually delivered, so this copies
// that number out of each capture `pnpm perf:worn-trace` wrote (DEV-993), in two sources:
//
//   * `frames.json`'s `period`: Chrome's own rAF-to-rAF time from the trace (the reducer's
//     `ExecuteRAFCallbacks`), the signal the trace's "slow frames" column is cut from;
//   * `game-perf.trace.csv`'s `dt_ms`: the game's own frame delta, the number the controller
//     is actually fed in the app (`boot/app/frame.ts`).
//
// Tenths of a millisecond, space-separated in one string per source, so the file stays small and
// biome leaves it on one line. `perf-out/` is not in git; the fixture is.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** What each capture was, from `docs/plan/eval-wave/eval-frame-trace.md`. */
export const WORN_TRACES = [
  { id: '2026-10-15_00-10-55', label: 'trace 1: int_01 Classic, medium (1620 px, 4x), battery' },
  { id: '2026-10-15_00-47-34', label: 'trace 3: int_02 Classic, medium (1620 px, 4x), HAGS off' },
  {
    id: '2026-10-15_00-53-49',
    label: 'unlabelled 00:53 run: int_01 Classic, medium (1620 px, 4x)',
  },
  { id: '2026-10-15_00-57-19', label: 'trace 4: int_01 Classic, medium (1620 px, 4x), PresentMon' },
  {
    id: '2026-10-15_01-15-04',
    label: 'trace 5: int_01 Classic, medium (1620 px, 4x), SteamVR timing',
  },
  { id: '2026-10-15_01-28-45', label: 'trace 6: int_01 Classic, low (1512 px, no MSAA)' },
]

/** Milliseconds to the fixture's tenths string. */
export const toTenths = (ms) => ms.map((v) => String(Math.round(v * 10))).join(' ')

const readPeriods = (dir) => {
  const file = path.join(dir, 'frames.json')
  if (!fs.existsSync(file)) return null
  const frames = JSON.parse(fs.readFileSync(file, 'utf8')).frames ?? []
  const out = frames.map((f) => f.period).filter((p) => typeof p === 'number' && p > 0)
  return out.length > 0 ? out : null
}

const readGame = (dir) => {
  const file = path.join(dir, 'game-perf.trace.csv')
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const header = JSON.parse(lines[0])
  const cols = lines[1].split(',')
  const dt = cols.indexOf('dt_ms')
  const rows = lines.slice(2).map((l) => Number(l.split(',')[dt]))
  return { budgetMs: header.budgetMs, dt: rows.filter((v) => v > 0) }
}

export const buildFixture = (root) => ({
  about:
    'Frame periods of the worn traces of 2026-10-15 (docs/plan/eval-wave/eval-frame-trace.md), ' +
    'tenths of a millisecond. Written by tools/perf/worn-periods.mjs; read by ' +
    'tests/unit/eye-scale.test.ts (DEV-996).',
  traces: WORN_TRACES.map(({ id, label }) => {
    const dir = path.join(root, id)
    const periods = readPeriods(dir)
    const game = readGame(dir)
    return {
      id,
      label,
      displayHz: game ? Math.round(1000 / game.budgetMs) : 72,
      chromePeriods: periods ? toTenths(periods) : null,
      gameDt: game ? toTenths(game.dt) : null,
    }
  }),
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ?? 'perf-out/worn-trace'
  const out = process.argv[3] ?? 'tests/unit/fixtures/worn-frame-periods.json'
  const fixture = buildFixture(root)
  fs.writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`)
  for (const t of fixture.traces) {
    const n = (s) => (s ? s.split(' ').length : 0)
    console.log(`${t.id}: ${n(t.chromePeriods)} Chrome periods, ${n(t.gameDt)} game frames`)
  }
}
