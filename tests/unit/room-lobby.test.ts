// A room's lobby and its start, as words and choices (DEV-389, plan/MULTIPLAYER.md
// §6.3, §6.9): the pure half of the lobby plates and the pad's banner.

import { describe, expect, it } from 'vitest'
import { roomPalette } from '@/game/remote-ships'
import {
  colourName,
  courseName,
  kickRowId,
  kickSlotOf,
  LOBBY_ACTION,
  LOBBY_KICK_HEADING,
  type LobbyInput,
  lobbyActionRows,
  lobbyEmptyStarts,
  lobbyEveryoneReady,
  lobbyHeading,
  lobbyKickOffered,
  lobbyKickRows,
  lobbyRosterHeading,
  lobbyRosterRows,
  lobbyRosterSelected,
  lobbyStartPress,
  nextFreeColour,
  ROOM_LISTED_DEFAULT,
  roomCodeText,
  roomCountdownStep,
  roomWaitingText,
  takenColours,
} from '@/game/room-lobby'
import type { RoomPlayerView, RoomRace, RoomSettings } from '@/net/room-protocol'
import { rowCentreLocalY, TOP_LOCAL_Y, WIDTH } from '@/render/pause'
import {
  LOBBY_BEARING_DEG,
  LOBBY_DISTANCE,
  LOBBY_SCALE,
  lobbyGapDeg,
  lobbyPlateOffset,
} from '@/render/room-lobby'
import { FIXED_DT } from '@/sim/constants'
import { createClock, stepFixed } from '@/sim/integrator'
import { createLaunch, type LaunchSpec, startLaunch, stepLaunch } from '@/sim/launch'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import { seeded } from './helpers/seeded'
import { loadLevelJson } from './helpers/terrain-field'

const race = (slots: number[]): RoomRace => ({
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  starts: Object.fromEntries(slots.map((slot, i) => [slot, i])),
  bots: [],
  colours: {},
})

describe('the pad’s banner while a room holds the start (§6.3 beat 2)', () => {
  it('counts the players on the grid who have loaded, out of the grid', () => {
    expect(roomWaitingText(race([0, 1, 2]), [], null)).toBe('WAITING FOR PLAYERS 0/3')
    expect(roomWaitingText(race([0, 1, 2]), [2, 0], null)).toBe('WAITING FOR PLAYERS 2/3')
    // A slot that loaded but is not on this race's grid does not count.
    expect(roomWaitingText(race([0, 2]), [1, 2], null)).toBe('WAITING FOR PLAYERS 1/2')
  })

  it('says GET READY once the room has released the field, and nothing with no race', () => {
    expect(roomWaitingText(race([0, 1]), [0], 123_456)).toBe('GET READY')
    expect(roomWaitingText(null, [], null)).toBeNull()
  })
})

describe('colours in words (§6.4)', () => {
  it('names every colour of both editions’ room palettes, each once', () => {
    for (const json of [anniversaryJson, classicJson]) {
      const livery = json.render.racerLivery as unknown as { palette: [number, number, number][] }
      const names = roomPalette(livery).map(colourName)
      expect(names[0]).toBe('orange') // the player's own panel comes first
      expect(new Set(names).size).toBe(names.length)
    }
    const names = roomPalette(
      anniversaryJson.render.racerLivery as unknown as { palette: [number, number, number][] },
    ).map(colourName)
    // The edition's own note names them in this order (DEV-350 follow-up).
    expect(names).toEqual(['orange', 'red', 'yellow', 'green', 'cyan', 'blue', 'violet'])
  })

  it('offers the next colour nobody else holds, wrapping, and keeps yours when none is free', () => {
    const view = (colour: number, present = true): RoomPlayerView => ({
      handle: 'x',
      variant: 'standard',
      colour,
      ready: false,
      joinSeq: 0,
      present,
    })
    const players = { 0: view(0), 1: view(2), 2: view(3, false) }
    const taken = takenColours(players, 0)
    // Your own colour is not "taken"; one held by a player who is away is not either.
    expect([...taken]).toEqual([2])
    expect(nextFreeColour(0, 7, taken)).toBe(1)
    expect(nextFreeColour(1, 7, taken)).toBe(3)
    expect(nextFreeColour(6, 7, taken)).toBe(0)
    expect(nextFreeColour(0, 2, new Set([1]))).toBe(0)
  })

  it('names a course without its vehicle, and leaves any other title alone', () => {
    expect(courseName('Intermediate 1 - HoverJet', 'hoverjet')).toBe('Intermediate 1')
    expect(courseName('Rookie 1 - JumpSeat', 'hoverjet')).toBe('Rookie 1 - JumpSeat')
    expect(courseName('Kauai', 'hoverjet')).toBe('Kauai')
  })

  it('writes a room id in fours, in capitals', () => {
    expect(roomCodeText('abcdefghijklmnop')).toBe('ABCD EFGH IJKL MNOP')
  })
})

