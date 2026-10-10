// src/render/flat-fov.ts — a wider lens with speed, on the FLAT build only.
//
// ── What 2016 had: a script that never ran ────────────────────────────────
//
// `Assets/Faceted Flight/Scripts/Boost_FOV.cs` lerps `Camera.fieldOfView`
// toward `maxFOV` at `speed` and back to the initial FOV at `speed * 0.8`. It is
// the intent of this feature, written down in 2015, and **it never shipped
// running**. Proved, not assumed:
//
//   · its guid `61d3a179f37ff424996da53f65441764` appears in exactly ONE text
//     file in the whole Unity project — `Boost_FOV.cs.meta`, where the guid is
//     DEFINED. No prefab, no scene, no `.asset` references it, so no
//     GameObject ever carried the component;
//   · `increaseFOV` and `decreaseFOV` are set nowhere outside the script's own
//     two branches, so even attached it would have sat at the initial FOV;
//   · every other `.cs` write to `fieldOfView` in the project is vendor code —
//     Marmoset's `FreeProbe`, OVR's cubemap capture, Standard Assets'
//     `TargetFieldOfView` / `FOVKick` / water / post, SteamVR's editor and
//     utils. First-party Faceted Flight code touches FOV nowhere else.
//
// So this is **FF2's own feature with a 2016 script as its brief**, which is
// exactly why it is Anniversary-only and has a DEV row (DEV-093). Hard rule 2
// applies to the script twice over: its `public float speed / minFOV / maxFOV`
// are field initialisers, and a field initialiser is not shipped behaviour even
// when the component ships — which this one did not. **Not one number below
// comes from that file.** What comes from it is the SHAPE: open with speed,
// close more slowly than you opened. Its own ratio is 1.25 (`t` grows at
// `speed` on the way out and `speed * 0.8` on the way back).
//
// ── Never in VR, and three is the reason it is cheap to promise ──────────
//
// research 05 §R7 is categorical: *"Never write `camera.fov` while
// presenting."* Changing the projection while the compositor is assuming its
// own lens distortion warps the periphery and is a direct nausea trigger. The
// structural reason this file can keep that promise without care is that in
// session three does not read `camera.fov` at all — `WebGLRenderer.render`
// swaps the passed camera for `xr.getCamera()` (`three.module.js:17637`) and
// the projection comes from the `XRView`.
//
// And the thing that makes the guard worth having in BOTH directions:
// `WebXRManager.updateCamera` writes `camera.fov` ITSELF, every XR frame, back-
// derived from the headset's projection matrix —
//
//     camera.fov = RAD2DEG * 2 * Math.atan( 1 / camera.projectionMatrix.elements[ 5 ] )
//                                                   — three.module.js:14676
//
// — so a session leaves the FLAT camera wearing the HEADSET's vertical FOV
// (~90-100° on a Quest, against the renderer's 70). That is a pre-existing wart
// of the port, it predates this feature, and `restoreBase()` on `sessionend`
// fixes it for free. It is also why `update()` returns before it reads anything
// while presenting: there is nothing to win and a rule to keep.
//
// ── Driven by AIRSPEED, not by a boost stage, and that is deliberate ─────
//
// `Boost_FOV` was named for the boost, and a boost stage would be the literal
// port. This takes `forwardSpeedOf(flight)` instead — the same
// `Ship_HoverShip.ForwardSpeed` the particles, the wind and the shake are all
// keyed on — because **a boost IS a speed rise**: the curve captures the boost
// without a second signal to keep in step, and it also captures the speed
// chain, a dive, and a tailwind down a valley, all of which are the lens
// opening for the same reason. One quantity, one curve, and nothing in
// `game/flight.ts` had to change to read it.
//
// ── Every number is in the preset ────────────────────────────────────────
//
// Hard rule 6 and ANNIVERSARY.md §0.2. `content/editions/*.json`
// `render.flatFov` holds the curve and the two time constants; the only
// literals here are the hard bounds of a usable perspective projection, which
// are not tuning.

import type * as THREE from 'three'
import { sampleCurve } from '@/audio/speed-curves'
import type { EditionFlatFov } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'

/**
 * The bounds of a projection, not a taste.
 *
 * `PerspectiveCamera.updateProjectionMatrix` takes `tan(fov/2)`, so 180 is a
 * divide by zero and 0 is a zero-width frustum. These are the rails a preset
 * typo hits instead of a NaN projection matrix, which renders an empty frame
 * with nothing in the console. `validateEdition` refuses a `base` outside a much
 * narrower band; these catch the CURVE, whose top is a delta and is checked by
 * nobody.
 */
