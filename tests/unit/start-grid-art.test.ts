// tests/unit/start-grid-art.test.ts — the start deck, seen from the seat (DEV-443),
// and 2016's pads on it (DEV-444).
//
// Matt, 2026-09-27: *"let's make sure that the starting platform (where all the
// racers start from) is there - i don't see it anymore"* and *"give the other
// planes the same "pad" art we had in the 2016 game."*
//
// DEV-443 was not a deck that stopped drawing: it drew three slabs and a light
// bar a frame, behind 2016's shaft head, which DEV-438 stood 1.65 to 1.96 m
// over the deck and half a metre under the eye. So the claim here is a
// SIGHTLINE, measured from the eye at the top of the ride against the real
// shaft file: every sample of the deck's walking surface the GENERATED shaft let
// the seat see — the shaft the port had before DEV-438, cut at `rimY` by
// DEV-106 — 2016's shaft lets it see too. The same sweep over 2016's shaft
// uncut is kept as the witness that the cause is in the file, not in the test.
//
// DEV-444's claims are distances, never a rotation (the orientation lesson):
// the player's pad, placed from the MISSION scene through `level.mjs` and the
// pad's own file, lands on the lift's dish, placed from the MENU scene through
// `convert-hangar-art.mjs` and `fromRoom` — two pipelines that share nothing but
// the Unity mesh, and 2016 authored the two dishes 2.7 cm apart at one yaw. A
// mirror or a turn in either misses by the dish's own asymmetry (its AABB sits
// 0.2 m off its origin). And every ship on the grid clears the dish under it,
// measured down from its hull onto the art.
//
// Both GLBs are bought geometry and never in git (hard rule 7), so the half that
// reads them is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi } from 'vitest'
import type { EditionRacers } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { EYE } from '@/game/flight'
import { racerStarts } from '@/game/racer-grid'
import { HOVERJET } from '@/generated/constants.generated'
import { createElevator } from '@/render/elevator'
import { createHangar } from '@/render/hangar'
import { createLaunchArt, HANGAR_ROOM_MESH } from '@/render/hangar-art'
import {
  createStartGrid,
  cutShaftAtRim,
  deckPadsOf,
  heldAtRelease,
  NO_DECK,
  padsUnder,
  releasePadOf,
  START_PAD_ART,
  START_PAD_MESH,
  type StartGridSpec,
  trimAbove,
} from '@/render/start-grid'
import { hangarSpecFor } from '@/sim/hangar'
import { hullFromColliders } from '@/sim/terrain-collision'
import { MAINTAINER_CHECKOUT } from './helpers/checkout'
import { fieldFor, groundUnder, haveMaps } from './helpers/terrain-field'

const ROOM_FILE = `public/${HANGAR_ROOM_MESH}`
const PAD_FILE = `public/${START_PAD_MESH}`
const AVAILABLE = fs.existsSync(ROOM_FILE) && fs.existsSync(PAD_FILE)

type Rig = Level & {
  spawn: Level['spawn'] & { startGrid?: StartGridSpec }
}

/** Every course with a start deck, straight off the extracted level JSON. */
const DECKS: Rig[] = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')) as Rig)
  .filter((l) => (l.spawn?.startGrid?.slabs?.length ?? 0) > 0)

/** Every course with a lift (DEV-457's two rookie courses have no deck). */
const LIFTS: Rig[] = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')) as Rig)
  .filter((l) => !!l.spawn?.launch?.platform)

const deckOf = (id: string): Rig => {
  const l = DECKS.find((d) => d.id === id)
  if (!l) throw new Error(`no start deck on ${id}`)
  return l
}

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

const worldPoints = (mesh: THREE.Mesh): THREE.Vector3[] => {
  mesh.updateWorldMatrix(true, false)
  const p = mesh.geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < p.count; i++)
    out.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld))
  return out
}

