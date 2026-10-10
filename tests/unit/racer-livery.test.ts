// tests/unit/racer-livery.test.ts — the AI racers are solid, and each wears its
// own colour. DEV-350.
//
// Matt: *"replace ai 'ghosts' as ai 'racers' - solid shaded, different
// coloration than the player's orange hoverjet."* Every claim below is checked
// against something outside the code under test:
//
//   * the METHOD against 2016: `GhostRacer.prefab`'s blue hull is the player's
//     orange with only the HSL hue moved — two FBX triples, read off the files
//     (`render/racer-livery.ts` cites them), and the assertion is about THEM;
//   * the CLASSIFIER against the shipped hull, swept vertex by vertex whenever
//     the GLB is on disk: the thresholds must sit in an empty gap, and the
//     count of what they select is the census the module's header quotes;
//   * the PALETTE against the player's colour, by the same classifier that
//     paints — a racer colour the painter would take for livery would be one a
//     player could take for their own ship — and, since the rainbow (the
//     DEV-350 follow-up), by distance in OKLab under `int_01`'s own sun, read
//     off the level; and since DEV-462, under the 2016 sun of EVERY mission a
//     racer flies, each read off its own level;
//   * the SHADOW against the table `render/shadows.ts` already carries, through
//     the same route the Edition page takes: a flip.
//
// The shipped-hull block is guarded on the gitignored GLB, with the disk work
// inside the `it`. Its loud counterpart is `hover-glow.test.ts`'s — that file's
// guard names the same GLB, and one counterpart per missing asset keeps a
// hydrated tree's skip count where it was.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import {
  applyVrOverrides,
  type Edition,
  EditionSchemaError,
  validateEdition,
  withFeatureOverrides,
} from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { dressRacerHull, racerMaterial, racesIn } from '@/game/racers'
import { HOVER_GLOW_NAMES } from '@/render/hover-glow'
import { LAMBERT1_COLOR_SRGB } from '@/render/lambert1'
import {
  GHOST_RACER_BLUE_SRGB,
  isLivery,
  LIVERY_HUE_TOLERANCE_DEG,
  LIVERY_MIN_SATURATION,
  LIVERY_PANEL_SRGB,
  linearToSrgb,
  paintLivery,
  paletteColour,
  racerLook,
  repaintSrgb,
  rgbToHsl,
  type Srgb,
  srgbHex,
} from '@/render/racer-livery'
import {
  ALL_CASTERS,
  createSunShadows,
  type ShadowFlags,
  shadowCastersFor,
  shadowFlagsFor,
} from '@/render/shadows'
import { srgbToLinear } from '@/render/unity-space'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const anniversary = anniversaryJson as unknown as Edition
const classic = classicJson as unknown as Edition

const HULL_GLB = 'public/assets/ships/hoverjet-exterior.glb'
const haveHull = fs.existsSync(HULL_GLB)

/** Shortest hue distance, degrees. */
const hueGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

const PANEL_HUE = rgbToHsl(LIVERY_PANEL_SRGB)[0]

// ── colour as an eye sees it: OKLab, lit (DEV-350 follow-up) ───────────────

/** OKLab (Ottosson, 2020) of a LINEAR sRGB triple. Euclidean distance in it is ΔE. */
const oklab = (lin: readonly number[]): [number, number, number] => {
  const [r, g, b] = lin as [number, number, number]
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}
const INT01_LIGHT = (
  int01 as unknown as { lighting: { sun: { colorLinear: number[]; colorGamma: number[] } } }
).lighting.sun
/**
 * `int_01_hoverJet`'s sun as the palette was DESIGNED against it (DEV-350):
 * the raw `m_Color` drawn as if linear, which is the port's rule until DEV-454
 * and `?sunlight=port` since. The level's own `colorGamma`, not a copy. Every
 * number this file and the preset note quote was measured under this light.
 */
const INT01_SUN = INT01_LIGHT.colorGamma
/**
 * The same sun as the frame DRAWS it since DEV-454 — Unity 5.4's rule, a much
 * deeper orange (hue 1 / 0.43 / 0.19). The level's own `colorLinear`.
 */
