// tests/unit/tv-camera.test.ts: DEV-481: Faceted Flight TV's viewer control.
//
// plan/FF-TV.md §9 DEV-481's gates, in node, over 2016's own recorded
// `int_01` flights (`helpers/tv-race.ts`):
//
//   0. AT LAUNCH A HEADSET GETS THE FLAT CAMERA (DEV-481 follow-up, Matt,
//      2026-10-01): over the same recorded race, a presenting camera puts the
//      rig on the flat camera's eye every frame, level, the head untouched;
//      Free flies the head along its gaze and turns smoothly about it, and
//      never goes under the ground.
//   1. WITH THE COMFORT CUTS ON (`headsetCuts`, off at launch), IN A HEADSET
//      THE RIG MOVES ONLY AT A CUT. Every frame the mission's own
//      camera code writes the rig first (as `flight.render` does in the app),
//      the head wanders, and the camera module runs after; the pose it leaves
//      must be bit-identical from one cut to the next, level, and changed only
//      on a frame that made a cut, at solid black. Today's `watchCamera`
//      wrote a chase pose there every frame; this is the test that says so.
//   2. THE DIRECTOR HOLDS a shot at least `directorMinHold` seconds, opens on
//      the start, and reaches the finish.
//   3. FOLLOW cycles every racer and wraps, both ways; `follow(n)` picks Racer
//      n by its number, also before any craft has arrived.
//   4. FREE never goes under the ground: a dive at full speed into the steepest
//      ground near every HoverJet Ring Attack course (gated on the maps), and
//      into a synthetic cliff that runs everywhere.
//   5. The headset's Free: a teleport is a cut through black, a snap turns
//      about the head.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { type Level, validateLevel } from '@/content/level-schema'
import {
  createTvCamera,
  TV_CAMERA_POLICY,
  type TvCameraInput,
  type TvCraft,
  tvHeadWorld,
} from '@/game/tv/tv-camera'
import { eyeInGateFrame, FRAMING } from '@/game/tv/tv-framing'
import {
  buildRoute,
  gateFramesOf,
  routePointAt,
  tvBoundsOf,
  tvCourseOf,
} from '@/game/tv/tv-vantage'
import { FLY_LOOK_POLICY } from '@/render/fly-look'
import { haveForest } from './helpers/prop-forest'
import { INT01, RACE_SECONDS, recordedRace } from './helpers/tv-race'
import { tvWorldFor } from './helpers/tv-world'

const DT = 1 / 90

interface Rig {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
}
const rigAndHead = (): { rig: Rig; camera: Rig } => ({
  rig: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
  camera: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
})

/** Simonet's sea is ~116 m: a flat floor under the course, so this file runs without the maps. */
const FLAT_GROUND = (): number => 100

const cameraOver = (
  craft: () => readonly TvCraft[],
  presenting: () => boolean,
  heightAt: (x: number, z: number) => number = FLAT_GROUND,
  cuts = false,
) =>
  createTvCamera({
    craft,
    presenting,
    heightAt,
    bounds: tvBoundsOf(INT01),
    course: tvCourseOf(INT01),
    headsetCuts: () => cuts,
  })

// ── 0. at launch: a headset gets the flat camera ──────────────────────────

/** A pure-yaw quaternion's yaw (three's: 0 looks down -Z). */
const yawOf = (q: THREE.Quaternion): number => {
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q)
  return Math.atan2(-f.x, -f.z)
}

