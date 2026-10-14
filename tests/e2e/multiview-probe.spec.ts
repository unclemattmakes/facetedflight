/**
 * tests/e2e/multiview-probe.spec.ts: each eye drawn by multiview equals the
 * eye three draws without it. DEV-988.
 *
 * Flat, no headset: `?multiview=1` installs `render/multiview.ts`, the mission
 * freezes at a fixed tick (`?snap=`), and `__ff2.multiviewProbe()` draws the
 * live stage twice in one JS turn, once through three's own stereo path (an
 * `ArrayCamera` into a side-by-side target, as a WebXR frame without
 * multiview) and once through the multiview path (one pass into a two-layer
 * texture array, the per-eye block written by the code the XR frame calls).
 * Nothing moves between the two, not even the render-clock water, so the
 * comparison has no drift term.
 *
 * Asserted, positive half first: both arms drew; the multiview arm made
 * exactly HALF the reference's draw calls (both counted with the shadow maps
 * held, so each count is the eye passes alone);
 * GL raised nothing; no source was refused by the rewrite; and each eye agrees
 * within the stated tolerance. The photographs (both arms, both eyes) go to
 * `MULTIVIEW_DIR` when set.
 *
 * What it cannot see is the XR layer: its acquisition, the compositor, the
 * swapchain. That is the rig run (`docs/plan/eval-wave/eval-multiview.md`).
 *
 *   MULTIVIEW_DIR=<dir> E2E_PORT=<port> playwright test multiview-probe --workers 1
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Ff2Global } from './fixtures/ff2'
import { flyToFreeze } from './fixtures/freeze'
import { PINNED } from './fixtures/quality-pin'
import { expect, test } from './fixtures/test'

const OUT_DIR = process.env.MULTIVIEW_DIR ?? ''
const EDITIONS = (process.env.MULTIVIEW_EDITIONS ?? 'anniversary,classic').split(',')
const MISSION = process.env.MULTIVIEW_MISSION ?? 'int_01_hoverJet'
const SNAP_AT = Number(process.env.MULTIVIEW_AT ?? '20')

/**
 * The tolerance, per channel out of 255, and the share of an eye's pixels
 * allowed past it. Not zero: the two arms take the same matrices by different
 * float paths (the eye's view as `E * centreView` against three's own
 * `eyeView`), which moves a few edge pixels by a rasterisation step. A wrong
 * eye, a missing light rewrite or a centre-camera view vector moves whole
 * surfaces, which is thousands of pixels past 8.
 */
const MAX_OVER8_SHARE = 0.005

/** Draws only one eye's frustum holds, at most, per arm. See assertion 3. */
const MAX_ONE_EYE_DRAWS = 8

