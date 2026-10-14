// tests/unit/edition-content.test.ts — the presets are a gate, and Classic is
// what it says it is.
//
// docs/plan/ANNIVERSARY.md §0.2: the preset is content, not code, and the JSON
// schema is a GATE — `additionalProperties: false` at every level, so a feature
// that grows a tuning key has to declare it in the schema, in
// `src/content/edition-schema.ts`, and in BOTH preset files. This is the test
// that makes that sentence true rather than aspirational (the level schema
// went unvalidated for the life of the extractor and declared keys it did not
// have; `level-schema-validates.test.ts` tells that story).
//
// The second half is the invariant the whole Classic/Anniversary split rests
// on: **Classic has every flag off.** If a Classic flag ever comes up true, the
// "faithful" preset has quietly stopped being the ledger, and no other test
// would notice, because every Anniversary feature is render-side and the sim
// suite cannot see it.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyVrOverrides,
  EDITION_IDS,
  type Edition,
  editionFeatures,
  validateEdition,
} from '@/content/edition-schema'
import { editionJson as read } from './helpers/content'
import { createValidator, type SchemaNode } from './helpers/json-schema'

const DIR = 'content/editions'
const schema = JSON.parse(fs.readFileSync(path.join(DIR, '_schema.json'), 'utf8')) as SchemaNode
const validate = createValidator(schema)

const presetFiles = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .sort()

describe('every preset validates against _schema.json', () => {
  it('finds exactly the two presets the settings know about', () => {
    // A third file here is a preset the menu cannot reach; a missing one is a
    // setting that loads nothing. Either way the two lists have to agree.
    expect(presetFiles.map((f) => f.replace('.json', ''))).toEqual([...EDITION_IDS].sort())
  })

  for (const f of presetFiles) {
    it(`${f} validates against the schema`, () => {
      const errs: string[] = []
      validate(schema, read(f.replace('.json', '')), f, errs)
      expect(errs, errs.join('\n')).toEqual([])
    })

    it(`${f} passes the runtime check the loader runs`, () => {
      const id = f.replace('.json', '')
      expect(validateEdition(read(id)).id).toBe(id)
    })
  }
})

describe('the schema is a gate, not a description', () => {
  it('rejects a tuning key nobody declared', () => {
    // The guard on the guard: what needs asserting is that running it REFUSES
    // something, not that it passes the files it was written from.
    const e = read('anniversary') as unknown as { fx: { motes: Record<string, unknown> } }
    e.fx.motes.densityNobodyDeclared = 40
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('densityNobodyDeclared')
  })

  it('rejects a preset missing a feature block', () => {
    const e = read('classic') as unknown as { cockpit: Record<string, unknown> }
    delete e.cockpit.shake
    const errs: string[] = []
    validate(schema, e, 'classic', errs)
    expect(errs.join('\n')).toContain('missing required "shake"')
  })

  it('rejects a tone mapping three.js does not have', () => {
    const e = read('anniversary') as unknown as { render: { toneMapping: string } }
    e.render.toneMapping = 'filmic-ultra'
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('"filmic-ultra" is not one of')
  })

  it('rejects a haze range of zero, which would be a NaN in every fragment', () => {
    // DEV-082. The shader is handed 1/range; a zero there multiplies an
    // infinity by a zero strength, and a NaN in `outgoingLight` is a BLACK
    // terrain with nothing in the console. `exclusiveMinimum` is in the
    // validator for this one key — see `tests/unit/helpers/json-schema.ts`.
    const e = read('anniversary') as unknown as { render: { haze: { range: number } } }
    e.render.haze.range = 0
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('is not greater than 0')
  })

  it('rejects a cabin lamp with a distance of zero', () => {
    // DEV-088. `distance` is the ONLY thing confining a cabin light to the
    // cabin — three has no per-object light mask, so a layer would turn the
    // lamp off rather than scope it (DEV-043). A zero there is three's "no
    // cutoff", which quietly lights the whole island from inside the cockpit.
    const e = read('anniversary') as unknown as {
      cockpit: { lighting: { fill: { distance: number } } }
    }
    e.cockpit.lighting.fill.distance = 0
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('is not greater than 0')
  })

  it('rejects a cabin lamp key nobody declared', () => {
    const e = read('anniversary') as unknown as {
      cockpit: { lighting: { dash: Record<string, unknown> } }
    }
    e.cockpit.lighting.dash.angleNobodyDeclared = 0.4
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('angleNobodyDeclared')
  })

  it('rejects a body palette missing a colour', () => {
    const e = read('anniversary') as unknown as {
      cockpit: { body: { palette: Record<string, unknown> } }
    }
    delete e.cockpit.body.palette.glove
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('missing required "glove"')
  })

  it('rejects a bloom key nobody declared', () => {
    // DEV-091. The gate again, on the newest block: a fifth bloom number has to
    // be declared here, in `edition-schema.ts` and in BOTH presets, or it is a
    // number `src/` reads that Classic has never heard of.
    const e = read('anniversary') as unknown as { render: { bloom: Record<string, unknown> } }
    e.render.bloom.kneeNobodyDeclared = 0.2
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('kneeNobodyDeclared')
  })

  it('rejects a bloom resolutionScale above 1', () => {
    // DEV-091. `UnrealBloomPass.setSize` halves whatever it is handed, so 1 is
    // already the half-res chain of ANNIVERSARY.md §3.2; above 1 asks for a bloom
    // pyramid LARGER than the frame, which costs more than the frame does and
    // buys nothing the composite can resolve.
    const e = read('anniversary') as unknown as {
      render: { bloom: { resolutionScale: number } }
    }
    e.render.bloom.resolutionScale = 2
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('above the maximum 1')
  })

  it('rejects a haze strength outside 0..1', () => {
    // Above 1 the tint would overshoot past itself and the colour would leave
    // the gamut on the far side — which renders as a channel clamping and
    // looks like a tone mapping bug rather than a tuning one.
    const e = read('anniversary') as unknown as { render: { haze: { strength: number } } }
    e.render.haze.strength = 1.4
    const errs: string[] = []
    validate(schema, e, 'anniversary', errs)
    expect(errs.join('\n')).toContain('above the maximum 1')
  })
})

