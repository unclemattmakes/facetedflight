// tests/unit/tone.test.ts — tone mapping and exposure (DEV-081).
//
// Three things, in the order they would hurt if they broke.
//
//  1. **Classic sets exactly what `render/renderer.ts` has always set.**
//     `NoToneMapping`, exposure 1 — three's own constructor defaults
//     (`three.module.js:16263` and `:16271`), which is what a renderer built
//     before the presets existed had. If this drifts, "Classic is the ledger as
//     it stands" stops being a fact.
//
//  2. **Nothing is marked for recompilation.** three 0.185.1 notices a tone
//     mapping change per material itself (`needsProgramChange`, `:18476`) and
//     pushes the exposure as a uniform every draw (`:18703`). A
//     traverse-and-dirty would work and would also throw away the terrain's
//     compiled program on every flip. That decision rests on three's behaviour,
//     so three's shipped build is what gets asserted — not a belief about it.
//     The `material.version` check beside it is a sentinel; the grep is the
//     guard, because `applyEditionRender` takes no scene and the way this
//     regresses is somebody threading one back in.
//
//  3. **The name map is total.** A preset name with no constant behind it
//     resolves to `undefined`, and `NoToneMapping` is 0 — so the failure would
//     be "the Anniversary preset silently renders like Classic", which is the
//     hardest kind of bug to see and the easiest to argue about.
//
// No GL context anywhere here: `applyEditionRender` takes the two properties it
// writes, so a plain object stands in for the renderer.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import { type Edition, TONE_MAPPINGS } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { applyEditionRender, attachEditionTone, TONE_MAPPING_BY_ID } from '@/render/tone'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

/** Just the two properties `applyEditionRender` is allowed to touch. */
const stubRenderer = () => ({ toneMapping: THREE.NoToneMapping, toneMappingExposure: 1 })