const SETTINGS: RoomSettings = {
  mission: 'int_01_hoverJet',
  edition: 'anniversary',
  bots: false,
  seats: 6,
  colours: 7,
  countdown: 4000,
  timeLimit: 180_000,
  rules: { standard: '1.aaaaaaaa' },
}
const player = (handle: string, colour: number, ready = false): RoomPlayerView => ({
  handle,
  variant: 'standard',
  colour,
  ready,
  joinSeq: colour,
  present: true,
})
const input = (over: Partial<LobbyInput> = {}): LobbyInput => ({
  status: 'open',
  notice: null,
  slot: 0,
  owner: 0,
  phase: 'lobby',
  settings: SETTINGS,
  players: { 0: player('Swift Kestrel 42', 0, true), 1: player('Steady Heron 17', 4) },
  race: null,
  results: [],
  courseName: 'Intermediate 1',
  colourNames: ['orange', 'red', 'yellow', 'green', 'cyan', 'blue', 'violet'],
  cannotRace: null,
  copied: false,
  ...over,
})
const ids = (rows: { id: string }[]) => rows.map((r) => r.id)

describe('the action plate (§6.9)', () => {
  it('gives the owner START and everyone else the same rows without it', () => {
    expect(ids(lobbyActionRows(input()))).toEqual([
      LOBBY_ACTION.course,
      // DEV-633: the owner's PUBLIC or PRIVATE.
      LOBBY_ACTION.listed,
      LOBBY_ACTION.bots,
      LOBBY_ACTION.colour,
      LOBBY_ACTION.ready,
      LOBBY_ACTION.start,
      // DEV-459: the owner's, with somebody to remove.
      LOBBY_ACTION.kick,
      LOBBY_ACTION.invite,
      LOBBY_ACTION.spectate,
      LOBBY_ACTION.leave,
    ])
    expect(ids(lobbyActionRows(input({ slot: 1 })))).not.toContain(LOBBY_ACTION.start)
    expect(ids(lobbyActionRows(input({ slot: 1 })))).not.toContain(LOBBY_ACTION.listed)
  })

  // DEV-633.
  it('says whether the room is PUBLIC or PRIVATE, private by default', () => {
    expect(ROOM_LISTED_DEFAULT).toBe(false)
    const row = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.listed)
    expect(row(input())?.value).toBe('private')
    const settings = input().settings
    if (!settings) throw new Error('the fixture has settings')
    expect(row(input({ settings: { ...settings, listed: true } }))?.value).toBe('public')
  })

  // DEV-459. Each claim red against the row it guards removed or offered to all.
  it('offers REMOVE A PLAYER to the owner only, in the lobby only, with somebody to remove', () => {
    const offered = (i: LobbyInput) => ids(lobbyActionRows(i)).includes(LOBBY_ACTION.kick)
    expect(offered(input())).toBe(true)
    expect(lobbyKickOffered(input())).toBe(true)
    expect(offered(input({ slot: 1 })), 'not to a guest').toBe(false)
    expect(offered(input({ players: { 0: player('Alone', 0) } })), 'nobody to remove').toBe(false)
    const race = {
      mission: 'int_01_hoverJet',
      edition: 'anniversary',
      starts: {},
      bots: [],
      colours: {},
    }
    expect(offered(input({ phase: 'racing', race })), 'not in a race').toBe(false)
    // And the page itself closes if a race starts while it is up (app.ts asks this).
    expect(lobbyKickOffered(input({ phase: 'racing', race })), 'the page, in a race').toBe(false)
    expect(offered(input({ status: 'closed' })), 'not in a closed room').toBe(false)
  })

  it('lists every other present player on its page, with Back, and arms before it removes', () => {
    const three = input({
      players: {
        0: player('Noble Condor 11', 0, true),
        1: player('Keen Gannet 22', 1),
        3: { ...player('Lucky Tern 44', 3), present: false },
        4: player('Amber Raven 55', 4),
      },
    })
    const rows = lobbyKickRows(three, null)
    expect(ids(rows)).toEqual([kickRowId(1), kickRowId(4), LOBBY_ACTION.kickBack])
    expect(rows.map((r) => r.label)).toEqual(['Keen Gannet 22', 'Amber Raven 55', 'Back'])
    expect(rows[0]?.note).toBe('press twice to remove them')
    const armed = lobbyKickRows(three, 4)
    expect(armed[1]?.note).toBe('press again to remove them')
    expect(armed[1]?.value).toBe('sure?')
    expect(armed[1]?.accentNote).toBe(true)
    expect(armed[0]?.value).toBeUndefined()
    expect(kickSlotOf(kickRowId(4))).toBe(4)
    expect(kickSlotOf(LOBBY_ACTION.kickBack)).toBeNull()
    expect(kickSlotOf(undefined)).toBeNull()
    expect(LOBBY_KICK_HEADING).toBe('- REMOVE A PLAYER -')
  })

  it('says what START waits for, and lights it only when everyone is ready', () => {
    const start = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.start)
    expect(start(input())?.note).toBe('waiting for 1 to be ready')
    expect(start(input())?.accentNote).toBe(false)
    const all = input({ players: { 0: player('A', 0, true), 1: player('B', 4, true) } })
    expect(start(all)?.accentNote).toBe(true)
    expect(start(input({ settings: null }))?.note).toBe('choose a course first')
  })

  // DEV-587. Matt, 2026-10-03: "can't start the multiplayer room and have it
  // fill empty seats with bots". Alone in the room the owner was the one
  // player START waited for, and the row said "waiting for 1 to be ready"
  // while a press did nothing. Red against the rows before: the alone note
  // was that line, unlit, and there was no press to read.
  describe('DEV-587: START with empty seats', () => {
    const start = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.start)
    const alone = (over: Partial<LobbyInput> = {}, ready = false, bots = true) =>
      input({ players: { 0: player('A', 0, ready) }, settings: { ...SETTINGS, bots }, ...over })

    it('starts a room of one, and says the AI racers fill the empty starts', () => {
      expect(lobbyStartPress(alone()), 'one press readies the owner and starts').toBe(
        'ready-and-start',
      )
      expect(lobbyStartPress(alone({}, true))).toBe('start')
      expect(start(alone())?.note).toBe('press to race: AI racers fill the 5 empty starts')
      expect(start(alone())?.accentNote).toBe(true)
      expect(start(alone({}, true))?.note).toBe('press to race: AI racers fill the 5 empty starts')
      expect(lobbyEmptyStarts(alone())).toBe(5)
    })

    it('says a room of one with Bots off races on its own, and still starts', () => {
      expect(start(alone({}, false, false))?.note).toBe('press to race on your own (Bots is off)')
      expect(lobbyStartPress(alone({}, false, false))).toBe('ready-and-start')
    })

    it('counts only the OTHER players START waits for; the press readies the owner', () => {
      // The owner ready, the guest not: as before.
      expect(lobbyStartPress(input())).toBeNull()
      expect(start(input())?.note).toBe('waiting for 1 to be ready')
      // The guest ready, the owner not: START is the owner's ready.
      const guestReady = input({ players: { 0: player('A', 0), 1: player('B', 4, true) } })
      expect(lobbyStartPress(guestReady)).toBe('ready-and-start')
      expect(start(guestReady)?.note).toBe('Everyone is ready: press START')
      expect(start(guestReady)?.accentNote).toBe(true)
      // Both, bots on: the empty starts said.
      const both = input({
        players: { 0: player('A', 0, true), 1: player('B', 4, true) },
        settings: { ...SETTINGS, bots: true },
      })
      expect(lobbyStartPress(both)).toBe('start')
      expect(start(both)?.note).toBe('Everyone is ready: press START, AI racers fill 4 starts')
      // Bots off with company: the line it always was.
      const bothOff = input({ players: { 0: player('A', 0, true), 1: player('B', 4, true) } })
      expect(start(bothOff)?.note).toBe('Everyone is ready: press START')
    })

    // DEV-634: Matt could not find START once everybody was ready.
    it('once everyone is ready, START pulses on the beat; before, it never does', () => {
      const ready = { 0: player('A', 0, true), 1: player('B', 4, true) }
      expect(lobbyEveryoneReady(input({ players: ready }))).toBe(true)
      expect(start(input({ players: ready, pulse: true }))?.accentNote).toBe(true)
      expect(start(input({ players: ready, pulse: false }))?.accentNote).toBe(false)
      // Waiting for somebody: not "everyone", and no pulse whatever the beat.
      expect(lobbyEveryoneReady(input())).toBe(false)
      expect(start(input({ pulse: true }))?.accentNote).toBe(false)
      // Alone: lit and still, as DEV-587 left it; nobody else to be ready.
      expect(lobbyEveryoneReady(alone({}, true))).toBe(false)
      expect(start(alone({ pulse: false }, true))?.accentNote).toBe(true)
      // A guest never has it.
      expect(lobbyEveryoneReady(input({ slot: 1, players: ready }))).toBe(false)
    })

    it('one empty start is said in the singular', () => {
      const five = Object.fromEntries(
        [0, 1, 2, 3, 4].map((s) => [s, player(`P${s}`, s, true)]),
      ) as Record<number, RoomPlayerView>
      const row = start(input({ players: five, settings: { ...SETTINGS, bots: true } }))
      expect(row?.note).toBe('Everyone is ready: press START, an AI racer fills 1 start')
    })

    it('presses nothing for a guest, before a course, or for an owner who cannot race', () => {
      const guest = input({ slot: 1, players: { 0: player('A', 0, true), 1: player('B', 4) } })
      expect(lobbyStartPress(guest), 'a guest, everyone else ready').toBeNull()
      expect(lobbyStartPress(alone({ settings: null }))).toBeNull()
      const cannot = alone({ cannotRace: 'your glider jet cannot race here' })
      expect(lobbyStartPress(cannot)).toBeNull()
      expect(start(cannot)?.note).toBe('your glider jet cannot race here')
      expect(start(cannot)?.accentNote).toBe(false)
      // Ready already, a reason not to be ready does not stop the start.
      expect(lobbyStartPress(alone({ cannotRace: 'x' }, true))).toBe('start')
    })

    it('says what Bots does in words, and an open seat names who flies it', () => {
      const bots = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.bots)
      expect(bots(alone())?.value).toBe('on')
      expect(bots(alone())?.note).toBe('AI racers fill the empty starts: press for none')
      expect(bots(alone({}, false, false))?.note).toBe(
        'the empty starts stay empty: press for AI racers',
      )
      expect(bots(input({ slot: 1 }))?.note).toBe('the owner chooses')
      expect(lobbyRosterRows(alone()).at(-1)?.note).toBe('an AI racer flies it')
    })
  })

  // DEV-441b. Red against the row before it: the code was only in the roster's
  // small footer, and a friend in a headset had nothing to type.
  it('shows a short code LARGE on the invite row, beside the link it copies', () => {
    const invite = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.invite)
    expect(invite(input({ code: 'K7QX4MN' }))?.value).toBe('K7Q X4MN')
    expect(invite(input({ code: 'K7QX4MN' }))?.note).toMatch(/code/)
    expect(invite(input({ code: 'K7QX4MN', copied: true }))?.note).toMatch(/link copied/)
    // A room joined by a long id from an older link: the row as it was.
    expect(invite(input())?.value).toBeUndefined()
    expect(invite(input({ code: null }))?.note).toBe('press to copy the link')
  })

  // DEV-632: the row says what its press does on this device.
  it('is SHARE on a phone, COPY LINK on a computer, INVITE in a headset; the code stays on it', () => {
    const invite = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.invite)
    const share = invite(input({ code: 'K7QX4MN', invite: 'share' }))
    expect(share?.label).toBe('Share')
    expect(share?.value).toBe('K7Q X4MN')
    expect(share?.note).toBe('press to send the link, or read them the code')
    expect(invite(input({ code: 'K7QX4MN', invite: 'share', shared: true }))?.note).toBe(
      'link sent',
    )
    // A phone with no share sheet copies instead, and says so.
    expect(invite(input({ code: 'K7QX4MN', invite: 'share', copied: true }))?.note).toMatch(
      /link copied/,
    )
    const copy = invite(input({ code: 'K7QX4MN', invite: 'copy' }))
    expect(copy?.label).toBe('Copy Link')
    expect(copy?.note).toBe('press to copy the link, or read them the code')
    expect(invite(input({ code: 'K7QX4MN', invite: 'copy', copied: true }))?.note).toMatch(
      /link copied/,
    )
    expect(invite(input({ code: 'K7QX4MN' }))?.label).toBe('Invite')
  })

  it('names your colour, and says why you cannot be ready when you cannot', () => {
    const rows = lobbyActionRows(input({ slot: 1, cannotRace: 'this room races Anniversary' }))
    expect(rows.find((r) => r.id === LOBBY_ACTION.colour)?.value).toBe('cyan')
    expect(rows.find((r) => r.id === LOBBY_ACTION.ready)?.note).toBe('this room races Anniversary')
  })

  it('is one LEAVE row saying why when the room has closed, and while it connects', () => {
    const closed = lobbyActionRows(input({ status: 'closed', notice: 'That room is full.' }))
    expect(closed).toEqual([expect.objectContaining({ id: 'leave', note: 'That room is full.' })])
    expect(lobbyHeading(input({ status: 'closed' }))).toBe('- ROOM CLOSED -')
    const connecting = lobbyActionRows(input({ status: 'connecting', slot: null }))
    expect(ids(connecting)).toEqual([LOBBY_ACTION.leave])
  })

  it('waits while the race is on, counting who is still flying', () => {
    const on = input({
      phase: 'loading',
      race: race([0, 1]),
      results: [
        {
          slot: 0,
          verdict: 'left',
          ticks: null,
          seconds: null,
          rings: 0,
          ringsTotal: 0,
          score2016: null,
          tainted: false,
          variant: 'standard',
        },
      ],
    })
    expect(lobbyHeading(on)).toBe('- RACE ON -')
    const rows = lobbyActionRows(on)
    expect(ids(rows)).toEqual([LOBBY_ACTION.wait, LOBBY_ACTION.leave])
    expect(rows[0]?.note).toBe('1 still flying')
    expect(lobbyRosterRows(on).map((r) => r.value ?? '')).toEqual([
      'left',
      'flying',
      '',
      '',
      '',
      '',
    ])
  })
})

