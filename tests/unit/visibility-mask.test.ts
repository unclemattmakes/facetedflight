// tests/unit/visibility-mask.test.ts — the lens-mask recorder records. DEV-331.
//
// What the flight will answer (does Chrome send a mask, and how much of the eye
// does it cover) cannot be tested here. What can be: that the recorder keeps
// what an event carries, that the area is the area, and that `boot/enter-vr.ts` attaches
// it BEFORE `setSession`, because the initial events fire at session start and
// a listener attached after three's awaits may miss them. That last one is
// structural: nothing else would notice two lines swapping.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTraceRecorder, formatTraceSummary } from '@/boot/perf-trace'
import { createVisibilityMaskRecorder, meshArea } from '@/boot/visibility-mask'
import { REPO } from './helpers/repo-root'

/** A session that can fire the event, and nothing else. */
const fakeSession = () => {
  const listeners: ((e: never) => void)[] = []
  return {
    addEventListener: (type: string, fn: (e: never) => void) => {
      if (type === 'visibilitymaskchange') listeners.push(fn)
    },
    fire: (e: unknown) => {
      for (const fn of listeners) fn(e as never)
    },
  }
}

describe('the lens-mask recorder (DEV-331)', () => {
  it('measures an indexed 2D mesh: a unit square in two triangles is 1', () => {
    const square = [0, 0, 1, 0, 1, 1, 0, 1]
    expect(meshArea(square, [0, 1, 2, 0, 2, 3])).toBeCloseTo(1, 12)
    // Winding does not make area negative.
    expect(meshArea(square, [0, 2, 1, 0, 3, 2])).toBeCloseTo(1, 12)
  })

  it('keeps what each event carries, per eye', () => {
    const recorder = createVisibilityMaskRecorder(() => true)
    const session = fakeSession()
    recorder.watch(session)
    session.fire({
      eye: 'left',
      index: 0,
      vertices: new Float32Array([0, 0, 2, 0, 0, 2]),
      indices: new Uint32Array([0, 1, 2]),
    })
    session.fire({
      eye: 'right',
      index: 1,
      vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    })
    const r = recorder.report()
    expect(r.supported).toBe(true)
    expect(r.watched).toBe(1)
    expect(r.eyes.map((e) => [e.eye, e.index, e.triangles, e.ownArea])).toEqual([
      ['left', 0, 1, 2],
      ['right', 1, 1, 0.5],
    ])
    expect(r.eyes[0]?.vertices).toEqual([0, 0, 2, 0, 0, 2])
  })

  it('says so when nothing was ever watched, and when the event is not exposed', () => {
    const r = createVisibilityMaskRecorder(() => false).report()
    expect(r).toEqual({ supported: false, watched: 0, eyes: [] })
    const throwing = createVisibilityMaskRecorder(() => {
      throw new Error('no XRSession here')
    }).report()
    expect(throwing.supported).toBe(false)
  })

  it('reaches the stored capture: the trace summary carries it, and its text says it', () => {
    const recorder = createVisibilityMaskRecorder(() => true)
    const session = fakeSession()
    recorder.watch(session)
    session.fire({
      eye: 'left',
      index: 0,
      vertices: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    })
    const t = createTraceRecorder()
    t.start(1, { mission: 'rookie_01_hoverJet', visibilityMask: recorder.report() })
    t.stop()
    expect(t.summary().visibilityMask?.eyes[0]?.ownArea).toBe(0.5)
    expect(formatTraceSummary(t.summary())).toContain('lens mask: event exposed')
    // And a trace armed without one says nothing rather than something false.
    const bare = createTraceRecorder()
    bare.start(1, { mission: 'rookie_01_hoverJet' })
    bare.stop()
    expect(bare.summary().visibilityMask).toBeUndefined()
    expect(formatTraceSummary(bare.summary())).not.toContain('lens mask')
  })

  // DEV-557: the request moved out of `main.ts` with the landing card, into
  // `boot/enter-vr.ts`, which the title's plate and the pause row share.
  it('is attached in boot/enter-vr.ts BEFORE setSession', () => {
    const src = fs.readFileSync(path.join(REPO, 'src/boot/enter-vr.ts'), 'utf8')
    const watch = src.indexOf('visibilityMask.watch(session)')
    const set = src.indexOf('sink.setSession(session)')
    expect(watch, 'enter-vr.ts watches the session').toBeGreaterThan(0)
    expect(set, 'enter-vr.ts hands the session to three').toBeGreaterThan(0)
    expect(watch).toBeLessThan(set)
  })
})