/** Metres from a HoverJet's origin down to the lowest point of its hull, off the sheet. */
const HULL = (() => {
  let lowest = 0
  for (const s of hullFromColliders(
    HOVERJET.shipCollisionColliders as unknown as Parameters<typeof hullFromColliders>[0],
  ))
    lowest = Math.min(lowest, s.y - s.radius)
  return -lowest
})()

/**
 * A mission's launch, built as `boot/app.ts` builds it: an anchor at the ship's
 * resting pose (the spawn, which the level JSON carries in three space), the
 * elevator and the launch room on it, and — `dressed` — 2016's rig through the
 * lift app.ts hands it.
 */
const launchRig = async (level: Rig, how: 'generated' | 'cut' | 'uncut') => {
  const launch = level.spawn.launch
  if (!launch?.platform || !launch.shaft) throw new Error(`${level.id} has no lift`)
  const anchor = new THREE.Group()
  anchor.position.fromArray(level.spawn.pos as number[])
  anchor.quaternion.fromArray(level.spawn.quat as number[])
  const elevator = createElevator({
    platform: launch.platform,
    shaft: launch.shaft,
    rise: launch.rise,
    hangar: hangarSpecFor(),
    seed: 0x48414e47,
  })
  anchor.add(elevator.object)
  const room = createHangar({
    spec: hangarSpecFor(),
    seed: 0x48414e47,
    furnished: false,
    title: '',
    subtitle: '',
    level: null,
  })
  anchor.add(room.object)
  if (how !== 'generated') {
    const loaded = await parse(ROOM_FILE)
    const ok = await createLaunchArt({
      room: room.object,
      lift: how === 'cut' ? cutShaftAtRim(elevator) : elevator,
      alive: () => true,
      load: async () => loaded,
    }).ready
    expect(ok, `${level.id}: 2016's rig stood`).toBe(true)
  }
  elevator.setRise(launch.rise)
  anchor.updateMatrixWorld(true)
  // The eye at the top of the ride: the ship's resting place moved up the rise,
  // and EYE in the ship's frame, which is the anchor's.
  const eye = EYE.clone()
    .applyQuaternion(anchor.quaternion)
    .add(anchor.position)
    .add(new THREE.Vector3(0, launch.rise, 0))
  return { anchor, elevator, eye, launch }
}

/** The deck's walking surface, sampled: a grid over each slab's top face, inset. */
const deckSamples = (grid: StartGridSpec, n = 9, inset = 0.5): THREE.Vector3[] => {
  const out: THREE.Vector3[] = []
  for (const slab of grid.slabs) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(slab.pos as number[]),
      new THREE.Quaternion().fromArray(slab.quat as number[]),
      new THREE.Vector3(1, 1, 1),
    )
    const [w, h, d] = slab.size as [number, number, number]
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = -w / 2 + inset + ((w - 2 * inset) * i) / (n - 1)
        const z = -d / 2 + inset + ((d - 2 * inset) * j) / (n - 1)
        out.push(new THREE.Vector3(x, h / 2, z).applyMatrix4(m))
      }
  }
  return out
}

/** Which samples a ray from the eye reaches past everything the lift draws, released. */
const seen = (
  rig: Awaited<ReturnType<typeof launchRig>>,
  samples: readonly THREE.Vector3[],
): boolean[] => {
  // Released: the platform (and 2016's deck with it) goes, and what stands is
  // the shaft. The deck hides with the lift in both builds alike, so the
  // comparison is the shaft's and nothing else's.
  rig.elevator.setReleased(true)
  rig.anchor.updateMatrixWorld(true)
  const occluders: THREE.Object3D[] = []
  rig.elevator.object.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (let n: THREE.Object3D | null = mesh; n; n = n.parent) if (!n.visible) return
    occluders.push(mesh)
  })
  const ray = new THREE.Raycaster()
  return samples.map((s) => {
    const to = s.clone().sub(rig.eye)
    const far = to.length()
    ray.set(rig.eye, to.normalize())
    ray.far = far - 0.05
    return ray.intersectObjects(occluders, false).length === 0
  })
}

// ── The cut, on geometry that is not the shaft ─────────────────────────────────

