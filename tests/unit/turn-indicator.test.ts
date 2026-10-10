// tests/unit/turn-indicator.test.ts — the cyan chevrons.
//
// Three classes of assertion here, and each exists because of a specific way
// this could have gone wrong:
//
//  1. **The count and the liveness**, per mission. `adv_01` places 21 and three
//     of them are dead; every JumpSeat mission places none at all. A port that
//     drew whatever the scene file contained would put three phantom arrows on
//     `adv_01` and, worse, would not notice that the JumpSeat zero is real.
//
//  2. **The shear.** The four bars are rotated children of a NON-UNIFORMLY
//     scaled parent, which is a shear — and the tempting simplification
//     (flatten each bar into one world TRS) silently destroys it. The test
//     compares the composed matrix against a hand-built Unity-order hierarchy
//     and asserts the result is NOT decomposable, so the simplification cannot
//     be made without a failure.
//
//  3. **The materials are the gate's.** Both guids resolve to
//     `checkpoint_enabled.mat` and `glowyMaterial.mat`. That identity is what
//     lets `turn-indicators.ts` read its colours out of `props.checkpointRing`
//     instead of re-deriving them, so it is asserted rather than assumed.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import type { Level, TurnIndicator } from '@/content/level-schema'
import { bakedGeometry } from '@/game/rings'
import { turnIndicatorArtPose } from '@/game/turn-indicators'
import { PROPS } from '@/generated/constants.generated'
import { unityPose } from '@/render/unity-space'
import int01 from '../../content/levels/int_01_hoverJet.json'

const SPEC = PROPS.turnIndicator

/** Every shipped mission's turn-indicator census, from the level JSON. */
const MISSIONS = import.meta.glob<{ default: typeof int01 }>('../../content/levels/*.json', {
  eager: true,
})

/** The same files, typed as the schema says they are. */
const LEVELS = import.meta.glob<{ default: Level }>('../../content/levels/*.json', { eager: true })

describe('what the extractor found', () => {
  it('places nine on int_01, and every one of them is live', () => {
    expect(int01.turnIndicators).toHaveLength(9)
    expect(int01.turnIndicators.every((t) => t.live)).toBe(true)
  })

  it('places them in THREE TRIOS, not nine separate signs', () => {
    // The clustering is the design: a turn is marked by a run of arrows sweeping
    // round it. If a future extraction returned nine scattered markers, either
    // the scene changed or the world transform is wrong — and this is the
    // cheapest way to notice.
    const pts = int01.turnIndicators.map((t) => t.pos as number[])
    // Greedy single-link clustering at 400 m — the intra-cluster spread is
    // ~150 m and the inter-cluster gap is over 2 km, so the threshold is not
    // delicate.
    const clusters: number[][][] = []
    for (const p of pts) {
      const near = clusters.find((c) =>
        c.some(
          (q) =>
            Math.hypot(
              (q[0] as number) - (p[0] as number),
              (q[1] as number) - (p[1] as number),
              (q[2] as number) - (p[2] as number),
            ) < 400,
        ),
      )
      if (near) near.push(p)
      else clusters.push([p])
    }
    expect(clusters).toHaveLength(3)
    for (const c of clusters) expect(c).toHaveLength(3)
  })

  it('points all nine DIFFERENT ways', () => {
    // Every instance overrides rotation as well as position. An extractor that
    // took the prefab's own transform would give nine identical quaternions,
    // and the arrows would point at nothing on eight of the nine.
    const seen = new Set(
      int01.turnIndicators.map((t) => (t.quat as number[]).map((v) => v.toFixed(3)).join(',')),
    )
    expect(seen.size).toBe(9)
  })

  it('is a HoverJet feature: every JumpSeat mission carries zero', () => {
    const census = Object.entries(MISSIONS)
      .filter(([path]) => !path.includes('/_'))
      .map(([path, mod]) => [path.split('/').pop() ?? '', mod.default] as const)

    // Guard the guard: if the glob stops matching, an empty census would make
    // every assertion below vacuous.
    expect(census.length).toBeGreaterThanOrEqual(13)

    for (const [file, level] of census) {
      const n = (level.turnIndicators ?? []).length
      if (file.includes('jumpSeat')) expect(n, file).toBe(0)
      else expect(n, file).toBeGreaterThan(0)
    }
  })

  it('keeps the dead markers as data rather than dropping them', () => {
    // `adv_01_hoverJet` places 21 and three are switched off in the shipped
    // scene. The extractor records all 21 with a `live` flag; the RENDERER is
    // what filters. Keeping them means the alternate-route structure stays
    // visible instead of being silently trimmed.
    const adv01 = MISSIONS['../../content/levels/adv_01_hoverJet.json']?.default
    expect(adv01).toBeDefined()
    const all = adv01?.turnIndicators ?? []
    expect(all).toHaveLength(21)
    expect(all.filter((t) => t.live)).toHaveLength(18)
  })
})