const INT01_SUN_2016 = INT01_LIGHT.colorLinear
const WHITE_LIGHT = [1, 1, 1]
/** The lights the rainbow was designed under (the DEV-350 follow-up). */
const LIGHTS: readonly [string, readonly number[]][] = [
  ['white light', WHITE_LIGHT],
  ["int_01's sun", INT01_SUN],
]
/**
 * DEV-462: the 2016 sun (DEV-454's `colorLinear`) of EVERY mission a racer
 * flies, straight off the extracted level JSON — `racesIn` is the racer
 * module's own question, so a vehicle that starts racing brings its missions'
 * suns in with it. int_01's alone was the palette's check until DEV-462, and
 * it was the wrong sample: `rookie_01`'s sun has almost no blue in it (0.045
 * against 0.55 red), so green and cyan, which differ mainly in blue, fell to
 * 0.039 there while int_01 read 0.116.
 */
const RACING_SUNS_2016: readonly [string, readonly number[]][] = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map(
    (f) =>
      JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')) as {
        id: string
        vehicle: string
        lighting: { sun: { colorLinear: number[] } }
      },
  )
  .filter((l) => racesIn(l.vehicle))
  .map((l) => [`${l.id}'s 2016 sun`, l.lighting.sun.colorLinear])
/** Every light the palette is held to since DEV-462. */
const ALL_LIGHTS: readonly [string, readonly number[]][] = [...LIGHTS, ...RACING_SUNS_2016]
/**
 * An sRGB albedo as that light shows it: linear albedo times the light, the
 * light scaled to unit luminance so that only its TINT moves the colour. Both
 * colours of a comparison go through the same light.
 */
const litBy = (c: Srgb, light: readonly number[]): number[] => {
  const y =
    0.2126 * (light[0] as number) + 0.7152 * (light[1] as number) + 0.0722 * (light[2] as number)
  return c.map((v, i) => (srgbToLinear(v) * (light[i] as number)) / y)
}
const distance3 = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )
const deltaE = (a: Srgb, b: Srgb, light: readonly number[]): number =>
  distance3(oklab(litBy(a, light)), oklab(litBy(b, light)))
/** X: no racer's colour within this ΔE of the player's orange, under either light. */
const CLEAR_OF_ORANGE = 0.15
/** DEV-350's magenta, its palette's nearest colour to the orange under int_01's sun. */
const DEV350_MAGENTA: Srgb = [0.7059, 0.1938, 0.5352]
/** Machado, Oliveira & Fernandes (2009), severity 1.0, linear rgb. */
const PROTAN = [
  [0.152286, 1.052583, -0.204868],
  [0.114503, 0.786281, 0.099216],
  [-0.003882, -0.048116, 1.051998],
]
const DEUTAN = [
  [0.367322, 0.860646, -0.227968],
  [0.280085, 0.672501, 0.047413],
  [-0.01182, 0.04294, 0.968881],
]
const TRITAN = [
  [1.255528, -0.076749, -0.178779],
  [-0.078411, 0.930809, 0.147602],
  [0.004733, 0.691367, 0.3039],
]
/** ΔE between two colours as a colour-blind eye sees them under int_01's sun. */
const cvdDeltaE = (a: Srgb, b: Srgb, m: readonly (readonly number[])[]): number => {
  const see = (c: Srgb) => {
    const v = litBy(c, INT01_SUN)
    return m.map((row) =>
      Math.max(
        0,
        (row[0] as number) * (v[0] as number) +
          (row[1] as number) * (v[1] as number) +
          (row[2] as number) * (v[2] as number),
      ),
    )
  }
  return distance3(oklab(see(a)), oklab(see(b)))
}

/** Colours off 2016's orange hull, to four places — the FBX's, and the grey the GLB's own. */
const ACCENT_2016: Srgb = [0.8256, 0.3376, 0.0279]
const WARM_GREY_2016: Srgb = [0.7319, 0.7041, 0.6864]
const CYAN_2016: Srgb = [0.8037, 0.9997, 0.9997]
const HULL_GREY_2016: Srgb = [0.7059, 0.7059, 0.7059]

