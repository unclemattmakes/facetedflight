// tests/unit/helpers/lap-variant-courses.ts — lap courses with a second aircraft variant. DEV-372.
//
// When this was written the HoverJet's aircraft file held one variant,
// `standard` (DEV-381 adds the others), so the committed courses cannot show a
// board per variant. This builds the artefact the committed one is built by —
// `buildLapCourses`, the same levels and editions — from the real aircraft file
// plus one FIXTURE variant, `fixture-fast`: `ship.maxSpeed` x 1.5, a key the
// aircraft schema allows. Nothing in `content/` changes; the variant exists
// only in the object this returns.

import type { Aircraft } from '@/content/aircraft-schema'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import type { LapCourses } from '@/net/lap-courses'
import { buildLapCourses } from '@/net/lap-courses-build'
import hoverjet from '../../../content/aircraft/hoverjet.json'
import anniversaryJson from '../../../content/editions/anniversary.json'
import classicJson from '../../../content/editions/classic.json'
import int01 from '../../../content/levels/int_01_hoverJet.json'

export const FIXTURE_VARIANT = 'fixture-fast'
export const FIXTURE_SPEED_SCALE = 1.5

export const variantCourses = (): LapCourses => {
  const base = hoverjet as unknown as Aircraft
  const aircraft: Aircraft = {
    ...base,
    variants: [
      ...base.variants,
      {
        id: FIXTURE_VARIANT,
        name: 'Fixture',
        blurb: 'a test fixture, never in content/',
        scale: { 'ship.maxSpeed': FIXTURE_SPEED_SCALE },
      },
    ],
  }
  return buildLapCourses(
    [int01 as unknown as Level],
    [anniversaryJson, classicJson] as unknown as Edition[],
    [aircraft],
  )
}
