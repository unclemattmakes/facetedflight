// tests/unit/start-deck.test.ts — 2016's start deck, a lift under every pad
// (DEV-549), and a hover glow under every pad that stands on nothing (DEV-550).
//
// Matt, 2026-09-30: *"sure"* (port 2016's deck with an opening per pad) and
// *"yes plz"* (a hover glow under the floating pads).
//
// The claims are GEOMETRY, never a rotation (the orientation lesson):
//
//   * the converted tiles, placed by the extractor's placements, stand on 2016's
//     own collision cubes — Unity built-ins, numbers through no importer — at
//     their walking surface, and cover it. Three of the four tiles stand off
//     their pivots, so a wrong mirror in the FBX conversion moves them 5.5 m and
//     the coverage falls: that is the witness, run beside the claim;
//   * nothing of the deck stands inside any pad's opening, and every pad's own
//     footprint is inside its opening, so a pad that rises (DEV-553's
//     arrival, which was DEV-461's `?arrival=rise`) meets no deck on its way up;
//   * the deck is ONE mesh in a material that keys like the pads' own;
//   * a glow stands under exactly the pads with nothing under them, in 2016's
//     register, read off the JumpSeat's engine on the sheet.
//
// Both GLBs are bought geometry and never in git (hard rule 7), so the half that
// reads them is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { racerStarts } from '@/game/racer-grid'
import { JUMPSEAT } from '@/generated/constants.generated'
import { glowMaterial, projectorMaterial } from '@/render/hover-glow'
import { hullXZ, type Xz } from '@/render/lift-seal'
import {
  ARRIVAL_DROP,
  createStartDeck,
  type DeckPlacement,
  deckMaterial,
  insideConvex,
  placeDeck,
  START_DECK_ART,
  START_DECK_MESH,
  START_DECK_PARTS,
  WELL_DEPTH,
  wellGeometry,
} from '@/render/start-deck'
import {
  createStartGrid,
  deckPadsOf,
  HOVER_GLOW_REGISTER,
  heldAtRelease,
  NO_DECK,
  releasePadOf,
  START_PAD_ART,
  START_PAD_GLOW,
  START_PAD_MESH,
  type StartGridSpec,
} from '@/render/start-grid'
import { MAINTAINER_CHECKOUT } from './helpers/checkout'

const DECK_FILE = `public/${START_DECK_MESH}`
const PAD_FILE = `public/${START_PAD_MESH}`
const AVAILABLE = fs.existsSync(DECK_FILE) && fs.existsSync(PAD_FILE)

type Rig = Level & {
  spawn: Level['spawn'] & { startGrid?: StartGridSpec & { art?: DeckPlacement[] } }
}

const LEVELS: Rig[] = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')) as Rig)

/** Every course with 2016's deck art: the six decks. */
const DECKS = LEVELS.filter((l) => (l.spawn?.startGrid?.art?.length ?? 0) > 0)

const RACERS = (edition: string): EditionRacers =>
  (
    JSON.parse(fs.readFileSync(`content/editions/${edition}.json`, 'utf8')) as {
      gameplay: { racers: EditionRacers }
    }
  ).gameplay.racers

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** The deck file's parts, by name; `mirror` negates x in each tile's own frame. */
const partsOf = (art: THREE.Object3D, mirror = false): Map<string, THREE.BufferGeometry> => {
  const parts = new Map<string, THREE.BufferGeometry>()
  for (const name of START_DECK_PARTS) {
    const g = (art.getObjectByName(name) as THREE.Mesh).geometry.clone()
    if (mirror && name !== 'moulding') g.scale(-1, 1, 1)
    parts.set(name, g)
  }
  return parts
}

