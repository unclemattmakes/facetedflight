// tests/unit/level-overrides.test.ts — the shipped-course override layer.
// DEV-538, plan/SHIPPED-COURSE-EDITS.md §3.3, §3.4, §3.5, §6.2, §8.
//
// Four guards, and the order is the order they matter in:
//
//  1. THE PIN. Every file in `content/overrides/` names the manifest's CURRENT
//     sha256 for its mission. A re-extraction that moves the baseline turns this
//     red and names the override to re-review — the extractor's own posture for
//     a stale deviation (`dev061ForcedMode`), made data. The sweep includes the
//     `_fixture_` files, and asserts it is not empty, so it cannot pass by
//     finding nothing to check.
//  2. THE CLOSED LIST. What an override may touch is pinned by value: widening
//     it is an edit here as well as in `level-override.ts` (CLAUDE.md,
//     "changing a shipped default"). Hard rule 3's risk is an override that
//     re-types an extracted fact; this is the list that forbids it.
//  3. WHAT APPLYING DOES, tested on the geometry rather than on the rotation
//     (the orientation lesson): a moved ring's trigger keeps its offset IN THE
//     RING'S OWN FRAME, a moved finish keeps every stud's distance, and
//     everything the list does not name is 2016's, deep-equal.
//  4. HARD RULE 6. A second mission is overridden with a tree handed to the
//     loader — no `src/` change — the way `listedLevelIds` takes injected trees.
//
// The first REAL override is Matt's (§9). Every override here is a fixture.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyOverride,
  baseProblem,
  canonicalOverrideText,
  checkOverride,
  courseKeyOf,
  type LevelOverride,
  manifestShaOf,
  OVERRIDE_ADD_FIELDS,
  OVERRIDE_FIELDS,
  OVERRIDE_SHAPE,
  overrideRoute,
  ringKey,
  turnIndicatorKey,
  validateOverride,
} from '@/content/level-override'
import {
  type FinishGateSphereUnion,
  type Level,
  LevelSchemaError,
  liveRings,
  type Ring,
} from '@/content/level-schema'
import {
  generatedLevelIds,
  type LevelTrees,
  loadBaselineLevel,
  loadLevel,
  loadLevelFrom,
  overriddenLevelIds,
} from '@/content/load-level'
import {
  PLAYER_COURSE_LIMITS,
  PLAYER_COURSE_SHAPE,
  playerCourseMedals,
} from '@/content/player-course'
import { cardFor, withVariant } from '@/game/mission-index'
import { runningMode } from '@/game/modes'
import { bestKey } from '@/game/personal-best'
import { conjugate, quat, rotateVec3 } from '@/sim/math/quat'
import { v3 } from '@/sim/math/vec3'
import { levelJson as raw } from './helpers/content'
import { createValidator, type SchemaNode } from './helpers/json-schema'
import { REPO as ROOT } from './helpers/repo-root'

const LEVELS = path.join(ROOT, 'content', 'levels')
const OVERRIDES = path.join(ROOT, 'content', 'overrides')
const MANIFEST = fs.readFileSync(path.join(ROOT, 'content', '_generated.sha256'), 'utf8')
const FIXTURE_FILE = '_fixture_int_01_hoverJet.json'
const ID = 'int_01_hoverJet'

const fixtureText = (): string => fs.readFileSync(path.join(OVERRIDES, FIXTURE_FILE), 'utf8')
const fixture = (): Record<string, unknown> => JSON.parse(fixtureText()) as Record<string, unknown>

/** Every override file on disk, fixtures included; the format's schema is not one. */
const overrideFiles = (): string[] =>
  fs
    .readdirSync(OVERRIDES)
    .filter((f) => f.endsWith('.json') && f !== '_override.schema.json')
    .sort()

/** `_fixture_<id>.json` or `<id>.json` → the mission it must name. */
const missionOfFile = (file: string): string =>
  file.replace(/^_fixture_/, '').replace(/\.json$/, '')

const ringByKey = (level: Level, key: string): Ring | undefined =>
  level.routes.flatMap((r) => r.rings).find((r) => ringKey(r) === key)

const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(
    (a[0] as number) - (b[0] as number),
    (a[1] as number) - (b[1] as number),
    (a[2] as number) - (b[2] as number),
  )

