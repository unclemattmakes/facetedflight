// tests/unit/personal-best.test.ts — the number that makes you fly it again.
//
// Two things are being guarded and only one of them is the arithmetic.
//
// The other is that `localStorage` THROWS on access in a private window with
// site data blocked, and in some embedded webviews — not returns null, throws.
// An unguarded read at boot takes the whole app down before the first frame,
// for a feature nobody would miss. So the store is injected here and half these
// tests hand in one that throws.

import { describe, expect, it, vi } from 'vitest'
import { bestKey, legacyBestKey, readBest, recordRun } from '@/game/personal-best'

/** An in-memory `localStorage`. */
const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

/** One that throws on everything, the way a blocked context does. */
const hostile = {
  getItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
}

const RUN = { score: 2400, timeSeconds: 71.2, gates: 21 }
/** The mode half of the key (DEV-204). `int_01_hoverJet` really runs in this one. */
const RA = 'ringAttack'

describe('the personal best', () => {
  it('keeps the first run, and reports it as an improvement', () => {
    const store = memory()
    const out = recordRun('int_01_hoverJet', RA, RUN, store)
    expect(out.improved).toBe(true)
    expect(out.previous).toBeNull()
    expect(out.best.score).toBe(2400)
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
  })

  it('keeps the higher score and leaves the stored one alone otherwise', () => {
    const store = memory()
    recordRun('int_01_hoverJet', RA, RUN, store)
    const worse = recordRun(
      'int_01_hoverJet',
      RA,
      { score: 1800, timeSeconds: 60, gates: 17 },
      store,
    )
    expect(worse.improved).toBe(false)
    expect(worse.best.score).toBe(2400)
    // And the store was not touched — a worse run must not overwrite the TIME
    // either, which is the half a "score only" check would miss.
    expect(readBest('int_01_hoverJet', RA, store)?.timeSeconds).toBeCloseTo(71.2, 6)

    const better = recordRun(
      'int_01_hoverJet',
      RA,
      { score: 2401, timeSeconds: 99, gates: 21 },
      store,
    )
    expect(better.improved).toBe(true)
    expect(better.previous?.score).toBe(2400)
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2401)
  })

  it('does not call a tie an improvement', () => {
    // Repeating your exact score is not progress, and flashing NEW BEST at it
    // devalues the one time it means something.
    const store = memory()
    recordRun('int_01_hoverJet', RA, RUN, store)
    expect(recordRun('int_01_hoverJet', RA, RUN, store).improved).toBe(false)
  })

  it('namespaces by mission, so a second course cannot overwrite the first', () => {
    const store = memory()
    recordRun('int_01_hoverJet', RA, RUN, store)
    recordRun('int_02_hoverJet', RA, { score: 100, timeSeconds: 9, gates: 1 }, store)
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
    expect(readBest('int_02_hoverJet', RA, store)?.score).toBe(100)
    expect(bestKey('int_01_hoverJet', RA)).not.toBe(bestKey('int_02_hoverJet', RA))
  })

  // ── the MODE half of the namespace (DEV-204) ───────────────────────────
  //
  // Matt, 2026-09-17, on where medals and bests are keyed: every one of them by
  // **mission id + mode, one namespace for all four modes** — departing from
  // 2016, which keyed Free Flight by ENVIRONMENT and Ring Attack by SCENE NAME.
  // `docs/DEVIATIONS.md` carries the row.

  it('namespaces by MODE, so one course flown two ways keeps two bests', () => {
    // A score is only comparable to another score under the same rules. Free
    // Flight counts orbs and awards no time bonus; Ring Attack is points. One
    // key for both would put a count next to a score and call it a best.
    const store = memory()
    recordRun('hoverJet_kauai_beg', 'ringAttack', RUN, store)
    recordRun('hoverJet_kauai_beg', 'freeFlight', { score: 11, timeSeconds: 240, gates: 0 }, store)
    expect(readBest('hoverJet_kauai_beg', 'ringAttack', store)?.score).toBe(2400)
    expect(readBest('hoverJet_kauai_beg', 'freeFlight', store)?.score).toBe(11)
    expect(bestKey('x', 'ringAttack')).not.toBe(bestKey('x', 'freeFlight'))
  })

  it('names all four modes apart, including the one with no level yet', () => {
    // `energyRace` (DEV-143) ships no course, so nothing can write this key
    // today — and the day something does, it must not land on Ring Attack's.
    const keys = ['ringAttack', 'targetPractice', 'freeFlight', 'energyRace'].map((m) =>
      bestKey('int_01_hoverJet', m),
    )
    expect(new Set(keys).size).toBe(4)
  })

  // ── what happens to a best set BEFORE the mode joined the key ──────────

  it('still finds a best stored under the OLD unmoded key', () => {
    // Real players have these in real browsers. Orphaning them silently is not
    // an option; a boot-time migration that writes on a read path is not one
    // either. So the read falls through, once, to the key that used to be used.
    const store = memory({
      [legacyBestKey('int_01_hoverJet')]: '{"score":1900,"timeSeconds":88,"gates":18,"setAt":7}',
    })
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(1900)
  })

  it('prefers the MODED key when both exist', () => {
    // A legacy key that outranked the current one would make a mode change
    // un-recordable: you would beat your best and read back the old number.
    const store = memory({
      [legacyBestKey('int_01_hoverJet')]: '{"score":9999,"timeSeconds":10,"gates":21,"setAt":7}',
      [bestKey('int_01_hoverJet', RA)]: '{"score":100,"timeSeconds":10,"gates":1,"setAt":8}',
    })
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(100)
  })

  it('beats a legacy best forward onto the new key, and never writes the old one', () => {
    // The migration, such as it is: the first run that beats the legacy number
    // moves the record. Nothing rewrites storage at boot, and nothing ever
    // writes the legacy key again — two live records that can disagree is the
    // shape of every "almost right" bug in this repo.
    const store = memory({
      [legacyBestKey('int_01_hoverJet')]: '{"score":1900,"timeSeconds":88,"gates":18,"setAt":7}',
    })
    const out = recordRun('int_01_hoverJet', RA, RUN, store)
    expect(out.improved).toBe(true)
    expect(out.previous?.score, 'it compared against the legacy best').toBe(1900)
    expect(store.map.get(bestKey('int_01_hoverJet', RA))).toContain('2400')
    expect(store.map.get(legacyBestKey('int_01_hoverJet')), 'the old key is untouched').toContain(
      '1900',
    )
    // And a WORSE run does not overwrite the legacy best either.
    const worse = recordRun('int_02_hoverJet', RA, { score: 1, timeSeconds: 1, gates: 0 }, store)
    expect(worse.improved).toBe(true)
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
  })

  it('does not let a legacy best leak across modes', () => {
    // The fallback is unambiguous because a mission runs in exactly ONE mode at
    // a time — but the key is a string and nothing stops a caller asking for
    // another. What it must never do is quietly answer with a record set under
    // different rules... which, with one legacy key per mission, it would. So
    // this is the documented shape rather than a guarantee: the fallback is
    // per-MISSION, and `boot/app.ts` only ever asks with `RUNNING_MODE`.
    const store = memory({
      [legacyBestKey('int_01_hoverJet')]: '{"score":1900,"timeSeconds":88,"gates":18,"setAt":7}',
    })
    expect(readBest('int_01_hoverJet', 'freeFlight', store)?.score).toBe(1900)
    expect(readBest('some_other_mission', 'freeFlight', store)).toBeNull()
  })

  it('carries a version in the key, so a scoring change invalidates rather than lies', () => {
    // DEV-014 already moved the medal thresholds once. A best set under
    // different arithmetic is not a best, it is a number that makes the delta
    // wrong — and a delta that is wrong is worse than no delta.
    expect(bestKey('int_01_hoverJet', RA)).toMatch(/\.v\d+$/)
  })

  // ── the half that is not arithmetic ────────────────────────────────────

  it('survives a storage that THROWS, which is the case that matters', () => {
    // Private window, site data blocked, some webviews. Not null — throws.
    expect(() => readBest('int_01_hoverJet', RA, hostile)).not.toThrow()
    expect(readBest('int_01_hoverJet', RA, hostile)).toBeNull()
    expect(() => recordRun('int_01_hoverJet', RA, RUN, hostile)).not.toThrow()
    // And the run still reports itself, because the results panel needs a
    // number whether or not anything remembered it.
    const out = recordRun('int_01_hoverJet', RA, RUN, hostile)
    expect(out.improved).toBe(true)
    expect(out.best.score).toBe(2400)
  })

  it('survives no storage at all', () => {
    expect(readBest('int_01_hoverJet', RA, null)).toBeNull()
    expect(recordRun('int_01_hoverJet', RA, RUN, null).best.score).toBe(2400)
  })

  it('treats garbage in the key as absent', () => {
    // The key is visible in devtools on a public URL. A hand-edited value must
    // not put NaN on the results panel.
    for (const raw of [
      'not json',
      '{}',
      '[]',
      'null',
      '{"score":"platinum"}',
      '{"score":NaN}',
      '{"score":-5,"timeSeconds":10,"gates":3}',
      '{"score":10,"timeSeconds":"soon","gates":3}',
      '{"score":10,"timeSeconds":10,"gates":null}',
    ]) {
      const store = memory({ [bestKey('int_01_hoverJet', RA)]: raw })
      expect(readBest('int_01_hoverJet', RA, store), raw).toBeNull()
    }
  })

  it('accepts a stored best that is missing only its timestamp', () => {
    // `setAt` is display-only and never compared, so an old or truncated record
    // is still a usable best. Discarding it would silently reset someone.
    const store = memory({
      [bestKey('int_01_hoverJet', RA)]: '{"score":1234,"timeSeconds":80,"gates":19}',
    })
    const best = readBest('int_01_hoverJet', RA, store)
    expect(best?.score).toBe(1234)
    expect(best?.setAt).toBe(0)
  })

  it('writes something `readBest` can read back', () => {
    // The round trip, which a shape change on one side would break silently.
    const store = memory()
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    recordRun('int_01_hoverJet', RA, RUN, store)
    vi.restoreAllMocks()
    const back = readBest('int_01_hoverJet', RA, store)
    expect(back).toEqual({ score: 2400, timeSeconds: 71.2, gates: 21, setAt: 1_700_000_000_000 })
  })
})

