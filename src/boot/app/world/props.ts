// src/boot/app/world/props.ts: what a world's props do in flight, out of
// `bootApp`. APP-SPLIT phase 4, slice 7 (world; `docs/plan/APP-SPLIT.md` §1b,
// "Props per world").
//
// DEV-502's line clearing (and its receipt), the props' visibility, DEV-136's
// break (with the bounce log's burst), and a craft's splash. The per-world
// handles they read and write (the colliders, the contact state, the fracture
// group, the drawn props, the mask and its input) are the world's and stay
// with the world's other handles. Every line below was moved verbatim from the
// closure; the plumbing is `ctx.x` where the code reads a binding the closure
// still owns (a getter, and a setter where this code writes one: the §6 rule 3
// bag), and the returned object.

import * as THREE from 'three'
import type { AudioSystem } from '@/audio'
import type { Feel } from '@/boot/feel'
import { JOLTS } from '@/game/cockpit-jolt'
import type { EditionState } from '@/game/edition'
import type { MissionState } from '@/game/mission'
import {
  type ParticleFx,
  propStrikeOf,
  type SeaSource,
  seaUnder,
  splashScale,
  strikeStands,
} from '@/game/particle-fx'
import {
  createLineMask,
  type LineClearingReceipt,
  type LineMask,
} from '@/game/props/course-clearing'
import type { loadProps } from '@/game/props/load-props'
import { type CraftSplashState, createCraftSplash, stepCraftSplash } from '@/game/splash-crossing'
import { propScatterVisible } from '@/render/advanced-menu'
import { TRAUMA } from '@/render/camera-shake'
import { readHeadPosition } from '@/render/head-pose'
import type { PropFracture } from '@/render/prop-fracture'
import type { Renderer } from '@/render/renderer'
import type { Clearing } from '@/sim/props/clearing'
import { type PropColliders, type PropHit, setPropCleared } from '@/sim/props/collision'