describe('trimAbove', () => {
  const triangle = (a: number[], b: number[], c: number[]) => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3))
    g.setAttribute(
      'color',
      new THREE.Float32BufferAttribute([...[1, 0, 0], ...[0, 1, 0], ...[0, 0, 1]], 3),
    )
    return g
  }
  const normalOf = (g: THREE.BufferGeometry, t = 0) => {
    const p = g.getAttribute('position')
    const a = new THREE.Vector3().fromBufferAttribute(p, t * 3)
    const b = new THREE.Vector3().fromBufferAttribute(p, t * 3 + 1)
    const c = new THREE.Vector3().fromBufferAttribute(p, t * 3 + 2)
    return b.sub(a).cross(c.sub(a))
  }

  it('hands back what stands wholly under the line, untouched', () => {
    const g = triangle([0, 0, 0], [1, 0, 0], [0, 1, 0])
    expect(trimAbove(g, 1)).toBe(g)
  })

  it('drops what stands wholly over it', () => {
    const g = trimAbove(triangle([0, 2, 0], [1, 2, 0], [0, 3, 0]), 1)
    expect(g.getAttribute('position').count).toBe(0)
  })

  it('clips a crossing triangle to the line, keeping its winding and its colour', () => {
    // One corner over: the part under the line is a quad, two triangles.
    const src = triangle([0, 0, 0], [2, 0, 0], [0, 2, 0])
    const cut = trimAbove(src, 1)
    const p = cut.getAttribute('position')
    expect(p.count).toBe(6)
    let top = -Infinity
    for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i))
    expect(top).toBe(1)
    // Same facing for every piece as the source.
    const n = normalOf(src).normalize()
    for (const t of [0, 1]) expect(normalOf(cut, t).normalize().dot(n)).toBeCloseTo(1, 9)
    // Area under the line: 2 - 0.5 of the whole 2.
    let area = 0
    for (const t of [0, 1]) area += normalOf(cut, t).length() / 2
    expect(area).toBeCloseTo(1.5, 9)
    // The new corner on the (0,0)-(0,2) edge is halfway: colour halfway, red to blue.
    const c = cut.getAttribute('color')
    let halfway = false
    for (let i = 0; i < p.count; i++)
      if (Math.abs(p.getX(i)) < 1e-9 && Math.abs(p.getY(i) - 1) < 1e-9)
        halfway = Math.abs(c.getX(i) - 0.5) < 1e-6 && Math.abs(c.getZ(i) - 0.5) < 1e-6
    expect(halfway).toBe(true)
  })
})

// ── Where FF2's own starts stand ───────────────────────────────────────────────

/** The lift's own `rimY` for a level: where its deck's foot arrives, in the anchor's frame. */
const rimOf = (level: Rig): number => {
  const launch = level.spawn.launch
  if (!launch?.platform || !launch.shaft) throw new Error(`${level.id} has no lift`)
  return createElevator({
    platform: launch.platform,
    shaft: launch.shaft,
    rise: launch.rise,
    hangar: hangarSpecFor(),
    seed: 1,
  }).rimY
}