// DEV-480 (docs/plan/FF-TV.md §2.1, §2.6): where the build has TV, WATCH ME
// under Spectators, the players told their races are on TV without names or
// the code, and a link that follows them. Shown red before the row.
describe('DEV-480: WATCH ME', () => {
  const watchMe = (i: LobbyInput) => lobbyActionRows(i).find((r) => r.id === LOBBY_ACTION.watchMe)

  it('sits under Spectators where the build has TV, and nowhere else', () => {
    const rows = ids(lobbyActionRows(input({ tv: true })))
    expect(rows.indexOf(LOBBY_ACTION.watchMe)).toBe(rows.indexOf(LOBBY_ACTION.spectate) + 1)
    expect(rows.at(-1)).toBe(LOBBY_ACTION.leave)
    expect(ids(lobbyActionRows(input()))).not.toContain(LOBBY_ACTION.watchMe)
    expect(ids(lobbyActionRows(input({ tv: false })))).not.toContain(LOBBY_ACTION.watchMe)
  })

  it('tells the players the race is on TV without names or the code, then what the press did', () => {
    expect(watchMe(input({ tv: true }))?.note).toBe(
      'on TV too, no names or code: press for your link',
    )
    const link = 'ff-10yr.pages.dev/tv/tv_abcdefghijklmnop?follow=1'
    expect(watchMe(input({ tv: true, watchMe: { link, shown: false } }))?.note).toBe(
      'TV link copied: it follows you, no names',
    )
    // A headset pastes nothing: the link itself, to read off the plate.
    expect(watchMe(input({ tv: true, watchMe: { link, shown: true } }))?.note).toBe(link)
    expect(watchMe(input({ tv: true, watchMe: { link: null, shown: false } }))?.note).toBe(
      'TV could not be reached for a link',
    )
  })
})

