// src/boot/feel.ts: the one door game events use to be FELT. DEV-636/637.
//
// POLISH-WAVE-2026-10-05 "the feel rules": a gate, a crash, a boost stage, a
// racer going by all want the same four things (a camera shake, a rumble, a lens
// kick, a cockpit jolt) and each of those has a rule about WHERE it is legal.
// Callers should not know the rules, so they call this:
//
//     feel.shake(TRAUMA.crash)        // flat camera trauma, 0..1, added
//     feel.haptic('cleanGate')        // a rumble kind, through the priority scheduler
//     feel.fovKick(2, 0.15)           // degrees and seconds, flat only
//     feel.jolt(JOLTS.nearMiss)       // the cockpit MESH, the one legal in a headset
//     feel.boostHum(0..1)             // the continuous boost rumble, 0 stops it
//
// and the rules are kept HERE, once:
//
//   · FLAT: the camera may shake (`render/camera-shake.ts`) and the lens may
//     kick (`render/flat-fov.ts`). Both are applied to the camera's RENDER pose
//     only and both are ZERO in an XR session. Both are vection-shaped, so both
//     are scaled by the Speed FX slider (off 0, light 0.5, full 1).
//   · XR: the rig never shakes and the lens never moves. The cockpit mesh may
//     vibrate (`game/cockpit-jolt.ts`, through `cockpit.shake`, which the
//     slider also scales) and the controllers may pulse. Audio may do anything.
//   · A haptic is not vection and is not scaled by the slider: it has its own
//     switch (the Controls page's HAPTICS row).
//   · Classic is a look (D35): every one of these is gameplay feedback and runs
//     in both looks, except the cockpit mesh, which is still in Classic because
//     `cockpit.shake` is off there.
//
// The sim is untouched. Nothing here can see a body, and nothing here is read
// by the sim, a raycast or the HUD's placement.

import { type CockpitJolt, startJolt } from '@/game/cockpit-jolt'
import type { HapticKind, Haptics } from '@/input/haptics'
import type { CameraShake } from '@/render/camera-shake'
import type { FlatFov } from '@/render/flat-fov'

export interface Feel {
  /** Add camera trauma (0..1). Flat only: dropped in a session and with Speed FX off. */
  shake(trauma: number): void
  /** A rumble, through the priority scheduler. Dropped when the HAPTICS switch is off. */
  haptic(kind: HapticKind): void
  /** Widen the flat lens `deg` degrees at once, back over `seconds`. Flat only, slider-scaled. */
  fovKick(deg: number, seconds: number): void
  /** Jolt the cockpit MESH: a blow of `gain` (multiples of the buffet's amplitude) dying over `seconds`. */
  jolt(spec: { readonly gain: number; readonly seconds: number }): void
  /** The boost hum, 0..1 by stage; 0 stops it (the button released, the tank empty). */
  boostHum(level: number): void
  /** The shake in force, for the render hook and the tests. */
  readonly cameraShake: CameraShake
  /** The cockpit jolt in flight, for `flight.shake`. */
  readonly cockpitJolt: CockpitJolt
  readonly haptics: Haptics
}

export interface FeelDeps {
  cameraShake: CameraShake
  haptics: Haptics
  cockpitJolt: CockpitJolt
  flatFov: Pick<FlatFov, 'kick'>
  /** Performance clock, ms. */
  nowMs(): number
  /** The Speed FX slider as 0 / 0.5 / 1, read live. */
  speedFx(): number
  /** Is an XR session presenting? */
  presenting(): boolean
}

export const createFeel = (deps: FeelDeps): Feel => ({
  cameraShake: deps.cameraShake,
  cockpitJolt: deps.cockpitJolt,
  haptics: deps.haptics,
  shake(trauma) {
    if (deps.presenting() || !(deps.speedFx() > 0)) return
    deps.cameraShake.add(trauma)
  },
  haptic(kind) {
    deps.haptics.trigger(kind, deps.nowMs())
  },
  fovKick(deg, seconds) {
    const scale = deps.speedFx()
    if (deps.presenting() || !(scale > 0)) return
    deps.flatFov.kick(deg * scale, seconds)
  },
  jolt(spec) {
    startJolt(deps.cockpitJolt, spec.gain, spec.seconds, deps.nowMs() / 1000)
  },
  boostHum(level) {
    deps.haptics.setBoost(level)
  },
})
