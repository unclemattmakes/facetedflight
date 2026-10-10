// tests/unit/helpers/tv-race.ts: a RECORDED race for TV's camera. DEV-481.
//
// NOT a `.test.ts`, so vitest does not collect it. The camera's gates ask
// about behaviour "over a recorded race", so the race is 2016's own: the two
// `int_01` flights in `content/ghosts/` (first-party recordings, committed),
// flown together from their launch, plus three more seats flown by the same
// two recordings a beat later so the field is DEV-125's five. Nothing here is
// synthesised motion: every pose is a recorded one, sampled the way
// `game/ghosts.ts` samples it (THREE world = worldOffset + the pose).

import * as THREE from 'three'
import { type Level, validateLevel } from '@/content/level-schema'
import type { TvCraft } from '@/game/tv/tv-camera'
import { decodeGhostClip, type GhostClip, type GhostDoc, sampleGhost } from '@/sim/ghost'
import fastDoc from '../../../content/ghosts/int_01_leftSpawn_fast_01.json'
import slowDoc from '../../../content/ghosts/int_01_rightSpawn_slow_01.json'
import int01Json from '../../../content/levels/int_01_hoverJet.json'

export const INT01: Level = validateLevel(int01Json as unknown as Level)

const FAST = decodeGhostClip(fastDoc as unknown as GhostDoc)
const SLOW = decodeGhostClip(slowDoc as unknown as GhostDoc)

/** The five seats: a recording and how late it leaves, seconds. */
const SEATS: readonly { clip: GhostClip; delay: number }[] = [
  { clip: FAST, delay: 0 },
  { clip: SLOW, delay: 0 },
  { clip: FAST, delay: 1.1 },
  { clip: SLOW, delay: 0.7 },
  { clip: FAST, delay: 2.3 },
]

/** How long the race runs, seconds: the slower recording to its end, and the latest seat. */
export const RACE_SECONDS = Math.max(
  ...SEATS.map((s) => s.clip.duration - s.clip.launchAt + s.delay),
)

/** A craft list that `at(t)` refills: the same objects every call, as a renderer's would be. */
export const recordedRace = (): { craft: TvCraft[]; at: (t: number) => readonly TvCraft[] } => {
  const pose = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
  const o = INT01.worldOffset
  const craft = SEATS.map((_, i) => ({
    id: `seat:${i}`,
    name: `Racer ${i + 1}`,
    racer: i + 1,
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
  }))
  const at = (t: number): readonly TvCraft[] => {
    SEATS.forEach((s, i) => {
      sampleGhost(s.clip, s.clip.launchAt + Math.max(0, t - s.delay), pose)
      const c = craft[i] as (typeof craft)[number]
      c.position.set(o[0] + pose.px, o[1] + pose.py, o[2] + pose.pz)
      c.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw)
    })
    return craft
  }
  return { craft, at }
}
