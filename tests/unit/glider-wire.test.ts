// tests/unit/glider-wire.test.ts — the glider, wired as a third aircraft.
// DEV-399 (docs/plan/AIRCRAFT-VARIANTS.md §5, G1).
//
// DEV-145 built the glider as a model, a pilot and a course, and left it
// unwired: the course said `vehicle: hoverjet` and carried its tuning as a
// `flightModel` that nothing that FLEW ever read, so `?mission=anniv_01_glider`
// flew a HoverJet. This file holds the three things G1 changes, each proved red
// against the code before it:
//
//  1. THE SEAM PICKS THE GLIDER. The course names the glider, `loadFlight`'s
//     branch sends that to the glider's seam, and the seam's airframe flies as
//     a glider — gravity on, no hover motor, ground effect fed from the belly
//     clearance, the rocket on the boost trigger, launched at trim — and flies
//     its own course end to end through the game's own seam and pilot.
//  2. CLASSIC HIDES IT. `gameplay.glider` is the fleet: on Anniversary the
//     course joins the level list and the hangar gets a third aircraft on a
//     one-variant page; on Classic neither exists.
//  3. THE HUD ROW READS GLIDER STATE. The rocket's tank and the stall margin
//     come off the glider the physics stepped, live, and the dash draws them.
//
// Relationships over values where one is available (trap 24): the margin is
// held against the airspeed the physics used, not against a second formula.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AIRCRAFT_TUNING_KEYS,
  type Aircraft,
  editionFlies,
  FLEET_2016,
  fleetOf,
  GLIDER_TUNING_KEYS,
  validateAircraft,
} from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import { type Level, LevelSchemaError, liveRings, validateLevel } from '@/content/level-schema'
import { aircraftFor, gliderTuning } from '@/content/load-aircraft'
import { levelIds, loadLevel } from '@/content/load-level'
import { type Flight, flightSeamFor } from '@/game/flight'
import {
  gliderAirframe,
  gliderAutopilot,
  gliderAutopilotOf,
  gliderFor,
  gliderReadout,
  unbankableChain,
  withGliderSeam,
} from '@/game/glider-flight'
import { startMission } from '@/game/mission'
import { loadMissionIndex, vehicleCards } from '@/game/mission-index'
import { racesIn } from '@/game/racers'
import { variantStep } from '@/game/variant-stats'
import type { FlightActions } from '@/input/actions'
import {
  SEAT_REST_BEARING,
  slotOrdersFor,
  stepsFor,
  TABLE_BEARING_STEP,
  tableBearings,
} from '@/render/hangar'
import { dashContent, type HudState, hudSignature } from '@/render/hud'
import { dashCanvasOps, drawDash } from '@/render/hud-dash'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { FIXED_DT } from '@/sim/constants'
import { createCourse, type Gate, stepCourse } from '@/sim/course'
import {
  type Glider,
  PROTOTYPE_GLIDER,
  stallMarginAt,
  stepGlider,
  terminalDiveSpeed,
  trimSpeed,
} from '@/sim/glider'
import { length } from '@/sim/math/vec3'
import { chainGate } from '@/sim/speed-chain'
import { terrainHeightAt } from '@/sim/terrain/height-field'
import { fieldFor, haveMaps, oceanFieldFor } from './helpers/terrain-field'

const REPO = process.cwd()
const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(path.join(REPO, p), 'utf8')) as T
const ANNIVERSARY = readJson<Edition>('content/editions/anniversary.json')
const CLASSIC = readJson<Edition>('content/editions/classic.json')
const MISSION = 'anniv_01_glider'

const secs = (s: number): number => Math.round(s / FIXED_DT)
const still = (over: Partial<FlightActions> = {}): FlightActions => ({
  pitch: 0,
  yaw: 0,
  roll: 0,
  throttle: 0,
  boost: false,
  brake: false,
  airbrake: false,
  ...over,
})

/** A glider the way the seam builds one, placed at `y` and started as a spawn starts it. */
const launched = (y = 1000): { glider: Glider; fly: (a: FlightActions, c?: number) => void } => {
  const glider = gliderFor()
  glider.body.position.y = y
  const airframe = gliderAirframe(glider)
  airframe.reset()
  airframe.start()
  return {
    glider,
    fly: (a, c = Number.POSITIVE_INFINITY) => airframe.fly(a, c),
  }
}

// ── 1. the seam picks the glider ────────────────────────────────────────────