describe('DEV-481 follow-up: at launch a headset gets the flat camera', () => {
  for (const mode of ['director', 'follow'] as const) {
    it(`${mode}: the presenting rig follows the flat eye path, level, every frame`, () => {
      const race = recordedRace()
      let t = 0
      const flat = cameraOver(
        () => race.at(t),
        () => false,
      )
      const xr = cameraOver(
        () => race.at(t),
        () => true,
      )
      if (mode === 'follow') {
        flat.follow(2)
        xr.follow(2)
      }
      const a = rigAndHead()
      const b = rigAndHead()
      let worst = 0
      let worstYaw = 0
      let moves = 0
      const was = new THREE.Vector3(Number.NaN)
      const wasQ = new THREE.Quaternion(Number.NaN)
      const frames = Math.ceil(RACE_SECONDS / DT)
      for (let f = 0; f < frames; f++) {
        t = f * DT
        // The mission's code scribbles on the headset rig first, and the head wanders.
        b.rig.position.set(-800 + t * 150, 140, 2000 - t * 90)
        b.camera.position.set(Math.sin(t) * 0.3, Math.cos(t * 0.7) * 0.1, Math.sin(t * 1.3) * 0.2)
        b.camera.quaternion.setFromEuler(new THREE.Euler(0.2 * Math.sin(t), t, 0))
        const headBefore = b.camera.quaternion.clone()
        flat.frame(DT, a.rig, a.camera)
        xr.frame(DT, b.rig, b.camera)
        if (a.rig.position.lengthSq() === 0) continue
        worst = Math.max(worst, a.rig.position.distanceTo(b.rig.position))
        const dy = Math.abs(
          THREE.MathUtils.euclideanModulo(
            yawOf(a.rig.quaternion) - yawOf(b.rig.quaternion) + Math.PI,
            2 * Math.PI,
          ) - Math.PI,
        )
        worstYaw = Math.max(worstYaw, dy)
        // Level: a pitched rig tilts the wearer's world (DEV-264).
        expect(Math.abs(b.rig.quaternion.x) + Math.abs(b.rig.quaternion.z)).toBeLessThan(1e-9)
        // The head is the runtime's.
        expect(b.camera.quaternion.equals(headBefore)).toBe(true)
        // A move is the rig placed anew: its position, or (a fixed framing's
        // camera, DEV-618, stands and pans) its facing.
        if (!b.rig.position.equals(was) || !b.rig.quaternion.equals(wasQ)) moves++
        was.copy(b.rig.position)
        wasQ.copy(b.rig.quaternion)
      }
      const r = xr.report()
      console.info(
        `DEV-481 follow-up ${mode}: ${frames} frames, ${moves} rig moves, worst eye gap ${worst.toExponential(2)} m, worst yaw gap ${worstYaw.toExponential(2)} rad, cuts ${r.cuts}`,
      )
      expect(r.mode).toBe(flat.report().mode)
      expect(r.following).toBe(flat.report().following)
      expect(r.headsetCuts).toBe(false)
      expect(worst).toBeLessThan(1e-9)
      expect(worstYaw).toBeLessThan(1e-9)
      // It is the flat camera: it moves continuously, and no cut is ever made.
      expect(moves).toBeGreaterThan(frames * 0.9)
      expect(r.cuts).toBe(0)
    })
  }

  it('Free flies the head along its gaze, turns smoothly about it, and never goes under the ground', () => {
    const cliff = (x: number, z: number): number => 100 + ((((x + z) % 40) + 40) % 40) * 1.5
    const cam = cameraOver(
      () => [],
      () => true,
      cliff,
    )
    const { rig, camera } = rigAndHead()
    rig.position.set(-800, 400, 2000)
    camera.position.set(0.3, 0.1, -0.2)
    cam.setMode('free')
    const headAt = (): THREE.Vector3 =>
      camera.position.clone().applyQuaternion(rig.quaternion).add(rig.position)
    // Forward along a level gaze down -Z: the head goes -Z, and nowhere else.
    const level: [number, number, number, number] = [0, 0, 0, 1]
    cam.frame(DT, rig, camera, { gaze: level })
    const h0 = headAt()
    for (let f = 0; f < 45; f++) cam.frame(DT, rig, camera, { xrMoveY: -1, gaze: level })
    const h1 = headAt()
    expect(h1.z).toBeLessThan(h0.z - 1)
    expect(Math.abs(h1.x - h0.x)).toBeLessThan(1e-6)
    expect(Math.abs(h1.y - h0.y)).toBeLessThan(1e-6)
    // A smooth turn: a little each frame, about the head (the head does not move).
    const yaws: number[] = []
    for (let f = 0; f < 30; f++) {
      cam.frame(DT, rig, camera, { xrTurn: 1, gaze: level })
      yaws.push(yawOf(rig.quaternion))
      expect(headAt().distanceTo(h1)).toBeLessThan(1e-6)
    }
    const step = (yaws[1] as number) - (yaws[0] as number)
    expect(step).toBeLessThan(0)
    expect(Math.abs(step)).toBeCloseTo(TV_CAMERA_POLICY.headsetTurnPerSecond * DT, 9)
    // Dive at the cliff, gaze pitched down, sinking: never under it.
    const down = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.8, 0.3, 0, 'YXZ'))
    const gaze: [number, number, number, number] = [down.x, down.y, down.z, down.w]
    for (let f = 0; f < 900; f++) {
      cam.frame(DT, rig, camera, { xrMoveY: -1, xrMoveX: 0.4, xrRise: -1, gaze })
      const h = headAt()
      expect(h.y, `frame ${f}`).toBeGreaterThanOrEqual(cliff(h.x, h.z) + 0.5)
      expect(Math.abs(rig.quaternion.x) + Math.abs(rig.quaternion.z)).toBeLessThan(1e-9)
    }
  })
})

// ── 1. with the comfort cuts on ────────────────────────────────────────────

