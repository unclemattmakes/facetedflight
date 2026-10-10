// tests/unit/xr-select.test.ts — the one button a WebXR session is promised.
//
// DEV-205. `input/xr.ts` commits the hangar on right-hand `xr-standard` button
// **4**, and the spec requires only `buttons[0]`: indices >= 4 are not reserved
// at all, and `pressed()` answers `false` for an index that is not there
// without saying so. `XRSession`'s `select` fires on every device whatever the
// profile, so the trigger commits as well — additively, leaving button 4
// exactly where it was.
//
// It is defence against profiles we have not met, NOT the cure for the one we
// have: measured in the Frame, both hands report seven button slots (six
// pressable), so index 4 is present on the hardware in the room. The row says
// so; so does this.
//
// There is no headless WebXR worth maintaining (CLAUDE.md), so the session is a
// FAKE: a structural `XrSelectSource` the latch can follow and a test can fire.
// Same pattern as `xr-head-pose.test.ts`'s rig — the only way to test a path a
// browser here cannot reach is to be able to hand one in.
//
// The three claims, which are the three ways this can be got wrong:
//
//   §1 WHERE it may commit — which is not this feature's question to answer.
//      `input/confirm.ts` owns the confirm handler's branch list, and §1 reads
//      the handler's own `if/else if` chain out of `app.ts` and fails if the
//      two orders part company. That is an ORACLE; the first draft of this
//      section was a third copy of the list asserted against itself.
//   §2 EXACTLY ONCE. An event latched and never cleared confirms for ever; one
//      cleared before anyone looks is a button that does nothing.
//   §3 that `app.ts` still spends the latch every frame, which an `||` would
//      quietly stop doing.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONFIRM_LABEL,
  type ConfirmMeaning,
  type ConfirmState,
  confirmArmed,
  confirmLabel,
  confirmMeans,
} from '@/input/confirm'
import { XR_BUTTON } from '@/input/xr'
import { createXrSelectLatch, type XrSelectSource } from '@/input/xr-select'
import { appFileThroughWith, appSourceThroughCtx } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

/**
 * A fake `XRSession`, and the only thing this file knows about WebXR.
 *
 * `listeners` is exposed so the leak question — *does following the same
 * session at 90 Hz add a listener a frame?* — is a thing a test can ask rather
 * than a thing the implementation promises in a comment.
 */
const fakeSession = () => {
  const listeners = new Set<(event: unknown) => void>()
  const session: XrSelectSource & {
    readonly listenerCount: number
    fire(handedness?: string): void
  } = {
    addEventListener(type, listener) {
      if (type === 'select') listeners.add(listener as (event: unknown) => void)
    },
    removeEventListener(type, listener) {
      if (type === 'select') listeners.delete(listener as (event: unknown) => void)
    },
    get listenerCount() {
      return listeners.size
    },
    fire(handedness = 'right') {
      for (const listener of [...listeners]) listener({ inputSource: { handedness } })
    },
  }
  return session
}

/** The live state, with the "boarded, on the pad" case as the base. */
const state = (over: Partial<ConfirmState> = {}): ConfirmState => ({
  worldLoaded: true,
  screen: 'mission',
  paused: false,
  finished: false,
  launchPhase: 'waiting',
  ...over,
})

