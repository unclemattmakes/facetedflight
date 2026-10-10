// tools/stats/columns.mjs: the arithmetic `pnpm stats` (stats.mjs) rests on,
// apart from the network so a unit test can hold it to the server (DEV-594).
//
// `columnOf` names a field's Analytics Engine column the way
// `src/net/stats-server.ts` writes it; `reach` is docs/stats.md's funnel rule.
// `tests/unit/stats-columns.test.ts` writes a row through the server's own
// `toPoint` and reads it back by these names.

/** `blobN` or `doubleN` for a kind's field: blob1 kind, blob2 version, then text fields; numbers from double1. */
export const columnOf = (schema, kind, name) => {
  const fields = schema.STATS_KINDS[kind]
  const text = schema.textFields(fields)
  const t = text.findIndex((f) => f.name === name)
  if (t >= 0) return `blob${t + 3}`
  const n = schema.numberFields(fields).findIndex((f) => f.name === name)
  if (n >= 0) return `double${n + 1}`
  if (kind === 'visit' && name === 'country') return `blob${text.length + 3}`
  throw new Error(`stats: no field ${kind}.${name}`)
}

/**
 * Reach per step of an ordered list, from groups that say where a row stood
 * (`at`, a list value) and where its visit's previous send stood (`before`,
 * index + 1, 0 on a first row): each visit counted once per step it reached.
 */
export const reach = (groups, order, atKey, beforeKey) =>
  order.map((step, i) => ({
    step,
    n: groups
      .filter((g) => Number(g[beforeKey]) < i + 1 && i + 1 <= order.indexOf(g[atKey]) + 1)
      .reduce((s, g) => s + Number(g.n), 0),
  }))