describe('DEV-481: with the comfort cuts on (gameplay.tv.headsetCuts), the rig moves only at a cut', () => {
  for (const mode of ['director', 'follow'] as const) {
    it(`${mode}: over a recorded race, one pose per cut, level, placed at solid black`, () => {
      const race = recordedRace()
      let t = 0
      const cam = cameraOver(
        () => race.at(t),
        () => true,
        FLAT_GROUND,
        true,
      )
      if (mode === 'follow') cam.follow(2)
      const { rig, camera } = rigAndHead()
      const last = { p: new THREE.Vector3(Number.NaN), q: new THREE.Quaternion(Number.NaN) }
      let changes = 0
      let lastCuts = 0
      const bad: string[] = []
      const frames = Math.ceil(RACE_SECONDS / DT)
      for (let f = 0; f < frames; f++) {
        t = f * DT
        // The mission's own camera code runs first in the app (`flight.render`
        // writes the hidden ship's cockpit pose onto the rig every frame).
        rig.position.set(-800 + t * 150, 140, 2000 - t * 90)
        rig.quaternion.setFromEuler(new THREE.Euler(0.1, t, 0.2))
        // The wearer's head wanders inside the rig.
        camera.position.set(Math.sin(t) * 0.3, Math.cos(t * 0.7) * 0.1, Math.sin(t * 1.3) * 0.2)
        cam.frame(DT, rig, camera)
        const r = cam.report()
        const moved = !rig.position.equals(last.p) || !rig.quaternion.equals(last.q)
        if (moved) {
          changes++
          if (r.cuts === lastCuts) bad.push(`frame ${f}: the rig moved without a cut`)
          if (f > 0 && r.black < 0.999) bad.push(`frame ${f}: the rig moved at black ${r.black}`)
        }
        // Level: a pure yaw (DEV-264: a pitched rig tilts the wearer's world).
        if (Math.abs(rig.quaternion.x) > 1e-12 || Math.abs(rig.quaternion.z) > 1e-12)
          bad.push(`frame ${f}: the rig is not level`)
        last.p.copy(rig.position)
        last.q.copy(rig.quaternion)
        lastCuts = r.cuts
      }
      const r = cam.report()
      console.info(
        `DEV-481 headset ${mode}: ${frames} frames, ${changes} rig placements, ${r.cuts} cuts, ` +
          `${r.vantages} vantages over ${RACE_SECONDS.toFixed(1)} s`,
      )
      expect(bad.slice(0, 10)).toEqual([])
      // It did cut (the race is shown, not one fixed eye) and it never cut faster than its hold.
      expect(changes).toBeGreaterThanOrEqual(4)
      expect(changes).toBe(r.cuts)
      expect(changes).toBeLessThanOrEqual(
        Math.ceil(RACE_SECONDS / TV_CAMERA_POLICY.headsetMinHold) + 1,
      )
    })
  }

  it('never touches the camera’s local pose in a session (the runtime owns it)', () => {
    const race = recordedRace()
    const cam = cameraOver(
      () => race.at(10),
      () => true,
      FLAT_GROUND,
      true,
    )
    const { rig, camera } = rigAndHead()
    camera.position.set(0.1, 0.2, 0.3)
    camera.quaternion.setFromEuler(new THREE.Euler(0.3, 0.2, 0.1))
    const p = camera.position.clone()
    const q = camera.quaternion.clone()
    for (let f = 0; f < 200; f++) cam.frame(DT, rig, camera)
    expect(camera.position.equals(p)).toBe(true)
    expect(camera.quaternion.equals(q)).toBe(true)
  })
})

// ── 2. the Director ────────────────────────────────────────────────────────

describe('DEV-481: the Director', () => {
  it('opens on the start, holds every shot its minimum, and reaches the finish', () => {
    const race = recordedRace()
    let t = 0
    const cam = cameraOver(
      () => race.at(t),
      () => false,
    )
    const { rig, camera } = rigAndHead()
    const shots: { at: number; shot: string; following: string; winner: boolean }[] = []
    for (let f = 0; f < Math.ceil(RACE_SECONDS / DT); f++) {
      t = f * DT
      cam.frame(DT, rig, camera)
      const r = cam.report()
      const key = `${r.shot}|${r.following}`
      const prev = shots[shots.length - 1]
      if (!prev || `${prev.shot}|${prev.following}` !== key)
        shots.push({
          at: t,
          shot: r.shot ?? '-',
          following: r.following ?? '-',
          winner: r.winnerShot,
        })
    }
    console.info(
      `DEV-481 director: ${shots.map((s) => `${s.at.toFixed(1)}s ${s.shot} ${s.following}`).join(' · ')}`,
    )
    expect(shots[0]?.shot).toBe('start')
    for (let i = 1; i < shots.length; i++) {
      // DEV-654: the winner's shot cuts at once, past every hold: that cut is the one exception.
      if ((shots[i] as (typeof shots)[number]).winner) continue
      const held =
        (shots[i] as (typeof shots)[number]).at - (shots[i - 1] as (typeof shots)[number]).at
      expect(held, `shot ${i} after ${held.toFixed(2)} s`).toBeGreaterThanOrEqual(
        // DEV-652: an overtake cuts after `overtakeMinHold`, not the full hold.
        TV_CAMERA_POLICY.overtakeMinHold - DT,
      )
    }
    const kinds = new Set(shots.map((s) => s.shot))
    expect(kinds.has('finish')).toBe(true)
    expect(kinds.has('leader') || kinds.has('battle')).toBe(true)
  })

  it('flat: chases its subject from behind and above, never under the ground', () => {
    const race = recordedRace()
    let t = 0
    const cam = cameraOver(
      () => race.at(t),
      () => false,
    )
    const { rig, camera } = rigAndHead()
    for (let f = 0; f < 30 * 90; f++) {
      t = f * DT
      cam.frame(DT, rig, camera)
      expect(rig.position.y).toBeGreaterThanOrEqual(
        FLAT_GROUND() + TV_CAMERA_POLICY.flatClearance - 1e-9,
      )
      expect(camera.position.lengthSq()).toBe(0)
    }
  })
})

