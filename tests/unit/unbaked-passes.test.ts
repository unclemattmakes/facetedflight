/**
 * tests/unit/unbaked-passes.test.ts — which scatter passes each preset draws.
 *
 * DEV-102, settled by Matt on 2026-09-14: *"keep em for anniversary"*. The port
 * drew five passes across four environments; 2016 shipped two. Rather than pick
 * one of those to throw away, the preset system carries both — **Classic draws
 * what 2016 SHIPPED, Anniversary draws what 2016 SET UP** — and this file is
 * what stops that sentence from being only a sentence.
 *
 * `props-2016-bake.test.ts` is the sibling and it answers a different question:
 * *is the `shipped2016` receipt on each pass TRUE*, checked against the 2016
 * files by a second derivation, behind a `$FF2_LEGACY` gate CI does not have.
 * This file answers *does the code DO anything with it*, needs no legacy tree,
 * and runs everywhere — which matters, because a receipt nothing reads is
 * documentation and not a guard (DEV-069).
 *
 * No GL context: `shippedIn2016` is a predicate over content.
 */
import { describe, expect, it } from 'vitest'
import type { Edition } from '@/content/edition-schema'
import { editionFeatures } from '@/content/edition-schema'
import type { PropScatter } from '@/content/load-environment'
import { shippedIn2016 } from '@/game/props/load-props'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'
import alpineJson from '../../content/environments/alpine.json'
import desertJson from '../../content/environments/desert.json'
import kauaiJson from '../../content/environments/kauai.json'
import simonetJson from '../../content/environments/simonet.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

const ENVIRONMENTS: readonly [string, { scatter: readonly PropScatter[] }][] = [
  ['simonet', simonetJson as unknown as { scatter: readonly PropScatter[] }],
  ['kauai', kauaiJson as unknown as { scatter: readonly PropScatter[] }],
  ['alpine', alpineJson as unknown as { scatter: readonly PropScatter[] }],
  ['desert', desertJson as unknown as { scatter: readonly PropScatter[] }],
]

describe('DEV-102 — the count is the predicate, not the flag', () => {
  it('every pass in every environment carries its receipt', () => {
    // The guard the predicate's `?? 0` exists for. A pass with no `shipped2016`
    // answers "not shipped", which is the safe direction — but an environment
    // that HAS one is a bug in the extractor, and it would otherwise show up as
    // trees quietly missing from Classic rather than as a failure here.
    for (const [id, env] of ENVIRONMENTS) {
      for (const entry of env.scatter) {
        expect(entry.shipped2016, `${id} pass ${entry.index} has a receipt`).toBeTruthy()
        expect(
          typeof entry.shipped2016?.bakedObjects,
          `${id} pass ${entry.index} counts its objects`,
        ).toBe('number')
      }
    }
  })

  it('reads the COUNT and ignores the component flag', () => {
    // DEV-102's lesson in one assertion. Alpine's big-tree pass is BOTH
    // disabled and empty, so it cannot separate the two readings — these two
    // synthetic entries can, and they are the case the row is about: a pass
    // that was switched off but had already baked its objects still drew them,
    // because by then they are GameObjects in the scene and nothing re-runs the
    // generator at play time.
    const disabledButBaked = { shipped2016: { componentEnabled: false, bakedObjects: 4242 } }
    const enabledButEmpty = { shipped2016: { componentEnabled: true, bakedObjects: 0 } }
    expect(shippedIn2016(disabledButBaked as unknown as PropScatter)).toBe(true)
    expect(shippedIn2016(enabledButEmpty as unknown as PropScatter)).toBe(false)
  })

  it('splits the five passes two/three, which is the whole finding', () => {
    const all = ENVIRONMENTS.flatMap(([id, env]) => env.scatter.map((s) => [id, s] as const))
    const shipped = all.filter(([, s]) => shippedIn2016(s))
    // Five passes; 2016 ran two, and they are alpine's Tree_Organic and
    // desert's. Named rather than counted, because "2 of 5" would still pass if
    // the two were the wrong two.
    expect(all).toHaveLength(5)
    expect(shipped.map(([id]) => id).sort()).toEqual(['alpine', 'desert'])
    // And the three that were not: both island palm generators, and alpine's
    // second pass. Simonet and Kauai lose their ONLY pass on Classic, which is
    // the part worth stating out loud — Classic draws no scatter at all there.
    const unshipped = all.filter(([, s]) => !shippedIn2016(s))
    expect(unshipped.map(([id]) => id).sort()).toEqual(['alpine', 'kauai', 'simonet'])
  })
})

describe('DEV-102 — the presets disagree, and only here', () => {
  it('Classic is off and Anniversary is on', () => {
    expect(classic.props.unbakedPasses.enabled).toBe(false)
    expect(anniversary.props.unbakedPasses.enabled).toBe(true)
  })

  it('is in the switchable-feature list, so Classic-is-all-off covers it', () => {
    // The DEV-069 trap, and it had already happened twice in this file's
    // neighbourhood: a flag that exists, is read, and is in no list. The
    // "Classic has every flag off" test walks `editionFeatures`, so being
    // absent from it means being unchecked by the one test that would notice.
    const paths = editionFeatures(anniversary).map(([p]) => p)
    expect(paths).toContain('props.unbakedPasses')
    // Its neighbour from the same session, for the same reason.
    expect(paths).toContain('fx.gatePulse')
  })

  it('leaves the 2016 passes byte-identical between presets', () => {
    // The flag ADDS; it must never re-author. Both presets read the same
    // `content/environments/*.json`, so the two passes 2016 baked are the same
    // objects in the same places under either — and `loadProps` seeds each pass
    // from `entry.index`, the index in the ENVIRONMENT rather than in the
    // filtered list, so alpine's surviving pass does not shift when the pass
    // beside it is switched off. That indexing is the thing this pins.
    const alpine = (alpineJson as unknown as { scatter: readonly PropScatter[] }).scatter
    const kept = alpine.filter(shippedIn2016)
    expect(kept).toHaveLength(1)
    // Alpine's baked pass is the SECOND entry, so a filtered list would
    // renumber it to 0 and reseed it. The index it carries is its own.
    expect(alpine.indexOf(kept[0] as PropScatter)).toBe(1)
    expect(kept[0]?.index).toBe(1)
  })
})