describe('§1 the arming agrees with the confirm handler, branch for branch', () => {
  // The handler is SLICED between two anchors, so it is read out of the ONE
  // file that holds it (APP-SPLIT phase 0).
  const handlerFile = (): string =>
    appFileThroughWith("if (confirmPressed && (flight || screen !== 'mission')) {").text

  it('mirrors the handler chain in app.ts, in its order', () => {
    // THE oracle, and the guard `touchConfirmLabel`'s comment has been asking
    // for since it was written: *"these branches are the confirm handler's
    // branches, IN ITS ORDER, and they have to stay that way"*, with nothing
    // but an e2e spec able to notice. This reads the handler's own chain out of
    // the file and compares it to the list `input/confirm.ts` tests, in order.
    //
    // ORDER, not just membership: `paused` after `screen` because a paused
    // mission is still `screen === 'mission'`, and `finished` before the launch
    // because after a run A means "again". Swap any two and every assertion
    // below still passes while the game confirms the wrong thing.
    const src = handlerFile()
    const open = src.indexOf("if (confirmPressed && (flight || screen !== 'mission')) {")
    expect(open, 'the confirm handler').toBeGreaterThan(-1)
    // The handler is a four-space `if`, so its own closing brace is the first
    // line that is exactly four spaces and a brace (everything inside sits deeper).
    const close = src.indexOf('\n    }\n', open)
    expect(close, 'the end of the handler').toBeGreaterThan(open)
    const body = src
      .slice(open, close)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // Only the handler's OWN branches: six spaces of indent. Anything nested
    // inside one of them sits deeper and is somebody else's decision.
    const chain = [...body.matchAll(/^ {6}(?:\} else )?if \((.+?)\) \{$/gm)].map((m) => m[1])
    expect(chain, 'the handler, in its order').toEqual([
      "screen === 'title'",
      "screen === 'menu'",
      'paused',
      'lastResult',
    ])
    // And a terminal `else`, which is the launch. Without it the fifth branch
    // would be an `if` this test never saw and `confirmMeans` invents.
    expect(/^ {6}\} else \{$/m.test(body), 'a terminal else — the launch').toBe(true)
    // The condition `confirmMeans` uses for that terminal branch is not in the
    // handler at all; it is inside `beginLaunch`, and this is what makes
    // `'waiting'` a fact rather than an approximation of one.
    expect(appSourceThroughCtx()).toContain("if (launch.phase !== 'waiting') return")
  })

  it('names every branch, and nothing else', () => {
    // The same five, from the other side. `worldLoaded` is the handler's own
    // outer gate, which since DEV-281 is `flight || screen !== 'mission'` — so
    // the two screens that exist to REACH a mission still confirm without one,
    // and the mission screen still does not.
    const table: [string, ConfirmState, ConfirmMeaning | null][] = [
      ['no world, on the mission screen', state({ worldLoaded: false }), null],
      ['no world, on the title screen', state({ worldLoaded: false, screen: 'title' }), 'start'],
      ['no world, in the hangar', state({ worldLoaded: false, screen: 'menu' }), 'select'],
      ['title', state({ screen: 'title' }), 'start'],
      ['the hangar', state({ screen: 'menu' }), 'select'],
      ['paused', state({ paused: true }), 'select'],
      ['a finished run (DEV-406: A goes home)', state({ finished: true }), 'hangar'],
      ['on the pad', state({ launchPhase: 'waiting' }), 'launch'],
      ['rising', state({ launchPhase: 'rising' }), null],
      ['flying', state({ launchPhase: 'flying' }), null],
    ]
    for (const [name, s, want] of table) expect(confirmMeans(s), name).toBe(want)
  })

  it('arms the LAUNCH PAD and the results plate, which the first cut did not', () => {
    // The correction, and the whole reason the third list was refused. DEV-205
    // shipped for an afternoon armed on *title, hangar, pause plate* only,
    // because the trigger is also the throttle and arming the pad looked like
    // putting `beginLaunch()` on it. It is not: while the prompt says "Press A
    // to launch" the ship is HELD, so on a controller with no button 4 that was
    // a mission you could pick and never start.
    expect(confirmArmed(state({ launchPhase: 'waiting' })), 'the pad').toBe(true)
    expect(confirmArmed(state({ finished: true })), 'the results plate').toBe(true)
  })

  it('does NOT arm a ship in the air, where the trigger is the throttle', () => {
    // The case the first cut was protecting, and the only one that needed it.
    // `input/xr.ts` puts the throttle on right button 0 and `select` is the
    // runtime's primary action for the same trigger, so an armed flight would
    // confirm on every throttle pull — `app.ts`'s own *"one control with two
    // meanings is a ship that rolls when you glance left"*.
    expect(confirmArmed(state({ launchPhase: 'flying' }))).toBe(false)
    expect(confirmArmed(state({ launchPhase: 'rising' })), 'and on the way up').toBe(false)
  })

  it('formats the same decision it arms on', () => {
    // One decision, two readers. If these could ever disagree, the touch chip
    // would name a branch the XR trigger does not fire, or the other way round.
    for (const s of [
      state({ worldLoaded: false }),
      state({ screen: 'title' }),
      state({ screen: 'menu' }),
      state({ paused: true }),
      state({ finished: true }),
      state({ launchPhase: 'waiting' }),
      state({ launchPhase: 'flying' }),
    ]) {
      expect(confirmLabel(s) !== null, JSON.stringify(s)).toBe(confirmArmed(s))
    }
    // Every meaning has a word — a missing entry would render `undefined` on
    // the chip rather than fail anywhere.
    for (const m of ['start', 'select', 'hangar', 'launch'] as const) {
      expect(CONFIRM_LABEL[m], m).toMatch(/^[A-Z]+$/)
    }
  })

  it('does not derive the arming from the LABEL', () => {
    // A function whose job is to produce a WORD, read for a BOOLEAN, is the
    // next drift: the day somebody wants the chip blank on a screen that still
    // confirms, the label goes null and the XR trigger goes dead with it,
    // silently, in a headset. So `confirmArmed` is defined on `confirmMeans`.
    const src = fs
      .readFileSync(path.join(ROOT, 'src/input/confirm.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const line = src.match(/^export const confirmArmed[\s\S]*?$/m)?.[0] ?? ''
    expect(line, 'confirmArmed exists').not.toBe('')
    expect(line).toContain('confirmMeans(')
    expect(line.includes('confirmLabel'), 'and not via the label').toBe(false)
  })
})

describe('§2 the latch — exactly once, and never later', () => {
  it('reports a select for one frame and not the next', () => {
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)

    expect(latch.take(true), 'before anything happened').toBe(false)
    session.fire()
    expect(latch.take(true), 'the frame after the select').toBe(true)
    expect(latch.take(true), 'and the frame after that').toBe(false)
  })

  it('cannot be missed the way a LEVEL can', () => {
    // The reason this is a latch and not a poll. `xr.confirm` is
    // `buttons[4].pressed` sampled once a frame: a pull and a release inside
    // one 11 ms frame is never seen. A latch survives to the next `take`.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)
    // Fired and "released" entirely between two frames.
    session.fire()
    expect(latch.take(true)).toBe(true)
  })

  it('coalesces two selects in one frame into one commit', () => {
    // Deliberate, not incidental. Two primary actions inside one 11 ms frame is
    // not a double tap anybody performed, and a menu that boards twice from it
    // would act on the second press against a screen the first one changed.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)
    session.fire()
    session.fire()
    expect(latch.take(true), 'one commit').toBe(true)
    expect(latch.take(true), 'not two').toBe(false)
  })

  it('SPENDS the latch even when it is not armed', () => {
    // The throttle case, and the whole reason `take` takes the flag rather than
    // the caller skipping the call. A trigger pull in flight that merely sat in
    // the latch would be delivered the instant somebody opened the pause plate
    // — a menu that commits a row you never chose.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)
    session.fire()
    expect(latch.take(false), 'in flight: not a commit').toBe(false)
    expect(latch.take(true), 'and it does not survive into the pause plate').toBe(false)
  })

  it('answers false with no session at all', () => {
    const latch = createXrSelectLatch()
    expect(latch.take(true), 'flat, never followed').toBe(false)
    latch.follow(null)
    expect(latch.take(true), 'and after following nothing').toBe(false)
  })
})

describe('§2b following the live session, once a frame, for hours', () => {
  it('adds ONE listener however many times it follows the same session', () => {
    // `follow` is called every frame at 90 Hz. A fresh closure per call, or an
    // `addEventListener` without the identity check, is one listener a frame —
    // and then one `select` would latch 40,000 times, which is harmless, and
    // leak, which is not.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    for (let i = 0; i < 500; i++) latch.follow(session)
    expect(session.listenerCount).toBe(1)
  })

  it('detaches when the session ends, and drops what it was holding', () => {
    // Leaving VR with the trigger half-pulled must not commit something on the
    // flat screen a moment later. `touch-overlay.ts` makes the same argument
    // about a control that has been taken away: it must not still press itself.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)
    session.fire()
    latch.follow(null)
    expect(session.listenerCount, 'listener removed').toBe(0)
    expect(latch.take(true), 'and the pending select went with it').toBe(false)
    session.fire()
    expect(latch.take(true), 'a dead session cannot latch').toBe(false)
  })

  it('moves cleanly from one session to the next', () => {
    // Enter VR, leave, enter again — which is what an evening of headset
    // testing is. The old session must be let go of and must not be able to
    // reach into the new one.
    const latch = createXrSelectLatch()
    const first = fakeSession()
    const second = fakeSession()
    latch.follow(first)
    latch.follow(second)
    expect(first.listenerCount, 'the old one is released').toBe(0)
    expect(second.listenerCount, 'and the new one is held once').toBe(1)
    first.fire()
    expect(latch.take(true), 'the old session is inert').toBe(false)
    second.fire()
    expect(latch.take(true), 'the new one commits').toBe(true)
  })

  it('goes inert on dispose', () => {
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)
    latch.dispose()
    expect(session.listenerCount).toBe(0)
    session.fire()
    expect(latch.take(true)).toBe(false)
  })

  it('commits from either hand, and from a source with no hand at all', () => {
    // Not gated on handedness on purpose — see the file header. A device with
    // one controller, a pinch, or a transient pointer (Apple Vision Pro
    // supports `immersive-vr` and has no thumbsticks) would otherwise be back
    // to a commit that silently never fires, which is the bug being fixed.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)
    for (const hand of ['left', 'right', 'none', '']) {
      session.fire(hand)
      expect(latch.take(true), `handedness ${hand || 'empty'}`).toBe(true)
    }
  })
})

