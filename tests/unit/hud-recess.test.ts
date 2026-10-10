// tests/unit/hud-recess.test.ts — DEV-362: the readout is IN the recess,
// measured against the cockpit mesh, and the recess pose is 2016's, measured
// against the prefab.
//
// ── Test the geometry, not the rotation ────────────────────────────────────
//
// CLAUDE.md's orientation lesson: a quaternion assertion is your belief written
// twice. So nothing here asserts a transform. It builds the panel with the
// game's own code (`createHud`, `placeHudAt`, `setMount('dash')`), loads the
// shipped `hoverjet-cockpit.glb` through the three `ART_*` lines every consumer
// applies, and asks the MESH three questions, by ray from the eye:
//
//   1. Can the seat see every screen? A ray to each sample point on the upper
//      screen, the speed card and the strip reaches it without crossing the
//      cockpit — so nothing is buried in the dash or behind the hood.
//   2. Is the upper screen set against the GLASS? The same ray, carried on,
//      meets the cockpit within 6 cm, on a near-black face (the recess's glass
//      is #0f0f0f; the bezel, hood and sill are brown, the cheeks grey).
//   3. Does the strip lie on the SILL? Carried on, it meets the dash within
//      3 cm, and not on the glass.
//
// The panel the port drew until this row — (0, -0.3, -0.72) tilted -0.42 from
// the eye — FAILS question 2: its rays carry on 19 cm to the glass. That case is
// in the suite, so the measure is shown to separate a recessed panel from a
// floating one rather than assumed to.
//
// ── And the numbers are 2016's ─────────────────────────────────────────────
//
// `render/hud-dash.ts` carries 2016's composed pose as constants (TODO(extract),
// as `ART_POSITION` still is). The last block re-reads
// `PlayerShip_SR14_Photon.prefab` — never `_unet` — walks `m_Father` from each
// panel to the root, and recomposes them, reading a RectTransform's x,y from
// `m_AnchoredPosition` (its serialised `m_LocalPosition` x,y are always 0).
//
// Everything that needs the gitignored GLB or the read-only Unity project is
// guarded with the disk work INSIDE the `it`, and the guarded halves have one
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ART_POSITION, ART_SCALE, EYE, SHIP_MODEL_YAW } from '@/game/flight'
import { createHud, type Hud } from '@/render/hud'
import {
  DASH_CARD,
  DASH_POSE_2016,
  DASH_SCREEN,
  DASH_STRIP,
  type HudPlacementLike,
  placeHudAt,
} from '@/render/hud-dash'
import { legacyAvailable, legacyPath } from '../../tools/legacy-root.mjs'

const COCKPIT_GLB = 'public/assets/ships/hoverjet-cockpit.glb'
const PREFAB = 'Assets/Faceted Flight/Resources/PlayerShip_SR14_Photon.prefab'
const haveGlb = fs.existsSync(COCKPIT_GLB)
const haveLegacy = legacyAvailable()

/** The two editions' HoverJet placement, as the build reads it. */
const EDITIONS = ['classic', 'anniversary'].map((id) => ({
  id,
  hud: (
    JSON.parse(fs.readFileSync(`content/editions/${id}.json`, 'utf8')) as {
      cockpit: { placement: { hud: HudPlacementLike } }
    }
  ).cockpit.placement.hud,
}))

/** The placement every build shipped until DEV-362: a plate floating in front of the dash nose. */
const FLOATING: HudPlacementLike = { offset: [0, -0.3, -0.72], tilt: -0.42, scale: 1 }

// ── the panel, built by the game's own code ────────────────────────────────

beforeEach(() => {
  vi.unstubAllGlobals()
})

const installCanvas = () => {
  const noop = () => {}
  const context = {
    clearRect: noop,
    fillRect: noop,
    fillText: noop,
    setTransform: noop,
    beginPath: noop,
    roundRect: noop,
    fill: noop,
    stroke: noop,
    measureText: (s: string) => ({ width: s.length * 8 }),
  }
  const element = { width: 0, height: 0, getContext: () => context }
  vi.stubGlobal('document', { createElement: () => element })
}

