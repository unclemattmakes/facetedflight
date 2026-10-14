// @engine-layer: imports nothing from game, content, generated or boot/app (tests/unit/engine-layering-guard.test.ts)
/**
 * `localStorage`, or null where touching it throws (a private window, blocked
 * site data, a webview with storage off).
 *
 * Reading the PROPERTY is what throws in a blocked context, so the try/catch
 * has to be around the access and not merely around `getItem`. Do not
 * "simplify" a call site to `globalThis.localStorage?.getItem(...)`: that is
 * the form that throws.
 *
 * It returns the whole `Storage` so a caller narrows it with `Pick<Storage, ...>`
 * to the part it uses (`personal-best.ts`'s `safeStorage`, the editor's
 * `DraftStorage`): structural typing makes a `Storage` assignable to each.
 * Where there is no `localStorage` at all (node, the unit tests) it is null.
 */
export const safeLocalStorage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * The JSON stored under `key`, or `undefined` when there is nothing USABLE:
 * no store, no key, an empty string, text that is not JSON, or a store whose
 * `getItem` throws. Never throws (reuse audit BE-2).
 *
 * `undefined` is safe as the "nothing" answer because JSON cannot produce it: a
 * stored `null`, `0` or `false` comes back as itself, so a caller that treats
 * a stored `null` differently from an absent key (`loadSettings` does) still
 * can. Each caller keeps its OWN shape check and its own default; this is the
 * try / getItem / empty / parse / catch they all wrote.
 */
export const readJsonKey = (storage: Pick<Storage, 'getItem'> | null, key: string): unknown => {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(key)
    if (!raw) return undefined
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * Store `value` as JSON under `key`. Returns whether it landed; never throws
 * (quota, a private window, a webview with storage off, and a value
 * `JSON.stringify` refuses all answer `false`). Callers that cannot do anything
 * about a failed save ignore the result.
 */
export const writeJsonKey = (
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  value: unknown,
): boolean => {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Is the flag key `'1'`? False for a missing key, no store, or a store that throws. */
export const readFlagKey = (storage: Pick<Storage, 'getItem'> | null, key: string): boolean => {
  if (!storage) return false
  try {
    return storage.getItem(key) === '1'
  } catch {
    return false
  }
}
