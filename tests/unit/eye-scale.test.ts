// tests/unit/eye-scale.test.ts: the eye buffer's controller, on made-up
// periods and on the six worn flights' recorded ones. DEV-996.
//
// The recorded half replays `tests/unit/fixtures/worn-frame-periods.json`
// (`tools/perf/worn-periods.mjs`, from `perf-out/worn-trace/2026-10-15_*`):
// Chrome's own rAF-to-rAF period out of each trace, and the game's `dt_ms`,
// which is what `boot/app/frame.ts` feeds the controller. A recording is OPEN
// LOOP (it cannot show the misses a smaller eye would have removed), so what
// it can hold is how the controller behaves on real miss patterns: when it
// steps, how often, how far, and that every step had its evidence in the
// periods just before it, counted here independently of the controller.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createEyeScaleState,
  DOWN_MISSES,
  DOWN_WINDOW_FRAMES,
  EYE_SCALE_FLOOR,
  EYE_SCALE_STEPS,
  type EyeScaleChange,
  eyeScaleOf,
  GRACE_FRAMES,
  HOLD_FRAMES,
  MISS_FACTOR,
  PROBATION_FRAMES,
  replayEyeScale,
  STALL_FACTOR,
  stepEyeScale,
  UP_CLEAN_FRAMES,
  UP_MAX_MISSES,
} from '@/render/eye-scale'

const HZ = 72
const GOOD = 1 / HZ
const LATE = 2 / HZ

/** Run `periods` (seconds) through a fresh state; the changes and the state. */
const run = (periods: readonly number[], hz = HZ) => {
  const state = createEyeScaleState()
  const changes: EyeScaleChange[] = []
  for (const p of periods) {
    const c = stepEyeScale(state, p, hz)
    if (c) changes.push(c)
  }
  return { state, changes }
}

const repeat = (n: number, p: number): number[] => Array.from({ length: n }, () => p)

/** Past the grace, with room for a hold. */
const settled = (): number[] => repeat(GRACE_FRAMES + HOLD_FRAMES, GOOD)