describe('Classic is the ledger, and Anniversary is not empty', () => {
  it('has EVERY Classic flag off — the whole meaning of the word', () => {
    const classic = read('classic')
    for (const [where, feature] of editionFeatures(classic)) {
      expect(feature.enabled, `classic ${where}`).toBe(false)
    }
    expect(classic.render.toneMapping).toBe('none')
    expect(classic.render.exposure).toBe(1)
    // And Classic's haze is a no-op by its NUMBERS, not only by its flag —
    // DEV-082. The flag is what the code reads; these are what would happen if
    // somebody flipped it by hand to see, and the answer has to be "nothing".
    expect(classic.render.haze.strength).toBe(0)
    expect(classic.render.haze.desaturate).toBe(0)
  })

  it('has at least one Anniversary flag on, or the preset is a label', () => {
    const on = editionFeatures(read('anniversary')).filter(([, f]) => f.enabled)
    expect(on.length).toBeGreaterThan(0)
  })

  it('refuses a preset whose id is not one of the two, with the list in the message', () => {
    const e = { ...read('classic'), id: 'remaster' } as unknown as Edition
    expect(() => validateEdition(e)).toThrow(/classic, anniversary/)
  })

  it('refuses a feature block without its flag, naming the block', () => {
    const e = read('classic') as unknown as { audio: { speedCurves: unknown } }
    e.audio.speedCurves = { note: 'flag missing' }
    expect(() => validateEdition(e as unknown as Edition)).toThrow(/audio\.speedCurves\.enabled/)
  })

  it('refuses a hand-edited hole in the haze, at LOAD rather than at frame 400', () => {
    // The runtime check, not the schema — this is the one that runs over
    // whatever `import.meta.glob` handed back. A missing `range` reaches the
    // shader as a NaN and the terrain goes black; a message with the key in it
    // is the difference between a minute and an afternoon. DEV-082.
    const e = read('anniversary') as unknown as { render: { haze: Record<string, unknown> } }
    delete e.render.haze.range
    expect(() => validateEdition(e as unknown as Edition)).toThrow(/render\.haze\.range/)

    const tintless = read('anniversary') as unknown as { render: { haze: Record<string, unknown> } }
    tintless.render.haze.tint = [0.5, 0.5]
    expect(() => validateEdition(tintless as unknown as Edition)).toThrow(/render\.haze\.tint/)
  })

  it('refuses a hand-edited hole in the cabin, naming the key — DEV-088', () => {
    // The two shapes that fail SILENTLY. A missing `decay` reaches three's
    // punctual-light maths as `undefined`, and `pow(x, undefined)` is NaN — so
    // every lit fragment in the game goes black with nothing in the console,
    // which is the same failure shape as the haze's missing `range` above. A
    // hole in the palette is a `THREE.Color` of NaN, and a pilot who renders
    // black is a much longer afternoon than a message with the key in it.
    const decayless = read('anniversary') as unknown as {
      cockpit: { lighting: { dash: Record<string, unknown> } }
    }
    delete decayless.cockpit.lighting.dash.decay
    expect(() => validateEdition(decayless as unknown as Edition)).toThrow(
      /cockpit\.lighting\.dash\.decay/,
    )

    const paintless = read('anniversary') as unknown as {
      cockpit: { body: { palette: Record<string, unknown> } }
    }
    paintless.cockpit.body.palette.suit = [0.1, 0.1]
    expect(() => validateEdition(paintless as unknown as Edition)).toThrow(
      /cockpit\.body\.palette\.suit/,
    )
  })

  it('refuses a lamp that SUBTRACTS light — DEV-088', () => {
    // three will happily do it, and a preset that darkens the cabin by asking
    // for a lamp gets diagnosed as a shader bug.
    const e = read('anniversary') as unknown as {
      cockpit: { lighting: { fill: { intensity: number } } }
    }
    e.cockpit.lighting.fill.intensity = -0.4
    expect(() => validateEdition(e as unknown as Edition)).toThrow(
      /cockpit\.lighting\.fill\.intensity/,
    )
  })

  it('refuses a hand-edited hole in the sea’s density ladder — DEV-183', () => {
    // The failure is silent everywhere downstream: `subdivideAt` clamps, so an
    // empty list is 2016's geometry on a preset that asked for eight, and a
    // fractional rung reaches `subdivideTriangleSoup` as a `Float32Array` of a
    // non-integer length. Neither throws anywhere a person would look.
    const empty = read('anniversary') as unknown as {
      terrain: { ocean: { subdivisionByLod: unknown } }
    }
    empty.terrain.ocean.subdivisionByLod = []
    expect(() => validateEdition(empty as unknown as Edition)).toThrow(
      /terrain\.ocean\.subdivisionByLod/,
    )

    const fractional = read('anniversary') as unknown as {
      terrain: { ocean: { subdivisionByLod: unknown } }
    }
    fractional.terrain.ocean.subdivisionByLod = [8, 4, 2.5]
    // The INDEX is in the message, because a ladder of six is a haystack.
    expect(() => validateEdition(fractional as unknown as Edition)).toThrow(
      /terrain\.ocean\.subdivisionByLod\[2\]/,
    )

    const zero = read('anniversary') as unknown as {
      terrain: { ocean: { subdivisionByLod: unknown } }
    }
    zero.terrain.ocean.subdivisionByLod = [8, 0]
    expect(() => validateEdition(zero as unknown as Edition)).toThrow(
      /terrain\.ocean\.subdivisionByLod\[1\]/,
    )
  })

  it('takes a ladder that RISES with distance, because that is a measurement', () => {
    // Deliberately legal. `[1, 8]` says "the near sea is not where the vertices
    // are going", which is a thing someone may want to try in a headset; the
    // schema has an opinion about the shape, not about the answer.
    const e = read('anniversary') as unknown as {
      terrain: { ocean: { subdivisionByLod: unknown } }
    }
    e.terrain.ocean.subdivisionByLod = [1, 8]
    expect(() => validateEdition(e as unknown as Edition)).not.toThrow()
  })
})

