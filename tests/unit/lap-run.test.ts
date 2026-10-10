// tests/unit/lap-run.test.ts — DEV-371: the lap a run keeps, and the ghost the
// next one races.
//
// Flown the way `boot/app.ts` calls it: `release` BEFORE the first flight step,
// then per fixed step `stepHoverJet`, `stepMission`, and `step` after it. The
// oracle for every time here is the live mission's own `finishAt` and
// `elapsed`, never a number this file computes — so the assertions are about
// the controller agreeing with the game, not with itself.

import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { readLap } from '@/game/ghost-store'
import { type ChosenGhost, createLapRun, ghostSplit, type LapRun, splitText } from '@/game/lap-run'
import { type MissionState, startMission, stepMission } from '@/game/mission'
import { threeQuatTupleToUnity, threeTupleToUnity } from '@/render/unity-space'
import { autopilotActions, nextGate } from '@/sim/autopilot'
import { FIXED_DT } from '@/sim/constants'
import { decodeGhostClip, type LapDoc, sampleGhost } from '@/sim/ghost'
import { createHoverJet, noInput, stepHoverJet } from '@/sim/hoverjet'
import int01 from '../../content/levels/int_01_hoverJet.json'

const LEVEL = int01 as unknown as Level
const WORLD_OFFSET: readonly [number, number, number] = [
  LEVEL.worldOffset[0] as number,
  LEVEL.worldOffset[1] as number,
  LEVEL.worldOffset[2] as number,
]
const ED = 'anniversary'

const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

/**
 * The rules a lap carries under each preset, as DEV-372's `lapRules` gives an
 * opaque string per (mission, edition, variant). Written out, not imported from
 * the server's module: the controller is handed a function, and this is one.
 * The vehicle is `lapVehicle`'s `<vehicle>:<variant>`, `standard` included.
 */
const rulesFor = (edition: string): string => `unit-rules-${edition}`
const VEHICLE = 'hoverjet:standard'
/** The slot a lap of this file is kept in. */
const slot = (edition: string, rules = rulesFor(edition)) => ({
  mission: LEVEL.id,
  mode: 'ringAttack',
  edition,
  rules,
  vehicle: VEHICLE,
  variant: 'standard',
})

const lapRunFor = (
  storage = memory(),
  urlTaint: readonly string[] = [],
  rules: (edition: string) => string = rulesFor,
  variant = 'standard',
): LapRun =>
  createLapRun({
    level: LEVEL,
    worldOffset: WORLD_OFFSET,
    mode: 'ringAttack',
    build: 'unit',
    rulesFor: rules,
    vehicle: `hoverjet:${variant}`,
    variant,
    urlTaint,
    storage,
  })

interface Flight {
  readonly mission: MissionState
  /** `run.clock` and `mission.elapsed` at every step, and the step each was read on. */
  readonly clocks: { tick: number; clock: number; elapsed: number }[]
  readonly lap: ReturnType<LapRun['step']>
}

/**
 * The autopilot's `int_01` lap, through the controller. `holdTicks` flies the
 * first ticks with the stick at rest, which makes a slower lap; `after` keeps
 * stepping past the finish, as the game does while the panel is up.
 */
const fly = (
  run: LapRun,
  options: {
    holdTicks?: number
    after?: number
    edition?: (tick: number) => string
    each?: (tick: number) => void
  } = {},
): Flight => {
  const jet = createHoverJet()
  jet.launched = true
  threeTupleToUnity(jet.body.position, LEVEL.spawn.pos as number[])
  threeQuatTupleToUnity(jet.body.orientation, LEVEL.spawn.quat as number[])
  jet.body.position.y += LEVEL.spawn.launch?.rise ?? 0
  const mission = startMission(LEVEL)
  const clocks: Flight['clocks'] = []
  const steps = Math.ceil(LEVEL.timer.timeLimit / FIXED_DT)
  let lap: Flight['lap'] = null
  let past = -1
  run.release(jet.body, options.edition?.(0) ?? ED)
  for (let tick = 1; tick <= steps; tick++) {
    const input = noInput()
    if (tick > (options.holdTicks ?? 0)) {
      const gates = mission.course.gates
      const target = nextGate(gates, mission.course.passed)
      const finishGate = mission.finishGate as NonNullable<typeof mission.finishGate>
      const aim = target >= 0 ? (gates[target] as (typeof gates)[number]).centre : finishGate
      const beyond = target >= 0 ? (gates[target + 1]?.centre ?? finishGate) : null
      autopilotActions(jet.body, aim, input, undefined, [], Number.POSITIVE_INFINITY, beyond)
    }
    options.each?.(tick)
    stepHoverJet(jet, input)
    const ring = stepMission(mission, LEVEL, jet.body.position, FIXED_DT)
    const kept = run.step(
      FIXED_DT,
      jet.body,
      { ring, finishCrossed: mission.finishCrossed, finished: mission.finished },
      options.edition?.(tick) ?? ED,
    )
    clocks.push({ tick, clock: run.clock, elapsed: mission.elapsed })
    if (kept) {
      lap = kept
      past = 0
    }
    if (past >= 0 && past++ >= (options.after ?? 0)) break
  }
  return { mission, clocks, lap }
}

