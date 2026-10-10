/**
 * @gpu Is there a tree on the pad? Asked of the live scene graph.
 *
 * DEV-100. `tests/unit/spawn-clearing.test.ts` sweeps the committed blobs and
 * that is the strong guard; this is the other side of the port. Between the blob
 * and the frame sit `expandPlacements`, `load-props.ts`'s composition
 * (`_root * _child * source.matrix`, a z flip and a yaw negation), the terrain
 * group's own `worldOffset + local + envRoot`, and three's `instanceMatrix`. Every
 * one of those has been wrong at least once — DEV-042 twice, DEV-096 on exactly
 * this data — so a clean blob is not the same claim as clear ground.
 *
 * ── Why `?ride=0` and not a timed launch ─────────────────────────────────
 *
 * The frame that matters is the RELEASE point, and `?ride=0` puts the ship there
 * statically: `createLaunch` starts `rise` at `topRise` when the ride is skipped
 * (DEV-094 §3), so the platform is up, the world is drawn and the phase is still
 * `waiting`. That is not a harness path — it is the switch NEXT.md lists and it is
 * what every retry gives a player. No polling, no 15.5 s climb, no race, and the
 * eye is exactly where DEV-094's census took its frames from.
 *
 * ── What is measured ─────────────────────────────────────────────────────
 *
 * Scattered props are `InstancedMesh`es, so their geometry lives at the origin
 * and the placements live in `instanceMatrix`. Reading `matrixWorld` alone is
 * DEV-096's bug — one flat grey palm per island — so this composes
 * `matrixWorld * instanceMatrix` per instance, which is what the GPU does.
 *
 * ── It measures VERTICES, and two earlier cuts did not ───────────────────
 *
 * **An instance matrix's translation is not the placement.** Alpine's gen1 palette
 * wraps Materialized Mesh bakes whose vertices sit ~285 units from their own
 * origin, and the wrapper prefab's `meshTransform.position` of (63.23, -0.7,
 * 15.22) cancels that inside the 3x3 — but `load-props.ts` composes
 * `_root * _child`, so the translation that comes out is
 * `placement + R_yaw * (s * childPos)`, up to 358 m from the placement at
 * `scaleMax`. Reading it reported a `tree4.glb` 26.2 m from the ship that the
 * blob has at 78 m, and the tree really is at 78 m. A bounding SPHERE was worse
 * again: on those meshes it is enormous and its radius says nothing about a tree.
 *
 * So the probe transforms the geometry's own VERTICES, and the number it asserts
 * on is the closest vertex of any scattered prop to the ship's vertical axis.
 * That is the quantity the picture is about — and it is a DIFFERENT and stronger
 * claim than the unit sweep's, which is about where placements are. Neither is a
 * restatement of the other, and only a browser can make this one: it is the sum
 * of `expandPlacements`, load-props' composition, the terrain group's offset and
 * three's `instanceMatrix`.
 *
 * The bound is the launch ROOM's own circumradius out of `sim/hangar.ts` —
 * derived from the extracted `platform.size` and nothing to do with the clearing
 * — so the claim is *no prop geometry overhangs the structure the player is
 * standing on*. It is deliberately looser than the clearing radius, because how
 * far a canopy leans is a property of bought geometry and not of this rule.
 *
 * ── Only the prop groups, by inclusion and not by exemption ──────────────
 *
 * The first cut exempted the terrain and the water and asked about everything
 * else, and reported the SKY DOME at 1.27 m — it is centred on the camera, so it
 * is always 1.27 m away and always will be. An exemption list is a list that
 * grows every time somebody adds a mesh, and each addition is a chance to exempt
 * the thing the test exists to find. So the walk is by INCLUSION: `props:` (the
 * 2016 scatter DEV-100 governs) and `dressing:` (DEV-089's Anniversary pass).
 *
 * **And `props:` is EVERY environment in the scene, not the mission's.** That
 * is what an inclusion walk means, and it holds whatever the number turns out
 * to be: the walk attributes each instance to the environment group that made
 * it, so a COUNT must be held per environment and never taken as a difference
 * of two whole-scene totals. The last test in this file is the one that learned
 * that the hard way — see its header.
 *
 * The number today is ONE. From DEV-155 (2026-09-16) it was two: the title
 * screen stands in 2016's own forest, a fifth environment `menu` parked 30 km
 * from the island so the two worlds cannot see each other, and `buildWorld`
 * built BOTH — so a mission's scene held the valley too, `visible`, and this
 * walk found it. **DEV-281 (2026-09-21) split the builders**: boot builds one
 * world and it is the one you are looking at, `loadProps('menu')` moved inside
 * `buildTitleWorld`, and the `?title=0&menu=0` boot below lands on `'mission'`.
 * `title-screen.spec.ts` holds the other half of that (*"the title valley, and
 * nothing else"*). For the three DISTANCE tests it never mattered either way —
 * a tree 30 km away is not the nearest anything.
 *
 * ── The dressing is held on its ORIGIN, and that is the stronger form ────
 *
 * The first version of this spec only REPORTED the dressing, because DEV-089's
 * clearance covered the route and the gates and not the spawns — and it was
 * the first thing to measure that: a shrub 16.39 m from `rookie_01_hoverJet`'s
 * release. DEV-103 clears it to the same cylinders, off the same receipt, so it
 * is a claim now. Unlike the palms, a generated prop's instance translation IS
 * its placement (`generate-shapes.ts` normalises the mesh about its own base),
 * so the dressing is held to the recorded radius EXACTLY, on the composed
 * matrix's translation — the rule's own quantity, in the frame the GPU draws
 * it in — rather than to a bound with a prop-width of slack in it. Its vertex
 * figure is still taken and held to the room, the claim the palms make.
 */
