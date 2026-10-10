// tests/unit/diorama-look.test.ts — the holotable island's colours come from
// the palette, one per cell, and the hologram shader compiles (DEV-140).
//
// The shader half is the kind of guard `far-shadow.test.ts` carries for a GLSL
// reserved word: a source-text check for the mistake that failed in no unit
// test and in every browser. `<colorspace_pars_fragment>` duplicates functions
// three's program prefix already declares, and the first frame of DEV-140 was
// six tables with no island on them because of it.
//
// ── What left this file with DEV-354 ─────────────────────────────────────
//
// Matt, 2026-09-24: *"level select - show terrain diorama, no gates."* The
// gates, targets and orbs this file used to stand on the island — and the
// tests of their facing (DEV-275), width (#25), art (DEV-326, DEV-327) and the
// circuit table with no island (DEV-313 #41a) — went with them. What each mark
// IS, as one large turning thing on the flight-plan table, is
// `mode-mark.test.ts`'s; the gate's orientation on the real GLB is
// `checkpoint-ring-asset.test.ts`'s. What stays here is the land, the craft,
// and the one claim DEV-354 adds: nothing else is on a level table.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  createDiorama,
  HILLSHADE_FLOOR,
  HILLSHADE_GAIN,
  padHopPath,
  SEA_TINT,
} from '@/render/diorama'
import { buildHeightField, terrainHeightAt } from '@/sim/terrain/height-field'
import type { MapSampler } from '@/sim/terrain/image-sampler'

const cone: MapSampler = {
  width: 64,
  height: 64,
  sample(u, v, out) {
    const h = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 6)
    out.r = h
    out.g = h
    out.b = h
  },
}
const field = (sampler: MapSampler = cone) =>
  buildHeightField(
    sampler,
    {
      terrainSize: 4096,
      terrainHeight: 900,
      chunkSize: 256,
      baseResolution: 16,
      randomOffset: 0,
      seed: 1,
    },
    { position: [0, 0, 0], scale: [1, 1, 1] },
  )

/** A palette that is red on the left half of the map and green on the right. */
const halves: MapSampler = {
  width: 2,
  height: 2,
  sample(u, _v, out) {
    out.r = u < 0.5 ? 0.8 : 0.1
    out.g = u < 0.5 ? 0.1 : 0.8
    out.b = 0.1
  },
}

const island = (d: ReturnType<typeof createDiorama>): THREE.Mesh =>
  d.object.getObjectByName('diorama-island') as THREE.Mesh

/** The diorama's sea tint (`SEA_TINT` in render/diorama.ts), as a colour to match. */
const SEA = new THREE.Color(SEA_TINT)
const isSea = (col: THREE.BufferAttribute, i: number): boolean =>
  Math.abs(col.getX(i) - SEA.r) < 1e-3 &&
  Math.abs(col.getY(i) - SEA.g) < 1e-3 &&
  Math.abs(col.getZ(i) - SEA.b) < 1e-3

