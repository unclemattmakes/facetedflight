// src/audio/spatial.ts — the geometry of positional audio. PURE. No Web Audio,
// no three, no DOM.
//
// ── Why this exists, and why it is NOT a deviation ────────────────────────
//
// The rest of `src/audio/` is 2D on purpose, and that is measured fidelity:
// `MasterAudio.cs`'s `sourceTrans == null` branch sets
// `info.Source.transform.localPosition = Vector3.zero` under the comment
// `// "2d manner" - from Master Audio location`, and
// `PlayerShipInitialization.cs:34-37` parents the whole bank to the camera rig
// at local origin. So every ordinary `PlaySound` in the shipped game emits AT
// THE LISTENER and the 33 groups' `ForceTo3D` config never bites.
//
// **Two cues do not take that branch, and both are genuinely 3D in 2016.**
//
//  1. The shaft whoosh. `FF_WorldTour/scripts/Trigger_PlaySound.cs:12` calls
//     `MasterAudio.PlaySound3DAtVector3(soundName, this.transform.position)`,
//     and the `useVector3` branch of `MasterAudio.PlaySoundOnSource` does
//     `info.Source.transform.position = sourcePosition` — the emitter is MOVED
//     to the trigger box. `PlayerStart_ElevatorShaft_Photon.prefab` carries
//     **eight** of those boxes, every one `m_Enabled: 1`, `m_IsActive: 1`,
//     `soundName: whoosh`, spaced **exactly 12 m apart** up the shaft
//     (composed world Y −80.7759 … +3.2241, components &11466066/68/70/74/76/
//     78/80/82 at prefab lines 6261-6371). The `whoosh` group is
//     `spatialBlendType: 1` / `spatialBlend: 1` with `MinDistance 10`,
//     `MaxDistance 500`, `rolloffMode: 0`.
//  2. The opposition's engines. `LevelArt_SimonetIslands.unity` carries four
//     raw Unity `AudioSource`s (first at `&104834125`, scene line 267) —
//     `PlayOnAwake 1`, `Loop 1`, `DopplerLevel 1.04`, `MinDistance 48`,
//     `MaxDistance 800`, `rolloffMode: 0`, `panLevelCustomCurve` = 1 at t=0
//     (fully 3D), routed to `Audio/Mixer/NPC Ship.mixer`.
//
// So rendering these two positional is **restoring 2016 behaviour the port had
// flattened**, not adding something. See `docs/DEVIATIONS.md` DEV-063 for the
// one half of AUD-5 that IS a deviation (FF2's racers having an engine at all).
//
// ── Why the numbers map onto WebAudio exactly ─────────────────────────────
//
// Unity's `rolloffMode: 0` is Logarithmic: gain is 1 inside `MinDistance`, then
// `MinDistance / d`, and it stops attenuating at `MaxDistance`.
// `ProjectSettings/AudioManager.asset` has `Rolloff Scale: 1`, so there is no
// project-wide scaling on top.
//
// WebAudio's `PannerNode` with `distanceModel: 'inverse'` computes
//
//     refDistance / (refDistance + rolloffFactor * (max(d, ref) - ref))
//
// with `d` clamped to `[refDistance, maxDistance]`. At `rolloffFactor: 1` that
// reduces to `ref / d` inside the range and `ref / maxDistance` beyond it —
// **the same function**, term for term. So `MinDistance -> refDistance`,
// `MaxDistance -> maxDistance`, `rolloffFactor: 1`, and the curve is ported
// rather than approximated. `unityLogRolloff` below is that function written
// out, so a test can assert the mapping instead of a comment claiming it.

/** A point or a direction, metres. Three space, which is also WebAudio space. */
export type Vec3Tuple = readonly [number, number, number]

/**
 * Where the ears are.
 *
 * WORLD space, right-handed, and it is the head pose rather than the ship's:
 * in the cockpit the camera is a child of the XR rig, so **`camera.position` is
 * the wrong vector** — it is the head offset INSIDE the rig, the origin until
 * you lean, while the rig carries the altitude. CLAUDE.md trap 18 is exactly
 * this mistake made one layer down, where `fog.update()` read the local
 * position against a shader using world space and drew a pink line across the
 * terrain at eye level. The caller must use `getWorldPosition()`.
 *
 * `forward` and `up` are unit vectors. WebAudio's listener looks down **−z**,
 * the same convention three's camera uses, so a three camera's world direction
 * goes in unchanged.
 */
export interface ListenerPose {
  readonly position: Vec3Tuple
  readonly forward: Vec3Tuple
  readonly up: Vec3Tuple
}

/** At the origin, looking down −z, +y up. What a context starts as. */
export const DEFAULT_LISTENER: ListenerPose = {
  position: [0, 0, 0],
  forward: [0, 0, -1],
  up: [0, 1, 0],
}

/** How one cue attenuates with distance. Straight off a 2016 `AudioSource`. */
export interface SpatialSpec {
  /**
   * Unity `MinDistance`. Inside it the gain is 1 and there is no rolloff.
   * WebAudio `refDistance`.
   */
  readonly refDistance: number
  /** Unity `MaxDistance`, past which attenuation stops. WebAudio `maxDistance`. */
  readonly maxDistance: number
  /**
   * Unity `DopplerLevel`, multiplied by `AudioManager.asset`'s
   * `Doppler Factor: 1`. Zero disables the shift.
   */
  readonly doppler: number
}