describe('eye-scale: the rules, on made-up periods', () => {
  it('holds full scale on a flight that never misses', () => {
    const { state, changes } = run(repeat(10_000, GOOD))
    expect(changes).toEqual([])
    expect(eyeScaleOf(state)).toBe(1)
  })

  it('a late frame now and then is not a burst', () => {
    // Two misses inside every window: one short of the burst.
    const periods = settled()
    for (let i = 0; i < 200; i++)
      periods.push(LATE, ...repeat(Math.floor(DOWN_WINDOW_FRAMES / 2), GOOD))
    const { changes, state } = run(periods)
    expect(state.missCount).toBe(200)
    expect(changes).toEqual([])
  })

  it('a burst steps down one step, and says why', () => {
    const { changes, state } = run([...settled(), ...repeat(DOWN_MISSES, LATE)])
    expect(changes).toHaveLength(1)
    expect(changes[0]?.from).toBe(1)
    expect(changes[0]?.to).toBe(EYE_SCALE_STEPS[1])
    expect(changes[0]?.reason).toContain(`${DOWN_MISSES} frames over ${MISS_FACTOR}x`)
    expect(eyeScaleOf(state)).toBe(EYE_SCALE_STEPS[1])
  })

  it('missing every frame walks to the floor and no further, one step per hold', () => {
    const { changes, state } = run([...settled(), ...repeat(5_000, LATE)])
    expect(eyeScaleOf(state)).toBe(EYE_SCALE_FLOOR)
    expect(changes.every((c) => c.to < c.from)).toBe(true)
    expect(Math.min(...changes.map((c) => c.to))).toBe(EYE_SCALE_FLOOR)
    for (let i = 1; i < changes.length; i++) {
      expect((changes[i] as EyeScaleChange).frame - (changes[i - 1] as EyeScaleChange).frame).toBe(
        HOLD_FRAMES,
      )
    }
  })

  it('climbs one step after a clean stretch, and only then', () => {
    const down = [...settled(), ...repeat(DOWN_MISSES, LATE)]
    const almost = run([...down, ...repeat(UP_CLEAN_FRAMES - 1, GOOD)])
    expect(almost.changes).toHaveLength(1)
    const climbed = run([...down, ...repeat(UP_CLEAN_FRAMES, GOOD)])
    expect(climbed.changes).toHaveLength(2)
    expect(climbed.changes[1]?.to).toBe(1)
  })

  it(`a clean stretch may hold ${UP_MAX_MISSES} miss, not ${UP_MAX_MISSES + 1}`, () => {
    const down = [...settled(), ...repeat(DOWN_MISSES, LATE)]
    const half = Math.floor(UP_CLEAN_FRAMES / 3)
    const one = run([...down, ...repeat(half, GOOD), LATE, ...repeat(UP_CLEAN_FRAMES, GOOD)])
    const two = run([
      ...down,
      ...repeat(half, GOOD),
      LATE,
      ...repeat(half, GOOD),
      LATE,
      ...repeat(UP_CLEAN_FRAMES - 2 * half - 2, GOOD),
    ])
    // Both reach UP_CLEAN_FRAMES after the step down; only the first has at most one miss in it.
    expect(one.changes.map((c) => c.to)).toEqual([EYE_SCALE_STEPS[1], 1])
    expect(two.changes.map((c) => c.to)).toEqual([EYE_SCALE_STEPS[1]])
  })

  it('a climb that fails inside its probation doubles the next clean stretch', () => {
    const down = [...settled(), ...repeat(DOWN_MISSES, LATE)]
    const climb = repeat(UP_CLEAN_FRAMES, GOOD)
    // Down again soon after the climb, but past the hold.
    const fail = [...repeat(HOLD_FRAMES, GOOD), ...repeat(DOWN_MISSES, LATE)]
    const { changes, state } = run([...down, ...climb, ...fail])
    expect(changes.map((c) => c.to)).toEqual([EYE_SCALE_STEPS[1], 1, EYE_SCALE_STEPS[1]])
    expect(state.backoff).toBe(2)
    expect(changes[2]?.reason).toContain('the last climb failed')
    // The next climb needs twice the stretch.
    const after = [...down, ...climb, ...fail]
    expect(run([...after, ...repeat(2 * UP_CLEAN_FRAMES - 1, GOOD)]).changes).toHaveLength(3)
    expect(run([...after, ...repeat(2 * UP_CLEAN_FRAMES, GOOD)]).changes).toHaveLength(4)
  })

  it('a climb that holds through its probation earns the back-off down again', () => {
    const down = [...settled(), ...repeat(DOWN_MISSES, LATE)]
    const climb = repeat(UP_CLEAN_FRAMES, GOOD)
    const fail = [...repeat(HOLD_FRAMES, GOOD), ...repeat(DOWN_MISSES, LATE)]
    const doubled = run([...down, ...climb, ...fail, ...repeat(2 * UP_CLEAN_FRAMES, GOOD)])
    expect(doubled.state.backoff).toBe(2)
    const held = run([
      ...down,
      ...climb,
      ...fail,
      ...repeat(2 * UP_CLEAN_FRAMES + PROBATION_FRAMES + 1, GOOD),
    ])
    expect(held.state.backoff).toBe(1)
  })

  it('a stall is not a miss: compiles and hidden frames are ignored', () => {
    const stall = (STALL_FACTOR + 1) / HZ
    const { changes, state } = run([...settled(), ...repeat(50, stall)])
    expect(changes).toEqual([])
    expect(state.missCount).toBe(0)
    expect(state.ignored).toBe(50)
  })

  it('the first seconds of a session are not evidence', () => {
    const { changes, state } = run([...repeat(GRACE_FRAMES, LATE), ...repeat(HOLD_FRAMES, GOOD)])
    expect(state.missCount).toBe(0)
    expect(changes).toEqual([])
  })

  it('judges a period against the display it is given', () => {
    // 18 ms is late at 90 Hz (over 16.7) and on time at 72 (under 20.8).
    const periods = [...repeat(GRACE_FRAMES + HOLD_FRAMES, 1 / 90), ...repeat(DOWN_MISSES, 0.018)]
    expect(run(periods, 90).changes).toHaveLength(1)
    expect(run(periods, 72).changes).toHaveLength(0)
  })
})

