// tools/extract/elevator.mjs — the launch elevator's actual motion.
//
// ── Why this file exists ──────────────────────────────────────────────────
//
// Because `spawn.launchRise` was reading a DEAD COMPONENT and getting away with
// it by two metres.
//
// `Elevator_animator` in `int_01_hoverJet` carries three things:
//
//   Mover_Lift      m_Enabled 1, amplitude 108.5, frequency 0.09, **move 0**
//   LaunchElevator  m_Enabled 1, PlayerShipRoot -> the platform
//   Animator        **m_Enabled 0**, controller Elevator_animator.controller
//
// `Mover_Lift.Update()` is `if (move) LiftMove();` and **nothing in the entire
// 2016 codebase ever sets `move`** — grep it. So its tuned 108.5 never moved
// anything. What moves is the Animator, which starts DISABLED and is switched on
// by `LaunchElevator.StartLaunch()` (LaunchElevator.cs:47).
//
// That controller has one state playing `elevator_up.anim`, whose
// `m_LocalPosition.y` curve is six Hermite keys ending at **106.647 m** over
// **15.4667 s**. Not 108.5, and not instant.
//
// ── How we know the clip is the shipped motion ────────────────────────────
//
// The transform chain under the platform sums to y = 19.79, which is
// `spawn.pos[1]` to five decimals. Add the clip's 106.647 and the ship is
// released at **126.437 m**.
//
// The two 2016 ghost recordings start at **126.286 m**.
//
// Fifteen centimetres, from two completely independent sources — an animation
// curve and a pair of recorded flights. `Mover_Lift`'s 108.5 would have put it
// at 128.29, nearly two metres out. That is the whole argument, and it is why
// this reads the clip rather than the convenient field next to it.
//
// The legacy project is READ-ONLY: this parses, never writes.

import fs from 'node:fs'
import path from 'node:path'
import { readUnityText } from '../unity/yaml.mjs'

/** `Assets/.../elevator_up.anim`, relative to the project root. */
export const ELEVATOR_CLIP =
  'Assets/Faceted Flight/FF_WorldTour/animation/experimental/elevator_up.anim'

/**
 * Parse the `m_LocalPosition.y` track out of a Unity `.anim`.
 *
 * Hand-rolled rather than run through the YAML parser because a `PositionCurve`
 * key is a nest of inline flow mappings (`value: {x: 0, y: 79.2777557, z: 0}`)
 * and we want exactly one channel of it. Unity writes these files with a fixed
 * shape, so a line scan is honest here — and it fails loudly rather than
 * silently returning an empty curve.
 *
 * Returns `[{ time, value, inSlope, outSlope }]`, ascending by time.
 */
export const readElevatorCurve = (projectRoot, relPath = ELEVATOR_CLIP) => {
  const abs = path.join(projectRoot, relPath)
  if (!fs.existsSync(abs)) throw new Error(`elevator clip missing: ${relPath}`)
  const lines = readUnityText(abs).split(/\r?\n/)

  const start = lines.findIndex((l) => l.trim() === 'm_PositionCurves:')
  if (start < 0) throw new Error(`${relPath}: no m_PositionCurves`)

  // Unity's float literals here drop the leading zero: `.600000024`.
  const yOf = (line) => {
    const m = /y:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(line)
    return m ? Number(m[1]) : null
  }
  const timeOf = (line) => {
    const m = /^\s*-\s*time:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*$/.exec(line)
    return m ? Number(m[1]) : null
  }

  const keys = []
  let current = null
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // The position track ends where the next top-level key begins.
    if (/^\s{2}m_[A-Za-z]/.test(line) && !/^\s{2}m_PositionCurves/.test(line)) break
    const t = timeOf(line)
    if (t !== null) {
      if (current) keys.push(current)
      current = { time: t, value: null, inSlope: null, outSlope: null }
      continue
    }
    if (!current) continue
    if (/^\s*value:/.test(line)) current.value = yOf(line)
    else if (/^\s*inSlope:/.test(line)) current.inSlope = yOf(line)
    else if (/^\s*outSlope:/.test(line)) current.outSlope = yOf(line)
  }
  if (current) keys.push(current)

  const complete = keys.filter((k) => k.value !== null && k.inSlope !== null && k.outSlope !== null)
  if (complete.length < 2) {
    throw new Error(`${relPath}: parsed ${complete.length} usable keys from the Y track`)
  }
  for (let i = 1; i < complete.length; i++) {
    if (complete[i].time <= complete[i - 1].time) {
      throw new Error(`${relPath}: keys are not strictly ascending in time`)
    }
  }
  return complete
}

/** `m_StopTime`, which is the clip's authored length rather than its last key's time. */
export const readClipStopTime = (projectRoot, relPath = ELEVATOR_CLIP) => {
  const abs = path.join(projectRoot, relPath)
  const text = readUnityText(abs)
  const m = /m_StopTime:\s*(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(text)
  return m ? Number(m[1]) : null
}
