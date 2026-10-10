// tests/unit/start-grid.test.ts — the race start platform.
//
// Matt: *"i'm talking about the race start platform with the ai launch positions
// and whatnot."* It was in the scene all along and the port drew none of it.
//
// The interesting property here is not any single number — it is that two
// completely separate derivations of the SAME mesh agree. `spawn.launch.platform
// .size` was measured off `Projector04-Faceted`'s AABB for the elevator months
// ago; `spawn.startGrid.pads[player].size` gets there through the scene graph,
// a different node, and a different scale. If they ever disagree, one of them is
// reading the wrong mesh.

import { describe, expect, it } from 'vitest'
import leftSpawn from '../../content/ghosts/int_01_leftSpawn_fast_01.json'
import rightSpawn from '../../content/ghosts/int_01_rightSpawn_slow_01.json'
import int01 from '../../content/levels/int_01_hoverJet.json'

const GRID = int01.spawn.startGrid
const LAUNCH = int01.spawn.launch

describe('the start grid comes out of the scene', () => {
  it('has three deck slabs and three pads, two of them AI', () => {
    expect(GRID.slabs).toHaveLength(3)
    expect(GRID.pads).toHaveLength(3)
    expect(GRID.pads.filter((p) => p.role === 'ai')).toHaveLength(2)
    expect(GRID.pads.filter((p) => p.role === 'player')).toHaveLength(1)
    // Two AI pads, and int_01 races exactly two 2016 ghosts. That is the whole
    // reason the pads are worth drawing.
    expect(int01.ghosts.length).toBe(2)
  })

  it('agrees with the ELEVATOR about the player pad, by a different route', () => {
    // The cross-check. Same mesh, two derivations that share nothing.
    const player = GRID.pads.find((p) => p.role === 'player')
    expect(player).toBeDefined()
    const size = player?.size as number[]
    const platform = LAUNCH.platform.size as number[]
    expect(size[0]).toBeCloseTo(platform[0] as number, 1)
    expect(size[2]).toBeCloseTo(platform[2] as number, 1)
    // Thickness is the loosest of the three because the elevator node is scaled
    // 1.606 in y where the pad node is 1.688 uniformly. 8 cm apart.
    expect(Math.abs((size[1] as number) - (platform[1] as number))).toBeLessThan(0.1)
  })

  it('puts the player pad under the SHIP, not somewhere plausible', () => {
    // The ship is released at spawn + rise. If the pad is not under that, the
    // grid has been placed in the wrong parent space — which is trap 15, and
    // this prefab family has now produced it twice.
    const player = GRID.pads.find((p) => p.role === 'player')
    const pos = player?.pos as number[]
    const spawn = int01.spawn.pos as number[]
    expect(
      Math.hypot(
        (pos[0] as number) - (spawn[0] as number),
        (pos[2] as number) - (spawn[2] as number),
      ),
    ).toBeLessThan(2)
    // And just below the released ship, not at the bottom of the shaft.
    const released = (spawn[1] as number) + LAUNCH.rise
    expect(pos[1] as number).toBeLessThan(released)
    expect(pos[1] as number).toBeGreaterThan(released - 4)
  })

  it('has the AI pads flanking the player, ~16 m out', () => {
    const player = GRID.pads.find((p) => p.role === 'player')?.pos as number[]
    const ai = GRID.pads.filter((p) => p.role === 'ai')
    for (const pad of ai) {
      const p = pad.pos as number[]
      const d = Math.hypot(
        (p[0] as number) - (player[0] as number),
        (p[2] as number) - (player[2] as number),
      )
      expect(d).toBeGreaterThan(12)
      expect(d).toBeLessThan(20)
    }
    // Opposite sides, not both off one shoulder — they are a starting GRID.
    const pts = ai.map((p) => p.pos as number[])
    const a = pts[0] as number[]
    const b = pts[1] as number[]
    const cross =
      ((a[0] as number) - (player[0] as number)) * ((b[2] as number) - (player[2] as number)) -
      ((a[2] as number) - (player[2] as number)) * ((b[0] as number) - (player[0] as number))
    expect(Math.abs(cross)).toBeLessThan(60)
  })

  it('puts the deck ABOVE the sea and the start line ON the deck', () => {
    // Sea level on Simonet is 116.6. The slabs are 22 m deep, so most of the
    // platform is under water and the top face is what you stand on.
    const SEA = 116.6
    for (const slab of GRID.slabs) {
      const top = (slab.pos[1] as number) + (slab.size[1] as number) / 2
      expect(top).toBeGreaterThan(SEA)
      expect((slab.pos[1] as number) - (slab.size[1] as number) / 2).toBeLessThan(SEA)
    }
    // The light bar sits within a few cm of the slab tops, which is how we know
    // the collider top IS the walking surface rather than something beneath it.
    const top = (GRID.slabs[0]?.pos[1] as number) + (GRID.slabs[0]?.size[1] as number) / 2
    expect(GRID.lightBar?.pos[1] as number).toBeCloseTo(top, 1)
  })

  it('is a 75 m start line, which is why it is worth drawing', () => {
    expect(GRID.lightBar?.size[0] as number).toBeGreaterThan(70)
    expect(GRID.lightBar?.size[1] as number).toBeCloseTo(1, 3)
  })

  it("DEV-549: carries 2016's deck art as placements, and holds back the tile in the shaft", () => {
    // Rule 7 has let the PolyWorld tiles and the MM kitbash ship from R2 since
    // 2026-09-23, so the extractor now places them (`start-deck.glb`'s parts)
    // where until then it counted them. Ten live floor tiles under
    // `starting_platform` and one moulding; the tenth tile stands at the sea,
    // 2.6 m off the seat, inside the lift's shaft, and is recorded, not drawn.
    const parts = GRID.art.map((a) => a.part)
    expect(parts.filter((p) => p.startsWith('floor-'))).toHaveLength(9)
    expect(parts.filter((p) => p === 'moulding')).toHaveLength(1)
    expect(GRID.artInShaft.map((a) => a.node)).toEqual(['Floor_B 2 (1)'])
    // Every drawn tile stands at the deck: its origin within 2 m under the
    // walking surface (the tile is 1.7 m thick, z-up in its file).
    const top = (GRID.slabs[0]?.pos[1] as number) + (GRID.slabs[0]?.size[1] as number) / 2
    for (const a of GRID.art.filter((x) => x.part.startsWith('floor-'))) {
      expect(top - (a.pos[1] as number), a.part).toBeGreaterThan(0)
      expect(top - (a.pos[1] as number), a.part).toBeLessThan(2)
    }
    const spawn = int01.spawn.pos as number[]
    const shaft = GRID.artInShaft[0]?.pos as number[]
    expect(
      Math.hypot(
        (shaft[0] as number) - (spawn[0] as number),
        (shaft[2] as number) - (spawn[2] as number),
      ),
    ).toBeLessThan(4.7)
  })
})

