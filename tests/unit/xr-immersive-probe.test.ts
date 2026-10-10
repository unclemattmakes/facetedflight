/**
 * tests/unit/xr-immersive-probe.test.ts — the three ways "no immersive session"
 * can be true, and the rule that they must not be told apart by guessing.
 *
 * ── Why this is a test at all (DEV-265) ──────────────────────────────────
 *
 * `xr-emulated-perf.spec.ts` sat red for months under the explanation *"needs a
 * runtime and times out on `#enter-vr`"*. It does not need a runtime — it
 * installs IWER and carries its own. The real causes were a query parameter and
 * a dismissed card. **A wrong explanation that sounds mechanical is worse than
 * no explanation, because it closes the question**, and that one closed it.
 *
 * So `assertImmersiveProbe` refuses to collapse the cases. A missing
 * `navigator.xr` is the browser or the build; a throw is neither; a `false` is
 * a device question, and only that one should send anybody to the rig. The
 * messages are the whole product here, so the messages are what is asserted.
 *
 * ── Why it does not drive a browser ──────────────────────────────────────
 *
 * The reading half is eight lines of typed DOM access; the deciding half is
 * this. Checking an error message by entering a real immersive session is not a
 * reasonable price, and on this box — SteamVR up, `forcedDriver` empty — it
 * would put a session on somebody's actual headset to find out what a string
 * says.
 */
import { describe, expect, it } from 'vitest'
import { assertImmersiveProbe } from '../e2e/fixtures/xr-browser'

describe('assertImmersiveProbe', () => {
  it('passes when a device is reported', () => {
    expect(() => assertImmersiveProbe({ kind: 'answered', supported: true })).not.toThrow()
  })

  it('blames the rig ONLY when the probe answered no', () => {
    expect(() => assertImmersiveProbe({ kind: 'answered', supported: false })).toThrow(
      /steamvr-rig\.mjs status vrto3d/,
    )
  })

  it('does not blame the rig when navigator.xr is missing', () => {
    // The distinction that matters: an absent WebXR is the browser or the
    // build, and sending somebody to reinstall a driver for it costs an hour.
    expect(() => assertImmersiveProbe({ kind: 'no-xr' })).toThrow(/NOT the rig/)
    expect(() => assertImmersiveProbe({ kind: 'no-xr' })).not.toThrow(/vrto3d/)
  })

  it('reports a throw verbatim and blames nothing', () => {
    const message = 'SecurityError: permissions policy'
    expect(() => assertImmersiveProbe({ kind: 'threw', message })).toThrow(new RegExp(message))
    expect(() => assertImmersiveProbe({ kind: 'threw', message })).not.toThrow(/vrto3d/)
  })

  it('every failure names the parameter that decides it', () => {
    // A message that says "no session" and not WHICH question was answered is
    // the shape that produced the wrong explanation in the first place.
    for (const probe of [
      { kind: 'answered', supported: false },
      { kind: 'threw', message: 'x' },
    ] as const) {
      expect(() => assertImmersiveProbe(probe)).toThrow(/immersive-vr/)
    }
  })
})
