// tests/unit/player-course-wire.test.ts — DEV-467, E1: a player course as a
// link and as a `.ffcourse` file (`src/content/player-course-wire.ts`).
//
// What is held here:
//   1. the wire's numbers, pinned by value (the HUD_RASTER_SHIPPED pattern);
//   2. the LINK LENGTHS, measured on courses drawn along 2016's own int_01
//      route at 10, 25 and 60 control points — EDITOR.md §5.1 rests on the
//      25-point figure being under ~2,000 characters — and the format's
//      most-of-everything course against the caps;
//   3. round trips: link and file give back the course, the SAME id, and the
//      same canonical bytes as each other;
//   4. refusals: every hostile input a refusal with a reason, never a throw —
//      garbage, a newer version, a deflate bomb, a cut-short file, a map
//      section, a size past the cap;
//   5. the module stays importable from a Playwright spec.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Level } from '@/content/level-schema'
import { validateLevel } from '@/content/level-schema'
import {
  canonicalPlayerCourse,
  PLAYER_COURSE_LIMITS,
  type PlayerCourse,
  playerCourseArea,
  playerCourseId,
  validatePlayerCourse,
} from '@/content/player-course'
import {
  courseFile,
  courseFileCap,
  courseFileName,
  courseFragment,
  courseLink,
  courseLinkable,
  coursePayload,
  courseToken,
  courseTokenIn,
  fileTooLarge,
  linkRefusal,
  noLinkForProps,
  PLAYER_COURSE_WIRE,
  readCourseFile,
  readCourseToken,
} from '@/content/player-course-wire'
import { PROP_LIBRARY, type PropLibraryEntry } from '@/content/prop-library'
import { toBase64url } from '@/net/base64url'
import { REPO, rel, walkImports } from '../../tools/test/import-graph.mjs'

type V = [number, number, number]

const int01 = validateLevel(
  JSON.parse(
    fs.readFileSync(path.join(REPO, 'content', 'levels', 'int_01_hoverJet.json'), 'utf8'),
  ) as Level,
)

const inside = (donor: Level, p: readonly number[]): boolean => {
  const area = playerCourseArea(donor)
  if (area?.kind !== 'sphere') return false
  const d = Math.hypot(
    (p[0] as number) - area.centre[0],
    (p[1] as number) - area.centre[1],
    (p[2] as number) - area.centre[2],
  )
  return d <= area.radius
}

/**
 * A course of exactly `n` control points along int_01's own route: evenly
 * spaced by index over the part inside its boundary. Real coordinates, so the
 * deflate sees what a course made on that island would give it.
 */
const courseOf = (n: number): PlayerCourse => {
  const route = (int01.route as V[]).filter((p) => inside(int01, p))
  const points: V[] = []
  for (let i = 0; i < n; i++) {
    points.push(route[Math.round((i * (route.length - 1)) / (n - 1))] as V)
  }
  return {
    v: 2,
    island: int01.environment,
    sky: int01.id,
    vehicle: 'hoverjet',
    mode: 'ringAttack',
    path: { points, gap: 400 },
    rings: [],
    start: { pos: points[0] as V, yaw: 0 },
    finish: { t: 1 },
    timeLimit: 180,
    name: ['Amber', 'Heron'],
  }
}

/** The format at its most: 64 points, 100 ring overrides, every number long. */
const MOST: PlayerCourse = {
  ...courseOf(64),
  path: {
    points: courseOf(64).path.points.map(
      (p, i) => [p[0] - 0.123 - i * 0.01, p[1] + 0.456, p[2] - 0.789] as V,
    ),
    gap: 999,
  },
  rings: Array.from({ length: 100 }, (_, i) => ({ t: 0.0001 + i * 0.0099, skip: true as const })),
  // DEV-475: a pad with every number long.
  start: { pos: [-1234.567, 123.456, 2345.678], yaw: -123.456 },
  finish: { t: 0.9876 },
  timeLimit: 899,
}

// ── 1. The numbers, pinned ────────────────────────────────────────────────

describe('DEV-467 — the wire numbers, pinned by value', () => {
  it('holds these', () => {
    expect(PLAYER_COURSE_WIRE).toEqual({
      linkPrefix: 'ffc1.',
      fragmentKey: 'c',
      maxTokenChars: 16_384, // DEV-504: was 8,192
      linkMaxProps: 128, // DEV-533
      maxInflatedBytes: 262_144, // DEV-504: was 16,384; DEV-533: was 65,536
      maxFileBytes: 65_536,
      fileMagic: 'FFCOURSE',
      fileVersion: 1,
      sectionCourse: 1,
      sectionMap: 2,
      fileExtension: '.ffcourse',
    })
  })
})

