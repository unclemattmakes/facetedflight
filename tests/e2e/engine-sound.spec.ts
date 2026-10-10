/**
 * DEV-137 — the engine's rumble reaches the REAL Web Audio graph, and only on
 * the Anniversary preset.
 *
 * Everything about the rumble that can be wrong in arithmetic is unit-tested
 * against a recording backend (`tests/unit/audio-engine-sound.test.ts`). What
 * no node test can see is whether the action list becomes NODES in a browser
 * with an `AudioContext` that a real gesture unlocked — which is the one path a
 * player takes, and the path that turned out pink-skied the first time a human
 * wore this build. So this spec instruments the browser's own `AudioContext`
 * and asks it what oscillators were started.
 *
 * The instrumentation is harness-side only (CLAUDE.md: the GAME must not
 * behave differently). `createOscillator` still builds the same node; the
 * wrapper only remembers the frequency each one was set to. Nothing in `src/`
 * knows it is there.
 *
 * Tagged `@gpu`: the run drives the terrain and the autopilot for real.
 */

import { CUES } from '@/audio/cues'
import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { firstPress } from './fixtures/landing'
import { watchPageErrors } from './fixtures/page-errors'
import { expect, test } from './fixtures/test'

/**
 * The rumble's sub, as the CATALOGUE defines it: the sine layer's authored Hz
 * times the cue's half-thruster pitch. Read rather than typed, so this spec
 * asserts "the browser started the voice the catalogue describes" and not
 * "47" — if the recipe is retuned the spec follows it.
 */
const rumble = CUES['engine.rumble']
const sub = rumble.layers.find((l) => l.kind === 'tone' && l.wave === 'sine')
if (!sub) throw new Error('engine.rumble has no sine sub layer')
const SUB_HZ = sub.startHz * rumble.pitch

/** How close a started oscillator has to be to count as the sub. */
const TOLERANCE_HZ = 0.5

/** Held for a few frames — the confirm input is a level, read once a frame. */
const confirmPress = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.keyboard.down('Enter')
  await page.waitForTimeout(200)
  await page.keyboard.up('Enter')
}

/**
 * Remember every frequency an oscillator is set to, before the app loads.
 * `setValueAtTime` is how `webaudio.ts` writes a tone's pitch (`buildLayer`),
 * so the recorded list is the authored Hz of every tone layer ever started.
 */
const instrumentOscillators = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.addInitScript(() => {
    const w = globalThis as unknown as {
      __ff2Osc: number[]
      AudioContext?: { prototype: { createOscillator: () => OscillatorNode } }
    }
    w.__ff2Osc = []
    const proto = w.AudioContext?.prototype
    if (!proto) return
    const original = proto.createOscillator
    proto.createOscillator = function (this: AudioContext) {
      const osc = original.call(this)
      const param = osc.frequency
      const set = param.setValueAtTime.bind(param)
      param.setValueAtTime = (value: number, when: number) => {
        w.__ff2Osc.push(value)
        return set(value, when)
      }
      return osc
    }
  })
}

const startedHz = async (page: import('@playwright/test').Page): Promise<number[]> =>
  page.evaluate(() => (globalThis as unknown as { __ff2Osc: number[] }).__ff2Osc)

const nearSub = (hz: number[]): number[] => hz.filter((f) => Math.abs(f - SUB_HZ) < TOLERANCE_HZ)

/**
 * Boot the autopilot on `edition`, unlock the audio with a real key press, and
 * fly until the ship has been released for a few seconds.
 */
const flyFor = async (page: import('@playwright/test').Page, edition: string): Promise<void> => {
  await page.goto(`/?autopilot=1&xr=off&edition=${edition}`)
  await firstPress(page)
  await missionReady(page, 180_000)
  await focusCanvas(page)
  // The gesture. `app.ts` calls `audio.resume()` on the confirm edge and then
  // writes `data-audio`; a keyboard press is a user activation in Chrome, so
  // this is the same unlock a player performs.
  await confirmPress(page)
  await expect(page.locator('body')).toHaveAttribute('data-audio', 'running', {
    timeout: 20_000,
  })
  // Wait for release — the idle bed and the rumble start on that tick — and a
  // few seconds of flight so the burner has lit at least once.
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as Ff2GlobalMaybe
      return w.__ff2?.launch().phase === 'flying'
    },
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(4_000)
}

test.describe('@gpu the engine rumble in the real graph', () => {
  test.setTimeout(600_000)

  test('anniversary starts an oscillator at the rumble sub, classic never does', async ({
    page,
  }) => {
    const problems = watchPageErrors(page)
    await instrumentOscillators(page)

    await flyFor(page, 'anniversary')
    const anniversary = await startedHz(page)
    // Something was started at all — otherwise the assertion below is vacuous.
    expect(anniversary.length).toBeGreaterThan(0)
    expect(
      nearSub(anniversary),
      `no oscillator within ${TOLERANCE_HZ} Hz of the ${SUB_HZ} Hz sub among ${anniversary.length} started`,
    ).not.toEqual([])

    // Same page, same instrumentation, the other preset. A fresh navigation
    // runs the init script again and empties the list. DEV-452 (D35): sound
    // is not a visual, so a player's Classic LOOK hears Anniversary's engine;
    // 2016's is the development switch's `?rules=classic`.
    await flyFor(page, 'classic&rules=classic')
    const classic = await startedHz(page)
    expect(classic.length).toBeGreaterThan(0)
    expect(nearSub(classic), 'classic must not start the rumble sub').toEqual([])

    expect(problems.list(), problems.list().join('\n')).toEqual([])
  })
})