describe('§2c one select is one action, through the edge detector', () => {
  it('fires the confirm handler once, not once a frame', () => {
    // `app.ts` edge-detects `confirm` against the previous frame's value, and
    // the two lines below are that arrangement — a MODEL of the call site, not
    // the call site, which is why §3 greps for the real thing beside it. What
    // it pins is the composition: a one-frame latch through a rising-edge
    // detector is one action, and neither half proves that alone.
    const latch = createXrSelectLatch()
    const session = fakeSession()
    latch.follow(session)

    let held = false
    let fired = 0
    const frame = (armed: boolean, otherDevice = false): void => {
      const selected = latch.take(armed)
      const confirm = otherDevice || selected
      if (confirm && !held) fired++
      held = confirm
    }

    frame(true)
    expect(fired, 'nothing pressed').toBe(0)
    session.fire()
    for (let i = 0; i < 10; i++) frame(true)
    expect(fired, 'one select, one action, across ten frames').toBe(1)

    // And a second select later is a second action — the latch is not
    // one-shot-for-ever, which a `fired ||= true` that nobody cleared would be.
    session.fire()
    for (let i = 0; i < 10; i++) frame(true)
    expect(fired).toBe(2)

    // A held button-4 press swallows a select that lands inside it, and that is
    // correct: the player is already confirming. It must not double-fire.
    session.fire()
    frame(true, true)
    frame(true, true)
    expect(fired, 'a select inside a held confirm is not a second action').toBe(3)
  })
})