describe('the island’s colours', () => {
  it('come from the palette, one colour per cell, with the sea kept as sea', () => {
    const d = createDiorama({ field: field(), palette: halves, route: null, size: 0.5 })
    const mesh = island(d)
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    const col = mesh.geometry.attributes.color as THREE.BufferAttribute
    let redLand = 0
    let greenLand = 0
    let sea = 0
    const leftCells: number[] = []
    for (let i = 0; i < pos.count; i += 6) {
      // Three vertices a triangle share one colour; the cell's two triangles
      // share one HUE (DEV-579 shades each by its own facing, so they may
      // differ in brightness and never in which channel leads).
      for (const t of [0, 3]) {
        for (let k = 1; k < 3; k++) {
          expect(col.getX(i + t + k)).toBe(col.getX(i + t))
          expect(col.getY(i + t + k)).toBe(col.getY(i + t))
        }
      }
      expect(col.getX(i) > col.getY(i)).toBe(col.getX(i + 3) > col.getY(i + 3))
      if (isSea(col, i)) {
        sea++
        continue
      }
      // A land cell stands above the waterline somewhere.
      expect([0, 1, 2, 3, 4, 5].some((k) => pos.getY(i + k) > 1e-6)).toBe(true)
      if (col.getX(i) > col.getY(i)) redLand++
      else greenLand++
      // Left of the model is the map's low u, which the palette paints red.
      if (pos.getX(i) < -0.02) leftCells.push(col.getX(i) - col.getY(i))
    }
    expect(sea).toBeGreaterThan(100)
    expect(redLand).toBeGreaterThan(20)
    expect(greenLand).toBeGreaterThan(20)
    expect(leftCells.length).toBeGreaterThan(5)
    expect(leftCells.every((v) => v > 0)).toBe(true)
    // Plain look: an unlit vertex-colour material, tone-mapped like the room.
    expect((mesh.material as THREE.Material).type).toBe('MeshBasicMaterial')
    d.dispose()
  })

  it('lean toward the holo tint by the mix, and leave the sea alone', () => {
    const plain = createDiorama({
      field: field(),
      palette: halves,
      route: null,
      size: 0.5,
    })
    const holo = createDiorama({
      field: field(),
      palette: halves,
      holo: { brightness: 1, holoMix: 0.5, rim: 0, scanline: 0 },
      route: null,
      size: 0.5,
    })
    const a = island(plain).geometry.attributes.color as THREE.BufferAttribute
    const b = island(holo).geometry.attributes.color as THREE.BufferAttribute
    let moved = 0
    for (let i = 0; i < a.count; i += 6) {
      if (isSea(a, i)) {
        expect(isSea(b, i)).toBe(true)
        continue
      }
      // Toward the tint means blue goes UP on every red or green land cell.
      expect(b.getZ(i)).toBeGreaterThan(a.getZ(i))
      moved++
    }
    expect(moved).toBeGreaterThan(40)
    plain.dispose()
    holo.dispose()
  })
})

/* ═══════ the colour map's own colours, on screen (DEV-579) ═══════════════ */
//
// Matt, 2026-10-03: *"use the real colors for the menu dioramas"*. The island
// shows the map's own BYTE, shaded by a relief light, where it used to take the
// byte as linear and so show it pushed through the sRGB encode (chalk, DEV-576).
// Measured on what the island draws, turned back into the sRGB a screen shows,
// never on the option echoed back.

/** One colour everywhere on the land: an olive, so all three channels differ. */
const OLIVE = { r: 0.4, g: 0.3, b: 0.2 }
const olive: MapSampler = {
  width: 1,
  height: 1,
  sample(_u, _v, out) {
    out.r = OLIVE.r
    out.g = OLIVE.g
    out.b = OLIVE.b
  },
}

