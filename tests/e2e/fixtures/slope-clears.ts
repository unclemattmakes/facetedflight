/**
 * tests/e2e/fixtures/slope-clears.ts — what DEV-356's slope limit removes.
 *
 * The same arrangement as `no-prop-volumes.ts`, for the same reason. The
 * census in `spawn-clearing.spec.ts` holds every pass to the conservation law
 * `held + cleared === placements.count`, and **that law is green with the
 * limit entirely off**: nothing cleared, `held` is the whole blob, the equation
 * balances. So two readers close it from opposite sides, and neither
 * re-derives the other:
 *
 *   - `tests/unit/prop-slope.test.ts` expands the COMMITTED placement blobs in
 *     node, looks every one up on the rendered facet of the real height map,
 *     and pins the count here. That is the content half.
 *   - `tests/e2e/spawn-clearing.spec.ts` reads what the BROWSER's load path
 *     says it removed, off each pass group's `userData.clearedBySlope`. That
 *     is the runtime half.
 *
 * The runtime counts AFTER the authored volumes (DEV-287), which take a
 * corridor of trees off the pad before the slope is asked, so the spec holds
 * the browser's figure inside `[pinned - clearedByVolumes, pinned]` for each
 * pass — a bracket a few dozen wide round a number in the thousands, which a
 * limit read against the wrong grid, the wrong params or the wrong map cannot
 * land in by accident.
 */

/** The environment both suites measure: `CORRIDOR_MISSION`'s, alpine. */
export const SLOPE_CLEARS_ENVIRONMENT = 'alpine'

/**
 * The `props.maxSlope.sin` the counts below were taken at. The unit test holds
 * `content/editions/anniversary.json` to it, so moving the limit in the preset
 * without moving these is a red test rather than a silent bracket miss.
 */
export const SLOPE_CLEARS_SIN = 0.7

/**
 * Placements on a rendered facet steeper than {@link SLOPE_CLEARS_SIN}, per
 * pass, keyed `<environment>:<entry.index>` as the census keys them — BEFORE
 * any authored volume.
 *
 * **Edit this on purpose or not at all.** It moves when the limit moves, when
 * the scatter is re-baked, or when the terrain's jitter seed or generator
 * changes the facets — each a change somebody should acknowledge in one place.
 * DEV-831 moved them (1869 and 1814 on 2016's diagonal): the slope limit is
 * Anniversary's, and Anniversary's facets now take the fixed diagonal.
 */
export const SLOPE_CLEARS: Readonly<Record<string, number>> = {
  'alpine:0': 1785,
  'alpine:1': 1693,
}
