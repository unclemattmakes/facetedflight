// tests/unit/world-handles.test.ts: the world's handles, one record with one
// owner (APP-SPLIT 3.1, `docs/plan/APP-SPLIT.md` §4a).
//
// `boot/app.ts` used to hold these as closure `let`s, which `buildWorld`
// assigned and `teardownWorld` disposed and nulled one by one in a second list
// kept by hand. The class of bug that invited: a handle a build adds and the
// teardown forgets, which then survives every course swap. Three things now
// stand against it, and this file pins each:
//
//   1. the release table is typed against the record, so a field without a
//      disposer does not compile (the `@ts-expect-error`s below; `tsc` checks
//      them, which is why they are a typecheck gate, not a vitest one);
//   2. the release runs every disposer, in the table's order, before ANY field
//      is emptied, and then empties every field (so the teardown cannot
//      half-release a world);
//   3. the record has one owner: only the world's builders write a handle, and
//      `teardownWorld` writes none (it releases through the table).

import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  type Disposers,
  disposeWorldHandles,
  emptyWorldHandles,
  releaseHandles,
  resetOnly,
  type WorldDisposers,
  type WorldHandles,
} from '@/boot/app/world-handles'
import { appFiles } from './helpers/app-source'

const FIELDS = Object.keys(emptyWorldHandles()) as (keyof WorldHandles)[]

/** A table that does nothing but record what it was handed, in order. */
const recording = (): { table: WorldDisposers; calls: [keyof WorldHandles, unknown][] } => {
  const calls: [keyof WorldHandles, unknown][] = []
  const table = Object.fromEntries(
    FIELDS.map((k) => [k, (v: unknown) => calls.push([k, v])]),
  ) as unknown as WorldDisposers
  return { table, calls }
}

describe('the release table is the record, field for field', () => {
  it('will not compile with a field missing or a field invented', () => {
    const { table } = recording()
    // A field left out of the table: the mirror-list bug, refused by the type.
    const { flight: _flight, ...missing } = table
    // @ts-expect-error a table without `flight` is not a WorldDisposers
    const short: WorldDisposers = missing
    // A disposer for a field the record does not have.
    const long: WorldDisposers = {
      ...table,
      // @ts-expect-error `notAHandle` is not a field of WorldHandles
      notAHandle: resetOnly,
    }
    expect(Object.keys(short)).not.toContain('flight')
    expect(Object.keys(long)).toContain('notAHandle')
  })

  it('has fields to release (the loud counterpart: an empty record passes everything)', () => {
    expect(FIELDS.length).toBeGreaterThan(0)
    expect(FIELDS).toContain('flight')
    expect(FIELDS).toContain('liveTerrain')
  })
})

describe('the empty record', () => {
  it('is every handle null and every list empty', () => {
    const empty = emptyWorldHandles()
    for (const k of FIELDS) {
      const v = empty[k]
      if (v === null) continue
      expect(v instanceof Set ? v.size : (v as readonly unknown[]).length, k).toBe(0)
    }
  })

  it('is a NEW object with NEW lists every time, so a release never shares one', () => {
    const a = emptyWorldHandles()
    const b = emptyWorldHandles()
    expect(a).not.toBe(b)
    for (const k of FIELDS) {
      if (a[k] !== null) expect(a[k], k).not.toBe(b[k])
    }
  })
})

