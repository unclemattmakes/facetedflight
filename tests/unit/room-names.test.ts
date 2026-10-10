// DEV-485: a room's names come from the handle list, on every client that
// draws one (plan/FF-TV.md §2.5, DEV-485).
//
// Until DEV-850 the room admitted any name of a loose shape (a letter or
// digit, then up to 39 letters, digits and spaces), so the list was checked
// where a name is DRAWN, and until DEV-485 nothing checked it there. DEV-850
// closed the door at the room too (`parseClientMessage` refuses a handle the
// lists did not generate); this file keeps the draw-side rule, which still
// covers a room that has not been redeployed. D30: generated names only.
//
// Three parts. The rule itself; every surface that draws a room's name, fed a
// name the room admits and the list refuses; and a sweep over `src/` for a
// room player's `.handle` read anywhere that does not go through the rule —
// the next surface somebody writes (the pattern of `xr-eye-layers.test.ts`).

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { createRemoteShips } from '@/game/remote-ships'
import { type LobbyInput, lobbyKickRows, lobbyRosterRows } from '@/game/room-lobby'
import { drawnHandle } from '@/game/room-names'
import { roomOpponents, roomStandingOf } from '@/game/room-results'
import { isHandle } from '@/net/handles'
import {
  parseClientMessage,
  ROOM_PROTOCOL,
  type RoomPlayerView,
  type RoomSettings,
} from '@/net/room-protocol'
import type { RoomSession } from '@/net/room-session'
import { APP_ENTRY, appFiles } from './helpers/app-source'
import { listTsWithDts } from './helpers/source-tree'

/** A name the LIST refuses (a protocol-8 room admitted it; DEV-850's room does not). */
const FREE_TEXT = 'Anything At All 99'
/** A handle the lists generate. */
const LISTED = 'Swift Kestrel 42'

describe('the rule', () => {
  it('rests on a name the list refuses, and the room refuses it too (DEV-850)', () => {
    expect(isHandle(FREE_TEXT), 'the list refuses it').toBe(false)
    expect(isHandle(LISTED)).toBe(true)
    const join = (handle: string) =>
      JSON.stringify({
        type: 'join',
        protocol: ROOM_PROTOCOL,
        handle,
        variant: 'standard',
        colour: 0,
        content: 'aaaaaaaa',
      })
    expect(parseClientMessage(join(LISTED))?.type).toBe('join')
    expect(parseClientMessage(join(FREE_TEXT)), 'free text is refused by the room').toBeNull()
    expect(parseClientMessage(join('<b>x</b>'))).toBeNull()
    expect(parseClientMessage(join('Swift Kestrel 4'))).toBeNull()
  })

  it('draws a listed handle as itself, and anything else as Racer N (slot + 1)', () => {
    expect(drawnHandle(LISTED, 0)).toBe(LISTED)
    expect(drawnHandle(FREE_TEXT, 0)).toBe('Racer 1')
    expect(drawnHandle(FREE_TEXT, 4)).toBe('Racer 5')
    // The room's shape check is not the only thing between a socket and a
    // screen: a player who has left, or a message nobody validated.
    expect(drawnHandle(undefined, 2)).toBe('Racer 3')
    expect(drawnHandle(null, 2)).toBe('Racer 3')
    expect(drawnHandle(42, 1)).toBe('Racer 2')
    expect(drawnHandle('', 1)).toBe('Racer 2')
    // A listed handle with the case changed is not on the list.
    expect(drawnHandle(LISTED.toUpperCase(), 0)).toBe('Racer 1')
  })
})

// ── Every surface ───────────────────────────────────────────────────────────

