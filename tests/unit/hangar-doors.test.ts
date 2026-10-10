// tests/unit/hangar-doors.test.ts: the hangar's FIRST step. DEV-558.
//
// Matt, 2026-10-01: *"Clicking either should take us to the Hangar, where the
// first set of choices are: Single Player / Multiplayer / FFTV. Clicking Single
// Player should: Aircraft selection then mode selection"*.
//
// Two halves. The cards as plain values (`render/hangar-doors.ts`): which
// tables stand on which build, in Matt's order, with the title rows' ids. And a
// REAL room (`createHangar`, the canvas stubbed as `course-shelf.test.ts` stubs
// it) walked the way a head and a press walk it: it opens on the doors, SINGLE
// PLAYER descends to the aircraft, BACK from the aircraft comes back, and a
// door the room does not descend through is handed to the app and boards
// nothing. Every press is a `gaze` at a table's bearing and a `choose()`.
//
// DEV-565 (Matt, 2026-10-02: *"add quick race as a 4th table"*): QUICK RACE
// stands beside SINGLE PLAYER on every build, and a press of it is handed to
// the app. DEV-578 (Matt, 2026-10-03: *"FF-TV - move to production"*): four
// tables on every build, laid at the doors' own narrower bearing step.

import fs from 'node:fs'
import * as THREE from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameMode } from '@/content/level-schema'
import type { MissionCard } from '@/game/mission-index'
import { MODES } from '@/game/modes'
import {
  BACK_KICKER,
  BACK_WORDS,
  backWordFor,
  boardsFromRank,
  CENTRED_STEPS,
  createHangar,
  DOOR_VIEWS,
  DOORS_BEARING_STEP,
  GAZE_RADIUS,
  HANGAR_VIEWS,
  type HangarArt,
  plateAction,
  restingSlot,
  SEAT_REST_BEARING,
  seatEyeLocal,
  stepBearings,
  stepStartYaw,
  TABLE_BEARING_STEP,
  tableGazeLocal,
  viewBehind,
} from '@/render/hangar'
import {
  DOOR,
  type DoorCard,
  type DoorInput,
  type DoorStep,
  doorCards,
  doorDescends,
  doorStepCards,
  FIRST_VISIT_NOTE,
  multiplayerCards,
  NO_OPEN_ROOMS_DOOR,
  OPEN_ROOM_TABLES,
  openRoomOfDoor,
  quickRaceCard,
} from '@/render/hangar-doors'
import { hangarSpecFor } from '@/sim/hangar'
import { appSourceThroughCtx } from './helpers/app-source'

const SPEC = hangarSpecFor()

const input = (over: Partial<DoorInput> = {}): DoorInput => ({
  rooms: true,
  tv: true,
  firstVisit: false,
  linkRoom: null,
  roomNotice: null,
  ...over,
})
const ids = (cards: readonly DoorCard[]) => cards.map((c) => c.id)

describe('DEV-879: the Course Editor table', () => {
  it('is the first step second table, on a build that offers the editor, and six doors stay symmetric', () => {
    const six = doorCards(input({ editor: true }))
    expect(ids(six)).toEqual([
      'options',
      'course-editor',
      'quick-race',
      'single-player',
      'multiplayer',
      'tv',
    ])
    expect(six[1]?.name).toBe('Course Editor')
    expect(six[1]?.picture).toBe('editor')
    // Absent or false: no table, the five doors as they were.
    expect(ids(doorCards(input()))).not.toContain('course-editor')
    expect(ids(doorCards(input({ editor: false })))).not.toContain('course-editor')
    // FLY is the right-middle of six, the table the resting look takes (DEV-858).
    expect(ids(six).indexOf(DOOR.single)).toBe(restingSlot(six.length))
    const at = stepBearings('doors', six.length)
    expect(at.reduce((a, b) => a + b, 0) / six.length).toBeCloseTo(SEAT_REST_BEARING, 9)
  })

  it('is pressed by the app (the editor), not descended', () => {
    expect(doorDescends(DOOR.editor)).toBeNull()
    const { room, handed } = build(input({ editor: true }))
    expect(pressDoor(room, DOOR.editor)).toBeNull()
    expect(handed).toEqual([DOOR.editor])
    expect(room.view).toBe('doors')
  })
})

