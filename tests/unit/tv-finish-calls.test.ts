// DEV-871: the finish call names the place a racer crossed in, not a place among
// the racers still flying. Matt, 2026-10-08: racers left after others had finished
// were announced as "#1".

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createTvCamera } from '@/game/tv/tv-camera'
import { createFinishTracker, createStandingsTracker } from '@/game/tv/tv-standings'
import { tvBoundsOf, tvCourseOf } from '@/game/tv/tv-vantage'
import { INT01, RACE_SECONDS, recordedRace } from './helpers/tv-race'

describe('the finish tracker', () => {
  it('names three racers finishing in order 1, 2, 3, each once', () => {
    const t = createFinishTracker()
    expect(t.step([])).toEqual([])
    expect(t.step([])).toEqual([])
    expect(t.step(['a'])).toEqual([{ id: 'a', place: 1 }])
    expect(t.step(['a'])).toEqual([])
    expect(t.step(['a', 'b'])).toEqual([{ id: 'b', place: 2 }])
    expect(t.step(['a', 'b', 'c'])).toEqual([{ id: 'c', place: 3 }])
    expect(t.step(['a', 'b', 'c'])).toEqual([])
    expect(t.placeOf('b')).toBe(2)
    expect(t.placeOf('zz')).toBeNull()
  })

  it('two crossing on one frame take consecutive places in the order given', () => {
    const t = createFinishTracker()
    t.step([])
    expect(t.step(['x', 'y'])).toEqual([
      { id: 'x', place: 1 },
      { id: 'y', place: 2 },
    ])
  })

  it('says nothing about racers already home when the viewer arrives', () => {
    const t = createFinishTracker()
    expect(t.step(['a', 'b'])).toEqual([])
    expect(t.step(['a', 'b', 'c'])).toEqual([{ id: 'c', place: 3 }])
  })

  it('a new race starts again from 1st', () => {
    const t = createFinishTracker()
    t.step([])
    t.step(['a'])
    t.step([])
    expect(t.step(['b'])).toEqual([{ id: 'b', place: 1 }])
  })

  it('an overtake among the racers still flying counts from 1 (why the camera adds those home)', () => {
    const s = createStandingsTracker()
    s.step(['c', 'b'], 0)
    const gains = s.step(['b', 'c'], 1)
    expect(gains[0]?.to).toBe(1)
  })
})

describe('the camera reports the crossing place and lifts overtakes past the finishers', () => {
  it('lastFinish places run 1, 2, 3 and an overtake never lands inside the finished', () => {
    const race = recordedRace()
    let t = 0
    const cam = createTvCamera({
      craft: () => race.at(t),
      presenting: () => false,
      heightAt: () => 100,
      bounds: tvBoundsOf(INT01),
      course: tvCourseOf(INT01),
      headsetCuts: () => false,
    })
    const rig = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
    const camera = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
    const places: number[] = []
    let finished = 0
    let lastN = 0
    let overtakeN = 0
    const DT = 1 / 90
    for (let f = 0; f < Math.ceil(RACE_SECONDS / DT); f++) {
      t = f * DT
      cam.frame(DT, rig, camera)
      const r = cam.report()
      if (r.lastFinish && r.lastFinish.n !== lastN) {
        lastN = r.lastFinish.n
        places.push(r.lastFinish.place)
        finished = Math.max(finished, r.lastFinish.place)
      }
      if (r.lastOvertake && r.lastOvertake.n !== overtakeN) {
        overtakeN = r.lastOvertake.n
        expect(r.lastOvertake.to).toBeGreaterThan(finished)
      }
    }
    expect(places.length).toBeGreaterThan(1)
    expect(places).toEqual(places.map((_, i) => i + 1))
  })
})
