// tests/unit/player-course-props.test.ts — hand-placed props in a player
// course. DEV-504 (docs/plan/EDITOR-PROPS.md, "DEV-504").
//
//   1. The block is optional and costs nothing absent: no props, and an EMPTY
//      list, give the bytes and the id a course had before it existed.
//   2. It is validated: the library's kinds only, the scale inside its range,
//      the cap, no twin, v2 only, inside the play area; and the canonical form
//      is sorted, so the order props were placed in is not part of the id.
//   3. It survives every door a course goes through: the link, the file, the
//      library, and a draft (`readDraftCourse` dropped an optional block twice
//      before; DEV-500's water was the second).
//   4. It expands into `level.props`, which `content/levels/_schema.json` holds
//      a level to, and the FRAME is right: the renderer's own
//      `landmarkMatrixOf`, under the terrain group `terrainOriginSim` places
//      (a guard of its own against `load-terrain.ts`), puts every prop where
//      the author put it, on all four islands (kauai's LevelArt root is not at
//      the offset, DEV-042) and on a course's own island (centred, DEV-489).
//   5. It draws as the ISLAND draws the same mesh: `landmarkMatrixOf` of a
//      placed prop equals the scatter's own `instanceMatrixOf` at the same
//      pivot, yaw and scale, under the palette's own wrapper transform — the
//      orientation lesson's "test the geometry, not the rotation", against a
//      function this row did not write.
//   6. The commands: every edit pure, a no-op the same object, one prop at a
//      time, and deleting the last gives the id back.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import {
  canonicalPlayerCourse,
  expandPlayerCourse,
  PLAYER_COURSE_LIMITS,
  type PlayerCourse,
  type PlayerCourseProp,
  playerCourseId,
  propFrameOf,
  validatePlayerCourse,
} from '@/content/player-course'
import {
  courseFile,
  courseToken,
  readCourseFile,
  readCourseToken,
} from '@/content/player-course-wire'
import {
  PROP_LIBRARY,
  type PropLibraryEntry,
  placedLandmark,
  propEntry,
} from '@/content/prop-library'
import {
  addProp,
  deleteProp,
  draftFromCourse,
  loadDraft,
  moveProp,
  readDraftCourse,
  saveDraft,
  scaleProp,
  turnProp,
} from '@/editor/core'
import { createCourseLibrary, type LibraryBackend } from '@/game/course-library'
import { terrainOriginSim } from '@/game/mission-shape'
import {
  COINCIDENT_PROP_METRES,
  childMatrixOf,
  instanceMatrixOf,
  LANDMARK_FALLBACK_COLOUR,
  landmarkFallbackColour,
  landmarkMatrixOf,
  SCATTER_FALLBACK_COLOUR,
} from '@/game/props/load-props'
import { customTerrainLocal } from '@/game/terrain/custom-ground'
import { environmentTerrains, terrainLocalPosition } from '@/game/terrain/load-terrain'
import { fittedCourse, shippedLevels } from './helpers/editor-course'
import { createValidator, type SchemaNode } from './helpers/json-schema'
import { REPO } from './helpers/repo-root'

type V = [number, number, number]

const levels = shippedLevels()
const byId = (id: string): Level => levels.find((l) => l.id === id) as Level
const int01 = byId('int_01_hoverJet')
const base = fittedCourse(int01)
const levelSchema = JSON.parse(
  fs.readFileSync(path.join(REPO, 'content', 'levels', '_schema.json'), 'utf8'),
) as SchemaNode
const validateAgainstSchema = createValidator(levelSchema)

/** On the 10 cm grid a course stores a point on. */
const g10 = (x: number): number => Math.round(x * 10) / 10

/** A pivot beside the course's own line (so inside the area), on the point grid. */
const near = (c: PlayerCourse, k: number): V => {
  const p = c.path.points[1 + (k % (c.path.points.length - 2))] as V
  return [g10(p[0] + 40 + 3 * k), g10(p[1] - 30), g10(p[2] + 25 - 2 * k)]
}

