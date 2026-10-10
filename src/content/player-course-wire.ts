// src/content/player-course-wire.ts — a player course as a LINK and as a
// FILE. DEV-467, E1.
//
// docs/plan/EDITOR.md §5.2 (the link tier) and §5.6 (creators host their own
// files). Both carry the same bytes: the course's CANONICAL JSON
// (`canonicalPlayerCourse`), deflated raw with the browser's own
// `CompressionStream`. So a course read from a link and the same course read
// from a file have the same id, and neither form can carry a field the
// validator has not seen: what comes out of either door goes through
// `validatePlayerCourse` before anything else reads it.
//
// ── The link ─────────────────────────────────────────────────────────────
//
//   https://<host>/#c=ffc1.<base64url(deflate-raw(canonical))>
//
// In the FRAGMENT, never the query: a fragment never reaches a server, so a
// course sent as a link is seen by its recipient and nobody else (§5.2's
// "moderation: none" rests on that). `ffc1` is the link format's version; a
// later one gets a new prefix and this build refuses it by name.
//
// ── The file (`.ffcourse`) ───────────────────────────────────────────────
//
//   bytes 0..7   "FFCOURSE" (ASCII), the magic
//   byte  8      the container version, 1
//   then SECTIONS, to the end of the file, each:
//     byte  0    its kind
//     bytes 1..4 its length, u32 little-endian
//     then that many bytes
//
//   kind 1  the course: the link's deflated bytes, exactly. Exactly one, first.
//   kind 2  the heightmap (§5.4's T1.5, §5.6's "one file, not a course plus a
//           map"), DEV-490: the map FILE's bytes as the creator imported them
//           (a greyscale PNG or an `.r16`, `content/island-map.ts`), stored,
//           not re-deflated (a PNG already is). At most one, and present
//           exactly when the course's `island` names a map, whose SHA-256 it
//           must be. A v1 build (DEV-467) refuses it by name.
//
// A course on an imported island has no link: a fragment cannot carry
// megabytes. `courseLinkable` says so, `courseToken` refuses one, and a link
// that names a map (hand-made) is refused on the way in.
//
// DEV-533: nor has a course of more than `linkMaxProps` placed props (128).
// Matt: *"128 for links. as much as needed for save files."* A link has to
// survive a chat app; a file does not. The cap is the WRITER's. The reader
// still opens any course the format holds within `maxTokenChars`, so a link
// made before DEV-533 with up to DEV-504's 256 props still opens.
//
// Sections rather than a fixed layout so the map can be added without a new
// magic, and a reader of this version can tell "a map I cannot use" from
// "not a course file".
//
// ── Untrusted input ──────────────────────────────────────────────────────
//
// A link or a file is as hostile as anything the lap server receives. Every
// length is checked before the bytes behind it are read: a fragment's length
// before it is decoded, a file's size before it is read (`fileTooLarge`, which
// the caller asks BEFORE `File.arrayBuffer`), a section's length against what
// is left, and the INFLATED size as it streams — a deflate bomb stops at the
// cap rather than at the end of memory. A message never echoes the input.
//
// Importable from a Playwright spec, deliberately: it reaches
// `player-course.ts` and nothing that reaches `load-level.ts`'s
// `import.meta.glob` (`tests/unit/e2e-import-graph.test.ts` holds it).

import { fromBase64url, toBase64url } from '@/net/base64url'
import { drainCapped } from '@/net/http'
import { HEIGHTMAP_LIMITS, heightmapSha } from './island-map'
import {
  canonicalPlayerCourse,
  isMapIsland,
  type PlayerCourse,
  type PlayerCourseIssue,
  type PlayerCourseResult,
  validatePlayerCourse,
} from './player-course'

/**
 * Every number the two wire forms rest on, under one name. Policy and format,
 * not physics; **pinned by value in `tests/unit/player-course-wire.test.ts`**,
 * so moving one is an edit made on purpose.
 */