// ── 3. Follow ──────────────────────────────────────────────────────────────

describe('DEV-481: Follow cycles every racer and wraps', () => {
  const field = (): TvCraft[] => recordedRace().at(20) as TvCraft[]

  it('next() visits all five once and comes back; previous() the same the other way', () => {
    const craft = field()
    const cam = cameraOver(
      () => craft,
      () => false,
    )
    const { rig, camera } = rigAndHead()
    cam.follow(1)
    cam.frame(DT, rig, camera)
    const visit = (step: () => void): string[] => {
      const names: string[] = []
      for (let i = 0; i < craft.length; i++) {
        step()
        cam.frame(DT, rig, camera)
        names.push(cam.report().following as string)
      }
      return names
    }
    const forward = visit(() => cam.next())
    expect(forward).toEqual(['Racer 2', 'Racer 3', 'Racer 4', 'Racer 5', 'Racer 1'])
    const back = visit(() => cam.previous())
    expect(back).toEqual(['Racer 5', 'Racer 4', 'Racer 3', 'Racer 2', 'Racer 1'])
    expect(cam.mode()).toBe('follow')
  })

  it('follow(n) picks Racer n by its number, whatever order the list arrives in', () => {
    const craft = field().reverse()
    const cam = cameraOver(
      () => craft,
      () => false,
    )
    const { rig, camera } = rigAndHead()
    cam.follow(3)
    cam.frame(DT, rig, camera)
    expect(cam.report().following).toBe('Racer 3')
  })

  it('follow(n) from a link waits for the racer to arrive', () => {
    let craft: TvCraft[] = []
    const cam = cameraOver(
      () => craft,
      () => false,
    )
    const { rig, camera } = rigAndHead()
    cam.follow(4)
    for (let f = 0; f < 10; f++) cam.frame(DT, rig, camera)
    expect(cam.report().following).toBeNull()
    craft = field()
    cam.frame(DT, rig, camera)
    expect(cam.report().following).toBe('Racer 4')
  })

  it('a press from the Director follows the racer after its subject', () => {
    const craft = field()
    const cam = cameraOver(
      () => craft,
      () => false,
    )
    const { rig, camera } = rigAndHead()
    cam.frame(DT, rig, camera)
    const subject = cam.report().following as string
    cam.next()
    cam.frame(DT, rig, camera)
    const n = Number(subject.split(' ')[1])
    expect(cam.report().following).toBe(`Racer ${(n % 5) + 1}`)
    expect(cam.mode()).toBe('follow')
  })

  it('cycles Director → Follow → Free → Director', () => {
    const cam = cameraOver(
      () => [],
      () => false,
    )
    expect(cam.mode()).toBe('director')
    expect([cam.cycleMode(), cam.cycleMode(), cam.cycleMode()]).toEqual([
      'follow',
      'free',
      'director',
    ])
  })
})

// ── 4. Free never goes under the ground ────────────────────────────────────

/** Dive: full speed, forward and down, nose pitched down, from `from`. Returns the frames that broke the floor. */
const dive = (
  heightAts: readonly ((x: number, z: number) => number)[],
  cam: ReturnType<typeof createTvCamera>,
  from: THREE.Vector3,
  yaw: number,
  frames: number,
): string[] => {
  const { rig, camera } = rigAndHead()
  rig.position.copy(from)
  rig.quaternion.setFromEuler(new THREE.Euler(-0.6, yaw, 0, 'YXZ'))
  cam.setMode('free')
  const input: TvCameraInput = {
    keys: { forward: true, down: true },
    // Wheel away: faster, every frame, to the top of the scale.
    wheel: -1,
    lookDy: 4,
  }
  const bad: string[] = []
  for (let f = 0; f < frames; f++) {
    cam.frame(DT, rig, camera, input)
    for (const h of heightAts) {
      const g = h(rig.position.x, rig.position.z)
      if (Number.isFinite(g) && rig.position.y < g + 0.5)
        bad.push(
          `(${rig.position.x.toFixed(0)}, ${rig.position.z.toFixed(0)}) ${(rig.position.y - g).toFixed(2)} m`,
        )
    }
  }
  return bad
}

