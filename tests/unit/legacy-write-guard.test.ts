// tests/unit/legacy-write-guard.test.ts: hard rule 1 as code (TL-19).
//
// `assertOutsideLegacy` is the one write-guard every tool that reads the Unity project calls
// before it writes. It compares STRINGS (lower-cased, forward-slashed) and never resolves the
// legacy root through `node:path`, so a `C:/...` root behaves the same on the Linux runner.

import { describe, expect, it } from 'vitest'
import { assertOutsideLegacy, portableText } from '../../tools/legacy-root.mjs'

const ROOT = 'C:/Unity/Project One'
/** One backslash, built rather than typed so no tool between here and the disk can eat it. */
const BS = String.fromCharCode(92)

describe('assertOutsideLegacy', () => {
  it('refuses the root itself and anything under it, whatever the case or slash', () => {
    expect(() => assertOutsideLegacy('C:/Unity/Project One', ROOT)).toThrow(/REFUSING/)
    expect(() => assertOutsideLegacy('C:/Unity/Project One/Assets/x.glb', ROOT)).toThrow(/REFUSING/)
    const windows = ['c:', 'unity', 'project one', 'Assets'].join(BS)
    expect(() => assertOutsideLegacy(windows, ROOT)).toThrow(/REFUSING/)
    expect(() => assertOutsideLegacy('C:/Unity/Project One/', `${ROOT}/`)).toThrow(/REFUSING/)
  })

  it('allows a sibling that only shares the root name as a prefix', () => {
    expect(() => assertOutsideLegacy('C:/Unity/Project One-copy/x', ROOT)).not.toThrow()
    expect(() => assertOutsideLegacy('C:/Unity/Project Onex', ROOT)).not.toThrow()
  })

  it('allows the repo and returns the forward-slashed absolute path it checked', () => {
    const got = assertOutsideLegacy('content/levels/x.json', ROOT)
    expect(got).not.toContain(BS)
    expect(got.endsWith('/content/levels/x.json')).toBe(true)
  })

  it('defaults to $FF2_LEGACY, and has nothing to guard when it is unset', () => {
    const before = { legacy: process.env.FF2_LEGACY, file: process.env.FF2_ENV_FILE }
    try {
      process.env.FF2_ENV_FILE = '/no/such/env/file'
      process.env.FF2_LEGACY = ROOT
      expect(() => assertOutsideLegacy(`${ROOT}/Assets/x`)).toThrow(/REFUSING/)
      // Unset: no project, so no path can be inside it. It must not throw and must not guess.
      delete process.env.FF2_LEGACY
      expect(() => assertOutsideLegacy(`${ROOT}/Assets/x`)).not.toThrow()
    } finally {
      if (before.legacy === undefined) delete process.env.FF2_LEGACY
      else process.env.FF2_LEGACY = before.legacy
      if (before.file === undefined) delete process.env.FF2_ENV_FILE
      else process.env.FF2_ENV_FILE = before.file
    }
  })
})

describe('portableText', () => {
  it('names the root in both the forward and the doubled-backslash spelling', () => {
    const back = ROOT.split('/').join(BS + BS)
    const out = portableText(`a ${ROOT}/Assets/x and "${back}${BS}${BS}Assets"`, ROOT)
    expect(out).not.toContain('Project One')
    expect(out.startsWith('a $FF2_LEGACY/Assets/x')).toBe(true)
  })

  it('leaves text without the root alone', () => {
    expect(portableText('nothing to see', ROOT)).toBe('nothing to see')
  })
})