// ── 2. How long a link is ─────────────────────────────────────────────────

describe('DEV-467 — link lengths (EDITOR.md §5.1: a 25-point course under ~2,000 characters)', () => {
  const MEASURED = path.join(REPO, 'test-results', 'player-course-link-lengths.json')

  it('measures 10, 25 and 60 control points on int_01, and the 25 is inside the estimate', async () => {
    const rows: { points: number; canonicalBytes: number; deflatedBytes: number; link: number }[] =
      []
    for (const n of [10, 25, 60]) {
      const course = courseOf(n)
      expect(validatePlayerCourse(course, int01).ok, `${n} points valid on int_01`).toBe(true)
      const link = await courseLink(course, 'https://ff-10yr.pages.dev/')
      rows.push({
        points: n,
        canonicalBytes: new TextEncoder().encode(canonicalPlayerCourse(course)).length,
        deflatedBytes: (await coursePayload(course)).length,
        link: link.length,
      })
    }
    fs.mkdirSync(path.dirname(MEASURED), { recursive: true })
    fs.writeFileSync(MEASURED, `${JSON.stringify(rows, null, 2)}\n`)
    const at = (n: number) => rows.find((r) => r.points === n)?.link ?? Number.NaN
    // The row's figures (DEVIATIONS DEV-467) are these; a regression past the
    // estimate is a fold of the link tier into the code tier (§5.1).
    expect(at(25)).toBeLessThan(2000)
    expect(at(10)).toBeLessThan(at(25))
    expect(at(25)).toBeLessThan(at(60))
  })

  it('the most-of-everything course fits inside every cap, with room', async () => {
    expect(validatePlayerCourse(MOST).ok).toBe(true)
    const token = await courseToken(MOST)
    const canonical = new TextEncoder().encode(canonicalPlayerCourse(MOST)).length
    const file = await courseFile(MOST)
    expect(token.length).toBeLessThan(PLAYER_COURSE_WIRE.maxTokenChars / 2)
    expect(canonical).toBeLessThan(PLAYER_COURSE_WIRE.maxInflatedBytes / 2)
    expect(file.length).toBeLessThan(PLAYER_COURSE_WIRE.maxFileBytes / 8)
    // What the wire's header comments quote.
    fs.mkdirSync(path.join(REPO, 'test-results'), { recursive: true })
    fs.writeFileSync(
      path.join(REPO, 'test-results', 'player-course-most.json'),
      `${JSON.stringify({ token: token.length, canonical, file: file.length })}\n`,
    )
  })
})

/**
 * DEV-504: the most-of-everything course, plus `n` placed props: every kind
 * the library has in turn, every number long and different, so the deflate is
 * shown the worst it could be handed rather than `n` copies of one.
 */
const mostWithProps = (n: number): PlayerCourse => ({
  ...MOST,
  props: Array.from({ length: n }, (_, i) => {
    const e = PROP_LIBRARY.entries[i % PROP_LIBRARY.entries.length] as PropLibraryEntry
    return {
      kind: e.id,
      pos: [-2345.6 + i * 17.3, 123.4 + ((i * 7.7) % 400), 3456.7 - i * 13.9] as V,
      yaw: -179 + ((i * 47) % 359),
      scale: Math.round(e.scale.default * (0.3 + ((i * 0.37) % 3.6)) * 100) / 100,
    }
  }),
})
/** DEV-533: a full LINK of props, and a full FILE. */
const LINK_PROPS = mostWithProps(PLAYER_COURSE_WIRE.linkMaxProps)
const FILE_PROPS = mostWithProps(PLAYER_COURSE_LIMITS.props.max)

/** A link token made without `courseToken`'s refusal: what a pre-DEV-533 build wrote. */
const rawToken = async (course: PlayerCourse): Promise<string> =>
  `${PLAYER_COURSE_WIRE.linkPrefix}${toBase64url(await coursePayload(course))}`