describe('DEV-481: Free never goes under the ground', () => {
  it('a full-speed dive into a cliff that runs everywhere', () => {
    // A sawtooth of 60 m walls every 40 m: as steep as ground gets.
    const cliff = (x: number, z: number): number => 100 + ((((x + z) % 40) + 40) % 40) * 1.5
    const cam = cameraOver(
      () => [],
      () => false,
      cliff,
    )
    const from = new THREE.Vector3(-800, 400, 2000)
    for (const yaw of [0, 1, 2, 3, 4, 5]) {
      expect(dive([cliff], cam, from, yaw, 900)).toEqual([])
    }
  })

  it.skipIf(!haveForest)(
    'a full-speed dive into the steepest ground beside every HoverJet Ring Attack course',
    () => {
      const dir = path.join(__dirname, '..', '..', 'content', 'levels')
      const courses = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .map((f) => validateLevel(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Level))
        .filter((l) => l.vehicle === 'hoverjet' && l.mode === 'ringAttack')
      expect(courses).toHaveLength(6)
      const rows: string[] = []
      for (const level of courses) {
        const world = tvWorldFor(level)
        const route = buildRoute(tvCourseOf(level).route)
        // The steepest ground within 150 m of the line: the rendered rise across 8 m, sampled.
        const spots: { at: THREE.Vector3; slope: number }[] = []
        for (let s = 0; s < route.length; s += 60) {
          const p = routePointAt(route, s)
          for (const [ox, oz] of [
            [120, 0],
            [-120, 0],
            [0, 120],
            [0, -120],
            [60, 60],
            [-60, -60],
          ] as const) {
            const x = p[0] + ox
            const z = p[2] + oz
            const h = world.renderAt(x, z)
            if (!Number.isFinite(h)) continue
            const slope = Math.max(
              Math.abs(world.renderAt(x + 8, z) - h),
              Math.abs(world.renderAt(x, z + 8) - h),
            )
            spots.push({ at: new THREE.Vector3(x, h + 60, z), slope })
          }
        }
        spots.sort((a, b) => b.slope - a.slope)
        const steep = spots.slice(0, 12)
        const cam = createTvCamera({
          craft: () => [],
          presenting: () => false,
          heightAt: world.heightAt,
          bounds: tvBoundsOf(level),
          course: tvCourseOf(level),
          obstructed: world.obstructed,
        })
        const bad: string[] = []
        steep.forEach((s, i) => {
          bad.push(...dive([world.renderAt, world.collisionAt], cam, s.at, i, 360))
        })
        rows.push(
          `${level.id.padEnd(20)} steepest rise ${steep[0]?.slope.toFixed(1)} m in 8 m · ${steep.length} dives · ${bad.length} frames under`,
        )
        expect(bad.slice(0, 5), level.id).toEqual([])
      }
      console.info(`DEV-481 free-camera dives:\n${rows.join('\n')}`)
    },
    300_000,
  )
})

// ── 5. the headset's Free ──────────────────────────────────────────────────

describe('DEV-481: with the comfort cuts on, teleport and snap turn', () => {
  it('a teleport is a cut through black; a snap turns about the head', () => {
    const race = recordedRace()
    const cam = cameraOver(
      () => race.at(5),
      () => true,
      FLAT_GROUND,
      true,
    )
    const { rig, camera } = rigAndHead()
    camera.position.set(0.4, 0.1, -0.2)
    for (let f = 0; f < 60; f++) cam.frame(DT, rig, camera)
    cam.setMode('free')
    const before = rig.position.clone()
    // Aim down at the ground 100 m ahead of the eye.
    const eye = tvHeadWorld(
      { position: [rig.position.x, rig.position.y, rig.position.z], yaw: 0 },
      [0, 0, 0],
    )
    const aim = {
      origin: [rig.position.x, rig.position.y, rig.position.z] as const,
      direction: [0, -1, -1] as const,
    }
    cam.frame(DT, rig, camera, { aim, teleport: true })
    const cuts = cam.report().cuts
    let movedAt = -1
    for (let f = 0; f < 40; f++) {
      cam.frame(DT, rig, camera)
      if (movedAt < 0 && !rig.position.equals(before)) {
        movedAt = f
        expect(cam.report().black).toBeGreaterThanOrEqual(0.999)
      }
    }
    expect(movedAt).toBeGreaterThan(0)
    expect(cam.report().cuts).toBe(cuts + 1)
    expect(cam.report().black).toBe(0)
    // The head landed 1.8 m over the flat ground, where the aim met it.
    const head = new THREE.Vector3()
      .copy(camera.position)
      .applyQuaternion(rig.quaternion)
      .add(rig.position)
    expect(head.y).toBeCloseTo(FLAT_GROUND() + 1.8, 6)
    expect(eye[1]).toBeGreaterThan(head.y)
    // A snap: the head does not move, the yaw turns 30°.
    const q0 = rig.quaternion.clone()
    cam.frame(DT, rig, camera, { snap: 1 })
    const head2 = new THREE.Vector3()
      .copy(camera.position)
      .applyQuaternion(rig.quaternion)
      .add(rig.position)
    expect(head2.distanceTo(head)).toBeLessThan(1e-9)
    expect(THREE.MathUtils.radToDeg(q0.angleTo(rig.quaternion))).toBeCloseTo(30, 6)
  })
})

// ── DEV-618: the Director films its shots more ways than the chase ────────