import fs from 'node:fs'
import path from 'node:path'
import { hangarSpecFor } from '../../src/sim/hangar'
import { missionReady } from './fixtures/boot'
// DATA, read off disk rather than imported.
//
// `import alpine from '.../alpine.json'` is what this wanted to be and it takes
// the WHOLE Playwright collection to zero — *"needs an import attribute of
// type: json"*, thrown during listing, reported as `Total: 0 tests in 0 files`
// with an exit code of 0. Playwright's loader runs as real ESM, where a JSON
// import needs `with { type: 'json' }`; Vitest's does not, which is why the
// unit tests beside this one import JSON freely and this cannot. Same class as
// the `import.meta.glob` edge that did it before — **read the first line of the
// output, not the exit code.**
//
// `readFileSync` has no such rule, runs at module scope, and is exactly what
// the spec below wants: the numbers, from the file, so moving a pass moves the
// expectation with it.
import { focusCanvas } from './fixtures/canvas'
import { firstPress } from './fixtures/landing'
import { CORRIDOR_MISSION, CORRIDOR_MISSION_CLEARS } from './fixtures/no-prop-volumes'
import { SLOPE_CLEARS } from './fixtures/slope-clears'
import { expect, type Page, test } from './fixtures/test'

/**
 * Where the frames land.
 *
 * Playwright wipes `test-results/` at the START of every run, so a before/after
 * pair taken across two runs loses its first half — the trap `FOG_SWEEP_DIR`
 * exists for. Point `SPAWN_CLEARING_DIR` somewhere else when taking a pair, and
 * `SPAWN_CLEARING_LABEL` names the half.
 */
const SHOT_DIR = process.env.SPAWN_CLEARING_DIR ?? 'test-results/spawn-clearing'
const LABEL = process.env.SPAWN_CLEARING_LABEL ?? 'after'

/** The environment JSON's own recorded radius. The spec does not choose a number. */
const radiusFor = (environment: string): number =>
  (
    JSON.parse(fs.readFileSync(`content/environments/${environment}.json`, 'utf8')) as {
      spawnClearing?: { radius: number }
    }
  ).spawnClearing?.radius ?? 0

/** `sim/hangar.ts`, off the extracted `platform.size`. Nothing to do with the clearing. */
const ROOM_RADIUS = hangarSpecFor().roomRadius

interface Group {
  /** Closest VERTEX of any instance to the ship's vertical axis, metres. */
  nearestVertex: number
  nearestName: string
  /**
   * Closest instance ORIGIN — the composed matrix's translation — to the axis.
   * For a generated prop that IS the placement, and DEV-103 holds the dressing
   * to it; for an MM bake it is not (see the header) and it is reported only.
   */
  nearestOrigin: number
  nearestOriginName: string
  instances: number
  /** Instances whose geometry comes within the reporting limit, nearest first. */
  within: { name: string; vertex: number }[]
}
interface Nearby {
  /** THREE space. x and z are the clearing's axis; y is only for the log. */
  shipX: number
  shipY: number
  shipZ: number
  phase: string
  /** Keyed by the top-level group prefix: `props` (2016's scatter) or `dressing`. */
  groups: Record<string, Group>
}

/**
 * Every SCATTERED prop drawn near the ship's vertical axis, by group.
 *
 * `limit` only bounds the reported list; the nearest figures are over everything.
 */
const nearbyAtShip = (page: Page, limit: number): Promise<Nearby> =>
  page.evaluate((lim) => {
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const ff = (globalThis as any).__ff2
    const s = ff?.flight?.()?.jet.body.position
    // THREE space: the sim's z is mirrored.
    const ax = s?.x ?? 0
    const az = -(s?.z ?? 0)
    const scene = ff.render.scene
    scene.updateMatrixWorld(true)

    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const drawn = (o: any): boolean => {
      for (let n = o; n; n = n.parent) if (n.visible === false) return false
      return true
    }
    /** Which scatter group this mesh belongs to, or null if it is not scenery. */
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const groupOf = (o: any): string | null => {
      for (let n = o; n; n = n.parent) {
        const name: string = n.name ?? ''
        if (name.startsWith('props:')) return 'props'
        if (name.startsWith('dressing:')) return 'dressing'
      }
      return null
    }

    const groups: Record<
      string,
      {
        nearestVertex: number
        nearestName: string
        nearestOrigin: number
        nearestOriginName: string
        instances: number
        within: { name: string; vertex: number }[]
      }
    > = {}

    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    scene.traverse((o: any) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return
      if (!drawn(o)) return
      const group = groupOf(o)
      if (group === null) return
      if (groups[group] === undefined) {
        groups[group] = {
          nearestVertex: Number.POSITIVE_INFINITY,
          nearestName: '',
          nearestOrigin: Number.POSITIVE_INFINITY,
          nearestOriginName: '',
          instances: 0,
          within: [],
        }
      }
      const bucket = groups[group]
      const g = o.geometry
      if (!g.boundingSphere) g.computeBoundingSphere()
      const bs = g.boundingSphere
      const p = g.attributes.position
      const m = o.matrixWorld.elements as number[]
      const name: string = o.name || o.parent?.name || o.type

      /** Horizontal distance from the axis to a local point through `e`. */
      const at = (e: number[], x: number, y: number, z: number): number => {
        const wx =
          (e[0] as number) * x + (e[4] as number) * y + (e[8] as number) * z + (e[12] as number)
        const wz =
          (e[2] as number) * x + (e[6] as number) * y + (e[10] as number) * z + (e[14] as number)
        return Math.hypot(wx - ax, wz - az)
      }

      /**
       * One instance: a conservative sphere reject, then every vertex.
       *
       * The reject uses the geometry's own bounding SPHERE, transformed — which is
       * useless as a MEASUREMENT on the MM bakes (see the header) but perfectly
       * sound as a bound, because a transformed sphere still contains the mesh.
       */
      const consider = (e: number[]) => {
        bucket.instances++
        // The origin, over EVERY instance and before the sphere reject: for a
        // generated prop it is the placement itself, and it is one hypot.
        const o = Math.hypot((e[12] as number) - ax, (e[14] as number) - az)
        if (o < bucket.nearestOrigin) {
          bucket.nearestOrigin = o
          bucket.nearestOriginName = name
        }
        const sx = Math.hypot(e[0] as number, e[1] as number, e[2] as number)
        const sy = Math.hypot(e[4] as number, e[5] as number, e[6] as number)
        const sz = Math.hypot(e[8] as number, e[9] as number, e[10] as number)
        const r = bs.radius * Math.max(sx, sy, sz)
        if (at(e, bs.center.x, bs.center.y, bs.center.z) - r > lim) return
        let nearest = Number.POSITIVE_INFINITY
        for (let i = 0; i < p.count; i++) {
          const d = at(e, p.getX(i), p.getY(i), p.getZ(i))
          if (d < nearest) nearest = d
        }
        if (nearest < bucket.nearestVertex) {
          bucket.nearestVertex = nearest
          bucket.nearestName = name
        }
        if (nearest < lim) bucket.within.push({ name, vertex: nearest })
      }

      if (o.isInstancedMesh && o.instanceMatrix) {
        // DEV-096: the placements are HERE, not in matrixWorld.
        const a = o.instanceMatrix.array as Float32Array
        const e: number[] = new Array(16).fill(0)
        for (let i = 0; i < o.count; i++) {
          // matrixWorld * instanceMatrix, column-major.
          for (let c = 0; c < 4; c++) {
            for (let r = 0; r < 4; r++) {
              let v = 0
              for (let k = 0; k < 4; k++) {
                v += (m[k * 4 + r] as number) * (a[i * 16 + c * 4 + k] as number)
              }
              e[c * 4 + r] = v
            }
          }
          consider(e)
        }
        return
      }
      consider(m)
    })

    for (const g of Object.values(groups)) {
      g.within.sort((a, b) => a.vertex - b.vertex)
      g.within = g.within.slice(0, 12)
    }
    return {
      shipX: ax,
      shipY: s?.y ?? 0,
      shipZ: az,
      phase: ff?.launch?.().phase ?? 'none',
      groups,
    }
  }, limit)