describe('the seam picks the glider', () => {
  it('the course names the glider, and loadFlight sends the glider to its own seam', async () => {
    const level = await loadLevel(MISSION)
    // Before G1 this said `hoverjet`, and the arm below was the HoverJet's.
    expect(level.vehicle).toBe('glider')
    expect(flightSeamFor(level.vehicle)).toBe('glider')
    // And the other two are where they always were.
    expect(flightSeamFor('hoverjet')).toBe('hoverjet')
    expect(flightSeamFor('jumpseat')).toBe('jumpseat')
    // Every generated course keeps its own seam: none of the thirteen is a glider.
    for (const id of await levelIds()) {
      const l = await loadLevel(id)
      expect(flightSeamFor(l.vehicle), id).not.toBe('glider')
    }
  })

  it('flies the aircraft file, which is the one the sim was tuned with', () => {
    // The tuning moved from the course to the aircraft (G1). One source: the
    // seam's glider is built from the file, and the file is DEV-145's numbers.
    expect(gliderFor().tuning).toEqual(gliderTuning())
    expect({ ...gliderTuning() }).toEqual({ ...PROTOTYPE_GLIDER })
  })

  it('is a glider: gravity on, no hover motor, launched at trim along the nose', () => {
    const glider = gliderFor()
    const airframe = gliderAirframe(glider)
    expect(airframe.hovers).toBe(false)
    expect(airframe.name).toBe('glider')
    expect(airframe.ship.body).toBe(glider.body)
    expect(glider.body.useGravity).toBe(true)
    // Launched along its nose (body +Z, orientation identity) at trim.
    airframe.start()
    const v = glider.body.velocity
    expect(v.z).toBeCloseTo(trimSpeed(glider.tuning), 9)
    expect(Math.hypot(v.x, v.y)).toBe(0)
    // And its instruments read the launch before the first tick, not a glider at rest.
    expect(gliderReadout(glider).stall.stalling).toBe(false)
  })

  it('hands-off it GLIDES: sinks, holds its speed near trim, and never stalls', () => {
    const { glider, fly } = launched()
    const y0 = glider.body.position.y
    let minAuthority = 1
    for (let i = 0; i < secs(20); i++) {
      fly(still())
      minAuthority = Math.min(minAuthority, glider.liftAuthority)
    }
    // A HoverJet with the throttle shut coasts level: its gravity is OFF once
    // launched. A glider trades height for speed, so it comes down.
    expect(glider.body.position.y).toBeLessThan(y0 - 50)
    expect(glider.airspeed).toBeGreaterThan(glider.tuning.stallSpeed + glider.tuning.stallWidth)
    expect(glider.airspeed).toBeLessThan(terminalDiveSpeed(glider.tuning))
    expect(minAuthority).toBe(1)
  })

  it('reads the belly clearance as ground effect: low over the deck, it sinks slower', () => {
    const high = launched()
    const low = launched()
    for (let i = 0; i < secs(10); i++) {
      high.fly(still(), Number.POSITIVE_INFINITY)
      low.fly(still(), 5)
    }
    // Same start, same stick: the only difference is the clearance handed in.
    expect(low.glider.body.position.y).toBeGreaterThan(high.glider.body.position.y + 1)
  })

  it('burns the rocket on the BOOST trigger, and the throttle does nothing', () => {
    const boosted = launched()
    const throttled = launched()
    const coasting = launched()
    for (let i = 0; i < secs(1); i++) {
      boosted.fly(still({ boost: true }))
      throttled.fly(still({ throttle: 1 }))
      coasting.fly(still())
    }
    expect(boosted.glider.fuel).toBeLessThan(boosted.glider.tuning.rocketSeconds)
    expect(length(boosted.glider.body.velocity)).toBeGreaterThan(
      length(coasting.glider.body.velocity) + 10,
    )
    expect(throttled.glider.body.position).toEqual(coasting.glider.body.position)
  })

  it('a reload fills the rocket; a second glider does not move the first (trap 19)', () => {
    const a = launched()
    const b = launched()
    for (let i = 0; i < secs(1); i++) a.fly(still({ boost: true }))
    const before = { ...a.glider.body.position }
    for (let i = 0; i < secs(1); i++) b.fly(still({ roll: 1, pitch: 1 }))
    expect(a.glider.body.position).toEqual(before)
    gliderAirframe(a.glider).reset()
    expect(a.glider.fuel).toBe(a.glider.tuning.rocketSeconds)
  })

  it('banks no speed chain: a ring cannot give the glider a mechanic it has not got', () => {
    const chain = unbankableChain()
    for (let i = 0; i < 10; i++) chainGate(chain)
    expect(chain.stacks).toBe(0)
    expect(chain.sinceGate).toBe(0)
    expect(gliderAirframe(gliderFor()).ship.chain.stacks).toBe(0)
  })

  it('FLIES ITS COURSE through the game’s own seam, frames and pilot', async () => {
    // What `boot/app.ts` does with `?autopilot` on a glider flight, headless:
    // the spawn in SIM space the way `loadAirframeFlight` converts it, the
    // seam's `start()`, `gliderAutopilot.step` for the actions, the airframe's
    // `fly` for the tick, and the rings and finish in the same frame.
    const level = await loadLevel(MISSION)
    const glider = gliderFor()
    const airframe = gliderAirframe(glider)
    threeTupleToUnity(glider.body.position, level.spawn.pos as number[])
    threeQuatTupleToUnity(glider.body.orientation, level.spawn.quat as number[])
    airframe.reset()
    airframe.start()
    const pilot = gliderAutopilot(glider)
    // The mission `app.ts` starts — its rings and its finish, in its frame —
    // rather than a second reading of the level (trap 24).
    const mission = startMission(level)
    const gates = mission.course.gates
    const home = mission.finishGate
    if (!home) throw new Error('the glider course has no finish gate')
    expect(gates.length).toBe(liveRings(level).length)
    const course = createCourse(gates)
    let finished = false
    let t = 0
    for (let i = 0; i < secs(level.timer.timeLimit); i++) {
      const next = course.passed.findIndex((p) => !p)
      airframe.fly(pilot.step(next < 0 ? home : (gates[next] as Gate).centre), glider.clearance)
      stepCourse(course, glider.body.position)
      t = (i + 1) * FIXED_DT
      if (next < 0) {
        const p = glider.body.position
        if (Math.hypot(p.x - home.x, p.y - home.y, p.z - home.z) <= home.radius) {
          finished = true
          break
        }
      }
    }
    expect(course.passedCount).toBe(gates.length)
    expect(finished).toBe(true)
    expect(t).toBeLessThan(level.timer.timeLimit)
  })

  // The disk work (two height maps) is INSIDE the `it`, never in a describe
  // body, so a tree without `public/assets` skips it rather than throwing at
  // collection (CLAUDE.md's `describe.skipIf` trap). `haveMaps` is false on CI.
  it.skipIf(!haveMaps)(
    'the flown line clears Simonet’s ground by over 100 m, all the way (the island is real)',
    async () => {
      // DEV-145 flew the course with no terrain and called it over water. In
      // the game's frame its middle went 147 m INTO the island, and the first
      // run on the player's route crashed 49 times there. Flown here through
      // the game's seam, sampled against the land and the sea as the hull meets
      // them (`terrainHeightAt`, sim space, the higher of the two).
      const level = await loadLevel(MISSION)
      const land = fieldFor(level)
      const sea = oceanFieldFor(level)
      const ground = (x: number, z: number): number =>
        Math.max(terrainHeightAt(land, x, z), sea ? terrainHeightAt(sea, x, z) : -Infinity)
      const glider = gliderFor()
      const airframe = gliderAirframe(glider)
      threeTupleToUnity(glider.body.position, level.spawn.pos as number[])
      threeQuatTupleToUnity(glider.body.orientation, level.spawn.quat as number[])
      airframe.reset()
      airframe.start()
      const pilot = gliderAutopilot(glider)
      const mission = startMission(level)
      const gates = mission.course.gates
      const home = mission.finishGate
      if (!home) throw new Error('no finish')
      const course = createCourse(gates)
      let lowest = Number.POSITIVE_INFINITY
      for (let i = 0; i < secs(level.timer.timeLimit); i++) {
        const next = course.passed.findIndex((p) => !p)
        airframe.fly(pilot.step(next < 0 ? home : (gates[next] as Gate).centre), glider.clearance)
        stepCourse(course, glider.body.position)
        const p = glider.body.position
        lowest = Math.min(lowest, p.y - ground(p.x, p.z))
        if (next < 0 && Math.hypot(p.x - home.x, p.y - home.y, p.z - home.z) <= home.radius) break
      }
      expect(course.passedCount).toBe(gates.length)
      expect(lowest).toBeGreaterThan(100)
    },
  )

  it('the seam carries the pilot, and no other aircraft does', () => {
    const glider = gliderFor()
    const flight = withGliderSeam({} as Flight, glider)
    expect(gliderAutopilotOf(flight)).not.toBeNull()
    expect(gliderAutopilotOf({} as Flight)).toBeNull()
  })
})