// ── 1. the method is 2016's ────────────────────────────────────────────────

describe('2016 painted its own AI racer by turning the hue', () => {
  it("GhostRacer's blue is the player's orange with ONLY the hue moved", () => {
    const [ho, so, lo] = rgbToHsl(LIVERY_PANEL_SRGB)
    const [hb, sb, lb] = rgbToHsl(GHOST_RACER_BLUE_SRGB)
    // Saturation and lightness to the FBX's own precision; the hue half a turn
    // away. This is the claim the whole repaint rests on, so it is asserted on
    // 2016's numbers rather than on anything this port computed.
    expect(sb).toBeCloseTo(so, 7)
    expect(lb).toBeCloseTo(lo, 7)
    expect(hueGap(ho, hb)).toBeGreaterThan(170)
    expect(ho).toBeCloseTo(25.2, 1)
    expect(hb).toBeCloseTo(210.8, 1)
  })

  it('lands the panel exactly on the target, and moves every shade by the same turn', () => {
    for (const target of anniversary.render.racerLivery.palette as readonly Srgb[]) {
      const panel = repaintSrgb(LIVERY_PANEL_SRGB, target)
      for (let k = 0; k < 3; k++) expect(panel[k]).toBeCloseTo(target[k] as number, 9)
    }
    // The accent is 1.9 degrees off the panel; turned onto 2016's blue it must
    // stay 1.9 degrees off it, and stop being orange.
    const accent = repaintSrgb(ACCENT_2016, GHOST_RACER_BLUE_SRGB)
    const offBefore = rgbToHsl(ACCENT_2016)[0] - PANEL_HUE
    const offAfter = rgbToHsl(accent)[0] - rgbToHsl(GHOST_RACER_BLUE_SRGB)[0]
    expect(offAfter).toBeCloseTo(offBefore, 6)
    expect(isLivery(accent)).toBe(false)
  })

  it('paints a grey livery grey, whatever the hue arithmetic did', () => {
    const charcoal: Srgb = [0.15, 0.15, 0.15]
    const out = repaintSrgb(ACCENT_2016, charcoal)
    expect(out[0]).toBeCloseTo(out[1], 9)
    expect(out[1]).toBeCloseTo(out[2], 9)
  })
})

// ── 2. which vertices are livery ──────────────────────────────────────────

describe('the livery is the orange and nothing else', () => {
  it('takes the panel and the accent, and leaves the greys and the cyan', () => {
    expect(isLivery(LIVERY_PANEL_SRGB)).toBe(true)
    expect(isLivery(ACCENT_2016)).toBe(true)
    // The warm grey shares the orange's HUE; only saturation separates it.
    expect(hueGap(rgbToHsl(WARM_GREY_2016)[0], PANEL_HUE)).toBeLessThan(LIVERY_HUE_TOLERANCE_DEG)
    expect(isLivery(WARM_GREY_2016)).toBe(false)
    expect(isLivery(HULL_GREY_2016)).toBe(false)
    expect(isLivery(CYAN_2016)).toBe(false)
  })
})

// ── 3. the paint ──────────────────────────────────────────────────────────

/** A hull in the GLB's own layout: RGBA, normalised uint16, LINEAR. */
const hullMesh = (colours: readonly Srgb[]): THREE.Mesh => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      colours.flatMap((_, i) => [i, 0, 0]),
      3,
    ),
  )
  const rgba = new Uint16Array(colours.length * 4)
  colours.forEach((c, i) => {
    for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(srgbToLinear(c[k] as number) * 65535)
    rgba[i * 4 + 3] = 65535
  })
  geometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4, true))
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true }))
}

const srgbAt = (attr: THREE.BufferAttribute, i: number): Srgb => [
  linearToSrgb(attr.getX(i)),
  linearToSrgb(attr.getY(i)),
  linearToSrgb(attr.getZ(i)),
]