/**
 * Every `props:` instance, attributed to the scatter pass that made it — and
 * counted TWICE, because since DEV-225 there are two numbers and this spec is
 * about one of them.
 *
 * ── HOLDS and DRAWN are different questions (DEV-267) ────────────────────
 *
 * `InstancedMesh.count` used to be the whole batch. DEV-225 (2026-09-19) wired
 * 2016's per-chunk reveal, and `load-props.ts` now says it plainly: *"`inst.
 * instanceMatrix` holds only what is DRAWN, compacted to the front; `source`
 * holds every instance the batch owns"*. `batch.apply(plan)` moves `inst.count`
 * to the length of that prefix as chunks pass their generator's `lodDistance`.
 *
 * So `.count` stopped answering *"how many did this pass build?"* and started
 * answering *"how many are within 1920 m of the camera right now?"*. This spec
 * asks the first question — every assertion below is against a `placements.
 * count` recorded at BAKE time, which no camera can move — so it reads
 * `instanceMatrix.count`, the capacity, which is the batch's whole source.
 *
 * The reveal is not ignored. It is asserted separately and on its own terms,
 * because dropping `.count` entirely would leave this file unable to tell a
 * working reveal from one that culled the world.
 */
interface PassCensus {
  /**
   * Instances each pass HOLDS, keyed `<environmentId>:<pass index>` — the
   * environment group's own name and `props:scatter:<n>`'s own suffix, which is
   * `entry.index`: the pass's index in the ENVIRONMENT JSON, not in the
   * filtered list the preset drew. So a key indexes `scatter[]` directly.
   */
  byPass: Record<string, number>
  /** What each of those passes currently DRAWS — DEV-225's revealed prefix. */
  drawnByPass: Record<string, number>
  /**
   * What each pass DID NOT build, because an authored no-prop volume took it
   * out — DEV-287, off the pass group's own `userData.clearedByVolumes`.
   *
   * It is here so the count assertion can stay exact. A pass used to hold its
   * baked `placements.count` and now holds that minus the volumes, so the
   * claim worth making is the CONSERVATION one: every baked placement is
   * either drawn or deliberately removed, and nothing evaporates. Read in the
   * same scene walk as `byPass`, because two halves of one equation taken from
   * two frames are not an equation.
   */
  clearedByPass: Record<string, number>
  /**
   * What each pass DID NOT build because its rendered facet was steeper than
   * `props.maxSlope` — DEV-356, off `userData.clearedBySlope`. A separate
   * receipt from the volumes because the two have separate claims: the volumes
   * apply on BOTH presets, the slope limit on Anniversary alone.
   */
  clearedBySlopeByPass: Record<string, number>
  /**
   * What each pass DID NOT build because its base stood under the sea's
   * high-water mark: DEV-862, off `userData.clearedByWater`. On BOTH looks, and
   * zero wherever there is no ocean.
   */
  clearedByWaterByPass: Record<string, number>
  /** Every `props:` instance the scene holds, whatever made it. */
  total: number
  /**
   * Drawn `props:` instances that are NOT inside a scatter pass — `props:landmarks`
   * (DEV-135) today, a fracture piece mid-break, whatever arrives next. Held
   * EQUAL across the presets rather than at zero: a landmark is drawn on both,
   * so it cannot be in the gap, and that is the claim worth making.
   */
  unattributed: number
  /** Whether the Anniversary dressing drew anything at all. */
  dressing: number
}

/**
 * The scatter, counted and attributed. Deliberately NOT `nearbyAtShip`.
 *
 * This is a claim about which PASSES a preset built, so it needs no vertices
 * and no ship — and running the per-vertex probe for a number that is a sum of
 * `InstancedMesh` counts would be twelve thousand transforms for nothing.
 */