describe('the prefab', () => {
  it("wears the checkpoint gate's OWN two materials", () => {
    // This is what lets the renderer read its colours out of
    // `props.checkpointRing`. If a future extraction ever finds a third
    // material, this fails instead of a colour quietly drifting.
    expect(SPEC.arrowMaterialIsRingFrame).toBe(true)
    expect(SPEC.barMaterialIsRingStud).toBe(true)
    expect(SPEC.arrow?.material).toBe('Assets/Faceted Flight/Materials/checkpoint_enabled.mat')
  })

  it('scales the arrow NON-UNIFORMLY', () => {
    const s = (SPEC.arrow?.scale ?? []) as readonly number[]
    expect(s[0] as number).toBeCloseTo(5.126736, 5)
    expect(s[1] as number).toBeCloseTo(4.868951, 5)
    expect(s[2] as number).toBeCloseTo(3.084374, 5)
    // The premise of the shear test below. If these were ever equal, the shear
    // would vanish and that test would pass for the wrong reason.
    expect(s[0] as number).not.toBeCloseTo(s[1] as number, 2)
    expect(s[1] as number).not.toBeCloseTo(s[2] as number, 2)
  })

  it('has four bars, all on the built-in cube', () => {
    expect(SPEC.bars).toHaveLength(4)
    for (const bar of SPEC.bars) {
      // fileID 10202 is Unity's built-in Cube. There is no asset path, and a
      // port that treated the null `mesh` as a missing file would draw nothing.
      expect(bar.builtinMesh).toBe(10202)
      expect(bar.mesh).toBeNull()
      expect(bar.active).toBe(true)
    }
    // Two long bars and two short ones — the chevron.
    const long = SPEC.bars.filter((b) => (b.scale[0] as number) > 3)
    const short = SPEC.bars.filter((b) => (b.scale[0] as number) < 1)
    expect(long).toHaveLength(2)
    expect(short).toHaveLength(2)
  })

  it('rotates every bar about z, which is what makes it a chevron', () => {
    for (const bar of SPEC.bars) {
      const q: readonly number[] = bar.rotation
      expect(Math.abs(q[2] as number)).toBeGreaterThan(0.29)
      expect(Math.abs(q[0] as number)).toBeLessThan(1e-6)
      expect(Math.abs(q[1] as number)).toBeLessThan(1e-6)
    }
    // Symmetric: two rotate one way, two the other.
    const up = SPEC.bars.filter((b) => (b.rotation[2] as number) > 0)
    expect(up).toHaveLength(2)
  })
})

describe('the shear', () => {
  // A rotated child under a non-uniformly scaled parent is a SHEAR. It is
  // reproduced for free by keeping the multiplication and destroyed by
  // flattening — and flattening is the tempting simplification, because it
  // turns two matrix multiplies per bar into one.

  const artPose = unityPose(
    SPEC.arrow?.position ?? [0, 0, 0],
    SPEC.arrow?.rotation ?? [0, 0, 0, 1],
    SPEC.arrow?.scale ?? [1, 1, 1],
  )

  it('produces a matrix that CANNOT be decomposed back to a TRS', () => {
    // The proof that the shear is real, and the reason the renderer must not
    // "simplify" by composing one TRS per bar. `decompose` always returns
    // something; the test is whether recomposing it reproduces the matrix.
    const bar = SPEC.bars.find((b) => (b.scale[0] as number) > 3)
    expect(bar).toBeDefined()
    if (!bar) return

    const composed = new THREE.Matrix4().multiplyMatrices(
      artPose,
      unityPose(bar.position, bar.rotation, bar.scale),
    )

    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    composed.decompose(p, q, s)
    const recomposed = new THREE.Matrix4().compose(p, q, s)

    const worst = Math.max(
      ...composed.elements.map((v, i) => Math.abs(v - (recomposed.elements[i] as number))),
    )
    // Not a rounding difference — the flattened form is metres out.
    expect(worst).toBeGreaterThan(0.1)
  })

  it("reproduces Unity's hierarchy exactly, flip and all", () => {
    // The independent oracle: build the chain in UNITY space first, compose it
    // there, and flip the RESULT — rather than flipping each link and composing,
    // which is what the renderer does. The two agree only if the flip really is
    // a conjugation, which is the claim `unity-space.ts` makes.
    const trs = (p: readonly number[], r: readonly number[], sc: readonly number[]) =>
      new THREE.Matrix4().compose(
        new THREE.Vector3(p[0] as number, p[1] as number, p[2] as number),
        new THREE.Quaternion(r[0] as number, r[1] as number, r[2] as number, r[3] as number),
        new THREE.Vector3(sc[0] as number, sc[1] as number, sc[2] as number),
      )

    // F = diag(1, 1, -1). Its own inverse.
    const F = new THREE.Matrix4().makeScale(1, 1, -1)

    for (const bar of SPEC.bars) {
      const unityChain = new THREE.Matrix4().multiplyMatrices(
        trs(
          SPEC.arrow?.position ?? [0, 0, 0],
          SPEC.arrow?.rotation ?? [0, 0, 0, 1],
          SPEC.arrow?.scale ?? [1, 1, 1],
        ),
        trs(bar.position, bar.rotation, bar.scale),
      )
      const oracle = new THREE.Matrix4().multiplyMatrices(F, unityChain).multiply(F)

      const ours = new THREE.Matrix4().multiplyMatrices(
        artPose,
        unityPose(bar.position, bar.rotation, bar.scale),
      )

      for (let i = 0; i < 16; i++) {
        expect(ours.elements[i] as number, `${bar.name} element ${i}`).toBeCloseTo(
          oracle.elements[i] as number,
          5,
        )
      }
    }
  })

  it('puts the bars inside the arrow they belong to', () => {
    // A sanity check on the composed scale: the arrow is 22.7 x 26.7 m, so a
    // bar has to land within that, not at prefab-local metres and not at 100x.
    for (const bar of SPEC.bars) {
      const m = new THREE.Matrix4().multiplyMatrices(
        artPose,
        unityPose(bar.position, bar.rotation, bar.scale),
      )
      const p = new THREE.Vector3().setFromMatrixPosition(m)
      expect(Math.abs(p.x), bar.name).toBeLessThan(16)
      expect(Math.abs(p.y), bar.name).toBeLessThan(16)
      expect(Math.abs(p.z), bar.name).toBeLessThan(1)
    }
  })
})

