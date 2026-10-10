// src/render/vignette.ts — the comfort vignette, and the screen fade that rides
// on the same draw call.
//
// PORT_PLAN §2.9 item 1, and R12 is the risk it exists for: *"Seated player,
// world rotating around a stationary head, no auto-level, unlimited roll,
// 179.6 m/s boosting, on a browser at 72 Hz ... Developer adaptation is real and
// fast: within a week of daily testing you stop being able to see the problem
// you shipped."* 2016 shipped no vignette; it also shipped to a tethered Rift at
// a locked 90 Hz. This is a deliberate departure and it owes a DEVIATIONS row.
//
// ── The signal is the ANGULAR RATE, and mostly the ROLL rate ─────────────
//
// §2.9, in its own words: *"Vignette driven by angular rate, not speed. Roll
// rate is the nauseogenic term; a speed-driven vignette is wide open during the
// worst manoeuvre in the game."* Straight-line 179.6 m/s over an island is
// comfortable. A slow barrel roll at 30 m/s is not.
//
// The rate is READ OFF THE BODY, not differenced from a quaternion frame to
// frame. `RigidBody.angularVelocity` is the integrator's own state in rad/s
// (`sim/rigidbody.ts`) — the same vector the ship is actually turning at, at the
// fixed step, exact. Differencing two render-frame quaternions instead would
// give a number that is quantised by the frame rate, noisy exactly when frames
// are dropping, and zero on any frame that renders twice from one sim state —
// i.e. it would go blind during a hitch, which is the moment it is for.
//
// ── Body axes, not world axes ────────────────────────────────────────────
//
// `angularVelocity` is WORLD space. Roll is rotation about the ship's own
// forward axis, so the vector is rotated into the body frame first and read off
// as x = pitch, y = yaw, z = roll (Unity/`sim` convention: +Z forward, +Y up).
// Taking `|ω|` instead would weight a yaw turn the same as a roll, and a ship
// that is inverted would have its roll counted as anything at all.

import * as THREE from 'three'
import type { VignetteSetting } from '@/boot/settings'
import { HOVERJET, JUMPSEAT } from '@/generated/constants.generated'
import { FEATHER, R_CLOSED_LIGHT, R_CLOSED_STRONG, R_OPEN } from '@/render/aperture'
import type { FuzzFrame } from '@/render/boundary-fuzz'
import { type Quat, rotateVec3Inverse } from '@/sim/math/quat'
import { type Vec3, v3 } from '@/sim/math/vec3'
import { fullStickRate } from '@/sim/rigidbody'

// ── The full-stick rates the vignette is calibrated against ─────────────
//
// Read off the SHEET — 2016's airframes, **never an aircraft variant's view,
// and that is deliberate** (AIRCRAFT-VARIANTS §1.3, DEV-380). The vignette
// measures an ABSOLUTE nauseogenic rate: an acrobat rolling at 118 deg/s should
// close it harder than a standard jet at 86, not by the same fraction of its
// own envelope. A later change that "fixes" these to follow the variant is a
// comfort regression, and `comfort-vignette.test.ts` pins them to the sheet so
// it has to be one on purpose.
//
// `fullStickRate` itself lives in `sim/rigidbody.ts`, beside the integrator
// recurrence it solves; its header says why the `(1 − d·dt)` factor matters.

/** 1.5019 rad/s — **86.0 °/s**. The launch mission's ship. */
export const HOVERJET_FULL_ROLL_RATE = fullStickRate(
  HOVERJET.ship.rollRate,
  HOVERJET.rigidbody.angularDrag,
)

/** 0.4474 rad/s — **25.6 °/s**. A third of the jet's; it needs its own. */
export const JUMPSEAT_FULL_ROLL_RATE = fullStickRate(
  JUMPSEAT.orientation.rollRate,
  JUMPSEAT.rigidbody.angularDrag,
)

