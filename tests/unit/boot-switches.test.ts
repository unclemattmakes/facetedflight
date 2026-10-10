// tests/unit/boot-switches.test.ts: the `?xr=off` and `?audio=off` readers. BE-15.
//
// Both switches used to be decided in several places (the capability gate and
// two sites in app.ts for xr; app.ts twice for audio). `src/boot/switches.ts`
// is the one answer, and it is a leaf so the gate can import it without
// reaching `three` or `import.meta.glob`. These pin the answers, and the leaf
// property, so a later edit cannot quietly reopen either.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { audioOff, touchOverride, xrProbeOff } from '@/boot/switches'
import { appSource, codeOnly } from './helpers/app-source'

const SRC = join(__dirname, '..', '..', 'src', 'boot')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

describe('BE-15: xrProbeOff', () => {
  it('is true only for exactly xr=off', () => {
    expect(xrProbeOff('?xr=off')).toBe(true)
    expect(xrProbeOff('?view=cam&xr=off&snap=20')).toBe(true)
    expect(xrProbeOff('')).toBe(false)
    expect(xrProbeOff('?xr=on')).toBe(false)
    expect(xrProbeOff('?xr=')).toBe(false)
    expect(xrProbeOff('?xr')).toBe(false)
    expect(xrProbeOff('?XR=off')).toBe(false)
    expect(xrProbeOff('?audio=off')).toBe(false)
  })

  it('takes a parsed query as well as a string, and they agree', () => {
    for (const q of ['', '?xr=off', '?xr=0', '?a=1&xr=off']) {
      expect(xrProbeOff(new URLSearchParams(q))).toBe(xrProbeOff(q))
    }
  })
})

describe('BE-15: audioOff', () => {
  it('is true only for exactly audio=off', () => {
    expect(audioOff('?audio=off')).toBe(true)
    expect(audioOff('?autopilot=1&audio=off')).toBe(true)
    expect(audioOff('')).toBe(false)
    expect(audioOff('?audio=on')).toBe(false)
    expect(audioOff('?audio=0')).toBe(false)
    expect(audioOff('?audio')).toBe(false)
    expect(audioOff('?xr=off')).toBe(false)
  })

  it('takes a parsed query as well as a string, and they agree', () => {
    for (const q of ['', '?audio=off', '?audio=1', '?a=1&audio=off']) {
      expect(audioOff(new URLSearchParams(q))).toBe(audioOff(q))
    }
  })
})

describe('BE-15: touchOverride', () => {
  it('is null when the page says nothing, false for exactly 0, true for anything else', () => {
    expect(touchOverride('')).toBeNull()
    expect(touchOverride('?xr=off')).toBeNull()
    expect(touchOverride('?touch=0')).toBe(false)
    expect(touchOverride('?touch=1')).toBe(true)
    expect(touchOverride('?touch')).toBe(true)
    expect(touchOverride('?touch=yes')).toBe(true)
    expect(touchOverride(new URLSearchParams('touch=0'))).toBe(false)
  })
})

describe('BE-15: room, watch, follow and snap are read once, in pins', () => {
  it('app.ts parses no URL switch itself and the gate reads touch through the leaf', () => {
    const app = codeOnly(read('app.ts'))
    expect(app).not.toMatch(/\bparams\.get\(/)
    expect(app).not.toMatch(/^\s*params,\s*$/m) // no longer imported at all
    const pins = codeOnly(read('app/pins.ts'))
    for (const name of ['room', 'watch', 'follow', 'snap']) {
      expect(pins).toContain(`params.get('${name}')`)
    }
    expect(codeOnly(read('capability-gate.ts'))).not.toMatch(/URLSearchParams/)
  })

  it('SKIP_RIDE is derived from the room pin, not from a second parse of ?room=', () => {
    const pins = codeOnly(read('app/pins.ts'))
    expect(pins.match(/params\.get\('room'\)/g)).toHaveLength(1)
    expect(pins).toMatch(/SKIP_RIDE =[^\n]*ROOM_AT_BOOT !== null/)
  })
})

describe('BE-15: the default reads the page the code runs in', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads globalThis.location.search at call time, so the gate sees a late stub', () => {
    vi.stubGlobal('location', { search: '?xr=off&audio=off' })
    expect(xrProbeOff()).toBe(true)
    expect(audioOff()).toBe(true)
    vi.stubGlobal('location', { search: '' })
    expect(xrProbeOff()).toBe(false)
    expect(audioOff()).toBe(false)
  })

  it('answers false where there is no location at all (node, a worker)', () => {
    // vitest's node environment has none unless stubbed.
    expect(xrProbeOff()).toBe(false)
    expect(audioOff()).toBe(false)
  })
})

describe('BE-15: one answer per switch, and the leaf stays a leaf', () => {
  it('switches.ts imports nothing', () => {
    expect(read('switches.ts')).not.toMatch(/^\s*import\s/m)
  })

  it('the capability gate reads xr through switches and never imports pins', () => {
    // Code only: the gate's own comment names the file it must not import.
    const gate = codeOnly(read('capability-gate.ts'))
    expect(gate).toMatch(/from '\.\/switches'/)
    // pins pulls in three and import.meta.glob: one edge from here makes
    // Playwright collect zero tests.
    expect(gate).not.toMatch(/app\/pins/)
    expect(gate).not.toMatch(/get\('xr'\)/)
  })

  it('pins and app.ts decide neither switch with their own string compare', () => {
    // app.ts is read through the helper: it is being split into app/*.ts.
    const text = appSource()
    expect(text).not.toMatch(/get\('xr'\)/)
    expect(text).not.toMatch(/get\('audio'\)/)
    expect(read('app/pins.ts')).toMatch(/from '\.\.\/switches'/)
  })
})