const passCensus = (page: Page): Promise<PassCensus> =>
  page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    const ff = (globalThis as any).__ff2
    const scene = ff.render.scene
    scene.updateMatrixWorld(true)
    const byPass: Record<string, number> = {}
    const drawnByPass: Record<string, number> = {}
    const clearedByPass: Record<string, number> = {}
    const clearedBySlopeByPass: Record<string, number> = {}
    const clearedByWaterByPass: Record<string, number> = {}
    let total = 0
    let unattributed = 0
    let dressing = 0
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
    scene.traverse((o: any) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return
      for (let n = o; n; n = n.parent) if (n.visible === false) return
      // DEV-267: the batch's whole source, and the prefix of it being drawn.
      // `instanceMatrix.count` is allocated once at build and never moves;
      // `count` is where DEV-225's reveal has put the boundary this frame.
      //
      // DEV-338 gave every batch coarser RUNGS, each its own InstancedMesh
      // named `<mesh>:lod<N>` with the batch's FULL capacity, so a prop is
      // HELD once — by rung 0 — however many rungs could draw it, and is
      // DRAWN by exactly one of them (`packRange` splits the batch's runs
      // between rungs, never overlapping). Counting every rung's capacity held
      // each prop three times on Anniversary: `alpine:0` read 12,390 against a
      // blob of 6,035, and 12,390 is exactly 3 x 4,130, the pass's survivors.
      // Classic builds no rungs, which is why it went on balancing.
      const lowerRung = /:lod\d+$/.test(o.name ?? '')
      const n = o.isInstancedMesh ? (lowerRung ? 0 : (o.instanceMatrix?.count ?? 0)) : 1
      const nDrawn = o.isInstancedMesh ? o.count : 1
      // The walk runs OUTWARD, so the last `props:` name that is not a pass
      // wins — `props:alpine` over the `props:tree1.glb` on the mesh itself and
      // over the `props:landmarks` in between.
      let environment: string | null = null
      let pass: string | null = null
      // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
      let passNode: any = null
      let isProps = false
      // biome-ignore lint/suspicious/noExplicitAny: reaching into the live scene graph
      for (let a: any = o; a; a = a.parent) {
        const name: string = a.name ?? ''
        if (name.startsWith('dressing:')) {
          dressing += n
          return
        }
        if (name.startsWith('props:scatter:')) {
          pass = name.slice('props:scatter:'.length)
          passNode = a
        } else if (name.startsWith('props:')) {
          isProps = true
          environment = name.slice('props:'.length)
        }
      }
      if (!isProps) return
      total += n
      if (environment !== null && pass !== null) {
        const key = `${environment}:${pass}`
        byPass[key] = (byPass[key] ?? 0) + n
        drawnByPass[key] = (drawnByPass[key] ?? 0) + nDrawn
        // Assigned, never accumulated: it is one number per PASS and this walk
        // reaches it once per drawn mesh. `?? 0` covers a pass group built
        // before DEV-287 existed, which is the same answer as no volumes.
        clearedByPass[key] = passNode?.userData?.clearedByVolumes ?? 0
        clearedBySlopeByPass[key] = passNode?.userData?.clearedBySlope ?? 0
        clearedByWaterByPass[key] = passNode?.userData?.clearedByWater ?? 0
      } else unattributed += n
    })
    return {
      byPass,
      drawnByPass,
      clearedByPass,
      clearedBySlopeByPass,
      clearedByWaterByPass,
      total,
      unattributed,
      dressing,
    }
  })

const bootAtRelease = async (page: Page, mission: string, extra = ''): Promise<void> => {
  // `ride=0` -> the platform starts at `topRise`, so this IS the release point.
  await page.goto(`/?mission=${mission}&xr=off&title=0&menu=0&ride=0${extra}`)
  await firstPress(page)
  await missionReady(page, 240_000)
  await focusCanvas(page)
  // The props are loaded after the terrain; give the scatter a moment to land.
  await page.waitForTimeout(3_000)
}

const save = async (
  page: Page,
  testInfo: import('@playwright/test').TestInfo,
  name: string,
): Promise<string> => {
  const shot = await page.locator('#viewport').screenshot()
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const at = path.join(SHOT_DIR, name)
  fs.writeFileSync(at, shot)
  testInfo.annotations.push({ type: 'screenshot', description: at })
  return at
}

/** The three the row is argued on: two alpine spawns, and a desert one. */
const MISSIONS: { id: string; environment: string; why: string }[] = [
  { id: 'rookie_01_hoverJet', environment: 'alpine', why: 'DEV-094 §6: the pad inside a canopy' },
  { id: 'rookie_01_jumpSeat', environment: 'alpine', why: 'DEV-094 §6: a trunk up the middle' },
  { id: 'rookie_02_hoverJet', environment: 'desert', why: 'the desert has bushes, and a rig' },
]