test.describe('@measure @gpu multiview draws each eye as three does: DEV-988', () => {
  test.setTimeout(600_000)

  for (const edition of EDITIONS) {
    test(`${MISSION} · ${edition} · the probe, one turn, both paths`, async ({ page }) => {
      const messages: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'warning' || m.type() === 'error') messages.push(m.text())
      })
      await flyToFreeze(page, {
        mission: MISSION,
        edition,
        snapAt: SNAP_AT,
        params: { ...Object.fromEntries(new URLSearchParams(PINNED)), multiview: '1' },
      })
      const result = await page.evaluate(() => {
        const w = globalThis as unknown as Ff2Global
        const probe = w.__ff2.multiviewProbe({ width: 768, height: 768, png: true })
        // ── the sweep: every multiview program, both halves, as GL holds them ──
        //
        // Vertex and fragment are two symbol tables: a per-eye name the
        // prelude defines in one stage only is a centre-camera read in the
        // other. So each emitted source is read back and checked for the
        // directive, and for camera names it USES that its own stage does not
        // define per view, plus every uniform it declares whose name says
        // camera, eye, view or projection (the custom per-eye kind this module
        // cannot see), listed for a human.
        const gl = w.__ff2.render.renderer.getContext()
        const programs = (w.__ff2.render.renderer.info.programs ?? []) as unknown as {
          cacheKey: string
          name: string
          vertexShader: WebGLShader
          fragmentShader: WebGLShader
        }[]
        const camera = [
          'viewMatrix',
          'cameraPosition',
          'projectionMatrix',
          'modelViewMatrix',
          'normalMatrix',
        ]
        const sweep = {
          programs: 0,
          missingDirective: [] as string[],
          centreReads: [] as string[],
          suspects: [] as string[],
        }
        for (const p of programs) {
          if (!p.cacheKey.includes('ff2-multiview-srgb')) continue
          sweep.programs++
          for (const [stage, shader] of [
            ['vertex', p.vertexShader],
            ['fragment', p.fragmentShader],
          ] as const) {
            const src = gl.getShaderSource(shader) ?? ''
            if (!src.includes('#extension GL_OVR_multiview2 : require')) {
              sweep.missingDirective.push(`${p.name} ${stage}`)
            }
            const body = src.slice(src.indexOf('#define FF2_MULTIVIEW'))
            for (const name of camera) {
              if (body.includes(`#define ${name} `)) continue
              const uses = body.replace(new RegExp(`uniform\\s+\\w+\\s+${name}\\s*;`, 'g'), '')
              if (new RegExp(`\\b${name}\\b`).test(uses))
                sweep.centreReads.push(`${p.name} ${stage}: ${name}`)
            }
            for (const m of body.matchAll(
              /uniform\s+\w+\s+(\w*(?:[Cc]am|[Ee]ye|[Vv]iew|[Pp]roj)\w*)/g,
            )) {
              sweep.suspects.push(`${p.name} ${stage}: ${m[1]}`)
            }
          }
        }
        sweep.suspects = [...new Set(sweep.suspects)]
        sweep.centreReads = [...new Set(sweep.centreReads)]
        return { probe, report: w.__ff2.multiview(), sweep }
      })
      console.info(`multiview-probe ${edition}: sweep ${JSON.stringify(result.sweep)}`)
      expect(result.sweep.programs, 'multiview programs in three cache').toBeGreaterThan(0)
      expect(result.sweep.missingDirective, 'multiview programs without the directive').toEqual([])
      expect(result.sweep.centreReads, 'camera names read from the centre camera').toEqual([])
      expect(result.probe, 'the page loaded with ?multiview=1 and installed it').not.toBeNull()
      const probe = result.probe as NonNullable<typeof result.probe>
      const report = result.report as NonNullable<typeof result.report>
      const { png, ...numbers } = probe
      console.info(`multiview-probe ${edition}: ${JSON.stringify(numbers)}`)
      console.info(`multiview-probe ${edition}: report ${JSON.stringify(report)}`)
      if (OUT_DIR && png) {
        fs.mkdirSync(OUT_DIR, { recursive: true })
        const names = ['reference-left', 'reference-right', 'multiview-left', 'multiview-right']
        for (const [i, url] of png.entries()) {
          const name = `${MISSION}-${edition}-${names[i]}.png`
          fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(url.split(',')[1] ?? '', 'base64'))
        }
        fs.writeFileSync(
          path.join(OUT_DIR, `${MISSION}-${edition}.json`),
          `${JSON.stringify({ ...numbers, report, sweep: result.sweep, messages }, null, 2)}\n`,
        )
      }

      // ── 1. positive: both arms drew, through a complete framebuffer ───────
      expect(probe.reference.calls, 'the reference drew').toBeGreaterThan(0)
      expect(probe.multiview.calls, 'the multiview arm drew').toBeGreaterThan(0)
      expect(probe.framebuffer).toBe('COMPLETE')
      expect(report.programs, 'multiview programs reached GL').toBeGreaterThan(0)
      // ── 2. nothing was refused and GL raised nothing ─────────────────────
      expect(report.fallbacks, 'sources the rewrite refused').toEqual([])
      expect(probe.glError).toEqual({ reference: 0, multiview: 0 })
      // ── 3. one pass: half the reference's eye-pass draws ─────────────────
      //
      // Not exactly half. The reference culls each eye against its own frustum
      // and the multiview arm culls once against the union, so an object only
      // one eye can see is one draw in each (int_01, anniversary: 154 against
      // 79, i.e. four such draws). The union holds both eyes, so it is never
      // fewer than half.
      expect(probe.multiview.calls * 2).toBeGreaterThanOrEqual(probe.reference.calls)
      expect(probe.multiview.calls * 2 - probe.reference.calls).toBeLessThanOrEqual(
        MAX_ONE_EYE_DRAWS * 2,
      )
      // ── 4. and each eye is three's eye ───────────────────────────────────
      //
      // First, that the eyes differ at all: a multiview arm that drew the left
      // eye into both layers would fail the right eye only if the reference's
      // own eyes are far apart, so that is asserted, against the same measure.
      expect(
        probe.parallax.over8,
        'the reference eyes differ (else a both-layers-left bug would pass)',
      ).toBeGreaterThan(probe.parallax.pixels * MAX_OVER8_SHARE * 4)
      for (const eye of probe.compare) {
        expect(
          eye.over8 / eye.pixels,
          `eye ${eye.eye}: ${eye.over8} pixels past 8 (max ${eye.maxDiff}, mean ${eye.meanDiff.toFixed(3)})`,
        ).toBeLessThanOrEqual(MAX_OVER8_SHARE)
      }
    })
  }
})
