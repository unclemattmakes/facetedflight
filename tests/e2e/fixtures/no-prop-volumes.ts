/**
 * tests/e2e/fixtures/no-prop-volumes.ts — what DEV-287's volumes actually remove.
 *
 * ONE exported name for a number two suites need, which is CLAUDE.md's own
 * worked example (`HUD_RASTER_SHIPPED`): *"give the default ONE exported name,
 * let the spec import it, and pin its VALUE in a single unit assertion somebody
 * has to edit on purpose."*
 *
 * ── Why this number needs two readers ────────────────────────────────────
 *
 * `spawn-clearing.spec.ts` asserts the conservation law
 * `held + cleared === placements.count`, and on its own **that law is green
 * when the volumes are entirely off**: with nothing culled, `cleared` is 0,
 * `held` is the whole blob, and the equation balances. So the spec that went
 * red to catch DEV-287 would say nothing if `withoutVolumes` stopped being
 * called, if the resolved list stopped reaching `loadProps`, or if the pass
 * group stopped publishing its receipt. The `?? 0` that makes the census
 * tolerant of a pass built before DEV-287 is the same tolerance that would
 * make it silent about the feature being broken.
 *
 * The two readers close it from opposite sides, and neither re-derives the
 * other:
 *
 *   - `tests/unit/no-prop-volumes.test.ts` walks the COMMITTED placement blobs
 *     in node, resolves the authored volumes against each mission, and pins the
 *     count here. That is the content half.
 *   - `tests/e2e/spawn-clearing.spec.ts` reads what the BROWSER's load path
 *     reports it removed, and compares it with the same number. That is the
 *     runtime half.
 *
 * Agreement between them is the claim. It catches the case the conservation law
 * cannot reach on its own: `boot/app.ts` resolving a volume against a different
 * context than the unit test builds, culling a different set, reporting it
 * honestly, and satisfying `held + cleared === count` at any magnitude.
 */

/**
 * The mission both suites measure. `spawn-clearing.spec.ts` boots it, and
 * `no-prop-volumes.test.ts` resolves the corridor against its pad and its first
 * gate.
 */
export const CORRIDOR_MISSION = 'rookie_01_hoverJet'

/**
 * Placements `alpine`'s `launch-corridor` removes on {@link CORRIDOR_MISSION},
 * across both of that environment's scatter passes (36 + 36).
 *
 * **Edit this on purpose or not at all.** It moves when the corridor's radius
 * moves, when the scatter is re-baked, or when the spawn or the first gate
 * moves — and every one of those is a change somebody should have to
 * acknowledge in one place rather than discover in two red suites. The radius
 * that produced it is argued in `content/no-prop-volumes.json`'s own `why`,
 * against the sweep 19 / 43 / 72 / 97 / 165 at 30 / 50 / 60 / 70 / 100 m.
 */
export const CORRIDOR_CLEARS = 72

/**
 * And the SAME volume on the other alpine HoverJet course removes nothing.
 *
 * The more interesting half of the measurement, kept beside the first so it
 * cannot be dropped as noise: it is one authored volume resolving against
 * another pad and another first gate, and finding no trees at any radius up to
 * 100 m. Zero here is what says the corridor is a rule about launch sites
 * rather than a number tuned until one screenshot looked right.
 */
export const CORRIDOR_CLEARS_INT_02 = 0

/**
 * Placements alpine's `rookie-01-climb-out` removes on {@link CORRIDOR_MISSION}
 * on its own, across both scatter passes: the DEV-364 follow-up (Matt,
 * 2026-09-25, call 8), which clears the crowns the racers' lanes climb out of
 * gate 0 over. Scoped to that mission; it removes nothing anywhere else.
 *
 * **Edit this on purpose or not at all**, for {@link CORRIDOR_CLEARS}'s reasons.
 * The radius is argued in the volume's own `why`, and
 * `tests/unit/racer-lanes-clear.test.ts` is what it is for.
 */
export const CLIMB_OUT_CLEARS = 59

/**
 * Every placement the authored volumes remove on {@link CORRIDOR_MISSION}: the
 * launch corridor and the climb-out together. What the BROWSER's load path must
 * report (`spawn-clearing.spec.ts`), and not the sum of the two: a placement
 * inside both is removed once.
 */
export const CORRIDOR_MISSION_CLEARS = 103