describe("the pad under a ship at the release (DEV-444's placement, from the level JSON)", () => {
  it("stands at the lift's height on every deck with a lift — the elevator's own rimY", () => {
    let decks = 0
    for (const level of DECKS) {
      if (!level.spawn.launch?.platform) continue
      decks++
      const pad = releasePadOf(
        level.spawn.startGrid as StartGridSpec,
        level.spawn,
        level.spawn.launch,
      )
      // To the millimetre: since DEV-548 the pad rises along the seat's own
      // up, as the lift does, and `int_02`'s seat leans 0.1 degrees.
      expect(
        Math.abs((pad?.pos[1] as number) - ((level.spawn.pos[1] as number) + rimOf(level))),
        level.id,
      ).toBeLessThan(0.001)
    }
    expect(decks, 'the five HoverJet decks').toBe(5)
  })

  it("DEV-548: is the lift's own dish, docked — the rig's dish, at the lift's height", () => {
    const census: string[] = []
    for (const level of DECKS) {
      const launch = level.spawn.launch
      if (!launch?.platform) continue
      const dish = (launch as { dish?: { size: number[] } }).dish
      expect(dish, `${level.id}: the extractor carries the lift's dish`).toBeDefined()
      const pad = releasePadOf(level.spawn.startGrid as StartGridSpec, level.spawn, launch)
      // Its size is the dish's own (1.688 x 1.606 x 1.688 of the mesh), and the
      // grid's `(1)` no longer decides it.
      expect(pad?.size, level.id).toEqual(dish?.size)
      // Its height is the elevator's rim, read off the elevator (a different
      // rule: the rig constants), to the centimetre.
      expect(
        Math.abs((pad?.pos[1] as number) - ((level.spawn.pos[1] as number) + rimOf(level))),
        `${level.id}: the dish's foot at the lift's rim`,
      ).toBeLessThan(0.01)
      // The census of what DEV-548 moved: 2016's authored player pad against
      // the docked dish, up and across. The ledger row quotes it.
      const player = level.spawn.startGrid?.pads.find((p) => p.role === 'player')
      if (!player || !pad) continue
      const up = (player.pos[1] as number) - (pad.pos[1] as number)
      const across = Math.hypot(
        (player.pos[0] as number) - (pad.pos[0] as number),
        (player.pos[2] as number) - (pad.pos[2] as number),
      )
      census.push(`${level.id} up ${up.toFixed(2)} across ${across.toFixed(2)}`)
    }
    console.info(`DEV-548 census: ${census.sort().join(' / ')}`)
    // Node origin to node origin. Two decks 2016 authored over its lift to the
    // centimetre, one 0.41 m high, and the two DEV-548 moves across: `adv_02`
    // 1.65 m, and `int_02`'s `2 (1)` 0.88 m — an AI-sized pad turned 56 degrees
    // off the dish, whose worst vertex was 1.62 m from it (DEV-461).
    expect(census.sort()).toEqual([
      'adv_01_hoverJet up 0.41 across 0.00',
      'adv_02_hoverJet up 0.65 across 1.65',
      'hoverJet_kauai_beg up -0.03 across 0.00',
      'int_01_hoverJet up -0.03 across 0.00',
      'int_02_hoverJet up 0.55 across 0.88',
    ])
  })

  it("DEV-548: the grid's own player pad no longer moves it", () => {
    // `int_02`'s deck with its `2 (1)` taken away stands the same pad.
    const int02 = deckOf('int_02_hoverJet')
    const authored = int02.spawn.startGrid as StartGridSpec
    expect(
      authored.pads.some((p) => p.role === 'player'),
      "int_02's own pad is found",
    ).toBe(true)
    const without: StartGridSpec = {
      ...authored,
      pads: authored.pads.filter((p) => p.role !== 'player'),
    }
    expect(releasePadOf(without, int02.spawn, int02.spawn.launch)).toEqual(
      releasePadOf(authored, int02.spawn, int02.spawn.launch),
    )
  })

  it("keeps the pre-DEV-548 rule for a launch with no dish: (1)'s place, the platform's height", () => {
    const int01 = deckOf('int_01_hoverJet')
    const launch = int01.spawn.launch
    if (!launch?.platform) throw new Error('int_01 has no lift')
    const old = { rise: launch.rise, platform: launch.platform }
    const grid = int01.spawn.startGrid as StartGridSpec
    const player = grid.pads.find((p) => p.role === 'player')
    const pad = releasePadOf(grid, int01.spawn, old)
    expect(pad?.pos[0]).toBe(player?.pos[0])
    expect(pad?.pos[2]).toBe(player?.pos[2])
    expect(pad?.pos[1]).toBeCloseTo((int01.spawn.pos[1] as number) + rimOf(int01), 6)
  })

  it("DEV-547: 2016's AI pads take the lift's size where they stand, and the JumpSeat's deck keeps its own", () => {
    for (const level of DECKS) {
      const grid = level.spawn.startGrid as StartGridSpec
      const release = releasePadOf(grid, level.spawn, level.spawn.launch)
      const drawn = deckPadsOf(grid, release, [])
      const ai = grid.pads.filter((p) => p.role !== 'player')
      expect(ai.length, `${level.id}: 2016's AI pads`).toBeGreaterThanOrEqual(2)
      for (const pad of ai) {
        const d = drawn.find((x) => x.pos === pad.pos)
        expect(d, `${level.id}: the pad is drawn where 2016 stood it`).toBeDefined()
        expect(d?.quat, level.id).toBe(pad.quat)
        if (release) {
          expect(d?.size, `${level.id}: the lift's size`).toEqual(release.size)
          // 10 % narrower than 2016 authored it, and a lift's dish.
          expect((pad.size[0] as number) / (d?.size[0] as number)).toBeCloseTo(1.106, 2)
        } else {
          expect(d?.size, `${level.id}: no lift to size from`).toBe(pad.size)
        }
      }
    }
  })

  it("DEV-461's prototype: arrive lowers every pad but the player's, and 0 puts them back", () => {
    const int01 = deckOf('int_01_hoverJet')
    const grid = int01.spawn.startGrid as StartGridSpec
    const start = createStartGrid(grid)
    start.arrive(4.5)
    grid.pads.forEach((pad, i) => {
      const y = (start.pads[i] as THREE.Object3D).position.y
      expect(y, pad.role).toBeCloseTo((pad.pos[1] as number) - (pad.role === 'player' ? 0 : 4.5), 9)
    })
    start.arrive(0)
    grid.pads.forEach((pad, i) => {
      expect((start.pads[i] as THREE.Object3D).position.y).toBeCloseTo(pad.pos[1] as number, 9)
    })
    start.dispose()
  })

  it('is nothing at all without a lift', () => {
    const jump = deckOf('int_01_jumpSeat')
    expect(
      releasePadOf(jump.spawn.startGrid as StartGridSpec, jump.spawn, jump.spawn.launch),
    ).toBeNull()
  })

  it('moves the template across the deck and nothing else', () => {
    const int01 = deckOf('int_01_hoverJet')
    const template = releasePadOf(
      int01.spawn.startGrid as StartGridSpec,
      int01.spawn,
      int01.spawn.launch,
    )
    if (!template) throw new Error('int_01 has no release pad')
    const starts = racerStarts(int01, RACERS('anniversary')).filter((s) => s.from.kind === 'slot')
    const pads = padsUnder(template, starts, 'ai')
    expect(pads).toHaveLength(starts.length)
    pads.forEach((pad, i) => {
      expect(pad.pos[0]).toBe((starts[i] as (typeof starts)[number]).pos[0])
      expect(pad.pos[2]).toBe((starts[i] as (typeof starts)[number]).pos[2])
      expect(pad.pos[1]).toBe(template.pos[1])
      expect(pad.quat).toBe(template.quat)
      expect(pad.size).toBe(template.size)
    })
  })
})

