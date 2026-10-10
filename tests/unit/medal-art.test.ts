// tests/unit/medal-art.test.ts — the medal over a table is above it, inside
// it, and big enough to be reviewed (DEV-113).
//
// The orientation lesson (docs/DEVIATIONS.md): test the GEOMETRY, not the
// rotation. Every assertion here is a bound — the emblem's box floats above the
// table's top, its axis stands inside the rim, its whole body inside the
// plinth's foot, it is a few centimetres across and not a few pixels, and a
// spin moves none of those. None of it names a quaternion.
//
// The emblem is the real title glTF, parsed off disk the way
// `checkpoint-ring-asset.test.ts` does it. The asset is gitignored (rule 7), so
// the skip is LOUD; a stand-in emblem covers the part that needs no asset.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { PROPS } from '@/generated/constants.generated'
import {
  HOLO_REACH,
  medalLocal,
  seatEyeLocal,
  TABLE_FOOT_RADIUS,
  TABLE_RIM_RADIUS,
  TABLE_TOP,
  tableLocal,
} from '@/render/hangar'
import { createMedal, MEDAL_SPIN, medalColour, medalPlacement } from '@/render/medal'
import { hangarSpecFor } from '@/sim/hangar'
import anniversary from '../../content/editions/anniversary.json'
import classic from '../../content/editions/classic.json'

const GLB = 'public/assets/props/title-logo.glb'
const available = fs.existsSync(GLB)

/** Parse the GLB straight out of the file, so no server or fetch is involved. */
const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** A table on the arc at `bearing`, with a medal over it. World = hangar local here. */
const tableWith = (
  logo: THREE.Object3D,
  bearing: number,
): { table: THREE.Group; medal: ReturnType<typeof createMedal> } => {
  const spec = hangarSpecFor()
  const table = new THREE.Group()
  const base = tableLocal(spec, bearing)
  table.position.set(base.x, base.y, base.z)
  const medal = createMedal(logo, 'gold', TABLE_RIM_RADIUS, 0)
  const at = medalLocal(bearing, medalPlacement(TABLE_RIM_RADIUS))
  medal.object.position.set(at.x, at.y, at.z)
  table.add(medal.object)
  table.updateWorldMatrix(true, true)
  return { table, medal }
}

/** The medal's world box, and its horizontal offset from the table's axis. */
const measure = (table: THREE.Group, medal: THREE.Object3D) => {
  table.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(medal)
  const centre = box.getCenter(new THREE.Vector3())
  const axis = table.getWorldPosition(new THREE.Vector3())
  const corners = [
    [box.min.x, box.min.z],
    [box.min.x, box.max.z],
    [box.max.x, box.min.z],
    [box.max.x, box.max.z],
  ] as const
  return {
    box,
    // Heights relative to the table's base, which is where TABLE_TOP is measured from.
    bottom: box.min.y - axis.y,
    top: box.max.y - axis.y,
    width: box.max.x - box.min.x,
    height: box.max.y - box.min.y,
    axisOffset: Math.hypot(centre.x - axis.x, centre.z - axis.z),
    reach: Math.max(...corners.map(([x, z]) => Math.hypot(x - axis.x, z - axis.z))),
  }
}