/** What `createWorldProps` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface WorldPropsCtx {
  readonly audio: AudioSystem
  readonly craftSplashes: Map<string, CraftSplashState>
  readonly editionState: EditionState
  readonly feel: Feel
  readonly liveFracture: PropFracture | null
  readonly liveFx: ParticleFx | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  liveLineMask: LineMask | null
  readonly livePropColliders: PropColliders | null
  readonly livePropsLive: Awaited<ReturnType<typeof loadProps>>
  readonly liveSea: SeaSource | null
  readonly mission: MissionState
  readonly render: Renderer
}

export const createWorldProps = (ctx: WorldPropsCtx) => {
  const { audio, craftSplashes, editionState, feel, mission, render } = ctx
  /** The last mask's cost and count, for `__ff2.lineClearing()` and DEV-502's row. */
  let lineClearingReceipt: LineClearingReceipt | null = null
  /**
   * DEV-502: mask `clearings` on this world's scatter — hide what they cover,
   * put back what they no longer cover — and take the same props' colliders
   * out (or back in) in the same call, so what is drawn and what is solid
   * cannot disagree (DEV-136). A tree already broken in flight is left alone
   * both ways. Null on a world with no scatter.
   */
  const applyCourseClearing = (
    clearings: readonly Clearing[],
    levelId: string,
  ): LineClearingReceipt | null => {
    const props = ctx.livePropsLive
    if (!props) return null
    const t0 = performance.now()
    if (!ctx.liveLineMask) {
      ctx.liveLineMask = createLineMask(
        props.colliderInputs.slice(0, props.scatterCount),
        editionState.current.gameplay.propCollision.cellMetres,
      )
    }
    const cols = ctx.livePropColliders
    const change = ctx.liveLineMask.update(clearings, (id) => !cols || cols.broken[id] === 0)
    props.mask(change.hide, true)
    props.mask(change.show, false)
    if (cols) {
      for (const id of change.hide) setPropCleared(cols, id, true)
      for (const id of change.show) setPropCleared(cols, id, false)
    }
    lineClearingReceipt = {
      level: levelId,
      clearings: clearings.length,
      masked: ctx.liveLineMask.count(),
      hidden: change.hide.length,
      shown: change.show.length,
      scatter: props.scatterCount,
      ms: performance.now() - t0,
    }
    return lineClearingReceipt
  }
  /**
   * The Props row, reaching the FOREST. DEV-303, and it is one line of effect.
   *
   * `props.enabled` was read by `game/props/load-dressing.ts` and by nothing
   * else, so the Advanced page's PROPS row moved the generated dressing — 3
   * draw calls, 87,448 triangles of rocks and shrubs — and left the 2016 baked
   * scatter alone. That scatter is **7.42 M triangles and 88–93 % of desert's
   * and alpine's world pass**, and finding where Anniversary's frame goes is
   * the whole reason the page exists (NEXT.md action 1). The row's own note
   * said *"trees, rocks and birds"*, naming the class it could not touch.
   *
   * VISIBILITY and not a rebuild, deliberately. `loadProps` is called at world
   * build with `unbakedPasses`, `scale` and `groundSnap` read there *"so an
   * EDITION flip mid-run does not restack the trees under you"* — which is
   * right for CONTENT and is untouched here. A bisect instrument needs the
   * FRAME COST to move when the row is pressed, and `group.visible = false`
   * takes the draw calls and the fill out while the geometry stays resident.
   * Resident geometry is not what the bisect is measuring.
   *
   * It does NOT reach the colliders: those are built once from
   * `gameplay.propCollision`, which is a feature of its own with its own row
   * in the registry, so a hidden tree is still solid. The row's note says so.
   *
   * Idempotent, and the same shape `load-dressing.ts:324` already uses for the
   * dressing (`group.visible = props.enabled && built`) — so this is the same
   * rule reaching the other half of the prop layer, not a second rule.
   */
  // DEV-332: NOT `props.enabled`. In the presets that flag is the generated
  // DRESSING, and Classic ships it false, so reading it here hid the whole 2016
  // forest on Classic. Only the Props row's own override hides the scatter;
  // `propScatterVisible` says why.
  const applyPropVisibility = (): void => {
    if (ctx.livePropsLive) {
      ctx.livePropsLive.group.visible = propScatterVisible(editionState.featureOverrides)
    }
  }
  editionState.subscribe(applyPropVisibility)
  /**
   * How often a BOUNCE may put a line in the console, per hitter. DEV-180.
   *
   * Seconds of mission time, not a tick count: the rate a human reads at does
   * not change with the frame rate, and `mission.elapsed` is the clock this
   * loop already has. Breaks are never rate-limited — see `breakProps`.
   */
  const PROP_BOUNCE_LOG_SECONDS = 1
  /** Per hitter: when its last bounce line went out, and how many since. */
  const bounceBurst = new Map<string, { since: number; suppressed: number }>()
  /**
   * What the RENDERER does about a contact the sim reported: hide the
   * instance, throw its facets, and play 2016's strike cue.
   *
   * One function because there is now more than one thing that can break a
   * tree — the player and every AI racer (DEV-147). Two copies of this is how
   * one of them ends up fracturing an instance the other already hid.
   * `velocity` is the hitter's, SIM space; the z flip into the terrain group's
   * frame happens here.
   */
  const breakProps = (
    hits: readonly PropHit[],
    velocity: { readonly x: number; readonly y: number; readonly z: number },
    who: string,
  ): void => {
    if (hits.length === 0) return
    for (const hit of hits) {
      if (!hit.broken) continue
      // `drawn` BEFORE `hide`: hiding zeroes the instance matrix the fracture
      // starts from.
      const d = ctx.livePropsLive?.drawn(hit.id)
      // ── DEV-428: a struck prop that KEPT its collider stands ───────────
      //
      // `gameplay.propCollision.strike`: the sim let the hitter through and
      // kept the tree solid, so the drawing stays too, and the strike throws
      // a burst in the prop's own colours. The renderer follows the COLLIDER,
      // not the flag (`strikeStands`): DEV-180's escape removes one even with
      // the strike on, and that tree comes apart below as it always did.
      //
      // P4's SWAY plugs in beside the burst, off the same `strike` object —
      // the instance id, the contact and the hitter's velocity — as a second
      // consumer (`livePropsLive.sway(strike)`, once `aSway` exists: NEXT.md
      // P4 #3/#18). Not a second derivation of the contact.
      if (ctx.livePropColliders && strikeStands(hit, ctx.livePropColliders)) {
        const strike = propStrikeOf(hit, velocity, ctx.livePropColliders, d ?? null)
        ctx.liveFx?.strikeProp(
          strike,
          editionState.current.fx.propBurst,
          // The HEAD (DEV-199's one door), for `maxMetres`.
          readHeadPosition(render.renderer.xr, render.camera, _strikeEye),
        )
        continue
      }
      ctx.livePropsLive?.hide(hit.id)
      if (d && ctx.liveFracture) {
        // Sim -> three: z flips. The pieces live under the terrain group,
        // whose frame the instance matrix is already in.
        ctx.liveFracture.break(
          d.geometry,
          d.material,
          d.matrix,
          new THREE.Vector3(velocity.x, velocity.y, -velocity.z),
        )
      }
    }
    // 2016's own strike cue: `Ship_HoverShip.OnCollisionEnter` played the same
    // sound for anything solid, and a tree is now solid. A racer's hit is
    // three-dimensional audio in the world, not in your cockpit — but the cue
    // is a 2D one-shot, so it is the PLAYER's hits that play it. A racer
    // mowing down a forest 800 m away must not bang in your ears.
    if (who === 'player') {
      audio.event({ type: 'ship.struck' })
      // DEV-636/637/643: a prop strike is felt (a medium shake, a cockpit jolt, a
      // hit rumble) and gets no render hold: that is the crash's alone.
      feel.shake(TRAUMA.propStrike)
      feel.jolt(JOLTS.propStrike)
      feel.haptic('hit')
    }
    // The `prop hit:` prefix is DEV-136's and `tests/e2e/prop-break.spec.ts`
    // greps for it; `who` goes INSIDE it so that spec can still pick out the
    // player's own break to photograph now that five racers break trees too.
    //
    // ── A BREAK always speaks; a BOUNCE speaks once a second (DEV-180) ────
    //
    // A break is one event and then the collider is gone, so there can never be
    // many of them. A bounce is a CONTACT, and a contact is per tick: the racer
    // Matt watched resting on a palm produced 157 of these in 1.9 s and kept
    // going for minutes, and in a headset nobody can read the console while the
    // main thread still pays for every line of it. The escape above ends the
    // resting, and this makes the burst that remains readable — the first
    // bounce in each second is printed with a count of the rest.
    //
    // DEV-428: a STRIKE — a tree that stood — is rate-limited like a bounce,
    // because the premise above ("then the collider is gone") is the one it
    // removes: a standing tree is struck again by every racer that passes it.
    // Only a removal still always speaks.
    const said = (h: PropHit): string =>
      !h.broken
        ? 'bounce'
        : ctx.livePropColliders && strikeStands(h, ctx.livePropColliders)
          ? 'struck'
          : 'broke'
    const broke = hits.some((h) => said(h) === 'broke')
    if (broke) {
      bounceBurst.delete(who)
      console.info(
        `prop hit: ${who} ${hits.map((h) => `${h.kind}#${h.id} ${said(h)} at ${h.speed.toFixed(0)} m/s`).join(', ')}`,
      )
      return
    }
    const burst = bounceBurst.get(who)
    const now = mission.elapsed
    if (burst && now - burst.since < PROP_BOUNCE_LOG_SECONDS) {
      burst.suppressed += hits.length
      return
    }
    const carried = burst ? burst.suppressed : 0
    bounceBurst.set(who, { since: now, suppressed: 0 })
    const one = hits[0] as PropHit
    console.info(
      `prop hit: ${who} ${one.kind}#${one.id} ${said(one)} at ${one.speed.toFixed(0)} m/s` +
        (carried > 0 ? ` (+${carried} more in the last ${PROP_BOUNCE_LOG_SECONDS} s)` : ''),
    )
  }
  /** DEV-428: the eye, for a strike's `maxMetres`. Scratch, one call's worth. */
  const _strikeEye = new THREE.Vector3()
  /** DEV-642: where the near-miss whoosh is emitted from, and the head's right. Scratch. */
  const _nearEye = new THREE.Vector3()
  const _nearRight = new THREE.Vector3()
  const _nearAt: [number, number, number] = [0, 0, 0]
  /** DEV-613: the eye for a splash's `maxMetres`, and the sea under a jet. Scratch. */
  const _splashEye = new THREE.Vector3()
  const _splashSea = { seaY: 0, depth: 0 }
  /**
   * DEV-613: one fixed tick of a jet against the sea, and the splash it throws.
   *
   * The player and every racer, through one rule (`game/splash-crossing.ts`):
   * IN when its hull's contact began over water deep enough to be sea, OUT when
   * it has risen `exitMetres` back over it. SIM in, THREE out: z flips. IN is
   * thrown at the hull (a ship touching the water is the best estimate of where
   * the drawn wave is, DEV-429's finding), OUT at the sea under it. Sized by the
   * crosser's body and its speed, the speed into the water counted in.
   */
  const splashCraft = (
    who: string,
    body: {
      readonly position: { readonly x: number; readonly y: number; readonly z: number }
      readonly velocity: { readonly x: number; readonly y: number; readonly z: number }
    },
    struck: boolean,
    impactSpeed: number,
    dt: number,
  ): void => {
    const spec = editionState.current.fx.splash
    if (!ctx.liveFx || !ctx.liveSea || !spec.enabled) return
    let state = craftSplashes.get(who)
    if (!state) {
      state = createCraftSplash()
      craftSplashes.set(who, state)
    }
    const p = body.position
    const v = body.velocity
    seaUnder(ctx.liveSea, p.x, p.z, _splashSea)
    const height = _splashSea.depth > 0 ? p.y - _splashSea.seaY : null
    const event = stepCraftSplash(state, { position: p, velocity: v, struck, height, dt }, spec)
    if (!event) return
    const speed = Math.hypot(v.x, v.y, v.z)
    const scale =
      event === 'in'
        ? splashScale(spec, spec.jetBody, Math.hypot(speed, impactSpeed))
        : splashScale(spec, spec.jetBody * spec.outScale, speed)
    ctx.liveFx.splash(
      { x: p.x, y: event === 'in' ? p.y : _splashSea.seaY, z: -p.z },
      { x: v.x, y: v.y, z: -v.z },
      scale,
      readHeadPosition(render.renderer.xr, render.camera, _splashEye),
    )
  }
  return {
    applyPropVisibility,
    applyCourseClearing,
    _splashEye,
    breakProps,
    splashCraft,
    _nearAt,
    _nearEye,
    _nearRight,
    get lineClearingReceipt() {
      return lineClearingReceipt
    },
  }
}