// ── the AIRCRAFT VARIANT half of the namespace (DEV-382) ─────────────────
//
// AIRCRAFT-VARIANTS §6.3, and Matt's answer to open call 4: medal thresholds
// are shared, RECORDS are per variant. A speed lap is not a standard lap.

describe('the personal best, per aircraft variant', () => {
  it("keeps the standard's key byte for byte, so no stored best needs migrating", () => {
    // Spelled out, not re-derived: this is the string every best already
    // stored in a real browser sits under.
    expect(bestKey('int_01_hoverJet', RA, 'standard')).toBe(
      'ff2.best.int_01_hoverJet.ringAttack.v1',
    )
    expect(bestKey('int_01_hoverJet', RA)).toBe(bestKey('int_01_hoverJet', RA, 'standard'))
    expect(bestKey('int_01_hoverJet', RA, 'speed')).toBe(
      'ff2.best.int_01_hoverJet.ringAttack.speed.v1',
    )
  })

  it('a speed best neither overwrites nor reads as a standard one', () => {
    const store = memory()
    recordRun('int_01_hoverJet', RA, RUN, store)
    const faster = { score: 3600, timeSeconds: 46.1, gates: 21 }
    const outcome = recordRun('int_01_hoverJet', RA, faster, store, 'speed')
    // Its own record: nothing to beat, so it is new, and it compared with
    // nothing of the standard's.
    expect(outcome.previous).toBeNull()
    expect(outcome.improved).toBe(true)
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
    expect(readBest('int_01_hoverJet', RA, store, 'speed')?.score).toBe(3600)
    expect(readBest('int_01_hoverJet', RA, store, 'acrobat')).toBeNull()
    expect(store.map.size).toBe(2)
  })

  it('does not hand a variant the standard-only legacy best', () => {
    // The unmoded key predates variants, so only 2016's machine set it.
    const store = memory({ [legacyBestKey('int_01_hoverJet')]: JSON.stringify({ ...RUN }) })
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
    expect(readBest('int_01_hoverJet', RA, store, 'speed')).toBeNull()
  })

  it('survives a storage that throws, in every variant', () => {
    expect(readBest('int_01_hoverJet', RA, hostile, 'speed')).toBeNull()
    expect(recordRun('int_01_hoverJet', RA, RUN, hostile, 'speed').improved).toBe(true)
  })
})