test.describe('@gpu nothing but ground stands on a mission spawn', () => {
  test.setTimeout(300_000)

  for (const m of MISSIONS) {
    test(`${m.id}: clear to the recorded radius at the release point`, async ({
      page,
    }, testInfo) => {
      const radius = radiusFor(m.environment)
      expect(radius, `a recorded radius for ${m.environment}`).toBeGreaterThan(0)

      // `?fog=off`: alpine's fog buries the eye at 112 m (DEV-094 §6), so every
      // frame in that row was taken this way and so is every frame here. The
      // MEASUREMENT does not care, and is taken on the same load as the picture.
      // `?edition=anniversary`, pinned rather than defaulted: the dressing half
      // below is an Anniversary claim and must not evaporate if the default
      // ever moves. The props half is a Classic claim too, and the last test
      // boots Classic for it.
      await bootAtRelease(page, m.id, '&fog=off&edition=anniversary')
      // 120 m: wide enough that the whole edge of the clearing is in the report,
      // narrow enough that the per-vertex pass only touches a few dozen instances
      // out of twelve thousand.
      const near = await nearbyAtShip(page, 120)

      // Saved BEFORE the assertions, so a red run still leaves the picture that
      // explains why it is red — which is how the before half of the pair is taken.
      const shot = await save(page, testInfo, `${m.id}-${LABEL}.png`)
      console.log(
        `spawn-clearing ${m.id}: ship (${near.shipX.toFixed(1)}, ${near.shipY.toFixed(2)}, ` +
          `${near.shipZ.toFixed(1)}) phase ${near.phase} -> ${shot}`,
      )
      for (const [name, g] of Object.entries(near.groups)) {
        console.log(
          `  ${name}: ${g.instances} drawn, nearest vertex ${g.nearestVertex.toFixed(2)} m ` +
            `(${g.nearestName}), nearest origin ${g.nearestOrigin.toFixed(2)} m ` +
            `(${g.nearestOriginName})` +
            (name === 'dressing'
              ? '   [DEV-103: held to the recorded radius on the origin, which IS its placement]'
              : "   [origin reported only: an MM bake's translation is not its placement]"),
        )
        for (const w of g.within) {
          console.log(`    ${w.vertex.toFixed(2).padStart(8)} m  ${w.name}`)
        }
      }

      const props = near.groups.props
      // A probe that found nothing is not a pass.
      expect(props, `${m.id}: the 2016 scatter drew nothing at all`).toBeTruthy()
      expect(props?.instances ?? 0, `${m.id}: the scatter drew instances`).toBeGreaterThan(100)

      // The ship has not left yet, and the axis measured above really is the
      // mission's own spawn axis. Not `phase === 'waiting'`: six of the thirteen
      // have no launch rig at all, so a JumpSeat's phase says nothing — which is
      // how the first version of this assertion was wrong, on the one mission
      // DEV-094 §6 names. The POSITION says it for every vehicle.
      const spawn = (
        JSON.parse(fs.readFileSync(`content/levels/${m.id}.json`, 'utf8')) as {
          spawn: { pos: number[] }
        }
      ).spawn.pos
      const drift = Math.hypot(
        near.shipX - (spawn[0] as number),
        // The level JSON is THREE space, and so is `shipZ`.
        near.shipZ - (spawn[2] as number),
      )
      expect(
        drift,
        `${m.id}: the ship is ${drift.toFixed(2)} m off its own spawn axis, so the ` +
          'measurement below is not about this clearing',
      ).toBeLessThan(2)
      const nearest = props?.nearestVertex ?? 0

      // THE CLAIM: no scattered prop's GEOMETRY overhangs the launch structure the
      // player is standing on. The bound is the launch room's own circumradius out
      // of `sim/hangar.ts`, off the extracted `platform.size` — a separate
      // derivation from the clearing radius, so this is not that number restated.
      expect(
        nearest,
        `${m.id} (${m.why}): scattered prop geometry reaches to ${nearest.toFixed(2)} m from the ` +
          `ship (${props?.nearestName}), inside the launch room's own ` +
          `${ROOM_RADIUS.toFixed(2)} m footprint. The clearing is ${radius.toFixed(2)} m.`,
      ).toBeGreaterThan(ROOM_RADIUS)

      // And the clearing itself has to contain that footprint, or the rule does not
      // cover the structure at all.
      expect(radius, "the clearing contains the launch room's footprint").toBeGreaterThan(
        ROOM_RADIUS,
      )

      // THE SECOND CLAIM (DEV-103): the Anniversary dressing stands off the same
      // cylinders. Its instance origin IS its placement, so this is the recorded
      // radius EXACTLY — `insideAnyClearing` rejects strictly inside, hence >=.
      // Before the row: a shrub at 16.39 m, on this very mission.
      const dressing = near.groups.dressing
      expect(dressing, `${m.id}: the Anniversary dressing drew nothing at all`).toBeTruthy()
      expect(dressing?.instances ?? 0, `${m.id}: the dressing drew instances`).toBeGreaterThan(100)
      const origin = dressing?.nearestOrigin ?? 0
      expect(
        origin,
        `${m.id}: a dressing placement (${dressing?.nearestOriginName}) stands ` +
          `${origin.toFixed(2)} m from the ship, inside the ${radius.toFixed(2)} m clearing ` +
          'the palms were baked to leave alone (DEV-103)',
      ).toBeGreaterThanOrEqual(radius)
      // And its geometry, like the palms', does not reach the room the player is
      // standing in — the same structural claim, held to the same bound.
      const dressingVertex = dressing?.nearestVertex ?? 0
      expect(
        dressingVertex,
        `${m.id}: dressing geometry (${dressing?.nearestName}) reaches to ` +
          `${dressingVertex.toFixed(2)} m, inside the launch room's ${ROOM_RADIUS.toFixed(2)} m`,
      ).toBeGreaterThan(ROOM_RADIUS)
    })
  }

  test('the presets differ by exactly the passes 2016 never ran, one per environment', async ({
    page,
  }) => {
    // This test used to assert *"the same instance count"*, and DEV-102 made
    // that false ON PURPOSE on 2026-09-14: Classic draws what 2016 SHIPPED and
    // Anniversary also draws the passes 2016 authored and never ran.
    //
    // The ORIGINAL claim survives underneath and is still what matters —
    // DEV-100's spawn clearing is a Classic change, it lives in the placements
    // blob, which is content, so both presets read the same placements. What
    // changed is only WHICH passes each reads.
    //
    // ── Why this is attributed per PASS and not a single subtraction ───────
    //
    // The version written on 2026-09-14 asserted one number — *"the gap between
    // the presets IS the pass 2016 never ran"* — against `alpine.json`'s one
    // never-baked pass, 6,035. It went red at **10,092** on a clean checkout,
    // and the 4,057 it had gained was not a changed bake and not a moved
    // placement. **A whole-scene tally is a claim about the whole scene, and
    // the scene grew a second environment two days later.** DEV-155
    // (2026-09-16) stands the title screen in 2016's own forest, which is a
    // FIFTH environment, `menu`, loaded by its own `loadProps('menu')` in
    // `app.ts` and parked 30 km from the island so the two worlds never see
    // each other. Boot built both worlds then, so it was in the scene during a
    // mission, it was `visible`, and it reads the SAME `props.unbakedPasses`
    // flag — so it brought its own never-run pass to the difference:
    //
    //     alpine:0   6,035   never baked (m_Enabled 0, _StoredChunks empty)
    //     menu:0     4,057   never baked, likewise
    //                ─────
    //                10,092  = the measured gap, exactly
    //
    // Nothing had regressed. The test's PREMISE had, and the fix is not a new
    // literal — it is to stop subtracting two whole-scene totals and attribute
    // every instance to the pass that made it. Each pass is then held to its
    // own `placements.count`, and the headline difference falls out as a
    // consequence rather than being the only thing measured. An environment
    // joining or leaving the scene now says so by name instead of moving a
    // number nobody can source.
    //
    // **And it left again, five days later, which is the other half of the
    // same argument.** DEV-281 (2026-09-21) made boot build one world, so a
    // `?menu=0` boot no longer holds the title valley at all and the gap is
    // alpine's never-run pass once more — the number the 2026-09-14 version
    // was written against. Its structure would have gone green on the way back
    // and proved nothing about why. This one moved exactly one assertion, the
    // one that NAMES the set, and every per-pass claim below was keyed by
    // environment name and did not move. That is what the attribution bought,
    // and it is worth more than the literal it replaced.
    //
    // (When both ARE in one scene — the title boot, today — they index their
    // palettes in opposite order: alpine's never-run pass is `scatter[0]`, the
    // ten Tree Pack `*-lod0.glb`; menu's is `scatter[0]` too but holds the ten
    // `MM_Tree*` bakes, which are alpine's `scatter[1]`. Keying on
    // `entry.index` rather than on a palette keeps that straight.)
    //
    // `anniversary-ab.spec.ts` is a capture tool and its pair differs in ACES,
    // haze and bloom on every pixel, so a picture cannot show any of this. A
    // measurement can, and it is the same measurement on both sides rather than
    // two of our own devices compared to each other (DEV-069): one of them is
    // the shipped default and the other is one keypress away.
    const id = CORRIDOR_MISSION
    await bootAtRelease(page, id, '&fog=off&edition=anniversary')
    const anniversary = await passCensus(page)
    // DEV-452 (D35): what STANDS is rules (it is solid), so a player's Classic
    // look plants Anniversary's scatter; 2016's is the development switch's.
    await bootAtRelease(page, id, '&fog=off&edition=classic&rules=classic')
    const classic = await passCensus(page)

    // Both numbers, always, and the ratio between them — so a failure here
    // arrives with the evidence for which of the two moved rather than one
    // number and a guess. (`census-baseline.spec.ts` printed its `saw` line
    // thirty seconds from the answer and it went unread for a day.)
    const report = (label: string, c: PassCensus): void =>
      console.log(
        `spawn-clearing ${label}: ${c.total} props instances held ` +
          `(${c.unattributed} outside any scatter pass), ${c.dressing} dressing\n` +
          Object.entries(c.byPass)
            .sort()
            .map(([k, v]) => {
              const drawn = c.drawnByPass[k] ?? 0
              const pct = v === 0 ? 0 : Math.round((100 * drawn) / v)
              const cleared = c.clearedByPass[k] ?? 0
              const steep = c.clearedBySlopeByPass[k] ?? 0
              const drowned = c.clearedByWaterByPass[k] ?? 0
              return `    ${k.padEnd(14)} holds ${String(v).padStart(5)}  draws ${String(
                drawn,
              ).padStart(5)}  (${pct}% revealed)${
                cleared > 0 ? `  — ${cleared} cleared by no-prop volumes` : ''
              }${steep > 0 ? `  - ${steep} off steep ground (DEV-356)` : ''}${
                drowned > 0 ? `  - ${drowned} under the sea (DEV-862)` : ''
              }`
            })
            .join('\n'),
      )
    report('anniversary', anniversary)
    report('classic', classic)

    expect(anniversary.total, 'anniversary drew the scatter').toBeGreaterThan(100)
    expect(classic.total, 'classic drew the scatter').toBeGreaterThan(100)

    // ── which environments are in the scene, and why there is one ──────────
    //
    // The mission's own, read off its level JSON, and nothing else. Which
    // environments a boot builds is a fact about `app.ts` and derivable from no
    // content file, so it is named here WITH its reason rather than accepted
    // silently. Pinning the set is the point: it is what the 2026-09-14 version
    // could not say, and an environment arriving or leaving must be argued, not
    // absorbed into a difference.
    //
    // It WAS two, and the comment this one replaces said the assertion below
    // "must be edited, loudly and on purpose, if that ever changes". This is
    // that edit. `buildWorld` made both worlds in one `Promise.all` and only
    // `switchMission`'s `teardownWorld` disposed the valley, so a player
    // reaching this course off a holotable flew with one environment in the
    // scene and this spec ran with two. **DEV-281 closed that gap from the
    // other end**: boot builds one world and it is the one you are looking at,
    // `loadProps('menu')` lives inside `buildTitleWorld`, and this spec's
    // `?title=0&menu=0` boot lands on `'mission'` — so the valley is never
    // built here. The spec and the player now see the same scene, which is the
    // better reason for this assertion than the pair ever was.
    //
    // `title-screen.spec.ts` asserts the same fact from the title side
    // (*"the title valley, and nothing else"*), and `boot-one-world.test.ts`
    // asserts the separation of the two builders on the gate CI actually runs.
    const missionEnvironment = (
      JSON.parse(fs.readFileSync(`content/levels/${id}.json`, 'utf8')) as { environment: string }
    ).environment
    const environmentsIn = (c: PassCensus): string[] =>
      [...new Set(Object.keys(c.byPass).map((k) => k.slice(0, k.lastIndexOf(':'))))].sort()
    const environments = environmentsIn(anniversary)
    expect(
      environments,
      "the scene holds the mission's environment and nothing else (DEV-281)",
    ).toEqual([missionEnvironment])
    // This one needed no edit when the set changed, and that is not luck: it
    // asserts a RELATIONSHIP against the line above rather than a value of its
    // own (the orientation lesson's general form). A preset selects passes,
    // never environments — true of one environment and of two.
    expect(
      environmentsIn(classic),
      'and Classic holds the same ones — a preset selects passes, never environments',
    ).toEqual(environments)

    // ── each environment: one pass 2016 baked, one it never ran ────────────
    interface Pass {
      index: number
      shipped2016: { bakedObjects: number }
      placements: { count: number }
    }
    // `placements.count` is ALREADY the post-clearing figure and
    // `clearedBySpawnClearing` is a RECEIPT of what was dropped, not a pending
    // subtraction — `bake-placements.mjs` runs the scatter twice and stores the
    // cleared run's count with the difference beside it, *"so `cleared` in the
    // receipt is a count and not a claim"*. Subtracting it again double-counts,
    // which is how the first version of this test was off by exactly 38 props.
    //
    // Nor is it `shipped2016.bakedObjects`: that is what 2016 SERIALISED
    // (alpine 6,097, menu 3,999) and this port re-runs the generator, so the
    // two differ by tens. `bakedObjects` decides WHETHER a pass ships;
    // `placements.count` is HOW MANY it draws. The numbers here are the second.
    //
    // ── and since DEV-287 the claim is a CONSERVATION law ─────────────────
    //
    // A pass used to hold `placements.count` exactly. It does not any more:
    // `content/no-prop-volumes.json` culls placements at LOAD, deliberately,
    // so alpine's launch corridor leaves `alpine:0` and `alpine:1` each 36
    // short of their blobs on the two HoverJet missions. That is the feature,
    // not a regression, and the bake is untouched on purpose (the volumes
    // resolve per MISSION and one blob serves four).
    //
    // So the assertion is `held + cleared === count` rather than a looser
    // `<=`. It is STRONGER than the equality it replaces: it says every baked
    // placement is either built or deliberately removed and nothing
    // evaporates, and it still fails if a pass silently loses one. `cleared`
    // is the runtime's own receipt off the pass group, read in the same scene
    // walk as `held` — not this file re-deriving the volumes, which would
    // agree with the bug (trap 24).
    //
    // DEV-356 adds a third term, the slope limit's own receipt, for the same
    // reason and in the same scene walk: a steep placement is deliberately
    // removed, not lost.
    const heldOf = (c: PassCensus, key: string): number | undefined =>
      c.byPass[key] === undefined
        ? undefined
        : (c.byPass[key] ?? 0) +
          (c.clearedByPass[key] ?? 0) +
          (c.clearedBySlopeByPass[key] ?? 0) +
          (c.clearedByWaterByPass[key] ?? 0)
    let gap = 0
    for (const environment of environments) {
      const scatter = (
        JSON.parse(
          fs.readFileSync(path.join('content', 'environments', `${environment}.json`), 'utf8'),
        ) as { scatter: readonly Pass[] }
      ).scatter
      const baked = scatter.filter((p) => p.shipped2016.bakedObjects > 0)
      const never = scatter.filter((p) => p.shipped2016.bakedObjects === 0)
      expect(baked, `${environment} baked exactly one of its two passes in 2016`).toHaveLength(1)
      expect(never, `${environment} authored exactly one it never ran`).toHaveLength(1)

      for (const p of scatter) {
        const key = `${environment}:${p.index}`
        expect(
          heldOf(anniversary, key),
          `${key}: Anniversary BUILDS every pass 2016 SET UP — held ` +
            `${anniversary.byPass[key]} + ${anniversary.clearedByPass[key] ?? 0} cleared by ` +
            `no-prop volumes (DEV-287) + ${anniversary.clearedBySlopeByPass[key] ?? 0} off ` +
            `steep ground (DEV-356) + ${anniversary.clearedByWaterByPass[key] ?? 0} under the ` +
            'sea (DEV-862) must be its recorded count',
        ).toBe(p.placements.count)
      }
      for (const p of baked) {
        const key = `${environment}:${p.index}`
        expect(
          heldOf(classic, key),
          `${key}: Classic BUILDS what 2016 BAKED — held ${classic.byPass[key]} + ` +
            `${classic.clearedByPass[key] ?? 0} cleared by no-prop volumes (DEV-287) must be ` +
            'its recorded count. The volumes apply on BOTH presets, like DEV-100.',
        ).toBe(p.placements.count)
      }
      for (const p of never) {
        const key = `${environment}:${p.index}`
        expect(
          classic.byPass[key],
          `${key}: 2016 never ran this pass, so Classic must not build it`,
        ).toBeUndefined()
        expect(
          p.placements.count,
          `${key} is not empty, or this environment proves nothing`,
        ).toBeGreaterThan(0)
        // The recorded bake LESS what the art direction removed, for the same
        // reason the assertions above became a conservation law: the gap
        // between the presets is what Anniversary actually holds for this
        // pass, and since DEV-287 that is the blob minus the volumes. The
        // count still comes from CONTENT and only the subtraction comes from
        // the page, so this stays a claim and does not become a tautology.
        gap += p.placements.count - (anniversary.clearedByPass[key] ?? 0)
      }
      // DEV-356: and the slope limit takes props off EVERY pass Anniversary
      // builds, the one 2016 baked included, where Classic takes none — so
      // each of those is a difference between the presets as well. Read off
      // the page's own receipts, like the volumes above.
      for (const p of scatter) {
        gap -= anniversary.clearedBySlopeByPass[`${environment}:${p.index}`] ?? 0
        // DEV-862: and the sea takes props off both presets' passes alike, so only
        // what Anniversary loses beyond Classic is a difference between them (every
        // never-run pass on Simonet and Kauai, where Classic builds nothing).
        gap -=
          (anniversary.clearedByWaterByPass[`${environment}:${p.index}`] ?? 0) -
          (classic.clearedByWaterByPass[`${environment}:${p.index}`] ?? 0)
      }
    }

    // ── and the reveal, which is the OTHER number and a separate claim ─────
    //
    // DEV-267. Everything above is about what each pass BUILDS; none of it can
    // see DEV-225's reveal, which is the whole reason those assertions had to
    // stop reading `InstancedMesh.count`. Dropping the drawn figure entirely
    // would have left this file green for a reveal that culled the world, so
    // it is asserted here — as a relationship, never as a literal, because the
    // count is a function of where the camera is and 5,092 is not a fact about
    // anything (the orientation lesson's general form: assert the relationship,
    // not the value).
    for (const [key, holds] of Object.entries(anniversary.byPass)) {
      const drawn = anniversary.drawnByPass[key] ?? 0
      expect(drawn, `${key}: the reveal cannot draw more than the pass holds`).toBeLessThanOrEqual(
        holds,
      )
      expect(drawn, `${key}: the reveal drew nothing at all`).toBeGreaterThan(0)
    }
    // The loop above used to carry an exemption for `menu`, because the title
    // valley keeps every prop on purpose — `app.ts` passes it `lodDistance:
    // PROP_LOD ?? Number.POSITIVE_INFINITY` and `createPassLod` returns null
    // for a non-finite distance, so nothing is culled from a screen whose eye
    // DEV-041 put deliberately above everything.
    //
    // **That exemption is gone rather than updated, and the difference matters.**
    // Since DEV-281 no `menu:` key reaches this census at all, so the assertion
    // it held — `drawnByPass[key]` toBe `byPass[key]` — had become `undefined`
    // against `undefined`: a green line proving nothing, which is worse than no
    // line (a skipped gate looks like a pass in a summary line; a vacuous one
    // does not even look skipped). The claim itself is real and did not go
    // away with the boot split, so it moved to where it is still observable:
    // `boot-one-world.test.ts` reads the infinite `lodDistance` out of
    // `buildTitleWorld`'s own body, and `prop-lod-wiring.test.ts` already owns
    // the other half — an infinite distance builds no LOD and the batch draws
    // everything.
    //
    // And the mission's own environment is NOT exempt: 2016's radius is live
    // and doing work at the release point. A bare `<=` above would hold just as
    // well with the reveal switched off, which is the shape of a test that
    // proves nothing (DEV-069 — two of your own devices, compared).
    const missionDrawn = Object.entries(anniversary.drawnByPass)
      .filter(([k]) => k.startsWith(`${missionEnvironment}:`))
      .reduce((s, [, v]) => s + v, 0)
    const missionHolds = Object.entries(anniversary.byPass)
      .filter(([k]) => k.startsWith(`${missionEnvironment}:`))
      .reduce((s, [, v]) => s + v, 0)
    expect(
      missionDrawn,
      `${missionEnvironment}: 2016's per-chunk reveal is live — it draws fewer ` +
        `than the ${missionHolds} its passes hold (DEV-225)`,
    ).toBeLessThan(missionHolds)

    // ── and nothing else is in the difference ──────────────────────────────
    //
    // `props:landmarks` (DEV-135) and a fracture piece are built on both
    // presets, so they cannot be in the gap; holding them EQUAL rather than at
    // zero says that without pretending alpine has spires. With every pass held
    // to its own count above, the headline number below is arithmetic — which
    // is exactly why it is worth asserting: if it disagrees, something under
    // `props:` is being counted that no pass and no landmark made.
    //
    // Both totals are HOLDS (DEV-267). A difference of two DRAWN totals would
    // be a claim about the camera as much as about the presets — and it would
    // have been the 9,149 this spec measured at the release point on
    // 2026-09-21, against a `gap` of 10,092 that is a sum of recorded bakes.
    // Same trap as the 2026-09-14 version above, one layer down: not a number
    // that moved, a number that changed what it was counting. (Both figures
    // were taken hours before DEV-281 landed, so both are over the two-world
    // scene; the gap is a sum over `environments` and no longer that number.
    // Neither is written down anywhere the test reads — it is derived above,
    // which is why the argument survives the arithmetic changing under it.)
    expect(
      anniversary.unattributed,
      'the props outside a scatter pass are edition-independent',
    ).toBe(classic.unattributed)
    expect(
      anniversary.total - classic.total,
      `the gap between the presets IS the passes 2016 never ran (${environments.join(' + ')})`,
    ).toBe(gap)

    // ── the volumes are ON, and they removed what the content says ────────
    //
    // **The conservation law above is GREEN when the feature is entirely
    // off**: nothing culled means `cleared` is 0, `held` is the whole blob,
    // and `held + cleared === count` balances. So the spec that went red to
    // catch DEV-287 would say nothing if `withoutVolumes` stopped being
    // called, if the resolved list stopped reaching `loadProps`, or if the
    // pass group stopped publishing its receipt — and the `?? 0` that makes
    // the census tolerant of a pre-DEV-287 pass is the same tolerance that
    // would make it silent about all three.
    //
    // This is the other side. `CORRIDOR_MISSION_CLEARS` (the launch corridor
    // and, since the DEV-364 follow-up, rookie_01's climb-out) is pinned in
    // `tests/unit/no-prop-volumes.test.ts` against a walk of the COMMITTED
    // blobs in node; the number here is what the BROWSER's load path reports
    // it removed. Neither re-derives the other, and their agreement catches
    // the case the law cannot reach alone: `app.ts` resolving the volume
    // against a different context than the unit test builds, culling a
    // different set, reporting it honestly, and balancing the equation at any
    // magnitude.
    const clearedIn = (c: PassCensus): number =>
      Object.values(c.clearedByPass).reduce((sum, v) => sum + v, 0)
    expect(
      clearedIn(anniversary),
      `${id}: the authored no-prop volumes were applied at LOAD (DEV-287) — the ` +
        'runtime removed this many placements, and the committed content says ' +
        `${CORRIDOR_MISSION_CLEARS}. Zero here means the feature is off, which the ` +
        'conservation law above cannot see.',
    ).toBe(CORRIDOR_MISSION_CLEARS)
    // Classic carries them too, like DEV-100 — asserted as a RELATIONSHIP
    // against the pass the two presets share, never as a second literal.
    const shared = Object.keys(classic.clearedByPass)
    expect(shared.length, 'classic built a pass to compare').toBeGreaterThan(0)
    for (const key of shared) {
      expect(
        classic.clearedByPass[key],
        `${key}: the volumes apply on BOTH presets, so the shared pass loses the same props`,
      ).toBe(anniversary.clearedByPass[key])
    }

    // ── and the slope limit is ON, and removed what the content says ──────
    //
    // DEV-356, and the same shape as the volumes above for the same reason:
    // the conservation law balances with the limit entirely off. The fixture
    // is pinned in `tests/unit/prop-slope.test.ts` over the committed blobs and
    // the real height map in node, counted BEFORE any volume; the page counts
    // AFTER the volumes, so the browser's figure must land in
    // `[pinned - clearedByVolumes, pinned]` — a bracket a few dozen wide round
    // a number in the thousands, which a limit read against the wrong grid,
    // map or params cannot hit by accident.
    for (const [key, pinned] of Object.entries(SLOPE_CLEARS)) {
      const steep = anniversary.clearedBySlopeByPass[key]
      const volumes = anniversary.clearedByPass[key] ?? 0
      expect(
        steep,
        `${key}: the slope limit removed ${steep} at LOAD (DEV-356); the committed content ` +
          `says ${pinned} before the ${volumes} the volumes took. Zero means the limit is off.`,
      ).toBeGreaterThanOrEqual(pinned - volumes)
      expect(steep, `${key}: and no more than the content has on steep ground`).toBeLessThanOrEqual(
        pinned,
      )
    }
    // Classic keeps 2016's forest on every slope: 2016's generator had none.
    for (const [key, steep] of Object.entries(classic.clearedBySlopeByPass)) {
      expect(steep, `${key}: Classic has no slope limit`).toBe(0)
    }

    // And the preset really did change (or the two sides are the same build twice).
    expect(
      classic.dressing,
      'classic draws no dressing — if it does, the presets did not switch',
    ).toBe(0)
    expect(anniversary.dressing, 'anniversary draws its dressing').toBeGreaterThan(100)
  })
})
