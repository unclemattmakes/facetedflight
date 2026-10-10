// tests/unit/override-added-key.test.ts: an added entity's key has ONE reading.
// DEV-770 (code-reuse audit BE-11, the part DEV-740 left).
//
// `content/level-override.ts` owns the key an added ring or turn indicator
// answers to (`ov:<n>`, n a positive whole number: the validator refuses
// anything else). The shipped desk held its own two readings of that
// convention: `isAdded` was `key.startsWith('ov:')` and `nextAddKey` took the
// biggest `Number(key.slice(3))`. They agree with the reader on every key the
// reader accepts and disagree on keys it REFUSES, which a draft never holds
// today and any hand-edited or future-format file might.
//
// Three things are held here:
//  1. ORACLE. On every key the reader accepts (and on 2016 fileIDs), the old
//     expressions and the owner's exports answer alike, `Object.is`, over many
//     keys and many add lists. This is the refactor's proof: no behaviour moved.
//  2. THE READER IS THE REFERENCE. `isAddedKey(k)` is true exactly when
//     `validateOverride` accepts `k` as an add's key, over the same keys.
//  3. THE FINDING. Where the old expressions disagree with the reader (`ov:`,
//     `ov:0`, `ov:07`, `ov:1.5`, `ov:1e3`), the reader wins: such a key is not
//     an added entity, and it never seeds the next key.

import { describe, expect, it } from 'vitest'
import {
  isAddedKey,
  nextAddedKey,
  OVERRIDE_VERSION,
  validateOverride,
} from '@/content/level-override'
import { loadBaselineLevel } from '@/content/load-level'
import { entityState, openShipped } from '@/editor/core'

const BASE = 'a'.repeat(64)

/** The editor's old expressions, verbatim, as the oracle. */
const oldIsAdded = (key: string): boolean => key.startsWith('ov:')
const oldNextAddKey = (add: readonly { readonly key: string }[] | undefined): string => {
  let n = 0
  for (const a of add ?? []) n = Math.max(n, Number(a.key.slice(3)) || 0)
  return `ov:${n + 1}`
}

/** Does the reader take `key` as an added ring's key? (Its other errors do not count.) */
const readerTakes = (key: string): boolean => {
  const r = validateOverride({
    v: OVERRIDE_VERSION,
    mission: 'int_01_hoverJet',
    base: BASE,
    rings: { add: [{ key, after: '1', pos: [0, 0, 0], quat: [0, 0, 0, 1] }] },
  })
  return r.ok || !r.errors.some((e) => e[0] === 'rings.add[0].key')
}

const validKeys: string[] = []
for (let n = 1; n <= 3000; n++) validKeys.push(`ov:${n}`)
validKeys.push('ov:9007199254740991', 'ov:10', 'ov:100', 'ov:999999999')
const fileIds = ['0', '1', '-1', '4294967295', '-9223372036854775808', '12345678901234567']
const malformed = [
  'ov:',
  'ov:0',
  'ov:07',
  'ov:00',
  'ov:1.5',
  'ov:1e3',
  'ov:-1',
  'ov:x',
  'ov:1 ',
  'OV:1',
  'ov:١',
]

/** A fixed pseudo-random stream, so a failure repeats. */
const lcg = (seed: number) => {
  let s = seed >>> 0
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('the oracle: on keys the reader accepts, the old expressions and the owner agree (DEV-770)', () => {
  it('isAddedKey, over added keys and 2016 fileIDs', () => {
    for (const k of [...validKeys, ...fileIds]) {
      expect(Object.is(isAddedKey(k), oldIsAdded(k)), k).toBe(true)
    }
  })

  it('nextAddedKey, over many add lists (empty, undefined, sparse, unordered, big)', () => {
    expect(Object.is(nextAddedKey(undefined), oldNextAddKey(undefined))).toBe(true)
    expect(Object.is(nextAddedKey([]), oldNextAddKey([]))).toBe(true)
    const rnd = lcg(770)
    for (let t = 0; t < 2000; t++) {
      const len = Math.floor(rnd() * 9)
      const span = [3, 12, 400, 3000][Math.floor(rnd() * 4)] as number
      const add = Array.from({ length: len }, () => ({
        key: `ov:${1 + Math.floor(rnd() * span)}`,
      }))
      expect(nextAddedKey(add), JSON.stringify(add)).toBe(oldNextAddKey(add))
    }
  })

  it('the key it hands out is one the reader accepts, and the next one up', () => {
    const add = [{ key: 'ov:2' }, { key: 'ov:9' }, { key: 'ov:4' }]
    expect(nextAddedKey(add)).toBe('ov:10')
    expect(isAddedKey(nextAddedKey(add))).toBe(true)
    expect(readerTakes(nextAddedKey(add))).toBe(true)
  })
})

describe('the reader is the reference (DEV-770)', () => {
  it('isAddedKey is true exactly where validateOverride takes the key', () => {
    for (const k of [...validKeys.slice(0, 200), 'ov:9007199254740991', ...fileIds, ...malformed]) {
      expect(isAddedKey(k), k).toBe(readerTakes(k))
    }
  })
})

describe('the finding: where the old expressions disagreed with the reader, the reader wins (DEV-770)', () => {
  it('the old isAdded took keys the reader refuses', () => {
    for (const k of malformed.filter((m) => m.startsWith('ov:'))) {
      expect(oldIsAdded(k), `old ${k}`).toBe(true)
      expect(isAddedKey(k), `owner ${k}`).toBe(false)
      expect(readerTakes(k), `reader ${k}`).toBe(false)
    }
  })

  it('a refused key does not seed the next key (old: ov:1e3 handed out ov:1001)', () => {
    expect(oldNextAddKey([{ key: 'ov:1e3' }])).toBe('ov:1001')
    expect(nextAddedKey([{ key: 'ov:1e3' }])).toBe('ov:1')
    expect(oldNextAddKey([{ key: 'ov:1.5' }])).toBe('ov:2.5')
    expect(nextAddedKey([{ key: 'ov:1.5' }, { key: 'ov:3' }])).toBe('ov:4')
  })

  it('the editor calls the owner: a ring keyed ov:0 is not "added"', async () => {
    const base = await loadBaselineLevel('int_01_hoverJet')
    const draft = openShipped(base, BASE, null, null).draft
    expect(entityState(draft, { kind: 'ring', key: 'ov:0' })).toBe('2016')
    expect(entityState(draft, { kind: 'ring', key: 'ov:1' })).toBe('added')
  })
})