const view = (handle: string, colour: number, present = true): RoomPlayerView => ({
  handle,
  variant: 'standard',
  colour,
  ready: false,
  joinSeq: colour,
  present,
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

const lobby = (players: Record<number, RoomPlayerView>): LobbyInput => ({
  status: 'open',
  notice: null,
  slot: 0,
  owner: 0,
  phase: 'lobby',
  settings: SETTINGS,
  players,
  race: null,
  results: [],
  courseName: 'Intermediate 1',
  colourNames: ['orange', 'red', 'yellow', 'green', 'cyan', 'blue', 'violet'],
  cannotRace: null,
  copied: false,
})

describe('every surface that draws a room name', () => {
  const players = { 0: view(LISTED, 0), 2: view(FREE_TEXT, 2) }

  it('the lobby roster', () => {
    const rows = lobbyRosterRows(lobby(players))
    expect(rows.find((r) => r.id === 'seat-0')?.label).toBe(LISTED)
    expect(rows.find((r) => r.id === 'seat-2')?.label).toBe('Racer 3')
    expect(JSON.stringify(rows)).not.toContain(FREE_TEXT)
  })

  it("the owner's REMOVE A PLAYER page", () => {
    const rows = lobbyKickRows(lobby(players), null)
    expect(rows[0]?.label).toBe('Racer 3')
    expect(JSON.stringify(rows)).not.toContain(FREE_TEXT)
  })

  it('the results panel', () => {
    const room = {
      slot: 0,
      players,
      race: {
        mission: 'int_01_hoverJet',
        edition: 'anniversary',
        starts: { 0: 0, 2: 1 },
        bots: [],
        colours: { 0: 0, 2: 2 },
      },
      results: [],
    }
    expect(roomStandingOf(room, 2).name).toBe('Racer 3')
    expect(roomStandingOf(room, 0).name).toBe(LISTED)
    expect(JSON.stringify(roomOpponents(room))).not.toContain(FREE_TEXT)
  })

  it("the others' ships: the name tag, the probe's report and the viewer's director", async () => {
    // The hull loads from the network and fails in node; the ship and its
    // handle exist before it does, and the tag is painted from that handle.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = {
      rosterVersion: 1,
      slot: 0,
      owner: 0,
      race: null,
      players,
      track: () => undefined,
    } as unknown as RoomSession
    const ships = createRemoteShips({
      worldOffset: [0, 0, 0],
      edition: { current: { render: { racerLivery: { palette: [] } } } } as never,
      session,
      now: () => 0,
    })
    ships.sync()
    const report = ships.report()
    expect(report.map((r) => [r.slot, r.handle])).toEqual([[2, 'Racer 3']])
    ships.group.traverse((o) => {
      if (o.name === 'room-ship:2') o.visible = true
    })
    expect(ships.follow(0, new THREE.Vector3(), new THREE.Quaternion())).toBe('Racer 3')
    await new Promise((r) => setTimeout(r, 0))
    ships.dispose()
    warn.mockRestore()
  })
})

// ── The sweep ───────────────────────────────────────────────────────────────

/**
 * A `.handle` read on something that is a ROOM player: a `RoomPlayerView` out
 * of `players`, the session's own roster, or a join. Lap handles (`state.lap`,
 * `share`, a ghost's) are the lap server's and are checked by it.
 *
 * Every file under `src/` outside the wire (`src/net/`, which carries and
 * checks the SHAPE and draws nothing) that reads a room roster must route each
 * name through `drawnHandle`. A file is room-aware if it reads `.players`;
 * inside one, each `.handle` read must be on a line that calls `drawnHandle`,
 * or on a receiver listed here with the reason it is not a room name.
 */
const NOT_A_ROOM_NAME: Record<string, readonly string[]> = {
  // `Ship.handle` is written once, from `drawnHandle` (players) or the host's
  // own bot names (`botName`, the game's tuning names): it is already drawn.
  'src/game/remote-ships.ts': ['ship'],
  // `drawn` is a `RemoteShipReport` (DEV-537's `__ff2perf.room()`), whose
  // handle is `Ship.handle`: drawn already. Every other `.handle` in app.ts is
  // a LAP's (the lap server checks those with `isHandle`). Keyed by the entry,
  // and applied to every file of the boot tree, so the list follows the code
  // when the app-split moves it (APP-SPLIT phase 0).
  [APP_ENTRY]: [
    'drawn',
    'lapRun.ghost',
    'share',
    'state.lap',
    'r.lap',
    'run',
    'linkGhost',
    'racing',
    'ghost',
    'lap',
  ],
}

describe('the sweep', () => {
  const root = join(__dirname, '..', '..')
  const files = listTsWithDts(join(root, 'src'))
    .map((p) => relative(root, p).split('\\').join('/'))
    .filter((p) => !p.startsWith('src/net/') && p !== 'src/game/room-names.ts')

  it('finds the room-aware files it is meant to guard', () => {
    // A sweep that matches nothing passes for ever. These three draw room
    // names today; if one stops reading `.players` the sweep's premise moved.
    const aware = files.filter((f) => /\.players\b/.test(readFileSync(join(root, f), 'utf8')))
    for (const f of [
      'src/game/room-lobby.ts',
      'src/game/room-results.ts',
      'src/game/remote-ships.ts',
    ]) {
      expect(aware, f).toContain(f)
    }
  })

  it("draws no room player's handle except through drawnHandle", () => {
    const appTree = new Set(appFiles().map((a) => a.file))
    const offenders: string[] = []
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8')
      if (!/\.players\b/.test(text)) continue
      const allowed =
        NOT_A_ROOM_NAME[f] ?? (appTree.has(f) ? NOT_A_ROOM_NAME[APP_ENTRY] : undefined) ?? []
      text.split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        for (const m of code.matchAll(/([\w.?[\]]+?)\??\.handle\b/g)) {
          const receiver = (m[1] as string).replace(/\?$/, '')
          if (code.includes('drawnHandle(')) continue
          if (allowed.includes(receiver)) continue
          offenders.push(`${f}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
