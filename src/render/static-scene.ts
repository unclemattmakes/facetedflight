/**
 * render/static-scene.ts: three stops recomputing what never moves. DEV-937.
 *
 * Matt, 2026-10-13: *"make everything that should be static, static. The only
 * movers are the ships, the ocean, dolphins, and sailboats, and elevator lift.
 * The lift can be frozen after countdown."*
 *
 * ── What it buys ─────────────────────────────────────────────────────────
 *
 * Every `renderer.render` walks the scene in `updateMatrixWorld`, and for each
 * object with `matrixAutoUpdate` on it composes the local matrix from
 * position, quaternion and scale and multiplies it into the world matrix. A
 * mission holds about 444 objects; 15 of them moved in a minute of flight.
 * Measured flat on `int_02_hoverJet` (`ANNIVERSARY-VR-FRAMERATE.md` section
 * 3.7): 1.04 s of a 20 s profile in those two functions, 0.80 s of it in the
 * render's own walk. An object with `matrixAutoUpdate` off and no
 * `matrixWorldNeedsUpdate` is skipped (no compose, no multiply) unless an
 * ancestor moved, in which case only its world matrix is rebuilt from the
 * local one it keeps. That includes the scene root: left on auto-update it
 * would mark every object below it for a rebuild every frame. So freezing is right for every object whose LOCAL
 * transform never changes, including the fixed parts inside a moving ship.
 *
 * ── The rules ────────────────────────────────────────────────────────────
 *
 * Only the subtrees under {@link StaticRules.roots} are swept, so anything
 * nobody listed (the ocean, the sky dome, the horizon band, the XR rig, life,
 * particles, FF-TV) keeps three's default and cannot be broken by this file.
 * Inside a root, an object matching {@link StaticRules.movers} keeps its own
 * transform live but its children are still swept (the ship's lean pivot
 * moves; the cockpit inside it does not), and a subtree matching
 * {@link StaticRules.dynamicSubtrees} is never touched (prop fragments fly).
 * {@link StaticRules.lift} objects are still only while the race is live: the
 * launch elevator's platform and the AI start pads rise during the ride and
 * the countdown, and a restart runs them again.
 *
 * ── Why a frozen object cannot silently stick ────────────────────────────
 *
 * The cost of a wrong freeze is a thing that should move and does not, with no
 * error anywhere. So every frame a few frozen objects are checked: if their
 * position, quaternion and scale no longer compose to the matrix they were
 * frozen with, somebody moved them, and they are handed back to three
 * (`matrixAutoUpdate` on again), named in {@link StaticScene.report}, and
 * warned about once. `tests/e2e/static-scene.spec.ts` flies whole missions and
 * fails on any such hand-back, which is how a new mover gets added to the
 * rules rather than discovered by a player.
 */
import * as THREE from 'three'

type NameRule = string | RegExp

export interface StaticRules {
  /** Direct children of the scene, by name, whose subtrees are swept. */
  readonly roots: readonly string[]
  /** Objects that keep their own transform live. Their children are still swept. */
  readonly movers: readonly NameRule[]
  /** Subtrees left entirely alone. */
  readonly dynamicSubtrees: readonly NameRule[]
  /** Objects frozen only while the race is live (`tick(true)`). */
  readonly lift: readonly NameRule[]
}

/**
 * The mission scene's rules. Every mover here was SEEN moving: a census of the
 * local matrix of every object, sampled every 2 s from the pad through the
 * ride, the countdown and 80 s of race on `int_01_hoverJet`,
 * `adv_01_hoverJet` and `rookie_01_jumpSeat` (DEV-937).
 */
export const MISSION_STATIC_RULES: StaticRules = {
  roots: [
    'world-terrain',
    'launch-anchor',
    'start-grid',
    'rings',
    'pads',
    'turn-indicators',
    'hoverjet',
    'jumpseat',
    'racers',
    'player-ghost',
    // Never moved in the census, and each composed its matrix every walk: the
    // particle fields (the GPU engine moves particles in the shader, not the
    // mesh), the full-screen tint and vignette, and the sky's light probe.
    'particle-fx',
    'scene-tint',
    'comfort-vignette',
    'skyshop-ibl',
  ],
  movers: [
    // The ships themselves, and the parts of them that move.
    'hoverjet',
    'jumpseat',
    /^racer:/,
    /^ghost:/,
    'art_pivot',
    'next-gate-arrow',
    'jumpseat_legs',
    /^leg_\d/,
  ],
  dynamicSubtrees: [
    // Prop fragments (`render/prop-fracture.ts`): built under the terrain group, moved every frame.
    'props:fracture',
    // Wing trails write their own matrices.
    'trail',
  ],
  lift: ['elevator-platform', 'start-pad-ai'],
}

export interface StaticReport {
  /** Objects frozen right now. */
  readonly frozen: number
  /** Objects a check found moved while frozen, by path. Should stay empty. */
  readonly healed: readonly string[]
  /** Lift objects known, and whether they are frozen now. */
  readonly lift: { readonly known: number; readonly frozen: boolean }
}