export const PLAYER_COURSE_WIRE = {
  /** The link token's prefix: the link format, version 1. */
  linkPrefix: 'ffc1.',
  /** The fragment's key: `#c=<token>`. */
  fragmentKey: 'c',
  /**
   * The longest token read, characters. A 64-point course with 100 skipped
   * rings (the format's most) measures ~1,600 (the test); a placed prop adds
   * ~26 characters, so DEV-533's link cap of 128 measures ~4,900. Kept at
   * DEV-504's 16,384, which its 256 props filled to half, so every link made
   * before DEV-533 still opens; past it is garbage, refused before a byte of
   * it is decoded. (8,192 until DEV-504.)
   */
  maxTokenChars: 16_384,
  /**
   * DEV-533: the most placed props a LINK carries. A course with more is
   * saved as a file (`linkRefusal`); the course's own ceiling, the file's, is
   * `PLAYER_COURSE_LIMITS.props.max`.
   */
  linkMaxProps: 128,
  /**
   * The most bytes a course may inflate to, link or file. The
   * most-of-everything course is ~4,100 canonical bytes, and a full file
   * ceiling of props takes it several times past DEV-504's 65,536 (the test
   * holds it under half of this); past this the stream is cancelled, whatever
   * the deflated input claimed. (16,384 until DEV-504, 65,536 until DEV-533.)
   */
  maxInflatedBytes: 262_144,
  /**
   * The largest `.ffcourse` WITHOUT a map, bytes. A v1 file is the link's
   * bytes plus 14 of framing. DEV-490: a file with a map may be larger by the
   * map's own cap (`HEIGHTMAP_LIMITS.maxFileBytes`) and its section header;
   * `courseFileCap` is the sum, asked of `File.size` BEFORE reading.
   */
  maxFileBytes: 65_536,
  /** The file's first eight bytes. */
  fileMagic: 'FFCOURSE',
  /** The container version in byte 8. */
  fileVersion: 1,
  /** Section kinds. */
  sectionCourse: 1,
  sectionMap: 2,
  /** The file name's extension, and the picker's `accept`. */
  fileExtension: '.ffcourse',
} as const

/** A section header: one kind byte and a u32 length. */
const SECTION_HEADER_BYTES = 1 + 4
/** Magic plus the version byte. */
const FILE_HEADER_BYTES = PLAYER_COURSE_WIRE.fileMagic.length + 1

const refused = (
  path: string,
  message: string,
): { readonly ok: false; readonly errors: readonly PlayerCourseIssue[] } => ({
  ok: false,
  errors: [[path, message] as PlayerCourseIssue],
})

// ── deflate-raw, both ways ────────────────────────────────────────────────

/** One whole buffer through a transform, as a stream. */
const through = (bytes: Uint8Array, transform: CompressionStream | DecompressionStream) => {
  const source = new Blob([bytes as BlobPart]).stream()
  return source.pipeThrough(transform as unknown as TransformStream<Uint8Array, Uint8Array>)
}

const deflate = async (bytes: Uint8Array): Promise<Uint8Array> =>
  (await drainCapped(
    through(bytes, new CompressionStream('deflate-raw')),
    Number.POSITIVE_INFINITY,
  )) ?? new Uint8Array(0)

/** Inflate, capped. Null past the cap; throws on a stream that is not deflate. */
const inflate = (bytes: Uint8Array): Promise<Uint8Array | null> =>
  drainCapped(
    through(bytes, new DecompressionStream('deflate-raw')),
    PLAYER_COURSE_WIRE.maxInflatedBytes,
  )

/**
 * DEV-490: the largest `.ffcourse` read, bytes: a course's file and a map's,
 * and the map section's header.
 */
export const courseFileCap =
  PLAYER_COURSE_WIRE.maxFileBytes + SECTION_HEADER_BYTES + HEIGHTMAP_LIMITS.maxFileBytes

/** The sentence said where a link is asked of a course that cannot be one. */
export const NO_LINK_FOR_A_MAP =
  'A link cannot carry an imported heightmap: use Save file, and send the file'

/** DEV-533: the same, for a course with more placed props than a link carries. */
export const noLinkForProps = (count: number): string =>
  `A link carries at most ${PLAYER_COURSE_WIRE.linkMaxProps} props and this course has ${count}: use Save file, and send the file`

/**
 * Why `course` cannot be a link, or null when it can: its island is an
 * imported map (DEV-490), or it holds more than `linkMaxProps` placed props
 * (DEV-533). `why` is the editor's sentence; `short` is the post-race panel's,
 * printed after "NOT COPIED:" with the file offered beside it.
 */
export const linkRefusal = (
  course: PlayerCourse,
): { readonly why: string; readonly short: string } | null => {
  if (isMapIsland(course.ground)) {
    return { why: NO_LINK_FOR_A_MAP, short: 'an imported island has no link' }
  }
  const n = course.props?.length ?? 0
  if (n > PLAYER_COURSE_WIRE.linkMaxProps) {
    return {
      why: noLinkForProps(n),
      short: `a link holds ${PLAYER_COURSE_WIRE.linkMaxProps} props: save a file`,
    }
  }
  return null
}

/** Can `course` be a link? Not on an imported map (DEV-490), nor past 128 props (DEV-533). */
export const courseLinkable = (course: PlayerCourse): boolean => linkRefusal(course) === null

