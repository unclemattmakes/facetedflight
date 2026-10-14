// tests/unit/xr-eye-layers.test.ts — layers 1 and 2 belong to WebXR (DEV-141).
//
// Matt, in a headset, first playthrough: *"UI only draws in one eye"*.
//
// `render/bloom.ts` moved every UI surface onto `UI_LAYER`, and `UI_LAYER` was
// **1**, which is three's LEFT EYE. `WebXRManager` derives the two eye cameras
// from the app camera's mask by clearing one bit each, so an object on layer 1
// is visible to `cameraL` and invisible to `cameraR` — not dim, not
// half-rendered, absent from one eye. The same is true of layer 2 the other way
// round.
//
// ── Why this file and not another assertion in bloom.test.ts ──────────────
//
// Because the claim is not about bloom. It is about a number that `src/` is
// allowed to choose, and two values of it that mean something to somebody else.
// The next module to want a layer will not read `bloom.ts` first.
//
// ── The oracle is three's own source, not our belief about it ─────────────
//
// CLAUDE.md: *a test that compares two of your own devices has not tested
// either of them* — `xr-input.test.ts` asserts VR and flat agree and stays
// green when both are wrong. So the masking rule is not retyped here from
// memory and then asserted against itself. §1 READS `three.module.js` and
// fails if the three lines it depends on are no longer there, which is the
// measured result a three upgrade is supposed to land with; §2 then applies
// the rule to our constants.
//
// There is no headless WebXR to drive instead (CLAUDE.md), so the build is the
// closest thing to the headset that a `pnpm test` can reach.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { UI_LAYER } from '@/render/bloom'
import { LENS_MASK_LAYERS } from '@/render/lens-mask'
import { REPO as ROOT } from './helpers/repo-root'
import { listTs } from './helpers/source-tree'

/**
 * three's rule, transcribed from `WebXRManager.updateCamera` — and §1 is what
 * makes transcribing it legitimate.
 *
 *     cameraXR.layers.mask = camera.layers.mask | 0b110
 *     cameraL.layers.mask  = cameraXR.layers.mask & -5
 *     cameraR.layers.mask  = cameraXR.layers.mask & -3
 */
const eyeMasks = (appMask: number): { left: number; right: number } => {
  const xr = appMask | 0b110
  return { left: xr & -5, right: xr & -3 }
}

describe('§1 three still masks the eyes the way we think it does', () => {
  it('derives both eye cameras by clearing bit 2 and bit 1', () => {
    // Inside the `it`, not above it: the disk work belongs where a guard can
    // skip it, and a `describe` body runs during COLLECTION (CLAUDE.md).
    const build = fs.readFileSync(
      path.join(ROOT, 'node_modules/three/build/three.module.js'),
      'utf8',
    )
    // The comment three writes above them, which is the whole finding in one
    // line. If it moves, read the new code before touching the numbers below.
    expect(build).toContain('enable eye layers (1 = left, 2 = right)')
    expect(build).toContain('cameraXR.layers.mask = camera.layers.mask | 0b110;')
    expect(build).toContain('cameraL.layers.mask = cameraXR.layers.mask & -5;')
    expect(build).toContain('cameraR.layers.mask = cameraXR.layers.mask & -3;')
  })

  it('is a rule about bits 1 and 2 ONLY — every other layer reaches both eyes', () => {
    // The half that says why the fix is a different number rather than a
    // different mechanism. `& -5` clears bit 2 and `& -3` clears bit 1; they
    // touch nothing else, so 0 and 3..31 are stereo and 1 and 2 are not.
    for (let layer = 0; layer < 32; layer += 1) {
      const { left, right } = eyeMasks(1 << layer)
      const bothEyes = (left & (1 << layer)) !== 0 && (right & (1 << layer)) !== 0
      expect(bothEyes, `layer ${layer}`).toBe(layer !== 1 && layer !== 2)
    }
  })
})

describe('§2 the UI reaches both eyes — DEV-141', () => {
  it('puts the UI on a layer that is not an eye', () => {
    expect(UI_LAYER).not.toBe(1)
    expect(UI_LAYER).not.toBe(2)
  })

  it('survives both eye masks on a camera that has it enabled', () => {
    // The shape the bug actually had: `bloom.render` enables `UI_LAYER` on the
    // app camera on EVERY frame including in VR, so the app mask is layer 0
    // plus the UI layer, and the question is what the two eyes make of it.
    const appMask = (1 << 0) | (1 << UI_LAYER)
    const { left, right } = eyeMasks(appMask)
    expect(left & (1 << UI_LAYER), 'left eye').not.toBe(0)
    expect(right & (1 << UI_LAYER), 'right eye').not.toBe(0)
    // And the world is still in both, which is the control: a mask that failed
    // this would mean the arithmetic above, not the layer.
    expect(left & 1, 'left eye, world').not.toBe(0)
    expect(right & 1, 'right eye, world').not.toBe(0)
  })
})

describe('§3 nothing in src/ parks an object on an eye', () => {
  it('has no literal layer 1 or 2 anywhere it could reach the scene graph', () => {
    // *When you fix one instance, re-derive all of them.* `UI_LAYER` was the
    // one that shipped; this is what catches the next module to pick a small
    // number because 0 was taken. `LOGO_LAYER` (23) is fine and stays fine.
    //
    // Comments are stripped first, so the paragraphs in `bloom.ts` explaining
    // that 1 is the left eye do not trip the guard that exists because of them.
    const offenders: string[] = []
    for (const file of listTs(path.join(ROOT, 'src'))) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      for (const call of code.matchAll(
        /layers\.(?:set|enable|toggle)\(\s*[12]\s*\)/g,
      ) as Iterable<RegExpMatchArray>) {
        // POSIX separators, so the message reads the same on the runner as it
        // does here and a copy-pasted path is clickable on both.
        offenders.push(`${path.relative(ROOT, file).replaceAll(path.sep, '/')}: ${call[0]}`)
      }
    }
    expect(offenders, 'layers 1 and 2 are the WebXR eyes — see §1').toEqual([])
  })
})

describe('§4 the one exception: the lens mask, on BOTH eyes (DEV-930)', () => {
  // `docs/plan/XR-PERF-VS-THREE.md` §3.11 premise 4: per-eye content is what
  // layers 1 and 2 are FOR, so the app's lens mask uses them, deliberately and
  // in one place. On both of them it is in both eyes (never DEV-141's one-eyed
  // shape) and in no camera that is not an eye. `render/lens-mask.ts` lock 2.
  it('sets both eye bits, not one', () => {
    expect(LENS_MASK_LAYERS & 0b110, 'both eyes').toBe(0b110)
    const { left, right } = eyeMasks(1 << 0)
    expect(left & LENS_MASK_LAYERS, 'left eye').not.toBe(0)
    expect(right & LENS_MASK_LAYERS, 'right eye').not.toBe(0)
  })

  it('is the only module that names the eye-layer mask', () => {
    const users: string[] = []
    for (const file of listTs(path.join(ROOT, 'src'))) {
      if (fs.readFileSync(file, 'utf8').includes('LENS_MASK_LAYERS')) {
        users.push(path.relative(ROOT, file).replaceAll(path.sep, '/'))
      }
    }
    expect(users).toEqual(['src/render/lens-mask.ts'])
  })
})