describe('the cards', () => {
  it('stands QUICK RACE, SINGLE PLAYER, MULTIPLAYER and FF-TV, with the title rows’ ids, and OPTIONS first (DEV-620, DEV-832)', () => {
    expect(ids(doorCards(input()))).toEqual([
      'options',
      'quick-race',
      'single-player',
      'multiplayer',
      'tv',
    ])
    expect(doorCards(input()).map((c) => c.name)).toEqual([
      'Options',
      'Quick Race',
      'Fly',
      'Multiplayer',
      'FF-TV',
    ])
  })

  it('follows the build: no FF-TV without TV, no Multiplayer without rooms (both ship since DEV-578)', () => {
    // DEV-620: CREDITS reads no flag either; it is first on every build.
    expect(ids(doorCards(input({ tv: false })))).toEqual([
      DOOR.options,
      DOOR.quickRace,
      DOOR.single,
      DOOR.multiplayer,
    ])
    expect(ids(doorCards(input({ rooms: false })))).toEqual([
      DOOR.options,
      DOOR.quickRace,
      DOOR.single,
      DOOR.tv,
    ])
    // DEV-565: QUICK RACE reads no flag; it stands wherever SINGLE PLAYER does.
    // With two tables the home is the first, so SINGLE PLAYER leads.
    expect(ids(doorCards(input({ rooms: false, tv: false })))).toEqual([
      DOOR.options,
      DOOR.single,
      DOOR.quickRace,
    ])
  })

  it('DEV-565: QUICK RACE keeps the title row’s id and says what it boards', () => {
    expect(DOOR.quickRace).toBe('quick-race')
    const q = quickRaceCard(input())
    // DEV-575: Matt's subtitle, word for word, and his "remove 'a random
    // course, no lift ride'": no note where the aircraft has one variant.
    expect(q.detail).toBe('Ring Attack on random course')
    expect(q.note).toBe('')
    // DEV-382's value on the old row, kept as the whole note where there are
    // two variants (preview): the jet it will fly, which no word above says.
    expect(quickRaceCard(input({ quickRaceVariant: 'Acrobat' })).note).toBe('Acrobat jet')
    // DEV-575: its picture is 2016's gate (MULTIPLAYER's until now).
    expect(q.picture).toBe('ring')
  })

  it('DEV-575: SINGLE PLAYER reads "HoverJet or JumpSeat"; MULTIPLAYER stands the formation, FF-TV the set', () => {
    const cards = doorCards(input({ racerLiveries: ['#ff1f4b', '#22aaff', '#ffd23f', '#00ff00'] }))
    const by = (id: string) => cards.find((c) => c.id === id) as DoorCard
    expect(
      by(DOOR.single).name,
      'the table says Fly (Flow A, DEV-858); its id stays single-player',
    ).toBe('Fly')
    expect(by(DOOR.single).detail).toBe('HoverJet or JumpSeat')
    expect(by(DOOR.multiplayer).picture).toBe('formation')
    expect(by(DOOR.multiplayer).vehicle).toBe('hoverjet')
    expect(by(DOOR.multiplayer).liveries, 'three jets, leader first').toEqual([
      '#ff1f4b',
      '#22aaff',
      '#ffd23f',
    ])
    expect(
      doorCards(input()).find((c) => c.id === DOOR.multiplayer)?.liveries,
      'no livery handed, none invented',
    ).toBeUndefined()
    expect(by(DOOR.tv).picture).toBe('tv')
    // No door stands the orb or a lone racer any more.
    // DEV-832: OPTIONS stands a panel of sliders (CREDITS' scroll is a step in).
    expect(cards.map((c) => c.picture)).toEqual(['options', 'ring', 'aircraft', 'formation', 'tv'])
  })

  it('lights the first-visit note on SINGLE PLAYER, in the accent (DEV-379’s, one table up)', () => {
    const single = (over: Partial<DoorInput>) =>
      doorCards(input(over)).find((c) => c.id === DOOR.single) as DoorCard
    expect(single({ firstVisit: true }).note).toBe(FIRST_VISIT_NOTE)
    expect(single({ firstVisit: true }).accent).toBe(true)
    expect(single({}).accent).toBe(false)
  })

  it('says a link’s room, or why it failed, on MULTIPLAYER', () => {
    const multiplayer = (over: Partial<DoorInput>) =>
      doorCards(input(over)).find((c) => c.id === DOOR.multiplayer)
    expect(multiplayer({ linkRoom: 'K7Q X4M2' })?.note).toBe('room K7Q X4M2, from your link')
    const refused = multiplayer({ linkRoom: 'K7Q X4M2', roomNotice: 'closed' })
    expect(refused?.note).toBe('closed')
    expect(refused?.accent).toBe(true)
  })

  it('puts the title’s Multiplayer page on its step: a link’s room first, then host and code', () => {
    expect(ids(multiplayerCards(input()))).toEqual([DOOR.host, DOOR.joinCode])
    const linked = multiplayerCards(input({ linkRoom: 'K7Q X4M2' }))
    expect(ids(linked)).toEqual([DOOR.joinLink, DOOR.host, DOOR.joinCode])
    expect(linked[0]?.detail).toContain('K7Q X4M2')
    // The title rows' own ids, so a spec or a log that named a row names this.
    expect([DOOR.host, DOOR.joinCode, DOOR.joinLink]).toEqual(['room', 'room-code', 'room-join'])
    expect(doorStepCards('multiplayer', input())).toEqual(multiplayerCards(input()))
  })

  // DEV-633: OPEN ROOMS, after the step's own tables.
  it('stands the public rooms after host and code: none while unknown, one table when there are none', () => {
    expect(ids(multiplayerCards(input({ openRooms: null })))).toEqual([DOOR.host, DOOR.joinCode])
    expect(ids(multiplayerCards(input({ openRooms: [] })))).toEqual([
      DOOR.host,
      DOOR.joinCode,
      NO_OPEN_ROOMS_DOOR,
    ])
    const room = (code: string, over = {}) => ({
      code,
      spoken: `${code.slice(0, 3)} ${code.slice(3)}`,
      course: 'Intermediate 1',
      players: 2,
      seats: 6,
      racing: false,
      ...over,
    })
    const cards = multiplayerCards(
      input({
        openRooms: [
          room('K7QX4MN'),
          room('BCDFGHJ', { racing: true }),
          room('2345678', { players: 6 }),
          room('MNPQRST'),
        ],
      }),
    )
    const open = cards.slice(2)
    expect(open).toHaveLength(OPEN_ROOM_TABLES)
    expect(open.map((c) => openRoomOfDoor(c.id))).toEqual(['K7QX4MN', 'BCDFGHJ', '2345678'])
    expect(open[0]).toMatchObject({ name: 'Intermediate 1', detail: '2 of 6 · room K7Q X4MN' })
    expect(open.map((c) => c.note)).toEqual([
      'open: press to join',
      'racing: join when it ends',
      'full',
    ])
    expect(openRoomOfDoor(DOOR.host)).toBeNull()
  })

  it('descends through SINGLE PLAYER and MULTIPLAYER only; every other door is the app’s', () => {
    expect(doorDescends(DOOR.single)).toBe('vehicles')
    expect(doorDescends(DOOR.multiplayer)).toBe('multiplayer')
    for (const id of [DOOR.tv, DOOR.quickRace, DOOR.host, DOOR.joinCode, DOOR.joinLink]) {
      expect(doorDescends(id), id).toBeNull()
    }
  })

  it('fits every line on the label (38 characters, 28 for a name)', () => {
    const all = [
      ...doorCards(input({ firstVisit: true, linkRoom: 'K7Q X4M2' })),
      // DEV-565: with the longest variant name the aircraft content holds today.
      quickRaceCard(input({ quickRaceVariant: 'Standard' })),
      ...multiplayerCards(input({ linkRoom: 'K7Q X4M2' })),
    ]
    for (const c of all) {
      expect(c.name.length, c.name).toBeLessThanOrEqual(28)
      expect(c.detail.length, c.detail).toBeLessThanOrEqual(38)
      expect(c.note.length, c.note).toBeLessThanOrEqual(38)
    }
  })
})

