/**
 * tests/e2e/xr-vrto3d-trace.spec.ts — the worn measurement, without the wearer.
 *
 * ── What this is ─────────────────────────────────────────────────────────
 *
 * `perf-trace.spec.ts` records a flight frame by frame on the FLAT path: one
 * camera, half the geometry, no compositor. This records the same thing through
 * the path a player actually takes — Chrome's own WebXR, a real OpenXR runtime,
 * SteamVR's compositor and swapchain — with a VRto3D virtual headset standing in
 * for the Steam Frame. Everything from `requestSession` down is the worn code
 * path. `__ff2perf` reports the same quantities it reported worn, because it is
 * the same code reading the same clocks.
 *
 * The rig goes on and comes off with vr-browser's tool, which registers the
 * driver outside the Steam tree and edits three settings keys:
 *
 *     node tools/steamvr-rig.mjs install vrto3d      # in ../vr-browser
 *     node tools/steamvr-rig.mjs uninstall vrto3d
 *
 * **The Steam Frame will not come up while it is installed** — `forcedDriver`
 * has already told SteamVR what its headset is.
 *
 * ── Two things that cost an hour each, both silent ───────────────────────
 *
 * 1. **Chrome's immersive-session prompt is browser chrome, and no automation
 *    can answer it.** Left alone, `requestSession` neither resolves nor rejects
 *    — it hangs, with the page reporting `visible` and `focused` and nothing in
 *    the console. `page.bringToFront()` appeared to fix this and did not: it
 *    only moved the bubble somewhere a human could reach, and a human was
 *    pressing Allow on every run. The grant is pre-written into a Chrome profile
 *    instead; see `fixtures/xr-browser.ts`, which carries the whole list of
 *    routes that do NOT work.
 * 2. **VRto3D's render size must be something the compositor can actually
 *    allocate.** Set to 2516 x 2516 per eye (the Frame's own figure) the
 *    compositor logged `WaitForAcquire timed out (FAILED)` from startup and
 *    `requestSession` came back `NotSupportedError: The specified session
 *    configuration is not supported` — a message about the SESSION for a fault
 *    in the DRIVER's config. The per-eye size lives in
 *    `<Steam>\config\vrto3d\default_config.json`.
 *
 * ── What it still cannot measure ─────────────────────────────────────────
 *
 * There is no Steam Frame here, so there is no VIDEO ENCODER sharing this
 * laptop's GPU. `docs/perf-baseline.md`'s pass rule is `GPU p95 <= 0.7 x budget`
 * precisely because the GPU is shared three ways when worn — game, compositor,
 * encoder — and on this rig it is shared two. Numbers off this route should
 * therefore come in BETTER than worn, and that gap is the encoder's. It is a
 * bound on the answer, not the answer.
 */

import fs from 'node:fs'
import path from 'node:path'
import { knownRed } from './fixtures/known-red'
import { enterVr, loadSettled } from './fixtures/landing'
import { armPlan, type StageArm, type StageKeys } from './fixtures/stage-arms'
import { expect, requireImmersiveDevice, test } from './fixtures/xr-browser'

type Page = import('@playwright/test').Page

const MISSION = process.env.VRTO3D_MISSION ?? 'rookie_01_hoverJet'
const EDITION = process.env.VRTO3D_EDITION ?? 'anniversary'
const SECONDS = Number(process.env.VRTO3D_SECONDS ?? '60')
const OUT_DIR = process.env.VRTO3D_DIR ?? path.join('perf-out', 'vrto3d')

/**
 * Dotted Anniversary flags to switch OFF for this run, comma separated — the
 * A/B arm. `VRTO3D_FLAGS_OFF=cockpit.body,cockpit.lighting` against an
 * otherwise identical run is how a term in the cost model gets confirmed or
 * killed. Empty means the shipped configuration.
 */
const FLAGS_OFF = (process.env.VRTO3D_FLAGS_OFF ?? '').split(',').filter((f) => f.includes('.'))

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter((g) => g.length > 0)

/**
 * Stage groups to HIDE for this run — `VRTO3D_HIDE=sky-dome,clouds`, or `*` for
 * every one of them (the EMPTY STAGE, which both of DEV-226's tables measure
 * from).
 *
 * ── Why a second arm mechanism, next to the flags ────────────────────────
 *
 * DEV-226 has to attribute the cost-model's **3.13 ms fixed term**, and most of
 * what a frame draws has no flag: the sky dome, the ocean, the land and the
 * horizon band are groups, not features. `perf-fill.spec.ts` already ranks the
 * census's own rows this way and its header carries the argument — *hiding is a
 * measurement, not a build: nothing is left hidden, and `visible = false` costs
 * a group its draws AND its shadow casting, which is the honest "what does this
 * cost me, all in" question.* The same words apply here; the difference is that
 * this one is flying and stereo rather than frozen and mono.
 *
 * And `*` is why the floor can be bounded at all. With every drawable group
 * hidden the renderer still clears, still traverses, still submits twice, and
 * the compositor still acquires and resolves a swapchain — so the reading is
 * the part of the frame **no content decision can reach**.
 */
const HIDE = list(process.env.VRTO3D_HIDE)

/**
 * The ADDITIVE arm — `VRTO3D_SOLO=world-ocean` shows that group and hides every
 * other drawable one.
 *
 * ── Why both directions, and why neither alone ───────────────────────────
 *
 * They bound the answer from opposite sides and each is wrong in a known
 * direction:
 *
 *   **A HIDE UNDER-STATES.** Take an opaque group away and its pixels go to
 *   whatever was behind it, which then shades them. You never get back the full
 *   cost of a thing that was hiding work — which is why the hide arms are
 *   expected to sum SHORT of the empty stage.
 *   **A SOLO OVER-STATES.** Drawn against nothing, a group pays for every pixel
 *   it covers with no depth rejection from anything in front of it, and loses
 *   the early-Z its neighbours were granting it.
 *
 * Truth is between them. A group whose two readings AGREE is genuinely that
 * expensive; one where they diverge has a cost that is mostly **occlusion
 * relationship** rather than intrinsic. For the ocean — `DoubleSide` with a
 * per-fragment `discard`, which forfeits early depth write for the largest
 * surface in the frame — that gap is the interesting number rather than a
 * nuisance.
 *
 * ── The rule that would silently ruin the table ──────────────────────────
 *
 * **A LIGHT IS NEVER AN ARM'S TO HIDE.** `WebGLRenderer.projectObject` returns
 * early on `visible === false` *before* it pushes a light, so a solo that hid
 * the sun with everything else would draw its group UNLIT — a different
 * program, a different fragment cost, and a number comparable with nothing in
 * the other table. It would look like a cheap group, not like a bug.
 *
 * The guard is structural: `fixtures/stage-arms.ts` splits `drawable` from
 * `lights` and the planners only ever see `drawable`, so they *cannot* name a
 * light. `tests/unit/stage-arms.test.ts` pins that half; the runtime half is
 * `litVisible` below, counted the way three counts it, asserted unchanged
 * across the arm.
 *
 * (`*` hid the lights too, for one commit. That made the empty stage recompile
 * every lit material and stop being an origin the solo table could share.)
 *
 * ── Two more rules the mechanism carries ─────────────────────────────────
 *
 * 1. **A name that matched nothing FAILS the run.** A group that does not exist
 *    reads as a system that costs nothing, which is indistinguishable from a
 *    result and is the shape of all three retractions in
 *    `VR-PERF-WAVE-2-WORK.md` §7.
 * 2. **The plan is re-derived on every poll, not applied once.** A group can be
 *    rebuilt mid-flight and a new top-level child can arrive VISIBLE, which for
 *    a solo is contamination. Re-planning costs two evaluates on a cadence the
 *    run already pays for.
 *
 * Streaming cuts the two directions differently, and it decides which arm a
 * group belongs in: **a solo of a streaming group is safe and a hide of one is
 * not.** Chunks land during the flight already visible — right for
 * `solo world-terrain/chunks`, wrong for a hide of the same key. So the land is
 * subtracted whole (`world-terrain`, hierarchical) and soloed at either level.
 */
const SOLO = list(process.env.VRTO3D_SOLO)

/**
 * A NESTED hide — `VRTO3D_HIDE_PATH=jumpseat/hud,jumpseat/motes`: one object
 * by name under one top-level group, locked the way `setHidden` locks a
 * group. Wave 4's queue F found the jitter's carrier is the VEHICLE group and
 * the group arm cannot say which child, because the planner names top-level
 * keys only. Same accessor lock, same idempotence, same refusal: a path that
 * matches nothing fails the run.
 */
const HIDE_PATH = list(process.env.VRTO3D_HIDE_PATH).filter((p) => p.includes('/'))

/** The arm, as the planner in `fixtures/stage-arms.ts` reads it. */
const ARM: StageArm = { hide: HIDE, solo: SOLO }

/**
 * How many times the GAME tried to re-show each group the arm hid (DEV-231).
 *
 * Zero everywhere is an arm nobody fought. A four-figure count beside a key is
 * the mechanism, named, in the run log — and it is the number that says *why*
 * the first sweep's control was not empty rather than leaving a reader to work
 * it out from two identical rows in a table.
 */
type ArmRelit = Record<string, number>

/** One group's share of what is STILL drawable after the arm — DEV-231. */
interface ResidueRow {
  /** `render-census.ts`'s `rowKey()`, so it reads against the census. */
  readonly group: string
  /** Visible draw-able objects found under it. */
  readonly objects: number
  /** Their triangles, from the geometry — a graph estimate, not a draw count. */
  readonly triangles: number
}

/**
 * The groups the stage offers, as `render-census.ts`'s `rowKey()` names them,
 * plus the lights three would GATHER right now. `null` before the stage exists.
 *
 * `litVisible` walks with `projectObject`'s own early-out, because that is the
 * number the arm must not change. It is the renderer's rule, not a proxy for
 * it.
 */
const stageKeys = (page: Page): Promise<(StageKeys & { litVisible: number }) | null> =>
  page.evaluate(() => {
    interface Node {
      name: string
      type: string
      visible: boolean
      isLight?: boolean
      children: Node[]
    }
    const w = globalThis as unknown as { __ff2?: { stage?: () => Node | undefined } }
    const stage = w.__ff2?.stage?.()
    if (!stage) return null
    // `render-census.ts`'s rowKey, with `-?` added: a negative chunk coordinate
    // is named `chunks` here and by itself there, and for hiding the permissive
    // form is the safe side of that difference.
    const chunkName = /^chunk_-?\d+_-?\d+$/
    const drawable: string[] = []
    const lights: string[] = []
    for (const child of stage.children) {
      const name = child.name || child.type
      if (child.isLight === true) {
        lights.push(name)
        continue
      }
      drawable.push(name)
      if (name !== 'world-terrain') continue
      for (const g of child.children) {
        const inner = chunkName.test(g.name) ? 'chunks' : g.name || g.type
        const key = `${name}/${inner}`
        if (!drawable.includes(key)) drawable.push(key)
      }
    }
    let litVisible = 0
    const walk = (o: Node): void => {
      if (o.visible === false) return
      if (o.isLight === true) litVisible++
      for (const c of o.children) walk(c)
    }
    walk(stage)
    return { drawable, lights, litVisible }
  })

