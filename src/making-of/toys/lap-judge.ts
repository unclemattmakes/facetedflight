// T27, try to cheat. DEV-521 (docs/plan/MAKING-OF.md §4).
//
// The lap server never believes a time. It takes the lap's POSES and re-times
// them itself, checks the ship could have flown them (continuity, a speed
// ceiling that the speed chain raises), and only then compares the time the
// client claimed. This toy flies a real `int_01` lap with the game's autopilot
// (`flyAutopilotLap`, the same lap the unit tests judge), records it with the
// game's recorder, and hands the bytes to the server's real `validateLap`.
//
// Each cheat edits the honest lap's full-rate recording the way a cheat would,
// and the way `tests/unit/lap-validate.test.ts` forges its refusals: by moving
// poses and ticks, then running them back through the real recorder and wire.

import type { Level } from '@/content/level-schema'
import { validateLevel } from '@/content/level-schema'
import { type AutopilotLap, flyAutopilotLap } from '@/game/autopilot-lap'
import { lapCourse, lapRules, lapVehicle } from '@/net/lap-courses'
import { ghostCourseOf, type LapVerdict, validateLap } from '@/net/lap-validate'
import { FIXED_DT } from '@/sim/constants'
import { decodeGhostClip, type LapDoc, type LapEvent, scoreGhost } from '@/sim/ghost'
import {
  createLapRecorder,
  type LapRecorder,
  lapToBytes,
  markLapEvent,
  recordedLap,
} from '@/sim/ghost-record'
import raw from '../../../content/levels/int_01_hoverJet.json'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

const MISSION = 'int_01_hoverJet'
/** Floats per recorded pose: position and quaternion. */
const POSE = 7

type Cheat = 'honest' | 'faster' | 'teleport' | 'jump' | 'lie' | 'skip'

const CHEATS: readonly { value: Cheat; label: string; what: string }[] = [
  { value: 'honest', label: 'honest', what: 'the lap as the autopilot flew it' },
  {
    value: 'faster',
    label: 'fly faster',
    what: 'one leg replayed at one and a half times the speed',
  },
  { value: 'teleport', label: 'teleport', what: 'half a leg skipped, marked as a crash reset' },
  { value: 'jump', label: 'jump', what: 'a rewind with no reset marked' },
  { value: 'lie', label: 'lie', what: 'the honest lap, claiming half a second less' },
  { value: 'skip', label: 'skip a ring', what: 'one ring flown sixty meters over' },
]

interface Key {
  readonly tick: number
  readonly src: number
  readonly lift?: number
}