describe('the roster (§6.9): every seat of the grid', () => {
  it('lists the players by slot, then the open seats up to the course’s seats', () => {
    const rows = lobbyRosterRows(input())
    expect(rows).toHaveLength(SETTINGS.seats)
    expect(rows.slice(0, 2).map((r) => [r.label, r.value, r.note])).toEqual([
      ['Swift Kestrel 42', 'ready', 'orange · owner · you'],
      ['Steady Heron 17', '', 'cyan'],
    ])
    expect(rows.slice(2).every((r) => r.label === 'Open seat')).toBe(true)
    expect(lobbyRosterHeading(input())).toBe('- PLAYERS 2/6 -')
    // It highlights YOU, which is what paints its footer (the room code).
    expect(lobbyRosterSelected(rows, 1)).toBe(1)
    expect(lobbyRosterSelected(rows, null)).toBe(-1)
  })
})

describe('where the lobby stands (render/room-lobby.ts)', () => {
  it('puts the plates either side of straight ahead, apart, and below the eye', () => {
    // The head's resting ray lands between them: a row is taken only when looked at.
    expect(lobbyGapDeg()).toBeGreaterThan(2)
    const [rx, ry, rz] = lobbyPlateOffset(LOBBY_BEARING_DEG.roster)
    const [ax, ay, az] = lobbyPlateOffset(LOBBY_BEARING_DEG.actions)
    expect(rx).toBeLessThan(0) // roster on the viewer's left
    expect(ax).toBeGreaterThan(0)
    expect(rz).toBeLessThan(0)
    expect(az).toBeLessThan(0)
    // The top edge below the eye line, so the heading, not a row, is nearest it.
    const top = ay + TOP_LOCAL_Y * LOBBY_SCALE
    expect(top).toBeLessThan(0)
    expect(ry).toBe(ay)
    // And the first row is within a comfortable look down: under 25 degrees.
    const firstRow = ay + rowCentreLocalY(0, 6) * LOBBY_SCALE
    expect((Math.atan(-firstRow / LOBBY_DISTANCE) * 180) / Math.PI).toBeLessThan(25)
    expect(WIDTH * LOBBY_SCALE).toBeLessThan(LOBBY_DISTANCE)
  })
})