// ── 2. Classic hides it ──────────────────────────────────────────────────────

describe('Classic hides the glider; Anniversary flies it', () => {
  it('the edition flag is the fleet', () => {
    expect(ANNIVERSARY.gameplay.glider.enabled).toBe(true)
    expect(CLASSIC.gameplay.glider.enabled).toBe(false)
    expect(editionFlies(CLASSIC, 'glider')).toBe(false)
    expect(editionFlies(ANNIVERSARY, 'glider')).toBe(true)
    // 2016's two fly in both, and a caller with no edition gets 2016's fleet.
    for (const edition of [CLASSIC, ANNIVERSARY]) {
      expect(editionFlies(edition, 'hoverjet')).toBe(true)
      expect(editionFlies(edition, 'jumpseat')).toBe(true)
    }
    expect(FLEET_2016('glider')).toBe(false)
  })

  it('the glider course joins the level list on Anniversary only', async () => {
    const classic = await levelIds(fleetOf(() => CLASSIC))
    const anniversary = await levelIds(fleetOf(() => ANNIVERSARY))
    expect(classic).not.toContain(MISSION)
    expect(anniversary).toContain(MISSION)
    // Nothing else moves: the two lists differ by the glider's courses alone.
    expect(anniversary.filter((id) => !classic.includes(id))).toEqual([MISSION])
  })

  it('the hangar has two aircraft on Classic and a third, last, on Anniversary', async () => {
    const aircraft = async (e: Edition) =>
      vehicleCards(
        await loadMissionIndex(
          undefined,
          fleetOf(() => e),
        ),
      ).map((v) => v.vehicle)
    expect(await aircraft(CLASSIC)).toEqual(['hoverjet', 'jumpseat'])
    expect(await aircraft(ANNIVERSARY)).toEqual(['hoverjet', 'jumpseat', 'glider'])
    const glider = vehicleCards(
      await loadMissionIndex(
        undefined,
        fleetOf(() => ANNIVERSARY),
      ),
    ).find((v) => v.vehicle === 'glider')
    expect(glider?.name).toBe('Glider')
    expect(glider?.missions.map((m) => m.id)).toEqual([MISSION])
  })

  it('the glider stands LEFT, so 2016’s two keep their Classic bearings on Anniversary', async () => {
    // DEV-203's first property across the edition switch: the HoverJet under
    // the resting pointer and the JumpSeat one step right, in both rooms.
    const bearingOf = async (e: Edition) => {
      const order = slotOrdersFor(
        await loadMissionIndex(
          undefined,
          fleetOf(() => e),
        ),
      ).vehicles
      const bearings = tableBearings(order.length)
      return (vehicle: string) => bearings[order.indexOf(vehicle)]
    }
    const classic = await bearingOf(CLASSIC)
    const anniversary = await bearingOf(ANNIVERSARY)
    // DEV-858: arcs are centred on the eye line, so Classic's two stand at -15/+15
    // off it and Anniversary's three at -30/0/+30: the HoverJet and the JumpSeat
    // keep their ORDER and their 30 degrees apart, and each moves 15 with the arc
    // (a deliberate trade, and only where the preview glider is on).
    const gap = (f: (v: string) => number | undefined) =>
      (f('jumpseat') as number) - (f('hoverjet') as number)
    expect(classic('hoverjet')).toBeCloseTo(SEAT_REST_BEARING - TABLE_BEARING_STEP / 2, 12)
    expect(gap(anniversary)).toBeCloseTo(gap(classic), 12)
    expect(anniversary('hoverjet')).toBeCloseTo(SEAT_REST_BEARING, 12)
    expect(classic('glider')).toBeUndefined()
    expect(anniversary('glider')).toBeLessThan(anniversary('hoverjet') as number)
  })

  it('its variant step is a ONE-table page, not a skipped step (§6.2)', () => {
    const step = variantStep(
      () => ANNIVERSARY,
      aircraftFor,
      () => null,
    )
    const cards = step.cardsFor('glider')
    expect(cards.map((c) => c.id)).toEqual(['standard'])
    expect(stepsFor(step, 'glider')).toContain('variants')
    // Its bars are the glider's own, derived, each at the middle mark.
    expect(cards[0]?.bars.map((b) => b.label)).toEqual(['TOP SPEED', 'BOOST', 'HANDLING'])
    for (const bar of cards[0]?.bars ?? []) {
      expect(bar.value).toBeGreaterThan(0)
      expect(bar.value).toBe(bar.standard)
    }
    expect(cards[0]?.bars[0]?.value).toBe(terminalDiveSpeed(gliderTuning()))
  })

  it('races nobody: the grid is HoverJets, and a glider race waits for a glider racer', () => {
    expect(racesIn('hoverjet')).toBe(true)
    expect(racesIn('glider')).toBe(false)
  })
})