/** A HoverJet panel, placed and set into the dash the way `game/flight.ts`'s `placeHud` does. */
const dashPanel = (p: HudPlacementLike): Hud => {
  installCanvas()
  const hud = createHud()
  placeHudAt(hud.object, p, EYE)
  hud.setMount('dash')
  hud.object.updateMatrixWorld(true)
  return hud
}

type Quad = readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]
/** The dash geometry's three quads in the SHIP frame: strip, card, upper (its draw order). */
const quadsOf = (hud: Hud): { strip: Quad; card: Quad; upper: Quad } => {
  const mesh = hud.object as THREE.Mesh
  const pos = mesh.geometry.getAttribute('position')
  const q = (k: number): Quad =>
    [0, 1, 2, 3].map((i) =>
      new THREE.Vector3().fromBufferAttribute(pos, k * 4 + i).applyMatrix4(mesh.matrixWorld),
    ) as unknown as Quad
  return { strip: q(0), card: q(1), upper: q(2) }
}

/** A point on a quad (corners TL, TR, BL, BR) at u across, v down. */
const at = (quad: Quad, u: number, v: number): THREE.Vector3 => {
  const top = quad[0].clone().lerp(quad[1], u)
  const bottom = quad[2].clone().lerp(quad[3], u)
  return top.lerp(bottom, v)
}

/** Sample points kept 8 % in from every edge — the lip may take an edge; it may not take a screen. */
const grid = (vs: readonly number[]): readonly (readonly [number, number])[] =>
  vs.flatMap((v) => [0.08, 0.3, 0.5, 0.7, 0.92].map((u) => [u, v] as const))
const SAMPLES = grid([0.08, 0.5, 0.92])
/**
 * The speed card's samples stop at 72 % down, where its drawing does (the
 * text line, and the glider's stall bar where the chain's was until
 * DEV-615). 2016's text rect is 142.5 units tall for a 97-
 * unit line set at its top, and the empty fifth below runs into the dash's
 * rear lip — in 2016 as here, and invisibly in both: it carries no pixel.
 */
const CARD_SAMPLES = grid([0.08, 0.4, 0.72])

// ── the mesh ────────────────────────────────────────────────────────────────

interface Tri {
  readonly a: THREE.Vector3
  readonly b: THREE.Vector3
  readonly c: THREE.Vector3
  /** Mean vertex luminance, 0..1. */
  readonly luma: number
}

const loadCockpit = async (): Promise<Tri[]> => {
  const bytes = fs.readFileSync(COCKPIT_GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const scene = await new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (g) => resolve(g.scene), reject)
  })
  // The three ART_* lines `game/flight.ts` applies to the cockpit art.
  const art = new THREE.Group()
  art.position.copy(ART_POSITION)
  art.rotation.y = SHIP_MODEL_YAW
  art.scale.copy(ART_SCALE)
  art.add(scene)
  art.updateMatrixWorld(true)
  const tris: Tri[] = []
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (!mesh.isMesh) return
    const g = mesh.geometry
    const pos = g.getAttribute('position')
    const col = g.getAttribute('color')
    const index = g.getIndex()
    const n = index ? index.count : pos.count
    const vi = (k: number) => (index ? index.getX(k) : k)
    const p = (i: number) =>
      new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
    const luma = (i: number) =>
      col ? 0.2126 * col.getX(i) + 0.7152 * col.getY(i) + 0.0722 * col.getZ(i) : 1
    for (let k = 0; k < n; k += 3) {
      const [i, j, l] = [vi(k), vi(k + 1), vi(k + 2)]
      tris.push({ a: p(i), b: p(j), c: p(l), luma: (luma(i) + luma(j) + luma(l)) / 3 })
    }
  })
  return tris
}

/** Every crossing of the cockpit along the ray from the eye through `point`, nearest first. */
const crossings = (tris: readonly Tri[], point: THREE.Vector3) => {
  const dir = point.clone().sub(EYE)
  const reach = dir.length()
  const ray = new THREE.Ray(EYE.clone(), dir.normalize())
  const hit = new THREE.Vector3()
  const out: { t: number; luma: number }[] = []
  for (const tri of tris) {
    if (ray.intersectTriangle(tri.a, tri.b, tri.c, false, hit)) {
      out.push({ t: hit.distanceTo(EYE) - reach, luma: tri.luma })
    }
  }
  return out.sort((x, y) => x.t - y.t)
}