/**
 * How much each axis counts toward "how nauseogenic is this right now".
 *
 * **These three are CHOSEN, not measured, and that is the honest statement.**
 * The one thing the corpus settles is the ORDER: §2.9 names roll as the
 * nauseogenic term, and rotation about the view axis is the classic
 * vection-conflict case because the whole retinal field rotates with nothing in
 * it holding still. Yaw is next (it is what a turn feels like, and the neck
 * expects some of it); pitch is least, because the ship pitches constantly in
 * ordinary flight and a vignette that fires on every pull-up is a vignette
 * people switch off.
 *
 * What would change our mind: a headset. §2.9 item 6 puts three external
 * testers on M5a's exit for exactly this reason — nothing in CI can tell you
 * these are wrong.
 */
export const W_ROLL = 1
export const W_YAW = 0.7
export const W_PITCH = 0.5

/**
 * The deadband, as a fraction of the vehicle's full-stick roll rate.
 *
 * Below this the vignette is fully open and draws nothing at all. Ordinary
 * flying — lining up a gate, a lazy bank — must not dim the periphery, or the
 * effect becomes the ambient state of the game rather than a signal, and people
 * stop being able to see it working. 0.2 of full stick is 17.6 °/s on the
 * HoverJet: a deliberate input, not a correction.
 */
export const OPEN_FRACTION = 0.2

/**
 * Attack and release time constants, seconds.
 *
 * Asymmetric ON PURPOSE, and it is the difference between a comfort aid and a
 * strobe. Closing must track the manoeuvre (0.10 s ≈ 8 frames at 72 Hz), but
 * opening must not: a flick-roll-and-centre would otherwise slam the aperture
 * open and shut inside a third of a second, which is its own motion cue and
 * worse than no vignette. 0.45 s out means a sequence of gates reads as one
 * sustained narrowing.
 *
 * Exponential rather than a fixed per-frame lerp, so 72 Hz in a headset and
 * 144 Hz on a desk converge at the same wall-clock rate.
 */
export const ATTACK_TAU = 0.1
export const RELEASE_TAU = 0.45

/**
 * The aperture radii, moved to a leaf so `content/edition-schema.ts` can read
 * `R_CLOSED_STRONG` without importing `three` (S6's bound; see `aperture.ts`).
 * Re-exported here because this is where they have always been read from.
 */
export { FEATHER, R_CLOSED_LIGHT, R_CLOSED_STRONG, R_OPEN } from './aperture'

/**
 * The LINEAR term's deadband and full closure, m/s² of vertical acceleration
 * over one fixed step (DEV-383).
 *
 * The argument above — straight-line speed is comfortable, rotation is not —
 * holds for a jet at a steady speed and fails for an IMPOSED linear
 * acceleration: the jumping spider leaves a pad at up to 200 m/s inside
 * 0.12 s, straight up, and the angular rate reads zero the whole time.
 * AIRCRAFT-VARIANTS §4.5 item 3: the vignette learns vertical acceleration,
 * under the existing setting, with no new menu row.
 *
 * **Chosen on a measurement, not measured to be right.** Per fixed tick over
 * `rookie_01_jumpSeat` and `int_01_jumpSeat` flown by the autopilot, the
 * STANDARD seat's |Δv_y|/dt has a p99 of 50–60 and a p99.9 of 101–119 m/s²,
 * with a handful of single-tick landing stops above that; overclocked's p99.9
 * is 100–106. So 120 opens above everything a seat that climbs does in flight
 * (its landings are one-tick blips the attack time barely registers), and 600
 * closes it fully for any burst of 72 m/s or more. A full spider jump reads
 * about 1,500; a tap (30 m/s) about 250, a quarter closure. A headset, not
 * this paragraph, says whether these are right (the P0 worn row).
 */
export const LINEAR_OPEN = 120
export const LINEAR_FULL = 600

