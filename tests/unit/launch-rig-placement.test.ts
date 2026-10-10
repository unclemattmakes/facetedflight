// tests/unit/launch-rig-placement.test.ts — DEV-101. Where a launch rig stands.
//
// `rookie_02_hoverJet`'s rig hung 107.010 m above the one every other desert
// mission uses, because `content/levels/*.json`'s `spawn.pos` came from
// `Level.SinglePlayerSpawnPosition` and that field is wired to the RESPAWN marker
// in that one scene. 2016 cannot see it — `Level.respawning` is serialised 1 in
// all thirteen scenes, so `Level.cs:287-294` reads the respawn marker and the
// spawn field is dead YAML. The port read it and built the room, the shaft and
// the release one full ride too high.
//
// ── What is asserted, and why none of it is a remembered number ─────────────
//
// Trap 24: a test that re-derives its expectation the way the code does has not
// tested the code. So every assertion here is a RELATIONSHIP between two things
// 2016 authored independently, and not one of them is an altitude:
//
//   1. the marker the pose came from is the elevator's own seat, named;
//   2. 2016's two markers BRACKET the ride — `respawn_position` sits one
//      `elevator_up.anim` rise above the seat, on every rig in the game;
//   3. the port's modelled release lands just under `respawn_position`, which is
//      where 2016 itself puts the ship;
//   4. both markers are on the same shaft in plan;
//   5. against the mission's own measured surface: the seat is UNDER it and the
//      release is OVER it. Two sign tests with no tolerance at all, and together
//      they are `Trigger_EnableTerrain`'s whole purpose — the ride is the thing
//      that takes you through the ground.
//
// Every one of 2, 3 and 5 fails on `rookie_02_hoverJet` before the fix and passes
// on the other six, which is the only way to know an assertion is load-bearing.
// Checked by putting 210.399994 back into the JSON by hand: 2 read 0.000 against
// a 106.647 ride, 3 read -106.647, 5's first test read a seat 13.81 m ABOVE the
// desert.
//
// The surface is a SAMPLE, never a constant: land from the environment's own
// height map, water from its water map where it has one. Two of the seven rigs
// stand on the seabed with ~96 m of ocean over them, so a land-only rule would
// be false on Simonet — the agreement lesson, which is how "the terrain transform
// is the centre" survived for a day on the one island anybody had loaded.
//
// `heightField` is the COLLISION surface, without the generator's 0.8 m jitter
// (CLAUDE.md). That is the same measure DEV-094's census used and the margins
// here are 13 m and up, so the jitter cannot reach any of them.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  fieldFor,
  groundUnder,
  haveMaps,
  loadLevelJson,
  MAPS,
  MISSIONS,
  OCEAN_MAPS,
  oceanFieldFor,
} from './helpers/terrain-field'

/** Every shipped mission that rides a lift, discovered rather than listed. */
const riggedMissions = (): { id: string; level: ReturnType<typeof loadLevelJson> }[] =>
  MISSIONS.map((id) => ({ id, level: loadLevelJson(id) })).filter(
    (m) => m.level.spawn?.launchKind === 'elevator',
  )

describe('DEV-101: the launch rig stands where 2016 put it', () => {
  it('finds seven rigged missions — not six, and not one', () => {
    // A guard on the sweep itself. Every assertion below is inside a loop over
    // this list, so a filter that quietly matched nothing would leave the whole
    // file green. Seven of the thirteen carry a rig; the six JumpSeats spawn on
    // their own sprung legs.
    expect(
      riggedMissions()
        .map((m) => m.id)
        .sort(),
    ).toEqual([
      'adv_01_hoverJet',
      'adv_02_hoverJet',
      'hoverJet_kauai_beg',
      'int_01_hoverJet',
      'int_02_hoverJet',
      'rookie_01_hoverJet',
      'rookie_02_hoverJet',
    ])
  })

  it('takes the pre-launch pose from the elevator seat, not from the Level spawn field', () => {
    for (const { id, level } of riggedMissions()) {
      expect(level.spawn.marker, id).toMatch(/^LaunchElevator\.PlayerShipRoot/)
      // And where 2016's own GameObject reference resolves in the scene, it names
      // that same node. Null on a rig placed as a real prefab instance, where the
      // un-overridden field carries the prefab's internal fileID.
      const trace = level.spawn.seatTrace
      expect(trace, id).toBeTruthy()
      if (trace.seatRefAgrees !== null) expect(trace.seatRefAgrees, id).toBe(true)
    }
  })

  it("brackets the ride: 2016's respawn marker sits one rise above the seat", () => {
    for (const { id, level } of riggedMissions()) {
      const rise = level.spawn.launch.rise as number
      const above = (level.respawn.pos[1] as number) - (level.spawn.pos[1] as number)
      // The marker is hand-placed per scene, so it sits a little clear of the
      // deck rather than on it — measured, the seven run 0.36 to 1.43 m proud of
      // the release. The relationship is "one ride, plus a hair".
      expect(above, `${id}: respawn marker ${above} m above the seat`).toBeGreaterThan(rise)
      expect(above, id).toBeLessThan(rise + 2)
    }
  })

  it('releases the ship just under where 2016 instantiates it', () => {
    for (const { id, level } of riggedMissions()) {
      // `markerUsedAtLoad` is `respawn` on all thirteen, so `respawn.pos` is
      // literally where 2016 puts the ship on load. The port rides up to it.
      expect(level.markerUsedAtLoad, id).toBe('respawn')
      const release = (level.spawn.pos[1] as number) + (level.spawn.launch.rise as number)
      const gap = (level.respawn.pos[1] as number) - release
      expect(
        gap,
        `${id}: release ${release} against 2016's ${level.respawn.pos[1]}`,
      ).toBeGreaterThan(0)
      expect(gap, id).toBeLessThan(2)
    }
  })

  it('puts both markers on the same shaft', () => {
    for (const { id, level } of riggedMissions()) {
      const dx = (level.spawn.pos[0] as number) - (level.respawn.pos[0] as number)
      const dz = (level.spawn.pos[2] as number) - (level.respawn.pos[2] as number)
      // The shaft's bore is ~9 m across and the two markers are inside it.
      expect(
        Math.hypot(dx, dz),
        `${id}: markers ${Math.hypot(dx, dz)} m apart in plan`,
      ).toBeLessThan(5)
    }
  })
})