const MIN_FOV = 1
const MAX_FOV = 175

const clampFov = (deg: number): number =>
  !Number.isFinite(deg) ? MIN_FOV : deg < MIN_FOV ? MIN_FOV : deg > MAX_FOV ? MAX_FOV : deg

/**
 * Degrees inside which the ease is declared finished and SNAPPED to the target.
 *
 * It has to exist: exponential decay never reaches its target, so without a
 * snap the last 0.001° would rebuild the projection matrix every frame for the
 * rest of the session and `camera.fov` would never be exactly the base again —
 * which is the one thing the Classic and the never-in-VR tests assert. 0.01° of
 * a 70° lens is one part in 7,000, about a quarter of a pixel at the edge of a
 * 1080-tall frame.
 */
export const FOV_SNAP_DEGREES = 0.01

/**
 * The lens this preset rests at, in degrees of VERTICAL field of view.
 *
 * `base: null` means "whatever the renderer built the camera with", which is
 * `render/renderer.ts`'s 70 (≈102° horizontal at 16:9) in both presets today.
 * ANNIVERSARY.md §1.5 item 8 argues for 55-60° on a monitor — wide lenses
 * minify the middle distance, so a narrower one would make the world *feel*
 * larger at some cost to the sense of speed — and that is one number, Matt's,
 * and every A/B frame ever taken would change with it. So the key exists, the
 * lookdev panel has a live slider on it, and it ships `null`. DEV-093.
 */
export const baseFovFor = (block: EditionFlatFov, rendererFov: number): number =>
  clampFov(block.base ?? rendererFov)

/**
 * The lens this AIRSPEED asks for. Pure, total, and monotonic in `airspeed` for
 * any curve whose y ascends.
 *
 * `sampleCurve` is imported from `audio/speed-curves.ts` rather than reimplemented
 * — it is the ONE evaluator for the `Breakpoints` shape the schema declares, and
 * two evaluators of one contract is the trap DEVIATIONS' *"a test that compares
 * two of your own devices has not tested either"* is about. It is a pure
 * function of two arguments and knows nothing about Web Audio; the layering
 * smell is real and it is the smaller of the two problems.
 *
 * Flat outside the curve's ends, which is the safety property that matters here:
 * a ship that somehow reaches 500 m/s gets the top breakpoint's value rather
 * than an extrapolated 30° of extra lens.
 */
export const fovFor = (block: EditionFlatFov, airspeed: number, baseFov: number): number => {
  if (!block.enabled) return clampFov(baseFov)
  return clampFov(baseFov + sampleCurve(block.addBySpeed, airspeed))
}

/**
 * One step of the ease, frame-rate independent.
 *
 * `tau` is a TIME CONSTANT, not a duration: after `tau` seconds the remaining
 * gap is down by 1/e (63% of the way there), after 3·tau it is 95% closed.
 * `1 - exp(-dt/tau)` rather than a fixed per-frame lerp factor, because a fixed
 * factor makes the effect twice as fast on a 144 Hz monitor as on a 72 Hz one —
 * which is how a tuned feel becomes a per-machine feel.
 *
 * A non-positive `dt` or `tau` snaps. The schema forbids a non-positive `tau`;
 * `dt` is a real frame delta and the first frame of the session can be anything.
 */
const easeToward = (current: number, target: number, tau: number, dt: number): number => {
  if (!(dt > 0) || !(tau > 0)) return target
  return current + (target - current) * (1 - Math.exp(-dt / tau))
}

/**
 * The tuning keys `?lookdev=1` may replace live. Not `base`, which has its own
 * setter because it is the only one that takes effect without a speed.
 */
export type FlatFovPatch = Partial<
  Pick<EditionFlatFov, 'addBySpeed' | 'attackSeconds' | 'releaseSeconds'>
>