/** The canonical bytes of a course, deflated: what the link and the file both carry. */
export const coursePayload = (course: PlayerCourse): Promise<Uint8Array> =>
  deflate(new TextEncoder().encode(canonicalPlayerCourse(course)))

/** Deflated bytes back to a course: inflate (capped), parse, validate (structural). */
export const readCoursePayload = async (payload: Uint8Array): Promise<PlayerCourseResult> => {
  let inflated: Uint8Array | null
  try {
    inflated = await inflate(payload)
  } catch {
    return refused('', 'is not a compressed course')
  }
  if (inflated === null) {
    return refused('', `inflates past ${PLAYER_COURSE_WIRE.maxInflatedBytes} bytes; not a course`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inflated))
  } catch {
    return refused('', 'is not a course: its text is not JSON')
  }
  return validatePlayerCourse(parsed)
}

// ── The link ──────────────────────────────────────────────────────────────

/** `ffc1.<base64url(deflate-raw(canonical))>`: the course as a link token. */
export const courseToken = async (course: PlayerCourse): Promise<string> => {
  const no = linkRefusal(course)
  if (no) throw new Error(no.why)
  return `${PLAYER_COURSE_WIRE.linkPrefix}${toBase64url(await coursePayload(course))}`
}

/** `#c=<token>`: the course as a URL fragment. */
export const courseFragment = async (course: PlayerCourse): Promise<string> =>
  `#${PLAYER_COURSE_WIRE.fragmentKey}=${await courseToken(course)}`

/**
 * The whole link: `base` (an origin plus a path, e.g. `location.origin +
 * location.pathname`) with the course in its fragment. Anything already in
 * `base`'s fragment is dropped.
 */
export const courseLink = async (course: PlayerCourse, base: string): Promise<string> =>
  `${base.split('#')[0]}${await courseFragment(course)}`

/**
 * The token in a location's hash (`#c=…`), or null when the hash names no
 * course. Only the `c` key is read; the value runs to the next `&`.
 */
export const courseTokenIn = (hash: string): string | null => {
  const body = hash.startsWith('#') ? hash.slice(1) : hash
  for (const part of body.split('&')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === PLAYER_COURSE_WIRE.fragmentKey) return part.slice(eq + 1)
  }
  return null
}

/** A link token to a course, validated structurally. Never throws. */
export const readCourseToken = async (token: string): Promise<PlayerCourseResult> => {
  if (token.length > PLAYER_COURSE_WIRE.maxTokenChars) {
    return refused('link', `is longer than ${PLAYER_COURSE_WIRE.maxTokenChars} characters`)
  }
  if (!token.startsWith(PLAYER_COURSE_WIRE.linkPrefix)) {
    const dot = token.indexOf('.')
    return dot > 0 && /^ffc\d+$/.test(token.slice(0, dot))
      ? refused('link', 'is from a newer build of the game')
      : refused('link', 'is not a course link')
  }
  const bytes = fromBase64url(token.slice(PLAYER_COURSE_WIRE.linkPrefix.length))
  if (bytes === null || bytes.length === 0) return refused('link', 'is damaged: not base64url')
  const read = await readCoursePayload(bytes)
  // Only the map is refused on the way IN: a link past DEV-533's 128 props
  // (made before it, or by hand) is a course the format holds, and opens.
  if (read.ok && isMapIsland(read.course.ground)) {
    return refused('link', 'names an imported heightmap, which comes in a .ffcourse file')
  }
  return read.ok ? read : { ok: false, errors: read.errors.map(([p, m]) => [p || 'link', m]) }
}

// ── The file ──────────────────────────────────────────────────────────────

const MAGIC = new TextEncoder().encode(PLAYER_COURSE_WIRE.fileMagic)

/**
 * A `.ffcourse`: the magic, the version, one course section, and — DEV-490,
 * when the course's island is an imported map — the map's bytes, which must
 * be the ones its `island.map` names (a mismatch throws: a file is never
 * written that its own reader would refuse).
 */
