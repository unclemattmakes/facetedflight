/**
 * tests/e2e/prop-break-programs.spec.ts — a break compiles nothing. DEV-177(a).
 *
 * ── The stall this gates ─────────────────────────────────────────────────
 *
 * Flat `int_01` under the autopilot, `renderer.info.programs` polled every
 * 100 ms with the FULL `cacheKey` of anything added:
 *
 *     t=45.35  FRACTURE live 0 -> 6   programs 101 -> 102
 *     t=46.73  FRACTURE live 6 -> 0   programs 102 -> 101
 *
 * A program that lives exactly as long as a fracture. `prop-fracture.ts` drew
 * its pieces with `material.clone()`, and `Material.copy` carries neither
 * `onBeforeCompile` nor `customProgramCacheKey` — so the clone came out with
 * three's empty prototype callback, no Unity fog, no far-field sun term, and a
 * key of its own. The first break of every run compiled a shader in the seat,
 * and the worn lap paid 156 / 122 ms for it at the same place every lap.
 *
 * ── What is asserted, and what is not ────────────────────────────────────
 *
 * A COUNT, never a millisecond. `renderer.info.programs.length` is a mechanism:
 * it is the same number on a busy GPU and an idle one, on this laptop and on a
 * runner, which is exactly why the house style prefers a mechanism gate
 * (`docs/testing/perf-protocol.md`). A spec that asserted "the break frame is
 * under N ms" would be measuring the machine.
 *
 * The sampling runs INSIDE the page rather than as a Playwright poll, because
 * the thing being watched appears and disappears together with the pieces: a
 * round trip per sample would step over it. The loop also records the fracture
 * liveness from `__ff2.fracture()`, so the break is NAMED by the count that
 * changed rather than inferred from when a console line arrived.
 *
 * ── And the burst (DEV-428) ──────────────────────────────────────────────
 *
 * The preset keeps a struck tree standing and throws a burst in its own
 * colours instead of the fracture. That burst is a PAPER particle field — a
 * program of its own — so the same question applies to it: does the first
 * strike compile in the seat? The sampler's `live` counts the burst's pieces
 * beside the fracture's, so an edge of either is a prop hit appearing or going
 * away, and the two assertions below hold both to the same bar.
 *
 * ── The loud counterpart ─────────────────────────────────────────────────
 *
 * A "nothing changed" assertion over a window with no break in it passes for
 * ever. So the spec fails if it never saw a break, and says so — the route is
 * then the finding, the way `prop-break.spec.ts` says it.
 *
 *   BREAK_MISSION=int_01_hoverJet E2E_PORT=<yours> \
 *     pnpm exec playwright test tests/e2e/prop-break-programs.spec.ts
 *
 * Alpine by default: the autopilot flies 2016's racing line through a forest
 * the scatter never cleared, so the PLAYER breaks trees within a minute and
 * keeps breaking them. `int_01_hoverJet` reproduces the original measurement —
 * a racer clipping palm#840 at ~85 m/s — and takes about 45 s of flight to
 * reach it.
 *
 * `@gpu`: hydrated assets, a real compiler, headed Chrome.
 */

import { missionReady } from './fixtures/boot'
import { focusCanvas } from './fixtures/canvas'
import { hold } from './fixtures/freeze'
import { knownRed } from './fixtures/known-red'
import { firstPress } from './fixtures/landing'
import { expect, test } from './fixtures/test'

const MISSION = process.env.BREAK_MISSION ?? 'rookie_01_hoverJet'
/** Seconds of flight to watch. Long enough for at least one break on either course. */
const SECONDS = Number(process.env.BREAK_PROGRAM_SECONDS ?? '110')

interface Sample {
  readonly t: number
  readonly programs: number
  readonly live: number
}

