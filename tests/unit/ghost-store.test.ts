// tests/unit/ghost-store.test.ts — DEV-371: your best lap, kept on this device.
//
// `game/ghost-store.ts` is wrapped as `game/personal-best.ts` is, and these are
// the cases that make the wrapping a claim rather than a comment: storage that
// THROWS (a private window), storage that is FULL (quota), values somebody
// edited in devtools, and a lap filed under another course or preset. Every
// storage here is a hand-made object, so each failure is the real shape and
// not whatever a jsdom mock happens to do.

import { describe, expect, it } from 'vitest'
import { ghostKey, keepLap, type LapCandidate, lapBeats, readLap } from '@/game/ghost-store'
import { fromBase64url, toBase64url } from '@/net/base64url'
import { LAP_SCHEMA, type LapDoc } from '@/sim/ghost'
import { lapToBytes } from '@/sim/ghost-record'

/** The rules a lap of this test is flown under: an opaque string, as DEV-372's hash is. */
const RULES = 'unit-rules'
const STD = 'standard'

/** A small, valid lap: three keys, one event. */
const lap = (over: Partial<LapDoc> = {}): LapDoc => ({
  $schema: LAP_SCHEMA,
  mission: 'int_01_hoverJet',
  mode: 'ringAttack',
  edition: 'anniversary',
  rules: RULES,
  vehicle: 'hoverjet:standard',
  build: 'unit',
  keyCount: 3,
  tick: [0, 1, 2],
  p: [0, 0, 0, 1000, 0, 0, 2000, 0, 0],
  q: [0, 0, 0, 32767, 0, 0, 0, 32767, 0, 0, 0, 32767],
  events: [{ tick: 2, kind: 'finish' }],
  ...over,
})

const candidate = (over: Partial<LapCandidate> = {}): LapCandidate => ({
  doc: lap(),
  seconds: 70,
  gates: 21,
  tainted: false,
  reasons: [],
  ...over,
})

/** A `Storage` with a map behind it. */
const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } => {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, String(v))
    },
  }
}

const KEY = ghostKey('int_01_hoverJet', 'ringAttack', 'anniversary')
/** The slot every lap above belongs to. */
const SLOT = {
  mission: 'int_01_hoverJet',
  mode: 'ringAttack',
  edition: 'anniversary',
  rules: RULES,
  vehicle: 'hoverjet:standard',
  variant: STD,
}

describe('the key', () => {
  it('is per mission, per mode, per EDITION, with the store version on the end', () => {
    expect(KEY).toBe('ff2.ghost.int_01_hoverJet.ringAttack.anniversary.v1')
    expect(ghostKey('int_01_hoverJet', 'ringAttack', 'classic')).not.toBe(KEY)
    // `standard` is the plain key, so nothing kept before variants existed moves.
    expect(ghostKey('int_01_hoverJet', 'ringAttack', 'anniversary', STD)).toBe(KEY)
    expect(ghostKey('int_01_hoverJet', 'ringAttack', 'anniversary', 'speed')).toBe(
      'ff2.ghost.int_01_hoverJet.ringAttack.anniversary.speed.v1',
    )
  })

  it("keeps a variant's lap in its own slot: a speed jet's lap is not the standard's best", () => {
    const s = memory()
    keepLap(candidate({ seconds: 80 }), STD, s)
    const speed = candidate({ doc: lap({ vehicle: 'hoverjet:speed' }), seconds: 50 })
    expect(keepLap(speed, 'speed', s)).toMatchObject({ improved: true, stored: true })
    expect(readLap(SLOT, s)?.seconds).toBe(80)
    expect(readLap({ ...SLOT, vehicle: 'hoverjet:speed', variant: 'speed' }, s)?.seconds).toBe(50)
    expect(s.map.size).toBe(2)
  })

  it('is not your best under stale RULES, and the next lap replaces it however slow', () => {
    // DEV-372: `rules` is a hash of the course and the edition's gameplay, so a
    // build that moves a gameplay number moves it. A lap flown before is not
    // comparable, and the server would refuse to board it.
    const s = memory()
    keepLap(candidate({ seconds: 60 }), STD, s)
    const now = { ...SLOT, rules: 'next-rules' }
    expect(readLap(now, s)).toBeNull()
    const slower = candidate({ doc: lap({ rules: 'next-rules' }), seconds: 90 })
    expect(keepLap(slower, STD, s)).toMatchObject({ improved: true, stored: true })
    expect(readLap(now, s)?.seconds).toBe(90)
    expect(readLap(SLOT, s)).toBeNull()
  })

  it('keeps the two presets apart: a Classic lap is not an Anniversary best', () => {
    const s = memory()
    expect(keepLap(candidate({ doc: lap({ edition: 'classic' }) }), STD, s).stored).toBe(true)
    expect(readLap(SLOT, s)).toBeNull()
    expect(readLap({ ...SLOT, edition: 'classic' }, s)?.seconds).toBe(70)
    // And a better Anniversary lap does not displace it.
    expect(keepLap(candidate({ seconds: 50 }), STD, s).stored).toBe(true)
    expect(readLap({ ...SLOT, edition: 'classic' }, s)?.seconds).toBe(70)
    expect(s.map.size).toBe(2)
  })
})