// ── DEV-263: the VR-only half of a preset ──────────────────────────────────
//
// Matt, 2026-09-21, after the first worn A/B this project has taken: *"off in
// VR, on in flat."* The measurement behind it, same mission and resolution and
// minute: Classic held 96.9 % of its frames at 90 Hz, Anniversary 75.0 %. Flat,
// the same build runs ~178 fps with 1.02 ms of GPU, so the cheaper look is
// worth having in the headset and would only cost look on a monitor.
describe('the VR override list', () => {
  it('names only real features, and every one is ON in flat', () => {
    // Both halves matter. A path that is not a feature would disable NOTHING
    // and the only symptom is a frame rate. A path that is already off is a
    // line that reads like a saving and is not one — this is the assertion
    // that keeps the list honest as the presets move.
    const anniversary = read('anniversary')
    const known = new Map(editionFeatures(anniversary))
    const disable = anniversary.vr?.disable ?? []
    expect(disable.length, 'anniversary has a VR list').toBeGreaterThan(0)
    for (const path of disable) {
      expect(known.has(path), `${path} is a feature`).toBe(true)
      expect(
        known.get(path)?.enabled,
        `${path} is on in flat, so turning it off buys something`,
      ).toBe(true)
    }
  })

  it('applies to a COPY, so the flat preset keeps its features', () => {
    // The bug this exists for: a shallow copy leaves the two presets SHARING
    // the feature objects, so writing `enabled: false` on the VR one turns the
    // flat one off too — and every test that looks at one preset at a time
    // passes anyway. Asserted on the base AFTER the override is built.
    const base = read('anniversary')
    const vr = applyVrOverrides(base)
    expect(vr).not.toBe(base)
    const flat = new Map(editionFeatures(base))
    const worn = new Map(editionFeatures(vr))
    for (const path of base.vr?.disable ?? []) {
      expect(worn.get(path)?.enabled, `${path} off in VR`).toBe(false)
      expect(flat.get(path)?.enabled, `${path} still on in flat`).toBe(true)
    }
  })

  it('changes NOTHING else: only the disable list and the override list move', () => {
    // The whole argument for LISTS rather than a deep-partial preset. If this
    // ever fails, `vr` has grown into a second preset and the claim that "what
    // does VR look like" is answerable by reading two lists is false. Since
    // DEV-934 the second list is `vr.override`'s named fields; nothing it does
    // not name may differ.
    const base = read('anniversary')
    const vr = applyVrOverrides(base)
    const disabled = new Set(base.vr?.disable ?? [])
    const flat = new Map(editionFeatures(base))
    for (const [path, feature] of editionFeatures(vr)) {
      if (disabled.has(path)) continue
      expect(feature.enabled, `${path} untouched`).toBe(flat.get(path)?.enabled)
    }
    // Put every named VR value back to its flat value on a copy; what is left
    // must be the flat preset but for `enabled`.
    const restored = structuredClone(vr) as Edition
    const restoredFeatures = new Map(editionFeatures(restored))
    for (const [path, fields] of Object.entries(base.vr?.override ?? {})) {
      const into = restoredFeatures.get(path) as unknown as Record<string, unknown>
      const from = flat.get(path) as unknown as Record<string, unknown>
      for (const key of Object.keys(fields)) if (key !== 'note') into[key] = from[key]
    }
    const strip = (e: Edition) => JSON.stringify(e, (k, v) => (k === 'enabled' ? undefined : v))
    expect(strip(restored)).toBe(strip(base))
  })

  it('sets every named VR value, and leaves the flat preset alone (DEV-934)', () => {
    const base = read('anniversary')
    const before = JSON.stringify(base)
    const vr = new Map(editionFeatures(applyVrOverrides(base)))
    const entries = Object.entries(base.vr?.override ?? {})
    expect(entries.length, 'anniversary has VR values').toBeGreaterThan(0)
    for (const [path, fields] of entries) {
      const worn = vr.get(path) as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(fields)) {
        if (key === 'note') continue
        expect(worn[key], `${path}.${key} in VR`).toEqual(value)
      }
    }
    expect(JSON.stringify(base), 'the flat preset was not written to').toBe(before)
  })

  it('returns the SAME OBJECT when there is nothing to do', () => {
    // `game/edition.ts` compares by identity to decide whether entering VR has
    // to notify every subscriber. Classic has no `vr` block, so entering VR on
    // Classic must not rebuild a single material.
    const classic = read('classic')
    expect(applyVrOverrides(classic)).toBe(classic)
  })

  it('refuses a path that is not a feature, and a repeated one', () => {
    const base = read('anniversary')
    const bad = { ...base, vr: { disable: ['render.thereIsNoSuchThing'] } } as Edition
    expect(() => validateEdition(bad)).toThrow(/not one of editionFeatures/)
    const dup = { ...base, vr: { disable: ['render.haze', 'render.haze'] } } as Edition
    expect(() => validateEdition(dup)).toThrow(/repeats a path/)
  })

  it('the cockpit point lights are off in BOTH presets', () => {
    // Matt: "we don't need the cockpit point lights." Global, not a VR
    // override — and a light COUNT is field #36 of three's program cache key
    // (DEV-186), so this is also two fewer shader variants everywhere.
    for (const id of EDITION_IDS) {
      expect(read(id).cockpit.lighting.enabled, `${id} cockpit lighting`).toBe(false)
    }
  })
})