export const courseFile = async (
  course: PlayerCourse,
  map: Uint8Array | null = null,
): Promise<Uint8Array> => {
  const payload = await coursePayload(course)
  const ground = course.ground
  if (isMapIsland(ground)) {
    if (!map || (await heightmapSha(map)) !== ground.map) {
      throw new Error('courseFile: the map given is not the one the course names')
    }
  } else if (map) {
    throw new Error('courseFile: a map given for a course that names none')
  }
  const mapBytes = isMapIsland(ground) ? (map as Uint8Array) : null
  const out = new Uint8Array(
    FILE_HEADER_BYTES +
      SECTION_HEADER_BYTES +
      payload.length +
      (mapBytes ? SECTION_HEADER_BYTES + mapBytes.length : 0),
  )
  out.set(MAGIC, 0)
  out[MAGIC.length] = PLAYER_COURSE_WIRE.fileVersion
  const view = new DataView(out.buffer)
  view.setUint8(FILE_HEADER_BYTES, PLAYER_COURSE_WIRE.sectionCourse)
  view.setUint32(FILE_HEADER_BYTES + 1, payload.length, true)
  out.set(payload, FILE_HEADER_BYTES + SECTION_HEADER_BYTES)
  if (mapBytes) {
    const at = FILE_HEADER_BYTES + SECTION_HEADER_BYTES + payload.length
    view.setUint8(at, PLAYER_COURSE_WIRE.sectionMap)
    view.setUint32(at + 1, mapBytes.length, true)
    out.set(mapBytes, at + SECTION_HEADER_BYTES)
  }
  return out
}

/** A read `.ffcourse`: the course, and its map's bytes when its island is one (DEV-490). */
export type PlayerCourseFileResult =
  | { readonly ok: true; readonly course: PlayerCourse; readonly map: Uint8Array | null }
  | { readonly ok: false; readonly errors: readonly PlayerCourseIssue[] }

/** A file name for a course: its two words and the extension, `amber-heron.ffcourse`. */
export const courseFileName = (course: PlayerCourse): string =>
  `${course.name.join('-').toLowerCase()}${PLAYER_COURSE_WIRE.fileExtension}`

/** Ask BEFORE reading: is a file of `size` bytes past the cap? */
export const fileTooLarge = (size: number): boolean =>
  !(Number.isFinite(size) && size >= 0 && size <= courseFileCap)

/**
 * A `.ffcourse`'s bytes to a course, validated structurally, and its map's
 * bytes checked against the SHA-256 the course names (DEV-490). The map is
 * not DECODED here: `content/island-map.ts` does that where a ground is built,
 * and says what is wrong with it there. Never throws.
 */
export const readCourseFile = async (bytes: Uint8Array): Promise<PlayerCourseFileResult> => {
  if (fileTooLarge(bytes.length)) {
    return refused('file', `is larger than ${courseFileCap} bytes`)
  }
  if (bytes.length < FILE_HEADER_BYTES || MAGIC.some((b, i) => bytes[i] !== b)) {
    return refused('file', 'is not a course file')
  }
  const version = bytes[MAGIC.length] as number
  if (version !== PLAYER_COURSE_WIRE.fileVersion) {
    return version > PLAYER_COURSE_WIRE.fileVersion
      ? refused('file', 'is from a newer build of the game')
      : refused('file', 'has an unknown version')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = FILE_HEADER_BYTES
  let payload: Uint8Array | null = null
  let map: Uint8Array | null = null
  while (at < bytes.length) {
    if (bytes.length - at < SECTION_HEADER_BYTES) return refused('file', 'is cut short')
    const kind = view.getUint8(at)
    const length = view.getUint32(at + 1, true)
    at += SECTION_HEADER_BYTES
    if (length > bytes.length - at) return refused('file', 'is cut short')
    if (kind === PLAYER_COURSE_WIRE.sectionCourse) {
      if (payload !== null) return refused('file', 'holds two courses')
      if (length > PLAYER_COURSE_WIRE.maxFileBytes)
        return refused('file', 'holds too long a course')
      payload = bytes.subarray(at, at + length)
    } else if (kind === PLAYER_COURSE_WIRE.sectionMap) {
      if (map !== null) return refused('file', 'holds two heightmaps')
      if (length > HEIGHTMAP_LIMITS.maxFileBytes)
        return refused('file', 'holds too large a heightmap')
      map = bytes.subarray(at, at + length)
    } else {
      return refused('file', 'has a section this version does not know')
    }
    at += length
  }
  if (payload === null) return refused('file', 'holds no course')
  const read = await readCoursePayload(payload)
  if (!read.ok) return { ok: false, errors: read.errors.map(([p, m]) => [p || 'file', m]) }
  const ground = read.course.ground
  if (isMapIsland(ground)) {
    if (!map) return refused('file', 'names an imported heightmap but does not carry it')
    if ((await heightmapSha(map)) !== ground.map) {
      return refused('file', 'carries a heightmap that is not the one its course names')
    }
    return { ok: true, course: read.course, map: map.slice() }
  }
  if (map) return refused('file', 'carries a heightmap its course does not name')
  return { ok: true, course: read.course, map: null }
}