describe('the personal best, per COURSE (DEV-538, plan/SHIPPED-COURSE-EDITS §6.2)', () => {
  // An overridden shipped mission carries `level.courseKey`; 2016's course
  // carries none. Matt's call 3: an edited course starts fresh bests.
  const COURSE = 'b75749b8'

  it('keeps every key a course as 2016 shipped it has ever had, byte for byte', () => {
    expect(bestKey('int_01_hoverJet', RA)).toBe('ff2.best.int_01_hoverJet.ringAttack.v1')
    expect(bestKey('int_01_hoverJet', RA, 'standard', null)).toBe(
      'ff2.best.int_01_hoverJet.ringAttack.v1',
    )
    expect(bestKey('int_01_hoverJet', RA, 'speed', null)).toBe(
      'ff2.best.int_01_hoverJet.ringAttack.speed.v1',
    )
  })

  it('gives an edited course its own segment, after the variant', () => {
    expect(bestKey('int_01_hoverJet', RA, 'standard', COURSE)).toBe(
      `ff2.best.int_01_hoverJet.ringAttack.c${COURSE}.v1`,
    )
    expect(bestKey('int_01_hoverJet', RA, 'speed', COURSE)).toBe(
      `ff2.best.int_01_hoverJet.ringAttack.speed.c${COURSE}.v1`,
    )
  })

  it('starts an edited course fresh, and leaves 2016’s course’s best where it was', () => {
    const store = memory()
    recordRun('int_01_hoverJet', RA, RUN, store)
    expect(readBest('int_01_hoverJet', RA, store, undefined, null, COURSE)).toBeNull()
    const slower = { score: 1800, timeSeconds: 90, gates: 17 }
    const out = recordRun('int_01_hoverJet', RA, slower, store, undefined, null, COURSE)
    // A worse score than the old course's best is still the new course's first.
    expect(out.improved).toBe(true)
    expect(out.previous).toBeNull()
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
    expect(readBest('int_01_hoverJet', RA, store, undefined, null, COURSE)?.score).toBe(1800)
    // Reverting the override (no course key) gets the old best back.
    expect(readBest('int_01_hoverJet', RA, store, undefined, null, null)?.score).toBe(2400)
  })

  it('never hands an edited course the legacy best, which only 2016’s course can have set', () => {
    const store = memory({ [legacyBestKey('int_01_hoverJet')]: JSON.stringify({ ...RUN }) })
    expect(readBest('int_01_hoverJet', RA, store)?.score).toBe(2400)
    expect(readBest('int_01_hoverJet', RA, store, undefined, null, COURSE)).toBeNull()
  })
})