describe('the tone mapping name map', () => {
  it('has a three constant for every name the schema allows', () => {
    for (const name of TONE_MAPPINGS) {
      expect(TONE_MAPPING_BY_ID[name], name).toBeTypeOf('number')
    }
    expect(Object.keys(TONE_MAPPING_BY_ID).sort()).toEqual([...TONE_MAPPINGS].sort())
  })

  it('maps each name to the curve that name means', () => {
    expect(TONE_MAPPING_BY_ID.none).toBe(THREE.NoToneMapping)
    expect(TONE_MAPPING_BY_ID.aces).toBe(THREE.ACESFilmicToneMapping)
    expect(TONE_MAPPING_BY_ID.agx).toBe(THREE.AgXToneMapping)
    expect(TONE_MAPPING_BY_ID.neutral).toBe(THREE.NeutralToneMapping)
  })

  it('gives four DISTINCT constants, so no two names are the same curve', () => {
    // The failure this catches is a copy-paste in the map, which would make one
    // preset name quietly render as another and cost an afternoon by eye.
    const values = Object.values(TONE_MAPPING_BY_ID)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('Classic sets what the renderer always set', () => {
  it('is NoToneMapping at exposure 1 — three own defaults', () => {
    const renderer = { toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 2.5 }
    applyEditionRender(renderer, classic)
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping)
    expect(renderer.toneMappingExposure).toBe(1)
    // And those ARE what a fresh WebGLRenderer carries, which is the claim
    // "Classic renders what it rendered" rests on. Read off a real renderer's
    // prototype defaults rather than restated: `new WebGLRenderer()` needs a
    // canvas, so the constants are compared instead.
    expect(THREE.NoToneMapping).toBe(0)
  })

  it('reports no change when the renderer is already there', () => {
    const renderer = stubRenderer()
    expect(applyEditionRender(renderer, classic)).toBe(false)
  })

  it('is idempotent — calling it twice is calling it once', () => {
    const renderer = stubRenderer()
    applyEditionRender(renderer, anniversary)
    const after = { ...renderer }
    expect(applyEditionRender(renderer, anniversary)).toBe(false)
    expect(renderer).toEqual(after)
  })
})

describe('the Anniversary preset', () => {
  it('asks for a real tone curve', () => {
    const renderer = stubRenderer()
    expect(applyEditionRender(renderer, anniversary)).toBe(true)
    expect(renderer.toneMapping).not.toBe(THREE.NoToneMapping)
    expect(renderer.toneMapping).toBe(TONE_MAPPING_BY_ID[anniversary.render.toneMapping])
  })

  it('carries a positive exposure, because zero is a black frame', () => {
    expect(anniversary.render.exposure).toBeGreaterThan(0)
    expect(classic.render.exposure).toBe(1)
  })
})

describe('a preset flip', () => {
  it('follows the live preset both ways', () => {
    const renderer = stubRenderer()
    const state = createEditionState(classic, DEFAULT_SETTINGS)
    const stop = attachEditionTone(renderer, state)
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping)

    state.setLook(anniversary)
    expect(renderer.toneMapping).toBe(TONE_MAPPING_BY_ID[anniversary.render.toneMapping])
    expect(renderer.toneMappingExposure).toBe(anniversary.render.exposure)

    // Back, and all the way back — the thing a toggle has to be able to do.
    state.setLook(classic)
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping)
    expect(renderer.toneMappingExposure).toBe(1)

    stop()
    state.setLook(anniversary)
    expect(renderer.toneMapping).toBe(THREE.NoToneMapping)
  })

  it('marks no material for recompilation — it is handed no scene to walk', async () => {
    // A material's `version` is what `needsUpdate = true` increments, so this
    // watches the observable. On its own it is nearly vacuous — `applyEditionRender`
    // has no reference to a scene and could not dirty a material if it wanted
    // to — and that IS the design, so the test is the signature as much as the
    // numbers: the grep below is what stops the scene being threaded back in
    // without somebody reopening DEV-081.
    const materials = [
      new THREE.MeshStandardMaterial(),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      new THREE.ShaderMaterial(),
    ]
    const before = materials.map((m) => m.version)

    const renderer = stubRenderer()
    const state = createEditionState(classic, DEFAULT_SETTINGS)
    attachEditionTone(renderer, state)
    state.setLook(anniversary)
    state.setLook(classic)

    expect(materials.map((m) => m.version)).toEqual(before)

    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../../src/render/tone.ts', import.meta.url), 'utf8')
    // In the prose at the top of the file, not in the code.
    const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//'))
    expect(code.join('\n'), 'render/tone.ts dirties materials — see DEV-081').not.toMatch(
      /needsUpdate|\.traverse\(/,
    )
  })

  it('rests on three still noticing a tone mapping change by itself', async () => {
    // THE assumption. `WebGLRenderer.setProgram` recomputes the per-material
    // tone mapping and `needsProgramChange` compares it against the last one,
    // so a flip recompiles what it has to and nothing else. If a three upgrade
    // ever drops that branch, every fogged material would keep its old program
    // after a flip and the preset would half-apply — which reads as "the tone
    // mapping does not work on the terrain" and is very hard to find from
    // there.
    //
    // Pinned against the SHIPPED BUILD rather than against a belief, because
    // this repo upgrades dependencies one at a time with a measured result
    // (CLAUDE.md, process) and this is the measurement for `three`.
    const { readFile } = await import('node:fs/promises')
    const three = await readFile(
      new URL('../../node_modules/three/build/three.module.js', import.meta.url),
      'utf8',
    )
    expect(three).toContain('materialProperties.toneMapping !== toneMapping')
    // And the exposure is a uniform pushed on every draw, not a define — which
    // is why an exposure slider needs no recompile at all.
    expect(three).toContain("'toneMappingExposure', _this.toneMappingExposure")
  })
})

describe('what is NOT tone-mapped', () => {
  // The line, from `render/tone.ts`: a surface showing a canvas-drawn UI
  // texture, or one that exists to modify the frame rather than to be in the
  // world, is not tone-mapped.
  //
  // Asserted as a grep over the source rather than by building the materials,
  // because building the HUD needs a DOM and a canvas and this suite runs on
  // `environment: 'node'`. Crude, and it catches the thing that actually goes
  // wrong: somebody adds a panel and does not think about the curve.
  const read = async (path: string): Promise<string> => {
    const { readFile } = await import('node:fs/promises')
    return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
  }
  const count = (source: string, needle: string): number => source.split(needle).length - 1

  it('exempts at least as many surfaces as each file draws canvases for', () => {
    // A canvas texture is the tell: it is a picture somebody drew in sRGB, and
    // there is no reading of "tone map the UI text" that is right. So every
    // `new THREE.CanvasTexture(` in these files has to be matched by a
    // `toneMapped: false`, and adding a panel without one fails here.
    return Promise.all(
      [
        'src/render/hud.ts',
        // The pause plate, results, briefing, the checklist, the perf and code
        // plates and the credits roll build their canvases through this file
        // (UI-1), so the one exemption here is every one of theirs.
        'src/render/ui-plate.ts',
        'src/render/title.ts',
        'src/render/hangar.ts',
      ].map(async (path) => {
        const source = await read(path)
        const canvases = count(source, 'new THREE.CanvasTexture(')
        expect(canvases, `${path} draws no canvas — has it moved?`).toBeGreaterThan(0)
        expect(count(source, 'toneMapped: false'), path).toBeGreaterThanOrEqual(canvases)
      }),
    )
  })

  it('exempts the two comfort overlays, which modify the frame', async () => {
    // Neither is a canvas; both are the player's own setting, at an authored
    // colour chosen against a frame rather than lit by one. A tone curve moving
    // them on a preset flip would be a comfort setting changing itself.
    for (const path of ['src/render/vignette.ts', 'src/render/horizon.ts']) {
      expect(await read(path), path).toContain('toneMapped: false')
    }
  })

  it('does NOT exempt the sky, which is scene radiance and takes the curve', async () => {
    // The counterweight, and the reason the rule is a line rather than a list.
    // The sky is the colour distant terrain fades INTO (DEV-030); exempt it
    // while the terrain takes the curve and the two disagree about what happens
    // above 1.0 — which reopens, at the sunward bearing where the sun glow
    // lives, exactly the horizon seam that row closed.
    const source = await read('src/render/sky.ts')
    expect(source).toContain('toneMapped: true')
    expect(count(source, 'toneMapped: false')).toBe(0)
  })
})