describe('DEV-618: the Director’s framings over a whole recorded race', () => {
  it('uses every framing, holds each, keeps its eyes in the air and its racer in frame, never crosses the line', () => {
    const race = recordedRace()
    let t = 0
    const cam = cameraOver(
      () => race.at(t),
      () => false,
    )
    const { rig, camera } = rigAndHead()
    const seen = new Map<string, number>()
    let last: string | null = null
    let since = 0
    let lastShot: string | null = null
    let lastFollowing: string | null = null
    const shortHolds: string[] = []
    let worstOffAxis = 0
    let worstAt = ''
    let lowest = Number.POSITIVE_INFINITY
    let overtakesThen = 0
    let inGate = 0
    let smallRun = 0
    let longestSmall = 0
    const gates = gateFramesOf(INT01)
    const sides = new Set<number>()
    const fwd = new THREE.Vector3()
    const to = new THREE.Vector3()
    const frames = Math.ceil(RACE_SECONDS / DT)
    for (let f = 0; f < frames; f++) {
      t = f * DT
      cam.frame(DT, rig, camera)
      const r = cam.report()
      if (r.framing === null || r.following === null) continue
      seen.set(r.framing, (seen.get(r.framing) ?? 0) + 1)
      if (r.framing !== last) {
        // A re-frame on the same subject and shot waits out the least hold:
        // the full one, or (DEV-652) a gate pass's, or an overtake's, which cut
        // sooner on purpose. The opening is held until the field is past.
        const floor =
          r.overtakes !== overtakesThen
            ? TV_CAMERA_POLICY.overtakeMinHold
            : TV_CAMERA_POLICY.gateCutMinHold
        if (
          last !== null &&
          last !== 'opening' &&
          r.shot === lastShot &&
          r.following === lastFollowing &&
          t - since < floor - 1e-9
        )
          shortHolds.push(`${last} -> ${r.framing} after ${(t - since).toFixed(2)} s`)
        last = r.framing
        since = t
        overtakesThen = r.overtakes
      }
      // DEV-652: the eye the Director leaves is in no gate's frame, whatever it proposed.
      const eyeAt: [number, number, number] = [rig.position.x, rig.position.y, rig.position.z]
      if (eyeInGateFrame(gates, eyeAt) >= 0) inGate++
      if (r.framing !== 'opening' && r.subjectShare < FRAMING.minSubject * 0.6) smallRun += DT
      else smallRun = 0
      longestSmall = Math.max(longestSmall, smallRun)
      lastShot = r.shot
      lastFollowing = r.following
      lowest = Math.min(lowest, rig.position.y - FLAT_GROUND())
      // The racer it is on is in the picture: within 30 degrees of the lens's axis
      // (the pair frames the midpoint, so its racer is allowed the frame's half-width).
      const subject = race.at(t).find((c) => c.name === r.following) as TvCraft
      fwd.set(0, 0, -1).applyQuaternion(rig.quaternion)
      to.set(subject.position.x, subject.position.y, subject.position.z)
        .sub(rig.position)
        .normalize()
      const off = THREE.MathUtils.radToDeg(fwd.angleTo(to))
      // The pair frames the midpoint; the opening pans round as the field goes by it.
      if (r.framing !== 'pair' && r.framing !== 'opening' && off > worstOffAxis) {
        worstOffAxis = off
        worstAt = `${r.framing} at ${t.toFixed(2)} s`
      }
      if (r.framing === 'side') {
        // Which side of the racer the eye is on, against its heading.
        const q = subject.quaternion
        const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(
          new THREE.Quaternion(q.x, q.y, q.z, q.w),
        )
        const rel = new THREE.Vector3().subVectors(
          rig.position,
          to.set(subject.position.x, subject.position.y, subject.position.z),
        )
        sides.add(Math.sign(nose.x * rel.z - nose.z * rel.x))
      }
    }
    console.info(
      `DEV-618 framings over ${frames} frames: ${JSON.stringify(Object.fromEntries(seen))}, ` +
        `${cam.report().framingCuts} framing cuts, worst off-axis ${worstOffAxis.toFixed(1)} deg, lowest eye ${lowest.toFixed(1)} m over the ground`,
    )
    for (const f of [
      'wide',
      'chase',
      'side',
      'trackside',
      'aerial',
      'flyby',
      // DEV-652: and the three new ones.
      'lead',
      'shoulder',
      'opening',
    ] as const)
      expect(seen.get(f) ?? 0, `the Director used ${f}`).toBeGreaterThan(0)
    expect(shortHolds).toEqual([])
    // DEV-652: never in a gate's frame, and the racer is never a dot for long:
    // a shot whose racer is under 0.6 of the floor is cut inside
    // `smallSubjectSeconds` (plus the hold's own floor, which a cut waits for).
    expect(inGate, 'frames with the eye in a gate frame').toBe(0)
    expect(longestSmall).toBeLessThanOrEqual(
      TV_CAMERA_POLICY.smallSubjectSeconds + TV_CAMERA_POLICY.overtakeMinHold + 0.1,
    )
    expect(lowest).toBeGreaterThanOrEqual(TV_CAMERA_POLICY.flatClearance - 1e-9)
    expect(worstOffAxis, worstAt).toBeLessThan(30)
    // Every side shot on one side of the line.
    expect(sides.size).toBeLessThanOrEqual(1)
  })
})