// ── The ghosts were already parked on the pads ────────────────────────────
//
// Matt: *"yes plz park the ghosts on the ai pads."* They were, and nobody had
// noticed, because you could not SEE them — the ghost wore the cockpit's own
// dark `COLOR_0` at 42 % opacity over a dark deck.
//
// The clips are named `int_01_leftSpawn_*` and `int_01_rightSpawn_*`, and their
// first recorded samples land on the two AI pads. That is 2016 telling us where
// it stood the opposition, from a completely different file than the scene the
// pads come out of — so it is worth holding the two together.
describe('the ghosts start on the AI pads', () => {
  const offset = int01.worldOffset as number[]
  /** A clip's first sample, in world space. */
  const firstSample = (clip: { quant: { pos: number }; p: number[] }): number[] => {
    const s = clip.quant.pos
    return [
      (clip.p[0] as number) / s + (offset[0] as number),
      (clip.p[1] as number) / s + (offset[1] as number),
      (clip.p[2] as number) / s + (offset[2] as number),
    ]
  }
  const CLIPS = [
    ['left', leftSpawn as unknown as { quant: { pos: number }; p: number[] }],
    ['right', rightSpawn as unknown as { quant: { pos: number }; p: number[] }],
  ] as const
  const aiPads = GRID.pads.filter((p) => p.role === 'ai')

  it('each clip begins over an AI pad, within 2 m', () => {
    for (const [name, clip] of CLIPS) {
      const p = firstSample(clip)
      const d = Math.min(
        ...aiPads.map((pad) =>
          Math.hypot(
            (pad.pos[0] as number) - (p[0] as number),
            (pad.pos[2] as number) - (p[2] as number),
          ),
        ),
      )
      expect(d, `${name}Spawn is ${d.toFixed(2)} m from the nearest AI pad`).toBeLessThan(2)
    }
  })

  it('takes ONE pad each — left and right, not both on one', () => {
    const nearest = CLIPS.map(([, clip]) => {
      const p = firstSample(clip)
      let best = -1
      let bestD = Infinity
      aiPads.forEach((pad, i) => {
        const d = Math.hypot(
          (pad.pos[0] as number) - (p[0] as number),
          (pad.pos[2] as number) - (p[2] as number),
        )
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      return best
    })
    expect(new Set(nearest).size).toBe(2)
  })

  it('starts them HOVERING, which is what a hoverjet does', () => {
    // ~3 m of daylight under each, and that is the recording rather than a
    // choice: they are parked where 2016 parked them, not snapped to the deck.
    for (const [name, clip] of CLIPS) {
      const p = firstSample(clip)
      const pad = aiPads.reduce((a, b) =>
        Math.hypot(
          (a.pos[0] as number) - (p[0] as number),
          (a.pos[2] as number) - (p[2] as number),
        ) <
        Math.hypot((b.pos[0] as number) - (p[0] as number), (b.pos[2] as number) - (p[2] as number))
          ? a
          : b,
      )
      const dy = (p[1] as number) - (pad.pos[1] as number)
      expect(dy, `${name}Spawn clearance`).toBeGreaterThan(1)
      expect(dy, `${name}Spawn clearance`).toBeLessThan(6)
    }
  })
})