/** 1 mm: a face that meets a sample point is not in front of it. */
const EPS = 0.001
/** The recess's glass is #0f0f0f; everything round it is brown or grey. */
const GLASS_LUMA = 0.1

interface Verdict {
  /** Samples a ray from the eye cannot reach without crossing the cockpit. */
  readonly hidden: number
  /** For each sample, how far past it the ray meets the cockpit, m (Infinity: never). */
  readonly backing: readonly number[]
  /** For each sample, whether that face is the recess's glass. */
  readonly onGlass: readonly boolean[]
}

const judge = (tris: readonly Tri[], quad: Quad, samples = SAMPLES): Verdict => {
  let hidden = 0
  const backing: number[] = []
  const onGlass: boolean[] = []
  for (const [u, v] of samples) {
    const all = crossings(tris, at(quad, u, v))
    if (all.some((c) => c.t < -EPS)) hidden += 1
    const behind = all.find((c) => c.t >= -EPS)
    backing.push(behind ? behind.t : Number.POSITIVE_INFINITY)
    onGlass.push(behind ? behind.luma < GLASS_LUMA : false)
  }
  return { hidden, backing, onGlass }
}

describe.skipIf(!haveGlb)('the readout against the shipped cockpit mesh', () => {
  for (const { id, hud: placement } of EDITIONS) {
    it(`${id}: the seat sees all three screens — none is buried in the dash or under the hood`, async () => {
      const tris = await loadCockpit()
      const q = quadsOf(dashPanel(placement))
      for (const name of ['upper', 'card', 'strip'] as const) {
        const samples = name === 'card' ? CARD_SAMPLES : SAMPLES
        expect(
          judge(tris, q[name], samples).hidden,
          `${id}: ${name} samples hidden from the eye`,
        ).toBe(0)
      }
    })

    it(`${id}: the upper screen is set against the recess's GLASS, within 6 cm of it`, async () => {
      const tris = await loadCockpit()
      const v = judge(tris, quadsOf(dashPanel(placement)).upper)
      expect(
        Math.max(...v.backing),
        `${id}: farthest glass behind a sample, m`,
      ).toBeLessThanOrEqual(0.06)
      expect(v.onGlass.every(Boolean), `${id}: a sample is backed by bezel, not glass`).toBe(true)
    })

    it(`${id}: the strip lies on the sill, within 3 cm, below the glass`, async () => {
      const tris = await loadCockpit()
      const v = judge(tris, quadsOf(dashPanel(placement)).strip)
      expect(
        Math.max(...v.backing),
        `${id}: farthest dash behind the strip, m`,
      ).toBeLessThanOrEqual(0.03)
      expect(v.onGlass.some(Boolean), `${id}: the strip is lying on the glass`).toBe(false)
    })
  }

  it('SEPARATES: the plate the port floated until DEV-362 is not in the recess', async () => {
    const tris = await loadCockpit()
    const v = judge(tris, quadsOf(dashPanel(FLOATING)).upper)
    // Its rays carry on ~19 cm to the glass, and its sides fall on the bezel.
    expect(Math.max(...v.backing)).toBeGreaterThan(0.1)
    expect(v.onGlass.every(Boolean)).toBe(false)
  })
})

// ── the prefab ──────────────────────────────────────────────────────────────

/** Raw Unity YAML documents by fileID. */
const readPrefab = (): Map<string, string> => {
  const text = fs.readFileSync(legacyPath(PREFAB), 'utf8')
  const docs = new Map<string, string>()
  for (const part of text.split(/^(?=--- !u!)/m)) {
    const m = part.match(/^--- !u!\d+ &(-?\d+)/)
    if (m?.[1]) docs.set(m[1], part)
  }
  return docs
}

const nums = (doc: string, key: string): Record<string, number> => {
  const m = doc.match(new RegExp(`^\\s*${key}: \\{([^}]*)\\}`, 'm'))
  if (!m?.[1]) throw new Error(`no ${key}`)
  const out: Record<string, number> = {}
  for (const pair of m[1].split(',')) {
    const [k, v] = pair.split(':').map((s) => s.trim())
    if (k && v !== undefined) out[k] = Number(v)
  }
  return out
}