describe('the island shows the colour map’s own byte (DEV-579)', () => {
  it('pins the sea: 2016’s Simonet table water, (0.14, 0.42, 0.58) as a byte', () => {
    // A shipped default, pinned once so a change to it is made on purpose.
    expect(SEA_TINT).toBe(0x246b94)
  })

  it('every land face is the map’s hue at 0.55 to 1.1 of its byte, and the relief reads', () => {
    const d = createDiorama({ field: field(), palette: olive, route: null, size: 0.5 })
    const mesh = island(d)
    const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
    const col = mesh.geometry.attributes.color as THREE.BufferAttribute
    const srgb = { r: 0, g: 0, b: 0 }
    const c = new THREE.Color()
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const e = new THREE.Vector3()
    const n = new THREE.Vector3()
    const ks: number[] = []
    // Mean shade of the faces that look north-west, and of those that look
    // south-east: three -x -z, and +x +z (map north is three -z).
    const facing = { nw: [] as number[], se: [] as number[] }
    for (let i = 0; i < pos.count; i += 3) {
      if (isSea(col, i)) continue
      c.setRGB(col.getX(i), col.getY(i), col.getZ(i))
      c.getRGB(srgb, THREE.SRGBColorSpace)
      const k = srgb.r / OLIVE.r
      // The map's own hue: every channel scaled by the same shade.
      expect(srgb.g / OLIVE.g).toBeCloseTo(k, 2)
      expect(srgb.b / OLIVE.b).toBeCloseTo(k, 2)
      ks.push(k)
      a.fromBufferAttribute(pos, i)
      b.fromBufferAttribute(pos, i + 1).sub(a)
      e.fromBufferAttribute(pos, i + 2).sub(a)
      n.crossVectors(b, e).normalize()
      if (n.y < 0) n.negate()
      if (n.x < -0.3 && n.z < -0.3) facing.nw.push(k)
      if (n.x > 0.3 && n.z > 0.3) facing.se.push(k)
    }
    expect(ks.length).toBeGreaterThan(100)
    // Never brighter than the byte times the gain, never darker than the floor.
    // The old read (raw as linear) shows 0.4 as 0.66 on screen: k = 1.66.
    expect(Math.max(...ks)).toBeLessThanOrEqual(HILLSHADE_FLOOR + HILLSHADE_GAIN + 1e-3)
    expect(Math.min(...ks)).toBeGreaterThanOrEqual(HILLSHADE_FLOOR - 1e-3)
    // The relief reads: the cone's two flanks are visibly apart.
    expect(Math.max(...ks) - Math.min(...ks)).toBeGreaterThan(0.25)
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    expect(facing.nw.length).toBeGreaterThan(5)
    expect(facing.se.length).toBeGreaterThan(5)
    // Lit from the north-west, the cartographer's light.
    expect(mean(facing.nw)).toBeGreaterThan(mean(facing.se) + 0.1)
    d.dispose()
  })
})