/**
 * Hide exactly the planned keys, and report which ones were MATCHED.
 *
 * The naming rule above is spelled twice — once to list the keys, once to find
 * them again — and `matched` is what stops the two from drifting apart in
 * silence: the caller asserts it against what it asked for, which is true of
 * any correct pair of rules and false the moment they disagree. (Trap 24: assert
 * the relationship, not the value.)
 *
 * ── `visible = false` IS NOT ENOUGH, and that cost the first sweep ───────
 *
 * DEV-231. An assignment lasts until the next thing that assigns, and this app
 * writes visibility from inside `frame()` — 71 `.visible =` sites across 24
 * files in `src/`, two of them on top-level stage children:
 *
 *   `boot/app.ts:6972`  `liveTerrain.terrain.group.visible = revealed`
 *                       — DEV-075's port of 2016's `trigger_enableTerrain`.
 *   `boot/app.ts:8277`  `liveSky.dome.visible = !onTitle`
 *                       — the title/mission dome swap.
 *
 * Both are unconditional writes of a computed value, every frame, and in flight
 * both compute TRUE. So the arm hid the land and the sky once, the game put
 * them back one frame later, and the 2026-09-19 sweep's **empty stage drew the
 * whole of `world-terrain` plus the sky** — 203 calls and 1.44 M triangles with
 * "everything hidden". It was not subtle in the data and it was invisible in
 * the report: `no-land` came back bit-identical to the baseline (264 calls,
 * 2 552 736 triangles, at every quantile) and `only-land` came back
 * bit-identical to the EMPTY STAGE, which is what those two rows mean when the
 * hide does nothing. Then `only-chunks` drew LESS than the control — because a
 * solo of a child hides `world-terrain`'s other children INDIVIDUALLY, and
 * those the game does not re-show.
 *
 * So the arm takes the property away rather than writing it. A `false` getter
 * cannot be assigned over, the game's write lands in the setter and is COUNTED,
 * and `relit` then names — at runtime, in the run log — exactly which group
 * fought the arm and how hard. That last part is the difference between this
 * happening again silently and it arriving with its own explanation.
 *
 * This is the harness doing something extra, not the GAME taking another path:
 * the build is untouched, no flag is added, and what the arm produces is a
 * scene graph a player could produce by flying somewhere the terrain is off.
 */
const setHidden = (
  page: Page,
  keys: readonly string[],
): Promise<{ matched: string[]; moved: number; litVisible: number; relit: ArmRelit }> =>
  page.evaluate((want) => {
    interface Node {
      name: string
      type: string
      visible: boolean
      isLight?: boolean
      children: Node[]
    }
    const w = globalThis as unknown as {
      __ff2?: { stage?: () => Node | undefined }
      __ff2StageArmRelit?: Record<string, number>
    }
    // Survives across evaluates, because the count that matters is how many
    // times the game fought the arm over the whole flight, not since the last
    // poll. Harness-owned and harness-named: nothing in `src/` reads it.
    w.__ff2StageArmRelit ??= {}
    const relit: Record<string, number> = w.__ff2StageArmRelit
    const stage = w.__ff2?.stage?.()
    if (!stage) return { matched: [], moved: 0, litVisible: 0, relit }
    const chunkName = /^chunk_-?\d+_-?\d+$/
    const matched: string[] = []
    let moved = 0
    /**
     * Hide `node` for good: `false`, and then no property left to write.
     *
     * Idempotent — a second poll finds the accessor already installed and
     * leaves the tally alone. `configurable` stays true so it can be, and
     * `enumerable` keeps three's own `copy`/`toJSON` seeing the field it
     * expects.
     */
    const lock = (key: string, node: Node): void => {
      const own = Object.getOwnPropertyDescriptor(node, 'visible')
      if (own && typeof own.get === 'function') return
      node.visible = false
      relit[key] ??= 0
      Object.defineProperty(node, 'visible', {
        configurable: true,
        enumerable: true,
        get: () => false,
        set: () => {
          relit[key] = (relit[key] ?? 0) + 1
        },
      })
    }
    const hit = (key: string, node: Node): void => {
      if (!want.includes(key)) return
      if (!matched.includes(key)) matched.push(key)
      lock(key, node)
      moved++
    }
    for (const child of stage.children) {
      const name = child.name || child.type
      if (child.isLight === true) continue
      hit(name, child)
      if (name !== 'world-terrain') continue
      for (const g of child.children) {
        const inner = chunkName.test(g.name) ? 'chunks' : g.name || g.type
        hit(`${name}/${inner}`, g)
      }
    }
    let litVisible = 0
    const walk = (o: Node): void => {
      if (o.visible === false) return
      if (o.isLight === true) litVisible++
      for (const c of o.children) walk(c)
    }
    walk(stage)
    return { matched, moved, litVisible, relit }
  }, keys as string[])

/**
 * What the stage would still DRAW, by census key — the arm's residue (DEV-231).
 *
 * ── Why a graph walk and not only `__ff2perf.census()` ───────────────────
 *
 * The census is the authority on calls and triangles and it is captured too,
 * beside this. But it renders five extra off-screen frames and reads pixels
 * back, and it has never been called with `xr.isPresenting` true — three swaps
 * in the ArrayCamera at that point (`WebGLRenderer.render`, the
 * `xr.getCamera()` branch) and a readback mid-session is a stall. An assertion
 * that can fail a 34-minute sweep must not rest on a call that has never been
 * made on this path, so the census is best-effort and THIS is what the run is
 * refused on: a pure read of `visible` and `geometry`, which cannot throw and
 * cannot perturb a frame.
 *
 * It over-counts by exactly the frustum — an object outside the view is listed
 * here and absent from the census — and that is the safe direction: the
 * question is *what did the arm fail to hide*, not *what did the GPU pay for*.
 */
const residue = (page: Page): Promise<ResidueRow[]> =>
  page.evaluate(() => {
    interface Node {
      name: string
      type: string
      visible: boolean
      isLight?: boolean
      isMesh?: boolean
      isPoints?: boolean
      isLine?: boolean
      isSprite?: boolean
      isInstancedMesh?: boolean
      count?: number
      geometry?: {
        index?: { count: number } | null
        attributes?: { position?: { count: number } }
      }
      children: Node[]
    }
    const w = globalThis as unknown as { __ff2?: { stage?: () => Node | undefined } }
    const stage = w.__ff2?.stage?.()
    if (!stage) return []
    const chunkName = /^chunk_-?\d+_-?\d+$/
    const rows = new Map<string, { group: string; objects: number; triangles: number }>()
    const triangles = (n: Node): number => {
      const g = n.geometry
      if (!g) return 0
      const total = g.index ? g.index.count : (g.attributes?.position?.count ?? 0)
      const instances = n.isInstancedMesh === true ? (n.count ?? 1) : 1
      return Math.floor(total / 3) * instances
    }
    const walk = (n: Node, key: string): void => {
      if (n.visible === false) return
      if (n.isMesh === true || n.isPoints === true || n.isLine === true || n.isSprite === true) {
        const row = rows.get(key) ?? { group: key, objects: 0, triangles: 0 }
        row.objects++
        row.triangles += triangles(n)
        rows.set(key, row)
      }
      for (const c of n.children) walk(c, key)
    }
    for (const child of stage.children) {
      if (child.isLight === true) continue
      if (child.visible === false) continue
      const name = child.name || child.type
      // The same one-level expansion under `world-terrain` the keys use, so a
      // residue row names the thing an arm could have hidden.
      if (name === 'world-terrain') {
        for (const g of child.children) {
          const inner = chunkName.test(g.name) ? 'chunks' : g.name || g.type
          walk(g, `${name}/${inner}`)
        }
        continue
      }
      walk(child, name)
    }
    return [...rows.values()].sort((a, b) => b.triangles - a.triangles)
  })

/**
 * `__ff2perf.census()`, or the reason it could not be taken.
 *
 * Guarded because it has never been called in session — see `residue` above.
 * A census that throws costs this run its nicest evidence and nothing else.
 */
const censusNow = (page: Page): Promise<{ census: unknown; error: string | null }> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2perf?: { census?: () => unknown } }
    try {
      return { census: w.__ff2perf?.census?.() ?? null, error: null }
    } catch (e) {
      return { census: null, error: e instanceof Error ? e.message : String(e) }
    }
  })

/**
 * How many times the game fought each hidden group, so far. Read-only: it must
 * not re-apply the arm, because it is called after the residue is measured and
 * hiding something then would erase the very evidence being collected.
 */
const relitSoFar = (page: Page): Promise<ArmRelit> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __ff2StageArmRelit?: Record<string, number> })
        .__ff2StageArmRelit ?? {},
  )

/**
 * Re-derive the plan from the live stage and apply it. Idempotent, and it is
 * the same call before the flight and on every poll during it.
 */
const applyArm = async (
  page: Page,
): Promise<{
  matched: string[]
  hide: string[]
  missing: string[]
  litVisible: number
  relit: ArmRelit
} | null> => {
  const keys = await stageKeys(page)
  if (keys === null) return null
  const plan = armPlan(keys, ARM)
  if (plan === null)
    return { matched: [], hide: [], missing: [], litVisible: keys.litVisible, relit: {} }
  const applied = await setHidden(page, plan.hide)
  return {
    matched: applied.matched,
    hide: [...plan.hide],
    missing: [...plan.missing],
    litVisible: applied.litVisible,
    relit: applied.relit,
  }
}
/**
 * The same thing the other way up — `VRTO3D_FLAGS_ON=props.scatterShadows`.
 *
 * Needed because `FLAGS_OFF` can only measure a flag that SHIPS ON, and
 * DEV-224's does not: `props.scatterShadows.enabled` is false in
 * `content/editions/anniversary.json`, so the shipped build is already the
 * treatment arm and the BASELINE is the one that has to be built. Without this
 * the only baseline available is a run from another day, and three runs of one
 * identical `perf-fill` measurement on this machine sit 2.2x apart across days
 * (`docs/plan/VR-PERF-WAVE-3.md` §1). Both arms have to come out of one
 * session or the bracket means nothing.
 *
 * It is the harness doing something extra, not the GAME taking a different
 * path: it goes through `__ff2.edition.set`, which is the Edition page's own
 * route, and it produces a configuration a player can produce from the pause
 * menu. Same build, same code, a switch the game already has.
 */
const FLAGS_ON = (process.env.VRTO3D_FLAGS_ON ?? '').split(',').filter((f) => f.includes('.'))

