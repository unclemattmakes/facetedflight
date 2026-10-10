// tests/unit/room-code.test.ts — a room's short code, and the letter plate it is
// typed on. DEV-441b.
//
// Four claims, each one somebody could get wrong without a screenshot noticing:
//
//   1. The FORMAT. The alphabet has no look-alikes and no vowels, the shape the
//      server checks spells exactly that alphabet, and a fresh code is drawn
//      uniformly from it — a biased draw is a smaller keyspace than the row
//      in DEVIATIONS says.
//   2. The ROUND TRIP. A code as a person writes it (any case, grouped) comes
//      back through `roomIdFrom` as the room's own name, and so does a long id
//      from an older link; a look-alike is refused, never guessed.
//   3. The KEYS. Every character once, no two keys on one cell, a stick step
//      never leaves the plate, and a press does what its label says.
//   4. The PLATE. What you look at is what you press (a ray through every
//      key's centre lands on that key, through the plate's own hit test); the
//      flat screen's centre ray misses it; it fits a flat frame and a portrait
//      phone.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  isRoomCode,
  newRoomCode,
  newRoomId,
  roomCodeCharOf,
  roomCodeFrom,
  roomIdFrom,
} from '@/game/room-client'
import {
  CODE_ACTION,
  CODE_COLS,
  CODE_KEYS,
  CODE_ROWS,
  codeArrowStep,
  codeCharsOf,
  codeFromPaste,
  codeKeyAt,
  codeKeyForKeyboard,
  codeKeyIndex,
  codeKeyStep,
  codeStickStep,
  codeTypedText,
  pressCodeKey,
} from '@/game/room-code'
import { roomCodeText } from '@/game/room-lobby'
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_CODE_SHAPE,
  ROOM_ID_SHAPE,
} from '@/net/room-protocol'
import {
  codeKeyCentre,
  codePlateExtent,
  pickCodeLocal,
  placeCodePlate,
} from '@/render/room-code-plate'

/** The renderer's own flat lens, vertical degrees (`render/renderer.ts`). */
const FLAT_VFOV = 70

/** A deterministic byte source: `bytes` in order, cycling. */
const cycling = (bytes: readonly number[]) => {
  let i = 0
  return (n: number): Uint8Array => {
    const out = new Uint8Array(n)
    for (let k = 0; k < n; k++) out[k] = bytes[i++ % bytes.length] as number
    return out
  }
}

describe('the format (DEV-441b)', () => {
  it('is 28 characters: no 0/O, no 1/I/L, no vowels, each once', () => {
    expect(ROOM_CODE_ALPHABET.length).toBe(28)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length)
    for (const bad of '01OILAEU') expect(ROOM_CODE_ALPHABET, bad).not.toContain(bad)
    expect(ROOM_CODE_ALPHABET).toMatch(/^[0-9A-Z]+$/)
    // DEV-458: seven (Matt, 2026-09-27: *"7 characters"*); DEV-441b had six.
    expect(ROOM_CODE_LENGTH).toBe(7)
  })

  it('the shape the server checks is that alphabet, at that length, and nothing else', () => {
    // Every printable ASCII character: in the alphabet, the shape takes it; out
    // of it, the shape refuses it. The shape is a character class spelled by
    // hand, so this is what keeps it and the alphabet one list.
    for (let c = 33; c < 127; c++) {
      const ch = String.fromCharCode(c)
      const code = ch.repeat(ROOM_CODE_LENGTH)
      expect(ROOM_CODE_SHAPE.test(code), ch).toBe(ROOM_CODE_ALPHABET.includes(ch))
      expect(ROOM_ID_SHAPE.test(code), ch).toBe(ROOM_CODE_ALPHABET.includes(ch))
    }
    expect(ROOM_CODE_SHAPE.test('K7QX4MN')).toBe(true)
    // DEV-458: a six-character code (DEV-441b's) is not a room any more, nor eight.
    expect(ROOM_CODE_SHAPE.test('K7QX4M')).toBe(false)
    expect(ROOM_ID_SHAPE.test('K7QX4M')).toBe(false)
    expect(ROOM_CODE_SHAPE.test('K7QX4MNP')).toBe(false)
  })

  it('writes the keyspace the DEVIATIONS row states: 28^7 = 13,492,928,512 (DEV-458)', () => {
    expect(ROOM_CODE_ALPHABET.length ** ROOM_CODE_LENGTH).toBe(13_492_928_512)
  })

  it('draws a fresh code in the shape, from the platform random source', () => {
    const code = newRoomCode((n) => {
      const b = new Uint8Array(n)
      globalThis.crypto.getRandomValues(b)
      return b
    })
    expect(code).toMatch(ROOM_CODE_SHAPE)
    expect(ROOM_ID_SHAPE.test(code)).toBe(true)
    expect(isRoomCode(code)).toBe(true)
  })

  it('maps the byte values evenly: nine each, and the last four drawn again', () => {
    // Over every byte value, each character is 9 of them and 252..255 are
    // none. Under a bare `b % 28` those four would be a tenth of the first four
    // characters, the bias the rejection exists to remove.
    const counts = new Map<string, number>()
    let rejected = 0
    for (let b = 0; b < 256; b++) {
      const ch = roomCodeCharOf(b)
      if (ch === null) rejected++
      else counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    expect(rejected).toBe(4)
    expect([...counts.keys()].sort().join('')).toBe([...ROOM_CODE_ALPHABET].sort().join(''))
    for (const [ch, n] of counts) expect(n, ch).toBe(9)
    expect(roomCodeCharOf(252)).toBeNull()
    expect(roomCodeCharOf(251)).toBe(ROOM_CODE_ALPHABET.charAt(251 % 28))
  })

  it('skips a rejected byte and asks for more: only kept bytes make the code', () => {
    // Four rejected bytes, then one good one, cycling; the code is the good one's.
    const code = newRoomCode(cycling([252, 253, 254, 255, 7]))
    expect(code).toBe((ROOM_CODE_ALPHABET.charAt(7) as string).repeat(ROOM_CODE_LENGTH))
  })
})

