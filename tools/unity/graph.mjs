// tools/unity/graph.mjs: a Unity prefab or scene as a graph (GameObject, Transform, component),
// and the one liveness walk over it.
//
// WP-23 and WP-24 (docs/plan/CODE-REUSE-AUDIT.md), TL-4 and TL-6 in docs/plan/code-reuse/tools.md.
// `componentRef` lived in constants.mjs and was used about fifteen times there; fourteen more
// sites spelled the same `m_Component -> byId.get -> filter(Boolean)` chain inline, level.mjs
// carried two copies of a third spelling, and convert-wings built its own `readPrefab` graph.
//
// ── The dialect trap lives here ───────────────────────────────────────────
//
// 2016 writes a GameObject's component list in TWO dialects: `- component: {fileID: N}` and the
// older `- 4: {fileID: N}` (the class number as the key). A reader that handles one returns an
// empty list for the other, and an empty list reads as ABSENCE (CLAUDE.md, DEV-043). Every
// component lookup in the extractors goes through `componentRef` below, which reads both.
//
// Everything here takes a `byId` lookup: a `Map<fileId string, parsed document>` (what
// `parseDocuments` gives, indexed by `String(doc.fileId)`), or any object with `.get(id)`. The
// lazy scanners in constants.mjs (terrain, sky) pass a wrapper whose `get` parses on demand.
// Pure reads. No Unity path is touched.

/**
 * The `{ fileID }` reference inside one `m_Component` entry, in either dialect.
 * Returns `null` for an entry that is not an object or has no key.
 */
export function componentRef(entry) {
  if (!entry || typeof entry !== 'object') return null
  if (entry.component) return entry.component
  const k = Object.keys(entry)[0]
  return k === undefined ? null : entry[k]
}

/** `String(doc.data.m_GameObject.fileID)`, '0' when absent: the GameObject a component hangs off. */
export const goIdOf = (comp) => String(comp?.data?.m_GameObject?.fileID ?? '0')

/** The GameObject document a component (a Transform included) belongs to, or `undefined`. */
export const goOfComponent = (byId, comp) => byId.get(goIdOf(comp))

/**
 * The fileIds of a GameObject's components, in list order, in either dialect.
 * An entry with no `fileID` is skipped (level.mjs's old loops did the same).
 */
export function componentIdsOf(go) {
  const out = []
  for (const entry of go?.data?.m_Component ?? []) {
    const ref = componentRef(entry)
    if (ref && ref.fileID !== undefined) out.push(String(ref.fileID))
  }
  return out
}

/**
 * A GameObject's component documents, in list order. A reference that does not resolve in this
 * file (a stripped prefab instance, a component that lives in another asset) is dropped.
 */
export function componentsOfGo(byId, go) {
  return (go?.data?.m_Component ?? [])
    .map((e) => byId.get(String(componentRef(e)?.fileID ?? '0')))
    .filter(Boolean)
}

/** The GameObject's Transform (class 4), or `undefined`. A GameObject has exactly one. */
export const transformOfGo = (byId, go) => componentsOfGo(byId, go).find((c) => c.classId === 4)

/**
 * `Map<component fileId, owning GameObject fileId>` over every GameObject (class 1) in `docs`.
 * Built from the raw component lists, so it answers for a component whose own document the
 * caller never parsed. A component listed by two GameObjects keeps the LATER owner.
 */
export function componentOwners(docs) {
  const owner = new Map()
  for (const d of docs) {
    if (d.classId !== 1) continue
    for (const id of componentIdsOf(d)) owner.set(id, String(d.fileId))
  }
  return owner
}

/** `String(m_Father.fileID)`, '0' for a root or a missing field. */
export const fatherIdOf = (tf) => String(tf?.data?.m_Father?.fileID ?? '0')

/** The parent Transform document, or `undefined` for a root (or a father outside this file). */
export const parentOf = (byId, tf) => {
  const id = fatherIdOf(tf)
  return id === '0' ? undefined : byId.get(id)
}

/** The GameObject's `m_Name` as a string ('' when absent). */
export const nameOfGo = (go) => String(go?.data?.m_Name ?? '')

/** Child Transform documents of a Transform, in `m_Children` order, unresolved ones dropped. */
export const childrenOf = (byId, tf) =>
  (tf?.data?.m_Children ?? []).map((c) => byId.get(String(c.fileID))).filter(Boolean)

