// tools/unity/material.mjs: material properties read off the RAW text of a `.mat`.
//
// WP-23, TL-7 in docs/plan/code-reuse/tools.md. Six readers of material properties lived in
// constants.mjs, three converters and convert-life, and two of them (constants `materialProperty`,
// convert-wings `readMaterial`) went through the YAML parser, which cannot answer for the OLD
// dialect:
//
//   m_Colors:
//     data:
//       first: {name: _Color}
//       second: {r: 1, g: 1, b: 1, a: 1}
//     data:
//       first: ...                 <- the same key again
//
// `parseDocuments` keeps only the LAST of the repeated `data` keys, so a parsed lookup sees one
// property or none, and "none" is emitted as "the shader's default" (CLAUDE.md, DEV-043: the old
// dialect reads as ABSENCE). Both dialects write `name: <prop>` with `second:` on the next line,
// so the raw text answers for both, which is what these do.
//
// They return UNROUNDED numbers and a 1-based line. Rounding is the caller's (the sheet rounds
// to 6 places, the GLB converters do not), and so is deciding whether a missing property is an
// error (the converters throw) or a null (the sheet records "not set").

/** A decimal, with an optional signed exponent. `1e+05` and `-1.5e-05` both read. */
const NUM = '(-?[\\d.]+(?:[eE][-+]?\\d+)?)'

const NEWLINE = /\r?\n/

/** The 1-based line of the `second:` that the match `m` carries, in `text`. */
const lineOfSecond = (text, m) =>
  text.slice(0, m.index + m[0].indexOf('second:')).split(NEWLINE).length

/** Which dialect `text` is in: the old one has a bare `data:` line with no list marker. */
export const materialDialect = (text) => (/\n\s+data:\s*\r?\n/.test(text) ? 'old' : 'new')

/**
 * A colour property: `{ value: [r, g, b, a], line, dialect }`, or `null` when `name` is absent.
 * `name` is matched whole (`_Color` does not match `_ColorTint`: the next line must be `second:`).
 */
export function rawColour(text, name) {
  const re = new RegExp(
    `name: ${name}\\r?\\n\\s*second: \\{r: ${NUM}, g: ${NUM}, b: ${NUM}, a: ${NUM}\\}`,
  )
  const m = re.exec(text)
  if (!m) return null
  return {
    value: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])],
    line: lineOfSecond(text, m),
    dialect: materialDialect(text),
  }
}

/** A float property: `{ value, line }`, or `null` when absent. */
export function rawFloat(text, name) {
  const re = new RegExp(`name: ${name}\\r?\\n\\s*second: ${NUM}\\s*\\r?\\n`)
  const m = re.exec(text)
  if (!m) return null
  return { value: Number(m[1]), line: lineOfSecond(text, m) }
}

/** A texture slot: `{ guid, scale: [x, y], offset: [x, y] }` (guid `null` for none), or `null`. */
export function rawTexEnv(text, name) {
  const re = new RegExp(
    `name: ${name}\\r?\\n\\s*second:\\r?\\n\\s*m_Texture: \\{fileID: (\\d+)(?:, guid: ([0-9a-f]+), type: \\d+)?\\}\\r?\\n\\s*m_Scale: \\{x: ${NUM}, y: ${NUM}\\}\\r?\\n\\s*m_Offset: \\{x: ${NUM}, y: ${NUM}\\}`,
  )
  const m = re.exec(text)
  if (!m) return null
  return {
    guid: m[2] ?? null,
    scale: [Number(m[3]), Number(m[4])],
    offset: [Number(m[5]), Number(m[6])],
  }
}

/** The shader's guid off a material's text, or `null`. */
export const shaderGuidOf = (text) => /m_Shader: \{fileID: \d+, guid: (\w+)/.exec(text)?.[1] ?? null
