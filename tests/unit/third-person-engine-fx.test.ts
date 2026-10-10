// DEV-836: the HoverJet's engines under `Art/ThirdPerson`, read off the prefab.
import { describe, expect, it } from 'vitest'
import { type ExtractedParticle, thirdPersonGroup } from '@/game/particle-fx'
import { HOVERJET } from '@/generated/constants.generated'

const specs = HOVERJET.particles as unknown as ExtractedParticle[]
const input = HOVERJET.input as unknown as Record<string, { ref?: { fileID?: string } | null }>
const idOf = (key: string): string | null => input[key]?.ref?.fileID ?? null

describe('the exterior hull engines (DEV-836)', () => {
  it('the throttle plays fx_thruster_gameplay 2 and its two faceted children', () => {
    const group = thirdPersonGroup(specs, idOf('jetFX'))
    expect(group.map((p) => p.name)).toEqual([
      'fx_thruster_gameplay 2',
      'fx_facetedAfterburner_gameplay 2 (1)',
      'fx_facetedAfterburner_gameplay 2 (2)',
    ])
  })

  it('the boost plays fx_afterburner_gameplay 2 (1) and its child', () => {
    const group = thirdPersonGroup(specs, idOf('afterburnerFX'))
    expect(group.map((p) => p.name)).toEqual([
      'fx_afterburner_gameplay 2 (1)',
      'fx_afterburner_gameplay 2 (2)',
    ])
  })

  it('none of them is the ghost copy under playbackGhost', () => {
    for (const key of ['jetFX', 'afterburnerFX']) {
      for (const p of thirdPersonGroup(specs, idOf(key))) {
        expect(
          p.ancestors.some((a) => a.name === 'playbackGhost'),
          p.name,
        ).toBe(false)
        // ThirdPerson is the one switched-off node; the whole group hangs under it.
        expect(p.ancestors.filter((a) => !a.active).map((a) => a.name)).toEqual(['ThirdPerson'])
      }
    }
  })

  it('a system that is not a lead gives nothing', () => {
    expect(thirdPersonGroup(specs, null)).toEqual([])
    expect(thirdPersonGroup(specs, 'no-such-id')).toEqual([])
  })
})