describe('the hologram shader', () => {
  it('does not redeclare three’s colour-space functions, and does write through its output chain', () => {
    const d = createDiorama({
      field: field(),
      palette: halves,
      holo: { brightness: 1, holoMix: 0.1, rim: 0.3, scanline: 0.1 },
      route: null,
      size: 0.5,
    })
    const material = island(d).material as THREE.ShaderMaterial
    expect(material.type).toBe('ShaderMaterial')
    // An actual include, not a mention in a comment.
    expect(material.fragmentShader).not.toMatch(/#include\s*<colorspace_pars_fragment>/)
    expect(material.fragmentShader).toMatch(/#include\s*<tonemapping_fragment>/)
    expect(material.fragmentShader).toMatch(/#include\s*<colorspace_fragment>/)
    expect(material.vertexColors).toBe(true)
    expect(material.side).toBe(THREE.DoubleSide)
    for (const name of ['uRim', 'uScan', 'uScanPerMetre', 'uHolo']) {
      expect(material.uniforms[name], name).toBeDefined()
    }
    d.dispose()
  })

  it('bands the land with scanlines and the pedestal wall below the waterline not at all (DEV-798)', () => {
    // Matt, 2026-10-07 (go with your recs, QUESTIONS item 26): scanlines banded
    // the pedestal's wall like rock layers. The shader is evaluated, not
    // grepped: the band expression is lifted out of the SHIPPED fragment source
    // and run in JS with GLSL's `step` and `fract`, over local heights above and
    // below the waterline (local y 0), so a mask that is mentioned and wrong,
    // or one that cuts the land too, fails here.
    const d = createDiorama({
      field: field(),
      palette: halves,
      holo: { brightness: 1, holoMix: 0.1, rim: 0.3, scanline: 0.1 },
      route: null,
      size: 0.5,
    })
    const material = island(d).material as THREE.ShaderMaterial
    const expr = /float band = ([^;]+);/.exec(material.fragmentShader)?.[1]
    expect(expr, 'the shader computes a band').toBeDefined()
    const band = new Function(
      'step',
      'fract',
      'vLocalY',
      'uScanPerMetre',
      `return ${expr as string}`,
    ) as (
      step: (edge: number, x: number) => number,
      fract: (x: number) => number,
      y: number,
      perMetre: number,
    ) => number
    const step = (edge: number, x: number) => (x < edge ? 0 : 1)
    const fract = (x: number) => x - Math.floor(x)
    const per = material.uniforms.uScanPerMetre?.value as number
    const at = (y: number) => band(step, fract, y, per)
    // Below the waterline: every height down the wall, dense enough to hit both
    // halves of every band, is band 0.
    for (let y = -0.4; y < 0; y += 0.001) expect(at(y), `wall at ${y.toFixed(3)}`).toBe(0)
    // Above it the land is banded as before: both values occur, every 2 cm.
    const above = Array.from({ length: 200 }, (_, i) => at(0.0005 + i * 0.001))
    expect(above).toContain(0)
    expect(above).toContain(1)
    d.dispose()
  })
})

/* ═══════ a level table is the LAND, and nothing marked on it (DEV-354) ═════ */
//
// Matt, 2026-09-24: *"level select - show terrain diorama, no gates. (this was
// a previous misunderstanding i think on both our counts)"*. Asserted as a
// census of what the table DRAWS, never as an option echoed back: every mesh
// on a level table is the island or a craft, whatever the table was handed —
// a racing line, a tour of pads, or both.

/** Four pads on a 2 km square, THREE space, as a level stores them. */
const PADS: readonly (readonly number[])[] = [
  [1000, 200, -1000],
  [3000, 200, -1000],
  [3000, 200, -3000],
  [1000, 200, -3000],
]

const cones = (d: ReturnType<typeof createDiorama>): THREE.Mesh[] =>
  d.object.children.filter(
    (o): o is THREE.Mesh =>
      (o as THREE.Mesh).isMesh &&
      ((o as THREE.Mesh).geometry as THREE.BufferGeometry).type === 'ConeGeometry',
  )

describe('a level table draws the land and nothing marked on it (DEV-354)', () => {
  it('holds the island and its craft and NOTHING ELSE, however it was handed its path', () => {
    const route = [
      [500, 100, -500],
      [2500, 150, -900],
      [3500, 120, -3000],
    ]
    for (const [label, extra] of [
      ['a racing line', { route }],
      ['a tour of pads', { route: null, pads: PADS }],
      ['both', { route, pads: PADS }],
    ] as const) {
      const d = createDiorama({ field: field(), palette: halves, size: 0.5, ...extra })
      const meshes: THREE.Mesh[] = []
      d.object.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh)
      })
      const craft = cones(d)
      expect(craft.length, `${label}: no craft`).toBeGreaterThan(0)
      expect(island(d), `${label}: no island`).toBeDefined()
      // The census: one island, the craft, and not a gate, a target or an orb.
      expect(
        meshes.filter((m) => m !== island(d) && !craft.includes(m)).map((m) => m.name),
        `${label}: a mark is on a level table`,
      ).toEqual([])
      d.dispose()
    }
  })

  it('reports its GROUND to the medal on every table', () => {
    // DEV-313's circuit table had no island and reported `-Infinity`, which
    // `medalRestY` read as "nothing under the medal". Every level table has its
    // island again, so the medal is lifted clear of a peak wherever there is one.
    const d = createDiorama({ field: field(), palette: halves, route: null, size: 0.5 })
    expect(Number.isFinite(d.peakUnder(0, 0, 0.2))).toBe(true)
    expect(d.peakUnder(0, 0, 0.2)).toBeGreaterThan(0)
    d.dispose()
  })
})

/* ═══════════ the craft on a table whose mission is its pads (#41c) ═════════ */