const GARDEN: PlayerCourseProp[] = [
  { kind: 'cactus-tall-01', pos: near(base, 0), yaw: 30, scale: 3 },
  { kind: 'cactus-short-02', pos: near(base, 1), yaw: -120, scale: 4.5 },
  { kind: 'spire-b', pos: near(base, 2), yaw: 75, scale: 0.5 },
]
const withGarden = (c: PlayerCourse = base): PlayerCourse => ({ ...c, props: GARDEN })

// ── 1. Absent costs nothing ───────────────────────────────────────────────

describe('DEV-504 — an absent or empty props block keeps the bytes and the id', () => {
  it('no props, and props: [], are the course without the block', () => {
    const plain = canonicalPlayerCourse(base)
    expect(plain).not.toContain('props')
    expect(canonicalPlayerCourse({ ...base, props: [] })).toBe(plain)
    expect(playerCourseId({ ...base, props: [] })).toBe(playerCourseId(base))
    // And the validator hands an empty list back as the absent block.
    const checked = validatePlayerCourse({ ...base, props: [] }, int01)
    expect(checked.ok && checked.course.props).toBe(undefined)
  })

  it('a course with props has a new id, and the block is written last', () => {
    const c = withGarden()
    expect(playerCourseId(c)).not.toBe(playerCourseId(base))
    const canonical = canonicalPlayerCourse(c)
    expect(canonical.indexOf('"props"')).toBeGreaterThan(canonical.indexOf('"name"'))
  })
})

// ── 2. Validation ─────────────────────────────────────────────────────────

describe('DEV-504 — the props block is validated', () => {
  it('a garden validates, quantised, in the order it was placed', () => {
    const noisy = withGarden()
    const nudged: PlayerCourse = {
      ...noisy,
      props: (noisy.props ?? []).map((p) => ({
        ...p,
        pos: [p.pos[0] + 0.012, p.pos[1] - 0.031, p.pos[2] + 0.044] as V,
        yaw: p.yaw + 0.3,
        scale: p.scale + 0.001,
      })),
    }
    const checked = validatePlayerCourse(nudged, int01)
    expect(checked.ok).toBe(true)
    if (!checked.ok) return
    expect(checked.course.props?.map((p) => p.kind)).toEqual(GARDEN.map((p) => p.kind))
    // The same course as the unnudged one: quantising is the canonical form.
    expect(playerCourseId(checked.course)).toBe(playerCourseId(withGarden()))
  })

  it('the canonical bytes are SORTED, so the order of placing is not the id', () => {
    const reversed: PlayerCourse = { ...base, props: [...GARDEN].reverse() }
    expect(canonicalPlayerCourse(reversed)).toBe(canonicalPlayerCourse(withGarden()))
    expect(playerCourseId(reversed)).toBe(playerCourseId(withGarden()))
  })

  const refused = (c: unknown, pathRe: RegExp): void => {
    const r = validatePlayerCourse(c, int01)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(
      r.errors.map((e) => e[0]).some((p) => pathRe.test(p)),
      JSON.stringify(r.errors),
    ).toBe(true)
  }

  it('refuses a kind the library does not have, and says which', () => {
    refused({ ...base, props: [{ ...GARDEN[0], kind: 'giraffe' }] }, /^props\[0\]\.kind$/)
  })

  it('refuses a scale outside a quarter to four times its kind’s default', () => {
    const d = propEntry('cactus-tall-01')?.scale.default as number
    const R = PLAYER_COURSE_LIMITS.propScaleRatio
    refused({ ...base, props: [{ ...GARDEN[0], scale: d * R.max * 1.1 }] }, /^props\[0\]\.scale$/)
    refused({ ...base, props: [{ ...GARDEN[0], scale: d * R.min * 0.9 }] }, /^props\[0\]\.scale$/)
    expect(
      validatePlayerCourse({ ...base, props: [{ ...GARDEN[0], scale: d * R.max }] }, int01).ok,
    ).toBe(true)
  })

  it('refuses an unknown key, a bad yaw and a bad position', () => {
    refused({ ...base, props: [{ ...GARDEN[0], tint: 1 }] }, /^props\[0\]\./)
    refused({ ...base, props: [{ ...GARDEN[0], yaw: 181 }] }, /^props\[0\]\.yaw$/)
    refused({ ...base, props: [{ ...GARDEN[0], pos: [0, 0] }] }, /^props\[0\]\.pos$/)
    refused({ ...base, props: 'palms' }, /^props$/)
  })

  it('refuses a prop outside the play area', () => {
    refused({ ...base, props: [{ ...GARDEN[0], pos: [99_000 / 4, 0, 0] }] }, /^props\[0\]$/)
  })

  it('refuses two of one kind nearer than the renderer would draw both', () => {
    expect(PLAYER_COURSE_LIMITS.propSpacingMetres).toBeGreaterThanOrEqual(COINCIDENT_PROP_METRES)
    const a = GARDEN[0] as PlayerCourseProp
    const twin = { ...a, pos: [a.pos[0] + 0.5, a.pos[1], a.pos[2]] as V, yaw: 90 }
    refused({ ...base, props: [a, twin] }, /^props\[1\]$/)
    // Another kind on the same spot is two props, and stands.
    expect(
      validatePlayerCourse({ ...base, props: [a, { ...twin, kind: 'cactus-tall-02' }] }, int01).ok,
    ).toBe(true)
  })

  it('refuses more than the cap, and a props block on a v1 course', () => {
    const many = Array.from({ length: PLAYER_COURSE_LIMITS.props.max + 1 }, (_, i) => ({
      ...GARDEN[0],
      pos: [near(base, 0)[0] + i * 2, near(base, 0)[1], near(base, 0)[2]] as V,
    }))
    refused({ ...base, props: many }, /^props$/)
    const atCap = many.slice(0, PLAYER_COURSE_LIMITS.props.max)
    expect(validatePlayerCourse({ ...base, props: atCap }, int01).ok).toBe(true)
    const { start: _s, ...rest } = base
    refused({ ...rest, v: 1, start: { t: 0 }, props: GARDEN }, /^props$/)
  })
})

