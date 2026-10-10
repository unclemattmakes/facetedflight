import { describe, expect, it } from 'vitest'
import { type PoseFields, poseRecord, restPoseFields } from '@/net/pose-codec'
import { drawnPose } from '@/net/remote-track'
import { POSE_KIND } from '@/net/room-protocol'

// Reuse audit, last clones (DEV-781): `poseRecord` and `drawnPose` wrote the
// fifteen rest-pose numbers out twice. They share `restPoseFields` now. This
// oracle keeps the two ORIGINAL literals and compares KEY ORDER and every value
// with Object.is, and pins that each call hands out a fresh object (both are
// reused hot-path records: a shared one would be two owners, trap 19).

const legacyPoseRecord = () => ({
  kind: POSE_KIND.own,
  index: 0,
  flags: 0,
  px: 0,
  py: 0,
  pz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: 0,
  vy: 0,
  vz: 0,
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
})

const legacyDrawnPose = () => ({
  mode: 'none',
  stale: false,
  flags: 0,
  px: 0,
  py: 0,
  pz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  vx: 0,
  vy: 0,
  vz: 0,
  pitch: 0,
  roll: 0,
  yaw: 0,
  throttle: 0,
})

const sameObject = (actual: object, expected: object): void => {
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
  for (const key of Object.keys(expected)) {
    expect(
      Object.is(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      ),
    ).toBe(true)
  }
}

describe('rest pose, old literals against the shared one (DEV-781)', () => {
  it('poseRecord() is the old literal, key order included', () => {
    sameObject(poseRecord(), legacyPoseRecord())
  })

  it('drawnPose() is the old literal, key order included', () => {
    sameObject(drawnPose(), legacyDrawnPose())
  })

  it('every call is a fresh object, and so is the shared fields factory', () => {
    const a = poseRecord()
    const b = poseRecord()
    a.px = 5
    expect(b.px).toBe(0)
    const d = drawnPose()
    d.qw = 0.5
    expect(drawnPose().qw).toBe(1)
    const f: PoseFields = restPoseFields()
    f.vx = 9
    expect(restPoseFields().vx).toBe(0)
  })
})
