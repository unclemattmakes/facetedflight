// src/game/orbs.ts — energy orbs, turned into something the sim can collect.
//
// Game rules, not physics, and THREE-FREE: `game/mission.ts` imports this and
// has to keep running headless. The orb ART is `game/orb-art.ts`.
//
// ── Free Flight's one working mechanic ────────────────────────────────────
//
// The orb is the only piece of either unimplemented mode that shipped WORKING in
// 2016, and the asymmetry that makes it a mode is one line:
//
//     EnergySystem_Ship.cs:277   finaleLogic.CheckScore();   // orbs do this
//     TriggerCheckpoint.cs:94-97 ++energySystem.gatesCleared // rings do not
//
// An orb increments the same counter a ring does AND asks the finale to re-score,
// which is why a Free Flight medal is awarded **in the air**, the instant the
// count reaches a threshold, as a 2.5 s banner. `docs/research/_modes-spec.md`
// §3.3, §5.2.
//
// ── Where the radius comes from, and why it is not in the JSON ────────────
//
// `Prefabs/EnergyOrb.prefab` is two GameObjects. The root carries a 12.98 m
// `SphereCollider` and `Trigger_Magnet`; the CHILD `sphere_fancy_lod_01`
// carries `SphereCollider m_Radius 3` and `Trigger_EnergyOrb`, at
// `localScale (1.6284001, 1.6284006, 1.6284006)`. Unity sizes a sphere collider
// by `radius * max|lossyScale|`, so the collection volume is the product below.
// The level JSON carries an orb's position and its magnet `speed` but no radius
// and no scale. One number serves every orb a running mode SCORES: of the 181
// shipped instances, only three have a root scale that is not 1 — 0.2849, all
// in `int_01_jumpSeat`, a Target Practice mission whose orbs nothing collects
// (`PROPS.energyOrb.rootScaleOverrides`, DEV-327). This comment used to say
// "every shipped instance is at root scale 1"; the sweep says otherwise.
//
// ── The magnet is NOT ported, and the flagship mission is why ─────────────
//
// `Trigger_Magnet` lerps the orb onto the ship over about four seconds once you
// enter its 12.98 m sphere, so in 2016 the effective reach is wider than the
// 4.885 m above. It is per-instance data (`_meta.magnetComponentEnabled`) and it
// is **false on all 11 of `hoverJet_kauai_beg`'s orbs** — the one forced-Free-
// Flight HoverJet mission, the flagship for this mode — and false on
// `int_01_hoverJet`'s 11. It is true only on `int_01_jumpSeat`'s 23, where orbs
// are inert anyway (the JumpSeat has no `EnergySystem_Ship`, §3.4). So porting
// it would add motion to missions that do not use it. Left out deliberately;
// the data is in the JSON when someone wants it.

import type { Level, Orb as OrbRow } from '@/content/level-schema'
import { PROPS } from '@/generated/constants.generated'
import { v3 } from '@/sim/math/vec3'
import type { Orb } from '@/sim/orbs'

/**
 * World collection radius, metres — written as the product it is.
 *
 * `Trigger_EnergyOrb`'s own `SphereCollider m_Radius 3`, times the largest
 * component of `sphere_fancy_lod_01`'s local scale (1.6284006): 4.885 m. Both
 * are read off `Prefabs/EnergyOrb.prefab` by the extractor since DEV-327 —
 * this was a typed `3 * 1.6284006` while the prefab interior was not in the
 * sheet — and the eight shipped scenes that restate the radius all say 3.
 */
export const ORB_COLLECT_RADIUS =
  PROPS.energyOrb.triggerRadius * Math.max(...PROPS.energyOrb.art.scale)

/**
 * The orbs a run can collect.
 *
 * `live` is already the extractor's hierarchy walk. It matters: `int_02_jumpSeat`
 * — the mission 2016 FORCES into Free Flight — ships 12 orbs with every one
 * `m_IsActive: 0`, and `adv_01_hoverJet` and `int_02_hoverJet` the same. **A Free
 * Flight run on `int_02_jumpSeat` can score nothing at all.** That is 2016, and
 * it is a fact to preserve rather than a gap to fill.
 */
export const liveOrbs = (level: Level): OrbRow[] => level.orbs.filter((o) => o.live)

/**
 * Where an orb actually is — DEV-067's one door.
 *
 * 2016 built `hoverJet_kauai_beg` by copying `int_01_hoverJet` onto a second
 * island and never re-authoring the orb scatter, which is byte-identical. Simonet
 * is mostly open water; kauai is one mountain; so five of the eleven finish
 * INSIDE it, by up to 619 m — in 2016's own bake as well as ours (DEV-062). Free
 * Flight scores orbs and `sim/terrain-collision.ts` pushes the hull out of the
 * ground, so those five are unreachable rather than merely ugly. The extractor
 * raises them to the least clearance 2016 itself gives a live orb on this island
 * and emits `posFf2` beside the untouched `pos`, exactly as `medalsFf2` sits
 * beside `medals`. `docs/DEVIATIONS.md` DEV-067.
 *
 * **Everything that reads an orb position goes through here.** The sim's hit test
 * and the art are two constants that must stay equal, and the orientation lesson
 * §5 is explicit that the way to keep them equal is to make them the same object
 * rather than to test two copies. An orb you can see and cannot collect is the
 * exact bug this file exists to prevent.
 */
export const orbPos = (orb: OrbRow): OrbRow['pos'] => orb.posFf2 ?? orb.pos

/** Into SIM space — the same z flip every trigger centre goes through. */
export const orbSpheres = (level: Level): Orb[] =>
  liveOrbs(level).map((orb) => {
    const p = orbPos(orb)
    return { centre: v3(p[0], p[1], -p[2]), radius: ORB_COLLECT_RADIUS }
  })