// ── liveness (WP-24, TL-4) ─────────────────────────────────────────────────
//
// "Alive" in Unity is `activeInHierarchy`: the GameObject's own `m_IsActive` AND every ancestor's.
// CLAUDE.md's "Ring counts need the liveness walk": skip it and `int_02` reports 77 rings
// instead of 21. The walk was written about a dozen times, each copy with its own idea of how
// deep to go, what to do about a cycle and what an absent `m_IsActive` means. This is the one.
//
// What an absent `m_IsActive` means (established from the YAML, read-only scan of every
// .unity and .prefab under the legacy Assets, 2026-10-05): all 432,538 non-stripped GameObject
// documents carry `m_IsActive` (417,715 are 1, 14,823 are 0); the 608 documents that lack it
// are `stripped` GameObjects, the placeholder a scene keeps for a PREFAB INSTANCE's object,
// whose real state lives in the prefab asset and the instance's `m_Modifications`. So an absent
// field is never a default of "active" or "inactive": it is UNKNOWN, and the file cannot answer.
// `activeOf` returns -1 for it, and each caller says what it does with an unknown
// (`chainIsLive`'s `unknown` option) instead of the answer being smuggled in by a default.

/**
 * A GameObject's `m_IsActive` as 1 (active), 0 (inactive) or -1 (unknown: no GameObject in this
 * file, or a stripped placeholder with no field).
 */
export const activeOf = (go) => {
  const v = go?.data?.m_IsActive
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : -1
}

/**
 * The Transforms from `tf` up to the root, NEAREST FIRST (`tf` itself first unless
 * `includeSelf` is false), each with its GameObject and that GameObject's `activeOf`.
 *
 * Returns `{ nodes, rootReached }`: `nodes[i] = { transform, go, active, fatherId }`, and
 * `rootReached` is true when the walk ended at a Transform whose father is 0 (a real root), false
 * when it ended because a father is not in this file (a stripped prefab-instance parent) or
 * because `cap` stopped it. `byId` is a Map or anything with `.get(id)`, so the lazy scanners in
 * constants.mjs can hand in a wrapper that parses on demand; a falsy answer ends the walk.
 *
 * A cycle throws: nothing in a Unity file has one, and the copies of this walk that guarded
 * against it by a depth cap answered "alive" for whatever lay past the cap, which reads as a
 * clean result. `cap` (max nodes) exists only so a caller can reproduce a legacy depth limit
 * while its bytes are being proved; no caller should keep one.
 */
export function chainUp(byId, tf, { includeSelf = true, cap = Number.POSITIVE_INFINITY } = {}) {
  const nodes = []
  const seen = new Set()
  let cur = includeSelf || !tf ? tf : byId.get(fatherIdOf(tf))
  while (cur && nodes.length < cap) {
    const id = String(cur.fileId)
    if (seen.has(id)) throw new Error(`transform chain cycle at ${id}`)
    seen.add(id)
    const go = byId.get(goIdOf(cur))
    const fatherId = fatherIdOf(cur)
    nodes.push({ transform: cur, go, active: activeOf(go), fatherId })
    if (fatherId === '0') break
    cur = byId.get(fatherId)
  }
  const last = nodes[nodes.length - 1]
  const rootReached = last ? last.fatherId === '0' : !includeSelf && !!tf && fatherIdOf(tf) === '0'
  return { nodes, rootReached }
}

/**
 * Is every node on the chain active? An UNKNOWN node (`active === -1`) counts as `unknown`
 * ('dead' by default: a conservative walk ships nothing it cannot prove alive; 'alive' for a
 * caller that treats the file's silence as no veto, as the fader census does).
 */
export const chainIsLive = (nodes, { unknown = 'dead' } = {}) =>
  nodes.every((n) => n.active === 1 || (n.active === -1 && unknown === 'alive'))

/**
 * activeInHierarchy over a FLATTENED scene (the prototype's `flat.objects`, which carry `active`
 * and a `parent` key rather than Transform documents). `parentOf(obj)` returns the parent object
 * or a falsy value for a root. Nodes `forced` are treated as active (a runtime-toggled page whose
 * state a script, not the file, decides) but their ANCESTORS still count. A missing parent is a
 * root. A cycle throws.
 */
export function flatIsLive(obj, parentOf, { forced = () => false } = {}) {
  const seen = new Set()
  for (let cur = obj; cur; cur = parentOf(cur)) {
    if (seen.has(cur)) throw new Error(`flat hierarchy cycle at ${cur.key ?? '?'}`)
    seen.add(cur)
    if (!forced(cur) && cur.active === false) return false
  }
  return true
}

/**
 * A prefab as a bound graph: the shape `convert-wings.readPrefab` always returned, now built once
 * from parsed documents. `goOf(tf)` takes a Transform; `tfOf(go)`, `nameOf(go)`, `componentsOf(go)`
 * take a GameObject; `parentOf(tf)` and `children(tf)` take a Transform.
 */
export function graphOf(docs) {
  const byId = new Map(docs.map((d) => [String(d.fileId), d]))
  return {
    docs,
    byId,
    goOf: (comp) => goOfComponent(byId, comp),
    tfOf: (go) => transformOfGo(byId, go),
    nameOf: nameOfGo,
    children: (tf) => childrenOf(byId, tf),
    parentOf: (tf) => parentOf(byId, tf) ?? null,
    componentsOf: (go) => componentsOfGo(byId, go),
  }
}