// ── DEV-198: which way does each one actually POINT? ──────────────────────
//
// Everything above tests the prefab and the census. None of it asks the only
// question a player asks, which is whether the arrow points where the course
// goes — and for four sessions the answer was "no" for 27 of the 114 live
// markers, because the SCENE overrides the arrow child's rotation and the port
// read the PREFAB's.
//
// Three rules from `docs/DEVIATIONS.md` shape what follows:
//
//  * **Test the geometry, not the rotation.** The claim is a dot product
//    between two things measured independently — the chevron's own shape, and
//    the course's own tangent. A quaternion assertion would be the belief
//    written twice.
//  * **Compare against something outside the port.** The course reference is
//    2016's authored ring order and Curvy spline, not another of our own
//    transforms.
//  * **A spot-check is a smoke test.** Every live marker in every hoverJet
//    mission, not `int_01`'s nine.
//
// And it drives the SHIPPED function — `turnIndicatorArtPose`, the one
// `loadTurnIndicators` calls — rather than re-deriving the composition here,
// because a test that re-derives its expectation the way the code does has not
// tested the code.

const V = (t: readonly number[]) =>
  new THREE.Vector3(t[0] as number, t[1] as number, t[2] as number)

/**
 * The chevron's own forward, in art-local space, derived from the FOUR BARS.
 *
 * The bars are Unity-native built-in cubes with pure Unity numbers, through no
 * importer — the same reason the mirror test below uses them as ground truth.
 * A unit cube's own ±x faces are its ends, so a long bar's two ends are ±0.5
 * along its local x through its own pose.
 *
 * The two long bars are the arms. Where their ends come closest is the point of
 * the "V"; the far pair is its open mouth; the arrow points from the mouth to
 * the point. Nothing here assumes an axis — the direction falls out of where
 * 2016 put four boxes, which is why it stays true if the mesh is re-exported.
 */
const chevronForward = (): THREE.Vector3 => {
  const arms = SPEC.bars.filter((b) => (b.scale[0] as number) > 3)
  if (arms.length !== 2) throw new Error(`expected 2 long bars, got ${arms.length}`)
  /** The two ends of one arm, `s = +1` and `s = -1` along its own x. */
  const end = (armIndex: number, s: number): THREE.Vector3 => {
    const bar = arms[armIndex]
    if (!bar) throw new Error(`no arm ${armIndex}`)
    return new THREE.Vector3(0.5 * s, 0, 0).applyMatrix4(
      unityPose(bar.position, bar.rotation, bar.scale),
    )
  }
  const mid = (p: THREE.Vector3, q: THREE.Vector3) => p.clone().add(q).multiplyScalar(0.5)
  let tip = new THREE.Vector3()
  let mouth = new THREE.Vector3()
  let closest = Infinity
  for (const s0 of [1, -1]) {
    for (const s1 of [1, -1]) {
      const d = end(0, s0).distanceTo(end(1, s1))
      if (d < closest) {
        closest = d
        tip = mid(end(0, s0), end(1, s1))
        mouth = mid(end(0, -s0), end(1, -s1))
      }
    }
  }
  if (!Number.isFinite(closest)) throw new Error('no chevron')
  return tip.sub(mouth).normalize()
}

const FORWARD = chevronForward()