describe('DEV-533 — 128 props in a link, 1,024 in a file', () => {
  it('pins the two caps by value, and the file’s is the larger', () => {
    // Matt, 2026-09-29: *"128 for links. as much as needed for save files."*
    expect(PLAYER_COURSE_WIRE.linkMaxProps).toBe(128)
    expect(PLAYER_COURSE_LIMITS.props.max).toBe(1024)
    expect(PLAYER_COURSE_LIMITS.props.max).toBeGreaterThan(PLAYER_COURSE_WIRE.linkMaxProps)
  })

  it('a full link fits every cap, with room, and the cost is written down', async () => {
    expect(validatePlayerCourse(LINK_PROPS).ok || validatePlayerCourse(LINK_PROPS)).toBe(true)
    expect(courseLinkable(LINK_PROPS)).toBe(true)
    const token = await courseToken(LINK_PROPS)
    const bare = await courseToken(MOST)
    const n = PLAYER_COURSE_WIRE.linkMaxProps
    const fileCourse = await courseFile(FILE_PROPS)
    const fileCanonical = new TextEncoder().encode(canonicalPlayerCourse(FILE_PROPS)).length
    const row = {
      linkProps: n,
      token: token.length,
      tokenWithoutProps: bare.length,
      perProp: Math.round((token.length - bare.length) / n),
      fileProps: PLAYER_COURSE_LIMITS.props.max,
      fileCanonical,
      file: fileCourse.length,
    }
    fs.mkdirSync(path.join(REPO, 'test-results'), { recursive: true })
    fs.writeFileSync(
      path.join(REPO, 'test-results', 'player-course-props-most.json'),
      `${JSON.stringify(row)}\n`,
    )
    // At the link's cap, the same half of every budget spare the
    // most-of-everything course above is held to.
    expect(token.length).toBeLessThan(PLAYER_COURSE_WIRE.maxTokenChars / 2)
    const back = await readCourseToken(token)
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(LINK_PROPS))
  })

  it('one more prop and there is no link: refused by name, and the file still made', async () => {
    const over = mostWithProps(PLAYER_COURSE_WIRE.linkMaxProps + 1)
    expect(validatePlayerCourse(over).ok).toBe(true)
    expect(courseLinkable(over)).toBe(false)
    const no = linkRefusal(over)
    expect(no?.why).toBe(noLinkForProps(PLAYER_COURSE_WIRE.linkMaxProps + 1))
    expect(no?.why).toMatch(/at most 128 props.*has 129.*Save file/)
    expect(no?.short.length).toBeLessThan(40) // it prints after "NOT COPIED:" on a panel
    await expect(courseToken(over)).rejects.toThrow(no?.why as string)
    const read = await readCourseFile(await courseFile(over))
    expect(read.ok && playerCourseId(read.course)).toBe(playerCourseId(over))
  })

  it('a full file fits its caps, with room, and reads back with its id', async () => {
    expect(validatePlayerCourse(FILE_PROPS).ok || validatePlayerCourse(FILE_PROPS)).toBe(true)
    const canonical = new TextEncoder().encode(canonicalPlayerCourse(FILE_PROPS)).length
    const file = await courseFile(FILE_PROPS)
    expect(canonical).toBeLessThan(PLAYER_COURSE_WIRE.maxInflatedBytes / 2)
    expect(file.length).toBeLessThan(PLAYER_COURSE_WIRE.maxFileBytes / 2)
    const back = await readCourseFile(file)
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(FILE_PROPS))
    // One past the ceiling is refused by the validator, which both doors share.
    const tooMany = validatePlayerCourse(mostWithProps(PLAYER_COURSE_LIMITS.props.max + 1))
    expect(tooMany.ok).toBe(false)
  })

  it('a link made before DEV-533, past 128 props, still opens with its id', async () => {
    // DEV-504 wrote links of up to 256; the cap is the writer's, not the reader's.
    const old = mostWithProps(256)
    const token = await rawToken(old)
    expect(token.length).toBeLessThanOrEqual(PLAYER_COURSE_WIRE.maxTokenChars)
    const back = await readCourseToken(token)
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(old))
  })
})

// ── 3. Round trips ────────────────────────────────────────────────────────

