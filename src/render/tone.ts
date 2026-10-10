// src/render/tone.ts — tone mapping and exposure, as preset state.
//
// ── What 2016 had, and what "none" therefore means ───────────────────────
//
// Unity 5's forward path in a Linear project writes the lit result to the
// framebuffer and the hardware encodes it to sRGB. There is no tone curve: a
// value over 1.0 clips, flat, and the highlight is gone. Faceted Flight had no
// Tonemapping image effect on any camera (ANNIVERSARY.md §3.1) — what it had
// instead was `BloomOptimized`, which bled the clipped parts sideways so the
// clipping read as glow. FF2 cut the bloom (PORT_PLAN §6.1) and did not replace
// the headroom, so a 4-degree sun, an additive speed streak and a white ring
// stud all land on the same flat 1.0.
//
// So `toneMapping: "none"` in `content/editions/classic.json` is not "we have
// not got round to it". It is the shipped look, and `applyEditionRender` on
// Classic sets exactly what `render/renderer.ts` has always set: three's
// `NoToneMapping` at exposure 1, which is a `saturate()` and nothing else.
//
// ── What three does on its own, which the first draft of this got wrong ──
//
// The received wisdom is that changing `renderer.toneMapping` after materials
// have compiled needs `material.needsUpdate = true` on every one of them. In
// three 0.185.1 it does not: `WebGLRenderer.setProgram` recomputes the
// per-material tone mapping (`three.module.js:18345`, which is `material
// .toneMapped ? renderer.toneMapping : NoToneMapping`) and `needsProgramChange`
// compares it against the material's last one (`:18476`), so the recompile
// happens by itself on the next draw. `toneMappingExposure` is not even a
// define — it is a uniform pushed on every `setProgram` (`:18703`), so it needs
// no recompile at all.
//
// This file therefore touches NO material on a flip, and
// `tests/unit/tone.test.ts` asserts that by watching `material.version`. A
// traverse-and-dirty would work, but it would also throw away every compiled
// program in the scene — including the terrain's, which is the expensive one —
// to do a job three has already done, and it would hide a real regression if
// three ever stopped doing it.
//
// ── What must NOT be tone-mapped ─────────────────────────────────────────
//
// The line, and it is a line rather than a list: **a surface showing a
// canvas-drawn UI texture, or one that exists to modify the frame rather than
// to be in the world, is not tone-mapped. Everything that is a thing in the
// world is.** Under it: the cockpit HUD, the pause/comfort/controls/edition
// plate, the results and briefing panels, the title word and prompt, the
// hangar's own labels, the comfort vignette and the comfort horizon band. Over
// it, and correctly tone-mapped: the sky dome, terrain, water, clouds, props,
// rings, particles, the ship, and the hangar room itself.
//
// The flag lives on the material at its construction site rather than in a
// registry here, because a material that is UI knows it is UI and a list in
// another file goes stale the first time somebody adds a panel.

import * as THREE from 'three'
import type { Edition, ToneMappingId } from '@/content/edition-schema'
import type { EditionState } from '@/game/edition'

/**
 * The preset's name for a tone curve, and three's constant for it.
 *
 * A `Record` over `ToneMappingId` rather than a switch, so adding a name to
 * `TONE_MAPPINGS` in `content/edition-schema.ts` without adding it here is a
 * type error rather than a silent `undefined` that reads as `NoToneMapping`
 * (which is 0, and therefore falsy, and therefore invisible).
 */
export const TONE_MAPPING_BY_ID: Readonly<Record<ToneMappingId, THREE.ToneMapping>> = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
}

/** What the renderer should be set to, resolved from a preset. */
export interface EditionRenderState {
  readonly toneMapping: THREE.ToneMapping
  readonly exposure: number
}

export const editionRenderState = (edition: Edition): EditionRenderState => ({
  toneMapping: TONE_MAPPING_BY_ID[edition.render.toneMapping],
  exposure: edition.render.exposure,
})

/**
 * Put the preset's tone curve and exposure on the renderer.
 *
 * Idempotent and cheap — two property writes and a comparison — so calling it
 * every frame would be legal. It is called at boot and on every preset or
 * settings change instead, because that is when it can differ.
 *
 * Returns whether anything actually moved, which is what the lookdev panel and
 * the tests want to know.
 */