/** Vertical acceleration → 0..1 demand, with the deadband. Either sign: a stop is a spike too. */
export const linearToDemand = (acceleration: number): number => {
  const d = (Math.abs(acceleration) - LINEAR_OPEN) / (LINEAR_FULL - LINEAR_OPEN)
  return d < 0 ? 0 : d > 1 ? 1 : d
}

/** What the vignette needs to know about the ship. Both are `sim` types. */
export interface VignetteInput {
  /** WORLD space, rad/s. `RigidBody.angularVelocity`, straight through. */
  readonly angularVelocity: Readonly<Vec3>
  /** World-from-body. `RigidBody.orientation`. */
  readonly orientation: Readonly<Quat>
  /**
   * m/s², the body's vertical velocity change over the LAST FIXED STEP
   * (`Flight.verticalAcceleration`, DEV-383) — the sim's own tick, never
   * differenced frame to frame, for the reason the angular rate is not.
   * Absent is zero: the HoverJet has no such term.
   */
  readonly verticalAcceleration?: number
}

// Volatile, valid only inside the call that writes it (trap 19: never read one
// a previous call left behind).
const _bodyOmega: Vec3 = v3()

/**
 * The weighted angular rate, rad/s. Pure, three-free, node-testable.
 *
 * Weighted L2 rather than a sum: a pure roll and a pure yaw of the same
 * magnitude should not add up to something larger than either when you do both
 * at once by a hair.
 */
export const nauseogenicRate = (input: VignetteInput): number => {
  rotateVec3Inverse(_bodyOmega, input.orientation as Quat, input.angularVelocity as Vec3)
  const pitch = W_PITCH * _bodyOmega.x
  const yaw = W_YAW * _bodyOmega.y
  const roll = W_ROLL * _bodyOmega.z
  return Math.hypot(roll, yaw, pitch)
}

/** Rate → 0..1 demand, with the deadband. `fullRate` is the vehicle's. */
export const rateToDemand = (rate: number, fullRate: number): number => {
  const open = fullRate * OPEN_FRACTION
  const span = fullRate - open
  if (!(span > 0)) return 0
  const d = (rate - open) / span
  return d < 0 ? 0 : d > 1 ? 1 : d
}

/** One step of the asymmetric exponential. `dt` is a FRAME delta, seconds. */
export const smoothLevel = (current: number, demand: number, dt: number): number => {
  // A backgrounded tab hands back a delta of seconds or minutes; without the
  // clamp the first frame after it snaps the aperture shut.
  const step = dt < 0 ? 0 : dt > 0.25 ? 0.25 : dt
  const tau = demand > current ? ATTACK_TAU : RELEASE_TAU
  const k = 1 - Math.exp(-step / tau)
  return current + (demand - current) * k
}

/** The closed radius this setting asks for. `off` never reaches the shader. */
export const closedRadius = (setting: VignetteSetting): number =>
  setting === 'strong' ? R_CLOSED_STRONG : R_CLOSED_LIGHT

/** Aperture radius in UV units for a smoothed level. `R_OPEN` at rest. */
export const apertureRadius = (setting: VignetteSetting, level: number): number => {
  if (setting === 'off') return R_OPEN
  const l = level < 0 ? 0 : level > 1 ? 1 : level
  return R_OPEN + (closedRadius(setting) - R_OPEN) * l
}