describe('DEV-467 — a course survives the link and the file, with its id', () => {
  const course = courseOf(25)

  it('link: token → the same canonical course, the same id', async () => {
    const token = await courseToken(course)
    expect(token.startsWith('ffc1.')).toBe(true)
    expect(token).toMatch(/^ffc1\.[A-Za-z0-9_-]+$/)
    const back = await readCourseToken(token)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(canonicalPlayerCourse(back.course)).toBe(canonicalPlayerCourse(course))
    expect(playerCourseId(back.course)).toBe(playerCourseId(course))
  })

  it('the fragment is #c=<token>, and courseTokenIn reads it back out of a hash', async () => {
    const fragment = await courseFragment(course)
    const token = await courseToken(course)
    expect(fragment).toBe(`#c=${token}`)
    expect(courseTokenIn(fragment)).toBe(token)
    expect(courseTokenIn(`#x=1&c=${token}&y=2`)).toBe(token)
    expect(courseTokenIn('')).toBeNull()
    expect(courseTokenIn('#cc=ffc1.x')).toBeNull()
    // A link replaces whatever fragment its base had, and keeps its path.
    const link = await courseLink(course, 'https://ff-10yr.pages.dev/?xr=off#old')
    expect(link).toBe(`https://ff-10yr.pages.dev/?xr=off${fragment}`)
  })

  it('file: bytes → the same course and id as the link; the layout is the header comment', async () => {
    const file = await courseFile(course)
    const payload = await coursePayload(course)
    expect(new TextDecoder().decode(file.subarray(0, 8))).toBe('FFCOURSE')
    expect(file[8]).toBe(1)
    expect(file[9]).toBe(PLAYER_COURSE_WIRE.sectionCourse)
    expect(new DataView(file.buffer).getUint32(10, true)).toBe(payload.length)
    expect(file.length).toBe(14 + payload.length)
    const back = await readCourseFile(file)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(playerCourseId(back.course)).toBe(playerCourseId(course))
    // The file's course section IS the link's payload.
    expect(toBase64url(file.subarray(14))).toBe((await courseToken(course)).slice(5))
  })

  it('names the file by its two words', () => {
    expect(courseFileName(course)).toBe('amber-heron.ffcourse')
  })

  it('a course that meant the same thing reads to the same id (quantised on the way in)', async () => {
    // From the course ON its grid (the route's own points are not), so a
    // 2–3 cm nudge cannot cross a rounding edge.
    const onGrid = validatePlayerCourse(course)
    if (!onGrid.ok) throw new Error('the sample must validate')
    const nudged: PlayerCourse = {
      ...onGrid.course,
      path: {
        ...onGrid.course.path,
        points: onGrid.course.path.points.map((p) => [p[0] + 0.02, p[1] - 0.03, p[2]] as V),
      },
    }
    const back = await readCourseToken(await courseToken(nudged))
    expect(back.ok && playerCourseId(back.course)).toBe(playerCourseId(course))
  })
})

// ── 4. Refusals, never throws ─────────────────────────────────────────────

const deflateRaw = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

const refusal = async (p: Promise<{ ok: boolean }>): Promise<string> => {
  const r = (await p) as { ok: boolean; errors?: readonly (readonly [string, string])[] }
  expect(r.ok).toBe(false)
  expect(r.errors?.length ?? 0).toBeGreaterThan(0)
  return (r.errors ?? []).map(([p, m]) => `${p}: ${m}`).join('; ')
}

describe('DEV-467 — a link refuses what it cannot read, and never throws', () => {
  it('garbage, of every kind', async () => {
    expect(await refusal(readCourseToken(''))).toMatch(/not a course link/)
    expect(await refusal(readCourseToken('hello'))).toMatch(/not a course link/)
    expect(await refusal(readCourseToken('ffc1.'))).toMatch(/damaged/)
    expect(await refusal(readCourseToken('ffc1.!!!!'))).toMatch(/damaged/)
    expect(await refusal(readCourseToken('ffc1.AAAAAAAA'))).toMatch(/link/)
    // Past the cap, whatever the cap is (DEV-504 moved it; 9,000 was typed here).
    expect(
      await refusal(readCourseToken(`ffc1.${'A'.repeat(PLAYER_COURSE_WIRE.maxTokenChars + 1)}`)),
    ).toMatch(/longer than/)
  })

  it('a newer link format says so', async () => {
    expect(await refusal(readCourseToken('ffc2.AAAA'))).toMatch(/newer build/)
  })

  it('deflated text that is not JSON, and JSON that is not a course', async () => {
    const notJson = toBase64url(await deflateRaw(new TextEncoder().encode('not json at all')))
    expect(await refusal(readCourseToken(`ffc1.${notJson}`))).toMatch(/not JSON/)
    const notCourse = toBase64url(await deflateRaw(new TextEncoder().encode('{"v":1}')))
    expect(await refusal(readCourseToken(`ffc1.${notCourse}`))).toMatch(/is missing/)
  })

  it('a deflate bomb is stopped at the inflate cap', async () => {
    // 4 MB of spaces deflates to a few KB: a small link that would inflate huge.
    const bomb = await deflateRaw(new Uint8Array(4 * 1024 * 1024).fill(32))
    const token = `ffc1.${toBase64url(bomb)}`
    expect(token.length).toBeLessThan(PLAYER_COURSE_WIRE.maxTokenChars)
    expect(await refusal(readCourseToken(token))).toMatch(/inflates past/)
  })
})