// ── 3. the HUD row reads glider state ────────────────────────────────────────

describe('the HUD row reads the glider the physics stepped', () => {
  const hud = (over: Partial<HudState>): HudState => ({
    ringsPassed: 3,
    ringsTotal: 10,
    score: 300,
    elapsed: 20,
    timeLimit: 180,
    timeCountsDown: true,
    speed: 55,
    medal: '',
    finished: false,
    countLabel: 'GATES',
    timeLabel: 'TIME',
    speedLabel: 'SPEED',
    banner: null,
    autopilot: false,
    ...over,
  })

  it('the rocket is the tank: it drains while the boost is held and reads lit while fuelled', () => {
    const { glider, fly } = launched()
    expect(gliderReadout(glider).fuel).toEqual({ fraction: 1, lit: true })
    for (let i = 0; i < secs(1); i++) fly(still({ boost: true }))
    const after = gliderReadout(glider).fuel
    expect(after.fraction).toBeCloseTo(glider.fuel / glider.tuning.rocketSeconds, 12)
    expect(after.fraction).toBeLessThan(0.7)
    expect(after.fraction).toBeGreaterThan(0.6)
    for (let i = 0; i < secs(3); i++) fly(still({ boost: true }))
    expect(gliderReadout(glider).fuel).toEqual({ fraction: 0, lit: false })
  })

  it('the stall margin is the airspeed the physics used, and warns only below full lift', () => {
    const { glider, fly } = launched()
    // Nose up, hard, until the wing lets go: the margin drains with the airspeed.
    let sawStall = false
    let last = gliderReadout(glider).stall.margin
    let fell = false
    for (let i = 0; i < secs(8); i++) {
      fly(still({ pitch: -1 }))
      const r = gliderReadout(glider).stall
      expect(r.margin).toBe(stallMarginAt(glider.tuning, glider.airspeed))
      expect(r.stalling).toBe(glider.liftAuthority < 1)
      if (r.margin < last) fell = true
      last = r.margin
      if (r.stalling) sawStall = true
    }
    expect(fell).toBe(true)
    expect(sawStall).toBe(true)
    // The ends: 0 at the stall speed, 1 at trim.
    expect(stallMarginAt(glider.tuning, glider.tuning.stallSpeed)).toBe(0)
    expect(stallMarginAt(glider.tuning, trimSpeed(glider.tuning))).toBe(1)
  })

  it('the flight hands the panel LIVE readings, not the ones at boarding', () => {
    const glider = gliderFor()
    const flight = withGliderSeam({} as Flight, glider)
    gliderAirframe(glider).start()
    expect(flight.fuel?.fraction).toBe(1)
    const margin0 = flight.stall?.margin
    glider.fuel = glider.tuning.rocketSeconds / 4
    for (let i = 0; i < secs(2); i++)
      stepGlider(glider, { roll: 0, pitch: -1, yaw: 0, rocket: false })
    expect(flight.fuel?.fraction).toBeCloseTo(
      0.25 + (secs(2) * FIXED_DT * glider.tuning.rocketRecharge) / glider.tuning.rocketSeconds,
      9,
    )
    expect(flight.stall?.margin).not.toBe(margin0)
  })

  it('the dash draws the row: a stall bar on the speed card, and STALL in words', () => {
    const fine = dashContent(hud({ stall: { margin: 0.8, stalling: false } }))
    const stalling = dashContent(hud({ stall: { margin: 0.1, stalling: true } }))
    const none = dashContent(hud({}))
    expect(fine.stall).toEqual({ margin: 0.8, stalling: false })
    expect(fine.badges).not.toContain('STALL')
    expect(stalling.badges).toContain('STALL')
    expect(none.stall).toBeUndefined()
    // The prediction holds against the drawing, bar and badge included.
    for (const content of [fine, stalling, none]) {
      let calls = { total: 0, texts: 0, measures: 0 }
      const tick = () => {
        calls = { ...calls, total: calls.total + 1 }
      }
      const context = {
        fillStyle: '',
        font: '',
        textAlign: 'left',
        textBaseline: '',
        clearRect: tick,
        fillRect: tick,
        setTransform: tick,
        fillText: () => {
          calls = { ...calls, total: calls.total + 1, texts: calls.texts + 1 }
        },
        measureText: (s: string) => {
          calls = { ...calls, total: calls.total + 1, measures: calls.measures + 1 }
          return { width: s.length * 8 }
        },
      }
      drawDash(context as never, 560, 203, content, {
        ink: '#fff',
        accent: '#fc0',
        muted: '#888',
        charge: '#0ff',
        tankTrack: '#022',
        plateEdge: '#9cc',
        boostOut: '#f85',
        boostOutTrack: '#410',
      })
      expect(calls).toEqual(dashCanvasOps(content))
    }
    // No bar at all without a glider: 2016's panel is untouched.
    expect(dashCanvasOps(none).total).toBeLessThan(dashCanvasOps(fine).total)
  })

  it('the panel repaints when the margin moves, and when the wing lets go', () => {
    const a = hudSignature(hud({ stall: { margin: 0.8, stalling: false } }))
    const b = hudSignature(hud({ stall: { margin: 0.5, stalling: false } }))
    const c = hudSignature(hud({ stall: { margin: 0.5, stalling: true } }))
    expect(b).not.toBe(a)
    expect(c).not.toBe(b)
  })
})