// ── 3. Every door ─────────────────────────────────────────────────────────

describe('DEV-504 — the props survive the link, the file, the library and a draft', () => {
  const c = withGarden()
  const id = playerCourseId(c)

  it('link', async () => {
    const r = await readCourseToken(await courseToken(c))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.course.props).toHaveLength(GARDEN.length)
    expect(playerCourseId(r.course)).toBe(id)
  })

  it('.ffcourse file', async () => {
    const r = await readCourseFile(await courseFile(c))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.course.props).toHaveLength(GARDEN.length)
    expect(playerCourseId(r.course)).toBe(id)
  })

  it('the library (rows structured-cloned, as IndexedDB keeps them)', async () => {
    const rows = new Map<string, unknown>()
    const backend: LibraryBackend = {
      durable: true,
      all: async () => [...rows.values()].map((r) => structuredClone(r)),
      one: async (k) => structuredClone(rows.get(k)),
      save: async (row) => {
        rows.set(row.id, JSON.parse(JSON.stringify(row)))
        return true
      },
      remove: async (k) => rows.delete(k),
      saveMap: async () => false,
      oneMap: async () => undefined,
    }
    const lib = createCourseLibrary(backend, () => 1)
    const put = await lib.put(c, 'made-here')
    expect(put?.id).toBe(id)
    const back = await lib.get(id)
    expect(back?.course.props).toHaveLength(GARDEN.length)
    expect(back && playerCourseId(back.course)).toBe(id)
  })

  it('a draft, saved and read back (and `readDraftCourse` alone)', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    expect(saveDraft(storage, 'abc', draftFromCourse(c), 1)).toBe(true)
    const back = loadDraft(storage, 'abc')
    expect(back?.course.props).toEqual(c.props)
    expect(back && playerCourseId(back.course)).toBe(id)
    const read = readDraftCourse(JSON.parse(JSON.stringify(c)))
    expect(read?.props).toEqual(c.props)
    // A draft keeps a prop the validator refuses (for the warnings to say so),
    // and refuses only what could not be a prop at all.
    const outside = { ...c, props: [{ ...GARDEN[0], pos: [30_000, 0, 0] }] }
    expect(readDraftCourse(JSON.parse(JSON.stringify(outside)))?.props).toHaveLength(1)
    expect(readDraftCourse({ ...c, props: [{ ...GARDEN[0], kind: 'giraffe' }] })).toBeNull()
  })
})