/** `p` in the frame of a body at `pos`/`q`: what a rigid motion must preserve. */
const local = (pos: readonly number[], q: readonly number[], p: readonly number[]) => {
  const inv = conjugate(quat(), quat(q[0], q[1], q[2], q[3]))
  return rotateVec3(
    v3(),
    inv,
    v3(
      (p[0] as number) - (pos[0] as number),
      (p[1] as number) - (pos[1] as number),
      (p[2] as number) - (pos[2] as number),
    ),
  )
}

/** A hand-made tree for the loader, from the real generated file and an override object. */
const trees = (
  overrides: Record<string, unknown>,
  authored: Record<string, Level> = {},
): LevelTrees => {
  const lazy =
    <T>(v: T) =>
    async () => ({ default: structuredClone(v) })
  const generated: Record<string, () => Promise<{ default: Level }>> = {}
  for (const id of generatedLevelIds()) generated[`/content/levels/${id}.json`] = lazy(raw(id))
  return {
    generated,
    authored: Object.fromEntries(
      Object.entries(authored).map(([id, l]) => [`/content/authored/${id}.json`, lazy(l)]),
    ),
    overrides: Object.fromEntries(
      Object.entries(overrides).map(([id, o]) => [`/content/overrides/${id}.json`, lazy(o)]),
    ),
  }
}

const minimal = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  mission: id,
  base: manifestShaOf(MANIFEST, id),
  ...extra,
})

const refusals = (input: unknown): string[] => {
  const r = validateOverride(input)
  return r.ok ? [] : r.errors.map(([p, m]) => `${p}: ${m}`)
}

// ── 1. The pin, over every file on disk ─────────────────────────────────────

describe('every file in content/overrides/ is current, valid and canonical', () => {
  it('has something to check: the sweep is not vacuous', () => {
    // The loud counterpart. Today the only files are fixtures (the first real
    // override is Matt's); without one, every assertion below would pass on an
    // empty list and say nothing.
    expect(overrideFiles()).toContain(FIXTURE_FILE)
  })

  it('pins each override to the manifest’s CURRENT line for its mission', () => {
    const stale: string[] = []
    for (const file of overrideFiles()) {
      const ov = JSON.parse(fs.readFileSync(path.join(OVERRIDES, file), 'utf8'))
      const problem = baseProblem(ov, MANIFEST)
      if (problem) stale.push(`${file}: ${problem}`)
    }
    expect(stale).toEqual([])
  })

  it('names a generated mission, in a file named for it', () => {
    const ids = new Set(generatedLevelIds())
    for (const file of overrideFiles()) {
      const ov = JSON.parse(fs.readFileSync(path.join(OVERRIDES, file), 'utf8'))
      expect(ids.has(missionOfFile(file)), `${file} names no generated mission`).toBe(true)
      expect(ov.mission, file).toBe(missionOfFile(file))
    }
  })

  it('validates, fits its baseline, and is already in canonical bytes (a re-save is a zero diff)', () => {
    for (const file of overrideFiles()) {
      const text = fs.readFileSync(path.join(OVERRIDES, file), 'utf8')
      const r = validateOverride(JSON.parse(text))
      expect(r.ok ? [] : r.errors, file).toEqual([])
      if (!r.ok) continue
      expect(checkOverride(raw(r.override.mission), r.override), file).toEqual([])
      expect(text, `${file} is not in canonical bytes`).toBe(canonicalOverrideText(r.override))
      expect(text.includes('\r'), `${file} has a CR`).toBe(false)
    }
  })

  it('validates against the format’s schema, with the content gates’ own validator', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(OVERRIDES, '_override.schema.json'), 'utf8'),
    ) as SchemaNode
    const validate = createValidator(schema)
    for (const file of overrideFiles()) {
      const errs: string[] = []
      validate(schema, JSON.parse(fs.readFileSync(path.join(OVERRIDES, file), 'utf8')), file, errs)
      expect(errs).toEqual([])
    }
  })

  it('applies to a level that still validates against content/levels/_schema.json', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(LEVELS, '_schema.json'), 'utf8'),
    ) as SchemaNode
    const validate = createValidator(schema)
    for (const file of overrideFiles()) {
      const ov = JSON.parse(fs.readFileSync(path.join(OVERRIDES, file), 'utf8'))
      // The two runtime stamps are not a file's (`loadLevel` refuses them on
      // disk); the rest is the course as a level file would hold it.
      const { _override, courseKey, ...asFile } = applyOverride(raw(ov.mission), ov)
      expect(_override?.base).toBe(ov.base)
      const errs: string[] = []
      validate(schema, asFile, file, errs)
      expect(errs).toEqual([])
    }
  })

  it('goes RED, naming the override, when a re-extraction moves the baseline', () => {
    const ov = fixture() as { mission: string; base: string }
    expect(baseProblem(ov, MANIFEST)).toBeNull()
    // The manifest as a re-extraction that touched int_01 would leave it.
    const moved = MANIFEST.replace(ov.base, 'f'.repeat(64))
    expect(moved).not.toBe(MANIFEST)
    const problem = baseProblem(ov, moved)
    expect(problem).toContain(`content/overrides/${ID}.json`)
    expect(problem).toContain('the baseline moved under this override')
    expect(problem).toContain('re-open it in the editor, check every entity it names, and re-save')
    // And an override for a file the manifest does not list at all.
    expect(baseProblem({ mission: 'no_such_mission', base: ov.base }, MANIFEST)).toContain(
      'lists no content/levels/no_such_mission.json',
    )
  })

  it('goes RED when a fileID the override names leaves the baseline', () => {
    const ov = validateOverride(fixture())
    if (!ov.ok) throw new Error('fixture refused')
    const moved = Object.keys(ov.override.rings?.move ?? {})[0] as string
    const base = raw(ID)
    const without: Level = {
      ...base,
      routes: base.routes.map((r) => ({
        ...r,
        rings: r.rings.filter((ring) => ringKey(ring) !== moved),
      })),
    }
    expect(checkOverride(without, ov.override).map(([p]) => p)).toContain(`rings.move.${moved}`)
  })
})