// ── the moved tuning, and the doors it closed ───────────────────────────────

describe('the tuning is the aircraft’s now', () => {
  it('lists every key GliderTuning reads, in code, schema and prototype alike', () => {
    const schema = readJson<{
      $defs: Record<string, { required?: string[]; properties?: Record<string, unknown> }>
    }>('content/aircraft/_schema.json')
    const keys = [...GLIDER_TUNING_KEYS].sort()
    expect(Object.keys(PROTOTYPE_GLIDER).sort()).toEqual(keys)
    expect([...(schema.$defs.gliderTuning?.required ?? [])].sort()).toEqual(keys)
    expect(Object.keys(schema.$defs.gliderTuning?.properties ?? {}).sort()).toEqual(keys)
    expect(AIRCRAFT_TUNING_KEYS.glider).toBe(GLIDER_TUNING_KEYS)
    expect(AIRCRAFT_TUNING_KEYS.hoverjet).toBeNull()
  })

  it('refuses a glider without its numbers, and a HoverJet with a second source', () => {
    const file = readJson<Aircraft>('content/aircraft/glider.json')
    const { tuning: _gone, ...bare } = file
    expect(() => validateAircraft(bare as Aircraft, 'bare')).toThrow(/needs a tuning block/)
    const short = { ...file, tuning: { ...file.tuning, rocketThrust: undefined } }
    expect(() => validateAircraft(short as unknown as Aircraft, 'short')).toThrow(/rocketThrust/)
    const extra = { ...file, tuning: { ...file.tuning, liftScale: 1 } }
    expect(() => validateAircraft(extra as Aircraft, 'extra')).toThrow(/liftScale/)
    const jet = readJson<Aircraft>('content/aircraft/hoverjet.json')
    expect(() => validateAircraft({ ...jet, tuning: { mass: 4 } }, 'jet')).toThrow(/second source/)
  })

  it('refuses a course that still carries a flight model', async () => {
    const level = readJson<Level>(`content/authored/${MISSION}.json`)
    const stale = { ...level, flightModel: { kind: 'glider', tuning: PROTOTYPE_GLIDER } }
    expect(() => validateLevel(stale as Level)).toThrow(LevelSchemaError)
    expect(() => validateLevel(stale as Level)).toThrow(/content\/aircraft\/glider\.json/)
  })

  it('launches at a trim speed that is the solve’s own cruise', () => {
    // DEV-145's second chosen number, read back out of the solved fields.
    const t = gliderTuning()
    expect(trimSpeed(t)).toBeGreaterThan(54)
    expect(trimSpeed(t)).toBeLessThan(56)
  })
})
