// tests/unit/history-loop.test.ts: the loop of an edit, once (code-reuse BE-14).
//
// The desk, the shipped desk and the bench each hand-rolled `apply`/`step`
// around `record`, with their own guards (`busy`, `dragging`, a history that is
// null until the level loads) and, on the main desk, a side effect (the
// pad-turn note cleared on every real change). `createHistoryLoop` is the part
// that was identical, with the guard and the side effect passed in.
//
// The proof is a differential one: the three OLD closures are kept below
// verbatim as the oracle, and one scripted stream of operations (edits, drag
// edits that coalesce, no-op edits, undo, redo, seal, a busy flag and a
// dragging flag flipping, a late load) is run through each old host and its new
// twin. After EVERY operation the history, the count of `changed` calls and the
// note must be equal, and a no-op must fire nothing.

import { describe, expect, it } from 'vitest'
import {
  createHistory,
  createHistoryLoop,
  type DraftKind,
  type History,
  record,
  redo,
  seal,
  undo,
} from '@/editor/core'

interface D {
  readonly v: number
  readonly sel: number
}
const KIND: DraftKind<D> = { edits: (d) => [d.v], saved: (d) => d.v }
const initial: D = { v: 0, sel: 0 }

type Op =
  | { t: 'edit'; v: number; sel: number; coalesce?: string }
  | { t: 'same' }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'seal' }
  | { t: 'busy'; on: boolean }
  | { t: 'dragging'; on: boolean }
  | { t: 'note' }
  | { t: 'load' }
  | { t: 'idle-step' }