export interface FlatFov {
  /** The lens it rests at. `render.flatFov.base`, or the renderer's own. */
  readonly base: number
  /** What the camera is wearing, as this module last wrote it. Degrees. */
  readonly current: number
  /** Where it is easing to, as of the last `update`. Degrees. */
  readonly target: number
  /** The block in force: the live preset's, with any lookdev patch folded in. */
  readonly block: EditionFlatFov
  /**
   * One frame.
   *
   * `airspeed` is `ForwardSpeed` in m/s. `active` is the caller's answer to "is
   * this a live run seen from the cockpit" — false in the hangar, false while
   * the pause plate is up, false for the elevator ride, and false on every
   * camera that is not the cockpit's (`?view=chase` and `?view=cam` are
   * photography tools, and a lens that breathes under a fixed camera would make
   * two screenshots of one viewpoint different screenshots). `dt` is RENDER
   * seconds, deliberately unclamped: a tab that was hidden for ten seconds
   * should come back at the settled lens, not a tenth of the way into an ease.
   *
   * `override`, when not null, is DEGREES another camera model wants added to
   * the base this frame — the third-person arm's speed term (DEV-128,
   * `render/spring-arm.ts`'s `fovAddFor`). It wins over `active` and over the
   * preset's own curve, and it still eases at this block's rates, so this
   * stays the ONLY writer of `camera.fov` in the app and the never-in-VR rule
   * is kept in one place for both cameras.
   */
  update(airspeed: number, active: boolean, dt: number, override?: number | null): void
  /**
   * A one-shot push of the lens, DEV-636's `feel.fovKick`: `deg` degrees wider at
   * once (added after the speed ease, so a 0.15 s shove is not smeared away by
   * its 0.2 s attack), falling linearly back to nothing over `seconds`. A new kick replaces a weaker one
   * still running and never a stronger one. Flat only: ignored while an XR
   * session is presenting (research 05 section R7), and it is discarded by a
   * session start. The CALLER scales `deg` by the Speed FX slider; this module
   * has no slider.
   */
  kick(deg: number, seconds: number): void
  /**
   * DEV-640: a SUSTAINED push of the lens, `deg` degrees wider for as long as it is
   * asked (the boost lit), eased in at the block's attack and out at its release
   * and added after the speed ease, beside the kick. Flat only: ignored while an
   * XR session is presenting, and held at nothing off a live cockpit or chase
   * frame. 0 releases it. The CALLER scales `deg` by the Speed FX slider.
   */
  push(deg: number): void
  /** The lookdev base slider. Snaps, because a slider that lags is a slider that lies. */
  setBase(deg: number): void
  /**
   * Lookdev only: replace tuning without touching the preset.
   *
   * Discarded on a preset flip, along with `base` — the same behaviour
   * `buildLookdev`'s header documents for the tone and haze knobs, and the
   * reason the panel's Copy settings button exists: the panel's job is to end
   * with a number for the JSON, not to become a second source of truth.
   */
  tune(patch: FlatFovPatch): void
  dispose(): void
}

/**
 * Wire the camera to the live preset.
 *
 * The renderer's own FOV is read ONCE, here, before anything has written it —
 * so `base: null` means the number in `render/renderer.ts` and keeps meaning it
 * if that number ever moves. Nothing else in the app writes `camera.fov`: the
 * resize handler (`renderer.ts:102-119`) sets `aspect` and calls
 * `updateProjectionMatrix`, which PRESERVES whatever fov is there, and
 * `tests/unit/flat-fov.test.ts` reads that file to keep it that way.
 */