export const applyEditionRender = (
  renderer: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>,
  edition: Edition,
): boolean => {
  const next = editionRenderState(edition)
  const changed =
    renderer.toneMapping !== next.toneMapping || renderer.toneMappingExposure !== next.exposure
  renderer.toneMapping = next.toneMapping
  renderer.toneMappingExposure = next.exposure
  return changed
}

// ── One surface, another look's curve (DEV-451, DEV-568) ─────────────────
//
// A curve is renderer state, so a surface cannot ask for its own. Two places
// need one anyway, both because a MENU's surface is on screen while the
// renderer wears a MISSION's curve (D35: the menus are always Anniversary,
// a mission wears the look the player chose): the loading scene
// (`render/loading-scene.ts`, DEV-451) and the launch rig, which is the
// hangar's own room and shaft at the bottom of every HoverJet mission
// (`render/hangar-art.ts`, DEV-568). Both are drawn in per-face vertex
// colours, so the curve can be drawn INTO the colours on the CPU.

/**
 * three's `ACESFilmicToneMapping` on one LINEAR colour, in place at `i`: the
 * exposure over 0.6, the input matrix, the RRT/ODT fit, the output matrix, a
 * clamp. The same numbers as `tonemapping_pars_fragment`, so a face coloured
 * here matches the face the renderer would have tone-mapped
 * (`tests/unit/loading-tone.test.ts` reads them back out of three's chunk).
 */
export const acesFilmic = (rgb: Float32Array | number[], i: number, exposure: number): void => {
  const k = exposure / 0.6
  const x = (rgb[i] as number) * k
  const y = (rgb[i + 1] as number) * k
  const z = (rgb[i + 2] as number) * k
  const rrtOdt = (v: number): number =>
    (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081)
  const r = rrtOdt(0.59719 * x + 0.35458 * y + 0.04823 * z)
  const g = rrtOdt(0.076 * x + 0.90834 * y + 0.01566 * z)
  const b = rrtOdt(0.0284 * x + 0.13383 * y + 0.83777 * z)
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  rgb[i] = clamp(1.60475 * r - 0.53108 * g - 0.07367 * b)
  rgb[i + 1] = clamp(-0.10208 * r + 1.10813 * g - 0.00605 * b)
  rgb[i + 2] = clamp(-0.00327 * r - 0.07276 * g + 1.07602 * b)
}

/** A curve and its exposure: what an edition's `render` block puts on the renderer. */
export interface ToneLook {
  readonly curve: ToneMappingId
  readonly exposure: number
}

/** An edition's curve, as a `ToneLook`. */
export const toneLookOf = (edition: Pick<Edition, 'render'>): ToneLook => ({
  curve: edition.render.toneMapping,
  exposure: edition.render.exposure,
})

/**
 * Write into `out` the linear colours that, drawn by a tone-mapped material
 * under `live`, show what `base` shows under `want`. Returns false where no
 * colour can (`out` then holds `base` unchanged):
 *
 *   the same curve   `base` times the exposure ratio. Every curve three has
 *                    multiplies by its exposure first, so this is exact.
 *   live is `none`   the wanted curve drawn in here, which `none`'s clamp
 *                    then leaves alone: ACES only (`acesFilmic`), since it is
 *                    the one curve a preset ships.
 *   anything else    a curve under another curve has no exact pre-image.
 */
export const toneColoursFor = (
  base: ArrayLike<number>,
  want: ToneLook,
  live: ToneLook,
  out: Float32Array | number[],
): boolean => {
  if (want.curve === live.curve) {
    const k = want.curve === 'none' ? 1 : want.exposure / live.exposure
    for (let i = 0; i < base.length; i++) out[i] = (base[i] as number) * k
    return true
  }
  for (let i = 0; i < base.length; i++) out[i] = base[i] as number
  if (live.curve !== 'none' || want.curve !== 'aces') return false
  for (let i = 0; i + 2 < base.length; i += 3) acesFilmic(out, i, want.exposure)
  return true
}

/**
 * Wire the renderer to the live preset: apply now, and again on every flip.
 *
 * Returns the unsubscribe. `boot/app.ts` drops it — the app reloads the
 * document on a level change, so there is exactly one renderer for the life of
 * the page — and the tests use it.
 */
export const attachEditionTone = (
  renderer: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>,
  editionState: EditionState,
): (() => void) => {
  applyEditionRender(renderer, editionState.current)
  return editionState.subscribe((edition) => {
    applyEditionRender(renderer, edition)
  })
}