describe('a round trip', () => {
  it('reads back the lap it wrote, integer for integer', () => {
    const s = memory()
    // Tainted by a URL switch, so the taint fields make the round trip too. Not
    // by the autopilot: since DEV-601 that lap is not kept of its own accord.
    const kept = keepLap(candidate({ tainted: true, reasons: ['mission'] }), STD, s)
    expect(kept).toMatchObject({ improved: true, stored: true })
    const back = readLap(SLOT, s)
    expect(back?.doc).toEqual(lap())
    expect(back).toMatchObject({ seconds: 70, gates: 21, tainted: true, reasons: ['mission'] })
  })

  it('stores the wire as base64url: no padding, no + or /', () => {
    const s = memory()
    keepLap(candidate(), STD, s)
    const raw = JSON.parse(s.map.get(KEY) as string) as { lap: string }
    expect(raw.lap).toMatch(/^[A-Za-z0-9_-]+$/)
    // DEV-372's codec reads it back: the kept text is the text a lap travels in.
    expect(fromBase64url(raw.lap)).toEqual(lapToBytes(lap()))
  })
})

describe('which lap is best', () => {
  it('ranks a clean lap over a tainted one, then rings, then time', () => {
    const at = (seconds: number, gates: number, tainted: boolean) => ({ seconds, gates, tainted })
    expect(lapBeats(at(90, 21, false), at(60, 21, true))).toBe(true)
    expect(lapBeats(at(60, 21, true), at(90, 21, false))).toBe(false)
    expect(lapBeats(at(90, 21, false), at(60, 20, false))).toBe(true)
    expect(lapBeats(at(60, 21, false), at(61, 21, false))).toBe(true)
    // A tie is not an improvement.
    expect(lapBeats(at(60, 21, false), at(60, 21, false))).toBe(false)
  })

  it('keeps a better lap and refuses a worse one', () => {
    const s = memory()
    keepLap(candidate({ seconds: 70 }), STD, s)
    expect(keepLap(candidate({ seconds: 71 }), STD, s)).toMatchObject({
      improved: false,
      stored: false,
    })
    expect(readLap(SLOT, s)?.seconds).toBe(70)
    expect(keepLap(candidate({ seconds: 69 }), STD, s)).toMatchObject({
      improved: true,
      stored: true,
    })
    expect(readLap(SLOT, s)?.seconds).toBe(69)
  })

  it('never lets an autopilot lap displace one you flew', () => {
    const s = memory()
    keepLap(candidate({ seconds: 90 }), STD, s)
    const fast = candidate({ seconds: 60, tainted: true, reasons: ['autopilot'] })
    expect(keepLap(fast, STD, s).improved).toBe(false)
    expect(readLap(SLOT, s)?.tainted).toBe(false)
  })

  it('does not keep an autopilot lap of its own accord, even with nothing saved (DEV-601)', () => {
    // The panel's SAVE AS YOUR GHOST? then starts at NO; a press keeps it
    // (`LapRun.keepLast`), which writes past this decision.
    const s = memory()
    const flown = candidate({ tainted: true, reasons: ['autopilot'] })
    expect(keepLap(flown, STD, s)).toMatchObject({ best: null, improved: true, stored: false })
    expect(s.map.size).toBe(0)
  })

  it('never keeps a lap that did not finish', () => {
    const s = memory()
    expect(keepLap(candidate({ seconds: null }), STD, s)).toMatchObject({
      best: null,
      stored: false,
    })
    expect(s.map.size).toBe(0)
  })
})