export const createFlatFov = (
  editionState: EditionState,
  camera: THREE.PerspectiveCamera,
  renderer: Pick<THREE.WebGLRenderer, 'xr'>,
): FlatFov => {
  const rendererFov = camera.fov
  let base = baseFovFor(editionState.current.render.flatFov, rendererFov)
  let current = camera.fov
  let target = base
  /** DEV-636: the kick in flight. `kickLeft` counts down to 0 over `kickTotal`. */
  let kickDeg = 0
  let kickLeft = 0
  let kickTotal = 0
  /** DEV-640: the sustained push asked for, and what the lens is wearing of it. */
  let pushWanted = 0
  let pushNow = 0
  /**
   * The lookdev patch, folded into a whole block once per `tune` rather than
   * merged on every frame — `update` runs at the display rate and an object
   * literal per frame is an allocation nobody asked for. `null` is the common
   * case: no panel, or a panel nobody has dragged.
   */
  let patched: EditionFlatFov | null = null
  const blockNow = (): EditionFlatFov => patched ?? editionState.current.render.flatFov

  /** Put the base on the camera now, and stop easing. */
  const restoreBase = (): void => {
    current = base
    target = base
    kickDeg = 0
    kickLeft = 0
    kickTotal = 0
    pushWanted = 0
    pushNow = 0
    if (camera.fov !== base) {
      camera.fov = base
      camera.updateProjectionMatrix()
    }
  }

  // A preset that overrides `base` takes effect at boot rather than on the
  // first frame, so the very first photograph of the flat build is already the
  // lens the preset asked for.
  restoreBase()

  /**
   * Both ends of a session, and the same call.
   *
   * On `sessionstart` because the feature must leave nothing of its own on a
   * camera the compositor is about to drive (§R7's rule, kept literally even
   * though three overwrites `fov` on its next `updateCamera` anyway). On
   * `sessionend` because by then three HAS overwritten it, with the headset's
   * back-derived vertical FOV — so without this, taking the headset off leaves
   * the flat build on a ~96° lens (`three.module.js:14676`).
   */
  const onSession = (): void => {
    restoreBase()
  }
  const xr = renderer.xr as unknown as {
    addEventListener?: (type: string, fn: () => void) => void
    removeEventListener?: (type: string, fn: () => void) => void
  }
  xr.addEventListener?.('sessionstart', onSession)
  xr.addEventListener?.('sessionend', onSession)

  // A flip re-resolves the base and lands it immediately: `base` is content, not
  // a signal, and easing between two presets' idea of "the resting lens" would
  // make the flip itself look like an effect. It also drops any lookdev patch,
  // so the panel cannot leave one preset's numbers on the other one.
  const unsubscribe = editionState.subscribe((edition) => {
    patched = null
    base = baseFovFor(edition.render.flatFov, rendererFov)
    restoreBase()
  })

  return {
    get base() {
      return base
    },
    get current() {
      return current
    },
    get target() {
      return target
    },
    get block() {
      return blockNow()
    },
    update(airspeed, active, dt, override = null) {
      // ── the one rule of this file ────────────────────────────────────────
      //
      // Before any read, and before any arithmetic. In session three owns the
      // projection and writes `camera.fov` itself every frame; §R7 says do not
      // fight it, and there is nothing here worth fighting for.
      if (renderer.xr.isPresenting) return

      const block = blockNow()
      // `active` first: Classic reaching `fovFor` would get the base back
      // anyway (the flag is checked there too), and this way the hot path on
      // the preset nobody is tuning is one boolean. An `override` is another
      // camera's answer and bypasses both — see the interface.
      target =
        override !== null
          ? clampFov(base + override)
          : active
            ? fovFor(block, airspeed, base)
            : base
      // DEV-636: a kick rides on whatever the lens is asking for, and only on a
      // live cockpit or chase frame (`override` or `active`), so a photography
      // viewpoint stays a fixed lens.
      // The kick is added AFTER the ease, not folded into the target: the speed
      // ease has a 0.2 s attack and a 0.15 s shove would never show through it.
      let kickNow = 0
      if (kickLeft > 0) {
        kickLeft = dt > 0 ? Math.max(0, kickLeft - dt) : 0
        if (override !== null || active) kickNow = kickDeg * (kickLeft / kickTotal)
      }

      // Asymmetric, and the direction is the 2016 script's: open at `attack`,
      // close at `release`. Which one applies is decided by where the target
      // is relative to where the lens IS, not by `active` — so lifting off
      // mid-ease keeps closing at the closing rate rather than switching
      // halfway.
      const tau = target > current ? block.attackSeconds : block.releaseSeconds
      let next = easeToward(current, target, tau, dt)
      if (Math.abs(next - target) < FOV_SNAP_DEGREES) next = target
      current = next
      // `!==` and not an epsilon: the snap above makes the settled value
      // EXACTLY the target, so this terminates and a resting camera rebuilds no
      // projection matrix. An epsilon here would leave a permanent sliver of
      // error and the Classic test would have to be approximate.
      // DEV-640: the boost push, eased on its own and added with the kick. Held
      // at nothing off a live frame, so a photography viewpoint stays a fixed lens.
      const pushTarget = override !== null || active ? pushWanted : 0
      pushNow = easeToward(
        pushNow,
        pushTarget,
        pushTarget > pushNow ? block.attackSeconds : block.releaseSeconds,
        dt,
      )
      if (Math.abs(pushNow - pushTarget) < FOV_SNAP_DEGREES) pushNow = pushTarget
      const extra = kickNow + pushNow
      const shown = extra > 0 ? clampFov(next + extra) : next
      if (camera.fov !== shown) {
        camera.fov = shown
        camera.updateProjectionMatrix()
      }
    },
    kick(deg, seconds) {
      if (renderer.xr.isPresenting) return
      if (!(deg > 0) || !(seconds > 0)) return
      // A weaker kick does not cut a stronger one short.
      if (kickLeft > 0 && deg < kickDeg * (kickLeft / kickTotal)) return
      kickDeg = deg
      kickLeft = seconds
      kickTotal = seconds
    },
    push(deg) {
      pushWanted = renderer.xr.isPresenting || !(deg > 0) ? 0 : deg
    },
    setBase(deg) {
      base = clampFov(deg)
      restoreBase()
    },
    tune(patch) {
      patched = { ...blockNow(), ...patch }
    },
    dispose() {
      unsubscribe()
      xr.removeEventListener?.('sessionstart', onSession)
      xr.removeEventListener?.('sessionend', onSession)
      restoreBase()
    },
  }
}