/** The world direction the arrow points, through the shipped composition. */
const worldForward = (t: TurnIndicator): THREE.Vector3 => {
  const world = new THREE.Matrix4().compose(
    V(t.pos),
    new THREE.Quaternion(
      t.quat[0] as number,
      t.quat[1] as number,
      t.quat[2] as number,
      t.quat[3] as number,
    ),
    V(t.scale),
  )
  return FORWARD.clone().transformDirection(world.multiply(turnIndicatorArtPose(t)))
}

/**
 * Every line 2016 authored through this course: each route's rings in their
 * authored order, plus the Curvy polyline.
 *
 * Both, because neither alone covers everything. `adv_01` has TWO routes and
 * `readRoute` keeps only the biggest spline group, so six of its markers have
 * no polyline near them; the ring order does have one. The polyline is much
 * finer everywhere else — 400–660 points against 16–28 rings.
 */
const courseLines = (level: Level): THREE.Vector3[][] => {
  const lines = level.routes.map((r) => r.rings.map((g) => V(g.pos)))
  // `route` is in `content/levels/_schema.json` and in every generated file, but
  // not on the `Level` interface. Five call sites in `src/` already reach it
  // through this cast; a sixth is not the place to change that.
  const curvy = (level as { route?: number[][] }).route ?? null
  if (curvy && curvy.length > 1) lines.push(curvy.map((p) => V(p)))
  return lines.filter((l) => l.length > 1)
}

/** Nearest point on any of them, and the unit direction of travel there. */
const nearestTangent = (lines: THREE.Vector3[][], p: THREE.Vector3) => {
  let best = { dist: Infinity, tangent: new THREE.Vector3(0, 0, 1) }
  const ab = new THREE.Vector3()
  const q = new THREE.Vector3()
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i] as THREE.Vector3
      ab.subVectors(line[i + 1] as THREE.Vector3, a)
      const l2 = ab.lengthSq()
      if (l2 <= 0) continue
      const s = Math.min(1, Math.max(0, q.subVectors(p, a).dot(ab) / l2))
      const dist = q.copy(a).addScaledVector(ab, s).distanceTo(p)
      if (dist < best.dist) best = { dist, tangent: ab.clone().normalize() }
    }
  }
  return best
}

const HOVERJET = Object.entries(LEVELS)
  .filter(([path]) => !path.includes('/_'))
  .map(([path, mod]) => ({ file: path.split('/').pop() ?? '', level: mod.default }))
  .filter(({ level }) => (level.turnIndicators ?? []).length > 0)
  .sort((a, b) => (a.file < b.file ? -1 : 1))

/**
 * The three markers no line in their own level is a reference for.
 *
 * `adv_02`'s 12/13/14 sit at y ≈ 1780–1814 m, which is ABOVE the highest point
 * of their own course (max ring y = 1666), and 410–602 m from the nearest
 * segment of it. Every other marker in the game is within 296 m. A tangent
 * measured half a kilometre away is not evidence about anything, so they are
 * named and counted rather than quietly passed — if a fourth ever joins them,
 * the count fails. They carry no art override and the port composes them
 * exactly as it composes the 87 that come out right; what they are FOR is not
 * established. (DEV-198.)
 */
const FAR_FROM_ANY_LINE = [
  'adv_02_hoverJet.json/#4 turnIndicator (12)',
  'adv_02_hoverJet.json/#5 turnIndicator (13)',
  'adv_02_hoverJet.json/#6 turnIndicator (14)',
]

/**
 * `i` and not just the name: `int_02` places TWO markers called
 * `turnIndicator`, so a name-keyed map silently holds 113 of 114 — which is
 * how this line came to exist.
 */
const keyOf = (file: string, t: TurnIndicator) => `${file}/#${t.i} ${t.name}`

/** Metres from each live marker to the nearest segment of any authored line. */
const distanceToCourse = new Map<string, number>()
for (const { file, level } of HOVERJET) {
  const lines = courseLines(level)
  for (const t of level.turnIndicators.filter((x) => x.live)) {
    distanceToCourse.set(keyOf(file, t), nearestTangent(lines, V(t.pos)).dist)
  }
}