test.describe('@gpu DEV-177(a): breaking a prop compiles no shader', () => {
  test.setTimeout(600_000)

  test(`${MISSION}: the program count does not move across a fracture`, async ({ page }) => {
    knownRed('KR-04', MISSION === 'rookie_01_hoverJet')
    await page.goto(`/?mission=${MISSION}&autopilot=1&xr=off&edition=anniversary`)
    await firstPress(page)
    await missionReady(page, 240_000)
    await focusCanvas(page)
    await hold(page, 'Enter')

    const samples: Sample[] = await page.evaluate(async (seconds: number) => {
      interface Handle {
        readonly render: {
          readonly renderer: { readonly info: { readonly programs: { length: number } | null } }
        }
        fracture(): { live: number } | null
        propStrike?(): { alive: number } | null
      }
      const h = (globalThis as unknown as { __ff2: Handle }).__ff2
      const out: { t: number; programs: number; live: number }[] = []
      const t0 = performance.now()
      const sleep = (ms: number): Promise<void> =>
        new Promise((r) => {
          setTimeout(r, ms)
        })
      while (performance.now() - t0 < seconds * 1000) {
        out.push({
          t: (performance.now() - t0) / 1000,
          programs: h.render.renderer.info.programs?.length ?? -1,
          // DEV-428: the preset's struck tree STANDS and bursts rather than
          // fracturing, so a prop hit in the air is the pieces OR the burst —
          // and the burst's paper program must not compile in the seat either.
          live: (h.fracture()?.live ?? -1) + (h.propStrike?.()?.alive ?? 0),
        })
        await sleep(50)
      }
      return out
    }, SECONDS)

    expect(samples.length, 'the page sampled nothing').toBeGreaterThan(100)
    expect(
      samples.every((s) => s.programs > 0),
      '`renderer.info.programs` is null — three stopped reporting them',
    ).toBe(true)
    expect(
      samples.every((s) => s.live >= 0),
      '`__ff2.fracture()` was null for the whole window — no fracture was built',
    ).toBe(true)

    // ── the loud counterpart ──────────────────────────────────────────────
    const firstBreak = samples.findIndex((s) => s.live > 0)
    const breaks = samples.filter((s, i) => s.live > 0 && (samples[i - 1]?.live ?? 0) === 0).length
    expect(
      firstBreak,
      `no prop broke in ${SECONDS} s on ${MISSION} — the gate saw nothing, which is a finding about the route, not a pass`,
    ).toBeGreaterThanOrEqual(0)

    // ── the gate ──────────────────────────────────────────────────────────
    //
    // TWO assertions, because the first draft of this spec had only a loose
    // version of the first and went red for somebody else's reason. It asserted
    // "the count did not move while pieces were in the air" and alpine failed
    // it: `91 -> 92` at 21.15 s, 0.7 s into a fracture. The full cacheKey named
    // the culprit as the LAND chunk material (`…|illustrative-warp|surface-gloss
    // |lod-fade|unity-fog|sun-ground…`) rather than a prop's (`…|unity-fog|
    // sun-height`) — a terrain variant compiling in the clear, which is
    // DEV-177(b) and not this. On alpine a tree is in pieces most of the time,
    // so "while pieces are live" is very nearly "always". Correlation, not
    // attribution.
    const peak = Math.max(...samples.map((s) => s.live))
    const moves = samples.flatMap((s, i) => {
      const before = samples[i - 1]
      return before && before.programs !== s.programs
        ? [
            `${before.t.toFixed(2)}->${s.t.toFixed(2)} s: ${before.programs} -> ${s.programs} (pieces live ${before.live} -> ${s.live})`,
          ]
        : []
    })
    console.info(
      `\nDEV-177(a) — ${MISSION}, ${samples.length} samples over ${SECONDS} s` +
        `\n  first break at ${(samples[firstBreak] as Sample).t.toFixed(2)} s, ${breaks} breaks, ${peak} pieces at the peak` +
        `\n  program changes over the whole window: ${moves.length === 0 ? 'none' : ''}` +
        moves.map((m) => `\n    ${m}`).join('') +
        '\n',
    )

    // (1) THE SAME SAMPLE. A piece compiles on the first frame that draws it,
    // and that is the frame the pieces are created in — so before the fix the
    // add and the `live 0 -> 6` landed in one sample (`t=45.35` for both). A
    // compile that belongs to anything else is somewhere in between two break
    // edges, as alpine's was.
    const onABreakEdge = samples.flatMap((s, i) => {
      const before = samples[i - 1]
      return before && before.live !== s.live && before.programs !== s.programs
        ? [
            `${s.t.toFixed(2)} s: pieces ${before.live} -> ${s.live} AND programs ${before.programs} -> ${s.programs}`,
          ]
        : []
    })
    expect(
      onABreakEdge,
      "the program count moved on the very frame a fracture or a strike burst appeared or went away — a piece is compiling its own shader again: see prop-fracture.ts's header, or DEV-428's paper field in render/particles.ts (is it in the warm-up?)",
    ).toEqual([])

    // (2) NOTHING IS EVER RELEASED. The signature that named this stall in the
    // first place is a program that LIVES 1.5 SECONDS: three releases a program
    // when its last material is disposed, and the pieces' clones were disposed
    // as they faded. Nothing else in the flight disposes a material — the
    // lod-fade clones are pooled, the sea's variants are permanent — so a
    // removal in flight is the fracture's, wherever in the window it lands.
    // Measured: one removal before the fix, none after, on Simonet and alpine.
    const removals = samples.flatMap((s, i) => {
      const before = samples[i - 1]
      return before && s.programs < before.programs
        ? [`${s.t.toFixed(2)} s: ${before.programs} -> ${s.programs}`]
        : []
    })
    expect(
      removals,
      'a program was RELEASED in flight, which means a material was disposed mid-run — the fracture pool is leaking its materials again',
    ).toEqual([])
  })
})