/**
 * A transform's local TRS in UNITY space. A RectTransform (`!u!224`) with
 * centred anchors and a centred parent pivot has its x,y in
 * `m_AnchoredPosition`; anything else would need the parent's rect, and is
 * refused rather than guessed.
 */
const localMatrix = (docs: Map<string, string>, id: string): THREE.Matrix4 => {
  const doc = docs.get(id)
  if (!doc) throw new Error(`no transform ${id}`)
  const p = nums(doc, 'm_LocalPosition')
  const r = nums(doc, 'm_LocalRotation')
  const s = nums(doc, 'm_LocalScale')
  let x = p.x ?? 0
  let y = p.y ?? 0
  if (doc.startsWith('--- !u!224')) {
    const lo = nums(doc, 'm_AnchorMin')
    const hi = nums(doc, 'm_AnchorMax')
    const pivot = nums(doc, 'm_Pivot')
    const father = doc.match(/m_Father: \{fileID: (-?\d+)\}/)?.[1] ?? '0'
    const parent = docs.get(father)
    // A plain Transform parent has no rect, so its "pivot" is its origin.
    const parentPivot = parent?.startsWith('--- !u!224')
      ? nums(parent, 'm_Pivot')
      : { x: 0.5, y: 0.5 }
    for (const v of [lo.x, lo.y, hi.x, hi.y, pivot.x, pivot.y, parentPivot.x, parentPivot.y]) {
      if (v !== 0.5) throw new Error(`RectTransform ${id} is not centred — needs its parent's rect`)
    }
    const ap = nums(doc, 'm_AnchoredPosition')
    x = ap.x ?? 0
    y = ap.y ?? 0
  }
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, p.z ?? 0),
    new THREE.Quaternion(r.x, r.y, r.z, r.w),
    new THREE.Vector3(s.x, s.y, s.z),
  )
}

/** Root-to-leaf composition of a transform's `m_Father` chain, Unity space. */
const worldMatrix = (docs: Map<string, string>, id: string): THREE.Matrix4 => {
  const chain: string[] = []
  let at: string | undefined = id
  while (at && at !== '0') {
    chain.unshift(at)
    at = docs.get(at)?.match(/m_Father: \{fileID: (-?\d+)\}/)?.[1]
  }
  return chain.reduce((m, link) => m.multiply(localMatrix(docs, link)), new THREE.Matrix4())
}

/** A RectTransform's GameObject's name, to find the panels by name rather than by fileID. */
const rectNamed = (docs: Map<string, string>, name: string, under: string): string => {
  for (const [id, doc] of docs) {
    if (!doc.startsWith('--- !u!224')) continue
    const go = doc.match(/m_GameObject: \{fileID: (-?\d+)\}/)?.[1]
    const goDoc = go ? docs.get(go) : undefined
    if (!goDoc || !new RegExp(`m_Name: ${name}\\s*$`, 'm').test(goDoc)) continue
    // Under the FIRST-PERSON canvas: the third-person one reuses every name.
    let up: string | undefined = id
    let path = ''
    while (up && up !== '0') {
      const upGo = docs.get(up)?.match(/m_GameObject: \{fileID: (-?\d+)\}/)?.[1]
      path = `${docs.get(upGo ?? '')?.match(/m_Name: (.*)$/m)?.[1] ?? ''}/${path}`
      up = docs.get(up)?.match(/m_Father: \{fileID: (-?\d+)\}/)?.[1]
    }
    if (path.includes(under)) return id
  }
  throw new Error(`no ${name} under ${under}`)
}

const toThree = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.y, -v.z)