describe('paintLivery', () => {
  it('repaints the livery vertices, and not one bit of anything else', () => {
    const mesh = hullMesh([LIVERY_PANEL_SRGB, HULL_GREY_2016, ACCENT_2016, CYAN_2016])
    const before = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    expect(paintLivery(mesh, GHOST_RACER_BLUE_SRGB)).toBe(2)
    const after = mesh.geometry.getAttribute('color') as THREE.BufferAttribute
    const panel = srgbAt(after, 0)
    for (let k = 0; k < 3; k++) expect(panel[k]).toBeCloseTo(GHOST_RACER_BLUE_SRGB[k] as number, 4)
    expect(isLivery(srgbAt(after, 2))).toBe(false)
    for (const i of [1, 3]) {
      expect(after.getX(i)).toBe(before.getX(i))
      expect(after.getY(i)).toBe(before.getY(i))
      expect(after.getZ(i)).toBe(before.getZ(i))
    }
    // The item size is the source's, alpha included: three keys `vertexAlphas`
    // into the program, so a hull with a vec3 here would compile apart from
    // the player's.
    expect(after.itemSize).toBe(4)
    expect(after.getW(0)).toBe(1)
  })

  it('never writes into the attribute it read — a second hull sharing it stays orange', () => {
    // Trap 19's guard, the shape it takes for a buffer: paint ONE and assert
    // the OTHER did not move. Two loads of one GLB do not share today; a cache
    // in front of the loader would make them, and the player's hull would be
    // the one repainted.
    const mine = hullMesh([LIVERY_PANEL_SRGB])
    const theirs = new THREE.Mesh(mine.geometry.clone(), mine.material)
    theirs.geometry.setAttribute('color', mine.geometry.getAttribute('color'))
    paintLivery(mine, GHOST_RACER_BLUE_SRGB)
    expect(mine.geometry.getAttribute('color')).not.toBe(theirs.geometry.getAttribute('color'))
    const still = srgbAt(theirs.geometry.getAttribute('color') as THREE.BufferAttribute, 0)
    expect(isLivery(still)).toBe(true)
  })
})

// ── 4. the two looks ──────────────────────────────────────────────────────

/** A hull with a wing: the hull mesh, and the wing's two parts by their names. */
const artWithWing = () => {
  const art = new THREE.Group()
  const hullMat = new THREE.MeshStandardMaterial({ name: 'lambert1' })
  const projMat = new THREE.MeshStandardMaterial({ name: 'Projector04_Mat' })
  const glowMat = new THREE.MeshStandardMaterial({ name: 'hover-glow' })
  const hull = new THREE.Mesh(new THREE.BufferGeometry(), hullMat)
  const wing = new THREE.Group()
  wing.name = 'hover-glow'
  const projectors = new THREE.Mesh(new THREE.BufferGeometry(), projMat)
  projectors.name = HOVER_GLOW_NAMES[0]
  const glow = new THREE.Mesh(new THREE.BufferGeometry(), glowMat)
  glow.name = HOVER_GLOW_NAMES[1]
  wing.add(projectors, glow)
  art.add(hull, wing)
  return { art, hull, projectors, glow, hullMat, projMat, glowMat }
}

describe('racerLook', () => {
  it('switches the hull and the projectors between their own and the hologram, never the glow', () => {
    const r = artWithWing()
    const holo = racerMaterial()
    const look = racerLook(r.art, holo, true)
    expect([r.hull.material, r.projectors.material, r.glow.material]).toEqual([
      r.hullMat,
      r.projMat,
      r.glowMat,
    ])
    look.setSolid(false)
    expect(look.solid).toBe(false)
    expect([r.hull.material, r.projectors.material, r.glow.material]).toEqual([
      holo,
      holo,
      r.glowMat,
    ])
    // And back, because a switch that only goes one way is a deletion.
    look.setSolid(true)
    expect([r.hull.material, r.projectors.material]).toEqual([r.hullMat, r.projMat])
    expect(look.solidMaterials).toEqual([r.hullMat, r.projMat])
    expect(look.shadowMeshes).toEqual([r.hull, r.projectors, r.glow])
  })

  it('starts in the look it is asked for', () => {
    const r = artWithWing()
    const holo = racerMaterial()
    racerLook(r.art, holo, false)
    expect(r.hull.material).toBe(holo)
    expect(r.projectors.material).toBe(holo)
    expect(r.glow.material).toBe(r.glowMat)
  })
})

