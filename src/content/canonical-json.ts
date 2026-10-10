// src/content/canonical-json.ts — one text for one value, and a short name for it.
//
// Moved here from `src/net/lap-courses-build.ts` (which re-exports both) by
// DEV-538, because the shipped-course override (`content/level-override.ts`)
// needs the same canonical form and the same hash for its personal-best course
// key, and `lap-courses-build.ts` imports `game/` — a module under
// `src/content/` that reached it would drag the game into anything that
// validates an override: the node tests, and the dev server's writer
// (`tools/dev/override-writer.mjs`). Pure: no DOM, no three, no glob.

/** JSON with every object's keys sorted: the same text for the same data, whatever order it was built in. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * FNV-1a, 32 bits, over UTF-16 code units, as eight hex digits. An IDENTITY for
 * a version, not a security boundary: nothing trusts it to be unforgeable, only
 * to change when its input does. The body lives in `sim/math/hash.ts`; this is
 * its hex form under the name `level-override` and the lap courses already use.
 */
export { fnv1a32Hex as fnv1a32 } from '@/sim/math/hash'

/** A deep copy of `value` with every object's keys in sorted order (undefined dropped). */
export const sortedKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortedKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (v !== undefined) out[k] = sortedKeys(v)
    }
    return out
  }
  return value
}

/**
 * Two-space JSON with every array of plain numbers on one line — a pose is
 * three or four numbers, and one number per line is unreviewable — and a final
 * newline. `serialiseLapCourses`'s layout, as a function of the text.
 */
export const oneLineNumberArrays = (json: string): string =>
  json.replace(
    /\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g,
    (_m, inner: string) => `[${inner.split(/,\s+/).join(', ')}]`,
  )