describe('the walk: the doors in front of the aircraft', () => {
  const withDoors = ['doors', ...HANGAR_VIEWS] as const

  it('puts BACK on the aircraft step, reading THE HANGAR (DEV-858), where the room has doors', () => {
    expect(viewBehind('vehicles', withDoors)).toBe('doors')
    // The first step lost its START header in DEV-832, so the plate that returns
    // to it no longer says START.
    expect(backWordFor('vehicles', withDoors)).toBe('THE HANGAR')
    expect(plateAction(-1, 'vehicles', 1, withDoors)).toEqual({ kind: 'back' })
    // And on the doors themselves, nothing is behind.
    expect(plateAction(-1, 'doors', 1, withDoors)).toBeNull()
    // A room without doors is the room it was: no BACK on the aircraft.
    expect(plateAction(-1, 'vehicles', 1)).toBeNull()
  })

  it('backs Multiplayer’s step out to the doors', () => {
    expect(viewBehind('multiplayer', DOOR_VIEWS)).toBe('doors')
    expect(backWordFor('multiplayer', DOOR_VIEWS)).toBe(BACK_WORDS.doors)
  })
})

// ── a real room ─────────────────────────────────────────────────────────────

/** A 2d context that answers every call and measures every string as 10 px. */
const stubCanvas = (): void => {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    },
  )
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx }),
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
  stubCanvas()
})