describe.skipIf(!haveLegacy)('the recess pose is 2016’s, recomposed from the prefab', () => {
  it('the upper screen, the strip and the speed card, against `render/hud-dash.ts`', () => {
    const docs = readPrefab()
    const under = 'FirstPersonHUDRoot/Ship_HUD/'
    const upper = worldMatrix(docs, rectNamed(docs, 'panel_shipUI', under))
    const strip = worldMatrix(docs, rectNamed(docs, 'panel_speedUI', under))
    const textRect = rectNamed(docs, 'text_speed', under)
    // The card: text_speed's plane, re-centred on the strip's centreline.
    const textDoc = docs.get(textRect) as string
    const textAp = nums(textDoc, 'm_AnchoredPosition')
    const card = strip
      .clone()
      .multiply(
        localMatrix(docs, textRect).premultiply(
          new THREE.Matrix4().makeTranslation(-(textAp.x ?? 0), 0, 0),
        ),
      )
    const size = (m: THREE.Matrix4, w: number, h: number) => ({
      w: toThree(new THREE.Vector3(w / 2, 0, 0).applyMatrix4(m)).distanceTo(
        toThree(new THREE.Vector3(-w / 2, 0, 0).applyMatrix4(m)),
      ),
      h: toThree(new THREE.Vector3(0, h / 2, 0).applyMatrix4(m)).distanceTo(
        toThree(new THREE.Vector3(0, -h / 2, 0).applyMatrix4(m)),
      ),
    })
    const rectSize = (id: string) => nums(docs.get(id) as string, 'm_SizeDelta')
    const up = rectSize(rectNamed(docs, 'panel_shipUI', under))
    const sp = rectSize(rectNamed(docs, 'panel_speedUI', under))
    const tx = rectSize(textRect)
    const textScale = nums(textDoc, 'm_LocalScale')

    // Sizes.
    const u = size(upper, up.x ?? 0, up.y ?? 0)
    expect(u.w).toBeCloseTo(DASH_SCREEN.width, 5)
    expect(u.h).toBeCloseTo(DASH_SCREEN.height, 5)
    const s = size(strip, sp.x ?? 0, sp.y ?? 0)
    expect(s.w).toBeCloseTo(DASH_STRIP.width, 5)
    expect(s.h).toBeCloseTo(DASH_STRIP.height, 5)
    // The card spans the strip's width, in the text's own units.
    const c = size(card, (sp.x ?? 0) / (textScale.x ?? 1), tx.y ?? 0)
    expect(c.w).toBeCloseTo(DASH_CARD.width, 5)
    expect(c.h).toBeCloseTo(DASH_CARD.height, 5)

    // The upper screen's pose, as the preset spells it: offset from the eye, tilt.
    const centre = toThree(new THREE.Vector3().applyMatrix4(upper))
    const offset = centre.clone().sub(EYE)
    expect(offset.x).toBeCloseTo(DASH_POSE_2016.offset[0], 4)
    expect(offset.y).toBeCloseTo(DASH_POSE_2016.offset[1], 4)
    expect(offset.z).toBeCloseTo(DASH_POSE_2016.offset[2], 4)
    const upY = toThree(new THREE.Vector3(0, 1, 0).transformDirection(upper))
    expect(Math.atan2(upY.z, upY.y)).toBeCloseTo(DASH_POSE_2016.tilt, 5)

    // The strip and the card in the upper screen's own frame.
    const ux = toThree(new THREE.Vector3(1, 0, 0).transformDirection(upper))
    const uz = new THREE.Vector3().crossVectors(ux, upY).normalize()
    const inUpper = (m: THREE.Matrix4, want: { position: readonly number[]; tilt: number }) => {
      const d = toThree(new THREE.Vector3().applyMatrix4(m)).sub(centre)
      expect(d.dot(ux)).toBeCloseTo(want.position[0] ?? 0, 4)
      expect(d.dot(upY)).toBeCloseTo(want.position[1] ?? 0, 4)
      expect(d.dot(uz)).toBeCloseTo(want.position[2] ?? 0, 4)
      const y = toThree(new THREE.Vector3(0, 1, 0).transformDirection(m))
      expect(Math.atan2(y.dot(uz), y.dot(upY))).toBeCloseTo(want.tilt, 5)
    }
    inUpper(strip, DASH_STRIP)
    inUpper(card, DASH_CARD)
  })

  it('Classic IS 2016: its HoverJet placement is the recomposed pose, not a trim of it', () => {
    const classic = EDITIONS.find((e) => e.id === 'classic')?.hud
    expect(classic?.offset).toEqual([...DASH_POSE_2016.offset])
    expect(classic?.tilt).toBe(DASH_POSE_2016.tilt)
    expect(classic?.scale).toBe(1)
  })
})

describe.skipIf(haveGlb && haveLegacy)('the guarded halves of this file', () => {
  it('are skipped only because the cockpit GLB or the Unity project is absent', () => {
    expect(haveGlb && haveLegacy).toBe(false)
  })
})