describe('storage that throws', () => {
  it('reads nothing and throws nothing when the ACCESS throws (null storage)', () => {
    expect(readLap(SLOT, null)).toBeNull()
    expect(keepLap(candidate(), STD, null)).toMatchObject({
      best: null,
      improved: true,
      stored: false,
    })
  })

  it('reads nothing when getItem throws, and still keeps nothing it could not write', () => {
    const blocked = {
      getItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('blocked', 'SecurityError')
      },
    }
    expect(readLap(SLOT, blocked)).toBeNull()
    expect(keepLap(candidate(), STD, blocked)).toMatchObject({ improved: true, stored: false })
  })

  it('survives a FULL store: the old best stands and nothing throws', () => {
    const s = memory()
    keepLap(candidate({ seconds: 80 }), STD, s)
    const full = {
      getItem: s.getItem,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      },
    }
    const r = keepLap(candidate({ seconds: 60 }), STD, full)
    expect(r.improved).toBe(true)
    expect(r.stored).toBe(false)
    // `best` is what the next read will return: the previous lap.
    expect(r.best?.seconds).toBe(80)
    expect(readLap(SLOT, s)?.seconds).toBe(80)
  })
})

describe('garbage reads as absent', () => {
  const stored = (value: unknown): Pick<Storage, 'getItem' | 'setItem'> => {
    const s = memory()
    s.setItem(KEY, typeof value === 'string' ? value : JSON.stringify(value))
    return s
  }
  const good = () => {
    const s = memory()
    keepLap(candidate(), STD, s)
    return JSON.parse(s.map.get(KEY) as string) as Record<string, unknown>
  }
  const read = (s: Pick<Storage, 'getItem' | 'setItem'>) => readLap(SLOT, s)

  it('is not fooled by a value that is not JSON, not an object, or not a lap', () => {
    expect(read(stored('{not json'))).toBeNull()
    expect(read(stored('null'))).toBeNull()
    expect(read(stored([1, 2, 3]))).toBeNull()
    expect(read(stored({ ...good(), lap: 'AAAA' }))).toBeNull()
    expect(read(stored({ ...good(), lap: '!!!' }))).toBeNull()
    expect(read(stored({ ...good(), lap: 42 }))).toBeNull()
  })

  it('refuses a result that is not a number, as personal-best.ts does', () => {
    expect(read(stored({ ...good(), seconds: 'fast' }))).toBeNull()
    expect(read(stored({ ...good(), seconds: null }))).toBeNull()
    expect(read(stored({ ...good(), seconds: -1 }))).toBeNull()
    expect(read(stored({ ...good(), gates: 20.5 }))).toBeNull()
  })

  it("refuses another course's, mode's, preset's, rules' or aircraft's lap under this key", () => {
    for (const over of [
      { mission: 'rookie_01_hoverJet' },
      { mode: 'freeFlight' },
      { edition: 'classic' },
      { rules: 'stale' },
      { vehicle: 'hoverjet:speed' },
    ]) {
      const s = stored({ ...good(), lap: toBase64url(lapToBytes(lap(over))) })
      expect(read(s), JSON.stringify(over)).toBeNull()
    }
  })

  it('reads a lap whose taint is missing or mangled as TAINTED, the safe side', () => {
    const { tainted: _, ...rest } = good()
    expect(read(stored(rest))?.tainted).toBe(true)
    expect(read(stored({ ...good(), tainted: 'no' }))?.tainted).toBe(true)
    expect(read(stored({ ...good(), tainted: 0 }))?.tainted).toBe(true)
    expect(read(stored({ ...good(), tainted: false }))?.tainted).toBe(false)
  })
})