describe('the release', () => {
  interface Toy {
    a: { id: string } | null
    b: string[]
    c: number | null
  }
  const emptyToy = (): Toy => ({ a: null, b: [], c: null })

  it('runs each disposer once, in table order, with the value it held', () => {
    const h: Toy = { a: { id: 'x' }, b: ['y'], c: 3 }
    const before = { ...h }
    const order: string[] = []
    const seen: unknown[] = []
    const table: Disposers<Toy> = {
      c: (v) => {
        order.push('c')
        seen.push(v)
      },
      a: (v) => {
        order.push('a')
        seen.push(v)
      },
      b: (v) => {
        order.push('b')
        seen.push(v)
      },
    }
    releaseHandles(h, table, emptyToy)
    expect(order).toEqual(['c', 'a', 'b'])
    expect(seen).toEqual([before.c, before.a, before.b])
  })

  it('empties no field until every disposer has run', () => {
    const h: Toy = { a: { id: 'x' }, b: ['y'], c: 3 }
    const sawSiblings: unknown[] = []
    releaseHandles(
      h,
      {
        a: () => sawSiblings.push(h.c),
        b: () => sawSiblings.push(h.a),
        c: () => sawSiblings.push(h.b),
      },
      emptyToy,
    )
    expect(sawSiblings).toEqual([3, { id: 'x' }, ['y']])
  })

  it('leaves every field empty, with fresh lists', () => {
    const list = ['y']
    const h: Toy = { a: { id: 'x' }, b: list, c: 3 }
    releaseHandles(h, { a: resetOnly, b: resetOnly, c: resetOnly }, emptyToy)
    expect(h).toEqual(emptyToy())
    expect(h.b).not.toBe(list)
  })

  it('releases the real record: every world handle through its own disposer, then empty', () => {
    const h = emptyWorldHandles()
    // A distinct stand-in in every field, so each disposer can be checked
    // against exactly the value its field held.
    const tokens = new Map<keyof WorldHandles, unknown>()
    for (const k of FIELDS) {
      const token = { field: k }
      tokens.set(k, token)
      ;(h as unknown as Record<string, unknown>)[k] = token
    }
    const { table, calls } = recording()
    disposeWorldHandles(h, table)
    expect(calls.map(([k]) => k)).toEqual(FIELDS)
    for (const [k, v] of calls) expect(v, k).toBe(tokens.get(k))
    expect(h).toEqual(emptyWorldHandles())
  })
})

describe('one owner', () => {
  /**
   * Every assignment `handles.<field> = ...` (or `??=`, `+=`...) in the boot tree, with the
   * outermost named function it sits in (`<top>` for the closure's own body).
   * Parsed, not grepped: a comment that spells an assignment cannot count.
   */
  const writes = (): { field: string; fn: string; file: string }[] => {
    const out: { field: string; fn: string; file: string }[] = []
    for (const { file, text } of appFiles()) {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
      const outerFn = (n: ts.Node): string => {
        let name = '<top>'
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (
            (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
            ts.isVariableDeclaration(p.parent) &&
            ts.isIdentifier(p.parent.name) &&
            p.parent.name.text !== 'bootApp' &&
            // A moved module's factory (`export const createX = (ctx) => {`) stands
            // where `bootApp` stood: the writer is the function inside it.
            !(
              /^create[A-Z]/.test(p.parent.name.text) &&
              ts.isSourceFile(p.parent.parent.parent.parent)
            )
          ) {
            // A phase of the frame (DEV-975) is the frame: it was one function.
            name = /^phase[A-Z]/.test(p.parent.name.text) ? 'frame' : p.parent.name.text
          }
        }
        return name
      }
      const visit = (n: ts.Node): void => {
        if (
          ts.isBinaryExpression(n) &&
          // `=`, and every compound form: the probe's gain is recorded with `??=`.
          n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          ts.isPropertyAccessExpression(n.left) &&
          ts.isIdentifier(n.left.expression) &&
          (n.left.expression.text === 'handles' ||
            // A moved module writes a handle through its ctx setter (APP-SPLIT §6
            // rule 3), which forwards to `handles`: the writer is the module's function.
            (n.left.expression.text === 'ctx' &&
              (FIELDS as readonly string[]).includes(n.left.name.text)))
        ) {
          out.push({ field: n.left.name.text, fn: outerFn(n), file })
        }
        ts.forEachChild(n, visit)
      }
      visit(sf)
    }
    return out
  }

  it('finds the writes it is meant to judge (an empty sweep passes for ever)', () => {
    const found = writes()
    expect(found.length).toBeGreaterThan(0)
    expect(found.map((w) => w.fn)).toContain('buildWorld')
  })

  it('is written only by the world builders and the named few, and never by the teardown', () => {
    // The builders write the world in; `switchMission` re-aims the sun and the
    // sky at each course; `applyCourseClearing` re-masks the scatter for a
    // player's line; the frame retires the title's curtain once it has lifted
    // and records the mission probe's gain the first time it dims it; and the
    // closure's own body lights the boot level. The TEARDOWN is not here: it
    // releases through `disposeWorldHandles`. A new writer is a decision, so it
    // goes in this list on purpose.
    const writers = new Set(writes().map((w) => w.fn))
    expect([...writers].sort()).toEqual(
      [
        '<top>',
        'applyCourseClearing',
        'buildTitleWorld',
        'buildWorld',
        'frame',
        'switchMission',
      ].sort(),
    )
  })

  it('names only fields of the record', () => {
    for (const w of writes()) expect(FIELDS, `${w.file}: handles.${w.field}`).toContain(w.field)
  })
})