/**
 * Extra query parameters for the run, e.g. `VRTO3D_QUERY=propLod=off`.
 *
 * The A/B arm for the DEV switches that are NOT preset flags and should not
 * become preset flags — `?propLod=` (DEV-225) and `?propCells=` (DEV-118) are
 * both 2016 behaviour or a layout, not Anniversary additions, so neither has a
 * block in the edition JSON for `FLAGS_OFF` to reach. Ampersand-separated; the
 * mission, autopilot and trace parameters are appended by this file and cannot
 * be overridden from here.
 */
const EXTRA_QUERY = (process.env.VRTO3D_QUERY ?? '').replace(/^[?&]+/, '')

/**
 * DEV-238. `render/fragment-gates.ts` arms — `VRTO3D_GATES=waterNoSpecular`.
 *
 * ── Why a fourth arm mechanism, next to the flags, the groups and the query ──
 *
 * Because the ocean's cost is not a group, not a flag and not a load-time
 * switch. §10.3 of `VR-PERF-WAVE-3.md` puts `world-ocean` at **1.16–1.89 ms on
 * the cheapest mission in the game**, 8 draw calls against the terrain's 175,
 * and PERF-JOURNEY §4 records three hypotheses about it and three negatives.
 * What has never been priced is the sea's fragment stack TERM BY TERM, and a
 * term is a statement in a shader: it has no group to hide and no preset to
 * turn off.
 *
 * `#define` is the only switch this machine can A/B at all for a fill-dominated
 * cost — §3a-ter, where a bracketed A-B-A of two IDENTICAL builds pinned at
 * load came back 4.82 / 4.27 / 7.05 ms because the GPU throttles inside the
 * reading window. A define flips between two readings of one page.
 *
 * `VRTO3D_GATES_WHICH` is `ocean` by default, which is the opposite of
 * `__ff2.fragmentGates`'s own default and deliberate: the four `FF2_WATER_*`
 * gates are INERT on the island (a define no statement reads, bought with a
 * recompile), so an ocean arm thrown at the land would be a mechanism check
 * that passes and a measurement of nothing. The `which` is printed on every
 * run for that reason.
 */
const GATES = list(process.env.VRTO3D_GATES)
const GATES_WHICH = (process.env.VRTO3D_GATES_WHICH ?? 'ocean') as 'land' | 'ocean' | 'both'

/**
 * DEV-238's draw-ORDER switches — `VRTO3D_ORDER=ocean`, `sky`, or both.
 *
 * §10.3's groups all diverge between their subtractive and additive readings,
 * which means each cost is mostly **occlusion relationship**; and PERF-JOURNEY
 * §3 measured hiding the terrain as making the frame 0.52 ms SLOWER, because
 * the island occludes the sea. You cannot delete a relationship. You can change
 * which side of it a thing is on, and that is what these two do.
 *
 * `ocean` draws the sea after every opaque terrain band so early-Z can reject a
 * sea fragment behind the island; `sky` draws the dome last at the far plane.
 *
 * ── Both are the SHIPPED order since DEV-241, and this name did not move ──
 *
 * `VRTO3D_ORDER=ocean` still means *assert the ocean switch ON*. It is a no-op
 * on a freshly loaded level now, and the mechanism line says so by printing the
 * state it produced rather than the intent it was handed.
 *
 * Inverting this name instead would have been the cheaper edit and it is the
 * one to refuse: `perf-out/queue-wave4-d.json` and `-e.json` are 33 recorded
 * rows spelling their arms this way, DEV-238 §5 is a table of these strings,
 * and every one of them would have silently started meaning the opposite. **A
 * string that predicts the right thing while being untrue is the exact shape of
 * the `oculus-touch` hunt** (NEXT.md action 1). A new spelling cannot be
 * misread by a file written before it existed, so the OFF arm is
 * `VRTO3D_ORDER_OFF` below.
 */
const ORDER = list(process.env.VRTO3D_ORDER).filter(
  (s) => s === 'ocean' || s === 'sky' || s === 'cockpit',
) as ('ocean' | 'sky' | 'cockpit')[]

/**
 * DEV-241's A/B arm: turn a SHIPPED default off — `VRTO3D_ORDER_OFF=ocean,sky`.
 *
 * This is the subtractive reading of the two order defaults, and it is the only
 * way to price either of them now that both are the build. It restores exactly
 * what `render/sky.ts` and `game/terrain/load-terrain.ts` constructed, which is
 * the state every wave-3 and wave-4 baseline was taken on — so an arm here is
 * directly comparable with the rows already on disk, with the sign flipped.
 *
 * **The OFF arm COMPILES on the sky.** Removing `FF2_SKY_FAR_PIN` is a new
 * program key with no warmed variant and none possible (DEV-177(b)), so the
 * first frame after the flip is a compile. It is thrown here, before the
 * recorder arms, and the A-B-A bracket is what would make a forgotten settle
 * visible.
 */
const ORDER_OFF = list(process.env.VRTO3D_ORDER_OFF).filter(
  (s) => s === 'ocean' || s === 'sky' || s === 'cockpit',
) as ('ocean' | 'sky' | 'cockpit')[]

interface GateReport {
  moved: number
  defines: string[]
  materials: number
  carrying: number
  which: string
}

/** Throw the gates and report what is TRUE, not what was asked for. */
const applyGates = (page: Page): Promise<GateReport | null> =>
  page.evaluate(
    ([g, w]) => {
      const ff2 = (
        globalThis as unknown as {
          __ff2?: {
            fragmentGates?: (gates: readonly string[], which: string) => GateReport
          }
        }
      ).__ff2
      return ff2?.fragmentGates?.(g as string[], w as string) ?? null
    },
    [GATES, GATES_WHICH] as const,
  ) as Promise<GateReport | null>

interface OrderReport {
  which: string
  moved: number
  seen: number
  on: boolean
}

/**
 * Assert a state on each named switch and report what is TRUE afterwards.
 *
 * `moved` counts what THIS CALL changed, so a `true` on a level that has just
 * loaded reports 0 and is not a failure — the constructors already did it
 * (DEV-241). `on` and `seen` are what an arm has to read, which is the same
 * separation `__ff2.fragmentGates` grew `carrying` for.
 */
const applyOrder = (
  page: Page,
  wanted: readonly ('ocean' | 'sky' | 'cockpit')[],
  on: boolean,
): Promise<OrderReport[]> =>
  page.evaluate(
    ([list, want]) => {
      const ff2 = (
        globalThis as unknown as {
          __ff2?: { drawOrderSwitch?: (which: string, on?: boolean) => OrderReport }
        }
      ).__ff2
      const out: OrderReport[] = []
      for (const which of list as string[]) {
        const r = ff2?.drawOrderSwitch?.(which, want as boolean)
        if (r) out.push(r)
      }
      return out
    },
    [wanted, on] as const,
  ) as Promise<OrderReport[]>

/** Every order switch this run touches, in one list, for the re-assert poll. */
const ORDER_ARMS: readonly {
  readonly which: readonly ('ocean' | 'sky' | 'cockpit')[]
  readonly on: boolean
}[] = [
  { which: ORDER, on: true },
  { which: ORDER_OFF, on: false },
].filter((a) => a.which.length > 0)

const traceStatus = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const t = (globalThis as unknown as { __ff2perf?: { trace?: { status?: () => string } } })
      .__ff2perf?.trace
    return t?.status?.() ?? null
  })

/** Whether this run carries a group arm at all. */
/**
 * Did the arm actually FIRE? One row per flag that can answer.
 *
 * ── Why this exists, and why it throws ───────────────────────────────────
 *
 * DEV-232's first A/B came back at **0.025 ms against a 0.05 ms bracket** and
 * was nearly filed as *"the bake buys nothing"*. It was not a result: the
 * median program count was **95 in all three arms**, distinct set {78, 94, 95}
 * in all three — and a `#define` is in three's program cache key, so an arm
 * that really set one cannot leave that untouched. The flag reached the edition
 * state, the subscriber ran, and the work it triggered gated on a variable
 * assigned 902 lines later. No define, no error, sixty seconds of recording,
 * and a number.
 *
 * **This is the third time this lesson has been paid for this week.**
 * `tools/perf/floor-sweep.mjs` refuses an arm whose call count did not fall;
 * `tools/perf/vehicle-mode-sweep.mjs` refuses a cell that did not move; DEV-231
 * withdrew fourteen rows scored against a control that drew the whole island.
 * Every one of them is the same sentence: **a measurement whose mechanism was
 * never checked is not a measurement.**
 *
 * So it THROWS rather than warning. A warning in a 60-second run scrolls past,
 * and the artifact on disk afterwards looks exactly like a real reading. The
 * run has to not happen.
 *
 * ── Why a table with one row, rather than something general ──────────────
 *
 * There is no generic way to ask "did this flag change anything" from outside
 * the page — each feature's mechanism is its own. What there IS is a shape: a
 * flag that can answer exposes a probe on `__ff2` that separates *what was
 * asked for* from *what is true*. `terrain.bakedLight` does, because it was
 * built to after it failed. The table is the place the next one goes, so adding
 * it is a row rather than a design.
 *
 * A flag with no row is not checked and not refused — silence here means
 * "this harness cannot tell", which is honest, and is why the console line
 * below names every flag it could not check.
 */