// ── The pass ──────────────────────────────────────────────────────────────
//
// `gl_Position` is written in CLIP SPACE directly, with no camera matrices
// anywhere. That is the whole trick, and it is why this is the right shape for
// the screen fade as well:
//
//  - It fills whatever VIEWPORT is being drawn. In an XR frame three renders the
//    scene once per sub-camera with `gl.viewport` set to that eye, so each eye
//    gets its own correctly-centred copy for free.
//  - It has NO Z, so it cannot clip against the near plane. PORT_PLAN §2.1 found
//    a real bug in revision 1 — the screen fade specified as a head-locked quad
//    at z = 0.11 against a 0.1 near plane, *"1 cm of margin, in stereo, with
//    per-eye off-axis projection"* — and gave two fixes: move the quad to
//    z ≥ 0.25, or *"implement the fade as a full-screen material pass rather
//    than a head-locked quad."* This is the second one, which also disposes of
//    the per-eye parallax a head-locked quad has at any z: a quad 0.3 m from the
//    eye sits 6° off centre for each eye, so its vignette would be visibly
//    lopsided and stereoscopically wrong at the periphery.
//
// The mesh therefore lives in the SCENE, not under the camera, and its transform
// is meaningless — hence `frustumCulled = false`, which is not an optimisation
// but a correctness requirement: a bounding sphere at the origin would cull the
// overlay the moment you flew a kilometre away.
const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// ── S6's pulse rides here (DEV-108) ───────────────────────────────────────
//
// One extra term in the same pass, for the three reasons `render/gate-pulse.ts`
// sets out: per-eye correct for free, outside the bloom and outside ACES
// (`toneMapped: false` is the predicate `bloom.ts` classifies this quad on), and
// composited UNDER the black so a death cannot be lit up by the last gate.
//
// `uPulse` (a vec4) carries level, inner radius, wedge count and wedge depth;
// `uPulseB` (a vec2) carries the feather and the phase. Packed rather than left
// as six separate floats because a set of values that is always written
// together is a set that cannot be written half-way.
// ── DEV-127's static rides here too ──────────────────────────────────────
//
// The out-of-bounds countdown as signal loss: a third term, between the pulse
// and the black. `uFuzz` (a vec4) carries level, clear radius, feather and
// grain; `uFuzzSeed` is the frame of the grain, at `FUZZ_HZ` rather than the
// display rate (`render/boundary-fuzz.ts` says why). Packed for the same
// reason the pulse is: a set of values always written together cannot be
// written half-way.
const FRAGMENT = /* glsl */ `
uniform float uRadius;
uniform float uFeather;
uniform float uFade;
uniform vec3 uColor;
uniform vec4 uPulse;
uniform vec2 uPulseB;
uniform vec3 uPulseColor;
uniform vec4 uWhiteout;   // rgb the colour, a the level (DEV-277)
uniform vec4 uFuzz;
uniform float uFuzzSeed;
varying vec2 vUv;

// A 2D hash that survives mediump: no sin(), so it does not band on a mobile
// GPU the way the classic fract(sin(dot())) does. Inputs are small integers
// (a cell index and a wrapped frame counter), which is what keeps it exact.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec2 d = vUv - 0.5;
  float r = length(d);
  float ring = smoothstep(uRadius, uRadius + uFeather, r);
  // MAX, not add: a full fade must be opaque everywhere, and a vignette under a
  // half fade must not double up into a black centre.
  float black = max(ring, uFade);

  float pulse = 0.0;
  if (uPulse.x > 0.0) {
    // The band. Zero inside uPulse.y, full at one feather past it, so the
    // centre of the frame is untouched however hard the pulse is driven.
    float band = smoothstep(uPulse.y, uPulse.y + uPulseB.x, r);
    // The streaks: wedges around the ring, turned by the phase so consecutive
    // gates do not stamp the same pattern. 0.5 + 0.5 cos is the smooth wedge;
    // uPulse.w is how deep it cuts, so 0 leaves a plain band.
    float theta = atan(d.y, d.x);
    float wedge = 0.5 + 0.5 * cos(theta * uPulse.z + uPulseB.y);
    pulse = uPulse.x * band * mix(1.0, wedge, uPulse.w);
  }

  float fuzz = 0.0;
  float grey = 0.0;
  if (uFuzz.x > 0.0) {
    // The static comes in from the corners: zero inside the clear radius, full
    // one feather past it. The clear radius closes on the centre with the
    // countdown, so the middle of the frame is the LAST place it reaches.
    float band = smoothstep(uFuzz.y, uFuzz.y + uFuzz.z, r);
    // One random grey per cell per grain frame. The seed is added to the cell
    // so a new frame is a new pattern rather than the old one shifted.
    vec2 cell = floor(vUv / uFuzz.w);
    grey = hash21(cell + uFuzzSeed);
    fuzz = uFuzz.x * band;
  }

  // Source-over, bottom to top: the pulse, then the static, then the black —
  // collapsed into the one RGBA this pass may write. Ordering is the whole
  // point: a warning covers a flourish, and black covers everything, each by
  // exactly the amount it covers.
  vec3 c = uPulseColor * pulse;
  float a = pulse;
  c = vec3(grey) * fuzz + c * (1.0 - fuzz);
  a = fuzz + a * (1.0 - fuzz);
  c = uColor * black + c * (1.0 - black);
  a = black + a * (1.0 - black);

  // The cloud whiteout composites LAST, over the black (DEV-277). Everything
  // above this line is something drawn ON the world -- a flourish, a warning, a
  // tunnel. This is the world being REPLACED: you are inside an opaque body and
  // there is nothing to see past it, so it covers the comfort tunnel too rather
  // than being covered by it.
  c = uWhiteout.rgb * uWhiteout.a + c * (1.0 - uWhiteout.a);
  a = uWhiteout.a + a * (1.0 - uWhiteout.a);
  if (a <= 0.002) discard;
  gl_FragColor = vec4(c / a, a);
}
`