describe.skipIf(!haveMaps)('DEV-101: the ride is what breaks the surface', () => {
  // The disk work is inside the `it`, never above the guard: a `describe.skipIf`
  // skips the TESTS and not the describe BODY, and a `fieldFor` evaluated during
  // collection throws ENOENT exactly where the gitignored maps are absent, which
  // is CI and only CI (CLAUDE.md).
  it('starts the seat under the surface and finishes the ride above it', () => {
    const rows: string[] = []
    for (const { id, level } of riggedMissions()) {
      const land = groundUnder(fieldFor(level), level.spawn.pos)
      const ocean = oceanFieldFor(level)
      const water = ocean ? groundUnder(ocean, level.spawn.pos) : null
      // The surface the platform breaks: whichever of the two is on top here.
      const surface = water === null ? land : Math.max(land, water)
      const release = (level.spawn.pos[1] as number) + (level.spawn.launch.rise as number)
      rows.push(
        `${id.padEnd(19)} seat ${(level.spawn.pos[1] as number).toFixed(2).padStart(9)}  ` +
          `land ${land.toFixed(2).padStart(9)}  water ${(water ?? Number.NaN).toFixed(2).padStart(8)}  ` +
          `surface ${surface.toFixed(2).padStart(9)}  release ${release.toFixed(2).padStart(9)}`,
      )
      expect(
        surface - (level.spawn.pos[1] as number),
        `${id}: the seat must be BELOW the surface — ${rows[rows.length - 1]}`,
      ).toBeGreaterThan(0)
      expect(
        release - surface,
        `${id}: the release must be ABOVE the surface — ${rows[rows.length - 1]}`,
      ).toBeGreaterThan(0)
    }
    // Seven rows, so a sweep that silently measured one mission cannot pass.
    expect(rows).toHaveLength(7)
  })

  it('stands the two desert missions on one rig', () => {
    // `rookie_02_hoverJet` and `adv_01_hoverJet` are the SAME launch site,
    // authored twice: `levelOffset/[PlayerStart_ElevatorShaft_Photon/]Position_adjustment`
    // composes to (804.4, 101.4, 1221.9) in both scenes. Two independently saved
    // 2016 files agreeing is the outside measurement this port can be wrong
    // against — and it is the pair the bug separated by 107 m.
    const a = loadLevelJson('rookie_02_hoverJet')
    const b = loadLevelJson('adv_01_hoverJet')
    for (let i = 0; i < 3; i++) {
      expect(Math.abs((a.spawn.pos[i] as number) - (b.spawn.pos[i] as number))).toBeLessThan(0.01)
    }
    expect(groundUnder(fieldFor(a), a.spawn.pos)).toBeCloseTo(
      groundUnder(fieldFor(b), b.spawn.pos),
      2,
    )
  })
})

describe.skipIf(haveMaps)('DEV-101: the terrain half of this file', () => {
  it('is skipped because a height map is not on disk', () => {
    // The loud counterpart. A guarded suite with no such test can rot for months
    // while every run stays green (CLAUDE.md).
    //
    // It asserts the REASON, not a particular file: `haveMaps` wants four land
    // maps and the water map, so naming one of them here would be a second
    // statement of the guard that could disagree with the first.
    expect(haveMaps).toBe(false)
    const all = [...Object.values(MAPS), ...Object.values(OCEAN_MAPS)]
    expect(all.filter((p) => !fs.existsSync(p)).length).toBeGreaterThan(0)
  })
})
