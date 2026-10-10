// src/render/title-curtain.ts — the emblem first, and the valley behind it.
// DEV-352.
//
// Matt, 2026-09-24: *"first frame - would it be possible to load and light the
// logo first? then fade in the bg?"*
//
// ── Why this is not the fade ────────────────────────────────────────────────
//
// `render/fade.ts` already has a black curtain, and it is the wrong one for
// this. It is drawn by the vignette's quad, which is UI — `toneMapped: false`,
// so under bloom it is moved to `UI_LAYER` and drawn in a pass of its own on
// top of the composited world (`render/bloom.ts`). Nothing in the world can be
// drawn over it, and "the emblem, lit, on black" is exactly a thing in the
// world drawn over black. The fade covers EVERYTHING; this covers everything
// but the emblem.
//
// So this curtain lives in the WORLD pass, and the emblem is drawn after it:
//
//   * **In the OPAQUE list**, on purpose. three sorts that list by
//     `renderOrder` before anything else, so a quad at `CURTAIN_ORDER` lands
//     after the terrain, the forest and the sky dome (every one of them at 2 or
//     below — `render/draw-order.ts`) and before the emblem at `EMBLEM_ORDER`.
//     `transparent: false` is what puts it there; `CustomBlending` is what
//     still lets it blend, because three switches NormalBlending off for an
//     opaque material and leaves a custom one alone.
//   * **The emblem stays OPAQUE.** Its material is not touched at all — only
//     its `renderOrder`, which is not part of a program's cache key — so there
//     is no second program for the gold and nothing to recompile when the
//     curtain goes.
//   * **`toneMapped` is left TRUE**, which is the one flag here that reads
//     wrong at a glance. A black quad is black on either side of the tone
//     curve, so the curve is not what the flag decides for this material:
//     `bloom.ts` classifies `toneMapped === false` as UI and lifts it into the
//     pass drawn over the composite, which would put this curtain over the
//     emblem too. `tests/unit/title-curtain.test.ts` pins that.
//   * **Clip space, no camera matrices**, the vignette's own trick: three's
//     per-eye viewport gives each eye its own full-screen copy, and a quad with
//     no Z cannot clip the near plane. It is XR-correct by construction, though
//     no headset has ever seen it — the title is ready before `#enter-vr` is.
//
// What is drawn AFTER the opaque list is not covered, and that is decided
// rather than inherited: the line under the emblem (DEV-285) is UI and shows on
// black with it, and the flypast jets — translucent on Classic — are held out
// of the flypast until the curtain lifts (`boot/app.ts`).
//
// ── The schedule is the fade's ─────────────────────────────────────────────
//
// `fadeRamp`, 2016's `Fade_Mesh` ramp with its 0.85 clamp, over whatever
// duration the caller hands in. `boot/app.ts` hands in `LOAD_FADE_SECONDS`,
// 2016's own mission-camera fade — the one tuned for arriving somewhere after
// real work, which is what the valley landing is.

import * as THREE from 'three'
import { fadeRamp } from '@/render/fade'

/**
 * Where the curtain sorts. Above everything the title world draws in its
 * opaque list — the sky dome's `SKY_LAST_ORDER` is 2 and the sea's
 * `OCEAN_LATE_ORDER` is 1 — and below the vignette's 10 000, which on a
 * single-pass frame (Classic, a headset) must still cover the emblem when the
 * boot fade is black.
 */
export const CURTAIN_ORDER = 9_000

/** Where the emblem sorts while the curtain is up: immediately after it. */
export const EMBLEM_ORDER = CURTAIN_ORDER + 1

/**
 * `held` — solid, and waiting for the valley. `lifting` — ramping to clear.
 * `gone` — clear, invisible, and ready to be taken out of the scene.
 */
export type CurtainPhase = 'held' | 'lifting' | 'gone'

export interface TitleCurtain {
  readonly object: THREE.Mesh
  /** 0..1 black over the world. 1 while `held`. */
  readonly amount: number
  readonly phase: CurtainPhase
  /** Start clearing, over `seconds` of render time. Idempotent once lifting. */
  lift(seconds: number): void
  /** Advance one RENDER frame. */
  update(dtSeconds: number): void
  dispose(): void
}

const VERTEX = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const FRAGMENT = /* glsl */ `
uniform float uAmount;
void main() {
  gl_FragColor = vec4(0.0, 0.0, 0.0, uAmount);
}
`

/**
 * The curtain's black at `elapsed` seconds into a `seconds`-long lift.
 *
 * Exported so the schedule is tested as the thing that ships rather than
 * re-derived beside it.
 */
export const curtainAmount = (elapsed: number, seconds: number): number =>
  1 - fadeRamp(elapsed, seconds)

export const createTitleCurtain = (): TitleCurtain => {
  const uniforms = { uAmount: { value: 1 } }
  const material = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms,
    // The OPAQUE list — see the header. `CustomBlending` with the ordinary
    // over operator for colour, and the destination's alpha left alone so a
    // half-lifted curtain does not punch holes in the composite's alpha.
    transparent: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const object = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
  object.name = 'title-curtain'
  object.frustumCulled = false
  object.renderOrder = CURTAIN_ORDER

  let phase: CurtainPhase = 'held'
  let amount = 1
  let elapsed = 0
  let seconds = 0

  return {
    object,
    get amount() {
      return amount
    },
    get phase() {
      return phase
    },
    lift(next) {
      if (phase !== 'held') return
      phase = 'lifting'
      elapsed = 0
      seconds = next
    },
    update(dt) {
      if (phase !== 'lifting') return
      elapsed += dt > 0 ? dt : 0
      amount = curtainAmount(elapsed, seconds)
      uniforms.uAmount.value = amount
      if (amount <= 0) {
        amount = 0
        phase = 'gone'
        object.visible = false
      }
    },
    dispose() {
      object.geometry.dispose()
      material.dispose()
    },
  }
}