describe('the round trip through `roomIdFrom` (DEV-441b)', () => {
  it('gives a code back as the room’s name however a person wrote it', () => {
    for (const written of [
      'K7QX4MN',
      'k7qx4mn',
      'K7Q X4MN',
      'k7q-x4mn',
      ' K7Q  X4MN ',
      'k7Q-X4mN',
    ]) {
      expect(roomIdFrom(written), written).toBe('K7QX4MN')
      expect(roomCodeFrom(written), written).toBe('K7QX4MN')
    }
  })

  it('gives a fresh code back unchanged, and as a plate says it', () => {
    const code = newRoomCode((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    expect(roomIdFrom(code)).toBe(code)
    expect(roomIdFrom(roomCodeText(code))).toBe(code)
    expect(roomIdFrom(codeTypedText(code))).toBe(code)
  })

  it('keeps a long id from an older link exactly as it is', () => {
    const long = newRoomId((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
    expect(roomIdFrom(long)).toBe(long)
    expect(isRoomCode(long)).toBe(false)
    expect(roomIdFrom('abcdefghij234567')).toBe('abcdefghij234567')
  })

  it('refuses a look-alike rather than guessing what was meant', () => {
    // O for a zero, I or L for a one, a vowel: not quietly another letter.
    for (const bad of [
      'K7QO4MN',
      'K7Q04MN',
      'K7Q14MN',
      'K7QI4MN',
      'K7QL4MN',
      'KAQX4MN',
      'K7QX4M',
      '',
    ]) {
      expect(roomIdFrom(bad), bad).toBeNull()
    }
    expect(roomIdFrom(null)).toBeNull()
    expect(roomIdFrom('<script>K7QX4MN')).toBeNull()
  })
})

describe('the keys (DEV-441b)', () => {
  it('holds every character of the alphabet once, and three actions', () => {
    const chars = CODE_KEYS.filter((k) => k.char !== null).map((k) => k.char)
    expect(chars.join('')).toBe(ROOM_CODE_ALPHABET)
    expect(CODE_KEYS.filter((k) => k.char === null).map((k) => k.id)).toEqual([
      CODE_ACTION.back,
      CODE_ACTION.del,
      CODE_ACTION.join,
    ])
  })

  it('covers the grid exactly: every cell one key, no key off the plate', () => {
    const cells = new Map<string, string>()
    for (const k of CODE_KEYS) {
      expect(k.col + k.span, k.id).toBeLessThanOrEqual(CODE_COLS)
      expect(k.row, k.id).toBeLessThan(CODE_ROWS)
      for (let c = k.col; c < k.col + k.span; c++) {
        const at = `${c},${k.row}`
        expect(cells.has(at), `${at}: ${cells.get(at)} and ${k.id}`).toBe(false)
        cells.set(at, k.id)
      }
    }
    expect(cells.size).toBe(CODE_COLS * CODE_ROWS)
    for (let r = 0; r < CODE_ROWS; r++)
      for (let c = 0; c < CODE_COLS; c++) expect(codeKeyAt(c, r)).toBeGreaterThanOrEqual(0)
  })

  it('steps one key a nudge, holds at the edges, and leaves a wide key from its middle', () => {
    const two = codeKeyIndex('2')
    expect(codeKeyStep(two, -1, 0)).toBe(two)
    expect(codeKeyStep(two, 0, -1)).toBe(two)
    expect(CODE_KEYS[codeKeyStep(two, 1, 0)]?.id).toBe('3')
    expect(CODE_KEYS[codeKeyStep(two, 0, 1)]?.id).toBe(CODE_KEYS[CODE_COLS]?.id)
    const join = codeKeyIndex(CODE_ACTION.join)
    expect(codeKeyStep(join, 1, 0)).toBe(join)
    expect(codeKeyStep(join, 0, 1)).toBe(join)
    // JOIN covers columns 4..6; up from it lands over its middle, column 5.
    expect(CODE_KEYS[codeKeyStep(join, 0, -1)]?.col).toBe(5)
    expect(CODE_KEYS[codeKeyStep(join, -1, 0)]?.id).toBe(CODE_ACTION.del)
    // From anywhere, enough steps down and right reach JOIN.
    let at = two
    for (let i = 0; i < CODE_ROWS + CODE_COLS; i++) at = codeKeyStep(codeKeyStep(at, 0, 1), 1, 0)
    expect(at).toBe(join)
  })

  it('types, deletes, backs out on nothing, and joins only a whole code', () => {
    const key = (id: string) => CODE_KEYS[codeKeyIndex(id)] as (typeof CODE_KEYS)[number]
    let typed = ''
    for (const ch of 'K7QX4MN') {
      const r = pressCodeKey(typed, key(ch))
      expect(r.outcome).toBe('typed')
      typed = r.typed
    }
    expect(typed).toBe('K7QX4MN')
    expect(pressCodeKey(typed, key('B'))).toEqual({ typed, outcome: 'nothing' })
    expect(pressCodeKey(typed, key(CODE_ACTION.join))).toEqual({ typed, outcome: 'join' })
    expect(pressCodeKey('K7Q', key(CODE_ACTION.join))).toEqual({ typed: 'K7Q', outcome: 'nothing' })
    expect(pressCodeKey('K7Q', key(CODE_ACTION.del))).toEqual({ typed: 'K7', outcome: 'deleted' })
    expect(pressCodeKey('', key(CODE_ACTION.del))).toEqual({ typed: '', outcome: 'back' })
    expect(pressCodeKey('K7Q', key(CODE_ACTION.back))).toEqual({ typed: 'K7Q', outcome: 'back' })
  })

  it('reads a keyboard: either case, Backspace is Delete, a look-alike is nothing', () => {
    expect(codeKeyForKeyboard('k')?.id).toBe('K')
    expect(codeKeyForKeyboard('K')?.id).toBe('K')
    expect(codeKeyForKeyboard('7')?.id).toBe('7')
    expect(codeKeyForKeyboard('Backspace')?.id).toBe(CODE_ACTION.del)
    for (const k of ['o', '0', '1', 'i', 'l', 'a', 'Enter', 'ArrowUp', ' ', 'Shift', 'F5']) {
      expect(codeKeyForKeyboard(k), k).toBeNull()
    }
    expect(codeArrowStep('ArrowLeft')).toEqual({ dCol: -1, dRow: 0 })
    expect(codeArrowStep('ArrowDown')).toEqual({ dCol: 0, dRow: 1 })
    expect(codeArrowStep('k')).toBeNull()
  })

  it('steps with the stick as every plate does: invert applies to rows, one axis a step', () => {
    // `+pitch` is nose down (the stick pushed forward) — the row above, as on
    // the pause plate; `+roll` is the stick to the LEFT.
    expect(codeStickStep(0.9, 0, false)).toEqual({ dCol: 0, dRow: -1 })
    expect(codeStickStep(-0.9, 0, false)).toEqual({ dCol: 0, dRow: 1 })
    expect(codeStickStep(-0.9, 0, true)).toEqual({ dCol: 0, dRow: -1 })
    expect(codeStickStep(0, 0.9, false)).toEqual({ dCol: -1, dRow: 0 })
    expect(codeStickStep(0, -0.9, false)).toEqual({ dCol: 1, dRow: 0 })
    expect(codeStickStep(0.6, -0.9, false)).toEqual({ dCol: 1, dRow: 0 })
    expect(codeStickStep(0.1, 0.1, false)).toEqual({ dCol: 0, dRow: 0 })
  })

  it('shows the code as it is typed, and as a lobby reads it, as a three and a four', () => {
    expect(codeTypedText('')).toBe('___ ____')
    expect(codeTypedText('K7QX')).toBe('K7Q X___')
    expect(codeTypedText('K7QX4MN')).toBe('K7Q X4MN')
    expect(roomCodeText('K7QX4MN')).toBe('K7Q X4MN')
    // A long id keeps DEV-389's fours.
    expect(roomCodeText('abcdefghijklmnop')).toBe('ABCD EFGH IJKL MNOP')
  })
})

describe('the plate (DEV-441b)', () => {
  const plate = new THREE.Object3D()
  placeCodePlate(plate)
  plate.updateMatrixWorld(true)
  const inverse = plate.matrixWorld.clone().invert()
  const eye = new THREE.Vector3(0, 0, 0)
  const hit = (direction: THREE.Vector3): number => {
    const o = eye.clone().applyMatrix4(inverse)
    const d = direction.clone().transformDirection(inverse)
    return pickCodeLocal(o.x, o.y, o.z, d.x, d.y, d.z)
  }

  it('lands on each key through that key’s centre', () => {
    CODE_KEYS.forEach((k, i) => {
      const c = codeKeyCentre(i)
      const centre = plate.localToWorld(new THREE.Vector3(c.x, c.y, 0))
      expect(hit(centre.sub(eye)), k.id).toBe(i)
    })
  })

  it('misses along the flat camera axis, so the keys and the stick keep what they chose', () => {
    expect(hit(new THREE.Vector3(0, 0, -1))).toBe(-1)
  })

  it('ends inside the flat frame and fits the width of a portrait phone', () => {
    const extent = codePlateExtent()
    expect(-extent.bottomDeg).toBeLessThan(FLAT_VFOV / 2 - 3)
    const halfWidth =
      (Math.atan(Math.tan(((FLAT_VFOV / 2) * Math.PI) / 180) * (9 / 19.5)) * 180) / Math.PI
    expect(extent.halfWidthDeg).toBeLessThan(halfWidth)
  })
})

// DEV-632: a code that arrives as a string, from a paste or a phone's own keyboard.
describe('DEV-632: a pasted code or link, and a phone field', () => {
  it('a paste takes a code however it was written, or the room of a whole link', () => {
    expect(codeFromPaste('K7QX4MN')).toBe('K7QX4MN')
    expect(codeFromPaste(' k7q-x4mn \n')).toBe('K7QX4MN')
    expect(codeFromPaste('K7Q X4MN')).toBe('K7QX4MN')
    expect(codeFromPaste('https://facetedflight.net/?room=K7QX4MN')).toBe('K7QX4MN')
    expect(
      codeFromPaste('join me! https://ff-10yr.pages.dev/?edition=classic&room=k7qx4mn&x=1'),
    ).toBe('K7QX4MN')
    // A part of one is typed as far as it goes (the plate says what is missing).
    expect(codeFromPaste('K7Q')).toBe('K7Q')
  })

  it('a paste that is not a code is refused whole, never guessed', () => {
    expect(codeFromPaste('K7QX4M0'), 'a zero is not in the alphabet').toBeNull()
    expect(codeFromPaste('KOQX4MN'), 'nor is an O').toBeNull()
    expect(codeFromPaste('K7QX4MNB'), 'eight is too many').toBeNull()
    expect(codeFromPaste('hello there')).toBeNull()
    expect(codeFromPaste('')).toBeNull()
  })

  it("a phone's field keeps the alphabet's characters, capitalised, at most seven, and a link's room", () => {
    expect(codeCharsOf('k7q')).toBe('K7Q')
    expect(codeCharsOf('k7qo')).toBe('K7Q')
    expect(codeCharsOf('K7Q X4MN')).toBe('K7QX4MN')
    expect(codeCharsOf('K7QX4MNBCD')).toBe('K7QX4MN')
    expect(codeCharsOf('https://facetedflight.net/?room=K7QX4MN')).toBe('K7QX4MN')
  })

  it('every character the field keeps is a key the plate has', () => {
    for (const c of codeCharsOf('abcdefghijklmnopqrstuvwxyz0123456789')) {
      expect(codeKeyForKeyboard(c)?.char).toBe(c)
    }
  })
})