// ── 4. The expansion and its frame ────────────────────────────────────────

/** The terrain group a level's land hangs under, as `load-terrain.ts` places it (THREE). */
const landGroup = (level: Level, own: { size: number } | null): THREE.Matrix4 => {
  const key = environmentTerrains(level.environment).land
  const o = terrainOriginSim(key, level.worldOffset)
  let pos = o.position
  if (own) {
    // DEV-489: a course's own island, centred on the donor's land.
    const local = terrainLocalPosition(key)
    const donorLocal = [
      pos[0] - level.worldOffset[0],
      pos[1] - level.worldOffset[1],
      pos[2] + level.worldOffset[2],
    ]
    const c = customTerrainLocal({ island: level.environment, size: own.size } as never, donorLocal)
    pos = [c[0] + level.worldOffset[0], c[1] + level.worldOffset[1], c[2] - level.worldOffset[2]]
    expect(local).toBeDefined()
  }
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pos[0], pos[1], -pos[2]),
    new THREE.Quaternion(),
    new THREE.Vector3(o.scale[0], o.scale[1], o.scale[2]),
  )
}

/** Where the renderer draws each of `level.props` in the world: its matrix, composed. */
const drawn = (level: Level, own: { size: number } | null = null): THREE.Matrix4[] => {
  const group = landGroup(level, own)
  const tl = terrainLocalPosition(environmentTerrains(level.environment).land)
  return level.props.map((p) =>
    group.clone().multiply(landmarkMatrixOf(p as never, tl, new THREE.Matrix4())),
  )
}

const translation = (m: THREE.Matrix4): V => {
  const v = new THREE.Vector3().setFromMatrixPosition(m)
  return [v.x, v.y, v.z]
}

describe('DEV-504 — placed props expand into level.props, in the landmark frame', () => {
  it('the level holds them, live and solid, and validates against the level schema', () => {
    const level = expandPlayerCourse(withGarden(), int01)
    expect(level.props).toHaveLength(GARDEN.length)
    for (const [i, p] of level.props.entries()) {
      const e = propEntry(GARDEN[i]?.kind as string)
      expect(p.meshAsset).toBe(e?.asset)
      expect(p.live).toBe(true)
      expect(p.solid).toBe(true)
    }
    const errs: string[] = []
    validateAgainstSchema(levelSchema, JSON.parse(JSON.stringify(level)), level.id, errs)
    expect(errs, errs.join('\n')).toEqual([])
    // No props, none: a course without the block expands as it always did.
    expect(expandPlayerCourse(base, int01).props).toEqual([])
  })

  it('every HoverJet sky, all four islands: the drawn pivot is where the author put it', () => {
    const skies = levels.filter((l) => l.vehicle === 'hoverjet')
    expect(new Set(skies.map((l) => l.environment))).toEqual(
      new Set(['simonet', 'kauai', 'desert', 'alpine']),
    )
    for (const sky of skies) {
      // A pivot inside the sky's area: beside its own 2016 line.
      const line = fittedCourse(sky)
      const at = near(line, 0)
      const c: PlayerCourse = {
        ...line,
        props: [{ kind: 'cactus-short-02', pos: at, yaw: 0, scale: 5 }],
      }
      const props = expandPlayerCourse(c, sky).props
      const m = drawn({ ...sky, props })[0] as THREE.Matrix4
      const got = translation(m)
      for (let k = 0; k < 3; k++)
        expect(got[k], `${sky.id} axis ${k}`).toBeCloseTo(at[k] as number, 3)
    }
  })

  it('a course’s own island: the frame follows the centred ground', () => {
    const own = { size: 2048 } // simonet's land is 4,096 m: centred, 1,024 m in
    const ground = {
      v: 2 as const,
      seed: 7,
      shape: { size: own.size, height: 300, rugged: 0.5, sea: 0.3 },
    }
    const c: PlayerCourse = { ...withGarden(), ground }
    // The frame moved (the island is smaller than simonet's 8 km, and centred)…
    expect(propFrameOf(c, int01).x0).not.toBe(propFrameOf(base, int01).x0)
    // …and the renderer, under the centred group, still draws the pivot there.
    const one: PlayerCourseProp = {
      kind: 'cactus-short-02',
      pos: GARDEN[1]?.pos as V,
      yaw: 0,
      scale: 5,
    }
    const landmark = placedLandmark(
      one,
      propEntry(one.kind) as PropLibraryEntry,
      propFrameOf(c, int01),
      0,
    )
    const got = translation(
      drawn({ ...int01, props: [landmark as never] }, own)[0] as THREE.Matrix4,
    )
    for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(one.pos[k] as number, 3)
  })
})