// ── 5. on the shipped hull ────────────────────────────────────────────────

const loadHull = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(HULL_GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  })
}

const colourOf = (root: THREE.Object3D): THREE.BufferAttribute => {
  let out: THREE.BufferAttribute | null = null
  root.traverse((n) => {
    const m = n as THREE.Mesh
    if (m.isMesh) out = m.geometry.getAttribute('color') as THREE.BufferAttribute
  })
  if (!out) throw new Error('racer-livery.test: the hull carries no COLOR_0')
  return out
}

describe.skipIf(!haveHull)('on the shipped hull', () => {
  it('the thresholds sit in an EMPTY gap, and select the census the module quotes', async () => {
    const attr = colourOf(await loadHull())
    let livery = 0
    let greyMaxS = 0
    let liveryMinS = 1
    let hueLo = 360
    let hueHi = 0
    /** The nearest hue, among SATURATED vertices that are not livery. */
    let otherNearest = 180
    for (let i = 0; i < attr.count; i++) {
      const c = srgbAt(attr, i)
      const [h, s] = rgbToHsl(c)
      const inBand = hueGap(h, PANEL_HUE) <= LIVERY_HUE_TOLERANCE_DEG
      if (isLivery(c)) {
        livery++
        liveryMinS = Math.min(liveryMinS, s)
        hueLo = Math.min(hueLo, h)
        hueHi = Math.max(hueHi, h)
      } else if (inBand) greyMaxS = Math.max(greyMaxS, s)
      else if (s >= LIVERY_MIN_SATURATION)
        otherNearest = Math.min(otherNearest, hueGap(h, PANEL_HUE))
    }
    expect(attr.count).toBe(1144)
    expect(livery).toBe(115)
    // The gap, both sides, with the threshold inside it by a margin.
    expect(greyMaxS).toBeLessThan(0.1)
    expect(liveryMinS).toBeGreaterThan(0.45)
    expect(LIVERY_MIN_SATURATION).toBeGreaterThan(greyMaxS)
    expect(LIVERY_MIN_SATURATION).toBeLessThan(liveryMinS)
    expect(hueLo).toBeGreaterThan(20)
    expect(hueHi).toBeLessThan(26)
    // And the hue band has room on its other side: the only saturated colour
    // that is not livery is the cyan, far past the tolerance.
    expect(otherNearest).toBeGreaterThan(150)
  })

  it('dresses every Anniversary racer in the player material, with no orange left on it', async () => {
    const livery = anniversary.render.racerLivery
    for (let i = 0; i < livery.palette.length; i++) {
      const source = colourOf(await loadHull())
      const art = await loadHull()
      const { look, glow, colour } = await dressRacerHull(art, livery, i, racerMaterial(), false)
      expect(glow).toBeNull()
      expect(colour).toEqual(paletteColour(livery.palette as readonly Srgb[], i))
      expect(look.solid).toBe(true)
      const hull = look.shadowMeshes[0] as THREE.Mesh
      const material = hull.material as THREE.MeshStandardMaterial
      // The player's hull, as `flight.ts` dresses it: the glTF's own material
      // with `lambert1.mat`'s colour, reading the vertex colours, opaque.
      expect(material.vertexColors).toBe(true)
      expect(material.transparent).toBe(false)
      const want = new THREE.Color().setRGB(...LAMBERT1_COLOR_SRGB, THREE.SRGBColorSpace)
      expect(material.color.equals(want)).toBe(true)
      const painted = colourOf(art)
      for (let v = 0; v < painted.count; v++) {
        const was = srgbAt(source, v)
        if (isLivery(was)) {
          expect(isLivery(srgbAt(painted, v)), `racer ${i} vertex ${v}`).toBe(false)
        } else {
          expect(painted.getX(v)).toBeCloseTo(source.getX(v), 6)
          expect(painted.getY(v)).toBeCloseTo(source.getY(v), 6)
          expect(painted.getZ(v)).toBeCloseTo(source.getZ(v), 6)
        }
      }
    }
  })

  it('dresses a Classic racer in the hologram, exactly as before DEV-350', async () => {
    const holo = racerMaterial()
    const art = await loadHull()
    const { look } = await dressRacerHull(art, classic.render.racerLivery, 0, holo, false)
    expect(look.solid).toBe(false)
    art.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) expect((n as THREE.Mesh).material).toBe(holo)
    })
  })
})

