import { describe, expect, it } from 'vitest'
import { type PoseFields, poseRecord } from '@/net/pose-codec'
import { drawnPose, type TrackInput } from '@/net/remote-track'

// XC-23: the three pose shapes share ONE field list (`PoseFields`) and the two
// zero factories share one rest literal (`restPoseFields`, DEV-781), so this
// pins the relationship between them: the
// wire record and the drawn pose carry the same fifteen numbers, each with the
// other's value, and the record satisfies the track's read-only input.

const fieldsOf = (o: object, extra: readonly string[]): string[] =>
  Object.keys(o)
    .filter((k) => !extra.includes(k))
    .sort()

describe('PoseFields (XC-23)', () => {
  it('a PoseRecord and a DrawnPose carry the same fifteen fields', () => {
    const wire = fieldsOf(poseRecord(), ['kind', 'index'])
    const drawn = fieldsOf(drawnPose(), ['mode', 'stale'])
    expect(wire).toHaveLength(15)
    expect(drawn).toEqual(wire)
  })

  it('both factories start at the same rest pose (identity rotation, nothing moving)', () => {
    const wire = poseRecord()
    const drawn = drawnPose()
    for (const key of fieldsOf(wire, ['kind', 'index']) as (keyof PoseFields)[]) {
      expect(drawn[key]).toBe(wire[key])
    }
    expect(wire.qw).toBe(1)
  })

  it('a PoseRecord is a valid TrackInput without copying', () => {
    const input: TrackInput = poseRecord()
    expect(input.qw).toBe(1)
  })
})