// ── One countdown, released at the room's GO (§6.3 beat 3) ─────────────────
//
// The app's own order, with the real stepper and the real launch: a frame
// reads the room's time, then `stepFixed` runs the steps that frame owes, and
// each step stands for the frame's time less what is still unspent. The room
// clock is taken as exact here: its error is the clock sync's, measured in
// `room-clock.test.ts`, and it adds to every client alike.
describe('the countdown lets go on the room’s GO, within one step (§6.3 beat 3)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: the level JSON is the truth and the types lag it
  const lvl: any = loadLevelJson('int_01_hoverJet')
  const spec: LaunchSpec = {
    keys: lvl.spawn.launch.keys,
    releaseAtSeconds: lvl.spawn.launch.releaseAtSeconds,
    countdownSteps: lvl.timer.countdown?.steps ?? 0,
    countdownStepSeconds: lvl.timer.countdown?.stepSeconds ?? 0,
    // A room never rides the lift (§11 call 2).
    skipRide: true,
  }
  const countdownMs = (spec.countdownSteps + 1) * spec.countdownStepSeconds * 1000
  const STEP_MS = FIXED_DT * 1000

  /** mulberry32: frame times that are the same on every run. */
  const frames = (seed: number, lo: number, hi: number) => {
    const next = seeded(seed)
    return () => lo + next() * (hi - lo)
  }

  /**
   * Fly one start; the room time the RELEASE step stands for, less `goAt`.
   * `how` is when the countdown starts: on its step (the build), on the
   * frame with the frame's lateness as spill (DEV-388's first cut), or when
   * `start` arrives (the naive one the plan names as the red). `phase`
   * moves the first frame, so the steps fall on every part of the GO's step.
   */
  const release = (
    goAt: number,
    frameMs: () => number,
    how: 'step' | 'frame' | 'arrival',
    arrival = 0,
    phase = 0,
  ): number => {
    const clock = createClock()
    const launch = createLaunch(spec)
    const begin = goAt - countdownMs
    let room = arrival - 50 - phase
    for (let frame = 0; frame < 5000; frame++) {
      const dt = frameMs()
      room += dt
      const at = room
      if (launch.phase === 'waiting' && how === 'frame' && at >= begin) {
        startLaunch(launch, spec)
        launch.countdownElapsed = (at - begin) / 1000
      }
      if (launch.phase === 'waiting' && how === 'arrival' && at >= arrival)
        startLaunch(launch, spec)
      let out: number | null = null
      stepFixed(clock, dt / 1000, (step) => {
        const stepRoom = at - clock.accumulator * 1000
        if (launch.phase === 'waiting' && how === 'step') {
          const elapsed = roomCountdownStep(stepRoom, goAt, countdownMs, step)
          if (elapsed !== null) {
            startLaunch(launch, spec)
            launch.countdownElapsed = elapsed
          }
        }
        if (stepLaunch(launch, spec, step) && out === null) out = stepRoom
      })
      if (out !== null) return out - goAt
    }
    throw new Error('never released')
  }

  it('releases on the first step at or past GO, for any frame timing and any GO', () => {
    expect(countdownMs).toBeGreaterThan(0)
    let worst = 0
    for (let trial = 0; trial < 400; trial++) {
      const next = frames(trial + 1, 4, 60)
      const goAt = 100_000 + trial * 37.123
      const late = release(
        goAt,
        next,
        'step',
        goAt - countdownMs - 1000,
        (trial * 0.0611) % STEP_MS,
      )
      expect(late, `trial ${trial}`).toBeGreaterThanOrEqual(0)
      expect(late, `trial ${trial}`).toBeLessThan(STEP_MS)
      worst = Math.max(worst, late)
    }
    expect(worst).toBeGreaterThan(STEP_MS / 2) // the sweep reaches the far end of the bound
  })

  it('is RED started at the frame with its spill: up to a frame early', () => {
    let early = 0
    for (let trial = 0; trial < 400; trial++) {
      const goAt = 100_000 + trial * 37.123
      const late = release(
        goAt,
        frames(trial + 1, 4, 60),
        'frame',
        goAt - countdownMs - 1000,
        (trial * 0.0611) % STEP_MS,
      )
      early = Math.min(early, late)
    }
    expect(early).toBeLessThan(-STEP_MS)
  })

  it('is RED started on the start message’s arrival: a whole margin early', () => {
    const goAt = 100_000
    // The room sends `start` a countdown plus ROOM_START_MARGIN_MS ahead of GO.
    const late = release(goAt, frames(7, 11, 22), 'arrival', goAt - countdownMs - 1000)
    expect(late).toBeLessThan(-900)
  })
})