// ── DEV-616: a click-drag orbits the chase, and lets go of it ─────────────

describe('DEV-616: on a flat screen a drag orbits the chase about its racer', () => {
  /** The followed craft's position this frame, by name. */
  const craftNamed = (list: readonly TvCraft[], name: string | null): THREE.Vector3 => {
    const c = list.find((x) => x.name === name) as TvCraft
    return new THREE.Vector3(c.position.x, c.position.y, c.position.z)
  }
  const reach = Math.hypot(TV_CAMERA_POLICY.chaseBehind, TV_CAMERA_POLICY.chaseAbove)

  it('swings the eye about the racer in Follow, stays in Follow, and eases back to the chase exactly', () => {
    const race = recordedRace()
    let t = 0
    const still = cameraOver(
      () => race.at(t),
      () => false,
    )
    const dragged = cameraOver(
      () => race.at(t),
      () => false,
    )
    still.follow(2)
    dragged.follow(2)
    const a = rigAndHead()
    const b = rigAndHead()
    let f = 0
    const step = (input?: TvCameraInput): void => {
      t = 20 + f * DT
      f++
      still.frame(DT, a.rig, a.camera)
      dragged.frame(DT, b.rig, b.camera, input)
    }
    for (let i = 0; i < 90; i++) step()
    expect(b.rig.position.distanceTo(a.rig.position)).toBe(0)
    // A quarter-second drag, 300 px right and 60 px down, in pieces, as a mouse sends it.
    for (let i = 0; i < 22; i++) step({ lookDx: 300 / 22, lookDy: 60 / 22 })
    const r = dragged.report()
    expect(r.mode).toBe('follow')
    expect(r.orbit).not.toBeNull()
    const swung = r.orbit?.[0] as number
    // The mouse-look's own rate per pixel.
    expect(swung).toBeCloseTo(
      -300 * THREE.MathUtils.degToRad(FLY_LOOK_POLICY.flyLookDegreesPerPixel),
      9,
    )
    // The eye is still the chase's reach from the racer, and somewhere else.
    const subject = craftNamed(race.at(t), r.following)
    expect(b.rig.position.distanceTo(subject)).toBeCloseTo(reach, 6)
    expect(b.rig.position.distanceTo(a.rig.position)).toBeGreaterThan(10)
    // Held while inside the hold...
    for (let i = 0; i < Math.floor((TV_CAMERA_POLICY.orbitHoldSeconds - 0.1) / DT); i++) step()
    expect(dragged.report().orbit?.[0]).toBe(swung)
    // ...then back, onto the chase itself, bit for bit.
    for (let i = 0; i < 6 / DT; i++) step()
    expect(dragged.report().orbit).toBeNull()
    expect(b.rig.position.distanceTo(a.rig.position)).toBe(0)
    expect(b.rig.quaternion.equals(a.rig.quaternion)).toBe(true)
  })

  it('zooms the orbit on the wheel, within its range', () => {
    const race = recordedRace()
    const t = 20
    const cam = cameraOver(
      () => race.at(t),
      () => false,
    )
    cam.follow(1)
    const { rig, camera } = rigAndHead()
    for (let i = 0; i < 30; i++) cam.frame(DT, rig, camera)
    for (let i = 0; i < 40; i++) cam.frame(DT, rig, camera, { wheel: 500 })
    const r = cam.report()
    expect(r.mode).toBe('follow')
    expect(r.orbit?.[2]).toBe(TV_CAMERA_POLICY.orbitZoomMax)
    expect(rig.position.distanceTo(craftNamed(race.at(t), r.following))).toBeCloseTo(
      reach * TV_CAMERA_POLICY.orbitZoomMax,
      6,
    )
  })

  it('a drag in the Director orbits too; the keys still fly Free; a headset ignores the drag', () => {
    const race = recordedRace()
    const t = 20
    const flat = cameraOver(
      () => race.at(t),
      () => false,
    )
    const { rig, camera } = rigAndHead()
    for (let i = 0; i < 30; i++) flat.frame(DT, rig, camera)
    flat.frame(DT, rig, camera, { lookDx: 40 })
    expect(flat.report().mode).toBe('director')
    expect(flat.report().orbit).not.toBeNull()
    flat.frame(DT, rig, camera, { keys: { forward: true } })
    expect(flat.report().mode).toBe('free')
    const xr = cameraOver(
      () => race.at(t),
      () => true,
    )
    const h = rigAndHead()
    for (let i = 0; i < 30; i++) xr.frame(DT, h.rig, h.camera, { lookDx: 40 })
    expect(xr.report().orbit).toBeNull()
    expect(xr.report().mode).toBe('director')
  })
})

