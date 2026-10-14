// tests/unit/hud-bars-look.test.ts: DEV-791 (QUESTIONS-FOR-MATT item 7).
//
// Matt, 2026-10-07 ("go with your recs"): Classic draws no HUD bars at all, as
// 2016 did. DEV-615 had kept the gate combo's countdown and the boost tank on
// both looks, because the bars came from gameplay flags (`chainMeter`,
// `energy`), which D35 makes Anniversary's on BOTH looks. So the bars need a
// LOOK flag of their own, `hud.bars`, and the app feeds the panel its two bars
// only through it.
//
// Three claims, each against something outside this test's own arithmetic:
//   - the flag's value in the two presets' own files (Classic off, Anniversary on);
//   - the composed Classic look over Anniversary's rules: bars off, the rules
//     that make the bars' mechanics (the chain, the tank) still Anniversary's
//     and still on, which is why a LOOK flag is the right place (a gameplay
//     flag would change the board);
//   - the wiring: the app reads the flag where it builds `chain` and the
//     HoverJet's `energy`, and no other bar's content is gated by it. The
//     panel's own painter already draws no bar when those two are absent
//     (`hud-dash.test.ts`: "Classic draws 2016's five words and nothing else").

import { describe, expect, it } from 'vitest'
import { type Edition, editionFeatures } from '@/content/edition-schema'
import { EDITION_KEY_CLASS, lookOnRules } from '@/content/edition-split'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const ANNIVERSARY = anniversaryJson as unknown as Edition
const CLASSIC = classicJson as unknown as Edition

describe('hud.bars is the look’s two bars (DEV-791)', () => {
  it('is off in Classic and on in Anniversary, in their own files', () => {
    expect(CLASSIC.hud.bars.enabled).toBe(false)
    expect(ANNIVERSARY.hud.bars.enabled).toBe(true)
  })

  it('is a look flag and a feature, so the Classic look takes it and the rules do not', () => {
    expect(EDITION_KEY_CLASS['hud.bars']?.class).toBe('look')
    expect(editionFeatures(ANNIVERSARY).map(([path]) => path)).toContain('hud.bars')
    const worn = lookOnRules(CLASSIC, ANNIVERSARY)
    expect(worn.hud.bars.enabled).toBe(false)
    // The mechanics under the bars are Anniversary's rules and keep running.
    expect(worn.gameplay.chainMeter.enabled).toBe(true)
    expect(worn.gameplay.energy.enabled).toBe(true)
  })

  // Removed (DEV-967): "the app reads the flag where it builds the combo and the tank", two regexes
  // over the exact expressions in the boot closure. They failed on any rewording and proved no pixel.
  // The painter's half stays held by hud-dash.test.ts ("Classic draws 2016's five words and nothing else").
})