export const toy: ToyDef = {
  id: 'lap-judge',
  title: 'Try to cheat',
  caption:
    'A real lap, flown by the game’s autopilot and judged by the lap server’s real validator. Pick a cheat and read the verdict.',
  kind: '2d',
  mount({ stage, controls }) {
    const level = validateLevel(raw as unknown as Level)
    const course = lapCourse(MISSION)
    if (!course) throw new Error(`making-of: no lap course for ${MISSION}`)
    const offset = course.worldOffset
    const run: AutopilotLap = flyAutopilotLap(level, offset)
    const ringTick = (g: number) => run.ringTicks.get(g) as number
    const meta = {
      mission: MISSION,
      mode: 'ringAttack',
      edition: 'anniversary',
      rules: lapRules(MISSION, 'anniversary', 'standard') as string,
      vehicle: lapVehicle('hoverjet', 'standard'),
      build: 'making-of',
    }
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    let cheat: Cheat = 'honest'

    /** A new recording from the honest one's poses, written directly (they are already in its space). */
    const forge = (keys: readonly Key[], events: readonly LapEvent[]): LapRecorder => {
      const src = run.rec
      const rec = createLapRecorder(offset, keys.length)
      keys.forEach((k, i) => {
        rec.ticks[i] = k.tick
        rec.poses.set(src.poses.subarray(k.src * POSE, k.src * POSE + POSE), i * POSE)
        rec.poses[i * POSE + 1] = (rec.poses[i * POSE + 1] as number) + (k.lift ?? 0)
      })
      rec.count = keys.length
      for (const e of [...events].sort((a, b) => a.tick - b.tick)) markLapEvent(rec, e.tick, e.kind)
      return rec
    }
    const remap = (map: (tick: number) => number | null): LapEvent[] =>
      run.rec.events
        .map((e) => ({ tick: map(e.tick), kind: e.kind }))
        .filter((e): e is LapEvent => e.tick !== null)

    /** The recording each cheat makes, and the ticks it tampered with (for the drawing). */
    const recordingFor = (c: Cheat): { rec: LapRecorder; from: number; to: number } => {
      const all = run.finishTick
      if (c === 'faster') {
        const T0 = ringTick(0) + 10
        const span = Math.min(180, ringTick(1) - ringTick(0) - 30)
        const f = 1.5
        const K = Math.floor(span / f)
        const keys: Key[] = []
        for (let t = 0; t <= T0; t++) keys.push({ tick: t, src: t })
        for (let k = 1; k <= K; k++) keys.push({ tick: T0 + k, src: T0 + Math.round(k * f) })
        const resume = T0 + Math.round(K * f)
        for (let s = resume + 1; s <= all; s++) keys.push({ tick: s - resume + T0 + K, src: s })
        const events = remap((t) => (t <= T0 ? t : t > resume ? t - resume + T0 + K : null))
        return { rec: forge(keys, events), from: T0, to: resume }
      }
      if (c === 'teleport') {
        const T = ringTick(4) + 20
        const skip = Math.floor((ringTick(5) - ringTick(4)) / 2)
        const keys: Key[] = []
        for (let t = 0; t <= T; t++) keys.push({ tick: t, src: t })
        for (let s = T + skip; s <= all; s++) keys.push({ tick: s - skip + 1, src: s })
        const events = [
          ...remap((t) => (t <= T ? t : t >= T + skip ? t - skip + 1 : null)),
          { tick: T + 1, kind: 'reset' as const },
        ]
        return { rec: forge(keys, events), from: T, to: T + skip }
      }
      if (c === 'jump') {
        const back = ringTick(5)
        const T = back + 60
        const shift = T + 1 - back
        const keys: Key[] = []
        for (let t = 0; t <= T; t++) keys.push({ tick: t, src: t })
        for (let s = back; s <= all; s++) keys.push({ tick: s + shift, src: s })
        return {
          rec: forge(
            keys,
            remap((t) => (t <= T ? t : t + shift)),
          ),
          from: back,
          to: T,
        }
      }
      if (c === 'skip') {
        const tr = ringTick(8)
        const H = Math.floor(0.8 * Math.min(tr - ringTick(7), ringTick(9) - tr))
        const keys: Key[] = []
        for (let t = 0; t <= all; t++) {
          const u = (t - tr) / H
          keys.push({
            tick: t,
            src: t,
            lift: Math.abs(u) < 1 ? 60 * 0.5 * (1 + Math.cos(Math.PI * u)) : 0,
          })
        }
        return {
          rec: forge(
            keys,
            remap((t) => t),
          ),
          from: tr - H,
          to: tr + H,
        }
      }
      return { rec: run.rec, from: -1, to: -1 }
    }

    /** What a client would claim: the time its own poses score, or less for the liar. */
    const claimFor = (doc: LapDoc, c: Cheat): number => {
      if (c === 'lie') return run.finishAt - 0.5
      const { ghost } = ghostCourseOf(course)
      return scoreGhost(decodeGhostClip(doc), ghost, FIXED_DT).seconds ?? Number.NaN
    }

    const verdicts = new Map<Cheat, { verdict: LapVerdict; from: number; to: number }>()
    const judge = (c: Cheat): { verdict: LapVerdict; from: number; to: number } => {
      const known = verdicts.get(c)
      if (known) return known
      const { rec, from, to } = recordingFor(c)
      const doc = recordedLap(rec, meta)
      const made = {
        verdict: validateLap(lapToBytes(doc), { seconds: claimFor(doc, c) }),
        from,
        to,
      }
      verdicts.set(c, made)
      return made
    }

    const draw = (from: number, to: number) => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const p = run.rec.poses
      const n = run.finishTick + 1
      let [x0, x1, z0, z1] = [Infinity, -Infinity, Infinity, -Infinity]
      for (let i = 0; i < n; i++) {
        x0 = Math.min(x0, p[i * POSE] as number)
        x1 = Math.max(x1, p[i * POSE] as number)
        z0 = Math.min(z0, p[i * POSE + 2] as number)
        z1 = Math.max(z1, p[i * POSE + 2] as number)
      }
      const pad = 20
      const s = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (z1 - z0))
      const px = (x: number) => (w - (x1 - x0) * s) / 2 + (x - x0) * s
      const pz = (z: number) => (h - (z1 - z0) * s) / 2 + (z - z0) * s
      const path = (a: number, b: number, colour: string, width: number) => {
        ctx.beginPath()
        for (let i = a; i <= b; i++) {
          const X = px(p[i * POSE] as number)
          const Z = pz(p[i * POSE + 2] as number)
          if (i === a) ctx.moveTo(X, Z)
          else ctx.lineTo(X, Z)
        }
        ctx.strokeStyle = colour
        ctx.lineWidth = width
        ctx.stroke()
      }
      path(0, n - 1, 'rgba(194,200,229,0.45)', 1.5)
      if (from >= 0) path(Math.max(0, from), Math.min(n - 1, to), '#ff7a7a', 3.5)
      ctx.lineWidth = 1
    }

    const show = () => {
      const { verdict, from, to } = judge(cheat)
      draw(from, to)
      const what = CHEATS.find((c) => c.value === cheat)?.what ?? ''
      if (verdict.ok) {
        out.update([
          { label: 'cheat', value: what },
          {
            label: 'verdict',
            value: verdict.board ? 'ACCEPTED, on the board' : 'ACCEPTED, off the board',
            tone: verdict.board ? 'good' : 'bad',
          },
          { label: 'time', value: `${verdict.score.seconds.toFixed(2)} s` },
          { label: 'rings', value: `${verdict.score.rings} of ${verdict.score.ringsTotal}` },
          ...(verdict.boardReason ? [{ label: 'why', value: verdict.boardReason }] : []),
        ])
      } else {
        out.update([
          { label: 'cheat', value: what },
          { label: 'verdict', value: `REFUSED at ${verdict.stage}`, tone: 'bad' },
          { label: 'why', value: verdict.reason },
        ])
      }
    }

    controls.segmented<Cheat>({
      options: CHEATS.map((c) => ({ value: c.value, label: c.label })),
      value: cheat,
      onChange: (v) => {
        cheat = v
        show()
      },
    })
    show()
    return {
      resize: (w, h) => {
        cv.resize(w, h)
        show()
      },
      dispose: () => cv.dispose(),
    }
  },
}