const MECHANISM_CHECKS: Record<string, (page: Page) => Promise<string | null>> = {
  /**
   * `terrain.bakedLight` — DEV-232. `on` requires a resolved sun AND a baked
   * colour buffer, not merely a define, so a define with nothing behind it
   * reports its own failure. `reason` says which half is missing.
   *
   * ── And WHICH RUNG, DEV-237 ────────────────────────────────────────────
   *
   * There are two pictures behind this one flag now, and the flag cannot tell
   * them apart: `VRTO3D_FLAGS_ON`'s flip is `{ ...target, enabled }`, which
   * carries the rung over from the preset untouched. The rung arrives by
   * `?bakedRung=` instead — a different mechanism, on a different line of the
   * command, and therefore a different thing to forget.
   *
   * So this prints the rung it found and refuses an arm whose materials are
   * carrying a rung the run did not ask for. **`rung` is the intent and
   * `liveRung` is read back off the terrain's materials**; equal is the only
   * acceptable answer, and `defines` is printed so the trace's own log says
   * which program was measured rather than leaving it to be reconstructed.
   *
   * That distinction is not theoretical here. DEV-232's first A/B recorded
   * sixty seconds and a number for an arm whose define never reached a
   * material, and every field this check reads exists because of it.
   */
  'terrain.bakedLight': async (page) => {
    const r = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __ff2?: {
          bakedLight?: () => {
            wanted: boolean
            on: boolean
            reason: string | null
            // DEV-240: a rung is 1, 3 or the STRING 'split'. Typed wide here
            // because this side of `page.evaluate` is a different realm and
            // cannot import the union; the comparison below is `!==`, which is
            // right for both shapes.
            rung: number | string
            liveRung: number | string | null
            defines: string[]
            baked: number
            materials: number
            vertices: number
            directBytes: number
          }
        }
      }
      return w.__ff2?.bakedLight?.() ?? null
    })
    if (r === null) return 'the page exposes no __ff2.bakedLight probe'
    console.info(
      `  A/B: terrain.bakedLight rung ${String(r.rung)} (live ${String(r.liveRung)}) ` +
        `defines [${r.defines.join(', ')}] · ${r.materials} materials, ${r.baked} baked` +
        // DEV-240. Zero at every rung but `split`, where it is the measured
        // price of the second attribute rather than an estimate of it.
        `, ${r.vertices} vertices, +${(r.directBytes / (1024 * 1024)).toFixed(1)} MB`,
    )
    if (r.wanted && !r.on) return `wanted but not on — ${r.reason ?? 'no reason given'}`
    if (!r.wanted && r.on) return 'on without being wanted'
    if (r.wanted && r.liveRung !== r.rung) {
      return (
        `asked for rung ${String(r.rung)} and the materials are carrying ${String(r.liveRung)} — ` +
        'the intent never reached them, or they disagree with each other. ' +
        'Select the rung with ?bakedRung=split|1|3 (VRTO3D_QUERY), not with VRTO3D_FLAGS_ON.'
      )
    }
    return null
  },

  /**
   * `hud.redraw` — DEV-243, and it is a QUERY arm rather than a preset flag.
   *
   * The key is synthesised by `assertArmFired` when `VRTO3D_QUERY` carries a
   * `hudRedraw=`, because there is no edition block for `FLAGS_ON` to reach:
   * the cadence is a DEV switch (`?propLod=`, `?propCells=` are the same shape)
   * and must not become a preset. `HUD_REDRAW_ASK` holds what the command line
   * asked for so this row has something to compare against.
   *
   * ── The two ways this arm can fail to fire, and WHEN each is answerable ──
   *
   * **The cadence never reached the panel.** `?hudRedraw=` is read once at
   * boot and the frame loop re-asserts it onto whatever HUD is current; a
   * course swap, a third-person re-parent or a typo all end with a panel on
   * `live` and a trace that looks exactly like a reading. That is answerable
   * the moment a panel exists, so it is THIS row. The probe's own `cadence`
   * is compared against the ask by STRING, and the two spellings are one
   * spelling because `describeHudRedraw` round-trips through `parseHudRedraw`
   * (`tests/unit/hud-redraw.test.ts` holds that).
   *
   * **The cadence reached the panel and had nothing to withhold.**
   * `repaints: 9` over sixty seconds is what a 10 Hz arm reports and also what
   * a flight where the panel never moved reports — and in the second case the
   * shipped build would not have uploaded either, so the arm removed nothing
   * and the delta is noise with a story attached. `skipped` separates them.
   * **But it cannot be read here**: this runs when `#enter-vr` goes enabled,
   * which is before the ship has flown a metre, and at that instant a correct
   * 10 Hz arm legitimately reads `skipped: 0`. So that half is asserted AFTER
   * the recording, beside DEV-231's empty-stage control and DEV-236's viewport
   * check, which are there for the same reason.
   *
   * Polled rather than read once, because `__ff2.hud()` answers `null` until
   * there is a ship to hang a panel on and `#enter-vr` does not promise one.
   */
  'hud.redraw': async (page) => {
    // A miss returns the refusal STRING like every other row in this table,
    // rather than throwing a poll timeout — so a failure reads as "the arm did
    // not fire" beside the others and not as a harness problem.
    let r = await hudProbe(page)
    const deadline = Date.now() + 60_000
    while (r === null && Date.now() < deadline) {
      await page.waitForTimeout(500)
      r = await hudProbe(page)
    }
    if (r === null) {
      return 'no __ff2.hud probe after 60 s — this build has no panel, or no ship to hang one on'
    }
    console.info(
      `  A/B: hud.redraw ${r.cadence} · ${r.repaints} repaints, ${r.uploads} uploads, ` +
        `${r.skipped} withheld, ${r.unchanged} quiet · ` +
        `${r.pixels.width}x${r.pixels.height} px, ${(r.bytes / 1024).toFixed(0)} KiB an upload`,
    )
    if (r.cadence !== HUD_REDRAW_ASK) {
      return (
        `asked for '${HUD_REDRAW_ASK}' and the panel is on '${r.cadence}' — the pin never ` +
        'reached it. Pass it as VRTO3D_QUERY=hudRedraw=freeze|10|live, not as a flag.'
      )
    }
    return null
  },

  /**
   * `hud.upload` — DEV-244, the other half of DEV-243 and a QUERY arm for the
   * same reason: a texture mode is a DEV switch, not an edition block.
   *
   * ── What this row can check that `hud.redraw`'s cannot ─────────────────
   *
   * A cadence is an intent and the only thing a probe can say about it is what
   * the panel believes. An upload MODE is three fields on a live texture, so
   * the probe reports both — `upload` is what was asked for and `liveUpload`
   * is classified back off `generateMipmaps`, `minFilter` and `anisotropy`.
   * That is DEV-232's wanted/on and DEV-237's rung/liveRung, and it is worth
   * having here because this panel is rebuilt on every course swap and the
   * intent is re-asserted onto it by the frame loop: "the mode never reached
   * the texture" is a real failure with a plausible-looking trace behind it.
   *
   * **`liveUpload: null` is the third answer and it fails too.** It means the
   * texture is in a combination no mode produces, i.e. something outside
   * `render/hud.ts` has set one of the three fields — in which case the run is
   * measuring a texture nobody configured, whichever mode was asked for.
   *
   * The byte line is printed on every checked run because the whole row turns
   * on which bytes moved: `nomip` removes the CHAIN (150,332 B on the shipped
   * 560 x 203 panel) and not one byte of level 0's 454,720, and a reader who
   * has only "the upload got cheaper" will quote the wrong quantity (DEV-027).
   */
  'hud.upload': async (page) => {
    let r = await hudProbe(page)
    const deadline = Date.now() + 60_000
    while (r === null && Date.now() < deadline) {
      await page.waitForTimeout(500)
      r = await hudProbe(page)
    }
    if (r === null) {
      return 'no __ff2.hud probe after 60 s — this build has no panel, or no ship to hang one on'
    }
    console.info(
      `  A/B: hud.upload ${r.upload} (live ${r.liveUpload ?? 'UNRECOGNISED'}) · ` +
        `${r.pixels.width}x${r.pixels.height} px, ${r.mipLevels} mip levels · ` +
        `${(r.bytes / 1024).toFixed(0)} KiB level 0 + ${(r.mipBytes / 1024).toFixed(0)} KiB chain ` +
        `= ${(r.uploadBytes / 1024).toFixed(0)} KiB an upload\n` +
        `       one repaint asks the canvas for ${r.canvasOps.total} calls ` +
        `(${r.canvasOps.texts} fillText, ${r.canvasOps.measures} measureText) — the ` +
        'per-upload-cost hypothesis predicts this differs ~4x between the two vehicles',
    )
    if (r.upload !== HUD_UPLOAD_ASK) {
      return (
        `asked for '${HUD_UPLOAD_ASK}' and the panel is on '${r.upload}' — the pin never ` +
        'reached it. Pass it as VRTO3D_QUERY=hudUpload=mip|nomip, not as a flag.'
      )
    }
    if (r.liveUpload === null) {
      return (
        `the panel reports '${r.upload}' and its TEXTURE is in no recognised mode — ` +
        'generateMipmaps, minFilter and anisotropy do not match either combination, so ' +
        'something outside render/hud.ts has set one of them and this run would be ' +
        'measuring a texture nobody configured'
      )
    }
    if (r.liveUpload !== r.upload) {
      return (
        `asked for '${r.upload}' and the texture is carrying '${r.liveUpload}' — the mode ` +
        'never reached it. The panel is rebuilt on every course swap; the frame loop ' +
        're-asserts the mode onto whatever panel is current, and that did not happen.'
      )
    }
    // DEV-244's own arithmetic, asserted rather than merely printed: `nomip`
    // must have taken the chain to nothing and `mip` must still be carrying
    // one. A mode that reached the texture and left `mipBytes` unchanged would
    // be a lever that fired and did nothing, which is exactly the shape
    // DEV-232's 0.025 ms had.
    if (r.upload === 'nomip' && (r.mipBytes !== 0 || r.mipLevels !== 1)) {
      return `nomip is in force and the texture still reports ${r.mipLevels} mip levels`
    }
    if (r.upload === 'mip' && r.mipBytes <= 0) {
      return 'mip is in force and the texture reports no chain — the shipped panel has one'
    }
    return null
  },
}

/**
 * DEV-243's probe, or null before there is a ship to hang a panel on.
 *
 * DEV-244 appended `upload`, `liveUpload`, `mipLevels`, `mipBytes` and
 * `uploadBytes`. Appended, not inserted, for `vp_w`'s reason (DEV-236): this
 * shape is read by two `MECHANISM_CHECKS` rows and by the post-recording
 * assertions, and a field order is as much a wire format as a CSV column list.
 */
interface HudProbe {
  cadence: string
  repaints: number
  uploads: number
  unchanged: number
  skipped: number
  pixels: { width: number; height: number }
  bytes: number
  /** DEV-244. The upload mode ASKED for. */
  upload: string
  /** DEV-244. The mode the live texture is in, or null for neither. */
  liveUpload: string | null
  /** DEV-244. 1 with no chain, 10 on the shipped 560 x 203 panel. */
  mipLevels: number
  /** DEV-244. Levels 1..n — what `nomip` removes, and 0 when it has. */
  mipBytes: number
  /** DEV-244. `bytes + mipBytes`: everything one upload moves. */
  uploadBytes: number
  /**
   * DEV-244. What the LAST repaint asked of the 2-D context, in calls.
   *
   * Here because the per-upload-cost hypothesis is about this number and
   * nothing else can report it per mission. Freezing this panel costs
   * `int_01_hoverJet` ten times what it costs `adv_02_jumpSeat` for 2.4× the
   * repaints; if canvas work explains the residue these two counts differ by
   * about 4×, and `tests/unit/hud-upload.test.ts` predicts they differ by
   * about a tenth of that. **Printing it on every checked run is what turns
   * that from a prediction into a reading.**
   */
  canvasOps: { total: number; texts: number; measures: number }
}

const hudProbe = (page: Page): Promise<HudProbe | null> =>
  page.evaluate(() => {
    const w = globalThis as unknown as { __ff2?: { hud?: () => unknown } }
    return (w.__ff2?.hud?.() ?? null) as never
  })

/**
 * What `VRTO3D_QUERY=hudRedraw=…` asked for, in the probe's own spelling.
 *
 * `''` when the run carries no such pin, which is how `assertArmFired` knows
 * not to synthesise the check at all. The normalisation goes through the same
 * two rules the app does — `0` and `off` are a freeze, `on` is `live`, a bare
 * number gains its unit — so that a command line written any of the accepted
 * ways compares equal to what the page reports rather than refusing its own
 * arm on a spelling.
 */