// One run flown once and shared: the three below only read it.
let flown: { run: LapRun; storage: ReturnType<typeof memory>; flight: Flight } | null = null
const firstLap = () => {
  if (!flown) {
    const storage = memory()
    const run = lapRunFor(storage)
    run.newRun(ED)
    flown = { run, storage, flight: fly(run, { after: 200 }) }
  }
  return flown
}

describe('the lap a run keeps', () => {
  it('is kept on the finish tick, and its own poses finish it on the live tick, to the bit', () => {
    const { flight } = firstLap()
    const lap = flight.lap
    expect(lap).not.toBeNull()
    expect(flight.mission.finishCrossed).toBe(true)
    expect(lap?.seconds).toBe(flight.mission.finishAt)
    expect(lap?.gates).toBe(flight.mission.ringsPassed)
    expect(lap?.gates).toBe(21)
    expect(lap?.finishTick).toBe(Math.round((flight.mission.finishAt as number) / FIXED_DT))
    // Tick 0 is the release; the last key is the finish tick.
    expect(lap?.doc.tick[0]).toBe(0)
    expect(lap?.doc.tick.at(-1)).toBe(lap?.finishTick)
    expect(lap?.doc.events.at(-1)).toEqual({ tick: lap?.finishTick, kind: 'finish' })
    expect(lap?.doc.events.filter((e) => e.kind === 'gate')).toHaveLength(21)
    expect(lap?.doc).toMatchObject({ mission: LEVEL.id, mode: 'ringAttack', edition: ED })
    // DEV-372's two fields: the rules of the preset it finished in, and the vehicle.
    expect(lap?.doc.rules).toBe(rulesFor(ED))
    expect(lap?.doc.vehicle).toBe(VEHICLE)
  })

  it('is stored as the best, clean, and read back as the same lap', () => {
    const { flight, storage } = firstLap()
    expect(flight.lap).toMatchObject({ improved: true, stored: true, tainted: false })
    const kept = readLap(slot(ED), storage)
    expect(kept?.doc).toEqual(flight.lap?.doc)
    expect(kept?.seconds).toBe(flight.mission.finishAt)
  })

  it('runs a ghost clock that IS mission.elapsed until the finish, and keeps going past it', () => {
    const { flight } = firstLap()
    const finishTick = flight.lap?.finishTick as number
    const before = flight.clocks.filter((c) => c.tick <= finishTick)
    expect(before.every((c) => c.clock === c.elapsed)).toBe(true)
    const after = flight.clocks.filter((c) => c.tick > finishTick)
    expect(after.length).toBeGreaterThan(100)
    // The mission stopped; the ghost's clock did not.
    expect(new Set(after.map((c) => c.elapsed)).size).toBe(1)
    const last = after.at(-1) as (typeof after)[number]
    expect(last.clock).toBeCloseTo(last.tick * FIXED_DT, 6)
  })
})