// ── DEV-628: what moving the camera does, with the mission's camera in front ──
//
// Matt, playing 0.20.0: "moving the camera takes me to a first person cam at
// launch position as opposed to orbiting the target". In the app the mission's
// own camera code writes the rig BEFORE TV's camera runs, every frame: the
// hidden craft's cockpit, standing on the launch pad. Free seeded itself from
// that rig, so entering Free (C, the plate's Camera row, W/A/S/D, a pad's
// sticks) put the eye in the cockpit on the pad. The DEV-616 tests above never
// write the rig between frames, which is why they could not see it. Every test
// here does, as `flight.render` does.

describe('DEV-628: the mission camera writes the rig first, and TV continues from its own view', () => {
  const LAUNCH = new THREE.Vector3(5000, 300, -5000)
  const COCKPIT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.1)
  const cockpit = (rig: Rig): void => {
    rig.position.copy(LAUNCH)
    rig.quaternion.copy(COCKPIT)
  }
  const reach = Math.hypot(TV_CAMERA_POLICY.chaseBehind, TV_CAMERA_POLICY.chaseAbove)
  const craftNamed = (list: readonly TvCraft[], name: string | null): THREE.Vector3 => {
    const c = list.find((x) => x.name === name) as TvCraft
    return new THREE.Vector3(c.position.x, c.position.y, c.position.z)
  }
  /** Degrees between where the rig looks and the direction to `p`. */
  const offAxis = (rig: Rig, p: THREE.Vector3): number => {
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.quaternion)
    return THREE.MathUtils.radToDeg(look.angleTo(p.clone().sub(rig.position)))
  }

  const following = (presenting = false) => {
    const race = recordedRace()
    const clock = { t: 20 }
    const cam = cameraOver(
      () => race.at(clock.t),
      () => presenting,
    )
    cam.follow(2)
    const h = rigAndHead()
    const step = (input?: TvCameraInput): void => {
      clock.t += DT
      cockpit(h.rig)
      cam.frame(DT, h.rig, h.camera, input)
    }
    for (let i = 0; i < 90; i++) step()
    return { race, clock, cam, h, step }
  }

  it('a drag orbits the followed racer: the eye stays the orbit radius from it, and it stays in frame', () => {
    const { race, clock, cam, h, step } = following()
    for (let i = 0; i < 22; i++) {
      step({ lookDx: 400 / 22, lookDy: -30 / 22 })
      const r = cam.report()
      expect(r.mode).toBe('follow')
      const racer = craftNamed(race.at(clock.t), r.following)
      expect(h.rig.position.distanceTo(racer)).toBeCloseTo(reach, 6)
      expect(offAxis(h.rig, racer)).toBeLessThan(30)
      expect(h.rig.position.distanceTo(LAUNCH)).toBeGreaterThan(1000)
    }
    expect(cam.report().orbit).not.toBeNull()
  })

  it('a pad’s right stick orbits too, and stays in Follow (it used to throw the view into Free)', () => {
    const { race, clock, cam, h, step } = following()
    for (let i = 0; i < 30; i++) step({ padLookX: 0.8 })
    const r = cam.report()
    expect(r.mode).toBe('follow')
    expect(r.orbit).not.toBeNull()
    const racer = craftNamed(race.at(clock.t), r.following)
    expect(h.rig.position.distanceTo(racer)).toBeCloseTo(reach, 6)
    expect(offAxis(h.rig, racer)).toBeLessThan(30)
  })

  for (const how of ['C', 'W'] as const) {
    it(`Free entered with ${how} starts at the chase eye, looking the same way, not in the cockpit`, () => {
      const { cam, h, step } = following()
      const eye = h.rig.position.clone()
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(h.rig.quaternion)
      if (how === 'C') {
        cam.cycleMode()
        expect(cam.mode()).toBe('free')
        step()
      } else {
        step({ keys: { forward: true } })
        expect(cam.mode()).toBe('free')
      }
      // One frame of Free flight at most: metres, not the kilometres to the pad.
      expect(h.rig.position.distanceTo(eye)).toBeLessThan(5)
      expect(h.rig.position.distanceTo(LAUNCH)).toBeGreaterThan(1000)
      const now = new THREE.Vector3(0, 0, -1).applyQuaternion(h.rig.quaternion)
      expect(THREE.MathUtils.radToDeg(now.angleTo(look))).toBeLessThan(1)
      // And it holds there while nothing moves it, frame after frame.
      for (let i = 0; i < 60; i++) step()
      expect(h.rig.position.distanceTo(eye)).toBeLessThan(5)
    })
  }

  it('a headset’s Free (no cuts) stays at the chase eye while the mission camera writes the cockpit', () => {
    const { cam, h, step } = following(true)
    const eye = h.rig.position.clone()
    cam.cycleMode()
    expect(cam.mode()).toBe('free')
    for (let i = 0; i < 60; i++) step()
    expect(h.rig.position.distanceTo(eye)).toBeLessThan(1e-6)
  })
})
