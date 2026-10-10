// src/game/speed-gauge.ts — the speed gauge's full scale, for the jet in hand.
// DEV-380.
//
// `render/hud-gauges.ts`'s `HUD_GAUGE_SPEED_FULL_SCALE` (DEV-257) is a number:
// the HoverJet's boosted terminal with a full `int_01` chain, 339.79 m/s. An
// aircraft variant moves that terminal — the speed variant's chained boosted
// terminal is about 564 m/s (AIRCRAFT-VARIANTS §3.1), so 2016's scale would
// peg the needle for most of a lap. This derives the same quantity from the
// jet's OWN sheet through `sim/speed-chain.ts`'s `terminalSpeed()`, and
// `tests/unit/variant-data.test.ts` holds it, for 2016's sheet, to the pinned
// constant BIT FOR BIT — so `standard`'s panel is the panel it always was.
//
// Here and not in `render/hud-gauges.ts` because that module is import-poor by
// design and says so: it takes the full scale as an option and never imports
// the sim. This is the option's one producer.

import type { HoverJetSheet } from '@/sim/hoverjet'
import { terminalSpeed } from '@/sim/speed-chain'

/**
 * The chain length the full scale is drawn for: `int_01_hoverJet`'s scored
 * gates, which is the course DEV-257 sized the gauge on. Not per-mission, for
 * the reasons `HUD_GAUGE_SPEED_FULL_SCALE`'s header gives (a question for
 * Matt, unchanged by variants). The unit test counts `int_01`'s live gates
 * and holds this to them.
 */
export const SPEED_GAUGE_CHAIN_GATES = 21

/**
 * Full scale for the speed gauge, m/s: `sheet`'s jet under continuous boost
 * with a full chain of `SPEED_GAUGE_CHAIN_GATES` gates.
 */
export const speedGaugeFullScale = (sheet: HoverJetSheet): number =>
  terminalSpeed(
    sheet.ship.maxSpeed + sheet.speedChain.speedIncreaseAmt * SPEED_GAUGE_CHAIN_GATES,
    sheet.ship.boostMultiplier,
    sheet.rigidbody.mass,
    sheet.rigidbody.drag,
  )