describe('DEV-198 — the arrow the SCENE aimed, not the one the prefab did', () => {
  it('finds the override on 27 markers, and only in Mesa Canyon', () => {
    expect(HOVERJET).toHaveLength(7)
    const withArt = HOVERJET.map(({ file, level }) => ({
      file,
      env: level.environment,
      n: level.turnIndicators.filter((t) => t.live && t.art).length,
      live: level.turnIndicators.filter((t) => t.live).length,
    }))
    expect(withArt.map((w) => `${w.file} ${w.n}/${w.live}`)).toEqual([
      'adv_01_hoverJet.json 6/18',
      'adv_02_hoverJet.json 0/18',
      'hoverJet_kauai_beg.json 0/9',
      'int_01_hoverJet.json 0/9',
      'int_02_hoverJet.json 0/27',
      'rookie_01_hoverJet.json 0/12',
      'rookie_02_hoverJet.json 21/21',
    ])
    // Both of them, and only them, are the desert. That is the whole of Matt's
    // report: "some of the turn indicator arrows in mesa canyon".
    for (const w of withArt) expect(w.n > 0, w.file).toBe(w.env === 'desert')
  })

  it("leaves the arrow node's POSITION and SCALE at the sheet's values", () => {
    // The level carries the whole art-node TRS, so the two numbers that are
    // also in the constants sheet have to agree with it — which turns the
    // duplication into a cross-check instead of a drift risk. If a future
    // extraction finds a scene that moved or resized the arrow, this fails
    // rather than the renderer quietly using a stale scale.
    const sheetPos = (SPEC.arrow?.position ?? []) as readonly number[]
    const sheetScale = (SPEC.arrow?.scale ?? []) as readonly number[]
    const sheetRot = (SPEC.arrow?.rotation ?? []) as readonly number[]
    let seen = 0
    for (const { file, level } of HOVERJET) {
      for (const t of level.turnIndicators) {
        if (!t.art) continue
        seen++
        const where = keyOf(file, t)
        expect(t.art.name, where).toBe('turnIndicator_art (2)')
        for (let i = 0; i < 3; i++) {
          expect(t.art.position[i] as number, `${where} pos[${i}]`).toBeCloseTo(
            sheetPos[i] as number,
            6,
          )
          expect(t.art.scale[i] as number, `${where} scale[${i}]`).toBeCloseTo(
            sheetScale[i] as number,
            6,
          )
        }
        // ...and the ROTATION is the one thing that is NOT the sheet's.
        const same = t.art.rotation.every((v, i) => Math.abs(v - (sheetRot[i] as number)) < 1e-6)
        expect(same, `${where} rotation is still the prefab's`).toBe(false)
      }
    }
    expect(seen).toBe(27)
  })

  it('is measured against a line that is actually near all but three of them', () => {
    // The exclusion, DERIVED rather than declared. If the three named markers
    // were not the three furthest by a wide margin, the set would be a tuned
    // constant and the next marker to drift out would join it silently.
    expect(distanceToCourse.size).toBe(114)
    const sorted = [...distanceToCourse].sort((a, b) => b[1] - a[1])
    expect(
      sorted
        .slice(0, 3)
        .map(([k]) => k)
        .sort(),
    ).toEqual([...FAR_FROM_ANY_LINE].sort())
    const gap = (sorted[2]?.[1] as number) - (sorted[3]?.[1] as number)
    // 409.6 m against 295.9 m. A gap, not a cut.
    expect(
      gap,
      `${sorted[2]?.[1].toFixed(0)} m then ${sorted[3]?.[1].toFixed(0)} m`,
    ).toBeGreaterThan(100)
  })

  it('points EVERY live marker along the course', () => {
    // The whole claim, in one number per marker. dot = 1 is "straight down the
    // track"; 0 is "across it", which is where all 27 of the overridden ones sat.
    const rows: string[] = []
    for (const { file, level } of HOVERJET) {
      const lines = courseLines(level)
      expect(lines.length, file).toBeGreaterThan(0)
      for (const t of level.turnIndicators.filter((x) => x.live)) {
        const key = keyOf(file, t)
        if (FAR_FROM_ANY_LINE.includes(key)) continue
        const { dist, tangent } = nearestTangent(lines, V(t.pos))
        const d = worldForward(t).dot(tangent)
        rows.push(`${key} dist=${dist.toFixed(0)}m dot=${d.toFixed(3)}`)
        // 0.5 is 60 degrees — far looser than the data (the worst is 0.71) and
        // far tighter than the bug (the worst was -0.46).
        expect(d, `${key} at ${dist.toFixed(0)} m from the line`).toBeGreaterThan(0.5)
      }
    }
    expect(rows).toHaveLength(114 - FAR_FROM_ANY_LINE.length)
  })

  it('would MISS on 27 of them with the prefab rotation alone — the state it shipped in', () => {
    // The other half of the claim, and the record of how big the signal is.
    // `{ art: null }` is exactly what this file did before DEV-198: the sheet's
    // arrow rotation for every placement, everywhere.
    const world = (t: TurnIndicator) =>
      new THREE.Matrix4().compose(
        V(t.pos),
        new THREE.Quaternion(
          t.quat[0] as number,
          t.quat[1] as number,
          t.quat[2] as number,
          t.quat[3] as number,
        ),
        V(t.scale),
      )
    let checked = 0
    for (const { file, level } of HOVERJET) {
      const lines = courseLines(level)
      for (const t of level.turnIndicators.filter((x) => x.live && x.art)) {
        checked++
        const { dist, tangent } = nearestTangent(lines, V(t.pos))
        expect(dist, keyOf(file, t)).toBeLessThan(250)
        const before = FORWARD.clone().transformDirection(
          world(t).multiply(turnIndicatorArtPose({ art: null })),
        )
        const after = worldForward(t)
        expect(before.dot(tangent), `${keyOf(file, t)} BEFORE`).toBeLessThan(0.3)
        expect(after.dot(tangent), `${keyOf(file, t)} AFTER`).toBeGreaterThan(0.7)
      }
    }
    expect(checked).toBe(27)
  })

  it('stands the sign BESIDE the flight path facing it, not across it', () => {
    // The second, independent property — and the one that says the fix is a
    // better GAME and not just a better number. A chevron is a flat plate; it
    // is readable only if its face is turned toward where the player will be.
    //
    // The 27 stood square across the flight path, face-on to a ship still
    // hundreds of metres away and edge-on by the time it mattered:
    // |dot(face normal, direction of travel)| was 0.71–1.00. It is now
    // 0.00–0.53, with the face turned toward the racing line (≥ 0.58) — which
    // is where the 84 untouched markers already were. Two different measures of
    // "wrong", one correction, and the corrected set lands on top of the set
    // that was never touched.
    const normalOf = (t: TurnIndicator, art: TurnIndicator['art']) => {
      const world = new THREE.Matrix4().compose(
        V(t.pos),
        new THREE.Quaternion(
          t.quat[0] as number,
          t.quat[1] as number,
          t.quat[2] as number,
          t.quat[3] as number,
        ),
        V(t.scale),
      )
      return new THREE.Vector3(0, 0, 1).transformDirection(
        world.multiply(turnIndicatorArtPose({ art })),
      )
    }
    let checked = 0
    for (const { file, level } of HOVERJET) {
      const lines = courseLines(level)
      for (const t of level.turnIndicators.filter((x) => x.live && x.art)) {
        checked++
        const p = V(t.pos)
        const { tangent } = nearestTangent(lines, p)
        const where = keyOf(file, t)
        expect(Math.abs(normalOf(t, null).dot(tangent)), `${where} BEFORE`).toBeGreaterThan(0.6)
        expect(Math.abs(normalOf(t, t.art).dot(tangent)), `${where} AFTER`).toBeLessThan(0.6)
      }
    }
    expect(checked).toBe(27)
  })

  it("turns the arrow about the sign's own UP, not about anything else", () => {
    // What the override IS, stated as geometry: the chevron still lies in its
    // own plane and still stands the same way up relative to itself — it is
    // swung round to face along the course. So the angle between the sign's
    // forward before and after is large, while the arm axis is unchanged or
    // rolled a quarter turn (nine of the 27 also roll 90 deg about x).
    for (const { file, level } of HOVERJET) {
      for (const t of level.turnIndicators.filter((x) => x.live && x.art)) {
        const before = turnIndicatorArtPose({ art: null })
        const after = turnIndicatorArtPose(t)
        const dir = (m: THREE.Matrix4, v: THREE.Vector3) => v.clone().transformDirection(m)
        const swing = dir(before, FORWARD).dot(dir(after, FORWARD))
        // 85.85 deg and 90 deg both put this within a whisker of zero.
        expect(Math.abs(swing), keyOf(file, t)).toBeLessThan(0.08)
      }
    }
  })
})