// ── 6. the preset ─────────────────────────────────────────────────────────

describe('the preset', () => {
  it('ships solid and casting on Anniversary, in flat AND in VR; Classic is the hologram', () => {
    expect(anniversary.render.racerLivery.enabled).toBe(true)
    expect(anniversary.render.racerLivery.shadow.enabled).toBe(true)
    // DEV-350's cost call: a handful of depth draws, so NOT in `vr.disable`.
    const vr = applyVrOverrides(anniversary).render.racerLivery
    expect(vr.enabled).toBe(true)
    expect(vr.shadow.enabled).toBe(true)
    expect(classic.render.racerLivery.enabled).toBe(false)
    expect(classic.render.racerLivery.shadow.enabled).toBe(false)
  })

  // ── DEV-350 follow-up: a bright rainbow, the orange left out ────────────
  //
  // Matt, 2026-09-25: *"go with bright rainbow colors for our color palette"*.
  // A rainbow puts red and yellow either side of the player's orange, so "clear
  // of the orange" stops being a rule about HUE (DEV-350 kept every colour 60
  // degrees off it) and becomes one about what an eye SEES: distance in OKLab,
  // with the colour and the orange both lit by the same light — white, and
  // `int_01`'s 4-degree sunset sun, which is the light that warms a red toward
  // an orange. X = `CLEAR_OF_ORANGE`, and it is not a taste number: it is where
  // DEV-350's own nearest colour, its magenta, already sat under that sun. No
  // rainbow colour is closer to the player than the palette it replaced put one.

  it('holds itself to every racing mission’s 2016 sun, and that is more than int_01’s', () => {
    // The premise of the two tests below, loud: an empty list would pass them
    // both under white light alone. Named rather than counted, so a new course
    // does not edit this line — int_01 is the one the palette was built on, and
    // rookie_01 is the one DEV-462 found it failing on.
    const names = RACING_SUNS_2016.map(([name]) => name)
    expect(names).toContain("int_01_hoverJet's 2016 sun")
    expect(names).toContain("rookie_01_hoverJet's 2016 sun")
    const distinct = new Set(RACING_SUNS_2016.map(([, rgb]) => rgb.join(',')))
    expect(distinct.size).toBeGreaterThan(1)
    // And it IS the frame's light since DEV-454: int_01's entry is the one the
    // DEV-454 note measured green-cyan against.
    expect(RACING_SUNS_2016).toContainEqual(["int_01_hoverJet's 2016 sun", INT01_SUN_2016])
  })

  it("keeps every racer clear of the player's orange by X = 0.15 in OKLab, in white light and under every racing sun", () => {
    const palette = anniversary.render.racerLivery.palette as readonly Srgb[]
    // X's provenance, measured rather than quoted: DEV-350's magenta.
    expect(deltaE(DEV350_MAGENTA, LIVERY_PANEL_SRGB, INT01_SUN)).toBeCloseTo(CLEAR_OF_ORANGE, 3)
    for (const c of palette) {
      // The painter's own test: a colour it would take for livery is a colour a
      // player could take for their own ship.
      expect(isLivery(c), srgbHex(c)).toBe(false)
      // DEV-462: under every racing mission's 2016 sun too. The violet was
      // 0.115 from the orange under rookie_01's until it stepped toward blue;
      // it is the nearest there now, at 0.160.
      for (const [light, rgb] of ALL_LIGHTS) {
        const d = deltaE(c, LIVERY_PANEL_SRGB, rgb)
        expect(d, `${srgbHex(c)} under ${light}: ${d.toFixed(3)}`).toBeGreaterThanOrEqual(
          CLEAR_OF_ORANGE,
        )
      }
    }
    // And Classic carries the same list: it is what a flip paints.
    expect(classic.render.racerLivery.palette).toEqual(palette)
  })

  it('no two racers alike: every pair at least X apart, in white light and under every racing sun', () => {
    // DEV-462 (Matt: "go with your rec"). Until it, this held under the two
    // lights the rainbow was designed under, and a sibling test RECORDED the
    // shortfall under 2016's sun instead of asserting the bar: green and cyan
    // 0.116 apart on int_01. Across every racing sun it was worse — 0.039 on
    // rookie_01 — so the cyan moved toward blue, and the blue deepened to keep
    // the pair it then made apart. The nearest pair now is green-cyan, 0.161,
    // under rookie_01's sun.
    const palette = anniversary.render.racerLivery.palette as readonly Srgb[]
    const below: string[] = []
    for (let i = 0; i < palette.length; i++) {
      for (let j = i + 1; j < palette.length; j++) {
        for (const [light, rgb] of ALL_LIGHTS) {
          const d = deltaE(palette[i] as Srgb, palette[j] as Srgb, rgb)
          if (d < CLEAR_OF_ORANGE) below.push(`racers ${i}-${j} under ${light}: ${d.toFixed(3)}`)
        }
      }
    }
    expect(below).toEqual([])
  })

  it('is a BRIGHT rainbow in rainbow order — red, yellow, green, cyan, blue, violet — with no orange and no grey', () => {
    const palette = anniversary.render.racerLivery.palette as readonly Srgb[]
    const bands: readonly [string, number, number][] = [
      ['red', 330, 360],
      ['yellow', 55, 70],
      ['green', 90, 150],
      ['cyan', 170, 200],
      ['blue', 200, 240],
      ['violet', 260, 300],
    ]
    expect(palette).toHaveLength(bands.length)
    palette.forEach((c, i) => {
      const [h, s] = rgbToHsl(c)
      const [name, lo, hi] = bands[i] as (typeof bands)[number]
      expect(
        h,
        `racer ${i} is ${name}: ${srgbHex(c)} at ${h.toFixed(1)} deg`,
      ).toBeGreaterThanOrEqual(lo)
      expect(h, `racer ${i} is ${name}`).toBeLessThan(hi)
      // Bright: nothing muted, and nothing grey (DEV-350's charcoal is gone).
      expect(s, `racer ${i} saturation`).toBeGreaterThanOrEqual(0.75)
    })
    // The blue keeps 2016's lineage: GhostRacer's own hue.
    const [ghostHue] = rgbToHsl(GHOST_RACER_BLUE_SRGB)
    expect(hueGap(rgbToHsl(palette[4] as Srgb)[0], ghostHue)).toBeLessThan(0.5)
    expect(new Set(palette.map(srgbHex)).size).toBe(palette.length)
  })

  it('states its cost: to a protanope the red IS the orange, where DEV-350 kept every colour 0.07 clear', () => {
    // The preset note quotes both numbers; this holds them (DEV-027). Machado,
    // Oliveira and Fernandes (2009), full severity, in linear light, under the
    // sun. No rainbow keeps red off orange for a protan eye: it is the price
    // of the ask, recorded rather than hidden.
    const palette = anniversary.render.racerLivery.palette as readonly Srgb[]
    const red = palette[0] as Srgb
    expect(cvdDeltaE(red, LIVERY_PANEL_SRGB, PROTAN)).toBeLessThan(0.035)
    // And the red is the green, for the same eyes: the rainbow's own cost.
    const green = palette[2] as Srgb
    expect(Math.min(cvdDeltaE(red, green, PROTAN), cvdDeltaE(red, green, DEUTAN))).toBeLessThan(
      0.02,
    )
    const dev350: readonly Srgb[] = [
      GHOST_RACER_BLUE_SRGB,
      [0.4646, 0.8062, 0.2938],
      DEV350_MAGENTA,
      [0.3723, 0.8277, 0.8277],
      [0.15, 0.15, 0.15],
    ]
    for (const c of dev350)
      for (const m of [PROTAN, DEUTAN, TRITAN])
        expect(cvdDeltaE(c, LIVERY_PANEL_SRGB, m), srgbHex(c)).toBeGreaterThanOrEqual(0.07)
  })

  it('refuses a palette hole at load, naming it', () => {
    const withPalette = (palette: unknown): Edition =>
      ({
        ...anniversary,
        render: {
          ...anniversary.render,
          racerLivery: { ...anniversary.render.racerLivery, palette },
        },
      }) as Edition
    expect(() => validateEdition(withPalette([]))).toThrow(EditionSchemaError)
    expect(() => validateEdition(withPalette([]))).toThrow(/racerLivery\.palette/)
    expect(() => validateEdition(withPalette([[0.2, 0.3]]))).toThrow(/palette\[0\]/)
    expect(() => validateEdition(withPalette([[0.2, 0.3, Number.NaN]]))).toThrow(/palette\[0\]/)
    expect(() => validateEdition(withPalette([[0.2, 0.3, 1.2]]))).toThrow(/palette\[0\]/)
  })
})

