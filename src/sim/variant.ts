// src/sim/variant.ts — a VIEW of the generated sheet, scaled. DEV-380.
//
// docs/plan/AIRCRAFT-VARIANTS.md §2.3. An aircraft variant is not a second set
// of numbers: it is a set of dimensionless multipliers on named keys of the
// sheet 2016's prefab produced, and this is the one function that applies
// them. The vehicle constructors take a sheet-shaped object and never learn
// that variants exist; `standard` is the sheet by construction, because an
// empty scale returns the sheet ITSELF, the same object, not a copy that has to
// be kept equal to it.
//
// Every physical number still comes off the sheet (hard rule 3). A variant
// contributes a factor, and the factor lives in content (`content/aircraft/`,
// hard rule 6), so "the acrobat rolls at 1.8 x 2016's torque" survives a
// re-extraction that corrects the torque, where an absolute 5.4 would not.
//
// No literal of its own, no three, no DOM: sim-pure, like everything here.
// What a key MAY be scaled is the content layer's business
// (`src/content/aircraft-schema.ts`'s whitelist); this file only refuses a key
// that does not name a finite number on the sheet it is handed, so a typo can
// never quietly add a field nothing reads.

/** `'ship.rollRate' -> 1.8`: a dotted sheet path and the factor it is multiplied by. */
export type SheetScale = Readonly<Record<string, number>>

/**
 * The shape of a sheet block with its literal types widened.
 *
 * The generated module is `as const`, so `typeof HOVERJET` says `maxSpeed:
 * 437.5` — true of the sheet and a lie about any view of it. A scaled view is
 * the same SHAPE with other numbers in it, and this is that shape.
 */
export type Sheet<T> = T extends number
  ? number
  : T extends string
    ? string
    : T extends boolean
      ? boolean
      : T extends readonly (infer U)[]
        ? readonly Sheet<U>[]
        : T extends object
          ? { readonly [K in keyof T]: Sheet<T[K]> }
          : T

export class SheetScaleError extends Error {
  constructor(key: string, detail: string) {
    super(`scaleSheet("${key}"): ${detail}`)
    this.name = 'SheetScaleError'
  }
}

type Node = Record<string, unknown>

const isNode = (x: unknown): x is Node => typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * A copy of `sheet` with each named leaf multiplied by its factor.
 *
 * Copies ONLY the objects on each named path, so the generated module is never
 * written and everything the scale does not name is shared with the sheet by
 * reference. An empty scale returns `sheet` itself.
 *
 * Throws on a path that does not walk own properties of plain objects to a
 * finite number. The content validator refuses those first, with the file's
 * name in the message; this is the second line, for a caller that builds a
 * scale by hand.
 */
export const scaleSheet = <T extends object>(sheet: T, scale: SheetScale): T => {
  const keys = Object.keys(scale)
  if (keys.length === 0) return sheet
  const root: Node = { ...(sheet as Node) }
  // The objects this call made. A path that shares a parent with an earlier
  // one writes into the copy already made rather than copying it again, which
  // would drop the earlier write.
  const mine = new Set<Node>([root])
  for (const key of keys) {
    const factor = scale[key]
    if (typeof factor !== 'number' || !Number.isFinite(factor)) {
      throw new SheetScaleError(key, `factor ${String(factor)} is not a finite number`)
    }
    const parts = key.split('.')
    const leaf = parts.pop() as string
    let node = root
    for (const part of parts) {
      const child = Object.hasOwn(node, part) ? node[part] : undefined
      if (!isNode(child)) throw new SheetScaleError(key, `"${part}" is not an object on the sheet`)
      let next = child
      if (!mine.has(next)) {
        next = { ...child }
        node[part] = next
        mine.add(next)
      }
      node = next
    }
    const value = Object.hasOwn(node, leaf) ? node[leaf] : undefined
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SheetScaleError(key, 'does not name a finite number on the sheet')
    }
    node[leaf] = value * factor
  }
  return root as T
}

/**
 * The value at a dotted path, or `undefined` when the path does not walk own
 * properties to a leaf. What the content validator checks a key against, so
 * "is this a number on the sheet" has one definition.
 */
export const sheetValue = (sheet: object, key: string): unknown => {
  let node: unknown = sheet
  for (const part of key.split('.')) {
    if (!isNode(node) || !Object.hasOwn(node, part)) return undefined
    node = node[part]
  }
  return node
}