const HUD_REDRAW_ASK: string = (() => {
  const raw = new URLSearchParams(EXTRA_QUERY).get('hudRedraw')
  if (raw === null) return ''
  const text = raw.trim().toLowerCase()
  if (text === 'live' || text === 'on') return 'live'
  if (text === 'freeze' || text === 'off' || text === '0') return 'freeze'
  const hz = Number(text.endsWith('hz') ? text.slice(0, -2) : text)
  return Number.isFinite(hz) ? `${hz}hz` : text
})()

/**
 * What `VRTO3D_QUERY=hudUpload=…` asked for, in the probe's own spelling.
 * DEV-244.
 *
 * `''` when the run carries no such pin, which is how `assertArmFired` knows
 * not to synthesise the check at all.
 *
 * The normalisation is the app's: hyphens and underscores come off, the plural
 * and the `map(s)` suffix collapse, so a command line written any accepted way
 * compares equal to what the page reports rather than refusing its own arm on
 * a spelling. **`on`/`off`/`live`/`freeze` are deliberately NOT accepted** —
 * `?hudRedraw=off` already means a freeze and one word meaning opposite things
 * on two pins of one panel is a trap; a run that passes one of them falls
 * through to the raw text here, disagrees with the page's `mip`, and is
 * refused with the ask printed. Which is the wanted outcome:
 * `tests/unit/hud-upload.test.ts` holds that the app refuses it too.
 */
const HUD_UPLOAD_ASK: string = (() => {
  const raw = new URLSearchParams(EXTRA_QUERY).get('hudUpload')
  if (raw === null) return ''
  const text = raw.trim().toLowerCase().replaceAll('-', '').replaceAll('_', '')
  if (text === 'mip' || text === 'mips' || text === 'mipmap' || text === 'mipmaps') return 'mip'
  if (
    text === 'nomip' ||
    text === 'nomips' ||
    text === 'nomipmap' ||
    text === 'nomipmaps' ||
    text === 'nochain'
  ) {
    return 'nomip'
  }
  return text
})()

/**
 * Refuse the run if any flipped flag that can answer says it did not fire.
 *
 * Called AFTER `#enter-vr` goes enabled — the app's own statement that the
 * world is up — because that is the earliest moment at which "the arm reached
 * the terrain" is a question with an answer. It is also, exactly, the moment
 * the first A/B never waited for.
 */
const assertArmFired = async (page: Page): Promise<void> => {
  // The flags, plus the QUERY arms that have a row. `?hudRedraw=` (DEV-243) is
  // not a preset flag and must not become one — it is a DEV switch, like
  // `?propLod=` — so its key is synthesised here from the query the run carries
  // rather than read out of `VRTO3D_FLAGS_ON`. A run without the pin adds
  // nothing and behaves exactly as it did before.
  const flipped = [
    ...FLAGS_OFF,
    ...FLAGS_ON,
    ...(HUD_REDRAW_ASK === '' ? [] : ['hud.redraw']),
    // DEV-244, synthesised the same way and for the same reason: an upload
    // mode is a DEV switch and must not become a preset flag.
    ...(HUD_UPLOAD_ASK === '' ? [] : ['hud.upload']),
  ]
  if (flipped.length === 0) return
  const failures: string[] = []
  const unchecked: string[] = []
  for (const dotted of flipped) {
    const check = MECHANISM_CHECKS[dotted]
    if (!check) {
      unchecked.push(dotted)
      continue
    }
    const problem = await check(page)
    if (problem !== null) failures.push(`${dotted}: ${problem}`)
  }
  if (unchecked.length > 0) {
    console.info(`  A/B: no mechanism check for ${unchecked.join(', ')} — not verified`)
  }
  if (failures.length > 0) {
    throw new Error(
      `A/B arm did not fire, so this run is not a measurement:\n  ${failures.join('\n  ')}\n` +
        'Refusing to record a trace. See MECHANISM_CHECKS in this file for why.',
    )
  }
  const checked = flipped.filter((f) => MECHANISM_CHECKS[f])
  if (checked.length > 0) console.info(`  A/B: mechanism verified for ${checked.join(', ')}`)
}

/** Lock each `group/child[/grandchild]` path hidden; report what matched. */
const setHiddenPaths = (
  page: Page,
  paths: readonly string[],
): Promise<{ matched: string[]; missing: string[] }> =>
  page.evaluate((want) => {
    interface Node {
      name: string
      visible: boolean
      children: Node[]
    }
    const w = globalThis as unknown as { __ff2?: { stage?: () => Node | undefined } }
    const stage = w.__ff2?.stage?.()
    if (!stage) return { matched: [], missing: [...want] }
    const lock = (node: Node): void => {
      const own = Object.getOwnPropertyDescriptor(node, 'visible')
      if (own && typeof own.get === 'function') return
      node.visible = false
      Object.defineProperty(node, 'visible', {
        configurable: true,
        enumerable: true,
        get: () => false,
        set: () => {},
      })
    }
    const find = (root: Node, name: string): Node | null => {
      if (root.name === name) return root
      for (const c of root.children) {
        const hit = find(c, name)
        if (hit) return hit
      }
      return null
    }
    const matched: string[] = []
    const missing: string[] = []
    for (const p of want) {
      const [group, ...rest] = p.split('/')
      let node: Node | null = stage.children.find((c) => c.name === group) ?? null
      for (const seg of rest) node = node ? find(node, seg) : null
      if (!node) {
        missing.push(p)
        continue
      }
      lock(node)
      matched.push(p)
    }
    return { matched, missing }
  }, paths as string[])

/**
 * Did the adaptive controller's resolution request reach the framebuffer?
 * DEV-236.
 *
 * Two columns of the same CSV. `scale` is the ASK — `ADAPTIVE_STEPS[stepIndex]`,
 * what `requestViewportScale` was called with — and `vp_w` is the OUTCOME: the
 * per-eye viewport width three read back out of `getViewport(view)` and drew
 * into. When the controller has stepped down and the viewport has not moved at
 * all, the request went nowhere, which is exactly what DEV-208 shipped for six
 * weeks with no instrument able to say so.
 *
 * ── Read by NAME, and skipped rather than guessed ────────────────────────
 *
 * Column indices come off the file's own header line, because `COLUMNS` in
 * `perf-trace.ts` is a wire format and *"a reader takes its order from the file
 * rather than from a copy of this list"*. A trace recorded before `vp_w`
 * existed has no such column and returns `null` — not zeros, and not a
 * failure, because the absence of the instrument is not evidence about the
 * runtime.
 *
 * `headerWidth` is DEV-227's stamp — `projection[0].viewport.w`, the width the
 * session opened at — and is the reference the minimum is compared against. It
 * is `null` on the flat path and on any pre-DEV-227 trace, and the caller then
 * falls back to comparing the minimum against the run's own maximum, which is
 * the weaker question ("did it EVER move?") but is answerable from the rows
 * alone.
 */
const viewportScaleLanded = (
  csv: string,
): {
  medianScale: number
  minWidth: number
  maxWidth: number
  headerWidth: number | null
  /** The controller stepped down and the viewport never followed. */
  refused: boolean
} | null => {
  const lines = csv.split(/\r?\n/)
  const names = (lines[1] ?? '').split(',')
  const iScale = names.indexOf('scale')
  const iVp = names.indexOf('vp_w')
  if (iScale < 0 || iVp < 0) return null

  let headerWidth: number | null = null
  try {
    const header = JSON.parse(lines[0] ?? '{}') as {
      projection?: { viewport?: { w?: number } | null }[] | null
    }
    const w = header.projection?.[0]?.viewport?.w
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) headerWidth = w
  } catch {
    // A header that will not parse is a header with no stamp in it. The row
    // comparison below still works.
  }

  const scales: number[] = []
  let minWidth = Number.POSITIVE_INFINITY
  let maxWidth = 0
  for (const line of lines.slice(2)) {
    if (line.length === 0) continue
    const cells = line.split(',')
    const sc = Number(cells[iScale])
    const vp = Number(cells[iVp])
    if (Number.isFinite(sc)) scales.push(sc)
    // 0 is the flat path's answer and is not a viewport. Excluded so a stray
    // pre-session row cannot make the minimum look like a win.
    if (Number.isFinite(vp) && vp > 0) {
      minWidth = Math.min(minWidth, vp)
      maxWidth = Math.max(maxWidth, vp)
    }
  }
  if (scales.length === 0 || maxWidth === 0) return null
  const sorted = [...scales].sort((a, b) => a - b)
  const medianScale = sorted[Math.floor(sorted.length / 2)] as number

  // 0.99, not 1: `ADAPTIVE_STEPS` is [1, .9, .8, .7, .6], so anything below 1
  // is at least a 10 % step and there is no value between 0.99 and 1 a working
  // controller can produce. A median below it means the run spent most of its
  // frames asking for fewer pixels.
  const askedForFewer = medianScale < 0.99
  const reference = headerWidth ?? maxWidth
  // A single pixel of movement is enough. The question is not "did it scale by
  // the right amount" — the UA is free to clamp to its own minimum viewport
  // scale, which the spec says it does — it is "did anything happen at all".
  const viewportNeverMoved = minWidth >= reference
  return {
    medianScale,
    minWidth,
    maxWidth,
    headerWidth,
    refused: askedForFewer && viewportNeverMoved,
  }
}

/**
 * The two cockpit canvas panels' repaint rates, OVER THE RECORDED FLIGHT.
 * DEV-243.
 *
 * ── Why this is the trace and not the probe ──────────────────────────────
 *
 * `__ff2.hud()` reports a rate too, over the PANEL's life — which starts under
 * the loading curtain and takes in the landing card, the lift and the launch
 * banner, all of it with a speed row that reads zero and never moves. The
 * recorded rows are the flight and nothing else, so a cumulative column
 * differenced across them is the rate during the sixty seconds the
 * milliseconds were also measured over. They are two different questions and
 * the second is the one the wave is asking.
 *
 * ── Why BOTH panels ──────────────────────────────────────────────────────
 *
 * The perf plate is the HUD's control (DEV-243 §2b): the same kind of object
 * on the same parent, 49 % more canvas, a fraction of the rate, and −0.30 ms
 * of p95 against the HUD's −2.35. **Two panels, two rates, one mechanism** is
 * the row, and it is only a row if both rates come out of the same file over
 * the same window.
 *
 * ── And the question it was added to answer ──────────────────────────────
 *
 * Hiding the HUD is worth −2.01 ms of p50 on `int_01_hoverJet` and −0.36 on
 * `adv_02_jumpSeat` — the same panel, the same canvas, **5.6×**. If that is
 * the repaint rate, these two numbers differ by about 5.6× as well. And there
 * is a ceiling on that: a panel cannot repaint more often than the frame, so
 * `paintsPerFrame` is printed beside the rate. **If both missions read near
 * 1.00 paints per frame, the rate hypothesis is arithmetically dead** — the
 * cap makes a 5.6× ratio impossible — and the 6× is per-upload cost,
 * occlusion, or a contaminated p50 instead.
 *
 * Returns null for a trace recorded before these columns existed: the absence
 * of the instrument is not evidence about the panels.
 */
