/**
 * tests/e2e/xr-vrto3d-probe.spec.ts — can this harness open a REAL immersive
 * session?
 *
 * Not a measurement. A probe, run before building anything on top of it.
 *
 * `isSessionSupported('immersive-vr')` already answers **true** against the
 * VRto3D virtual headset, and the `#enter-vr` click lands — but the overlay
 * never comes down, so `requestSession` is rejecting. The app does not record
 * that rejection anywhere a spec can read it (nothing in the boot path
 * catches a `requestSession` rejection in a place a spec can read), so the
 * probe wraps the call itself.
 *
 * The wrapper is HARNESS-SIDE and records only — it forwards every call
 * untouched and re-throws. Nothing about the game's behaviour changes, which is
 * the line CLAUDE.md draws: the harness may do something extra, the GAME may
 * not take a different path.
 */

import type { Ff2GlobalMaybe } from './fixtures/ff2'
import { knownRed } from './fixtures/known-red'
import { enterVr, loadSettled } from './fixtures/landing'
import { expect, requireImmersiveDevice, test } from './fixtures/xr-browser'

interface XrProbe {
  readonly calls: string[]
  readonly errors: string[]
  readonly resolved: number
}

test.describe('@measure @gpu vrto3d', () => {
  test.setTimeout(180_000)

  test('chrome opens a real immersive session against the virtual headset', async ({
    page,
    baseURL,
  }) => {
    knownRed('KR-13')
    const consoleErrors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

    await page.addInitScript(() => {
      const probe: { calls: string[]; errors: string[]; resolved: number } = {
        calls: [],
        errors: [],
        resolved: 0,
      }
      ;(globalThis as unknown as Record<string, unknown>).__xrProbe = probe
      const xr = navigator.xr as unknown as
        | { requestSession: (m: string, o?: unknown) => Promise<unknown> }
        | undefined
      if (!xr?.requestSession) return
      const original = xr.requestSession.bind(xr)
      xr.requestSession = (mode: string, init?: unknown) => {
        probe.calls.push(`${mode} ${JSON.stringify(init ?? {})}`)
        return original(mode, init).then(
          (s) => {
            probe.resolved += 1
            return s
          },
          (e: unknown) => {
            const err = e as { name?: string; message?: string }
            probe.errors.push(`${err?.name ?? 'Error'}: ${err?.message ?? String(e)}`)
            throw e
          },
        )
      }
    })

    // The `vr` content setting is already in this profile — see fixtures/xr-browser.ts.
    // Nothing to click, and nothing to bring to front.
    await page.goto('/?perf=1&mission=rookie_01_hoverJet&autopilot=1')

    const supported = await page.evaluate(
      async () => (await navigator.xr?.isSessionSupported?.('immersive-vr')) ?? null,
    )

    // DEV-265: say it now, with the rig named, rather than spending the wait
    // below proving a fact the capability probe already had.
    await requireImmersiveDevice(page)
    await loadSettled(page, 90_000)

    // NO `bringToFront` on this run, deliberately. The earlier fix bundled it
    // with a human pressing Allow on the permission bubble, so which of the two
    // actually opened the session was never established. With the grant now
    // automated, leaving the window alone isolates it.
    const focus = await page.evaluate(() => ({
      visibility: document.visibilityState,
      focused: document.hasFocus(),
    }))

    await enterVr(page)
    // Give the handshake room to fail rather than asserting it succeeded.
    await page.waitForTimeout(25000)

    const probe = (await page.evaluate(
      () => (globalThis as unknown as { __xrProbe?: XrProbe }).__xrProbe ?? null,
    )) as XrProbe | null
    const presenting = await page.evaluate(() => {
      const ff2 = (globalThis as unknown as Ff2GlobalMaybe).__ff2
      const renderer = ff2?.render?.renderer as { xr?: { isPresenting?: boolean } } | undefined
      return renderer?.xr?.isPresenting ?? null
    })

    console.info(
      `\nvrto3d probe\n` +
        `  profile: vr content setting pre-granted for ${baseURL}\n` +
        `  isSessionSupported('immersive-vr'): ${supported}\n` +
        `  at click: visibility=${focus.visibility} focused=${focus.focused}\n` +
        `  requestSession calls:  ${probe?.calls.length ? probe.calls.join(' | ') : '(none)'}\n` +
        `  requestSession errors: ${probe?.errors.length ? probe.errors.join(' | ') : '(none)'}\n` +
        `  sessions resolved:     ${probe?.resolved ?? 'n/a'}\n` +
        `  renderer.xr.isPresenting: ${presenting}\n` +
        `  console errors: ${consoleErrors.length ? `\n    ${consoleErrors.slice(0, 8).join('\n    ')}` : '(none)'}`,
    )

    expect(supported, 'no immersive-vr support — is SteamVR up with the virtual HMD?').toBe(true)
    expect(probe?.calls.length, 'the click never reached requestSession').toBeGreaterThan(0)
    expect(probe?.errors ?? [], 'requestSession rejected').toEqual([])
    expect(presenting, 'the session resolved but three is not presenting').toBe(true)
  })
})
