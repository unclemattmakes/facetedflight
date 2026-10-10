// tests/unit/music-filter.test.ts: music that listens (DEV-645).
//
// The curve is pure, so the assertions are about its SHAPE, as relationships: a
// closed door is darker than a race, a race is darker than open, the opening only
// ever goes one way, and a boost lifts a shelf and never a volume.

import { describe, expect, it } from 'vitest'
import { createRecordingBackend } from '@/audio/backend'
import { createAudioSystem } from '@/audio/index'
import {
  MUSIC_FILTER,
  MUSIC_FILTER_OPEN,
  type MusicListening,
  musicFilterChanged,
  musicFilterFor,
  openingProgress,
} from '@/audio/music-filter'

const racing = (over: Partial<MusicListening> = {}): MusicListening => ({
  paused: false,
  crashBlack: false,
  boosting: false,
  racing: true,
  gatesLeft: 10,
  ...over,
})

describe('the curve', () => {
  it('a menu, the pad and the title are open and flat: the soundtrack is untouched', () => {
    expect(
      musicFilterFor({
        paused: false,
        crashBlack: false,
        boosting: true,
        racing: false,
        gatesLeft: 2,
      }),
    ).toEqual(MUSIC_FILTER_OPEN)
  })

  it('ordering: a closed door < a race < open', () => {
    const door = musicFilterFor(racing({ paused: true })).lowpassHz
    const race = musicFilterFor(racing()).lowpassHz
    expect(door).toBeLessThan(race)
    expect(race).toBeLessThan(MUSIC_FILTER.openHz)
  })

  it('a pause and a crash black both close it, and a closed door has no boost lift', () => {
    for (const over of [{ paused: true }, { crashBlack: true }]) {
      const f = musicFilterFor(racing({ ...over, boosting: true }))
      expect(f.lowpassHz).toBe(MUSIC_FILTER.duckedHz)
      expect(f.highShelfDb).toBe(0)
    }
  })

  it('boost lifts the shelf and leaves the cutoff alone', () => {
    const calm = musicFilterFor(racing())
    const boost = musicFilterFor(racing({ boosting: true }))
    expect(boost.highShelfDb).toBeGreaterThan(calm.highShelfDb)
    expect(boost.highShelfDb).toBeGreaterThan(0)
    expect(boost.lowpassHz).toBe(calm.lowpassHz)
  })

  it('opens over the LAST THREE gates, monotonically, ending fully open', () => {
    const hz = (left: number | null): number =>
      musicFilterFor(racing({ gatesLeft: left })).lowpassHz
    // With three or more to take it sits at the race floor.
    expect(hz(MUSIC_FILTER.openingGates)).toBe(MUSIC_FILTER.raceHz)
    expect(hz(50)).toBe(MUSIC_FILTER.raceHz)
    // Then it opens as gates are taken: each fewer gate left is no lower.
    const walk = [3, 2, 1, 0].map(hz)
    for (let i = 1; i < walk.length; i++)
      expect(walk[i] as number).toBeGreaterThan(walk[i - 1] as number)
    expect(walk[3]).toBeCloseTo(MUSIC_FILTER.openHz, 6)
  })

  it('the opening is even in octaves: equal ratios per gate (a cutoff is heard in octaves)', () => {
    const hz = (left: number): number => musicFilterFor(racing({ gatesLeft: left })).lowpassHz
    expect(hz(2) / hz(3)).toBeCloseTo(hz(1) / hz(2), 9)
    expect(hz(1) / hz(2)).toBeCloseTo(hz(0) / hz(1), 9)
  })

  it('no objective count is no opening (null, NaN)', () => {
    expect(openingProgress(null)).toBe(0)
    expect(openingProgress(Number.NaN)).toBe(0)
    expect(openingProgress(-4)).toBe(1)
  })

  it('the race floor sits between the closed door and open, with the door well below it', () => {
    expect(MUSIC_FILTER.duckedHz).toBeLessThan(MUSIC_FILTER.raceHz / 4)
    expect(MUSIC_FILTER.raceHz).toBeLessThan(MUSIC_FILTER.openHz)
  })

  it('a change smaller than the ear can hear is no change', () => {
    expect(musicFilterChanged(MUSIC_FILTER_OPEN, { lowpassHz: 20000.5, highShelfDb: 0.001 })).toBe(
      false,
    )
    expect(musicFilterChanged(MUSIC_FILTER_OPEN, { lowpassHz: 18000, highShelfDb: 0 })).toBe(true)
    expect(musicFilterChanged(MUSIC_FILTER_OPEN, { lowpassHz: 20000, highShelfDb: 3.5 })).toBe(true)
  })
})

describe('through the audio system', () => {
  it('tells the backend only when the target moves, and never touches a volume', () => {
    const backend = createRecordingBackend()
    const system = createAudioSystem({ backend })
    const filterCalls = (): number => backend.calls.filter((c) => c.call === 'musicFilter').length
    system.setMusicListening(racing({ gatesLeft: 20 }))
    expect(filterCalls()).toBe(1)
    expect(backend.musicFilter.lowpassHz).toBe(MUSIC_FILTER.raceHz)
    // The same state for a hundred frames is one call.
    for (let i = 0; i < 100; i++) system.setMusicListening(racing({ gatesLeft: 20 }))
    expect(filterCalls()).toBe(1)
    system.setMusicListening(racing({ gatesLeft: 20, paused: true }))
    expect(filterCalls()).toBe(2)
    expect(backend.musicFilter.lowpassHz).toBe(MUSIC_FILTER.duckedHz)
    // Volumes untouched: the only gain call is none at all.
    expect(backend.calls.filter((c) => c.call === 'musicGain')).toHaveLength(0)
  })

  it('a second system does not move the first (trap 19)', () => {
    const a = createRecordingBackend()
    const b = createRecordingBackend()
    const sa = createAudioSystem({ backend: a })
    const sb = createAudioSystem({ backend: b })
    sa.setMusicListening(racing({ paused: true }))
    sb.setMusicListening(racing())
    expect(a.musicFilter.lowpassHz).toBe(MUSIC_FILTER.duckedHz)
    expect(b.musicFilter.lowpassHz).toBe(MUSIC_FILTER.raceHz)
  })
})