const panelPaintRates = (
  csv: string,
): {
  seconds: number
  frames: number
  hud: { paints: number; rateHz: number; perFrame: number }
  plate: { paints: number; rateHz: number; perFrame: number }
} | null => {
  const lines = csv.split(/\r?\n/)
  const names = (lines[1] ?? '').split(',')
  const iHud = names.indexOf('hud_paints')
  const iPlate = names.indexOf('plate_paints')
  const iDt = names.indexOf('dt_ms')
  if (iHud < 0 || iPlate < 0 || iDt < 0) return null

  // CUMULATIVE columns, so the answer is last minus first — which is exact on
  // any subset of rows, and is the whole reason they are levels rather than
  // per-frame flags (`perf-trace.ts`'s column list has the argument).
  let firstHud: number | null = null
  let firstPlate: number | null = null
  let lastHud = 0
  let lastPlate = 0
  let ms = 0
  let frames = 0
  for (const line of lines.slice(2)) {
    if (line.length === 0) continue
    const cells = line.split(',')
    const h = Number(cells[iHud])
    const p = Number(cells[iPlate])
    const dt = Number(cells[iDt])
    if (!Number.isFinite(h) || !Number.isFinite(p)) continue
    if (firstHud === null) {
      firstHud = h
      firstPlate = p
    }
    lastHud = h
    lastPlate = p
    if (Number.isFinite(dt)) ms += dt
    frames += 1
  }
  if (firstHud === null || frames === 0 || ms <= 0) return null
  const seconds = ms / 1000
  const hudPaints = lastHud - firstHud
  const platePaints = lastPlate - (firstPlate ?? 0)
  return {
    seconds,
    frames,
    hud: { paints: hudPaints, rateHz: hudPaints / seconds, perFrame: hudPaints / frames },
    plate: { paints: platePaints, rateHz: platePaints / seconds, perFrame: platePaints / frames },
  }
}

/**
 * The recording poll: re-derive and re-assert the arm, then read the status.
 * Without an arm it is exactly `traceStatus`.
 */
const tick = async (page: Page): Promise<string | null> => {
  if (HIDE.length > 0 || SOLO.length > 0) await applyArm(page)
  if (HIDE_PATH.length > 0) await setHiddenPaths(page, HIDE_PATH)
  // Re-asserted every poll, for the same reason the group arm is: the ocean
  // cuts a new per-LOD BAND the first time a chunk of that facet size is
  // built, and `game/terrain/load-terrain.ts` builds chunks during the flight.
  // A band born after the arm was thrown would draw the ungated program, and
  // the reading would be a mixture nobody could name. Both calls are no-ops
  // when nothing moved, which is the property that makes re-asserting free.
  if (GATES.length > 0) await applyGates(page)
  // Re-asserted for the same reason as the gates, and DEV-241 gave it a second
  // one: the shipped order is applied where the objects are BUILT, so a level
  // that lands mid-run arrives at the DEFAULT — and an OFF arm that was not
  // re-asserted would quietly go back on and the median would be a mixture.
  for (const arm of ORDER_ARMS) await applyOrder(page, arm.which, arm.on)
  return traceStatus(page)
}