const card = (id: string, vehicle: string, environment: string): MissionCard =>
  ({
    id,
    title: id,
    vehicle: vehicle as MissionCard['vehicle'],
    difficulty: 'beginner',
    chainIndex: null,
    environment,
    mode: 'ringAttack',
    vehicleName: vehicle,
    difficultyName: 'Beginner',
    modeName: 'Ring Attack',
    environmentName: environment,
    best: null,
    medal: null,
  }) satisfies MissionCard

const TWO = [card('hj_a', 'hoverjet', 'simonet'), card('js_a', 'jumpseat', 'alpine')]

const build = (doorInput: DoorInput = input()) => {
  const handed: string[] = []
  const room = createHangar({
    spec: SPEC,
    seed: 0x48414e47,
    title: '',
    subtitle: '',
    level: null,
    missions: TWO,
    currentId: 'hj_a',
    shapeFor: () => new Promise(() => {}),
    doors: (step: DoorStep) => doorStepCards(step, doorInput),
    onDoor: (id) => handed.push(id),
  })
  return { room, handed }
}

/** A head looking at the table at `bearing` (radians), from the seat. */
const lookAtBearing = (room: HangarArt, bearing: number): boolean => {
  room.object.updateWorldMatrix(true, true)
  const local = seatEyeLocal(SPEC)
  const from = new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(room.object.matrixWorld)
  const c = tableGazeLocal(SPEC, bearing)
  const to = new THREE.Vector3(c.x, c.y, c.z).applyMatrix4(room.object.matrixWorld)
  return room.gaze(from, to.sub(from))
}

/** Press door `id` on the step that is up: look at its table, then A. */
const pressDoor = (room: HangarArt, id: string): MissionCard | null => {
  const at = room.doors.findIndex((d) => d.id === id)
  expect(at, `the step offers ${id}`).toBeGreaterThanOrEqual(0)
  // The room's own layout for the step that is up (DEV-565: the doors are centred).
  expect(lookAtBearing(room, stepBearings(room.view, room.doors.length)[at] as number)).toBe(true)
  const aim = room.aim
  expect(aim?.kind === 'door' && aim.door.id, `the head is on ${id}`).toBe(id)
  return room.choose()
}