describe('the ghost the next run races', () => {
  it('is your kept best by default, and the lap just flown when asked (race this lap)', () => {
    const storage = memory()
    const run = lapRunFor(storage)
    expect(run.newRun(ED)).toBeNull()
    const fast = fly(run).lap
    // A slower lap: the stick at rest for the first two seconds.
    const best = run.newRun(ED)
    expect(best?.source).toBe('best')
    expect(best?.result.seconds).toBe(fast?.seconds)
    expect(run.last).toBeNull()
    const slow = fly(run, { holdTicks: Math.round(2 / FIXED_DT) }).lap
    expect(slow?.seconds).toBeGreaterThan(fast?.seconds as number)
    expect(slow).toMatchObject({ improved: false, stored: false })
    // "Race this lap": the slow one, best or not.
    const raced = run.newRun(ED, true)
    expect(raced?.source).toBe('this-lap')
    expect(raced?.doc).toBe(slow?.doc)
    expect(raced?.result.seconds).toBe(slow?.seconds)
    // And another go after that is back to the best.
    expect(run.newRun(ED)?.result.seconds).toBe(fast?.seconds)
  })

  it('does not race a lap kept under rules that have since moved (DEV-372)', () => {
    const storage = memory()
    const before = lapRunFor(storage)
    before.newRun(ED)
    expect(fly(before).lap?.stored).toBe(true)
    // A later build: the same course, one gameplay number moved, so the rules
    // hash did too. The kept lap is not comparable, and is not the ghost.
    const after = lapRunFor(storage, [], (edition) => `moved-${edition}`)
    expect(after.newRun(ED)).toBeNull()
    expect(after.stored(ED)).toBeNull()
    // Nor does it stop the next lap from being kept, however it compares.
    const next = fly(after, { holdTicks: Math.round(2 / FIXED_DT) }).lap
    expect(next).toMatchObject({ improved: true, stored: true })
    expect(next?.doc.rules).toBe(`moved-${ED}`)
  })

  it('keeps a best per VARIANT: the speed jet never races the standard jet, nor it the speed jet', () => {
    // Matt, through the lead, 2026-09-25: records are per variant, and there is
    // a board per variant. The lap run takes the variant the flight was built
    // as; a different variant is a world swap, so a new lap run (DEV-382).
    const storage = memory()
    const speed = lapRunFor(storage, [], (edition) => `speed-rules-${edition}`, 'speed')
    speed.newRun(ED)
    const flown = fly(speed).lap
    expect(flown?.doc.vehicle).toBe('hoverjet:speed')
    expect(flown?.stored).toBe(true)
    // The standard jet on the same course and preset: nothing to race.
    const standard = lapRunFor(storage)
    expect(standard.newRun(ED)).toBeNull()
    expect(standard.stored(ED)).toBeNull()
    // Its own lap, however slow, is its own best, and the speed jet's stands.
    const slow = fly(standard, { holdTicks: Math.round(2 / FIXED_DT) }).lap
    expect(slow).toMatchObject({ improved: true, stored: true })
    expect(standard.newRun(ED)?.result.seconds).toBe(slow?.seconds)
    const again = lapRunFor(storage, [], (edition) => `speed-rules-${edition}`, 'speed')
    expect(again.newRun(ED)?.result.seconds).toBe(flown?.seconds)
    expect(storage.map.size).toBe(2)
  })

  it('races nothing on "race this lap" when this run left no lap', () => {
    const run = lapRunFor()
    run.newRun(ED)
    expect(run.newRun(ED, true)).toBeNull()
  })

  it('splits against the ghost at a ring: behind is plus, ahead is minus, a miss is nothing', () => {
    const { run } = firstLap()
    const ghost = run.newRun(ED)
    const at = ghost?.result.ringTimes[3] as number
    expect(ghostSplit(ghost, 3, at + 0.42)).toBeCloseTo(0.42, 9)
    expect(splitText(0.42)).toBe('GHOST +0.42')
    expect(splitText(-1.5)).toBe('GHOST -1.50')
    expect(ghostSplit(null, 3, at)).toBeNull()
    expect(
      ghostSplit(
        ghost ? { ...ghost, result: { ...ghost.result, ringTimes: [null] } } : null,
        0,
        10,
      ),
    ).toBeNull()
  })
})

describe('runTainted', () => {
  it('is set by an autopilot tick, kept on the lap, and cleared by the next run', () => {
    const run = lapRunFor()
    run.newRun(ED)
    const lap = fly(run, { each: (tick) => tick === 2000 && run.taintRun('autopilot') }).lap
    expect(lap?.tainted).toBe(true)
    expect(lap?.reasons).toEqual(['autopilot'])
    run.newRun(ED)
    expect(run.taint.reasons).toEqual([])
  })

  it("starts every run from the URL's own switches", () => {
    const run = lapRunFor(memory(), ['?props'])
    run.newRun(ED)
    expect(fly(run).lap?.reasons).toEqual(['?props'])
    run.newRun(ED)
    expect(run.taint.reasons).toEqual(['?props'])
  })

  it('is set by a preset flipped mid-lap', () => {
    const run = lapRunFor()
    run.newRun(ED)
    const lap = fly(run, { edition: (tick) => (tick > 3000 ? 'classic' : ED) }).lap
    expect(lap?.tainted).toBe(true)
    expect(lap?.reasons).toEqual(['edition changed mid-lap'])
    // Filed under the preset it finished in, with that preset's rules.
    expect(lap?.doc.edition).toBe('classic')
    expect(lap?.doc.rules).toBe(rulesFor('classic'))
  })
})