/**
 * Unity's engine default, and it is NOT a project setting.
 *
 * `ProjectSettings/AudioManager.asset` carries `Doppler Factor: 1` and
 * `Rolloff Scale: 1` and no speed of sound at all — Unity 5 dropped
 * `AudioSettings.speedOfSound` from the API and fixed it internally. So this is
 * the documented engine constant rather than a number measured out of the game,
 * and it is labelled that way because DEV-027's rule applies hardest to numbers
 * that LOOK extracted and are not.
 */
export const SPEED_OF_SOUND = 343

/**
 * Listener-relative coordinates for a world point.
 *
 * Right-handed, **−z forward**, so a point dead ahead comes back as
 * `[0, 0, -d]`, one to the player's left as `[-d, 0, 0]`. That is WebAudio's
 * own frame and three's camera frame, so nothing is being converted here — this
 * exists so a headless test can assert WHERE a panner ended up relative to the
 * head, which is the only part of positional audio that can actually be wrong
 * in a way a listener would notice.
 *
 * CLAUDE.md's orientation lesson: **test the geometry, not the rotation.** A
 * distance and a signed offset are true independently of what anybody believed
 * about the handedness; a quaternion assertion is the belief written twice.
 */
export const toListenerSpace = (listener: ListenerPose, world: Vec3Tuple): Vec3Tuple => {
  const f = normalise(listener.forward)
  const u = normalise(listener.up)
  // right = forward x up. Check it once: forward (0,0,-1) x up (0,1,0) = (1,0,0),
  // which is +x, which is the player's right. It is the correct cross for a
  // right-handed frame that looks down −z.
  const r = cross(f, u)
  const d: Vec3Tuple = [
    world[0] - listener.position[0],
    world[1] - listener.position[1],
    world[2] - listener.position[2],
  ]
  return [dot(d, r), dot(d, u), -dot(d, f)]
}

/** Straight-line distance from the ears to a world point, metres. */
export const distanceToListener = (listener: ListenerPose, world: Vec3Tuple): number => {
  const dx = world[0] - listener.position[0]
  const dy = world[1] - listener.position[1]
  const dz = world[2] - listener.position[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Unity's logarithmic rolloff, which is also WebAudio's `inverse` at factor 1.
 *
 * Written out so `tests/unit/audio-spatial.test.ts` can assert the equivalence
 * the header claims, rather than the header claiming it alone. A structural
 * claim with one source is a hypothesis (PORT_PLAN §4.7), and "these two curves
 * are the same function" is exactly the kind of claim that is believed for a
 * year and then turns out to differ past `maxDistance`.
 */
export const unityLogRolloff = (distance: number, spec: SpatialSpec): number => {
  const ref = spec.refDistance
  if (ref <= 0) return 1
  const d = Math.min(Math.max(distance, ref), Math.max(spec.maxDistance, ref))
  return ref / d
}

/**
 * The pitch ratio for a closing speed. **Linearised on purpose.**
 *
 * The exact single-source form is `c / (c - v)`, and it is singular at `v = c`.
 * This game reaches it: the `int_01` speed chain takes terminal from 182 to
 * **340 m/s** over twenty-one gates (`src/sim/speed-chain.ts`), so a racer
 * coming the other way past the player can close at most of Mach 1 and the
 * exact formula would hand the mixer a ratio of 8, or a negative one. The
 * first-order form below is the standard small-Doppler linearisation, it is
 * symmetric in listener and source motion (which is *correct* to first order —
 * and correctness to first order is all the relative radial speed can support
 * anyway, since it cannot say which of the two is moving), and it degrades
 * instead of exploding.
 *
 * `closingSpeed` is positive when the gap is shrinking: `-d(distance)/dt`.
 * Clamped to one octave either way, which a 1.04 `DopplerLevel` reaches at
 * about 330 m/s of closing — i.e. only where the exact formula has already
 * stopped meaning anything.
 */
export const dopplerRatio = (closingSpeed: number, level: number): number => {
  if (!Number.isFinite(closingSpeed) || level === 0) return 1
  const ratio = 1 + (level * closingSpeed) / SPEED_OF_SOUND
  return ratio < 0.5 ? 0.5 : ratio > 2 ? 2 : ratio
}

/** A frequency ratio as a detune in cents, which is what an oscillator takes. */
export const ratioToCents = (ratio: number): number => (ratio > 0 ? 1200 * Math.log2(ratio) : 0)

// ── vector plumbing, deliberately local ───────────────────────────────────
//
// Four lines rather than an import: `src/audio/` owes nothing to `src/sim/`'s
// vector types and a dependency between them would be one more edge in the
// graph for no gain. Everything here allocates rather than writing into a
// scratch — see `index.ts`'s note on trap 19. These run once per emitter per
// frame, which is two calls a frame in the shipped mission.

const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

const normalise = (v: Vec3Tuple): Vec3Tuple => {
  const length = Math.sqrt(dot(v, v))
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : v
}
