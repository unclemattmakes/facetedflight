// src/game/speed-line-ramp.ts — the speed lines RAMP instead of switching.
// DEV-351.
//
// Matt, 2026-09-24: *"our 'speed lines' particle fx are pretty binary. it'd be
// nice if they ramped in both in numbers, transparency, and speed."*
//
// ── Why they read as binary ───────────────────────────────────────────────
//
// `Ship_HoverShip.Update()` plays EXACTLY ONE of three boost systems and stops
// the other two, cut at the prefab's 120 / 240 / 350 m/s (`boostStageAt` below
// is that, as arithmetic, and it is still what Classic runs). Off the sheet:
//
//                     rate/s   spawn speed    shell     space
//   boost_particles       75     90-250 m/s   4.63 m    local (rides the ship)
//   fasterBoost          150    350-400 m/s   8.07 m    world
//   ludacrisSpeed        300    550-650 m/s   8.07 m    world
//
// So at 119.9 m/s there is nothing and at 120 there are 75 streaks a second at
// full alpha; at 240 the tube jumps outward by 3.4 m, doubles its count, and —
// because stage 1 rides the ship while stage 2 is left behind in the world —
// its streaks go from ~170 m/s past the eye to ~615. Every cut is a step in all
// three of the things Matt named.
//
// ── The ramp ──────────────────────────────────────────────────────────────
//
// Three rules, and every speed in them is 2016's own except the onset:
//
//   1. EACH STAGE IS 2016's OWN, ALONE, AT THE MIDDLE OF THE BAND 2016 GAVE IT.
//      Stage 1 at (120+240)/2, stage 2 at (240+350)/2, stage 3 at (350+top)/2.
//      There its emission rate is exactly the authored rate and no other stage
//      emits. That is the anchor: the ramp passes THROUGH the shipped design.
//
//   2. BETWEEN TWO MIDDLES THE STAGES CROSSFADE, linearly, by EMISSION RATE.
//      The outgoing stage's rate falls as the incoming one's rises, so the
//      total count runs as a straight line from one authored rate to the next
//      (75 → 150 → 300) instead of a step. The 50/50 point lands within 6 m/s
//      of 2016's cut (237.5 against 240, 344.4 against 350). Particles already
//      in the air finish their lives, exactly as they did after 2016's `Stop()`.
//      Above stage 3's middle it stays stage 3 — ludacrisSpeed, as authored.
//
//   3. BELOW STAGE 1's MIDDLE THE LINES RAMP IN, in all three channels at once:
//      the rate rises from nothing at `onsetSpeed`, and the alpha and the spawn
//      speed rise from their floors, all reaching 2016's own numbers at the
//      middle of stage 1's band and staying there. The spawn speed carries the
//      STRETCH with it — the engine draws a streak's length from its velocity
//      (`size * lengthScale + speed * velocityScale`) — so a slower streak is
//      also a shorter one.
//
// Nothing here ever EXCEEDS the sheet. Every multiplier is in [0, 1], so the
// generated spec is the ceiling of every channel and is reached: rule 1 reaches
// it for the rate, rule 3 for the alpha and the speed.
//
// ── The comfort slider ────────────────────────────────────────────────────
//
// At `speedFx` 0 the ramp is OFF and the three cuts come back — the same answer
// `speedLineOverride` gives, for the same reason, so "off" means one thing
// across the whole of S2. Above 0 the ramp is drawn WHOLE: the slider's scaling
// of how much the lines are seen stays where it already was, on S2's width,
// alpha and lift. The slider does NOT interpolate the ramp back toward the
// cuts, and that is a decision: a half-ramp is a half-cut, `light` is the
// DEFAULT setting, and a comfort setting that made the onset MORE sudden would
// be working against itself. Sudden onset of optic flow is the thing a comfort
// block exists to soften.

import type { EditionSpeedRamp } from '@/content/edition-schema'
import { HOVERJET } from '@/generated/constants.generated'

/**
 * What the speed does to one boost field this frame. The same three numbers the
 * engine's `ParticleDrive` carries, restated here so this module stays free of
 * three.js and the unit test can run it bare.
 */
export interface SpeedLineDrive {
  /** Multiplies the emission rate. 0 emits nothing, 1 is the authored rate. */
  rate: number
  /** Multiplies the particle alpha, on top of S2's `alphaScale`. */
  alpha: number
  /** Multiplies the spawn speed, and with it the drawn streak length. */
  speed: number
}

/** 2016's cuts and the envelope's top, all off the generated sheet. */
export interface SpeedLineStages {
  /**
   * `minBoostEffectsSpeed`, `minBoostEffect_stage2_speed`,
   * `minBoostEffect_stage3_speed`, ascending. Metres per second of FORWARD speed.
   */
  readonly cuts: readonly [number, number, number]
  /** `maxSpeed` — the top of the envelope, as `particle-fx.ts`'s header calls it. */
  readonly top: number
}

/** The ramp, resolved against the comfort slider. `null` is 2016's three cuts. */
export interface SpeedLineRamp {
  readonly onsetSpeed: number
  readonly alphaFloor: number
  readonly speedFloor: number
}

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x)