describe('a table handed PADS flies them (#41c)', () => {
  const table = () =>
    createDiorama({
      field: field(),
      palette: halves,
      pads: PADS,
      route: null,
      size: 0.5,
    })

  it('scales the CRAFT with `craftScale`', () => {
    // `markScale` reached the rings, the plates and the orbs and missed the
    // aircraft for a while, so the craft on every table stayed at the
    // proportion that option's own note prices at four pixels. It is the only
    // mark left on a level table now, and the option is named for it. Asserted
    // as the RATIO between two builds rather than as a length, so it is true
    // whatever the cone's dimensions are.
    const at = (craftScale: number): number => {
      const d = createDiorama({
        field: field(),
        palette: halves,
        pads: PADS,
        route: null,
        size: 0.5,
        craftScale,
      })
      const jet = cones(d)[0] as THREE.Mesh
      const box = new THREE.Box3().setFromBufferAttribute(
        jet.geometry.getAttribute('position') as THREE.BufferAttribute,
      )
      const out = box.getSize(new THREE.Vector3()).length()
      d.dispose()
      return out
    }
    expect(at(2) / at(1), 'the craft ignores craftScale').toBeCloseTo(2, 6)
  })

  it('puts a craft on a table whose mission has NO RACING LINE', () => {
    // The bug, stated as a count: five of the six Target Practice missions carry
    // `route: null`, `line.length > 1` was false, and those five tables built
    // zero jets. Nothing moved on them from the day the file was written.
    expect(cones(table()).length).toBeGreaterThan(0)
  })

  it('comes down where the LAND says the pad is, not in its mirror image', () => {
    // The frame check, and since DEV-354 it is against the island, because the
    // targets it used to be checked against are no longer drawn. The island is
    // built from SIM-space samples and the tour from THREE-space pads, through
    // two different flips; a z flip that went one way for one and the other way
    // for the other lands the craft over the mirror image of the peak.
    //
    // So: a field with ONE peak, off-centre in z (a centred cone would hide
    // exactly this mirror), a pad on its summit, and the craft must pass over
    // the island's highest point.
    const peakU = 0.5
    const peakV = 0.25
    const offCentre: MapSampler = {
      width: 64,
      height: 64,
      sample(u, v, out) {
        const h = Math.max(0, 1 - Math.hypot(u - peakU, v - peakV) * 8)
        out.r = h
        out.g = h
        out.b = h
      },
    }
    // The summit in SIM space, found by asking the field — not by assuming how
    // (u, v) maps onto (x, z), which is the very thing under test — and the
    // pad put there in THREE space, z negated, as a level stores it.
    const terrain = field(offCentre)
    let simX = 0
    let simZ = 0
    let best = Number.NEGATIVE_INFINITY
    for (let x = 0; x <= 4096; x += 16) {
      for (let z = 0; z <= 4096; z += 16) {
        const h = terrainHeightAt(terrain, x, z)
        if (h > best) {
          best = h
          simX = x
          simZ = z
        }
      }
    }
    // Off-centre in z, or the sample cannot separate a mirror from the truth.
    expect(Math.abs(simZ - 2048), 'the peak is on the z midline').toBeGreaterThan(500)
    const summit = [simX, best, -simZ]
    const other = [simX + 1200, 0, -(simZ + 2400)]
    const d = createDiorama({
      field: terrain,
      route: null,
      pads: [summit, other],
      size: 0.5,
    })
    // The island's own highest vertex, in the table's space.
    const pos = island(d).geometry.getAttribute('position') as THREE.BufferAttribute
    let top = 0
    for (let i = 1; i < pos.count; i++) if (pos.getY(i) > pos.getY(top)) top = i
    const peak = new THREE.Vector2(pos.getX(top), pos.getZ(top))
    let nearest = Number.POSITIVE_INFINITY
    for (let step = 0; step < 2_700; step++) {
      d.update(0.01)
      for (const jet of cones(d)) {
        nearest = Math.min(
          nearest,
          new THREE.Vector2(jet.position.x, jet.position.z).distanceTo(peak),
        )
      }
    }
    // One facet of the 56-cell model is 9 mm; the summit vertex and the pad
    // agree to within a cell. The mirror image is the peak's distance from the
    // midline twice over — more than 0.12 m on this table.
    expect(nearest, 'the craft lands on the mirror image of the peak').toBeLessThan(0.5 / 56)
    d.dispose()
  })

  it('climbs between the targets instead of sliding along the table', () => {
    // A lob, not a taxi. Measured on the craft alone — its highest point over
    // its lowest, which is where it lands — so it is true whatever the vertical
    // exaggeration is and needs no target to be drawn.
    const d = table()
    let highest = Number.NEGATIVE_INFINITY
    let lowest = Number.POSITIVE_INFINITY
    for (let step = 0; step < 2_700; step++) {
      d.update(0.01)
      for (const jet of cones(d)) {
        highest = Math.max(highest, jet.position.y)
        lowest = Math.min(lowest, jet.position.y)
      }
    }
    // A 45-degree lob over a 2 km side is a 500 m apex; at 0.5 m / 4096 m with
    // the 1.35x relief that is 0.082 m over the pads. Asserted loosely at half
    // of it, because the claim under test is "it leaves the ground", and the
    // exact quarter is pinned on `padHopPath` below where nothing else is in
    // the way.
    expect(highest - lowest).toBeGreaterThan(0.04)
    d.dispose()
  })
})