/** A slab's top face as a counter-clockwise footprint, and its height. */
const slabTopOf = (slab: StartGridSpec['slabs'][number]): { hull: Xz[]; y: number } => {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(slab.pos as number[]),
    new THREE.Quaternion().fromArray(slab.quat as number[]),
    new THREE.Vector3(1, 1, 1),
  )
  const [w = 0, h = 0, d = 0] = slab.size as number[]
  const pts = [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([x = 0, z = 0]) => {
    const v = new THREE.Vector3(x, h / 2, z).applyMatrix4(m)
    return { x: v.x, z: v.z }
  })
  return { hull: hullXZ(pts), y: (slab.pos[1] as number) + h / 2 }
}

/** Samples of the walking surface: a grid over each slab's top, inset. */
const walkSamples = (grid: StartGridSpec, n = 15, inset = 0.5): Xz[] => {
  const out: Xz[] = []
  for (const slab of grid.slabs) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(slab.pos as number[]),
      new THREE.Quaternion().fromArray(slab.quat as number[]),
      new THREE.Vector3(1, 1, 1),
    )
    const [w = 0, , d = 0] = slab.size as number[]
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const v = new THREE.Vector3(
          -w / 2 + inset + ((w - 2 * inset) * i) / (n - 1),
          0,
          -d / 2 + inset + ((d - 2 * inset) * j) / (n - 1),
        ).applyMatrix4(m)
        out.push({ x: v.x, z: v.z })
      }
  }
  return out
}

/** A deck's grid as `boot/app.ts` builds it: 2016's pads, the player's, and the slots. */
const gridOf = (level: Rig, edition = 'anniversary') => {
  const authored = level.spawn.startGrid as StartGridSpec
  const release = releasePadOf(authored, level.spawn, level.spawn.launch)
  const slots = racerStarts(level, RACERS(edition)).filter(heldAtRelease)
  return createStartGrid({ ...authored, pads: deckPadsOf(authored, release, slots) })
}

// ── Pure ───────────────────────────────────────────────────────────────────────

describe('the deck geometry', () => {
  const SQUARE: Xz[] = [
    { x: -1, z: -1 },
    { x: 1, z: -1 },
    { x: 1, z: 1 },
    { x: -1, z: 1 },
  ]

  it('asks inside a convex counter-clockwise polygon', () => {
    expect(insideConvex(SQUARE, { x: 0, z: 0 })).toBe(true)
    expect(insideConvex(SQUARE, { x: 1.5, z: 0 })).toBe(false)
    expect(insideConvex([...SQUARE].reverse(), { x: 0, z: 0 })).toBe(false)
  })

  it('walls a well only where a tile stands, from that tile down WELL_DEPTH under the deck', () => {
    // A tile covering x < 0 only: the opening's left half is walled.
    const tile = {
      hull: [
        { x: -5, z: -5 },
        { x: 0, z: -5 },
        { x: 0, z: 5 },
        { x: -5, z: 5 },
      ],
      top: 2,
    }
    const well = wellGeometry(SQUARE, 3, [tile], [0.5, 0.5, 0.5])
    const p = well.positions
    expect(p.length).toBeGreaterThan(0)
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < p.length; i += 3) {
      expect(p[i] as number, 'no wall over the sea half').toBeLessThanOrEqual(1e-9)
      minY = Math.min(minY, p[i + 1] as number)
      maxY = Math.max(maxY, p[i + 1] as number)
    }
    expect(maxY, "from the tile's own top").toBe(2)
    expect(minY, 'down WELL_DEPTH under the deck').toBeCloseTo(3 - WELL_DEPTH, 9)
    // A well a waiting pad fits in: its drop, a pad's height, and more.
    expect(WELL_DEPTH).toBeGreaterThan(ARRIVAL_DROP + 1.67)
  })

  it('refuses a part the file does not carry, and a mirrored node', () => {
    const parts = new Map([['floor-a', new THREE.BoxGeometry(1, 1, 1)]])
    const at = { pos: [0, 0, 0], quat: [0, 0, 0, 1] }
    expect(() => placeDeck(parts, [{ part: 'floor-z', ...at, scale: [1, 1, 1] }])).toThrow()
    expect(() => placeDeck(parts, [{ part: 'floor-a', ...at, scale: [-1, 1, 1] }])).toThrow()
  })

  it("keys like the pads' own material: no new program for the deck", () => {
    // three folds the material TYPE and these switches into a program's key;
    // the colour and the roughness are uniforms. `projectorMaterial` is the
    // pads' (and the wings') `Projector04_Mat`.
    const deck = deckMaterial()
    const pad = projectorMaterial(
      Object.assign(new THREE.MeshStandardMaterial(), {
        userData: {
          unity: {
            name: 'Projector04_Mat',
            shader: null,
            colorSrgb: [1, 1, 1],
            shininess: 0.5,
            specInt: 1,
          },
        },
      }),
    )
    for (const key of [
      'type',
      'vertexColors',
      'flatShading',
      'side',
      'transparent',
      'alphaTest',
      'fog',
      'map',
      'normalMap',
      'emissiveMap',
      'wireframe',
    ] as const)
      expect((deck as unknown as Record<string, unknown>)[key], key).toEqual(
        (pad as unknown as Record<string, unknown>)[key],
      )
    expect(deck.defines ?? {}).toEqual(pad.defines ?? {})
  })

  it("DEV-550: the glow's register is the JumpSeat engine's, off the sheet", () => {
    // `hover_engine (1)`: `Sphere (1)` inside an upturned `Projector04` — the
    // disc's size over the dish's, in the dish's own frame.
    const engine = JUMPSEAT.art.engines[0] as unknown as {
      sphere: { local: { scale: { x: number; y: number } } }
      projector: { local: { scale: { x: number; y: number } } }
    }
    const PAD_AABB = [5.54, 1.04] as const // `Projector04-Faceted`'s m_LocalAABB, as level.mjs reads it
    const across = engine.sphere.local.scale.x / (engine.projector.local.scale.x * PAD_AABB[0])
    const thick = engine.sphere.local.scale.y / (engine.projector.local.scale.y * PAD_AABB[1])
    expect(HOVER_GLOW_REGISTER.across).toBeCloseTo(across, 2)
    expect(HOVER_GLOW_REGISTER.thick).toBeCloseTo(thick, 2)
  })
})