describe('§3 app.ts still spends the latch every frame', () => {
  // The whole boot tree: "exactly one take()" is one in the TREE.
  const app = (): string => appSourceThroughCtx()

  it('binds take() to a name instead of inlining it in the || chain', () => {
    // THE trap. `a || b || latch.take(x) || c` looks identical and is wrong:
    // `||` short-circuits, so on any frame another device already said yes the
    // latch is not spent, and that select is delivered a frame later against
    // whatever screen the first confirm moved to. Inside the `it`, reading the
    // file, because a describe body runs during collection (CLAUDE.md).
    const code = app()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    const calls = [...code.matchAll(/^.*\bxrSelect\.take\s*\(.*$/gm)].map((m) => m[0])
    expect(calls, 'exactly one take() call site').toHaveLength(1)
    const line = calls[0] as string
    expect(line, 'bound to a name').toMatch(/(?:const|let)\s+\w+\s*=\s*xrSelect\.take\s*\(/)
    expect(line.includes('||'), 'and not inside a || chain').toBe(false)
    expect(line.includes('&&'), 'nor behind a &&').toBe(false)
  })

  it('follows the live session and arms off the SHARED predicate', () => {
    // The wiring, so that deleting either half fails here rather than in a
    // headset. `follow` off `getSession()` is what makes the latch track a
    // session that starts, ends and starts again with no second lifecycle.
    //
    // And `confirmArmed(confirmNow())` specifically, not a condition spelled
    // out at the call site: that spelling-out is what made a third copy of the
    // handler's branches, and §1 is only an oracle while both readers go
    // through the one function.
    const code = app()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/xrSelect\.follow\(\s*render\.renderer\.xr\.getSession\(\)\s*\)/)
    expect(code).toMatch(/xrSelect\.take\(\s*confirmArmed\(confirmNow\(\)\)\s*\)/)
    // The touch chip's label is the other reader, through the same state.
    // DEV-607: it shows only the title's START now, still off that state.
    expect(code).toContain('const now = confirmNow()')
    expect(code).toContain("return confirmMeans(now) === 'start' ? confirmLabel(now) : null")
    // And the branch list is nowhere in this file any more.
    expect(code.includes("if (screen === 'title') return"), 'no second branch list').toBe(false)
  })

  it('leaves button 4 exactly where it was', () => {
    // Additive, not a replacement: a controller that DOES report index 4 keeps
    // the binding it has, and nothing that cannot be tested from here loses
    // one. If a later change makes the primary action the only route, this is
    // the test that should have to be deleted on purpose.
    const xr = fs.readFileSync(path.join(ROOT, 'src/input/xr.ts'), 'utf8')
    // Named by the code-reuse audit (IA-5): the name, and the number it names.
    expect(xr).toContain('confirm: buttonDown(right, XR_BUTTON.lower)')
    expect(XR_BUTTON.lower).toBe(4)
    const code = app()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    expect(code).toMatch(/const confirm\s*=\s*\n?\s*xr\.confirm\s*\|\|/)
  })
})