export interface Vignette {
  readonly object: THREE.Object3D
  /**
   * Advance one RENDER frame. `dtSeconds` is the frame delta, not the fixed
   * step — the aperture is a visual filter and the eye lives in frame time.
   *
   * **`null` means "there is nothing to measure", and it RELEASES.** Pass it on
   * the title screen and in the hangar, where there is no ship — and, less
   * obviously, **while the game is paused**. Pausing freezes the sim, so
   * `angularVelocity` keeps whatever value it had; a run paused mid-roll would
   * otherwise leave you reading the comfort menu down a closed tunnel, which is
   * a funny bug exactly once. `app.ts` already zeroes the stick on the same
   * frames (`actions = noActions()`), and this is the same gesture.
   */
  update(input: VignetteInput | null, dtSeconds: number): void
  /** Change the setting. Retracts smoothly rather than snapping when set off. */
  setSetting(setting: VignetteSetting): void
  /** Which vehicle's envelope to calibrate against. See `*_FULL_ROLL_RATE`. */
  setFullRate(rate: number): void
  /**
   * 0..1 black over everything, on the same draw call.
   *
   * Unwired as of this session: nothing in `app.ts` fades yet. It is here
   * because the pass that cannot clip is the one that should own the fade when
   * respawn, camera change and level transition get theirs (2016 fades 1.0 s on
   * all three), and because building a second full-screen quad later to do it
   * would be the exact mistake §2.1 caught.
   */
  setFade(amount: number): void
  /**
   * S6's gate pulse, on the same draw call (DEV-108).
   *
   * `null` clears it — and clearing is what the title screen, the hangar and
   * Classic all pass, so a preset with the feature off costs one uniform write
   * and no pixels. `render/gate-pulse.ts` owns the schedule; this owns only the
   * band's geometry and its colour.
   */
  setPulse(pulse: PulseFrame | null): void
  /**
   * The cloud whiteout, 0-1. DEV-277.
   *
   * Rides this pass because `render/gate-pulse.ts` already established that the
   * vignette owns the ONLY full-screen quad in the game, and a second one for a
   * flat fill would be a second full-screen draw on a frame that is 75 % fill.
   * It composites over the comfort tunnel rather than under it -- see the
   * shader -- because being inside a cloud is the world being replaced, not
   * something drawn on it.
   */
  setWhiteout(level: number): void
  /**
   * DEV-127's out-of-bounds static, on the same draw call, under the black
   * and over the pulse. `null` clears it — Classic, the title, the hangar and
   * every frame in bounds all pass it, so a run inside the world costs one
   * uniform write. `render/boundary-fuzz.ts` owns the numbers; this owns the
   * grain and the compositing.
   */
  setFuzz(fuzz: FuzzFrame | null): void
  /** The smoothed 0..1 closure. Read for telemetry and by the tests. */
  readonly level: number
  /** The static's live 0..1 edge alpha. 0 means none is drawn. For the tests and the dev handle. */
  readonly fuzzLevel: number
  dispose(): void
}