// ── 2016's files ───────────────────────────────────────────────────────────────

describe.skipIf(!AVAILABLE)('the start deck from the seat, and the pads on it', () => {
  it("DEV-443: 2016's shaft, cut at the rim, hides none of the deck the generated shaft showed", async () => {
    for (const id of ['int_01_hoverJet', 'adv_02_hoverJet', 'hoverJet_kauai_beg']) {
      const level = deckOf(id)
      const samples = deckSamples(level.spawn.startGrid as StartGridSpec)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const before = seen(await launchRig(level, 'generated'), samples)
      const cut = await launchRig(level, 'cut')
      const after = seen(cut, samples)
      const uncut = seen(await launchRig(level, 'uncut'), samples)
      warn.mockRestore()
      const count = (xs: boolean[]) => xs.filter(Boolean).length
      console.info(
        `DEV-443 ${id}: deck samples seen from the seat — generated ${count(before)}, ` +
          `2016 cut ${count(after)}, 2016 uncut ${count(uncut)} of ${samples.length}`,
      )
      // The premise: the seat sees the deck at all, and 2016's shaft as it
      // stands in the file walls part of it off. If this stops failing to see,
      // the witness has gone and this test says nothing.
      expect(count(before), `${id}: the seat sees the deck`).toBeGreaterThan(samples.length / 4)
      expect(count(uncut), `${id}: 2016's shaft head, uncut, hides some of it`).toBeLessThan(
        count(before),
      )
      // THE CLAIM.
      const lost = samples.filter((_, i) => before[i] && !after[i])
      expect(
        lost.map((p) => p.toArray().map((n) => +n.toFixed(1))),
        `${id}: deck lost to the shaft`,
      ).toEqual([])
      // And the mechanism, by name: nothing of the shaft over the lift's
      // arrival, in the lift's own frame — the frame `rimY` is written in.
      const shaft = cut.elevator.object.getObjectByName('elevator-shaft-2016') as THREE.Mesh
      const p = shaft.geometry.getAttribute('position')
      let top = -Infinity
      for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i))
      expect(top, `${id}: shaft top vs rim`).toBeLessThanOrEqual(cut.elevator.rimY + 1e-5)
    }
  }, 120_000)

  it("DEV-444: the player's pad lands on the lift's dish — two pipelines, one place", async () => {
    const pad = await parse(PAD_FILE)
    const worst: Record<string, string> = {}
    for (const level of DECKS) {
      const grid = level.spawn.startGrid as StartGridSpec
      const release = releasePadOf(grid, level.spawn, level.spawn.launch)
      const at = grid.pads.findIndex((p) => p.role === 'player')
      if (at < 0 || !release) continue
      const start = createStartGrid({ ...grid, pads: deckPadsOf(grid, release, []) })
      start.dress(pad)
      start.object.updateMatrixWorld(true)
      const art = (start.pads[at] as THREE.Object3D).getObjectByName(START_PAD_ART) as THREE.Mesh
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const rig = await launchRig(level, 'cut')
      warn.mockRestore()
      const dish = rig.elevator.object.getObjectByName('elevator-deck-2016') as THREE.Mesh
      const lift = worldPoints(dish)
      const mine = worldPoints(art)
      let far = 0
      for (const p of mine) {
        let best = Infinity
        for (const q of lift) best = Math.min(best, p.distanceToSquared(q))
        far = Math.max(far, Math.sqrt(best))
      }
      // And the height alone, which holds on every deck: the two feet.
      const foot = (pts: THREE.Vector3[]) => Math.min(...pts.map((v) => v.y))
      const feet = foot(mine) - foot(lift)
      console.info(
        `DEV-444 ${level.id}: player pad to the lift's dish, worst vertex ${far.toFixed(3)} m, feet ${feet.toFixed(4)} m`,
      )
      expect(Math.abs(feet), `${level.id}: the pad's foot is the dish's`).toBeLessThan(0.01)
      worst[level.id] = far.toFixed(2)
      start.dispose()
    }
    // DEV-548: vertex for vertex on all five, now that the pad IS the dish —
    // 8 mm, the extractor's rounded AABB. Until DEV-548 the pad stood where
    // 2016 authored `(1)`, and `adv_02` missed by 1.65 m and `int_02` (its
    // `2 (1)`) by 1.62. The dish's pose comes off the MISSION scene
    // (`level.mjs`, `launch.dish`) and the lift's off the MENU scene
    // (`convert-hangar-art.mjs`, `fromRoom`), so this is still two pipelines;
    // and a mirror or a turn misses by the dish's own asymmetry.
    expect(worst).toEqual({
      adv_01_hoverJet: '0.01',
      adv_02_hoverJet: '0.01',
      hoverJet_kauai_beg: '0.01',
      int_01_hoverJet: '0.01',
      int_02_hoverJet: '0.01',
    })
  }, 120_000)

  it("DEV-444: dresses every pad in 2016's art, the player's in lambert1, and hides the octagons", async () => {
    const int01 = deckOf('int_01_hoverJet')
    const grid = int01.spawn.startGrid as StartGridSpec
    const template = releasePadOf(grid, int01.spawn, int01.spawn.launch)
    if (!template) throw new Error('int_01 has no release pad')
    const slots = racerStarts(int01, RACERS('anniversary')).filter((s) => s.from.kind === 'slot')
    const start = createStartGrid({ ...grid, pads: deckPadsOf(grid, template, slots) })
    const prepared: THREE.Material[] = []
    start.dress(await parse(PAD_FILE), (m) => prepared.push(m))
    expect(prepared.length, 'both materials go through the mission prepare').toBe(2)
    const names = new Set<string>()
    for (const [i, group] of start.pads.entries()) {
      const drawn = group.children.filter((c) => c.visible)
      expect(
        drawn.map((c) => c.name),
        `pad ${i}`,
      ).toEqual([START_PAD_ART])
      const material = (drawn[0] as THREE.Mesh).material as THREE.Material
      names.add(material.name)
      const role = i < grid.pads.length ? (grid.pads[i] as { role: string }).role : 'ai'
      expect(material.name, `pad ${i} (${role})`).toBe(
        role === 'player' ? 'lambert1' : 'Projector04_Mat',
      )
    }
    expect([...names].sort()).toEqual(['Projector04_Mat', 'lambert1'])
    // The player's is off while the lift holds the ship, and only the player's.
    start.setHeld(true)
    expect(start.pads.map((g) => g.visible)).toEqual(
      start.pads.map((_, i) => (grid.pads[i] as { role: string } | undefined)?.role !== 'player'),
    )
    start.setHeld(false)
    expect(start.pads.every((g) => g.visible)).toBe(true)
    start.dispose()
  })

  it('DEV-444/457: every ship on the grid clears the dish under it, on both presets and every lift', async () => {
    const pad = await parse(PAD_FILE)
    const ray = new THREE.Raycaster()
    let rookies = 0
    for (const level of LIFTS) {
      // As `boot/app.ts` builds it: the authored deck, or none (DEV-457).
      const grid = level.spawn.startGrid?.slabs?.length ? level.spawn.startGrid : NO_DECK
      if (grid === NO_DECK) rookies++
      const template = releasePadOf(grid, level.spawn, level.spawn.launch)
      if (!template || !level.spawn.launch) continue
      const release = (level.spawn.pos[1] as number) + level.spawn.launch.rise
      for (const edition of ['classic', 'anniversary']) {
        const starts = racerStarts(level, RACERS(edition))
        const slots = starts.filter(heldAtRelease)
        const start = createStartGrid({ ...grid, pads: deckPadsOf(grid, template, slots) })
        start.dress(pad)
        start.object.updateMatrixWorld(true)
        const dishes = start.pads.map((g) => g.getObjectByName(START_PAD_ART) as THREE.Mesh)
        // The player where the deck draws a pad for it (not `int_02`'s: 2016
        // authored none there, and the lift's dish is the player's pad).
        const player = grid.pads.some((p) => p.role === 'player')
          ? [
              {
                who: 'player',
                pos: [level.spawn.pos[0] as number, release, level.spawn.pos[2] as number],
              },
            ]
          : []
        const ships = [
          ...player,
          ...starts.map((s) => ({ who: `${s.from.kind} ${s.from.index}`, pos: [...s.pos] })),
        ]
        for (const ship of ships) {
          // Straight down from the lowest point of the hull, onto the art.
          const belly = new THREE.Vector3(ship.pos[0], (ship.pos[1] as number) - HULL, ship.pos[2])
          ray.set(belly.clone().add(new THREE.Vector3(0, 50, 0)), new THREE.Vector3(0, -1, 0))
          ray.far = 100
          const hit = ray.intersectObjects(dishes, false)[0]
          expect(hit, `${level.id} ${edition} ${ship.who}: a dish under it`).toBeDefined()
          const clearance = belly.y - (hit as THREE.Intersection).point.y
          expect(
            clearance,
            `${level.id} ${edition} ${ship.who}: belly over the dish`,
          ).toBeGreaterThan(0.05)
        }
        start.dispose()
      }
    }
    expect(rookies, 'the two rookie courses, which have no deck').toBe(2)
  }, 120_000)

  it("DEV-457: five racers' pads on each rookie course and the player's, none in another, over the ground", async () => {
    // Matt: *"5 racers on rookie"*. The two courses authored no deck and no
    // `ai` pad, so every pad there is DEV-444's pad under a ship held at the
    // release: 2016's two ghost starts, off the shoulders, and the three slots.
    for (const level of LIFTS.filter((l) => !l.spawn.startGrid?.slabs?.length)) {
      const template = releasePadOf(NO_DECK, level.spawn, level.spawn.launch)
      if (!template) throw new Error(`${level.id}: no pad under the release`)
      const starts = racerStarts(level, RACERS('anniversary')).filter(heldAtRelease)
      const pads = deckPadsOf(NO_DECK, template, starts)
      expect(
        starts.map((s) => s.from.kind),
        level.id,
      ).toEqual(['ghost', 'ghost', 'slot', 'slot', 'slot'])
      // Five racers' pads, led since DEV-548 by the player's own — the lift's
      // dish hands over to it at the dock, so it must be there to hand to.
      expect(
        pads.map((p) => p.role),
        level.id,
      ).toEqual(['player', 'ai', 'ai', 'ai', 'ai', 'ai'])
      expect(pads[0], `${level.id}: the player's is the pad under the release`).toBe(template)
      const reach = Math.hypot(template.size[0] as number, template.size[2] as number) / 2
      for (let i = 0; i < pads.length; i++) {
        for (let j = i + 1; j < pads.length; j++) {
          const a = (pads[i] as StartGridSpec['pads'][number]).pos
          const b = (pads[j] as StartGridSpec['pads'][number]).pos
          const d = Math.hypot(
            (a[0] as number) - (b[0] as number),
            (a[2] as number) - (b[2] as number),
          )
          // Two dishes meet only inside the sum of their reaches.
          expect(d, `${level.id}: pads ${i} and ${j}`).toBeGreaterThan(2 * (reach - 0.8))
        }
      }
      if (!haveMaps) continue
      // The ground: each pad's foot above the collision surface under its
      // footprint, sampled over its corners and centre, with the generator's
      // jitter as a margin (CLAUDE.md: `heightField` is not what you see).
      const field = fieldFor(level as unknown as { environment: string; worldOffset: number[] })
      const jitter = 0.8
      for (const [i, p] of pads.entries()) {
        let ground = Number.NEGATIVE_INFINITY
        for (const [dx, dz] of [
          [0, 0],
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ] as const) {
          ground = Math.max(
            ground,
            groundUnder(field, [
              (p.pos[0] as number) + dx * reach,
              0,
              (p.pos[2] as number) + dz * reach,
            ]),
          )
        }
        const foot = p.pos[1] as number
        console.info(
          `DEV-457 ${level.id} pad ${i}: foot ${foot.toFixed(2)}, ground ${ground.toFixed(2)}`,
        )
        expect(foot - ground, `${level.id} pad ${i}: over the ground`).toBeGreaterThan(jitter)
      }
    }
  })
})

// The loud counterpart asserts only in the maintainer checkout: these are BOUGHT assets,
// which the public export and its content pack never carry (plan/PUBLIC-REPO-facetedflight.md
// §4.3, Matt M4), so a public clone skips both halves. tests/unit/helpers/checkout.ts.
describe.skipIf(AVAILABLE || !MAINTAINER_CHECKOUT)(
  'the start deck from the seat: the GLBs are not hydrated',
  () => {
    it('says so, rather than passing quietly', () => {
      expect(
        fs.existsSync(ROOM_FILE) && fs.existsSync(PAD_FILE),
        `pnpm assets:pull (or tools/assets/convert-*.mjs) to measure ${ROOM_FILE} and ${PAD_FILE}`,
      ).toBe(true)
    })
  },
)
