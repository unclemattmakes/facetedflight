/**
 * tests/e2e/fixtures/stage-arms.ts — which groups an arm hides, decided in node.
 *
 * DEV-226. `xr-vrto3d-trace.spec.ts` measures the cost model's 3.13 ms floor by
 * flying the same mission with one group taken away (SUBTRACTIVE) or with one
 * group and nothing else (ADDITIVE). Both come down to the same question —
 * *which of the stage's groups end up invisible* — and that question is pure
 * arithmetic over a list of names.
 *
 * ── Why it is HERE and not inside the `page.evaluate` ────────────────────
 *
 * Because the one rule that decides whether the additive table means anything
 * has to be provable without a headset:
 *
 *     **A LIGHT IS NEVER AN ARM'S TO HIDE.**
 *
 * `WebGLRenderer.projectObject` returns early on `visible === false` *before*
 * it pushes a light (the same mechanism as DEV-043's masked key light), so a
 * solo that hid the sun along with everything else would render its group
 * **unlit** — a different program, a different fragment cost, and a number
 * comparable with nothing else in either table. It would not look wrong. It
 * would look like a cheap group.
 *
 * The guard is structural rather than a check: `StageKeys` separates `drawable`
 * from `lights`, every planner below works over `drawable` alone, and so a
 * planner **cannot name a light** whatever it is asked for. Asking to solo one
 * comes back as `missing`, which fails the run. `tests/unit/stage-arms.test.ts`
 * pins it, and the spec asserts the runtime half — that the number of lights
 * three would gather is the same after the arm as before it.
 *
 * ── The keys are the CENSUS's keys ───────────────────────────────────────
 *
 * `boot/render-census.ts`'s `rowKey()`: a top-level child of the stage, except
 * under `world-terrain`, which expands one level (`world-terrain/chunks`,
 * `world-terrain/props:simonet`, ...) because the land's chunks and its scatter
 * are separate answers. So an arm names the same thing `perf-out/census-all/`
 * ranks, and the two can be read against each other.
 *
 * That makes the key set a TREE, and both planners honour it: hiding a parent
 * hides its children by three's own hierarchy, and soloing a child must leave
 * its ancestors alone or it hides itself.
 */

/** What the stage offers an arm. Lights are listed, never planned over. */
export interface StageKeys {
  /** Drawable groups, as `render-census.ts`'s `rowKey()` names them. */
  readonly drawable: readonly string[]
  /** Lights, so the report can say how many there were. An arm never touches one. */
  readonly lights: readonly string[]
}

export interface ArmPlan {
  /** Keys to set `visible = false`. Reduced to roots — a parent covers its children. */
  readonly hide: readonly string[]
  /** Names the arm asked for that the stage does not have. Non-empty fails the run. */
  readonly missing: readonly string[]
}

/** `a` is an ancestor of `b` — `world-terrain` of `world-terrain/chunks`. */
export const isAncestorKey = (a: string, b: string): boolean => b.startsWith(`${a}/`)

/**
 * Drop any key that has an ancestor in the same set.
 *
 * Hiding `world-terrain` already hides `world-terrain/chunks`, so listing both
 * would double the `moved` count and make a mechanism check read as though more
 * had happened than did.
 */
export const rootKeys = (keys: readonly string[]): string[] =>
  keys.filter((k) => !keys.some((other) => other !== k && isAncestorKey(other, k)))

/**
 * SUBTRACTIVE: hide the named groups, or every one of them for `*`.
 *
 * `*` is the EMPTY STAGE, and it is the origin both tables are measured from —
 * the frame with the clear, three's traversal, two submissions, the resolve and
 * SteamVR's swapchain, and no geometry at all. The lights stay lit over
 * nothing, which costs the reading nothing and keeps it comparable with every
 * solo below. (It did hide them, for one commit, and that made the empty stage
 * recompile every lit material and stop being the additive table's origin.)
 */
export const hidePlan = (keys: StageKeys, want: readonly string[]): ArmPlan => {
  if (want.includes('*')) return { hide: rootKeys([...keys.drawable]), missing: [] }
  const missing = want.filter((w) => !keys.drawable.includes(w))
  return { hide: rootKeys(want.filter((w) => keys.drawable.includes(w))), missing }
}

/**
 * ADDITIVE: show exactly one group and hide every other drawable one.
 *
 * Neither an ancestor of the target nor a descendant of it may be hidden: hiding
 * `world-terrain` to solo `world-terrain/chunks` hides the chunks too, and that
 * arm would report the empty stage's own number while looking like a result.
 *
 * **A solo of a STREAMING group is safe where a hide of one is not**, and that
 * asymmetry is why `world-terrain/chunks` is an additive arm and not a
 * subtractive one. Chunks arrive during the flight already visible, which is
 * what a solo of them wants and the opposite of what a hide of them wants.
 */
export const soloPlan = (keys: StageKeys, want: readonly string[]): ArmPlan => {
  const missing = want.filter((w) => !keys.drawable.includes(w))
  if (missing.length > 0) return { hide: [], missing }
  const keep = (k: string): boolean =>
    want.some((t) => k === t || isAncestorKey(k, t) || isAncestorKey(t, k))
  return { hide: rootKeys(keys.drawable.filter((k) => !keep(k))), missing: [] }
}

/** An arm, as `tools/perf/floor-sweep.mjs` writes one. */
export interface StageArm {
  /** Groups to hide, or `['*']` for the empty stage. */
  readonly hide?: readonly string[]
  /** The one group to show, everything else hidden. */
  readonly solo?: readonly string[]
}

/**
 * The plan for an arm, or `null` when it touches no group at all (a flag arm,
 * or the plain baseline).
 *
 * `null` and `{ hide: [] }` are different answers and the spec treats them
 * differently: nothing to do, versus an arm that asked for something and got
 * nothing — which is the shape a free-looking non-result arrives in.
 */
export const armPlan = (keys: StageKeys, arm: StageArm): ArmPlan | null => {
  if (arm.solo && arm.solo.length > 0) return soloPlan(keys, arm.solo)
  if (arm.hide && arm.hide.length > 0) return hidePlan(keys, arm.hide)
  return null
}