// ── 2. The closed list, by value ────────────────────────────────────────────

describe('the closed field list (§3.4)', () => {
  it('is exactly this, pinned by value', () => {
    expect(OVERRIDE_FIELDS).toEqual({
      $schema: [],
      v: [],
      mission: [],
      base: [],
      rings: ['move', 'remove', 'add'],
      turnIndicators: ['move', 'remove', 'add'],
      finish: ['pos', 'quat'],
      route: ['points'],
      timer: ['timeLimit', 'bonusParTime'],
      medals: ['bronze', 'silver', 'gold', 'platinum'],
      notes: ['at', 'what'],
    })
    expect(OVERRIDE_ADD_FIELDS).toEqual(['key', 'after', 'pos', 'quat'])
  })

  it('reaches no extracted environment fact, no recording, no spawn and no _meta', () => {
    // The "never" column of §3.4, as keys a level has and the list must not.
    const never = [
      'worldOffset',
      'fog',
      'lighting',
      'clouds',
      'boundary',
      'ui',
      'scoring',
      'ghosts',
      'ambientTraffic',
      'spawn',
      'respawn',
      '_meta',
      'orbs',
      'pads',
      'props',
      'environment',
      'vehicle',
      'mode',
    ]
    for (const key of never) {
      expect(Object.keys(OVERRIDE_FIELDS)).not.toContain(key)
      expect(refusals(minimal(ID, { [key]: {} })).join('\n'), key).toContain(
        `${key}: is not an overridable field`,
      )
    }
    // `timer.countdown` is extracted; only the limit and par are Matt's.
    expect(refusals(minimal(ID, { timer: { countdown: null } })).join('\n')).toContain(
      'timer.countdown: is not an overridable field',
    )
  })

  it('holds the format’s schema file to the same list', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(OVERRIDES, '_override.schema.json'), 'utf8'),
    ) as SchemaNode & { $defs: Record<string, SchemaNode> }
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(Object.keys(OVERRIDE_FIELDS).sort())
    expect(schema.additionalProperties).toBe(false)
    const block = (key: keyof typeof OVERRIDE_FIELDS): string[] => {
      const node = schema.properties?.[key] as SchemaNode
      const s = node.$ref ? (schema.$defs[node.$ref.replace('#/$defs/', '')] as SchemaNode) : node
      const inner = key === 'notes' ? (s.items as SchemaNode) : s
      return Object.keys(inner.properties ?? {}).sort()
    }
    for (const key of [
      'rings',
      'turnIndicators',
      'finish',
      'route',
      'timer',
      'medals',
      'notes',
    ] as const) {
      expect(block(key), key).toEqual([...OVERRIDE_FIELDS[key]].sort())
    }
  })

  it('adds ONE policy number, the quaternion quantum, and it is the extractor’s own precision', () => {
    expect(OVERRIDE_SHAPE).toEqual({
      posQuantumMetres: PLAYER_COURSE_SHAPE.pointQuantumMetres,
      quatQuantum: 1e-6,
    })
    // The outside check: every quaternion component the extractor wrote into
    // content/levels/ sits on this grid, so a 2016 rotation copied into an
    // override is not rounded by it.
    let seen = 0
    const onGrid = (x: number): boolean =>
      Math.abs(x / OVERRIDE_SHAPE.quatQuantum - Math.round(x / OVERRIDE_SHAPE.quatQuantum)) < 1e-6
    for (const id of generatedLevelIds()) {
      const l = raw(id)
      const quats = [
        ...l.routes.flatMap((r) => r.rings.flatMap((ring) => [ring.quat, ring.trigger.quat])),
        ...l.turnIndicators.map((t) => t.quat),
        ...(l.finish ? [l.finish.quat] : []),
      ]
      for (const q of quats) {
        for (const x of q) {
          seen++
          expect(onGrid(x), `${id}: ${x}`).toBe(true)
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
  })
})

// ── 3. What applying does ────────────────────────────────────────────────────

describe('applying the fixture to int_01_hoverJet', () => {
  const base = raw(ID)
  const ov = validateOverride(fixture())
  if (!ov.ok) throw new Error(`fixture refused: ${JSON.stringify(ov.errors)}`)
  const o = ov.override as LevelOverride
  const level = applyOverride(base, fixture())
  const movedKey = Object.keys(o.rings?.move ?? {})[0] as string
  const removedKey = (o.rings?.remove ?? [])[0] as string
  const added = (o.rings?.add ?? [])[0] as NonNullable<LevelOverride['rings']>['add'] extends
    | readonly (infer A)[]
    | undefined
    ? A
    : never

  it('moves a ring RIGIDLY: its trigger keeps its offset in the ring’s own frame', () => {
    const before = ringByKey(base, movedKey) as Ring
    const after = ringByKey(level, movedKey) as Ring
    expect(after.pos).toEqual(o.rings?.move?.[movedKey]?.pos)
    expect(before.pos[1] - after.pos[1]).toBeCloseTo(10, 0)
    const a = local(before.pos, before.quat, before.trigger.pos)
    const b = local(after.pos, after.quat, after.trigger.pos)
    expect(b.x).toBeCloseTo(a.x, 4)
    expect(b.y).toBeCloseTo(a.y, 4)
    expect(b.z).toBeCloseTo(a.z, 4)
    expect(after.trigger.radius).toBe(before.trigger.radius)
    expect(after.trigger.spheres).toEqual(before.trigger.spheres)
    expect(after.scoring).toEqual(before.scoring)
    // Its 2016 key stays (so the next save names it again); its raw 2016 pose,
    // no longer true, does not.
    const meta = (after as Ring & { _meta: Record<string, unknown> })._meta
    expect(meta.ringFileID).toBe(movedKey)
    expect(meta.raw).toBeUndefined()
  })

  it('removes, adds after its anchor, and renumbers', () => {
    expect(ringByKey(level, removedKey)).toBeUndefined()
    const rings = level.routes[0]?.rings as Ring[]
    const at = rings.findIndex((r) => ringKey(r) === added.key)
    expect(ringKey(rings[at - 1] as Ring)).toBe(added.after)
    expect(rings.map((r) => r.i)).toEqual(rings.map((_, i) => i))
    expect(rings.map((r) => r.order)).toEqual(rings.map((_, i) => i))
    // A copy of the mission's first live ring (DEV-466's rule), moved to its pose.
    const template = liveRings(base)[0] as Ring
    const ring = rings[at] as Ring
    expect(ring.pos).toEqual(added.pos)
    expect(ring.trigger.spheres).toEqual(template.trigger.spheres)
    expect(ring.scoring).toEqual(template.scoring)
    expect(dist(ring.pos, ring.trigger.pos)).toBeCloseTo(
      dist(template.pos, template.trigger.pos),
      6,
    )
    expect(liveRings(level)).toHaveLength(liveRings(base).length) // one out, one in
  })

  it('moves the finish rigidly: trigger, frame and every stud together', () => {
    const before = base.finish as FinishGateSphereUnion
    const after = level.finish as FinishGateSphereUnion
    expect(after.pos).toEqual(o.finish?.pos)
    expect(after.pos[1] - before.pos[1]).toBeCloseTo(5, 0)
    expect(after.radius).toBe(before.radius)
    expect(after.spheres).toEqual(before.spheres)
    const studs = before.art?.studs ?? []
    expect(studs.length).toBeGreaterThan(0)
    for (const [i, s] of studs.entries()) {
      const t = after.art?.studs[i]
      expect(dist(t?.pos ?? [], after.pos)).toBeCloseTo(dist(s.pos, before.pos), 4)
    }
    expect(dist(after.art?.frame.pos ?? [], after.pos)).toBeCloseTo(
      dist(before.art?.frame.pos ?? [], before.pos),
      4,
    )
  })

  it('moves a turn indicator and leaves its arrow’s prefab-local pose alone', () => {
    const key = Object.keys(o.turnIndicators?.move ?? {})[0] as string
    const before = base.turnIndicators.find((t) => turnIndicatorKey(t) === key)
    const after = level.turnIndicators.find((t) => turnIndicatorKey(t) === key)
    expect(after?.pos).toEqual(o.turnIndicators?.move?.[key]?.pos)
    expect(after?.art).toEqual(before?.art)
    expect(level.turnIndicators).toHaveLength(base.turnIndicators.length)
  })

  it('lays the line through the control points, every routeSpacingMetres, ending on the last', () => {
    const points = o.route?.points ?? []
    const route = level.route ?? []
    expect(route[0]).toEqual(points[0])
    expect(route[route.length - 1]).toEqual(points[points.length - 1])
    expect(route).toEqual(overrideRoute(points))
    // Consecutive samples are one spacing apart ALONG the curve, so never more
    // than that as the crow flies.
    for (let i = 1; i < route.length; i++) {
      expect(dist(route[i - 1] ?? [], route[i] ?? [])).toBeLessThanOrEqual(
        PLAYER_COURSE_SHAPE.routeSpacingMetres + 1e-9,
      )
    }
  })

  it('sets the time limit and par, and nothing else of the timer', () => {
    expect(level.timer.timeLimit).toBe(o.timer?.timeLimit)
    expect(level.timer.bonusParTime).toBe(o.timer?.bonusParTime)
    expect(level.timer.countdown).toEqual(base.timer.countdown)
    expect(level.timer.shadowedParTime).toBe(base.timer.shadowedParTime)
  })

  it('leaves every field off the closed list exactly as 2016 shipped it', () => {
    for (const key of [
      'id',
      'title',
      'vehicle',
      'environment',
      'environmentScene',
      'mode',
      'worldOffset',
      'spawn',
      'respawn',
      'orbs',
      'pads',
      'clouds',
      'props',
      'ui',
      'medals',
      'scoring',
      'boundary',
      'fog',
      'lighting',
      'ghosts',
      'ambientTraffic',
      'generated',
      '_meta',
    ] as const) {
      expect((level as unknown as Record<string, unknown>)[key], key).toEqual(
        (base as unknown as Record<string, unknown>)[key],
      )
    }
    // The ring count did not move, so the medal curve is the baseline's exactly.
    expect(level.medalsFf2).toEqual(base.medalsFf2)
  })

  it('does not touch the baseline object it was handed', () => {
    expect(base).toEqual(raw(ID))
  })

  it('names the new course for bests, in eight hex digits', () => {
    expect(level.courseKey).toMatch(/^[0-9a-f]{8}$/)
    expect(level.courseKey).toBe(courseKeyOf(level))
    expect(level.courseKey).not.toBe(courseKeyOf(base))
  })
})

describe('applying: medals, the course key, and what leaves a course alone', () => {
  const base = raw(ID)

  it('an override that changes nothing is the baseline, with no course key', () => {
    const level = applyOverride(base, minimal(ID))
    const { _override, ...rest } = level
    expect(rest).toEqual(base)
    expect(level.courseKey).toBeUndefined()
    expect(_override).toEqual({ base: manifestShaOf(MANIFEST, ID), notes: [] })
  })

  it('re-derives the medals when the ring count moves, with no number typed', () => {
    const drop = ringKey(base.routes[0]?.rings[4] as Ring) as string
    const level = applyOverride(base, minimal(ID, { rings: { remove: [drop] } }))
    const rings = liveRings(level).length
    expect(rings).toBe(liveRings(base).length - 1)
    const perRing = (liveRings(base)[0] as Ring).scoring.addScore * base.scoring.gateMultiplier
    const { _meta, ...curve } = level.medalsFf2 ?? ({} as NonNullable<Level['medalsFf2']>)
    expect(curve).toEqual(playerCourseMedals(base, rings, perRing))
    // Platinum is every ring (DEV-393), on the new count.
    expect(curve.platinum).toBe(rings * perRing)
    expect(level.courseKey).toMatch(/^[0-9a-f]{8}$/)
  })

  it('takes Matt’s own medals when the file names them — and they move no best', () => {
    const medals = { bronze: 1000, silver: 1500, gold: 2000, platinum: 2100 }
    const level = applyOverride(base, minimal(ID, { medals }))
    expect({ ...level.medalsFf2, _meta: undefined }).toEqual({ ...medals, _meta: undefined })
    // A medal is not the course: the same bests stand (§6.1, "a medals-only
    // override leaves rules, and so the board, where it was").
    expect(level.courseKey).toBeUndefined()
  })

  it('a notes-only override is not a new course either', () => {
    const level = applyOverride(
      base,
      minimal(ID, { notes: [{ at: '2026-09-30', what: 'looked, changed nothing' }] }),
    )
    expect(level.courseKey).toBeUndefined()
    expect(level._override?.notes).toHaveLength(1)
  })

  it('a changed time limit IS a new course: the time bonus is part of the score', () => {
    const level = applyOverride(base, minimal(ID, { timer: { bonusParTime: 150 } }))
    expect(level.courseKey).toMatch(/^[0-9a-f]{8}$/)
    expect(level.timer.timeLimit).toBe(base.timer.timeLimit)
  })

  it('reads two adds on one anchor in the order they are written', () => {
    const r = base.routes[0]?.rings as Ring[]
    const anchor = ringKey(r[2] as Ring) as string
    const pose = { pos: [0, 400, 0], quat: [0, 0, 0, 1] }
    const level = applyOverride(
      base,
      minimal(ID, {
        rings: {
          add: [
            { key: 'ov:1', after: anchor, ...pose },
            { key: 'ov:2', after: anchor, ...pose },
            { key: 'ov:3', after: null, ...pose },
          ],
        },
      }),
    )
    const keys = (level.routes[0]?.rings ?? []).map(ringKey)
    expect(keys[0]).toBe('ov:3')
    const i = keys.indexOf(anchor)
    expect(keys.slice(i, i + 3)).toEqual([anchor, 'ov:1', 'ov:2'])
  })

  it('adds a turn indicator as a copy of the first live one', () => {
    const level = applyOverride(
      base,
      minimal(ID, {
        turnIndicators: { add: [{ key: 'ov:1', after: null, pos: [1, 2, 3], quat: [0, 0, 0, 1] }] },
      }),
    )
    const t = level.turnIndicators[0]
    expect(turnIndicatorKey(t as NonNullable<typeof t>)).toBe('ov:1')
    expect(t?.pos).toEqual([1, 2, 3])
    expect(t?.live).toBe(true)
    expect(level.turnIndicators.map((x) => x.i)).toEqual(level.turnIndicators.map((_, i) => i))
    // A turn indicator is a hint, not the course.
    expect(level.courseKey).toBeUndefined()
  })
})

// ── Refusals ─────────────────────────────────────────────────────────────────

describe('what the validator refuses', () => {
  const pose = { pos: [0, 100, 0], quat: [0, 0, 0, 1] }

  it.each([
    ['not an object', [], 'must be a JSON object'],
    ['a v2', minimal(ID, { v: 2 }), 'v: must be 1'],
    ['a base that is not a sha256', minimal(ID, { base: 'abc' }), 'base: must be the sha256'],
    ['a bad mission id', minimal('1nope'), 'mission: must name a shipped mission id'],
    [
      'a key in rings the format does not have',
      minimal(ID, { rings: { scale: {} } }),
      'rings.scale: is not an overridable field',
    ],
    [
      'a move keyed by index',
      minimal(ID, { rings: { move: { '/routes/0/rings/7': pose } } }),
      'must be a 2016 fileID',
    ],
    [
      'a move of an added ring',
      minimal(ID, { rings: { move: { 'ov:1': pose } } }),
      'placed by its own "add" entry',
    ],
    [
      'a ring both moved and removed',
      minimal(ID, { rings: { move: { '12': pose }, remove: ['12'] } }),
      'is both moved and removed',
    ],
    ['a removal listed twice', minimal(ID, { rings: { remove: ['12', '12'] } }), 'is listed twice'],
    [
      'a zero quaternion',
      minimal(ID, { finish: { pos: [0, 0, 0], quat: [0, 0, 0, 0] } }),
      'is not a rotation',
    ],
    [
      'a position past the structural bound',
      minimal(ID, {
        finish: { pos: [PLAYER_COURSE_LIMITS.coordinateMetres + 1, 0, 0], quat: [0, 0, 0, 1] },
      }),
      'finish.pos: must be [x, y, z]',
    ],
    [
      'an add with a bad key',
      minimal(ID, { rings: { add: [{ key: 'x', after: null, ...pose }] } }),
      'must be "ov:<n>"',
    ],
    [
      'an add after a LATER add',
      minimal(ID, {
        rings: {
          add: [
            { key: 'ov:1', after: 'ov:2', ...pose },
            { key: 'ov:2', after: null, ...pose },
          ],
        },
      }),
      'the key of an EARLIER add',
    ],
    [
      'a line of one point',
      minimal(ID, { route: { points: [[0, 0, 0]] } }),
      `route.points: must be ${PLAYER_COURSE_LIMITS.points.min} to`,
    ],
    [
      'a line past the point cap',
      minimal(ID, {
        route: {
          points: Array.from({ length: PLAYER_COURSE_LIMITS.points.max + 1 }, (_, i) => [
            i * 10,
            0,
            0,
          ]),
        },
      }),
      'control points',
    ],
    [
      'two line points on top of each other',
      minimal(ID, {
        route: {
          points: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      }),
      'is within',
    ],
    [
      'a time limit out of bounds',
      minimal(ID, { timer: { timeLimit: PLAYER_COURSE_LIMITS.timeLimitSeconds.max + 1 } }),
      'timer.timeLimit: must be seconds',
    ],
    [
      'medals out of order',
      minimal(ID, { medals: { bronze: 900, silver: 800, gold: 1900, platinum: 2100 } }),
      'medals.silver: must be a whole score',
    ],
    [
      'a note with no date',
      minimal(ID, { notes: [{ at: 'yesterday', what: 'x' }] }),
      'notes[0].at: must be a date',
    ],
  ])('refuses %s', (_name, input, message) => {
    expect(refusals(input).join('\n')).toContain(message)
  })

  it('never throws, whatever it is handed', () => {
    for (const input of [
      null,
      undefined,
      1,
      'x',
      [],
      { v: 1, rings: 7 },
      { finish: { pos: 'no' } },
    ]) {
      expect(() => validateOverride(input)).not.toThrow()
    }
  })

  it('refuses, against its baseline, what the baseline cannot hold', () => {
    const base = raw(ID)
    const check = (extra: Record<string, unknown>, id = ID) => {
      const r = validateOverride(minimal(id, extra))
      if (!r.ok) throw new Error(JSON.stringify(r.errors))
      return checkOverride(raw(id), r.override)
        .map(([p, m]) => `${p}: ${m}`)
        .join('\n')
    }
    expect(
      check({ rings: { move: { '424242': { pos: [0, 0, 0], quat: [0, 0, 0, 1] } } } }),
    ).toContain('rings.move.424242: names no ring in the baseline')
    expect(
      check({
        rings: { add: [{ key: 'ov:1', after: '424242', pos: [0, 0, 0], quat: [0, 0, 0, 1] }] },
      }),
    ).toContain('names no ring in the baseline')
    const all = base.routes.flatMap((r) => r.rings).map((r) => ringKey(r) as string)
    expect(check({ rings: { remove: all } })).toContain('leaves 0 live rings')
    expect(check({ medals: { bronze: 1, silver: 2, gold: 3, platinum: 999_999 } })).toContain(
      'medals.platinum',
    )
    // A JumpSeat's finish is a convex slab and its moves are DEV-E's.
    expect(check({ finish: { pos: [0, 0, 0], quat: [0, 0, 0, 1] } }, 'int_01_jumpSeat')).toContain(
      'only a sphere-union finish gate moves in v1',
    )
    expect(
      check(
        {
          route: {
            points: [
              [0, 0, 0],
              [100, 0, 0],
            ],
          },
        },
        'int_01_jumpSeat',
      ),
    ).toContain('no racing line to replace')
    // And the file must be the mission it is applied to.
    const r = validateOverride(minimal('adv_01_hoverJet'))
    if (!r.ok) throw new Error('refused')
    expect(checkOverride(base, r.override)[0]?.[1]).toContain('but the baseline is')
  })

  it('throws LevelSchemaError from applyOverride, naming the mission and the path', () => {
    expect(() => applyOverride(raw(ID), minimal(ID, { fog: {} }))).toThrow(LevelSchemaError)
    expect(() => applyOverride(raw(ID), minimal(ID, { fog: {} }))).toThrow(
      /level "int_01_hoverJet": override refused: fog: is not an overridable field/,
    )
  })
})

// ── 4. The loader, and hard rule 6 ─────────────────────────────────────────

describe('loadLevel applies an override; loadBaselineLevel does not (§3.1)', () => {
  it('applies the file in content/overrides/<id>.json on load', async () => {
    const t = trees({ [ID]: fixture() })
    const shipped = await loadLevelFrom(t, ID)
    const baseline = await loadLevelFrom(t, ID, { baseline: true })
    expect(shipped.courseKey).toMatch(/^[0-9a-f]{8}$/)
    expect(baseline.courseKey).toBeUndefined()
    expect(baseline).toEqual(await loadLevelFrom(trees({}), ID))
    expect(shipped.timer.timeLimit).not.toBe(baseline.timer.timeLimit)
  })

  it('HARD RULE 6: overriding ANOTHER mission is one more file in the tree, and no src/ change', async () => {
    const id = 'adv_02_hoverJet'
    const base = raw(id)
    const ring = base.routes[0]?.rings[0] as Ring
    const ov = minimal(id, {
      rings: {
        move: {
          [ringKey(ring) as string]: {
            pos: [ring.pos[0], ring.pos[1] + 30, ring.pos[2]],
            quat: ring.quat,
          },
        },
      },
      notes: [{ at: '2026-09-30', what: 'the proof: a second mission, by data alone' }],
    })
    const level = await loadLevelFrom(trees({ [id]: ov }), id)
    expect(ringByKey(level, ringKey(ring) as string)?.pos[1]).toBeCloseTo(ring.pos[1] + 30, 1)
    expect(level.courseKey).toMatch(/^[0-9a-f]{8}$/)
  })

  it('refuses a broken override for that one mission, naming it', async () => {
    await expect(loadLevelFrom(trees({ [ID]: minimal(ID, { lighting: {} }) }), ID)).rejects.toThrow(
      /level "int_01_hoverJet": override refused: lighting/,
    )
    // …and the other twelve load as before.
    await expect(
      loadLevelFrom(trees({ [ID]: minimal(ID, { lighting: {} }) }), 'adv_01_hoverJet'),
    ).resolves.toBeTruthy()
  })

  it('refuses an override on an AUTHORED course: those are edited in their own file', async () => {
    const authored = { ...raw(ID), id: 'my_course', _meta: undefined } as unknown as Level
    await expect(
      loadLevelFrom(
        trees({ my_course: minimal('my_course') }, { my_course: authored }),
        'my_course',
      ),
    ).rejects.toThrow(/edits a SHIPPED mission/)
  })

  it('refuses the override’s own stamps on a file on disk', async () => {
    const typed = { ...raw(ID), courseKey: 'deadbeef' }
    const t = trees({})
    const withTyped: LevelTrees = {
      ...t,
      generated: {
        ...t.generated,
        [`/content/levels/${ID}.json`]: async () => ({ default: typed }),
      },
    }
    await expect(loadLevelFrom(withTyped, ID)).rejects.toThrow(/set by an override on load/)
  })

  it('the hangar’s card reads the edited course’s own best, and keeps it across a variant', () => {
    const level = applyOverride(raw(ID), fixture())
    const course = level.courseKey as string
    const mode = runningMode(level)
    const store = new Map<string, string>([
      [bestKey(ID, mode), JSON.stringify({ score: 2400, timeSeconds: 70, gates: 21, setAt: 1 })],
      [
        bestKey(ID, mode, 'standard', course),
        JSON.stringify({ score: 1500, timeSeconds: 99, gates: 15, setAt: 2 }),
      ],
    ])
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} }
    const card = cardFor(level, storage)
    expect(card.course).toBe(course)
    expect(card.best?.score).toBe(1500)
    const [again] = withVariant([card], level.vehicle, 'standard', storage)
    expect(again?.best?.score).toBe(1500)
    // 2016's course, with no override, reads its own record as it always did.
    const plain = cardFor(raw(ID), storage)
    expect(plain.course).toBeUndefined()
    expect(plain.best?.score).toBe(2400)
  })

  it('leaves fixtures out of the real tree, and every real override names a generated mission', async () => {
    const ids = overriddenLevelIds()
    expect(ids.some((id) => id.startsWith('_'))).toBe(false)
    for (const id of ids) expect(generatedLevelIds()).toContain(id)
    // Whatever is on disk, the baseline loader is 2016's bytes.
    const base = await loadBaselineLevel(ID)
    expect(base.courseKey).toBeUndefined()
    expect(base._override).toBeUndefined()
    // And with no real override for it, the game flies exactly that.
    if (!ids.includes(ID)) expect(await loadLevel(ID)).toEqual(base)
  })
})