describe('the flip itself', () => {
  // These do not belong to the turn indicator, but they are here because the
  // turn indicator is what made `unityPose` shared — and writing them exposed a
  // hole. The whole 299-test suite passed with `flipPosition` NOT negating z.
  //
  // The reason is the reason this project keeps writing this note down: every
  // prefab-local pose that existed until now was at or near z = 0. The gate's
  // frame sits at z = 0.014, its stud cage is nearly symmetric in z, and all
  // four turn-indicator bars are at exactly z = 0. A mirror through the z axis
  // is invisible on all of them.
  //
  // So the flip is tested here as an IDENTITY on adversarial inputs — non-zero
  // z, rotation about all three axes, non-uniform scale — rather than on the
  // shipped data that happens not to exercise it.

  /** F = diag(1, 1, -1). Its own inverse. */
  const F = new THREE.Matrix4().makeScale(1, 1, -1)

  const trs = (p: readonly number[], r: readonly number[], sc: readonly number[]) =>
    new THREE.Matrix4().compose(
      new THREE.Vector3(p[0] as number, p[1] as number, p[2] as number),
      new THREE.Quaternion(r[0] as number, r[1] as number, r[2] as number, r[3] as number),
      new THREE.Vector3(sc[0] as number, sc[1] as number, sc[2] as number),
    )

  const conjugate = (m: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(F, m).multiply(F)

  /** Deterministic, asymmetric poses. Every one has a non-zero z. */
  const POSES = [
    { position: [3, -7, 11], rotation: [0.183, 0.365, 0.548, 0.732], scale: [2, 5, 0.5] },
    { position: [-13, 2.5, -4.25], rotation: [-0.5, 0.5, -0.5, 0.5], scale: [1, 1, 1] },
    { position: [0.1, 0.2, 0.3], rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [3, 1, 7] },
    { position: [100, 0, -250], rotation: [0, 0.382683, 0, 0.92388], scale: [1.5, 1.5, 1.5] },
  ] as const

  it('is exactly the conjugation F·M·F⁻¹, one pose at a time', () => {
    for (const pose of POSES) {
      const ours = unityPose(pose.position, pose.rotation, pose.scale)
      const oracle = conjugate(trs(pose.position, pose.rotation, pose.scale))
      for (let i = 0; i < 16; i++) {
        expect(ours.elements[i] as number, `${JSON.stringify(pose.position)} el ${i}`).toBeCloseTo(
          oracle.elements[i] as number,
          6,
        )
      }
    }
  })

  it('DISTRIBUTES over composition — which is what makes nesting legal', () => {
    // The claim `unity-space.ts` makes, and the licence `turn-indicators.ts`
    // relies on to rebuild a nested prefab one node at a time.
    for (const a of POSES) {
      for (const b of POSES) {
        const ours = new THREE.Matrix4().multiplyMatrices(
          unityPose(a.position, a.rotation, a.scale),
          unityPose(b.position, b.rotation, b.scale),
        )
        const oracle = conjugate(
          new THREE.Matrix4().multiplyMatrices(
            trs(a.position, a.rotation, a.scale),
            trs(b.position, b.rotation, b.scale),
          ),
        )
        for (let i = 0; i < 16; i++) {
          expect(ours.elements[i] as number).toBeCloseTo(oracle.elements[i] as number, 5)
        }
      }
    }
  })

  it('actually moves a point across the z plane', () => {
    // The bluntest possible statement of it, and the one the whole suite was
    // missing: a Unity point at z = +11 is a three point at z = -11.
    const m = unityPose([3, -7, 11], [0, 0, 0, 1], [1, 1, 1])
    const p = new THREE.Vector3().setFromMatrixPosition(m)
    expect(p.x).toBeCloseTo(3, 9)
    expect(p.y).toBeCloseTo(-7, 9)
    expect(p.z).toBeCloseTo(-11, 9)
  })

  it('reverses the handedness of a rotation about x and y, not about z', () => {
    // A yaw of +40° in Unity (left-handed, y up) is a yaw of -40° in three.
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.698132)
    const m = unityPose([0, 0, 0], [yaw.x, yaw.y, yaw.z, yaw.w], [1, 1, 1])
    const q = new THREE.Quaternion().setFromRotationMatrix(m)
    const angle = 2 * Math.atan2(Math.hypot(q.x, q.y, q.z), q.w)
    expect(angle).toBeCloseTo(0.698132, 6)
    // Same magnitude, opposite sense.
    expect(q.y).toBeCloseTo(-yaw.y, 9)
  })
})

