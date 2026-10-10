// tests/unit/perf-capture.test.ts
//
// The property this exists to hold: **a capture that records N runs hands back
// N runs, in the order they were flown.** That sounds too obvious to test, and
// it is the exact thing the recorder it wraps gets wrong — `?trace=` arms once,
// saves once, and writes one storage key that the next run overwrites, so three
// flights through it leave one trace.
//
// No DOM, no clock, no storage: `boot/perf-capture.ts` is state and a payload
// so that this can be asserted without a page, which is the only way it gets
// asserted at all (`pnpm e2e` never runs unattended).
import { describe, expect, it } from 'vitest'
import {
  CAPTURE_VERSION,
  captureFileName,
  captureRowValue,
  createPerfCapture,
} from '@/boot/perf-capture'

const run = (
  mission: string,
  csvRows = 2,
): { mission: string; edition: string; summary: unknown; csv: string } => ({
  mission,
  edition: 'anniversary',
  summary: { frames: 100, mission },
  csv: `dt_ms,frame_ms\n${'16.7,4.2\n'.repeat(csvRows)}`,
})

describe('a perf capture spans runs', () => {
  it('keeps every run, in flight order, numbered from one', () => {
    const c = createPerfCapture()
    c.start()
    c.add(run('int_01_hoverJet'))
    c.add(run('rookie_02_hoverJet'))
    c.add(run('adv_01_jumpSeat'))
    expect(c.runs).toBe(3)
    expect(c.missions).toEqual(['int_01_hoverJet', 'rookie_02_hoverJet', 'adv_01_jumpSeat'])
    const out = c.stop()
    expect(out.runs.map((r) => r.index)).toEqual([1, 2, 3])
    expect(out.runs.map((r) => r.mission)).toEqual([
      'int_01_hoverJet',
      'rookie_02_hoverJet',
      'adv_01_jumpSeat',
    ])
    expect(out.kind).toBe('ff2-perf-capture')
    expect(out.version).toBe(CAPTURE_VERSION)
  })

  it('drops a run that finishes after the player stopped', () => {
    // A trace armed before the stop can complete after it. Queueing it would
    // put a run nobody chose to record into the NEXT session's file.
    const c = createPerfCapture()
    c.start()
    c.add(run('int_01_hoverJet'))
    c.stop()
    c.add(run('a-straggler'))
    expect(c.runs).toBe(1)
    expect(c.missions).toEqual(['int_01_hoverJet'])
  })

  it('records nothing before it is started', () => {
    const c = createPerfCapture()
    c.add(run('int_01_hoverJet'))
    expect(c.runs).toBe(0)
    expect(c.recording).toBe(false)
  })

  it('clears the previous session on start, rather than appending to it', () => {
    const c = createPerfCapture()
    c.start()
    c.add(run('first'))
    c.stop()
    c.start()
    c.add(run('second'))
    expect(c.missions).toEqual(['second'])
  })

  it('can be exported twice — stopping does not empty it', () => {
    // The download can be refused by the browser; the caller then falls back to
    // storage, and both have to see the same runs.
    const c = createPerfCapture()
    c.start()
    c.add(run('int_01_hoverJet'))
    const stopped = c.stop()
    expect(c.payload().runs).toHaveLength(1)
    expect(c.payload().runs).toEqual(stopped.runs)
  })
})

describe('the digest is the half that fits in storage', () => {
  it('carries the summaries and NOT the csv', () => {
    // The split is the point: a run is ~half a megabyte of CSV and a few of
    // those exceed what localStorage holds, failing on the LAST write — after
    // the earlier runs looked like they worked.
    const c = createPerfCapture()
    c.start()
    c.add(run('int_01_hoverJet', 5000))
    const d = c.digest()
    expect(d.runs[0]?.summary).toEqual({ frames: 100, mission: 'int_01_hoverJet' })
    expect(JSON.stringify(d)).not.toContain('16.7,4.2')
    // And it is genuinely small — asserted as a RELATIONSHIP to the full
    // payload rather than against a byte count this test would have to guess.
    expect(JSON.stringify(d).length).toBeLessThan(JSON.stringify(c.payload()).length / 100)
  })
})

describe('what the player and the filesystem see', () => {
  it('the row says what pressing it will do', () => {
    const c = createPerfCapture()
    expect(captureRowValue(c)).toBe('OFF')
    c.start()
    expect(captureRowValue(c)).toBe('ON')
    c.add(run('a'))
    c.add(run('b'))
    expect(captureRowValue(c)).toBe('ON · 2')
    c.stop()
    expect(captureRowValue(c)).toBe('2 SAVED')
  })

  it('the filename is legal on Windows and sorts by time', () => {
    // This machine is the one the Frame streams from, so the file lands in a
    // Windows Downloads folder — where a colon is not a legal character and an
    // un-stamped name becomes "… (3)", which tells a reader nothing.
    const a = captureFileName(new Date('2026-09-17T18:04:05.678Z'))
    expect(a).toBe('ff2-perf-capture-2026-09-17_18-04-05.json')
    expect(a).not.toMatch(/[:*?"<>|]/)
    const b = captureFileName(new Date('2026-09-17T18:04:06.000Z'))
    expect([b, a].sort()).toEqual([a, b])
  })
})