// ── 7. the shadow ─────────────────────────────────────────────────────────

describe('a racer casts only while it is solid', () => {
  it("is the player's hull's row behind the preset's flag", () => {
    expect(shadowFlagsFor('racer-hull', true, 0, ALL_CASTERS)).toEqual({
      cast: true,
      receive: false,
    })
    expect(shadowFlagsFor('racer-hull', true, 0, { ...ALL_CASTERS, racers: false })).toEqual({
      cast: false,
      receive: false,
    })
    expect(shadowFlagsFor('racer-hull', false, 0, ALL_CASTERS)).toEqual({
      cast: false,
      receive: false,
    })
  })

  it('composes the livery, its shadow, the map and the tier', () => {
    const at = (e: Edition, quality = DEFAULT_SETTINGS.quality) =>
      shadowCastersFor(e, { ...DEFAULT_SETTINGS, quality }).racers
    // Asserted on presets BUILT to say so, not on whichever way the shipped
    // JSON points today (shadows.test.ts's DEV-304 lesson).
    const on = withFeatureOverrides(anniversary, {
      'render.shadows': true,
      'render.racerLivery': true,
      'render.racerLivery.shadow': true,
    })
    expect(at(on, 'high')).toBe(true)
    expect(at(withFeatureOverrides(on, { 'render.racerLivery': false }), 'high')).toBe(false)
    expect(at(withFeatureOverrides(on, { 'render.racerLivery.shadow': false }), 'high')).toBe(false)
    expect(at(withFeatureOverrides(on, { 'render.shadows': false }), 'high')).toBe(false)
    expect(at(on, 'low')).toBe(false)
    expect(at(classic, 'high')).toBe(false)
  })

  it('reaches the MESHES, and a flip to the hologram takes the shadow with it', () => {
    const renderer = { shadowMap: { enabled: false, type: THREE.BasicShadowMap } }
    const sun = new THREE.DirectionalLight(0xffffff, 1)
    sun.position.set(-9622, 697, -2630)
    const racers: ShadowFlags[] = [0, 1, 2].map(() => ({ castShadow: false, receiveShadow: false }))
    const hull: ShadowFlags = { castShadow: false, receiveShadow: false }
    const on = withFeatureOverrides(anniversary, {
      'render.shadows': true,
      'render.racerLivery': true,
      'render.racerLivery.shadow': true,
    })
    const state = createEditionState(on, { ...DEFAULT_SETTINGS, quality: 'high' })
    const shadows = createSunShadows(renderer, sun, state)
    shadows.attach({ shipExterior: [hull], racers })
    for (const r of racers) expect(r).toEqual({ castShadow: true, receiveShadow: false })

    // The route the Edition page takes. The hull is the control: it must not move.
    state.setLook(withFeatureOverrides(on, { 'render.racerLivery': false }))
    for (const r of racers) expect(r).toEqual({ castShadow: false, receiveShadow: false })
    expect(hull).toEqual({ castShadow: true, receiveShadow: false })

    state.setLook(on)
    for (const r of racers) expect(r).toEqual({ castShadow: true, receiveShadow: false })
    shadows.dispose()
  })
})
