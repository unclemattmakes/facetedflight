/**
 * A standard pad the HARNESS holds, and a pilot that flies it. DEV-373.
 *
 * ── Why a pad, and why that is not a different build ─────────────────────
 *
 * Share is offered only for a CLEAN lap (D30's `runTainted`, DEV-371): the
 * autopilot at any tick taints the run, so the autopilot every other flying
 * spec uses cannot produce a lap Share will post. Something has to fly the
 * ship the way a player does — through an input device the game already reads.
 *
 * So this puts a W3C `standard`-mapping pad in `navigator.getGamepads()`, the
 * way plugging one in would, and moves its sticks from a small controller that
 * runs in the page each frame. The GAME's path is the one a player's pad takes:
 * `readGamepad` → scheme "a" → `stepHoverJet`, with no switch and no flag. That
 * is CLAUDE.md's line — the harness doing what a player does, never the build
 * doing something different.
 *
 * ── The pilot ─────────────────────────────────────────────────────────────
 *
 * Deliberately simple and deliberately NOT the autopilot: it seeks one target
 * (a spec hands it the finish gate), climbing to a cruise height first so no
 * hill is on the way and dropping onto the target inside `near` metres. Throttle
 * only, never boost: on Anniversary boost costs energy (DEV-143) and an empty
 * tank ends the run. It takes no rings on purpose — a lap that missed rings is
 * still a lap the server keeps and a link can race (PLAYER-GHOSTS §8 call 3),
 * and it is ~30 s of flying instead of ~77.
 *
 * The steering is `sim/autopilot.ts`'s bearing/elevation law and its signs,
 * which were measured off the integrator; the pad's axes are those actions run
 * backwards through `readGamepad` (`shapeAxis`'s dead zone, scheme "a": left X
 * yaws, left Y pitches with `invertPitch` off, right X rolls).
 */
import type { Page } from '@playwright/test'
import { DEAD_ZONE_LOWER, DEAD_ZONE_UPPER } from '@/input/gamepad'

/** A point in SIM space (Unity's: the level JSON with z negated). */
export interface SimPoint {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** Before `page.goto`: the pad, and its pilot, idle until {@link flyTo}. */
export const installHarnessPad = async (page: Page): Promise<void> => {
  await page.addInitScript(
    ({ lower, upper }) => {
      type Btn = { pressed: boolean; touched: boolean; value: number }
      type V = { x: number; y: number; z: number }
      type Q = V & { w: number }
      const idle = (): Btn => ({ pressed: false, touched: false, value: 0 })
      const pad = {
        id: 'e2e harness pad (STANDARD GAMEPAD)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, idle),
        vibrationActuator: null,
      }
      Object.defineProperty(Navigator.prototype, 'getGamepads', {
        configurable: true,
        value: () => [pad, null, null, null],
      })
      const pilot = {
        on: false,
        target: null as V | null,
        cruise: 600,
        lead: 350,
        near: 700,
        frames: 0,
      }
      const g = globalThis as unknown as Record<string, unknown>
      g.__harnessPad = pad
      g.__harnessPilot = pilot
      const clamp = (v: number): number => Math.max(-1, Math.min(1, v))
      // `shapeAxis` backwards: |v| in (0, 1] onto the live band past the dead zone.
      const raw = (v: number): number =>
        Math.abs(v) < 1e-4
          ? 0
          : Math.sign(v) * (lower + 1e-3 + Math.min(1, Math.abs(v)) * (upper - lower - 1e-3))
      // `sim/math/quat.ts`'s `rotateVec3Inverse`, verbatim.
      const rotInv = (q: Q, v: V): V => {
        const tx = -2 * (q.y * v.z - q.z * v.y)
        const ty = -2 * (q.z * v.x - q.x * v.z)
        const tz = -2 * (q.x * v.y - q.y * v.x)
        return {
          x: v.x + q.w * tx - q.y * tz + q.z * ty,
          y: v.y + q.w * ty - q.z * tx + q.x * tz,
          z: v.z + q.w * tz - q.x * ty + q.y * tx,
        }
      }
      const frame = (): void => {
        requestAnimationFrame(frame)
        const app = g.__ff2 as
          | { flight?: () => { jet?: { body?: { position: V; orientation: Q } } } | null }
          | undefined
        const body = app?.flight?.()?.jet?.body
        if (!pilot.on || !pilot.target || !body) {
          pad.axes = [0, 0, 0, 0]
          pad.buttons[7] = idle()
          return
        }
        const p = body.position
        const q = body.orientation
        const t = pilot.target
        const hx = t.x - p.x
        const hz = t.z - p.z
        const horiz = Math.hypot(hx, hz)
        // Far out, aim at a point a short way along the heading AT cruise
        // height, which climbs hard before it goes anywhere. Probed on `int_01`
        // (a scratch spec, 2026-09-25): the first draft aimed at 300 m over the
        // target itself, climbed at 7 m/s and crashed ~800 m out every nine
        // seconds (a crash reset puts the ship back near the start); a 360 m
        // cruise still met something at 342 m; at 600 m it crossed the finish
        // in ~26 s with nothing in the way. Near the target, straight at it.
        const far = horiz > pilot.near
        const lead = Math.min(horiz, pilot.lead)
        const aim = far
          ? {
              x: p.x + (hx / horiz) * lead,
              y: Math.max(t.y, pilot.cruise),
              z: p.z + (hz / horiz) * lead,
            }
          : { x: t.x, y: t.y, z: t.z }
        const l = rotInv(q, { x: aim.x - p.x, y: aim.y - p.y, z: aim.z - p.z })
        const bearing = Math.atan2(l.x, l.z)
        const elevation = Math.atan2(l.y, Math.hypot(l.x, l.z))
        // `DEFAULT_AUTOPILOT`'s gains: +yaw is nose right, +pitch nose DOWN.
        const yaw = clamp(bearing * 2.6)
        const pitch = clamp(-elevation * 3.2)
        // Wings level, banked into the turn: +roll raises the right wing.
        const right = rotInv({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, { x: 1, y: 0, z: 0 })
        const wantRightY = Math.max(-0.72, Math.min(0.72, -yaw * 0.55))
        const roll = clamp(-(right.y - wantRightY) * 2.2)
        // Scheme "a" through `readGamepad`: pitch = -leftY, yaw = leftX, roll = -rightX.
        pad.axes = [raw(yaw), raw(-pitch), raw(-roll), 0]
        pad.buttons[7] = { pressed: true, touched: true, value: 1 }
        pad.timestamp = performance.now()
        pilot.frames += 1
      }
      requestAnimationFrame(frame)
    },
    { lower: DEAD_ZONE_LOWER, upper: DEAD_ZONE_UPPER },
  )
}

/** Fly at `target` (SIM space) until {@link padIdle}. */
export const flyTo = async (page: Page, target: SimPoint): Promise<void> => {
  await page.evaluate((t) => {
    const pilot = (globalThis as unknown as { __harnessPilot: { on: boolean; target: unknown } })
      .__harnessPilot
    pilot.target = t
    pilot.on = true
  }, target)
}

/** Sticks centred, throttle off. */
export const padIdle = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    ;(globalThis as unknown as { __harnessPilot: { on: boolean } }).__harnessPilot.on = false
  })
}

/** How many frames the pilot has driven the pad. */
export const pilotFrames = async (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      (globalThis as unknown as { __harnessPilot?: { frames: number } }).__harnessPilot?.frames ??
      0,
  )