describe('a real room with doors', () => {
  it('opens on the doors, its first step, with BACK nowhere', () => {
    const { room } = build()
    expect(room.view).toBe('doors')
    expect(room.views[0]).toBe('doors')
    expect(ids(room.doors)).toEqual(['options', 'quick-race', 'single-player', 'multiplayer', 'tv'])
    expect(room.vehicle).toBeNull()
  })

  it('SINGLE PLAYER descends to the aircraft, and BACK comes back to the doors', () => {
    const { room, handed } = build()
    expect(pressDoor(room, DOOR.single), 'a door boards nothing').toBeNull()
    expect(room.view).toBe('vehicles')
    expect(room.views.slice(0, 2)).toEqual(['doors', 'vehicles'])
    expect(room.vehicles.map((v) => v.vehicle)).toEqual(['hoverjet', 'jumpseat'])
    room.goBack()
    expect(room.view).toBe('doors')
    expect(handed).toEqual([])
  })

  it('MULTIPLAYER descends to its own step; its choices are handed to the app', () => {
    const { room, handed } = build(input({ linkRoom: 'K7Q X4M2' }))
    expect(pressDoor(room, DOOR.multiplayer)).toBeNull()
    expect(room.view).toBe('multiplayer')
    expect(room.views).toEqual(['doors', 'multiplayer'])
    expect(ids(room.doors)).toEqual([DOOR.joinLink, DOOR.host, DOOR.joinCode])
    expect(pressDoor(room, DOOR.host)).toBeNull()
    expect(handed).toEqual([DOOR.host])
    room.goBack()
    expect(room.view).toBe('doors')
  })

  it('FF-TV is handed to the app, and the room stays where it is', () => {
    const { room, handed } = build()
    expect(pressDoor(room, DOOR.tv)).toBeNull()
    expect(handed).toEqual([DOOR.tv])
    expect(room.view).toBe('doors')
  })

  it('DEV-565: QUICK RACE is handed to the app, boards no table’s course, and the room stays', () => {
    const { room, handed } = build()
    expect(pressDoor(room, DOOR.quickRace), 'the race is the app’s draw').toBeNull()
    expect(handed).toEqual([DOOR.quickRace])
    expect(room.view).toBe('doors')
  })

  it('showDoors goes straight back to the first step from deep in the walk', () => {
    const { room } = build()
    pressDoor(room, DOOR.single)
    room.openVehicle(0)
    expect(room.view).not.toBe('doors')
    room.showDoors()
    expect(room.view).toBe('doors')
    expect(room.vehicle).toBeNull()
  })

  it('Matt, 2026-10-02: SINGLE PLAYER is under the resting pointer on three tables and on four', () => {
    // *"single player under the pointer"*. Four on every build since DEV-578;
    // three where a build has no TV. DEV-620's CREDITS stands first, off the
    // left end, and moves none of them.
    // DEV-858: arcs are symmetric about the eye line. All five doors: FLY is ON
    // it. Four (no TV): the line is between the middle two, FLY the right-middle,
    // which is the table the resting look takes (`REST_GAP_RADIUS`).
    for (const [over, offSteps] of [
      [{}, 0],
      [{ tv: false }, 0.5],
    ] as const) {
      const { room } = build(input(over))
      const at = stepBearings('doors', room.doors.length)
      const home = ids(room.doors).indexOf(DOOR.single)
      expect(home).toBe(2)
      expect(at[home]).toBeCloseTo(SEAT_REST_BEARING + offSteps * DOORS_BEARING_STEP, 9)
      expect(at[home - 1]).toBeCloseTo(SEAT_REST_BEARING + (offSteps - 1) * DOORS_BEARING_STEP, 9)
      // The resting look, pointing at the eye line itself, aims FLY.
      expect(lookAtBearing(room, SEAT_REST_BEARING), 'the resting look aims a table').toBe(true)
      expect(room.aim?.kind === 'door' && room.aim.door.id).toBe(DOOR.single)
    }
    // Two tables (no rooms, no TV): the home is the first, and SINGLE PLAYER leads.
    const two = doorCards(input({ rooms: false, tv: false }))
    expect(ids(two)[1]).toBe(DOOR.single)
    expect(stepBearings('doors', two.length)[1]).toBeCloseTo(SEAT_REST_BEARING, 9)
  })

  it('DEV-857/858: OPTIONS is the first table of the arc, in frame, and the door the app answers with the pause plate OPTIONS page', () => {
    // Matt, 2026-10-08: the options table shows the pause panel's OPTIONS page.
    // It does not descend a step: the app answers it, as it answers TV.
    expect(doorDescends(DOOR.options)).toBeNull()
    const { room, handed } = build()
    expect(pressDoor(room, DOOR.options)).toBeNull()
    expect(handed).toEqual([DOOR.options])
    expect(room.view).toBe('doors')
    // The five stand at -2, -1, 0, +1, +2 steps about the resting pointer: the
    // arc is even and OPTIONS is no longer 80 degrees off its end.
    const off = stepBearings('doors', 5).map((b) => ((b - SEAT_REST_BEARING) * 180) / Math.PI)
    expect(off.map((d) => Math.round(d))).toEqual([-46, -23, 0, 23, 46])
    // The CREDITS door and its step stay in the room's vocabulary, reached by the page now.
    expect(doorDescends(DOOR.credits)).toBe('credits')
    expect(BACK_WORDS.options).toBe('OPTIONS')
    expect(BACK_WORDS.credits).toBe('CREDITS')
  })

  it('DEV-606 met DEV-620: a new step starts the look where its arc is laid, so CREDITS opens on its first credit', () => {
    // DEV-606 rests the seat on a new step because a step lays its tables
    // around the resting look; CREDITS' step is laid from CREDITS' own bearing,
    // so a rest there opened it with the first credit 80 degrees to the left.
    // Turned by three's own rotation, not by a sign written down twice: the
    // resting sightline, yawed by the start, lands on the first credit.
    const look = (yaw: number): number => {
      const v = new THREE.Vector3(Math.sin(SEAT_REST_BEARING), 0, -Math.cos(SEAT_REST_BEARING))
      v.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      return Math.atan2(v.x, -v.z)
    }
    expect(look(stepStartYaw('credits'))).toBeCloseTo(stepBearings('credits', 4)[0] as number, 9)
    expect(stepStartYaw('options')).toBe(stepStartYaw('credits'))
    for (const view of [...HANGAR_VIEWS, 'doors', 'multiplayer'] as const)
      expect(stepStartYaw(view), view).toBe(0)
    expect(stepStartYaw(null)).toBe(0)
    // The room's rest reads it (`boot/app.ts`, the seat's look block).
    expect(appSourceThroughCtx()).toContain('seatLookYaw = stepStartYaw(seatKey, ')
  })

  it('DEV-620: the fifth table puts no lamp in the room, so the light count is the four tables’', () => {
    const { room } = build()
    const keys: string[] = []
    room.object.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight && o.name.startsWith('holotable-key-'))
        keys.push(o.name)
    })
    expect(keys.sort()).toEqual([
      'holotable-key-0',
      'holotable-key-1',
      'holotable-key-2',
      'holotable-key-3',
    ])
  })

  it('DEV-578: the doors are laid by tableBearings at their own 23 degrees, so FF-TV stands at +46, not +60', () => {
    // Matt, 2026-10-03: *"FF-TV - move to production"*: four tables on every
    // build. `hangar-tables.test.ts` measures why 23 against 2016's table (the
    // narrowest whole degree that keeps them apart) and the frame.
    expect(CENTRED_STEPS.has('doors')).toBe(false)
    // DEV-620: five with CREDITS first, off the left end; the four are DEV-578's.
    const off = stepBearings('doors', 5).map((b) => ((b - SEAT_REST_BEARING) * 180) / Math.PI)
    expect(off.slice(1).map((d) => Math.round(d))).toEqual([-23, 0, 23, 46])
    // Every other step keeps its 30 degrees, Multiplayer's included.
    const mp = stepBearings('multiplayer', 3).map((b) => ((b - SEAT_REST_BEARING) * 180) / Math.PI)
    expect(mp.map((d) => Math.round(d))).toEqual([-30, 0, 30])
    expect(TABLE_BEARING_STEP).toBeCloseTo(Math.PI / 6, 12)
  })

  it('DEV-578: looking between two doors still selects neither (a narrower dead band than 30 degrees gives)', () => {
    // The pitched sightlines to two neighbours' gaze centres, against the
    // window each centre is picked inside (`level-select.test.ts` has the
    // same measurement for the 30-degree steps, where it is 8.3 degrees).
    const eye = seatEyeLocal(SPEC)
    const dir = (b: number) => {
      const c = tableGazeLocal(SPEC, b)
      return new THREE.Vector3(c.x - eye.x, c.y - eye.y, c.z - eye.z)
    }
    const at = stepBearings('doors', 5)
    const a = dir(at[2] as number)
    const b = dir(at[3] as number)
    const apart = (a.angleTo(b) * 180) / Math.PI
    const window = (2 * Math.asin(GAZE_RADIUS / a.length()) * 180) / Math.PI
    expect(apart - window, 'dead band, degrees (1.9 at 23)').toBeGreaterThan(1.5)
    // And the room says so: half a step between SINGLE PLAYER and MULTIPLAYER aims nothing.
    const { room } = build()
    lookAtBearing(room, SEAT_REST_BEARING + DOORS_BEARING_STEP / 2)
    expect(room.aim).toBeNull()
  })

  it('a room built without doors opens on the aircraft, as it always did', () => {
    const room = createHangar({
      spec: SPEC,
      seed: 0x48414e47,
      title: '',
      subtitle: '',
      level: null,
      missions: TWO,
      currentId: 'hj_a',
      shapeFor: () => new Promise(() => {}),
    })
    expect(room.view).toBe('vehicles')
    expect(room.views[0]).toBe('vehicles')
    room.showDoors()
    expect(room.view).toBe('vehicles')
  })
})