// ── Guarded, because the assets are not in git ───────────────────────────
//
// `public/assets/**` is gitignored for LICENSING reasons (CLAUDE.md hard rule
// 7), so a CI runner has none of it. This block read the GLB unguarded, and
// **CI was red on every push from 2026-09-11 to 2026-09-12** — five of them —
// while every local `pnpm check` was green, because a developer has run
// `pnpm assets:pull`.
//
// That is the worst shape a broken gate can take: it fails only where nobody
// is looking. Every other asset-reading spec in this suite already used
// `describe.skipIf(!available)` with a loud counterpart — this one was the
// exception, and the exception is what broke.
const AVAILABLE = fs.existsSync('public/assets/props/turn-indicator.glb')

describe.skipIf(!AVAILABLE)('the mirror', () => {
  // ── The bug this exists to not have again ──────────────────────────────
  //
  // Unity's FBX importer converts a right-handed file into its own LEFT-handed
  // space, and FF2's world is Unity's mirrored in z. Those two conversions do
  // NOT cancel: a mesh coming through `tools/assets/convert-fbx.py` arrived
  // MIRRORED IN X relative to the mesh Unity draws.
  //
  // Three assets shipped that way and nothing noticed, because a cockpit and a
  // hexagonal gate are both left-right symmetric and a mirror of a symmetric
  // shape is the shape. CLAUDE.md predicted it: "the handedness test proves the
  // PAIRING, not the absence of a mirror — check an ASYMMETRIC asset."
  //
  // The turn indicator is that asset, and it is asymmetric in the one way that
  // can measure this. Its prefab carries four `glowyMaterial` bars whose
  // transforms are UNITY-NATIVE — built-in cubes, pure Unity numbers, through no
  // importer at all. They are ground truth, and the two short ones cap the ends
  // of the arrow's arms. Composed against them the arm ends landed 4.8 m away;
  // un-mirrored they land 0.6 m away, on a mesh 4.43 m wide.
  //
  // So this test does not assert a fingerprint of the current file. It asserts
  // that the MESH and the PREFAB agree about where the arrow's arms end — which
  // is true of the real asset, false of a mirrored one, and stays meaningful if
  // the mesh is ever re-exported.

  const GLB = 'public/assets/props/turn-indicator.glb'

  const parse = async (): Promise<THREE.Object3D> => {
    const bytes = fs.readFileSync(GLB)
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    return new Promise((resolve, reject) => {
      new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
    })
  }

  /** The mean of the `n` vertices furthest along +y and -y: the two arm ends. */
  const armEnds = (geometry: THREE.BufferGeometry) => {
    const pos = geometry.getAttribute('position')
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < pos.count; i++) {
      pts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
    }
    pts.sort((a, b) => b.y - a.y)
    const mean = (arr: THREE.Vector3[]) =>
      arr.reduce((acc, v) => acc.add(v), new THREE.Vector3()).divideScalar(arr.length)
    return { top: mean(pts.slice(0, 4)), bottom: mean(pts.slice(-4)) }
  }

  const endCaps = SPEC.bars.filter((b) => (b.scale[0] as number) < 1)

  const nearestCap = (p: THREE.Vector3) =>
    Math.min(
      ...endCaps.map((b) =>
        Math.hypot(p.x - (b.position[0] as number), p.y - (b.position[1] as number)),
      ),
    )

  it('has the arrow and its end-cap bars in the SAME place', async () => {
    const geometry = bakedGeometry(await parse())
    expect(geometry).not.toBeNull()
    if (!geometry) return
    expect(endCaps).toHaveLength(2)

    const { top, bottom } = armEnds(geometry)
    // Both arms, both caps. A metre of slack on a 4.43 m mesh: the bars are
    // highlights sitting just inside the arm ends, not exactly on them.
    expect(nearestCap(top), 'top arm end to its cap').toBeLessThan(1)
    expect(nearestCap(bottom), 'bottom arm end to its cap').toBeLessThan(1)
  })

  it('would FAIL if the mesh were mirrored in x — the state it shipped in', async () => {
    // The other half of the claim. Without this, a future export that mirrored
    // BOTH the mesh and (somehow) the reference would pass the test above while
    // being wrong; and more usefully, it records the size of the signal.
    const geometry = bakedGeometry(await parse())
    if (!geometry) return
    const mirrored = geometry.clone()
    mirrored.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1))

    const { top, bottom } = armEnds(mirrored)
    expect(nearestCap(top), 'mirrored top arm end').toBeGreaterThan(4)
    expect(nearestCap(bottom), 'mirrored bottom arm end').toBeGreaterThan(4)
  })

  it('points its tip along -x, away from the open arms', async () => {
    // The plainest statement of which way the chevron faces, so a re-export that
    // flipped it would fail on the reading rather than on a distance.
    const geometry = bakedGeometry(await parse())
    if (!geometry) return
    const pos = geometry.getAttribute('position')
    let minX = Infinity
    let maxX = -Infinity
    const spread = (near: (x: number) => boolean) => {
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < pos.count; i++) {
        if (!near(pos.getX(i))) continue
        lo = Math.min(lo, pos.getY(i))
        hi = Math.max(hi, pos.getY(i))
      }
      return hi - lo
    }
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i))
      maxX = Math.max(maxX, pos.getX(i))
    }
    // Narrow at -x (the point), wide at +x (the open arms).
    expect(spread((x) => x < minX + 1)).toBeLessThan(2)
    expect(spread((x) => x > maxX - 1)).toBeGreaterThan(4)
  })

  it('agrees with the BARS about which way it points (DEV-198)', async () => {
    // The two sources close on each other. `FORWARD` above comes from four
    // Unity-native cubes and never touches the asset; this comes from the mesh
    // and never touches the sheet. The whole 114-marker sweep rests on the
    // first one, so it is worth saying out loud that the second agrees — and a
    // re-export that flipped the arrow would fail here rather than quietly
    // inverting every dot product in the suite by the same amount.
    const geometry = bakedGeometry(await parse())
    expect(geometry).not.toBeNull()
    if (!geometry) return
    const pos = geometry.getAttribute('position')
    const verts: THREE.Vector3[] = []
    for (let i = 0; i < pos.count; i++) {
      verts.push(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)))
    }
    const mean = (vs: THREE.Vector3[]) =>
      vs.reduce((acc, v) => acc.add(v), new THREE.Vector3()).divideScalar(vs.length)
    // The plate is 1.0 units THICK, so the point of the V is a PAIR of vertices
    // at z = ±0.5. Take one of them and the direction picks up 12 degrees of z
    // that is not in the shape; average them and it cancels.
    const minX = Math.min(...verts.map((v) => v.x))
    const tip = mean(verts.filter((v) => v.x < minX + 0.25))
    const meshForward = tip.sub(mean(verts)).normalize()
    expect(meshForward.dot(FORWARD), `mesh ${meshForward.toArray().join(',')}`).toBeGreaterThan(
      0.99,
    )
  })
})

describe.skipIf(AVAILABLE)('the mirror — asset not hydrated', () => {
  it('is skipped loudly rather than passing vacuously', () => {
    // The counterpart every other asset spec in this suite already had. A
    // `skipIf` with nothing on the other side is indistinguishable, in a CI
    // log, from a block that ran and found nothing wrong.
    expect(AVAILABLE).toBe(false)
  })
})