describe('DEV-467 — a file refuses what it cannot read, and never throws', () => {
  const good = () => courseFile(courseOf(10))

  it('not a course file; a newer one; a cut-short one', async () => {
    expect(await refusal(readCourseFile(new Uint8Array(0)))).toMatch(/not a course file/)
    expect(await refusal(readCourseFile(new TextEncoder().encode('PK\u0003\u0004zip')))).toMatch(
      /not a course file/,
    )
    const newer = await good()
    newer[8] = 2
    expect(await refusal(readCourseFile(newer))).toMatch(/newer build/)
    const whole = await good()
    expect(await refusal(readCourseFile(whole.subarray(0, whole.length - 3)))).toMatch(/cut short/)
    expect(await refusal(readCourseFile(whole.subarray(0, 11)))).toMatch(/cut short/)
    expect(await refusal(readCourseFile(whole.subarray(0, 9)))).toMatch(/holds no course/)
  })

  it('the reserved map section is refused by name; an unknown one too; two courses', async () => {
    const base = await good()
    const withSection = (kind: number): Uint8Array => {
      const out = new Uint8Array(base.length + 5 + 3)
      out.set(base, 0)
      out[base.length] = kind
      new DataView(out.buffer).setUint32(base.length + 1, 3, true)
      return out
    }
    expect(await refusal(readCourseFile(withSection(2)))).toMatch(/heightmap/)
    expect(await refusal(readCourseFile(withSection(9)))).toMatch(/does not know/)
    const twice = new Uint8Array(base.length + (base.length - 9))
    twice.set(base, 0)
    twice.set(base.subarray(9), base.length)
    expect(await refusal(readCourseFile(twice))).toMatch(/two courses/)
  })

  it('the size is asked before reading, and a big buffer is refused', async () => {
    expect(fileTooLarge(0)).toBe(false)
    expect(fileTooLarge(courseFileCap)).toBe(false)
    expect(fileTooLarge(courseFileCap + 1)).toBe(true)
    expect(fileTooLarge(Number.NaN)).toBe(true)
    expect(fileTooLarge(-1)).toBe(true)
    const big = new Uint8Array(courseFileCap + 1)
    expect(await refusal(readCourseFile(big))).toMatch(/larger than/)
  })

  it('random bytes behind a good header never throw', async () => {
    let seed = 7
    const next = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed >>> 24
    }
    const head = (await good()).subarray(0, 9)
    for (let k = 0; k < 40; k++) {
      const len = next() + 5
      const bytes = new Uint8Array(9 + len)
      bytes.set(head, 0)
      for (let i = 9; i < bytes.length; i++) bytes[i] = next()
      bytes[9] = 1
      const r = await readCourseFile(bytes)
      expect(r.ok).toBe(false)
    }
  })
})

// ── 5. Importable from a spec ─────────────────────────────────────────────

describe('DEV-467 — the wire stays importable from a Playwright spec', () => {
  it('reaches no module that uses import.meta.glob', () => {
    const reached = [...walkImports(path.join(REPO, 'src', 'content', 'player-course-wire.ts'))]
    // The walk is the premise: it must have reached the format it imports.
    expect(reached.map((n) => rel(n.file))).toContain('src/content/player-course.ts')
    // Code, not prose: a comment NAMING the global is not a use of it (the
    // substring-guard trap, CLAUDE.md), so comment lines are dropped first —
    // `player-course.test.ts`'s reading.
    const viteOnly = /import\.meta\.(glob|env)/
    const glob = reached.filter((n) =>
      viteOnly.test(
        fs
          .readFileSync(n.file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\/\/|\*)/.test(line))
          .join('\n'),
      ),
    )
    expect(glob.map((n) => rel(n.file))).toEqual([])
  })
})