describe('going back a step (DEV-605)', () => {
  it('says BACK TO over the step it goes to, so START reads as a way back', () => {
    expect(BACK_KICKER).toBe('BACK TO')
    const hangar = fs.readFileSync('src/render/hangar.ts', 'utf8')
    expect(hangar).toContain('paintPlate(plate.canvas, backWord(), BACK_KICKER)')
  })

  it("binds the room's goBack to the back press, with the plate it shares a press with read first", () => {
    const app = appSourceThroughCtx()
    expect(app).toContain('const codeWasUp = codeUp()')
    expect(app).toContain('hangar.goBack()')
    // The pad's B, the headset's B and Backspace, as the letter plate reads them.
    expect(app).toContain('const titleBack = backPressed(backSources, BACK_KEYS_BACKSPACE)')
  })
})

describe('a click or a tap on a table chooses it (DEV-604)', () => {
  it('aims the room through the point, for the free cursor and for a finger', () => {
    const app = appSourceThroughCtx()
    // The free cursor's click: the title's model (DEV-418), in its own slot.
    expect(app).toContain("mouseLook.setCursorTarget((x, y) => roomPointAim(x, y), 'room')")
    // A finger: the hangar asks the overlay for taps, and a tap aims and presses.
    expect(app).toMatch(/taps:\s*titleMenuUp\(\) \|\|\s*lapAskUp\(\) \|\|\s*roomTakesPoints\(\)/)
    // (DEV-884: it also marks the press as a point's, so a tap on a mark picks and stops.)
    expect(app).toContain('if (tapped !== null && roomPointAim(tapped.x, tapped.y)) {')
    expect(app).toContain('roomPointPress = true')
    // Aimed through the same picker the laser uses, then pressed by choose().
    expect(app).toContain('hangar.gaze(ray.origin, ray.direction)')
  })
})