test.describe('@measure @gpu vrto3d', () => {
  test.setTimeout(420_000)

  test('records a worn-path trace through the real compositor', async ({ page }) => {
    knownRed('KR-14')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))

    const query = `perf=1&mission=${MISSION}&autopilot=1&trace=${SECONDS}`
    await page.goto(`/?${EXTRA_QUERY ? `${EXTRA_QUERY}&` : ''}${query}`)
    if (EXTRA_QUERY) console.info(`  A/B: extra query ${EXTRA_QUERY}`)

    // ── A/B arm: switch Anniversary systems off before the recorder arms ───
    //
    // Through the Edition page's own path (`__ff2.edition.set`), the same route
    // `perf-fill.spec.ts` uses — so this is the game reconfiguring itself the
    // way the edition system already allows, not a test-only branch. The
    // recorder does not arm until the ship is flying, so setting it here lands
    // well before the first recorded frame.
    if (FLAGS_OFF.length > 0 || FLAGS_ON.length > 0) {
      await page.waitForFunction(
        () => {
          const w = globalThis as unknown as { __ff2?: { edition?: unknown } }
          return w.__ff2?.edition != null
        },
        { timeout: 120_000 },
      )
      // Two SEGMENTS, always: `block[b].enabled`. A three-segment path would
      // destructure to its first two and quietly switch off the wrong block
      // (`render.shadows.scatter` would turn off `render.shadows`), so the
      // flag a measurement wants has to be a feature block one level under a
      // top-level one — which is what `props.scatterShadows` is.
      const flip = async (dotted: string, enabled: boolean): Promise<void> => {
        await page.evaluate(
          ({ p, enabled }) => {
            const w = globalThis as unknown as {
              __ff2: {
                edition: { current: Record<string, unknown>; setPreset: (e: unknown) => void }
              }
            }
            const e = structuredClone(w.__ff2.edition.current) as Record<string, unknown>
            const parts = p.split('.')
            if (parts.length !== 2) throw new Error(`not a two-segment flag path: ${p}`)
            const [a, b] = parts as [string, string]
            const block = e[a] as Record<string, unknown>
            const target = block[b] as Record<string, unknown> | undefined
            if (target == null) throw new Error(`no such edition block: ${p}`)
            block[b] = { ...target, enabled }
            w.__ff2.edition.setPreset(e)
          },
          { p: dotted, enabled },
        )
      }
      for (const dotted of FLAGS_OFF) await flip(dotted, false)
      for (const dotted of FLAGS_ON) await flip(dotted, true)
      if (FLAGS_OFF.length > 0) console.info(`  A/B: switched OFF ${FLAGS_OFF.join(', ')}`)
      if (FLAGS_ON.length > 0) console.info(`  A/B: switched ON ${FLAGS_ON.join(', ')}`)
    }

    // DEV-265: say it now, with the rig named, rather than spending the wait
    // below proving a fact the capability probe already had.
    await requireImmersiveDevice(page)
    await loadSettled(page, 120_000)

    // ── Did the arm FIRE? ──────────────────────────────────────────────────
    //
    // Here and not at the flip: the flip happens as soon as `__ff2.edition`
    // exists, which is BEFORE the world is built, so nothing about the terrain
    // is answerable then. That gap is not hypothetical — it is precisely where
    // DEV-232's first A/B lost its define. See `MECHANISM_CHECKS`.
    await assertArmFired(page)

    // ── DEV-238: the fragment gates, and the order switches ────────────────
    //
    // Here, with the group arm and for the same reason: `#enter-vr` going
    // enabled is the app's own statement that the world is up, and neither a
    // water material nor an ocean group exists before it.
    //
    // **Both refuse rather than warn.** A gate that reached no material and a
    // switch that saw no mesh both produce a perfectly ordinary 60-second trace
    // with a perfectly ordinary median in it, and the artifact on disk is
    // indistinguishable from a reading. That is DEV-232's 0.025 ms, DEV-231's
    // fourteen withdrawn rows and DEV-230's void 2x2 — three times in one week
    // — and the sentence they share is *a measurement whose mechanism was never
    // checked is not a measurement*. The run has to not happen.
    if (GATES.length > 0) {
      const report = await applyGates(page)
      if (report === null) {
        throw new Error('ARM DID NOT FIRE: the page exposes no __ff2.fragmentGates')
      }
      if (report.defines.length !== GATES.length) {
        throw new Error(
          `ARM DID NOT FIRE: ${GATES.length} gate(s) asked for, ${report.defines.length} known. ` +
            'An unknown name warns and is DROPPED, so a typo costs the whole arm — see ' +
            'FRAGMENT_GATES in src/render/fragment-gates.ts for the list.',
        )
      }
      if (report.carrying === 0 || report.carrying !== report.materials) {
        throw new Error(
          `ARM DID NOT FIRE: ${report.carrying} of ${report.materials} live '${report.which}' ` +
            `material(s) carry ${report.defines.join(' + ')}.\n` +
            'A partial arm is worse than none: the sea would draw some bands through the gated\n' +
            'program and the rest through the ungated one, and the median would be a mixture\n' +
            'with no name. Refusing to record a trace.',
        )
      }
      console.info(
        `  A/B: gates ${GATES.join(',')} on ${report.which} — ${report.carrying}/${report.materials} ` +
          `material(s) carry ${report.defines.join(' + ')}`,
      )
    }
    for (const arm of ORDER_ARMS) {
      const reports = await applyOrder(page, arm.which, arm.on)
      const dead = reports.filter((r) => r.seen === 0)
      if (reports.length !== arm.which.length || dead.length > 0) {
        throw new Error(
          `ARM DID NOT FIRE: draw-order switch(es) ${arm.which.join(',')} reached nothing ` +
            `(${reports.map((r) => `${r.which} seen ${r.seen}`).join(', ') || 'no report at all'}).`,
        )
      }
      // ── the line prints the STATE, not the intent (DEV-241) ────────────
      //
      // `moved` is what this call changed and it is 0 for a `true` on a level
      // that has just loaded, because the sea and the dome ship in this order
      // now. A line that said "ocean on, moved 0 of 4" and nothing else would
      // read exactly like a dead arm — which is how a run gets thrown away —
      // so the state it produced is what is printed, and `moved 0` is
      // annotated as the default already being in force rather than left to be
      // guessed at.
      console.info(
        `  A/B: draw order — ${reports
          .map(
            (r) =>
              `${r.which} ${r.on ? 'ON' : 'OFF'} (${r.moved} of ${r.seen} moved` +
              `${r.moved === 0 ? `, already ${r.on ? 'the default' : 'off'}` : ''})`,
          )
          .join('; ')}`,
      )
    }

    // ── A/B arm: hide or solo stage groups, before the first recorded frame ──
    //
    // HERE, and not earlier, because `__ff2.stage()` answers the moment the app
    // boots and the level lands in it asynchronously: an empty `children` is
    // indistinguishable from a stage that has no ocean, and an arm applied to it
    // would move nothing and report nothing wrong. **`#enter-vr` going enabled
    // is the app's own statement that the world is up**, so the wait above is
    // the signal to use rather than a timer or a child count.
    //
    // And still not later: the recorder arms the instant the ship is flying, and
    // the first seconds of a 60 s median are not free to get wrong.
    if (HIDE.length > 0 || SOLO.length > 0) {
      // The lights three would GATHER, before the arm. This is the baseline the
      // assertion below holds the arm to, and it is read from the live stage
      // rather than assumed, so a mission with a different lighting rig is
      // measured against its own.
      const litBefore = (await stageKeys(page))?.litVisible ?? null
      expect(litBefore, 'the stage answered before it had any lights in it').not.toBeNull()

      // Poll rather than assert first: a group can join a beat after the button
      // enables, and the assertion below is what turns a persistent miss into a
      // failure with the stage's actual contents printed beside it.
      await expect
        .poll(async () => (await applyArm(page))?.missing.length ?? -1, { timeout: 60_000 })
        .toBe(0)
      const armed = await applyArm(page)
      const present = ((await stageKeys(page))?.drawable ?? []).join(', ')
      expect(armed, 'the stage went away between arming and asserting').not.toBeNull()
      const it = armed as NonNullable<typeof armed>

      expect(
        it.missing,
        `The arm named groups the stage does not have: ${it.missing.join(', ')}.\n` +
          `The stage has: ${present}.\n` +
          'A group that matched nothing reads as a system that costs nothing, which is\n' +
          'not a result — see this file’s SOLO comment, rule 1.',
      ).toEqual([])
      expect(
        it.matched.length,
        `the arm planned ${it.hide.length} group(s) and matched none. The stage has: ${present}`,
      ).toBeGreaterThan(0)

      // The planner names keys and the applier finds them again, each with its
      // own copy of the naming rule. Asserting the two SETS agree is true of any
      // correct pair and false the moment they drift — which is the failure a
      // count alone cannot see. (Trap 24.)
      //
      // SETS, deduplicated on both sides, and that is not a weakening. Nothing
      // in three requires a child's name to be unique, and this stage really
      // does carry two top-level children called `sky-dome` — so the planner
      // lists the name twice and the applier, matching by name, hides both and
      // records one. Comparing sorted ARRAYS made that legal scene a failed run:
      // `- "sky-dome"` was the whole diff, and it cost the 2026-09-19 floor
      // sweep its empty-stage arm — the one reading the other fourteen are
      // scored against. Set equality is what the sentence above always meant.
      expect(
        [...new Set(it.matched)].sort(),
        'the planner and the applier disagree about what the stage is called',
      ).toEqual([...new Set(it.hide)].sort())

      // ── the light guard ────────────────────────────────────────────────
      //
      // `projectObject` returns early on `visible === false` BEFORE it pushes a
      // light, so an arm that took the sun down would render its group unlit —
      // a different program, a different fragment cost, and a row comparable
      // with nothing else. The planner cannot name a light by construction;
      // this is the half of the guard that can see a mistake made some other
      // way, such as a light parented under a group an arm does hide.
      expect(
        it.litVisible,
        `the arm changed how many lights the renderer will gather: ${litBefore} -> ${it.litVisible}.\n` +
          'An unlit solo is not a cheap group, it is a different shader — see this\n' +
          'file’s SOLO comment and tests/unit/stage-arms.test.ts.',
      ).toBe(litBefore)

      const what = SOLO.length > 0 ? `SOLO ${SOLO.join(', ')}` : `HID ${HIDE.join(', ')}`
      console.info(
        `  A/B: ${what} — hid ${it.matched.length} group(s), ${it.litVisible} light(s) still gathered`,
      )
    }

    if (HIDE_PATH.length > 0) {
      await expect
        .poll(async () => (await setHiddenPaths(page, HIDE_PATH)).missing.length, {
          timeout: 60_000,
        })
        .toBe(0)
      const nested = await setHiddenPaths(page, HIDE_PATH)
      expect(
        nested.missing,
        `HIDE_PATH named objects the stage does not have: ${nested.missing.join(', ')}`,
      ).toEqual([])
      console.info(
        `  A/B: HID PATH ${nested.matched.join(', ')} — ${nested.matched.length} object(s) locked`,
      )
    }

    // The click is a real user gesture, which is what `requestSession` wants.
    // The consent prompt is already answered by the profile — see the header.
    await enterVr(page)

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const ff2 = (globalThis as unknown as { __ff2?: { render?: { renderer?: unknown } } })
              .__ff2
            const r = ff2?.render?.renderer as { xr?: { isPresenting?: boolean } } | undefined
            return r?.xr?.isPresenting ?? false
          }),
        { timeout: 60_000 },
      )
      .toBe(true)

    // The recorder arms itself once the ship is FLYING and the launch has let go
    // — state-driven, not event-driven (app.ts). So this waits for the recording
    // to start rather than assuming the click did it.
    await expect.poll(async () => tick(page), { timeout: 180_000 }).toBe('recording')
    await expect
      .poll(async () => tick(page), { timeout: (SECONDS + 90) * 1000, intervals: [2000] })
      .toBe('done')

    const summary = await page.evaluate(() => {
      const t = (
        globalThis as unknown as {
          __ff2perf?: { trace?: { summary?: () => unknown; dump?: () => string } }
        }
      ).__ff2perf?.trace
      return { summary: t?.summary?.() ?? null, csv: t?.dump?.() ?? '' }
    })

    fs.mkdirSync(OUT_DIR, { recursive: true })
    const stem = `${MISSION}-${EDITION}-${SECONDS}s-vrto3d`
    fs.writeFileSync(
      path.join(OUT_DIR, `${stem}.summary.json`),
      JSON.stringify(summary.summary, null, 2),
    )
    fs.writeFileSync(path.join(OUT_DIR, `${stem}.trace.csv`), summary.csv)

    // ── what the arm FAILED to hide, named, beside the summary (DEV-231) ───
    //
    // Taken here: the recorder has stopped, so the five off-screen frames of a
    // census cannot reach the trace, and the session is still up and still
    // flying, so the stage is the one that was measured. Before the fix the
    // `empty-stage` arm's file would have read `world-terrain/chunks`,
    // `world-terrain/props:simonet` and `sky-dome` — which is the sentence the
    // 2026-09-19 report could not say, and the reason it printed a table
    // instead of refusing.
    //
    // **An arm that cannot say what it failed to hide is the same defect as the
    // one this file fixes**, so the capture is unconditional: a baseline's
    // residue is the whole frame and is worth having as the comparison.
    const stillDrawn = await residue(page)
    const taken = await censusNow(page)
    const relit = await relitSoFar(page)
    fs.writeFileSync(
      path.join(OUT_DIR, `${stem}.census.json`),
      `${JSON.stringify(
        {
          mission: MISSION,
          edition: EDITION,
          hide: HIDE,
          solo: SOLO,
          relit,
          residue: stillDrawn,
          census: taken.census,
          censusError: taken.error,
        },
        null,
        2,
      )}\n`,
    )
    const fought = Object.entries(relit).filter(([, n]) => n > 0)
    if (fought.length > 0)
      console.info(
        `  A/B: the game tried to re-show ${fought.length} hidden group(s) — ` +
          `${fought.map(([k, n]) => `${k} x${n}`).join(', ')}.\n` +
          '       Every one of those writes landed in the lock and changed nothing.\n' +
          '       Before DEV-231 each of them un-hid its group for the next frame.',
      )
    if (stillDrawn.length > 0)
      console.info(
        `  A/B: still drawable after the arm — ${stillDrawn
          .map((r) => `${r.group} (${r.objects} obj, ${(r.triangles / 1e6).toFixed(2)} M tri)`)
          .join(', ')}`,
      )
    if (taken.error !== null) console.info(`  A/B: census refused in session — ${taken.error}`)

    // ── did the resolution request LAND? (DEV-236) ────────────────────────
    //
    // The guard that would have caught DEV-208's defect on its first run, and
    // did not exist to. `scale` is what the adaptive controller ASKED the
    // runtime for; `vp_w` is the per-eye viewport three read back and drew
    // into. For six weeks those read 0.600 against a full-size 2016 px eye,
    // because `requestViewportScale` was being called on the projection LAYER,
    // which has no such method — and no instrument in the project could put the
    // two beside each other, because the ask was a per-frame column and the
    // outcome was a once-per-run header stamp.
    //
    // Read out of the CSV by COLUMN NAME, off the file's own header line, which
    // is the rule `COLUMNS` states: a reader takes its order from the file. A
    // trace recorded before `vp_w` existed reports `null` here and is skipped
    // rather than failed.
    const landed = viewportScaleLanded(summary.csv)
    if (landed) {
      console.info(
        `\n  viewport scale: asked median ${landed.medianScale.toFixed(3)}, ` +
          `eye width ${landed.minWidth}–${landed.maxWidth} px` +
          (landed.headerWidth === null ? '' : ` against a header ${landed.headerWidth} px`),
      )
    }

    // ── the two panels' repaint rates, over the flight (DEV-243) ──────────
    //
    // Printed on every run, arm or no arm, because the BASELINE's rate is the
    // number the whole question turns on: hiding this panel is worth −2.01 ms
    // of p50 on `int_01_hoverJet` and −0.36 on `adv_02_jumpSeat`, and whether
    // that is the repaint rate is answered by reading both missions' baselines
    // off this line. A number that only appears when somebody remembers to
    // pass an arm is a number nobody has for the runs already on disk.
    const panels = panelPaintRates(summary.csv)
    if (panels) {
      console.info(
        `\n  canvas panels over ${panels.seconds.toFixed(1)} s / ${panels.frames} frames:\n` +
          `    hud    ${panels.hud.paints} paints  ${panels.hud.rateHz.toFixed(1)} Hz  ` +
          `${panels.hud.perFrame.toFixed(2)}/frame\n` +
          `    plate  ${panels.plate.paints} paints  ${panels.plate.rateHz.toFixed(1)} Hz  ` +
          `${panels.plate.perFrame.toFixed(2)}/frame` +
          (panels.plate.paints === 0 ? '   (no ?perf=1, so no plate)' : '') +
          `\n    A panel cannot repaint more often than the frame, so 1.00/frame is the\n` +
          `    ceiling. Two missions both at the ceiling cannot differ 5.6x in rate.`,
      )
    }

    const s = summary.summary as Record<string, { p50: number; p95: number; max: number } | number>
    const stat = (k: string) => s[k] as { p50: number; p95: number; max: number } | undefined
    interface WorstFrame {
      dtMs: number
      elapsedSeconds: number
      calls: number
      triangles: number
      precedingProgramRise: { delta: number; msEarlier: number } | null
      precedingStreamingChange: {
        msEarlier: number
        renderMs: number
        terrainFading: number
        seaPending: number
        seaFading: number
        triangles: number
      } | null
    }
    const worst = (s.worst as WorstFrame[] | undefined) ?? []
    /**
     * What came before a worst frame, as DIFFERENCES. DEV-239 and DEV-242.
     *
     * Both halves on the line, because a stall on this mission is one of two
     * things and the two are told apart by which of these is non-null. The
     * levels are in the CSV; what a reader needs here is the step.
     */
    const cause = (w: WorstFrame | undefined): string => {
      if (!w) return ''
      const rise = w.precedingProgramRise
      const swap = w.precedingStreamingChange
      const bits = [
        rise
          ? `programs +${rise.delta} ${rise.msEarlier.toFixed(0)} ms earlier`
          : 'no program rise',
        swap
          ? `streaming ${swap.msEarlier.toFixed(0)} ms earlier: terrF ${swap.terrainFading >= 0 ? '+' : ''}${swap.terrainFading} · seaP ${swap.seaPending >= 0 ? '+' : ''}${swap.seaPending} · seaF ${swap.seaFading >= 0 ? '+' : ''}${swap.seaFading} · tris ${swap.triangles >= 0 ? '+' : ''}${swap.triangles} · that frame's render ${swap.renderMs.toFixed(1)} ms`
          : 'no streaming change',
      ]
      return bits.join('  |  ')
    }
    console.info(
      `\nvrto3d trace — ${MISSION} ${EDITION}, ${SECONDS} s, through the real compositor\n` +
        `  frames ${s.frames}  fps ${Number(s.fps).toFixed(1)}  budget ${Number(s.budgetMs).toFixed(2)} ms (${s.budgetSource})\n` +
        `  dt     p50 ${stat('dt')?.p50.toFixed(2)}  p95 ${stat('dt')?.p95.toFixed(2)}  max ${stat('dt')?.max.toFixed(2)}\n` +
        `  frame  p50 ${stat('frame')?.p50.toFixed(2)}  p95 ${stat('frame')?.p95.toFixed(2)}\n` +
        `  gpu    p50 ${stat('gpu')?.p50.toFixed(2)}  p95 ${stat('gpu')?.p95.toFixed(2)}  max ${stat('gpu')?.max.toFixed(2)}  (over ${s.gpuFrames} frames)\n` +
        `  hitches ${s.hitches} (${(Number(s.hitchFraction) * 100).toFixed(1)}%)   tier ${(Number(s.tierFraction) * 100).toFixed(0)}%\n` +
        `  worst frame: dt ${worst[0]?.dtMs?.toFixed(1)} ms, ${worst[0]?.calls} calls, ${((worst[0]?.triangles ?? 0) / 1e6).toFixed(2)} M tris\n` +
        worst
          .slice(0, 3)
          .map(
            (w) =>
              `    ${w.elapsedSeconds.toFixed(2).padStart(6)} s  ${w.dtMs.toFixed(1).padStart(6)} ms  ${cause(w)}\n`,
          )
          .join('') +
        // The one worn reference this box has. It is NOT "the same mission" —
        // it is `rookie_01_hoverJet`, and it was printed under that wording on
        // every mission's trace until 2026-09-20. Provenance:
        // `perf-out/capture/ff2-perf-capture-2026-09-19_06-27-22.json`, 69.9 s,
        // budget 11.11 ms measured (a 90 Hz display).
        //
        // READ THE TIER BEFORE COMPARING. The rig above runs pinned; this row
        // ran at `tierFraction: 1` and adaptive `scale` 0.600 — every frame of
        // it in a reprojection tier at a 45.0 Hz cadence, held steadily
        // (`hitchFraction` 0.043). So a rig line that looks better than this
        // one is not measuring the encoder; it is partly measuring the tier.
        // perf-protocol.md §1a has what one worn capture would close.
        `\n  WORN reference — rookie_01_hoverJet, 2026-09-19, 2763 frames,\n` +
        `  AT THE 45 Hz TIER (tier 100%, scale 0.600) — not a like-for-like row:\n` +
        `    dt p50 22.20 p95 33.40 · frame p50 3.60 p95 4.80 · gpu p50 9.52 p95 12.09 · 198 calls · 9.69 M tris\n` +
        `\n  written to ${path.join(OUT_DIR, stem)}.{summary.json,trace.csv,census.json}`,
    )

    expect(errors, `page errors during the run:\n${errors.join('\n')}`).toEqual([])
    expect(Number(s.frames), 'the recorder produced no frames').toBeGreaterThan(100)
    expect(Number(s.gpuFrames), 'no GPU timer results — the gpu column is empty').toBeGreaterThan(0)

    // ── the CONTROL has to be empty or it is not a control (DEV-231) ──────
    //
    // Last, so the run has already written its files and printed its numbers:
    // a failed control is still a measurement of something and the operator
    // will want to see it. But it FAILS, and it fails at the arm rather than
    // only in the runner's report, so the answer arrives three minutes into a
    // 34-minute sweep instead of at the end of it.
    //
    // On the graph walk rather than the census, because the walk cannot throw
    // — see `residue`. The census is written beside it either way.
    if (HIDE.includes('*'))
      expect(
        stillDrawn,
        'THE EMPTY STAGE IS NOT EMPTY. Every other arm is scored against this\n' +
          'reading, so whatever it still draws is added to all of them. The groups\n' +
          'listed are ones the arm hid and something put back — look for a\n' +
          "per-frame `.visible =` write on each (DEV-231, and setHidden's header).",
      ).toEqual([])

    // ── and the resolution request has to have landed (DEV-236) ───────────
    //
    // Same posture and the same position as the control above: the files are
    // written and the numbers are printed first, because a refused request is
    // still a measurement of something. But it FAILS, because the alternative
    // is what happened for six weeks — a `scale` column reading 0.600 through
    // every trace in `perf-out/`, quoted in two reports as a pixel count, while
    // every frame was drawn at full size.
    //
    // It cannot fire on `?adaptive=0`: the controller is pinned at 1.000 there,
    // so the median is 1 and the condition is vacuous. It fires only on a run
    // that spent most of its frames asking for fewer pixels and got none.
    if (landed?.refused === true)
      expect(
        landed,
        `VIEWPORT SCALE DID NOT LAND. The adaptive controller asked for a median\n` +
          `${landed.medianScale.toFixed(3)} and every frame still drew into ` +
          `${landed.minWidth} px per eye` +
          (landed.headerWidth === null ? '' : ` against the session's ${landed.headerWidth}`) +
          `.\nTwo explanations, and they are told apart by ONE reading:\n` +
          `  · __ff2perf.quality().viewportScale is NULL — no request ever reached an\n` +
          `    XRView, so this is our defect. That is DEV-208's shape, where the call\n` +
          `    went to the projection layer, which has no such method.\n` +
          `  · it is a NUMBER — the request landed and the runtime declined it. Legal:\n` +
          `    the spec permits a UA to implement dynamic viewport scaling as a no-op,\n` +
          `    and to clamp to its own minimum viewport scale. Then say so in\n` +
          `    docs/perf-baseline.md and the perf ranking changes, because fewer pixels\n` +
          `    is the only lever left in a frame where nothing dominates.\n` +
          `Do NOT compare this trace's milliseconds against one taken at another scale.`,
      ).toMatchObject({ refused: false })

    // ── and the HUD arm has to have WITHHELD something (DEV-243) ──────────
    //
    // The other half of `MECHANISM_CHECKS['hud.redraw']`, here because it is
    // the earliest point at which it is a question with an answer: the check
    // at the arm runs when `#enter-vr` enables, which is before the ship has
    // flown a metre, and a correct 10 Hz arm reads `skipped: 0` then.
    //
    // What it refuses: a run where the panel never had anything new to draw.
    // `repaints: 9` over sixty seconds is what a 10 Hz arm reports and also
    // what a flight that never left the pad reports — and in the second case
    // the SHIPPED build would not have uploaded either, so the arm removed
    // nothing and whatever the milliseconds did is noise with a story on it.
    // `skipped` counts frames where the panel had something new and the budget
    // withheld it, which is exactly the upload this arm exists to remove.
    //
    // `live` is exempt, because `live` withholding nothing is `live` working.
    if (HUD_REDRAW_ASK !== '' && HUD_REDRAW_ASK !== 'live') {
      const hud = await hudProbe(page)
      console.info(
        `\n  hud redraw: ${hud?.cadence} · ${hud?.repaints} repaints, ` +
          `${hud?.uploads} uploads, ${hud?.skipped} withheld over the run`,
      )
      expect(
        hud?.skipped ?? 0,
        `HUD REDRAW ARM DID NOT FIRE. The panel is on '${hud?.cadence}' and withheld\n` +
          `NOTHING across the whole recording (repaints ${hud?.repaints}, uploads ${hud?.uploads}).\n` +
          'The cadence reached the panel — the check at the arm already proved that — so\n' +
          'what this says is that the panel never had a second thing to draw. A flight\n' +
          'that never moved is one the SHIPPED build would not have uploaded on either,\n' +
          'so this run removed no upload and its milliseconds are not a delta.\n' +
          'Look at the autopilot before you look at the cadence.',
      ).toBeGreaterThan(0)
    }

    // ── and the UPLOAD arm has to still be in force at the END (DEV-244) ──
    //
    // The check at the arm ran when `#enter-vr` enabled, which is before the
    // ship has flown a metre. What it cannot see is the panel being REBUILT
    // mid-run: `boot/app.ts` re-creates the HUD on a course swap and
    // re-asserts the mode onto whatever panel is current, and a recording that
    // began under `nomip` and ended under `mip` would average two builds and
    // look like a weak result rather than a void one.
    //
    // So the mode is re-read off the texture at the end, and the run must also
    // have uploaded more than once — `uploads` is `texture.version`, which
    // starts at 1 because `CanvasTexture`'s constructor uploads the blank
    // canvas before `draw()` has ever run (DEV-243). A run at 1 never repainted
    // at all, which makes any per-upload lever a lever over nothing.
    if (HUD_UPLOAD_ASK !== '') {
      const hud = await hudProbe(page)
      console.info(
        `\n  hud upload: ${hud?.upload} (live ${hud?.liveUpload ?? 'UNRECOGNISED'}) · ` +
          `${hud?.uploads} uploads of ${((hud?.uploadBytes ?? 0) / 1024).toFixed(0)} KiB ` +
          `(${((hud?.bytes ?? 0) / 1024).toFixed(0)} level 0 + ` +
          `${((hud?.mipBytes ?? 0) / 1024).toFixed(0)} chain), ${hud?.mipLevels} mip levels`,
      )
      expect(
        { live: hud?.liveUpload ?? null, upload: hud?.upload ?? null },
        `HUD UPLOAD ARM DID NOT HOLD. It was in force when the world came up and the\n` +
          `texture ended the recording on '${hud?.liveUpload}' against an ask of\n` +
          `'${HUD_UPLOAD_ASK}'. The panel is rebuilt on a course swap and the frame loop\n` +
          're-asserts the mode; if that stopped happening this trace averages two builds.',
      ).toEqual({ live: HUD_UPLOAD_ASK, upload: HUD_UPLOAD_ASK })
      expect(
        hud?.uploads ?? 0,
        `HUD UPLOAD ARM MEASURED NOTHING. The panel uploaded ${hud?.uploads} time(s) across\n` +
          "the whole recording, and the first of those is `CanvasTexture`'s constructor\n" +
          'pushing the blank canvas before anything was drawn. A lever on the cost of an\n' +
          'upload is a lever over nothing when there were no uploads: look at the\n' +
          'autopilot, and at whether a redraw budget is also pinned this run.',
      ).toBeGreaterThan(1)
    }
  })
})
