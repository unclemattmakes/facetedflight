// tests/unit/run-taint.test.ts — DEV-371: D30's runTainted, the URL's half.
//
// The rule under test is the SHAPE of the list: presentation switches are
// allowed by name and everything else taints, including a switch nobody has
// written yet. So the cases that matter are a switch the plan named as
// changing the game, a switch that does not exist today, and an allowlisted
// name that is not really a switch (a typo would silently leave the real one
// tainting, which is safe, or — worse — list a name nothing reads while the
// switch it meant stays free to change the game under another spelling).

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createRunTaint,
  isPresentationSwitch,
  isTainted,
  PRESENTATION_SWITCHES,
  ROOM_SWITCH,
  ROOM_TAINT,
  resetRunTaint,
  taintedInRoom,
  taintRun,
  urlTaint,
} from '@/game/run-taint'
import { listTsWithDts } from './helpers/source-tree'

describe('the URL', () => {
  it('is clean with no switches, and with only the pins the harness and a player use', () => {
    expect(urlTaint('')).toEqual([])
    expect(urlTaint('?xr=off&adaptive=0&quality=high')).toEqual([])
    expect(urlTaint('?mission=int_01_hoverJet&edition=classic&perf=1&camera=third')).toEqual([])
  })

  it('taints on every switch PLAYER-GHOSTS §5 names as changing the game', () => {
    for (const name of ['props', 'mode', 'feature', 'opponents', 'snap', 'lookdev', 'autopilot']) {
      expect(urlTaint(`?${name}=1`), name).toEqual([`?${name}`])
      expect(isPresentationSwitch(name), name).toBe(false)
    }
    // And the autopilot's own route guidance, which the racers read too.
    expect(urlTaint('?guide=off')).toEqual(['?guide'])
  })

  it('is clean when opened from a shared lap’s link: a ghost cannot move your lap (DEV-373)', () => {
    // Were it to taint, every lap raced from a link — the one lap a link
    // exists to provoke — could never be shared back.
    expect(urlTaint('?ghost=AbCdEf1234')).toEqual([])
    expect(isPresentationSwitch('ghost')).toBe(true)
  })

  it('taints a room lap ON PURPOSE, under its own reason (DEV-390, MULTIPLAYER §11 call 10)', () => {
    // Off the solo boards: a room has no racer contact and a row start.
    expect(isPresentationSwitch(ROOM_SWITCH)).toBe(false)
    expect(urlTaint('?room=abc123&xr=off')).toEqual([ROOM_TAINT])
    expect(urlTaint('?room=abc123&autopilot=1')).toEqual(['?autopilot', ROOM_TAINT])
    // And the room's own "assisted" mark leaves that reason out: every lap in
    // a room carries it, and it says nothing about how the lap was flown.
    expect(taintedInRoom([ROOM_TAINT])).toBe(false)
    expect(taintedInRoom([])).toBe(false)
    expect(taintedInRoom(['?autopilot', ROOM_TAINT])).toBe(true)
    expect(taintedInRoom(['autopilot'])).toBe(true)
  })

  it('taints on a switch nobody has written yet — the reason it is an allowlist', () => {
    expect(urlTaint('?gravity=0&quality=high')).toEqual(['?gravity'])
  })

  it('goes by KEY, not value: ?autopilot=0 and ?props=on taint too', () => {
    expect(urlTaint('?autopilot=0')).toEqual(['?autopilot'])
    expect(urlTaint('?props=on')).toEqual(['?props'])
  })

  it('names each switch once, sorted', () => {
    expect(urlTaint('?snap=20&props=off&snap=30&quality=low')).toEqual(['?props', '?snap'])
    expect(urlTaint(new URLSearchParams('mode=freeFlight'))).toEqual(['?mode'])
  })
})

describe('the allowlist', () => {
  /** Every `.get('<name>')` / `.has('<name>')` in `src/`: the switches that exist. */
  const readSwitches = (): Set<string> => {
    const found = new Set<string>()
    for (const full of listTsWithDts(path.join(process.cwd(), 'src'))) {
      const text = fs.readFileSync(full, 'utf8')
      for (const m of text.matchAll(/\.(?:get|has)\('([A-Za-z]+)'\)/g)) found.add(m[1] as string)
    }
    return found
  }

  it('names only switches the source actually reads', () => {
    const real = readSwitches()
    const unknown = Object.keys(PRESENTATION_SWITCHES).filter((name) => !real.has(name))
    expect(unknown).toEqual([])
  })

  it('says why, for every entry', () => {
    for (const [name, why] of Object.entries(PRESENTATION_SWITCHES)) {
      expect(why.length, name).toBeGreaterThan(8)
    }
  })

  it('is a real own-property lookup, not the prototype chain', () => {
    expect(isPresentationSwitch('toString')).toBe(false)
    expect(urlTaint('?constructor=1')).toEqual(['?constructor'])
  })
})

describe('a run', () => {
  it('starts from what the URL says, gains reasons once each, and resets to the URL', () => {
    const t = createRunTaint(['?props'])
    expect(isTainted(t)).toBe(true)
    taintRun(t, 'autopilot')
    taintRun(t, 'autopilot')
    expect(t.reasons).toEqual(['?props', 'autopilot'])
    resetRunTaint(t, [])
    expect(isTainted(t)).toBe(false)
    expect(t.reasons).toEqual([])
  })
})