describe('a new step starts the seat at rest (DEV-606)', () => {
  it('rests the look when the step changes and when the room comes back, flat only', () => {
    const app = appSourceThroughCtx()
    expect(app).toContain('if (!presenting && seatKey !== seatRestKey) {')
    expect(app).toContain('seatLookYaw = 0')
    expect(app).toContain('seatLookPitch = seatPitchLocal()')
    expect(app).toContain('} else seatRestKey = null')
  })
})

describe('a lesson rank boards from the rank (DEV-608)', () => {
  const card = (id: string) => ({ id }) as unknown as MissionCard

  it('boards the one lesson of a plan that teaches, and nothing else', () => {
    const lesson = (Object.keys(MODES) as GameMode[]).find((m) => MODES[m].teaches)
    const racing = (Object.keys(MODES) as GameMode[]).find((m) => !MODES[m].teaches)
    expect(lesson, 'the premise: a mode that teaches').toBeDefined()
    expect(racing).toBeDefined()
    if (!lesson || !racing) return
    expect(boardsFromRank({ mode: lesson, missions: [card('lesson_01_canyon')] })?.id).toBe(
      'lesson_01_canyon',
    )
    // Two lessons in a rank keep the PLACE step, to choose between them.
    expect(boardsFromRank({ mode: lesson, missions: [card('a'), card('b')] })).toBeNull()
    // A racing rank with one course keeps its PLACE step: the island, the best, the ghost.
    expect(boardsFromRank({ mode: racing, missions: [card('int_01_hoverJet')] })).toBeNull()
  })
})