/**
 * The key names on `HOVERJET.ship`, in stage order — the PREFAB's values, which
 * `particle-fx.ts`'s header shows are four times the C# initialisers.
 */
export const SPEED_LINE_CUT_KEYS = [
  'minBoostEffectsSpeed',
  'minBoostEffect_stage2_speed',
  'minBoostEffect_stage3_speed',
] as const

/**
 * The HoverJet's stages, off the generated sheet. Throws rather than falling
 * back to a typed-in number: a missing key is an extractor fault, and a literal
 * here would hide it (hard rule 3).
 */
export const hoverJetSpeedLineStages = (): SpeedLineStages => {
  const ship = HOVERJET.ship as unknown as Record<string, unknown>
  const read = (key: string): number => {
    const v = ship[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`HOVERJET.ship.${key} is not on the sheet`)
    }
    return v
  }
  const [k1, k2, k3] = SPEED_LINE_CUT_KEYS
  return Object.freeze({
    cuts: Object.freeze([read(k1), read(k2), read(k3)]) as readonly [number, number, number],
    top: read('maxSpeed'),
  })
}

/**
 * The preset's ramp, or `null` for 2016's cuts: the flag off, or the comfort
 * slider at zero. Above zero the slider does not scale the ramp — see the
 * header for why.
 */
export const speedLineRamp = (flag: EditionSpeedRamp, speedFx: number): SpeedLineRamp | null => {
  if (!flag.enabled || !(speedFx > 0)) return null
  return {
    onsetSpeed: Math.max(0, flag.onsetSpeed),
    alphaFloor: clamp01(flag.alphaFloor),
    speedFloor: clamp01(flag.speedFloor),
  }
}

/**
 * `Ship_HoverShip.Update()`'s choice, as arithmetic: 0 below the first cut,
 * otherwise the stage whose cut the speed has reached. Exactly one plays.
 * The comparison is `<`, as it always was here — a speed ON a cut is in the
 * stage above it.
 */
export const boostStageAt = (forwardSpeed: number, stages: SpeedLineStages): 0 | 1 | 2 | 3 => {
  const [c1, c2, c3] = stages.cuts
  return forwardSpeed < c1 ? 0 : forwardSpeed < c2 ? 1 : forwardSpeed < c3 ? 2 : 3
}

/**
 * The middle of the band 2016 gave each stage, m/s: where that stage is 2016's
 * own, alone (rule 1 in the header).
 */
export const stageMiddles = (stages: SpeedLineStages): readonly [number, number, number] => {
  const [c1, c2, c3] = stages.cuts
  const half = (a: number, b: number): number => (a + b) / 2
  return [half(c1, c2), half(c2, c3), half(c3, stages.top)]
}

const newDrives = (): [SpeedLineDrive, SpeedLineDrive, SpeedLineDrive] => [
  { rate: 0, alpha: 0, speed: 0 },
  { rate: 0, alpha: 0, speed: 0 },
  { rate: 0, alpha: 0, speed: 0 },
]

/**
 * The three boost fields' drives at `forwardSpeed`, under the ramp.
 *
 * Writes into `out` when given one — the per-frame caller passes its own, so
 * nothing is allocated in the loop — and returns it. The caller must COPY the
 * numbers out; `ParticleField.setDrive` does (CLAUDE.md trap 19).
 */
export const speedLineDrives = (
  forwardSpeed: number,
  stages: SpeedLineStages,
  ramp: SpeedLineRamp,
  out: [SpeedLineDrive, SpeedLineDrive, SpeedLineDrive] = newDrives(),
): [SpeedLineDrive, SpeedLineDrive, SpeedLineDrive] => {
  const v = Number.isFinite(forwardSpeed) ? forwardSpeed : 0
  const [m1, m2, m3] = stageMiddles(stages)
  // An onset at or past stage 1's middle degenerates to a step AT the middle,
  // rather than to a rising edge that runs backwards.
  const onset = Math.min(ramp.onsetSpeed, m1)

  // Rule 3: the ramp-in, one fraction for all three channels.
  const rampIn = m1 > onset ? clamp01((v - onset) / (m1 - onset)) : v >= m1 ? 1 : 0
  // Rule 2: how far the hand-offs have got.
  const into2 = m2 > m1 ? clamp01((v - m1) / (m2 - m1)) : v >= m2 ? 1 : 0
  const into3 = m3 > m2 ? clamp01((v - m2) / (m3 - m2)) : v >= m3 ? 1 : 0

  const rates = [rampIn * (1 - into2), into2 * (1 - into3), into3] as const
  // Zero at rest, and zero wherever the ramp has not begun; above it, from the
  // floor to 2016's own. Shared by all three stages, so the crossfade can never
  // make the picture dimmer or slower than the stage it is leaving.
  const alpha = rampIn > 0 ? ramp.alphaFloor + (1 - ramp.alphaFloor) * rampIn : 0
  const speed = rampIn > 0 ? ramp.speedFloor + (1 - ramp.speedFloor) * rampIn : 0

  for (let i = 0; i < 3; i++) {
    const d = out[i] as SpeedLineDrive
    d.rate = rates[i] as number
    d.alpha = alpha
    d.speed = speed
  }
  return out
}
