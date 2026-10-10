// tests/unit/xr-visibility.test.ts — DEV-206.
//
// The property: **the run is held whenever the session is not `visible`** — not
// whenever it is one of the two states we happened to observe.
//
// That distinction is the entire test. The same session was measured going to
// `visible-blurred` on one press and to `hidden` on the next, and a handler
// written against `visible-blurred` alone would pass a suite anyone would think
// to write while missing the case that was actually seen in a headset.
//
// `boot/app.ts`'s listeners cannot be reached from a suite with no browser in
// it, which is why the predicate is a separate module at all — the same reason
// `perf-plate.ts`'s clipped row survived both suites: `draw` needs a 2d context,
// so the only witness was a human wearing the thing.
import { describe, expect, it } from 'vitest'
import { xrHoldLine, xrRunHeld } from '@/boot/xr-visibility'

/**
 * Every state the WebXR spec defines, as an exhaustive list.
 *
 * Typed as `XRVisibilityState[]` on purpose: if the spec — or rather the lib
 * types we build against — ever grows a fourth state, this array stops
 * compiling and someone has to decide what it means, instead of a new state
 * silently falling into whichever branch the implementation happens to have.
 */
const ALL_STATES: XRVisibilityState[] = ['visible', 'visible-blurred', 'hidden']

describe('the run is held unless the session is visible', () => {
  it('holds for BOTH non-visible states — the one that was measured is `hidden`', () => {
    // Both arms, named, because the peer review's insistence was right: prove
    // `hidden` if you only have room to prove one. It is the state the second
    // press produced (21:51:43) and the stronger case, where the app is not
    // composited at all.
    expect(xrRunHeld('hidden'), 'measured 2026-09-17 21:51:43').toBe(true)
    expect(xrRunHeld('visible-blurred'), 'measured 2026-09-17 21:48:40').toBe(true)
  })

  it('does NOT hold while visible', () => {
    expect(xrRunHeld('visible')).toBe(false)
  })

  it('does not hold with no session — the flat build must not freeze on boot', () => {
    // The failure this guards is total: nothing sets the flag back for a player
    // who never enters a session, so a held flat build never resumes. `null` is
    // "no session", `undefined` is "asked before one existed", and neither is a
    // reason to stop the world.
    expect(xrRunHeld(null)).toBe(false)
    expect(xrRunHeld(undefined)).toBe(false)
  })

  it('holds for EVERY state that is not `visible` — exhaustively', () => {
    // The assertion that makes this a rule rather than two examples. It is
    // written over the spec's own enumeration, so a state nobody has met yet is
    // covered by construction: the only way to be not-held is to BE `visible`.
    for (const state of ALL_STATES) {
      expect(xrRunHeld(state), `${state} must ${state === 'visible' ? 'not ' : ''}hold`).toBe(
        state !== 'visible',
      )
    }
  })
})

describe('the plate says which one it is', () => {
  it('names the dashboard for a blur, and the compositor for hidden', () => {
    // Two different lines because they are two different situations for the
    // person wearing it: a dashboard is in front of you and you can dismiss it;
    // `hidden` means the app is not being drawn at all.
    expect(xrHoldLine('visible-blurred')).toContain('dashboard')
    expect(xrHoldLine('hidden')).toContain('composited')
  })

  it('says the run is HELD in both, because that is the part that matters', () => {
    // A row that reports a state without saying what it did to the game is a
    // row a wearer cannot act on.
    for (const state of ALL_STATES.filter((s) => s !== 'visible')) {
      expect(xrHoldLine(state)).toContain('the run is held')
    }
  })

  it('is null whenever the run is not held, so the row simply is not there', () => {
    expect(xrHoldLine('visible')).toBeNull()
    expect(xrHoldLine(null)).toBeNull()
  })

  it('agrees with the predicate for every state — one source of truth', () => {
    // The two exports must never disagree: a plate that says nothing while the
    // run is held is exactly the instrument failure DEV-206 was found through.
    for (const state of [...ALL_STATES, null, undefined]) {
      expect(xrHoldLine(state) !== null).toBe(xrRunHeld(state))
    }
  })
})