// ── 2016's files ───────────────────────────────────────────────────────────────

describe.skipIf(!AVAILABLE)("2016's deck on the six decks (DEV-549)", () => {
  it("stands on 2016's own collision cubes, at their walking surface, and covers them", async () => {
    const art = await parse(DECK_FILE)
    expect(DECKS.map((l) => l.id).sort()).toEqual(
      [
        'adv_01_hoverJet',
        'adv_02_hoverJet',
        'hoverJet_kauai_beg',
        'int_01_hoverJet',
        'int_02_hoverJet',
        'int_01_jumpSeat',
      ].sort(),
    )
    for (const level of DECKS) {
      const grid = level.spawn.startGrid as StartGridSpec & { art: DeckPlacement[] }
      const surface = slabTopOf(grid.slabs[0] as StartGridSpec['slabs'][number]).y
      const samples = walkSamples(grid)
      const cover = (mirror: boolean) => {
        const placed = placeDeck(partsOf(art, mirror), grid.art)
        return {
          tiles: placed.tiles,
          share:
            samples.filter((p) => placed.tiles.some((t) => insideConvex(t.hull, p))).length /
            samples.length,
        }
      }
      const right = cover(false)
      const mirrored = cover(true)
      console.info(
        `DEV-549 ${level.id}: tiles cover ${(right.share * 100).toFixed(1)} % of the walking surface ` +
          `(mirrored in x: ${(mirrored.share * 100).toFixed(1)} %); tops ` +
          right.tiles.map((t) => (t.top - surface).toFixed(2)).join(' '),
      )
      expect(right.tiles, level.id).toHaveLength(9)
      // Every tile's top on the walking surface: 2016's tiles sit 0.03 under
      // to 0.26 over the cubes' tops (PolyWorld stones, hand placed).
      for (const t of right.tiles) {
        expect(t.top - surface, `${level.id}: a tile's top`).toBeGreaterThan(-0.1)
        expect(t.top - surface, `${level.id}: a tile's top`).toBeLessThan(0.3)
      }
      // THE CLAIM: the tiles are the deck the cubes are under — all of it but
      // the lift's own cell and a strip down one edge, where 2016's colliders
      // run 2 m past its art (82 % on every deck, measured).
      expect(right.share, `${level.id}: covered`).toBeGreaterThan(0.8)
      // The witness: the same tiles mirrored in their own x — the other
      // reading of Unity's FBX handedness — stand off the cubes.
      expect(mirrored.share, `${level.id}: mirrored, covered`).toBeLessThan(right.share - 0.05)
    }
  })

  it('cuts an opening under every pad, walls it, and nothing of the deck stands in one', async () => {
    const art = await parse(DECK_FILE)
    const padArt = await parse(PAD_FILE)
    for (const level of DECKS) {
      const grid = gridOf(level)
      grid.dress(padArt)
      const placements = (level.spawn.startGrid as { art: DeckPlacement[] }).art
      const deck = createStartDeck(art, placements, grid.pads)
      expect(deck.object.name).toBe(START_DECK_ART)
      expect(deck.openings, level.id).toHaveLength(grid.pads.length)
      const p = deck.object.geometry.getAttribute('position')
      // Each opening a hair smaller, so a vertex ON its edge (the cut, the
      // well's wall) is not counted as in it.
      const inset = deck.openings.map((o) => {
        const c = o.reduce((a, v) => ({ x: a.x + v.x / o.length, z: a.z + v.z / o.length }), {
          x: 0,
          z: 0,
        })
        return o.map((v) => ({ x: c.x + (v.x - c.x) * 0.999, z: c.z + (v.z - c.z) * 0.999 }))
      })
      let inside = 0
      const a = new THREE.Vector3()
      for (let t = 0; t + 2 < p.count; t += 3) {
        a.set(0, 0, 0)
        for (let k = 0; k < 3; k++) a.add(new THREE.Vector3().fromBufferAttribute(p, t + k))
        a.divideScalar(3)
        if (inset.some((o) => insideConvex(o, { x: a.x, z: a.z }))) inside++
      }
      expect(inside, `${level.id}: deck triangles inside an opening`).toBe(0)
      // Every pad's own footprint is inside its opening: so a pad rising up
      // its well (DEV-553) meets no deck on the way.
      grid.pads.forEach((pad, i) => {
        const opening = deck.openings[i] as Xz[]
        pad.updateWorldMatrix(true, true)
        const dish = pad.getObjectByName(START_PAD_ART) as THREE.Mesh
        const q = dish.geometry.getAttribute('position')
        const v = new THREE.Vector3()
        for (let k = 0; k < q.count; k++) {
          v.fromBufferAttribute(q, k).applyMatrix4(dish.matrixWorld)
          expect(insideConvex(opening, { x: v.x, z: v.z }), `${level.id} pad ${i}`).toBe(true)
        }
      })
      // A well under every pad that stands on a tile.
      const onTile = grid.pads.filter((pad) =>
        deck.tiles.some((t) => insideConvex(t.hull, { x: pad.position.x, z: pad.position.z })),
      )
      expect(onTile.length, `${level.id}: pads on the tiles`).toBeGreaterThanOrEqual(2)
      let lowest = Infinity
      for (let k = 0; k < p.count; k++) lowest = Math.min(lowest, p.getY(k))
      expect(lowest, `${level.id}: the wells reach down`).toBeLessThanOrEqual(
        deck.top - WELL_DEPTH + 1e-3,
      )
      deck.dispose()
      grid.dispose()
    }
  }, 120_000)

  it('DEV-550: a glow under every pad with nothing under it, centred under its dish, riding with it', async () => {
    const padArt = await parse(PAD_FILE)
    const deckArt = await parse(DECK_FILE)
    let floating = 0
    for (const level of LEVELS.filter((l) => !!l.spawn?.launch?.platform)) {
      const decked = (level.spawn.startGrid?.art?.length ?? 0) > 0
      const authored = decked ? (level.spawn.startGrid as StartGridSpec) : NO_DECK
      const release = releasePadOf(authored, level.spawn, level.spawn.launch)
      const slots = racerStarts(level, RACERS('anniversary')).filter(heldAtRelease)
      const specs = deckPadsOf(authored, release, slots)
      const grid = createStartGrid({ ...authored, pads: specs })
      grid.dress(padArt)
      const deck = decked
        ? createStartDeck(
            deckArt,
            (level.spawn.startGrid as { art: DeckPlacement[] }).art,
            grid.pads,
          )
        : null
      // `boot/app.ts`'s rule: not the player's (the lift's car, on its shaft's
      // head), and nothing of the deck under the centre.
      const under = grid.pads.map(
        (pad, i) =>
          specs[i]?.role !== 'player' &&
          !deck?.tiles.some((t) => insideConvex(t.hull, { x: pad.position.x, z: pad.position.z })),
      )
      grid.hover(under, glowMaterial())
      grid.pads.forEach((pad, i) => {
        const glow = grid.glows[i]
        if (!under[i]) {
          expect(glow, `${level.id} pad ${i}: on the deck, no glow`).toBeNull()
          return
        }
        floating++
        expect(glow?.name).toBe(START_PAD_GLOW)
        expect(glow?.parent, 'a child of its pad').toBe(pad)
        // Centred under what the pad draws, to a centimetre.
        pad.updateWorldMatrix(true, true)
        const dish = pad.getObjectByName(START_PAD_ART) as THREE.Mesh
        dish.geometry.computeBoundingBox()
        const box = (dish.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(dish.matrixWorld)
        const centre = box.getCenter(new THREE.Vector3())
        const at = (glow as THREE.Mesh).getWorldPosition(new THREE.Vector3())
        expect(Math.hypot(at.x - centre.x, at.z - centre.z), `${level.id} pad ${i}`).toBeLessThan(
          0.01,
        )
        // Hanging from the dish's foot: its top on the foot (to 2 cm: a pad
        // turned with its rig leans as `int_02`'s does).
        const halfThick = (glow as THREE.Mesh).scale.y / 2
        expect(
          Math.abs(at.y + halfThick - box.min.y),
          `${level.id} pad ${i}: hung from the foot`,
        ).toBeLessThan(0.02)
      })
      // It rises with its pad, and hides with the player's.
      grid.arrive(ARRIVAL_DROP)
      grid.pads.forEach((pad, i) => {
        const glow = grid.glows[i]
        if (glow) expect(glow.parent).toBe(pad)
      })
      grid.setHeld(true)
      grid.pads.forEach((pad, i) => {
        const glow = grid.glows[i]
        if (glow && !pad.visible) expect(glow.parent?.visible).toBe(false)
      })
      deck?.dispose()
      grid.dispose()
    }
    // The two rookie courses float all five racers' pads (never the player's).
    expect(floating, 'pads float').toBeGreaterThanOrEqual(10)
  }, 120_000)
})

// The loud counterpart asserts only in the maintainer checkout: these are BOUGHT assets,
// which the public export and its content pack never carry (plan/PUBLIC-REPO-facetedflight.md
// §4.3, Matt M4), so a public clone skips both halves. tests/unit/helpers/checkout.ts.
describe.skipIf(AVAILABLE || !MAINTAINER_CHECKOUT)("2016's deck: the GLBs are not hydrated", () => {
  it('says so, rather than passing quietly', () => {
    expect(
      fs.existsSync(DECK_FILE) && fs.existsSync(PAD_FILE),
      `pnpm assets:pull (or node tools/assets/convert-start-deck.mjs) to measure ${DECK_FILE} and ${PAD_FILE}`,
    ).toBe(true)
  })
})