// ── the worn flights ────────────────────────────────────────────────────────

interface Trace {
  readonly id: string
  readonly label: string
  readonly displayHz: number
  readonly chromePeriods: string | null
  readonly gameDt: string | null
}

const FIXTURE = path.join(__dirname, 'fixtures', 'worn-frame-periods.json')
const traces = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { traces: Trace[] }).traces

const sequences = traces.flatMap((t) =>
  (['chromePeriods', 'gameDt'] as const)
    .filter((source) => t[source] !== null)
    .map((source) => ({
      name: `${t.id} ${source}`,
      label: t.label,
      displayHz: t.displayHz,
      ms: (t[source] as string).split(' ').map((v) => Number(v) / 10),
    })),
)

describe('eye-scale: the worn flights of 2026-10-15, replayed', () => {
  it('the fixture holds every flight, both sources where the capture had them', () => {
    expect(traces.map((t) => t.id)).toHaveLength(6)
    // Trace 1's frames.json has no per-frame rows; the other five have both.
    expect(sequences).toHaveLength(11)
    for (const s of sequences) expect(s.ms.length).toBeGreaterThan(2_500)
  })

  for (const seq of sequences) {
    it(`${seq.name} (${seq.label})`, () => {
      const r = replayEyeScale(seq.ms, seq.displayHz)
      const minutes = r.frames / seq.displayHz / 60
      // Never below the floor, never two changes inside a hold.
      expect(r.lowest).toBeGreaterThanOrEqual(EYE_SCALE_FLOOR)
      expect(r.minGap).toBeGreaterThanOrEqual(HOLD_FRAMES)
      // Every one of these flights missed 6 % to 20 % of its frames in bursts:
      // the controller must have stepped down at least once, and not flapped.
      expect(r.changes.filter((c) => c.to < c.from).length).toBeGreaterThan(0)
      expect(r.changes.length / minutes).toBeLessThan(8)

      // The evidence, counted from the periods themselves: every step down
      // had DOWN_MISSES late frames in the DOWN_WINDOW_FRAMES before it, and
      // every step up at most UP_MAX_MISSES in the UP_CLEAN_FRAMES before it.
      const display = 1000 / seq.displayHz
      const counted = seq.ms.filter((p) => p > 0 && p <= STALL_FACTOR * display)
      const late = counted.map((p) => p > MISS_FACTOR * display)
      const missesBefore = (frame: number, window: number): number =>
        late.slice(Math.max(0, frame - window), frame).filter(Boolean).length
      for (const c of r.changes) {
        if (c.to < c.from) {
          expect(missesBefore(c.frame, DOWN_WINDOW_FRAMES)).toBeGreaterThanOrEqual(DOWN_MISSES)
        } else {
          expect(missesBefore(c.frame, UP_CLEAN_FRAMES)).toBeLessThanOrEqual(UP_MAX_MISSES)
        }
      }
    })
  }

  it('trace 5 flew its first stretch clean and the controller held full scale through it', () => {
    // SteamVR's own timing beside trace 5 saw no skipped vsync for the first
    // 35 s; the controller's first step comes only once the misses do.
    const seq = sequences.find((s) => s.name === '2026-10-15_01-15-04 chromePeriods')
    expect(seq).toBeDefined()
    const s = seq as NonNullable<typeof seq>
    const r = replayEyeScale(s.ms, s.displayHz)
    const firstStep = r.changes[0] as EyeScaleChange
    expect(firstStep.frame / s.displayHz).toBeGreaterThan(20)
  })
})