export interface StaticScene {
  /**
   * Once a frame, before the render. `raceLive` freezes the lift objects (and
   * a false after a true thaws them, for a restart).
   */
  tick(raceLive: boolean): void
  report(): StaticReport
}

/** Objects checked for drift each frame; the whole set is covered every ~25 frames. */
const CHECKS_PER_FRAME = 16
/** Frames between sweeps for objects added since (streamed chunks, revealed props). */
const SWEEP_EVERY = 30

const matches = (name: string, rules: readonly NameRule[]): boolean =>
  rules.some((r) => (typeof r === 'string' ? r === name : r.test(name)))

const pathOf = (o: THREE.Object3D): string => {
  const parts: string[] = []
  for (let p: THREE.Object3D | null = o; p?.parent; p = p.parent) parts.unshift(p.name || p.type)
  return parts.join(' / ')
}

/** True when `a` and `b` hold the same 16 numbers, to a part in a million of the larger. */
const sameMatrix = (a: THREE.Matrix4, b: THREE.Matrix4): boolean => {
  const x = a.elements
  const y = b.elements
  for (let i = 0; i < 16; i++) {
    const d = Math.abs((x[i] as number) - (y[i] as number))
    if (d > 1e-6 * Math.max(1, Math.abs(x[i] as number))) return false
  }
  return true
}

export const createStaticScene = (
  scene: THREE.Object3D,
  rules: StaticRules = MISSION_STATIC_RULES,
): StaticScene => {
  const frozen: THREE.Object3D[] = []
  const mine = new WeakSet<THREE.Object3D>()
  // Handed back after a check found them moved: never frozen again, or the
  // next sweep would freeze a mover all over.
  const movedOnce = new WeakSet<THREE.Object3D>()
  const lifts = new Set<THREE.Object3D>()
  const healed: string[] = []
  const composed = new THREE.Matrix4()
  let cursor = 0
  let frames = 0
  let liftFrozen = false

  const freeze = (o: THREE.Object3D): void => {
    // An object already off auto-update has an owner that writes its matrix;
    // it is not ours to freeze or to heal.
    if (mine.has(o) || movedOnce.has(o) || !o.matrixAutoUpdate) return
    o.updateMatrix()
    o.matrixAutoUpdate = false
    mine.add(o)
    frozen.push(o)
  }

  const thaw = (o: THREE.Object3D): void => {
    if (!mine.has(o)) return
    mine.delete(o)
    o.matrixAutoUpdate = true
  }

  const walk = (o: THREE.Object3D): void => {
    if (matches(o.name, rules.dynamicSubtrees)) return
    if (matches(o.name, rules.lift)) {
      lifts.add(o)
      if (liftFrozen) freeze(o)
    } else if (!matches(o.name, rules.movers)) {
      freeze(o)
    }
    for (const c of o.children) walk(c)
  }

  const sweep = (): void => {
    // The scene itself first. An object that composes its own matrix marks its
    // world matrix stale, and three then rebuilds the world matrix of EVERY
    // descendant that frame (`updateMatrixWorld`'s `force`). The scene root
    // never moves, but left on auto-update it does exactly that, so freezing
    // the subtrees below it would save the compose and not the multiply.
    freeze(scene)
    for (const root of scene.children) if (rules.roots.includes(root.name)) walk(root)
  }

  /** Check a few frozen objects; drop the removed, hand back the moved. */
  const check = (): void => {
    let n = Math.min(CHECKS_PER_FRAME, frozen.length)
    while (n-- > 0 && frozen.length > 0) {
      if (cursor >= frozen.length) cursor = 0
      const o = frozen[cursor] as THREE.Object3D
      const gone = !mine.has(o) || o.parent === null
      if (!gone) {
        composed.compose(o.position, o.quaternion, o.scale)
        if (sameMatrix(composed, o.matrix)) {
          cursor++
          continue
        }
        const where = pathOf(o)
        healed.push(where)
        console.warn(
          `static-scene: "${where}" moved while frozen; handed back to three. Add it to MISSION_STATIC_RULES.movers (DEV-937).`,
        )
        thaw(o)
        movedOnce.add(o)
      }
      // Swap-remove: the frozen list never holds a removed or thawed object.
      frozen[cursor] = frozen[frozen.length - 1] as THREE.Object3D
      frozen.pop()
    }
  }

  return {
    tick(raceLive) {
      if (raceLive !== liftFrozen) {
        liftFrozen = raceLive
        for (const o of lifts) {
          if (o.parent === null) lifts.delete(o)
          else if (raceLive) freeze(o)
          else thaw(o)
        }
      }
      if (frames++ % SWEEP_EVERY === 0) sweep()
      check()
    },
    report() {
      let live = 0
      for (const o of frozen) if (mine.has(o)) live++
      return { frozen: live, healed: [...healed], lift: { known: lifts.size, frozen: liftFrozen } }
    },
  }
}