describe('padHopPath — the 45-degree lob (#41c)', () => {
  const A = [0, 0, 0] as const
  const B = [1000, 0, 0] as const

  /**
   * The FIRST hop of a tour, on its own.
   *
   * Derived from the path's own length rather than from the sample count, so
   * this does not become a second copy of a constant in the file under test —
   * a tour of `n` pads is `n` hops plus the one point that closes it.
   */
  const firstHop = (pads: readonly (readonly number[])[]): number[][] => {
    const path = padHopPath(pads)
    return path.slice(0, (path.length - 1) / pads.length)
  }

  it('passes through every pad and closes the tour on the first', () => {
    const pads: readonly [number, number, number][] = [
      [0, 0, 0],
      [1000, 0, 0],
      [1000, 0, 1000],
    ]
    const path = padHopPath(pads)
    for (const pad of pads) {
      const hit = path.some(
        (p) =>
          Math.hypot(
            (p[0] as number) - pad[0],
            (p[1] as number) - pad[1],
            (p[2] as number) - pad[2],
          ) < 1e-9,
      )
      expect(hit, `pad ${pad.join(',')} is not on the path`).toBe(true)
    }
    // The last point IS the first pad, so the closing hop lands rather than
    // stopping one sample short of its target.
    expect(path.at(-1)).toEqual([...A])
  })

  it('reaches a quarter of its RANGE at the top — the 45-degree launch', () => {
    // `apex / range = tan(theta) / 4`, so a quarter is 45 degrees exactly: the
    // angle that throws furthest for a given launch speed. Measured off the
    // returned points rather than restated from the constant.
    const hop = firstHop([A, B])
    const apex = Math.max(...hop.map((p) => p[1] as number))
    const range = Math.hypot((B[0] as number) - A[0], (B[2] as number) - A[2])
    expect(apex / range).toBeCloseTo(0.25, 6)
  })

  it('never dips below the line between two pads', () => {
    // A sign error on the apex term is a craft that burrows to its next target,
    // and at 1:8000 under an island it would simply vanish.
    for (const p of padHopPath([
      [0, 300, 0],
      [800, 100, 600],
    ])) {
      const t = (p[0] as number) / 800
      expect(p[1] as number).toBeGreaterThanOrEqual(300 + (100 - 300) * t - 1e-9)
    }
  })

  it('samples in equal TIME, which is what makes it read as thrown', () => {
    // The property that makes the motion ballistic without `update` knowing
    // anything about it: the walker takes one sample per equal slice of the lap,
    // so EQUAL HORIZONTAL steps with SHRINKING vertical ones are a craft that is
    // fast off the pad and slow over the top. Re-sampling this by arc length —
    // the obvious "improvement" — would produce a constant-speed cruise.
    const hop = firstHop([A, B])
    const dx: number[] = []
    const dy: number[] = []
    for (let i = 1; i < hop.length; i++) {
      dx.push((hop[i]?.[0] as number) - (hop[i - 1]?.[0] as number))
      dy.push((hop[i]?.[1] as number) - (hop[i - 1]?.[1] as number))
    }
    for (const step of dx) expect(step).toBeCloseTo(dx[0] as number, 9)
    // Rising, and rising by less each time, all the way to the top of the arc.
    for (let i = 1; i < dy.length; i++) {
      expect(dy[i] as number).toBeLessThan(dy[i - 1] as number)
    }
  })

  it('gives a lone pad no tour at all', () => {
    expect(padHopPath([A])).toEqual([])
    expect(padHopPath([])).toEqual([])
  })
})