describe('the edges of a run', () => {
  const body = (x: number) => ({
    position: { x, y: 500, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  })
  const ON = { ring: -1, finishCrossed: false, finished: false }

  it('keeps no lap for a run the clock ended', () => {
    const run = lapRunFor()
    run.newRun(ED)
    run.release(body(0), ED)
    expect(run.step(FIXED_DT, body(1), ON, ED)).toBeNull()
    expect(run.step(FIXED_DT, body(2), { ...ON, finished: true }, ED)).toBeNull()
    expect(run.step(FIXED_DT, body(3), { ...ON, finishCrossed: true }, ED)).toBeNull()
    expect(run.last).toBeNull()
  })

  it('restarts the lap at tick 0 ON the marker mid-flight, with no reset event there', () => {
    // DEV-372's validator refuses a `reset` at tick 0 (it has no step into it)
    // and accepts a first key on the respawn marker: the lap simply starts there.
    const run = lapRunFor()
    run.newRun(ED)
    run.release(body(0), ED)
    expect(run.tick).toBe(0)
    // A second release is a no-op: the lift lets go once.
    run.release(body(99), ED)
    for (let i = 1; i <= 5; i++) run.step(FIXED_DT, body(i), ON, ED)
    run.placed()
    run.step(FIXED_DT, body(6), ON, ED)
    // The boundary kills the run: back to zero, on the marker.
    run.restart(body(-50), ED)
    expect(run.tick).toBe(0)
    expect(run.clock).toBe(0)
    run.step(FIXED_DT, body(-50), ON, ED)
    const lap = run.step(FIXED_DT, body(-49), { ...ON, finishCrossed: true, finished: true }, ED)
    expect(lap?.doc.tick).toEqual([0, 1, 2])
    expect(lap?.doc.events).toEqual([{ tick: 2, kind: 'finish' }])
    // And its first pose is where the respawn put the ship (SIM x = THREE x).
    const first = sampleGhost(decodeGhostClip(lap?.doc as LapDoc), 0, {
      px: 0,
      py: 0,
      pz: 0,
      qx: 0,
      qy: 0,
      qz: 0,
      qw: 1,
    })
    expect(first.px + WORLD_OFFSET[0]).toBeCloseTo(-50, 3)
    // The first lap's crash reset went with the lap it was in.
    expect(lap?.finishTick).toBe(2)
  })

  it('marks the crash reset tick on the lap that keeps it', () => {
    const run = lapRunFor()
    run.newRun(ED)
    run.release(body(0), ED)
    run.step(FIXED_DT, body(1), ON, ED)
    run.placed()
    run.step(FIXED_DT, body(-20), ON, ED)
    const lap = run.step(FIXED_DT, body(-19), { ...ON, finishCrossed: true, finished: true }, ED)
    expect(lap?.doc.events).toEqual([
      { tick: 2, kind: 'reset' },
      { tick: 3, kind: 'finish' },
    ])
  })
})

describe('the ghost the player chose (DEV-373)', () => {
  const chosenRun = (chosen: () => ChosenGhost, storage = memory()): LapRun =>
    createLapRun({
      level: LEVEL,
      worldOffset: WORLD_OFFSET,
      mode: 'ringAttack',
      build: 'unit',
      rulesFor,
      vehicle: VEHICLE,
      variant: 'standard',
      urlTaint: [],
      storage,
      chosen,
    })

  it('races a shared lap on its own course, under its poster’s handle, rescored from its poses', () => {
    const { flight } = firstLap()
    const doc = flight.lap?.doc as LapDoc
    const run = chosenRun(() => ({ kind: 'shared', doc, handle: 'Bold Heron 77' }))
    const ghost = run.newRun(ED)
    expect(ghost?.source).toBe('shared')
    expect(ghost?.handle).toBe('Bold Heron 77')
    expect(ghost?.doc).toBe(doc)
    expect(ghost?.result.seconds).toBe(flight.mission.finishAt)
    expect(ghost?.tainted).toBe(false)
  })

  it('races nothing when none was chosen, with a best kept; and the default is still the best', () => {
    const { storage } = firstLap()
    expect(chosenRun(() => ({ kind: 'none' }), storage).newRun(ED)).toBeNull()
    const best = chosenRun(() => ({ kind: 'best' }), storage).newRun(ED)
    expect(best?.source).toBe('best')
    expect(best?.handle).toBeNull()
  })

  it('never flies another course’s lap here: its poses belong to that level', () => {
    const { flight, storage } = firstLap()
    const doc = { ...(flight.lap?.doc as LapDoc), mission: 'int_02_hoverJet' }
    const run = chosenRun(() => ({ kind: 'shared', doc, handle: 'Bold Heron 77' }), storage)
    expect(run.newRun(ED)?.source).toBe('best')
  })

  it('gives way to "race this lap" for the one run that asks, and comes back after it', () => {
    const doc = firstLap().flight.lap?.doc as LapDoc
    const run = chosenRun(() => ({ kind: 'shared', doc, handle: 'Bold Heron 77' }))
    run.newRun(ED)
    expect(fly(run).lap).not.toBeNull()
    expect(run.newRun(ED, true)?.source).toBe('this-lap')
    expect(run.newRun(ED)?.source).toBe('shared')
  })
})

// ── DEV-571: "save as your ghost?" ──────────────────────────────────────────
//
// Matt, 2026-10-02: *"ask if they want to save their ghost"*. The finish tick
// still saves a lap that beats the saved one (so a quick retry races it); the
// panel's answer then moves it either way, and these hold what each answer
// leaves in the store.

describe('the answer to "save as your ghost?" (DEV-571)', () => {
  const only = (storage: ReturnType<typeof memory>): string | undefined =>
    storage.map.get([...storage.map.keys()][0] as string)

  it('starts where the store left it: yes for a better lap, no for a worse one', () => {
    const storage = memory()
    const run = lapRunFor(storage)
    run.newRun(ED)
    expect(run.lastKept, 'no lap on the panel').toBeNull()
    const fast = fly(run).lap
    expect(run.lastKept).toBe(true)
    expect(fast?.savedBefore, 'nothing was saved before it').toBeNull()
    run.newRun(ED)
    const slow = fly(run, { holdTicks: Math.round(2 / FIXED_DT) }).lap
    expect(run.lastKept).toBe(false)
    expect(slow?.savedBefore).toBe(fast?.seconds)
  })

  it('YES saves a slower lap over the faster one; NO puts back exactly what was saved', () => {
    const storage = memory()
    const run = lapRunFor(storage)
    run.newRun(ED)
    const fast = fly(run).lap
    const fastText = only(storage)
    run.newRun(ED)
    // A slower lap is not saved by itself ...
    const slow = fly(run, { holdTicks: Math.round(2 / FIXED_DT) }).lap
    expect(readLap(slot(ED), storage)?.seconds).toBe(fast?.seconds)
    // ... YES saves it over the faster one: it is the player's ghost, chosen.
    expect(run.keepLast(true)).toBe(true)
    expect(readLap(slot(ED), storage)?.seconds).toBe(slow?.seconds)
    // ... and NO puts the faster one back, byte for byte.
    expect(run.keepLast(false)).toBe(false)
    expect(only(storage)).toBe(fastText)
    // YES again, and the next run races the slow one.
    expect(run.keepLast(true)).toBe(true)
    expect(run.newRun(ED)?.result.seconds).toBe(slow?.seconds)
  })

  it('NO with nothing saved before leaves no ghost, on a store that can remove and on one that cannot', () => {
    const map = new Map<string, string>()
    const removing = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    }
    for (const storage of [removing, memory()]) {
      const run = createLapRun({
        level: LEVEL,
        worldOffset: WORLD_OFFSET,
        mode: 'ringAttack',
        build: 'unit',
        rulesFor,
        vehicle: VEHICLE,
        variant: 'standard',
        urlTaint: [],
        storage,
      })
      run.newRun(ED)
      fly(run)
      expect(run.lastKept).toBe(true)
      expect(run.keepLast(false)).toBe(false)
      expect(readLap(slot(ED), storage)).toBeNull()
      expect(run.newRun(ED), 'nothing to race').toBeNull()
    }
    expect(map.size, 'removed, not emptied').toBe(0)
  })

  it('cannot be asked with no storage, and a store that throws leaves the answer where it was', () => {
    const none = createLapRun({
      level: LEVEL,
      worldOffset: WORLD_OFFSET,
      mode: 'ringAttack',
      build: 'unit',
      rulesFor,
      vehicle: VEHICLE,
      variant: 'standard',
      urlTaint: [],
      storage: null,
    })
    none.newRun(ED)
    fly(none)
    expect(none.lastKept).toBeNull()
    expect(none.keepLast(true)).toBeNull()

    const storage = memory()
    const run = lapRunFor(storage)
    run.newRun(ED)
    fly(run)
    storage.setItem = () => {
      throw new Error('quota')
    }
    expect(run.keepLast(false), 'the write failed: still saved').toBe(true)
  })

  it('is about the lap on the panel only: a new run has none to answer for', () => {
    const run = lapRunFor()
    run.newRun(ED)
    fly(run)
    run.newRun(ED)
    expect(run.lastKept).toBeNull()
    expect(run.keepLast(true)).toBeNull()
  })
})