const lcg = (seed: number) => {
  let s = seed >>> 0
  return (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const script = (seed: number, n: number): Op[] => {
  const rnd = lcg(seed)
  const ops: Op[] = []
  for (let i = 0; i < n; i++) {
    const r = rnd()
    if (r < 0.3) ops.push({ t: 'edit', v: Math.floor(rnd() * 6), sel: Math.floor(rnd() * 3) })
    else if (r < 0.45)
      ops.push({
        t: 'edit',
        v: Math.floor(rnd() * 6),
        sel: 0,
        coalesce: `move:${Math.floor(rnd() * 2)}`,
      })
    else if (r < 0.5) ops.push({ t: 'same' })
    else if (r < 0.6) ops.push({ t: 'undo' })
    else if (r < 0.68) ops.push({ t: 'redo' })
    else if (r < 0.74) ops.push({ t: 'seal' })
    else if (r < 0.8) ops.push({ t: 'busy', on: rnd() < 0.5 })
    else if (r < 0.86) ops.push({ t: 'dragging', on: rnd() < 0.5 })
    else if (r < 0.9) ops.push({ t: 'note' })
    else if (r < 0.92) ops.push({ t: 'load' })
    else ops.push({ t: 'idle-step' })
  }
  return ops
}

interface Snap {
  readonly history: History<D> | null
  readonly changed: number
  readonly note: string
}

/** A host: the same surface for an old closure set and its new twin. */
interface Host {
  edit(next: D, coalesce?: string): void
  step(f: (h: History<D>) => History<D>): void
  present(): D | null
  snap(): Snap
  setBusy(on: boolean): void
  setDragging(on: boolean): void
  setNote(): void
  load(): void
}

/** The main desk's old `apply`/`step`, verbatim (desk/index.ts before BE-14). */
const oldDesk = (): Host => {
  let history: History<D> = createHistory(initial, KIND)
  let busy = false
  let dragging = false
  let padTurnNote = ''
  let changedN = 0
  const changed = (): void => {
    changedN++
  }
  const apply = (next: D, coalesce?: string): void => {
    if (busy) return
    const before = history
    history = record(history, next, coalesce ? { coalesce } : {})
    if (history !== before) {
      padTurnNote = ''
      changed()
    }
  }
  const step = (f: (h: History<D>) => History<D>): void => {
    if (busy || dragging) return
    const before = history
    history = f(history)
    if (history !== before) {
      padTurnNote = ''
      changed()
    }
  }
  return {
    edit: apply,
    step,
    present: () => history.present,
    snap: () => ({ history, changed: changedN, note: padTurnNote }),
    setBusy: (on) => {
      busy = on
    },
    setDragging: (on) => {
      dragging = on
    },
    setNote: () => {
      padTurnNote = 'turn left 12 degrees'
    },
    load: () => {
      history = createHistory(initial, KIND)
    },
  }
}

const newDesk = (): Host => {
  let history: History<D> = createHistory(initial, KIND)
  let busy = false
  let dragging = false
  let padTurnNote = ''
  let changedN = 0
  const loop = createHistoryLoop<D>({
    get: () => history,
    set: (h) => {
      history = h
    },
    changed: () => {
      changedN++
    },
    onMoved: () => {
      padTurnNote = ''
    },
    canEdit: () => !busy,
    canStep: () => !busy && !dragging,
  })
  return {
    edit: loop.edit,
    step: loop.step,
    present: () => history.present,
    snap: () => ({ history, changed: changedN, note: padTurnNote }),
    setBusy: (on) => {
      busy = on
    },
    setDragging: (on) => {
      dragging = on
    },
    setNote: () => {
      padTurnNote = 'turn left 12 degrees'
    },
    load: () => {
      history = createHistory(initial, KIND)
    },
  }
}

/** The shipped desk's old pair: the same guards, no side effect. */
const oldShipped = (): Host => {
  let history: History<D> = createHistory(initial, KIND)
  let busy = false
  let dragging = false
  let changedN = 0
  const changed = (): void => {
    changedN++
  }
  const apply = (next: D, coalesce?: string): void => {
    if (busy) return
    const before = history
    history = record(history, next, coalesce ? { coalesce } : {})
    if (history !== before) changed()
  }
  const step = (f: (h: History<D>) => History<D>): void => {
    if (busy || dragging) return
    const before = history
    history = f(history)
    if (history !== before) changed()
  }
  return {
    edit: apply,
    step,
    present: () => history.present,
    snap: () => ({ history, changed: changedN, note: '' }),
    setBusy: (on) => {
      busy = on
    },
    setDragging: (on) => {
      dragging = on
    },
    setNote: () => {},
    load: () => {
      history = createHistory(initial, KIND)
    },
  }
}

const newShipped = (): Host => {
  let history: History<D> = createHistory(initial, KIND)
  let busy = false
  let dragging = false
  let changedN = 0
  const loop = createHistoryLoop<D>({
    get: () => history,
    set: (h) => {
      history = h
    },
    changed: () => {
      changedN++
    },
    canEdit: () => !busy,
    canStep: () => !busy && !dragging,
  })
  return {
    edit: loop.edit,
    step: loop.step,
    present: () => history.present,
    snap: () => ({ history, changed: changedN, note: '' }),
    setBusy: (on) => {
      busy = on
    },
    setDragging: (on) => {
      dragging = on
    },
    setNote: () => {},
    load: () => {
      history = createHistory(initial, KIND)
    },
  }
}

/** The bench's old `apply` (a nullable history, no flags) and its `edit` on top of it. */
const oldBench = (): Host => {
  let history: History<D> | null = null
  let changedN = 0
  const changed = (): void => {
    changedN++
  }
  const apply = (f: (h: History<D>) => History<D>): void => {
    if (!history) return
    const before = history
    history = f(history)
    if (history !== before) changed()
  }
  const edit = (next: (d: D) => D, coalesce?: string): void =>
    apply((h) => record(h, next(h.present), coalesce ? { coalesce } : {}))
  return {
    edit: (next, coalesce) => edit(() => next, coalesce),
    step: apply,
    present: () => history?.present ?? null,
    snap: () => ({ history, changed: changedN, note: '' }),
    setBusy: () => {},
    setDragging: () => {},
    setNote: () => {},
    load: () => {
      history = createHistory(initial, KIND)
    },
  }
}

const newBench = (): Host => {
  let history: History<D> | null = null
  let changedN = 0
  const loop = createHistoryLoop<D>({
    get: () => history,
    set: (h) => {
      history = h
    },
    changed: () => {
      changedN++
    },
  })
  const apply = loop.step
  const edit = (next: (d: D) => D, coalesce?: string): void =>
    apply((h) => record(h, next(h.present), coalesce ? { coalesce } : {}))
  return {
    edit: (next, coalesce) => edit(() => next, coalesce),
    step: apply,
    present: () => history?.present ?? null,
    snap: () => ({ history, changed: changedN, note: '' }),
    setBusy: () => {},
    setDragging: () => {},
    setNote: () => {},
    load: () => {
      history = createHistory(initial, KIND)
    },
  }
}

const run = (host: Host, ops: readonly Op[], onEach: (i: number) => void): void => {
  ops.forEach((op, i) => {
    switch (op.t) {
      case 'edit':
        host.edit({ v: op.v, sel: op.sel }, op.coalesce)
        break
      case 'same': {
        const p = host.present()
        if (p) host.edit(p)
        break
      }
      case 'undo':
        host.step(undo)
        break
      case 'redo':
        host.step(redo)
        break
      case 'seal':
        host.step(seal)
        break
      case 'idle-step':
        host.step((h) => h)
        break
      case 'busy':
        host.setBusy(op.on)
        break
      case 'dragging':
        host.setDragging(op.on)
        break
      case 'note':
        host.setNote()
        break
      case 'load':
        host.load()
        break
    }
    onEach(i)
  })
}

const pairs: readonly [string, () => Host, () => Host][] = [
  ['the main desk (busy and dragging guards, the pad-turn note)', oldDesk, newDesk],
  ['the shipped desk (the same guards, no side effect)', oldShipped, newShipped],
  ['the bench (a history that loads late, no flags)', oldBench, newBench],
]

describe('createHistoryLoop is each host old apply/step (BE-14)', () => {
  for (const [name, mkOld, mkNew] of pairs) {
    it(`${name}: 4 scripts of 600 operations, equal after every one`, () => {
      for (const seed of [1, 2, 3, 4]) {
        const ops = script(seed * 7919, 600)
        const a = mkOld()
        const b = mkNew()
        const trace: Snap[] = []
        run(a, ops, () => trace.push(a.snap()))
        run(b, ops, (i) => {
          const got = b.snap()
          const want = trace[i] as Snap
          expect(got.changed, `seed ${seed} op ${i} ${JSON.stringify(ops[i])}`).toBe(want.changed)
          expect(got.note, `seed ${seed} op ${i} note`).toBe(want.note)
          expect(got.history, `seed ${seed} op ${i} history`).toEqual(want.history)
        })
        // The script really exercised the loop: edits landed, and the guards held some back.
        expect((trace.at(-1) as Snap).changed).toBeGreaterThan(20)
      }
    })
  }

  it('a result that is the same history fires nothing, and the note survives it', () => {
    const h = newDesk()
    h.setNote()
    h.step((x) => x)
    h.edit(initial) // the present itself: record returns the same history
    expect(h.snap().changed).toBe(0)
    expect(h.snap().note).toBe('turn left 12 degrees')
    h.edit({ v: 1, sel: 0 })
    expect(h.snap().changed).toBe(1)
    expect(h.snap().note).toBe('')
  })

  it('busy blocks an edit and a step; dragging blocks only a step', () => {
    const h = newShipped()
    h.setDragging(true)
    h.edit({ v: 1, sel: 0 })
    expect(h.snap().changed).toBe(1)
    h.step(undo)
    expect(h.snap().changed).toBe(1)
    h.setDragging(false)
    h.setBusy(true)
    h.edit({ v: 2, sel: 0 })
    h.step(undo)
    expect(h.snap().changed).toBe(1)
    h.setBusy(false)
    h.step(undo)
    expect(h.snap().changed).toBe(2)
    expect(h.present()).toEqual(initial)
  })

  it('a history that is not there yet makes every call a no-op (the bench before load)', () => {
    const h = newBench()
    h.edit({ v: 1, sel: 0 })
    h.step(undo)
    expect(h.snap().history).toBeNull()
    expect(h.snap().changed).toBe(0)
    h.load()
    h.edit({ v: 1, sel: 0 })
    expect(h.snap().changed).toBe(1)
  })
})
