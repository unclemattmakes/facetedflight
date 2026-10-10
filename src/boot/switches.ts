/**
 * The URL switches the capability gate has to answer, read in ONE place (reuse
 * audit BE-15 / WP-19), and the ones another boot module answers too.
 *
 * `?xr=off` used to be decided in three places (the capability gate and two
 * sites in app.ts) and `?audio=off` in two. This file is the single answer for
 * each, and it is a LEAF on purpose: it imports nothing. `capability-gate.ts`
 * runs before the renderer exists and is reachable from Playwright's collection
 * graph, and `boot/app/pins.ts` imports `three`, the content loaders and
 * `import.meta.glob`: one src import edge from a Playwright-reachable file to
 * that makes the whole suite collect zero tests. So the gate imports THIS, and
 * pins.ts imports this, and neither imports the other.
 *
 * Each reader takes the query to read, so a unit test can hand it a string and
 * the callers that already hold a `URLSearchParams` (pins' `params`) do not
 * parse the query a second time.
 */

type Query = URLSearchParams | string

const toParams = (query: Query): URLSearchParams =>
  typeof query === 'string' ? new URLSearchParams(query) : query

/** The page's own query string, safe where there is no `location` (node, a worker). */
const currentQuery = (): string => globalThis.location?.search ?? ''

/**
 * `?xr=off`: answer "no headset" without asking the platform.
 *
 * `isSessionSupported('immersive-vr')` is not a passive query: it starts the
 * machine's OpenXR runtime (on a SteamVR box, every page load launches Steam).
 * The screenshot and gameplay specs pass this so they never do; the specs that
 * exist to test the probe do not.
 */
export const xrProbeOff = (query: Query = currentQuery()): boolean =>
  toParams(query).get('xr') === 'off'

/**
 * `?audio=off`: boot the audio system on the silent backend, so no audio
 * device is opened. A guarantee a spec can lean on; it never touches the stored
 * volume.
 */
export const audioOff = (query: Query = currentQuery()): boolean =>
  toParams(query).get('audio') === 'off'

/**
 * `?touch=1` / `?touch=0`: answer the touchscreen question by hand. Null when
 * the page says nothing (the capability gate then asks the platform); any value
 * but `0` means touch. What it is for, and why no spec may use it to reach
 * behaviour a phone could not, is written at its one caller, `capability-gate.ts`.
 */
export const touchOverride = (query: Query = currentQuery()): boolean | null => {
  const value = toParams(query).get('touch')
  if (value === null) return null
  return value !== '0'
}
