/**
 * DEV-603: boot waits for the headset probe for XR_PROBE_DEADLINE_MS at most.
 *
 * The 2026-10-03 persona playtest: on a SteamVR box with no headset the probe
 * took 8.4 to 8.8 s and the title was ready at 14 to 18 s. Past the deadline
 * the page boots flat, and a late yes reaches the ENTER VR row as a device
 * change.
 */
import { describe, expect, it } from 'vitest'
import { probeWithDeadline, XR_PROBE_DEADLINE_MS } from '@/boot/capability-gate'
import { watchXrDevices } from '@/boot/enter-vr'

/** A wait that never ends, and one that ends at once: the deadline, controlled. */
const never = () => new Promise<void>(() => {})
const now = () => Promise.resolve()

describe('the headset probe has a deadline (DEV-603)', () => {
  it('is short beside the 8.4 s the playtest measured, and long beside a runtime that is up', () => {
    expect(XR_PROBE_DEADLINE_MS).toBe(1500)
  })

  it('takes an answer that arrives in time, yes or no', async () => {
    expect(await probeWithDeadline(async () => true, 1, never)).toEqual({
      kind: 'answered',
      immersiveVr: true,
    })
    expect(await probeWithDeadline(async () => false, 1, never)).toEqual({
      kind: 'answered',
      immersiveVr: false,
    })
  })

  it('reads a rejection as no, as the probe always has', async () => {
    const out = await probeWithDeadline(() => Promise.reject(new Error('no runtime')), 1, never)
    expect(out).toEqual({ kind: 'answered', immersiveVr: false })
  })

  it('stops waiting at the deadline, and hands on the answer still to come', async () => {
    let answer: (ok: boolean) => void = () => {}
    const slow = new Promise<boolean>((r) => {
      answer = r
    })
    const out = await probeWithDeadline(() => slow, 1, now)
    expect(out.kind).toBe('late')
    if (out.kind !== 'late') return
    answer(true)
    expect(await out.answer).toBe(true)
  })
})

describe('a late yes is a device change for the ENTER VR row (DEV-603)', () => {
  it('calls the row once when the late answer is yes', async () => {
    let calls = 0
    const unwatch = watchXrDevices(() => {
      calls += 1
    }, Promise.resolve(true))
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    unwatch()
  })

  it('does nothing for a late no, or once the row has stopped watching', async () => {
    let calls = 0
    const bump = () => {
      calls += 1
    }
    watchXrDevices(bump, Promise.resolve(false))
    let yes: (ok: boolean) => void = () => {}
    const late = new Promise<boolean>((r) => {
      yes = r
    })
    const unwatch = watchXrDevices(bump, late)
    unwatch()
    yes(true)
    await late
    await Promise.resolve()
    expect(calls).toBe(0)
  })
})