describe('where the medal stands, as a ratio of the table', () => {
  const p = medalPlacement(TABLE_RIM_RADIUS)
  const S = PROPS.medals

  it('puts the axis inside the rim and near its edge, the way 2016 did', () => {
    // 2016's slot, read off the prefab by hand: z 0.2520 on a table whose
    // half-depth is 0.5485 x 0.5 = 0.2742 — 92 % of the way out. Not the sheet's
    // numbers re-multiplied; the file's, as a person reads them.
    expect(p.out).toBeLessThan(TABLE_RIM_RADIUS)
    expect(p.out / TABLE_RIM_RADIUS).toBeCloseTo(0.252 / (0.5485 * 0.5), 2)
  })

  it('lifts the emblem a hand above the top, and stretches it the way the slot does', () => {
    // 0.523 slot, 0.466 top, plus 0.1222 x 0.3768 of child offset: 0.103 m in
    // 2016, scaled by the port's rim over 2016's half-depth.
    expect(p.lift).toBeGreaterThan(0)
    expect(p.lift).toBeCloseTo((0.523 - 0.4661 + 0.1222 * 0.3768) * (TABLE_RIM_RADIUS / 0.2742), 2)
    // The slot is (0.3337, 0.3768, 0.3337): 13 % taller than wide, on purpose or
    // not, and the port keeps it.
    expect(p.scale.y / p.scale.x).toBeCloseTo(0.3768 / 0.3337, 3)
    expect(p.scale.z).toBe(p.scale.x)
  })

  it('scales linearly with the table, so a wider table moves its medal with it', () => {
    const twice = medalPlacement(2 * TABLE_RIM_RADIUS)
    expect(twice.out).toBeCloseTo(2 * p.out, 9)
    expect(twice.lift).toBeCloseTo(2 * p.lift, 9)
    expect(twice.scale.x).toBeCloseTo(2 * p.scale.x, 9)
  })

  it('stands on the SEAT side of the table, whichever bearing the table is on', () => {
    // `medalLocal` is a direction; this checks it against where the seat IS,
    // not against the sign it was written with. Collinear with table -> seat,
    // pointing towards it, at every bearing a page can use.
    const spec = hangarSpecFor()
    const seat = seatEyeLocal(spec)
    for (const bearing of [-Math.PI / 4, -Math.PI / 12, Math.PI / 12, Math.PI / 4]) {
      const base = tableLocal(spec, bearing)
      const at = medalLocal(bearing, p)
      const toSeat = { x: seat.x - base.x, z: seat.z - base.z }
      const len = Math.hypot(toSeat.x, toSeat.z)
      const dot = (at.x * toSeat.x + at.z * toSeat.z) / len
      expect(dot, `bearing ${bearing}`).toBeCloseTo(p.out, 6)
      expect(at.y).toBeCloseTo(TABLE_TOP + p.lift, 9)
    }
    // And the sheet's slot really is offset along ONE axis, which is what makes
    // "out" a single number: x is zero to the millimetre.
    expect(Math.abs(S.slot.position[0])).toBeLessThan(0.001)
  })
})

describe.skipIf(!available)('the medal, built from the real title emblem', () => {
  it('floats above the top, inside the rim, inside the foot, and under the label', async () => {
    const logo = await parse()
    const { table, medal } = tableWith(logo, -Math.PI / 12)
    const m = measure(table, medal.object)
    expect(m.bottom, 'clear of the table top').toBeGreaterThan(TABLE_TOP)
    expect(m.bottom - TABLE_TOP, 'but not floating away from it').toBeLessThan(0.15)
    expect(m.axisOffset, 'its axis is inside the rim').toBeLessThan(TABLE_RIM_RADIUS)
    expect(m.reach, 'every corner is inside the plinth foot').toBeLessThan(TABLE_FOOT_RADIUS)
    // The label stands at TABLE_TOP + 0.4; the medal must not grow into it.
    expect(m.top - TABLE_TOP).toBeLessThan(0.3)
  })

  it('is centimetres across, not pixels: over two degrees at the seat', async () => {
    const logo = await parse()
    const { table, medal } = tableWith(logo, -Math.PI / 12)
    const m = measure(table, medal.object)
    // 17.97 m of emblem at the sheet's scale is about 7.5 cm. Orientation
    // lesson §5c: a thing too small to see has been rendered, not reviewed.
    expect(m.width).toBeGreaterThan(0.06)
    expect(m.width).toBeLessThan(0.1)
    expect(m.height).toBeGreaterThan(0.04)
    const degrees = (2 * Math.atan(m.width / 2 / HOLO_REACH) * 180) / Math.PI
    expect(degrees).toBeGreaterThan(2)
  })

  it('is two meshes in one gold, with the wordmark gone and the source untouched', async () => {
    const logo = await parse()
    const before: string[] = []
    logo.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) before.push(n.name)
    })
    const { medal } = tableWith(logo, 0)
    const names: string[] = []
    const materials = new Set<THREE.Material>()
    medal.object.traverse((n) => {
      const mesh = n as THREE.Mesh
      if (!mesh.isMesh) return
      names.push(n.name)
      materials.add(mesh.material as THREE.Material)
    })
    expect(names.sort()).toEqual(['logo_bottom', 'logo_top'])
    expect(materials.size).toBe(1)
    const mat = [...materials][0] as THREE.MeshStandardMaterial
    expect(mat.color.getHex()).toBe(medalColour('gold').getHex())
    // The title screen's copy still has its three meshes.
    const after: string[] = []
    logo.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) after.push(n.name)
    })
    expect(after).toEqual(before)
    expect(before).toContain('title')
  })

  it('spins in place: a turn moves neither the box nor its height', async () => {
    const logo = await parse()
    const { table, medal } = tableWith(logo, Math.PI / 12)
    const before = measure(table, medal.object)
    medal.update(0.5)
    const after = measure(table, medal.object)
    // 27.5 degrees later the emblem is still over the same spot at the same
    // height. The 2016 slot spins about its own vertical; so does this.
    expect(after.bottom).toBeCloseTo(before.bottom, 6)
    expect(after.top).toBeCloseTo(before.top, 6)
    expect(Math.abs(after.axisOffset - before.axisOffset)).toBeLessThan(0.02)
    // And it did turn, by the sheet's rate.
    expect(medal.object.rotation.y).toBeCloseTo(MEDAL_SPIN * 0.5, 9)
  })
})