/** One frame of S6's pulse, as the shader wants it. All of it is per-frame. */
export interface PulseFrame {
  /** 0..1 overlay alpha at the outermost pixel, already speed- and slider-scaled. */
  readonly level: number
  /** UV radius the band starts at. At or outside `R_CLOSED_STRONG` — see `aperture.ts`. */
  readonly innerRadius: number
  /** UV width of the band's soft inner edge. */
  readonly feather: number
  /** Wedges around the ring. */
  readonly streaks: number
  /** 0-1, how deep the wedges cut. */
  readonly streakDepth: number
  /** Radians. Turns per pass so consecutive gates differ. */
  readonly phase: number
  /** LINEAR RGB. The ring's own glow, blended toward white by the preset's `tint`. */
  readonly color: THREE.Color
}

export interface VignetteOptions {
  readonly setting?: VignetteSetting
  /** Defaults to the HoverJet's, which is what the launch mission flies. */
  readonly fullRate?: number
}

export const createVignette = (options: VignetteOptions = {}): Vignette => {
  let setting: VignetteSetting = options.setting ?? 'light'
  let fullRate = options.fullRate ?? HOVERJET_FULL_ROLL_RATE
  let level = 0
  let fade = 0

  const uniforms = {
    uRadius: { value: R_OPEN },
    uFeather: { value: FEATHER },
    uFade: { value: 0 },
    uColor: { value: new THREE.Color(0, 0, 0) },
    // level, innerRadius, streaks, streakDepth
    uPulse: { value: new THREE.Vector4(0, R_CLOSED_STRONG, 1, 0) },
    // feather, phase
    uPulseB: { value: new THREE.Vector2(FEATHER, 0) },
    uPulseColor: { value: new THREE.Color(1, 1, 1) },
    uWhiteout: { value: new THREE.Vector4(1, 1, 1, 0) },
    // level, clearRadius, feather, grain. Level 0 is "draw none".
    uFuzz: { value: new THREE.Vector4(0, R_OPEN, FEATHER, 1) },
    uFuzzSeed: { value: 0 },
  }

  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // The quad is written straight into clip space, so which way it "faces" is
    // not a question the winding can answer usefully. Draw it either way.
    side: THREE.DoubleSide,
    // Not tone-mapped (DEV-081). Belt and braces: three only injects
    // `<tonemapping_fragment>` into its OWN materials, so a hand-written
    // `ShaderMaterial` is already outside the curve — but this flag is what
    // `render/tone.ts`'s rule is stated in, and a comfort overlay that darkens
    // the frame is the clearest case of "modifies the frame rather than being
    // in the world". Leaving it at the default would mean the exemption
    // depended on an implementation detail of three rather than on a decision.
    toneMapped: false,
  })

  // Positions are already ±1: the vertex shader passes `position.xy` through as
  // NDC untouched, so the geometry IS the viewport.
  const geometry = new THREE.PlaneGeometry(2, 2)
  const object = new THREE.Mesh(geometry, material)
  object.name = 'comfort-vignette'
  object.frustumCulled = false
  // Above every panel in the game (the pause plate is 12, the results panel 11).
  // This is the last thing drawn, because it is the thing between you and all of
  // it.
  object.renderOrder = 10_000
  object.visible = false

  const refresh = () => {
    uniforms.uRadius.value = apertureRadius(setting, level)
    uniforms.uFade.value = fade
    // Fully open and not fading is not a cheap draw, it is NO draw. At rest this
    // costs nothing, which is what makes it acceptable on a Quest. The pulse is
    // the third way for this quad to have something to say, and it is the one
    // that is usually silent — so it is an OR, not a replacement.
    object.visible =
      fade > 0 ||
      uniforms.uPulse.value.x > 0.002 ||
      uniforms.uFuzz.value.x > 0.002 ||
      // The FOURTH way, and the comment above predicted it. DEV-277 set the
      // whiteout uniform correctly, the containment test was right and the
      // envelope was right, and nothing appeared -- because the quad that draws
      // it is hidden unless something in THIS list says otherwise. A new layer
      // is not wired until it is in this OR.
      uniforms.uWhiteout.value.w > 0.002 ||
      (setting !== 'off' && level > 0.002)
  }

  return {
    object,
    get level() {
      return level
    },
    update(input, dtSeconds) {
      // `off` and `null` both release rather than snapping: the aperture
      // retracts over RELEASE_TAU, so turning it off mid-roll — or pausing
      // mid-roll — is not itself a motion cue.
      // The larger of the two terms (DEV-383): a vertical launch closes it as a
      // roll does, and one never adds to the other.
      const demand =
        setting === 'off' || input === null
          ? 0
          : Math.max(
              rateToDemand(nauseogenicRate(input), fullRate),
              linearToDemand(input.verticalAcceleration ?? 0),
            )
      level = smoothLevel(level, demand, dtSeconds)
      refresh()
    },
    setSetting(next) {
      setting = next
      refresh()
    },
    setFullRate(rate) {
      if (rate > 0) fullRate = rate
    },
    setFade(amount) {
      fade = amount < 0 ? 0 : amount > 1 ? 1 : amount
      refresh()
    },
    setWhiteout(level) {
      const w = uniforms.uWhiteout.value
      const next = level > 1 ? 1 : level > 0 ? level : 0
      if (w.w === next) return
      w.w = next
      refresh()
    },
    setPulse(pulse) {
      const p = uniforms.uPulse.value
      if (!pulse || !(pulse.level > 0.002)) {
        // Zero the LEVEL only. Leaving the geometry alone means a pulse that
        // fires on the very next frame draws the band it was authored with
        // rather than the default one, and nothing reads the other three while
        // the level is zero anyway.
        p.x = 0
        refresh()
        return
      }
      p.set(
        pulse.level > 1 ? 1 : pulse.level,
        // Clamped to the comfort layer's own floor rather than trusted: the
        // loader already refuses a preset below it, but this is the last place
        // the number can be wrong before it is a pixel, and the failure it
        // guards against — a flash in the centre of the frame — is one R7 calls
        // a nausea trigger rather than a visual defect.
        Math.max(pulse.innerRadius, R_CLOSED_STRONG),
        pulse.streaks,
        pulse.streakDepth < 0 ? 0 : pulse.streakDepth > 1 ? 1 : pulse.streakDepth,
      )
      uniforms.uPulseB.value.set(pulse.feather, pulse.phase)
      uniforms.uPulseColor.value.copy(pulse.color)
      refresh()
    },
    get fuzzLevel() {
      return uniforms.uFuzz.value.x
    },
    setFuzz(fuzz) {
      const f = uniforms.uFuzz.value
      if (!fuzz || !(fuzz.level > 0.002)) {
        // The level only, as `setPulse` does: nothing reads the other three
        // while it is zero, and the next frame writes all four anyway.
        f.x = 0
        refresh()
        return
      }
      f.set(
        fuzz.level > 1 ? 1 : fuzz.level,
        fuzz.clearRadius < 0 ? 0 : fuzz.clearRadius,
        fuzz.feather,
        // A grain of zero is a division by zero in the shader; the driver's
        // constant is positive, and this is the last place it can be wrong.
        fuzz.grain > 0 ? fuzz.grain : 1,
      )
      uniforms.uFuzzSeed.value = fuzz.seed
      refresh()
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