// ── 5. As the island draws the same mesh ──────────────────────────────────

describe('DEV-504 — a placed prop is drawn as the island draws that mesh', () => {
  it('every scatter kind: landmarkMatrixOf = the scatter’s instanceMatrixOf, wrapper and all', () => {
    const env = JSON.parse(
      fs.readFileSync(path.join(REPO, 'content', 'environments', 'alpine.json'), 'utf8'),
    )
    expect(env.id).toBe('alpine')
    const sky = byId('int_01_hoverJet')
    const key = environmentTerrains(sky.environment).land
    const tl = terrainLocalPosition(key)
    const o = terrainOriginSim(key, sky.worldOffset)
    const g: V = [o.position[0], o.position[1], -o.position[2]]
    const at: V = [
      g10(sky.spawn.pos[0] + 12.3),
      g10(sky.spawn.pos[1] - 4.5),
      g10(sky.spawn.pos[2] - 6.7),
    ]
    let checked = 0
    for (const e of PROP_LIBRARY.entries) {
      if (e.from !== 'scatter') continue
      for (const yaw of [0, 37, -140]) {
        const s = e.scale.default
        const course: PlayerCourse = { ...base, props: [{ kind: e.id, pos: at, yaw, scale: s }] }
        const p = expandPlayerCourse(course, sky).props[0]
        const mine = landmarkMatrixOf(p as never, tl, new THREE.Matrix4())
        // The scatter's own: Unity mesh-frame pivot, Unity yaw (THREE's, negated), s, wrapper.
        const theirs = instanceMatrixOf(
          at[0] - g[0],
          at[1] - g[1],
          -(at[2] - g[2]),
          (-yaw * Math.PI) / 180,
          s,
          childMatrixOf(
            {
              position: [...e.rest.position],
              rotation: [...e.rest.rotation],
              scale: [...e.rest.scale],
            },
            new THREE.Matrix4(),
          ),
          null,
          new THREE.Matrix4(),
        )
        const a = mine.elements
        const b = theirs.elements
        for (let k = 0; k < 16; k++) {
          expect(a[k], `${e.id} yaw ${yaw} element ${k}`).toBeCloseTo(b[k] as number, 3)
        }
        checked++
      }
    }
    expect(checked).toBe(PROP_LIBRARY.entries.filter((e) => e.from === 'scatter').length * 3)
  })

  it('a hand-placed kind at yaw 0 and scale 1 is its island instance, moved', () => {
    const e = propEntry('spire-b')
    const sky = byId('int_01_hoverJet')
    const at: V = [sky.spawn.pos[0], sky.spawn.pos[1], sky.spawn.pos[2]]
    const p = expandPlayerCourse(
      { ...base, props: [{ kind: 'spire-b', pos: at, yaw: 0, scale: 1 }] },
      sky,
    ).props[0]
    expect(p?.rotation).toEqual([...(e?.rest.rotation ?? [])])
    expect(p?.scale).toEqual([...(e?.rest.scale ?? [])])
    // And a turn is about the world's UP, whatever the rest pose leans: the
    // drawn +y of the mesh keeps its angle to up.
    const tl = terrainLocalPosition(environmentTerrains(sky.environment).land)
    const up = (m: THREE.Matrix4): number => {
      const q = new THREE.Quaternion()
      m.decompose(new THREE.Vector3(), q, new THREE.Vector3())
      return new THREE.Vector3(0, 0, -1).applyQuaternion(q).y
    }
    const turned = expandPlayerCourse(
      { ...base, props: [{ kind: 'spire-b', pos: at, yaw: 120, scale: 1 }] },
      sky,
    ).props[0]
    // (To 1e-6: the rest pose is the environment file's six-decimal quaternion,
    // a hair off unit length, exactly as the island's own spire is drawn.)
    expect(up(landmarkMatrixOf(turned as never, tl, new THREE.Matrix4()))).toBeCloseTo(
      up(landmarkMatrixOf(p as never, tl, new THREE.Matrix4())),
      6,
    )
  })
})

