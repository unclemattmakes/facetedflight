// tests/unit/xr-lifecycle-listeners.test.ts — DEV-206.
//
// **Two states the app can enter, and had no listener for.** Both defects were
// ABSENCES, and an absence is the one thing a behavioural test cannot catch:
// there is nothing to call, nothing throws, and every existing suite stays
// green. `grep` is the honest instrument for it — the same reason
// `shader-prefix-duplicates.test.ts` scans source rather than rendering.
//
//   1. `webglcontextlost`. Before DEV-206, `grep -rn "webglcontextlost|
//      isContextLost|loseContext" src/` returned NOTHING. A lost context stops
//      rendering with no exception, no visibility change and no thrown frame.
//      It was measured `false` during the 2026-09-17 blur, so it is not what
//      happened that night — it is a live possibility on a GPU at 98 % of
//      budget, and it must not be diagnosed a second time from scratch.
//
//   2. The boot card (gone since DEV-557; see the describe below). `main.ts` set `hidden`, `.leaving` and `display: none`
//      when the session starts, and **nothing in the codebase ever put them
//      back**. SteamVR ends a session from its own side — measured 21:49:43,
//      three seconds after a dashboard blur cleared — leaving the Enter VR
//      button present, enabled and unreachable, with the game running flat
//      behind a card that had gone. The only way back was a page reload, which
//      costs a full terrain generation spent sitting in a headset looking at
//      nothing. Matt reloaded four times in one evening; every one of them was
//      read as impatience.
//
// These assert the LISTENER EXISTS AND IS REACHED, not what it does — what it
// does is `boot/xr-visibility.ts`'s job and is unit tested properly there.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appFileWith, appSource } from './helpers/app-source'
import { listTsWithDts } from './helpers/source-tree'

const SRC = path.join(process.cwd(), 'src')

/** Every `.ts` under `src/`, recursively. */
const allSources = (): { file: string; text: string }[] =>
  listTsWithDts(SRC).map((full) => ({
    file: path.relative(SRC, full),
    text: fs.readFileSync(full, 'utf8'),
  }))

/** Lines that are not comments — a mention in prose is not a listener. */
const codeLines = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))

describe('a lost WebGL context is noticed', () => {
  it('somewhere under src/ actually listens for it', () => {
    // The whole defect was that this returned nothing. Matched on CODE lines so
    // that deleting the listener and leaving the comment cannot pass.
    const listeners = allSources().filter(({ text }) =>
      codeLines(text).some((l) => l.includes("'webglcontextlost'")),
    )
    expect(
      listeners.map((l) => l.file),
      'nothing in src/ can see a lost context: it stops rendering with no exception, ' +
        'no visibility change and no thrown frame',
    ).not.toEqual([])
  })

  it('calls preventDefault, without which a restore can never fire', () => {
    // Not decoration: the browser will not fire `webglcontextrestored` unless
    // the lost event was cancelled. A listener that only logs forecloses any
    // future recovery, and would look correct forever.
    const app = appFileWith("'webglcontextlost'").text
    const at = app.indexOf("'webglcontextlost'")
    expect(at, 'no webglcontextlost listener in boot/app').toBeGreaterThan(-1)
    // Inside the handler body, not merely somewhere in an 8,000-line file.
    expect(app.slice(at, at + 400)).toContain('preventDefault()')
  })
})

describe('a session the runtime ended still has a way back in (DEV-206, DEV-557)', () => {
  // Until DEV-557 the way back was the landing card, which `main.ts` put back
  // on `sessionend`. The card is gone (Matt, 2026-10-01: "let's get rid of the
  // html curtain"), so the way back is IN the game: the title's ENTER VR plate,
  // and from anywhere else the pause plate's ENTER VR row while a page that
  // has a headset is flat. These pin the structure, not the behaviour: an
  // absence is what this file exists to catch.
  const app = (): string => appFileWith("id: 'entervr'").text

  it('the pause plate offers ENTER VR, flat, where a headset is there', () => {
    const text = app()
    const at = text.indexOf("id: 'entervr'")
    expect(at, 'no ENTER VR pause row').toBeGreaterThan(-1)
    // It is the other arm of EXIT VR's `isPresenting` ternary, gated on the
    // headset being there, so it is never a row that cannot act.
    const before = text.slice(Math.max(0, at - 1500), at)
    expect(before).toContain('render.renderer.xr.isPresenting')
    expect(before).toContain('titleVr.supported')
  })

  it('and pressing it asks for a session through the one door', () => {
    // APP-SPLIT 4.6d: the row is the plate's (`boot/app/hangar/menus.ts`) and
    // the press is the frame's confirm dispatch, so this reads the frame's file.
    const text = appFileWith("chosen === 'entervr'").text
    const at = text.indexOf("chosen === 'entervr'")
    expect(at, 'nothing handles the ENTER VR row').toBeGreaterThan(-1)
    expect(text.slice(at, at + 400)).toContain('titleVr.press()')
  })

  it('requestSession has ONE caller in src/, the one the plate and the row share', () => {
    const callers = allSources().filter(({ text }) =>
      codeLines(text).some((l) => l.includes("requestSession('immersive-vr'")),
    )
    expect(callers.map((c) => c.file.split(path.sep).join('/'))).toEqual(['boot/enter-vr.ts'])
  })
})

describe('the hold predicate has ONE home', () => {
  it('app.ts does not carry its own copy of the visibility comparison', () => {
    // The drift this prevents is specific and has happened here before with
    // `material.fog` (DEV-194): two places deciding the same thing, one of them
    // updated. The plate's row and the pause it describes must be the same
    // predicate, or the instrument can say "held" while the run is not, which
    // is worse than no row at all.
    const app = appSource()
    const inline = codeLines(app).filter(
      (l) => l.includes('visibilityState') && l.includes("'visible'"),
    )
    expect(
      inline,
      'use xrRunHeld / xrHoldLine from boot/xr-visibility.ts rather than comparing here',
    ).toEqual([])
  })
})
