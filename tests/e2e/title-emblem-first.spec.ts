/**
 * The emblem first, lit on black, and the valley fading in behind it. DEV-352.
 *
 * Matt, 2026-09-24: *"first frame - would it be possible to load and light the
 * logo first? then fade in the bg?"* Until this row a cold load showed a black
 * page and *"Loading Alpine Forest… 0%"* for ~6.5 s, because `buildTitleWorld`
 * awaited the valley's terrain and only then loaded `title-logo.glb`.
 *
 * What this pins is an ORDER, sampled off the live scene from the first frame:
 *
 *   1. the emblem is in the drawn scene strictly before the valley is;
 *   2. there is a moment when the emblem is on screen — the boot fade already
 *      lifting — while the valley's curtain is still solid;
 *   3. the valley then lands and the curtain lifts, on its own, with nobody
 *      having pressed anything;
 *   4. the frame the emblem was placed through before the valley existed is
 *      the valley's own (`data-title-frame-drift`, `boot/app.ts`).
 *
 * Against the tree before this row, 1 fails: the valley is added to the scene
 * before the emblem's GLB is even requested. The unit half — the sort order,
 * the blend, the schedule, and the premise that the curtain is not a UI object
 * — is `tests/unit/title-curtain.test.ts`; what that cannot see is the order in
 * which a real boot fills the scene, which is this.
 *
 * Polled on a 100 ms loop from `goto`, sequentially rather than on a timer, so a
 * sample cannot arrive after the assertion that reads it (`fade.spec.ts`).
 */
import { expect, test } from './fixtures/test'

interface Sample {
  readonly t: number
  readonly logo: boolean
  readonly valley: boolean
  readonly curtain: string | null
  readonly fade: number | null
  readonly ready: boolean
  readonly drift: string | null
}

test.describe('@gpu the emblem first, then the valley (DEV-352)', () => {
  test.setTimeout(240_000)

  test('lights the emblem on black before the valley, then fades the valley in behind it', async ({
    page,
  }) => {
    await page.goto('/?xr=off')
    const t0 = Date.now()
    const samples: Sample[] = []
    let settledAt: number | null = null
    while (Date.now() - t0 < 180_000) {
      const s = await page.evaluate(() => {
        const app = (
          globalThis as unknown as {
            __ff2?: {
              stage: () => { traverse: (f: (o: { name?: string }) => void) => void }
              fade: () => { amount: number }
            }
          }
        ).__ff2
        let logo = false
        let valley = false
        app?.stage().traverse((o) => {
          if (o.name === 'title-logo') logo = true
          if (o.name === 'title-valley') valley = true
        })
        const body = document.body.dataset
        return {
          logo,
          valley,
          curtain: body.titleCurtain ?? null,
          fade: app ? app.fade().amount : null,
          ready: body.titleReady === 'true',
          drift: body.titleFrameDrift ?? null,
        }
      })
      samples.push({ t: Date.now() - t0, ...s })
      if (s.ready && settledAt === null) settledAt = Date.now()
      // Past ready, keep sampling until the curtain has gone, or 10 s.
      if (settledAt !== null && (s.curtain === 'gone' || Date.now() - settledAt > 10_000)) break
      await page.waitForTimeout(100)
    }
    const line = samples
      .filter(
        (s, i) =>
          i === 0 || JSON.stringify({ ...s, t: 0 }) !== JSON.stringify({ ...samples[i - 1], t: 0 }),
      )
      .map(
        (s) =>
          `${s.t}ms logo=${s.logo} valley=${s.valley} curtain=${s.curtain} fade=${s.fade?.toFixed(2)} ready=${s.ready}`,
      )
      .join('\n')
    console.info(`title-emblem-first: state changes —\n${line}`)

    const firstLogo = samples.find((s) => s.logo)
    const firstValley = samples.find((s) => s.valley)
    expect(firstLogo, 'the emblem reached the scene').toBeDefined()
    expect(firstValley, 'the valley reached the scene').toBeDefined()
    // 1. The emblem is FIRST — not merely on the same sample as the valley.
    expect(
      firstLogo?.t ?? Number.POSITIVE_INFINITY,
      'the emblem arrives before the valley',
    ).toBeLessThan(firstValley?.t ?? 0)
    // 2. Seen on black: the boot fade has let go while the valley's curtain holds.
    expect(
      samples.some((s) => s.logo && s.curtain === 'held' && s.fade !== null && s.fade < 1),
      'a frame with the emblem showing and the valley still curtained',
    ).toBe(true)
    // 3. And the valley came in behind it, unprompted.
    const last = samples[samples.length - 1]
    expect(last?.ready, 'the title world finished').toBe(true)
    expect(last?.curtain, 'the curtain lifted by itself').toBe('gone')
    expect(last?.fade, 'the boot fade is clear').toBe(0)
    // 4. The stand-in frame and the valley's own agree.
    expect(
      Number(last?.drift ?? Number.NaN),
      'emblem placed through the valley frame',
    ).toBeLessThan(1e-6)
  })
})