describe.skipIf(available)('title-logo.glb is not on disk', () => {
  it('so the emblem tests above were SKIPPED, not passed', () => {
    expect(available).toBe(false)
  })
})

describe('the medal, built from a stand-in emblem (no asset needed)', () => {
  /** Three named boxes in the glTF's shape: top, bottom, and the wordmark. */
  const standIn = (): THREE.Object3D => {
    const root = new THREE.Group()
    const mesh = (name: string, y: number) => {
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(18, 1.6, 4),
        new THREE.MeshBasicMaterial({ color: 0x808080 }),
      )
      m.name = name
      m.position.y = y
      return m
    }
    root.add(mesh('logo_top', 2), mesh('logo_bottom', -2), mesh('title', 8))
    return root
  }

  it('drops the wordmark and paints what is left in the tier colour', () => {
    const logo = standIn()
    const medal = createMedal(logo, 'bronze', TABLE_RIM_RADIUS, 0)
    const names: string[] = []
    medal.object.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) names.push(n.name)
    })
    expect(names.sort()).toEqual(['logo_bottom', 'logo_top'])
    medal.object.traverse((n) => {
      const mesh = n as THREE.Mesh
      if (!mesh.isMesh) return
      expect((mesh.material as THREE.MeshStandardMaterial).color.getHex()).toBe(
        medalColour('bronze').getHex(),
      )
    })
    // The source keeps its wordmark and its own material.
    let sourceMeshes = 0
    logo.traverse((n) => {
      const mesh = n as THREE.Mesh
      if (!mesh.isMesh) return
      sourceMeshes++
      expect((mesh.material as THREE.MeshBasicMaterial).color.getHex()).toBe(0x808080)
    })
    expect(sourceMeshes).toBe(3)
  })

  it('names itself for the scene, and carries its tier', () => {
    const medal = createMedal(standIn(), 'platinum', TABLE_RIM_RADIUS, 1)
    expect(medal.object.name).toBe('hangar-medal')
    expect(medal.object.userData.tier).toBe('platinum')
    expect(medal.object.rotation.y).toBe(1)
  })

  // ── DEV-151: the medal has to be readable over EVERY island ──────────────
  //
  // DEV-140 gave the holotable islands the terrain's own colours, in both
  // presets, because that is what 2016 drew. 2016's medal is the title emblem
  // in the tier's own `_Color` (DEV-113) and four of the five tiers are pale,
  // so a pale medal ended up on pale rock. NEXT.md filed it as "platinum
  // unreadable over alpine and Simonet"; the sweep below says it is wider than
  // that.
  //
  // The measurement is a CONTRAST RATIO, not an opinion: WCAG 2.x's
  // (Llighter + 0.05) / (Ldarker + 0.05) on sRGB relative luminance, between
  // the medal's own colour and each land cell the diorama draws. 3:1 is WCAG's
  // bar for a graphical object, which is what a medal is.
  //
  // The island side is not a number I chose. `diorama.ts` samples the palette
  // and uses it RAW AS LINEAR (DEV-014 — 2016 used sRGB vertex colours as
  // linear albedo and the port keeps the bug), unlit, so a stored byte b is
  // linear b/255 on screen. These tests read the shipped
  // `content/palettes/*.json` and do the same thing to them.
  describe('the medal reads against every island (contrast, measured)', () => {
    const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    const linToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
    type Rgb = readonly [number, number, number]
    const relLum = (srgb: Rgb) =>
      0.2126 * srgbToLin(srgb[0]) + 0.7152 * srgbToLin(srgb[1]) + 0.0722 * srgbToLin(srgb[2])
    const contrast = (a: Rgb, b: Rgb) => {
      const [hi, lo] = relLum(a) >= relLum(b) ? [relLum(a), relLum(b)] : [relLum(b), relLum(a)]
      return (hi + 0.05) / (lo + 0.05)
    }

    /** Every land cell colour a diorama draws for `env`, as sRGB display triples. */
    const islandCells = (env: string): Rgb[] => {
      const pal = JSON.parse(fs.readFileSync(`content/palettes/${env}.json`, 'utf8')) as {
        rgb: string
      }
      const buf = Buffer.from(pal.rgb, 'base64')
      const out: Rgb[] = []
      for (let i = 0; i + 2 < buf.length; i += 3) {
        // raw as linear, then straight to the display: the island is unlit.
        out.push([
          linToSrgb((buf.at(i) ?? 0) / 255),
          linToSrgb((buf.at(i + 1) ?? 0) / 255),
          linToSrgb((buf.at(i + 2) ?? 0) / 255),
        ])
      }
      return out
    }

    const ENVS = ['alpine', 'desert', 'kauai', 'simonet'] as const
    const TIERS = ['bronze', 'silver', 'gold', 'platinum'] as const
    const havePalettes = ENVS.every((e) => fs.existsSync(`content/palettes/${e}.json`))

    it('records the problem: most tiers are under 3:1 over most of most islands', () => {
      expect(havePalettes, 'palettes are tracked, not gitignored').toBe(true)
      // The bare emblem's own colour, as `medalColour` builds it, back to sRGB.
      const bare = (tier: (typeof TIERS)[number]): Rgb => {
        const c = medalColour(tier)
        return [linToSrgb(c.r), linToSrgb(c.g), linToSrgb(c.b)]
      }
      let badPairs = 0
      for (const env of ENVS) {
        const cells = islandCells(env)
        for (const tier of TIERS) {
          const c = bare(tier)
          const under = cells.filter((cell) => contrast(c, cell) < 3).length
          if (under / cells.length > 0.25) badPairs += 1
        }
      }
      // This is the DEFECT, asserted so it cannot quietly go away and leave the
      // outline looking unnecessary. 15 of 16 at the time of writing.
      expect(badPairs, 'tier/environment pairs unreadable without a border').toBeGreaterThanOrEqual(
        12,
      )
    })

    it('the outline fixes it for every tier over every island', () => {
      const outline = (anniversary as unknown as Edition).menu.medalOutline
      expect(outline.enabled, 'Anniversary draws the border').toBe(true)
      const border: Rgb = [outline.colour[0], outline.colour[1], outline.colour[2]]
      // The border is what the eye finds the shape by, so IT is what has to
      // clear the island — and because it is near-black and no island cell is,
      // one number covers every tier at once. That is the point of fixing this
      // with a silhouette instead of with four new tier colours.
      //
      // Note what is NOT asserted: that the border beats every cell by a wide
      // margin. It cannot. The worst cells are the DARKEST ones — Simonet's
      // shadowed rock at sRGB 86,99,104 — and a near-black border against dark
      // rock is 3.15:1, close to the best any single dark colour can do once
      // WCAG's +0.05 term is in. That is the case where the PALE EMBLEM is what
      // the eye finds, which is the point of a two-tone silhouette: the border
      // carries the light islands, the medal carries the dark ones, and neither
      // has to carry both.
      let worst = Number.POSITIVE_INFINITY
      let worstEnv = ''
      for (const env of ENVS) {
        for (const cell of islandCells(env)) {
          const c = contrast(border, cell)
          if (c < worst) {
            worst = c
            worstEnv = env
          }
        }
      }
      expect(worst, `the darkest island cell (${worstEnv}) still frames the medal`).toBeGreaterThan(
        3,
      )
      // Every cell, not just the worst: no island has a pocket the border loses.
      for (const env of ENVS) {
        const under = islandCells(env).filter((cell) => contrast(border, cell) < 3).length
        expect(under, `${env} cells the border does not clear`).toBe(0)
      }
    })

    it('Classic keeps 2016, zeroed twice over', () => {
      const c = (classic as unknown as Edition).menu.medalOutline
      expect(c.enabled).toBe(false)
      expect(c.widthFraction).toBe(0)
      expect(c.opacity).toBe(0)
      // A hand-flipped flag draws nothing: the geometry test, not the flag.
      const medal = createMedal(standIn(), 'platinum', TABLE_RIM_RADIUS, 0, {
        ...c,
        enabled: true,
      })
      let shells = 0
      medal.object.traverse((n) => {
        if (n.name === 'medal-outline') shells += 1
      })
      expect(shells).toBe(0)
    })
  })

  // ── DEV-151: the shell's GEOMETRY, not its material ──────────────────────
  //
  // The orientation lesson again: assert the band's WIDTH, which is a distance
  // and is true whatever I believed about the scale I typed.
  describe('the outline is a band of the right width all the way round', () => {
    const block = {
      enabled: true,
      widthFraction: 0.06,
      colour: [0.04, 0.05, 0.07],
      opacity: 1,
    } as const

    const boxesOf = (medal: ReturnType<typeof createMedal>) => {
      medal.object.updateMatrixWorld(true)
      let emblem: THREE.Object3D | null = null
      let shell: THREE.Object3D | null = null
      medal.object.traverse((n) => {
        if (n.name === 'medal-emblem') emblem = n
        if (n.name === 'medal-outline-holder') shell = n
      })
      return {
        emblem: emblem ? new THREE.Box3().setFromObject(emblem) : null,
        shell: shell ? new THREE.Box3().setFromObject(shell) : null,
      }
    }

    it('stands off the emblem by widthFraction of its height, top and bottom', () => {
      const medal = createMedal(standIn(), 'platinum', TABLE_RIM_RADIUS, 0, block)
      const { emblem, shell } = boxesOf(medal)
      expect(emblem).not.toBeNull()
      expect(shell).not.toBeNull()
      const e = emblem as unknown as THREE.Box3
      const s = shell as unknown as THREE.Box3
      const height = e.max.y - e.min.y
      const want = block.widthFraction * height
      // A DISTANCE, measured on both faces independently.
      expect(s.max.y - e.max.y).toBeCloseTo(want, 6)
      expect(e.min.y - s.min.y).toBeCloseTo(want, 6)
      // And it surrounds, rather than merely sitting behind: proud on x and z too.
      expect(s.max.x).toBeGreaterThan(e.max.x)
      expect(s.min.x).toBeLessThan(e.min.x)
      expect(s.max.z).toBeGreaterThan(e.max.z)
      expect(s.min.z).toBeLessThan(e.min.z)
    })

    it('is back faces only, so the emblem hides all of it but the border', () => {
      const medal = createMedal(standIn(), 'platinum', TABLE_RIM_RADIUS, 0, block)
      let checked = 0
      medal.object.traverse((n) => {
        const mesh = n as THREE.Mesh
        if (!mesh.isMesh || !n.parent) return
        // Meshes under the shell holder, wherever they sit in the clone.
        let p: THREE.Object3D | null = n
        let underShell = false
        while (p) {
          if (p.name === 'medal-outline-holder') underShell = true
          p = p.parent
        }
        if (!underShell) return
        const m = mesh.material as THREE.MeshBasicMaterial
        expect(m.side).toBe(THREE.BackSide)
        expect(m.depthWrite).toBe(false)
        checked += 1
      })
      expect(checked, 'the shell has meshes').toBeGreaterThan(0)
    })

    it('DEV-140 lifts the SHELL clear of the island, not just the emblem', () => {
      // `bottom` is what `settleMedal` puts over the peak. With a border on, the
      // lowest thing is the border, so `bottom` has to have moved down with it —
      // otherwise the fix for a medal lost in a mountain draws a black rim
      // inside one.
      const bare = createMedal(standIn(), 'platinum', TABLE_RIM_RADIUS, 0)
      const bordered = createMedal(standIn(), 'platinum', TABLE_RIM_RADIUS, 0, block)
      expect(bordered.bottom).toBeLessThan(bare.bottom)
      expect(bordered.reach).toBeGreaterThan(bare.reach)
    })

    it('a spin does not change any of it', () => {
      const medal = createMedal(standIn(), 'gold', TABLE_RIM_RADIUS, 0, block)
      const before = boxesOf(medal)
      medal.update(1.7)
      const after = boxesOf(medal)
      const b = before.shell as unknown as THREE.Box3
      const a = after.shell as unknown as THREE.Box3
      expect(a.max.y).toBeCloseTo(b.max.y, 6)
      expect(a.min.y).toBeCloseTo(b.min.y, 6)
    })
  })
})