describe('DEV-504 — a placed plant is the island’s green, not rock brown', () => {
  it('a placed prop of a scattered mesh takes the scatter’s fallback colour; nothing else moves', () => {
    const sky = byId('int_01_hoverJet')
    for (const e of PROP_LIBRARY.entries) {
      const at = near(base, 0)
      const p = expandPlayerCourse(
        { ...base, props: [{ kind: e.id, pos: at, yaw: 0, scale: e.scale.default }] },
        sky,
      ).props[0]
      expect(landmarkFallbackColour(p as never), e.id).toBe(
        e.from === 'scatter' ? SCATTER_FALLBACK_COLOUR : LANDMARK_FALLBACK_COLOUR,
      )
    }
    // A mission's own props (int_01_jumpSeat's GL palms) are drawn as they were.
    for (const l of levels) {
      for (const m of l.props)
        expect(landmarkFallbackColour(m), m.name).toBe(LANDMARK_FALLBACK_COLOUR)
    }
  })
})

// ── 6. The commands ───────────────────────────────────────────────────────

describe('DEV-504 — the prop commands', () => {
  const d0 = draftFromCourse(base)

  it('add, move, turn, scale, delete: each an edit, and a no-op the same object', () => {
    const d1 = addProp(d0, 'cactus-tall-01', near(base, 0))
    expect(d1.course.props).toHaveLength(1)
    expect(d1.course.props?.[0]?.scale).toBe(propEntry('cactus-tall-01')?.scale.default)
    expect(addProp(d0, 'giraffe', near(base, 0))).toBe(d0)
    const d2 = moveProp(d1, 0, near(base, 3))
    expect(d2.course.props?.[0]?.pos).toEqual(near(base, 3).map((x) => Math.round(x * 10) / 10))
    expect(moveProp(d2, 0, near(base, 3))).toBe(d2)
    const d3 = turnProp(d2, 0, 200)
    expect(d3.course.props?.[0]?.yaw).toBe(-160)
    expect(turnProp(d3, 0, -160.2)).toBe(d3)
    const d4 = scaleProp(d3, 0, 1e6)
    const e = propEntry('cactus-tall-01')
    expect(d4.course.props?.[0]?.scale).toBeCloseTo(
      (e?.scale.default as number) * PLAYER_COURSE_LIMITS.propScaleRatio.max,
      9,
    )
    expect(moveProp(d4, 5, near(base, 1))).toBe(d4)
    const d5 = deleteProp(d4, 0)
    expect(d5.course.props).toBeUndefined()
    // The id the course had before its first prop.
    expect(playerCourseId(d5.course)).toBe(playerCourseId(base))
    // The input was never touched.
    expect(d0.course.props).toBeUndefined()
    expect(d1.course.props?.[0]?.yaw).toBe(0)
  })

  it('the cap: past it, add changes nothing', () => {
    let d = d0
    for (let i = 0; i < PLAYER_COURSE_LIMITS.props.max; i++) {
      d = addProp(d, 'cactus-short-02', [
        near(base, 0)[0] + 2 * i,
        near(base, 0)[1],
        near(base, 0)[2],
      ])
    }
    expect(d.course.props).toHaveLength(PLAYER_COURSE_LIMITS.props.max)
    expect(addProp(d, 'cactus-short-02', near(base, 5))).toBe(d)
  })
})
