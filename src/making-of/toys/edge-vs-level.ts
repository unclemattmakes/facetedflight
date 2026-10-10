// T08, edge against level. DEV-515 (docs/plan/MAKING-OF.md §4).
//
// `int_01_jumpSeat` respawns the ship 2.6 km from the centre of a 2,047 m play
// sphere, outside it. 2016's boundary is a TRIGGER: the countdown starts on the
// EXIT edge, so a ship that was never inside has nothing to exit and nothing
// happens. The port first shipped a LEVEL test ("are you outside right now?"),
// under which this mission reset every 15.5 s for ever.
//
// The toy steps the game's real `stepBoundary` on the game's real clock, with
// the mission's real boundary. The "level test" switch sets `state.armed` every
// tick, which is what that test amounted to: the toy forces the one flag the
// fix introduced, and does not re-create the old function.

import {
  type BoundarySpec,
  boundaryCountdown,
  boundaryProgress,
  createBoundary,
  stepBoundary,
} from '@/sim/boundary'
import { v3 } from '@/sim/math/vec3'
import level from '../../../content/levels/int_01_jumpSeat.json'
import { createCanvas2D } from '../shared/canvas2d'
import { createToyClock, type ToyDef } from '../shared/toy-host'

type Semantics = 'edge' | 'level'

const FLY_SPEED = 400 // toy-world metres per second toward the pointer; a toy control, not a game constant

export const toy: ToyDef = {
  id: 'edge-vs-level',
  title: 'Edge or level',
  caption:
    'The ship starts outside the sphere, as the mission puts it. Tap the stage to fly toward a point; fly in and out. Then switch to the level test and leave it alone.',
  kind: '2d',
  mount({ stage, controls }) {
    const b = level.boundary
    const spec: BoundarySpec = {
      enabled: b.enabled,
      centre: v3(b.volume.centre[0], b.volume.centre[1], b.volume.centre[2]),
      radius: b.volume.radius,
      resetDelaySeconds: b.resetDelay,
      fadeSeconds: b.resetFadeSeconds,
    }
    const spawn = v3(level.spawn.pos[0], level.spawn.pos[1], level.spawn.pos[2])
    const ship = v3(spawn.x, spawn.y, spawn.z)
    const target = v3(spawn.x, spawn.y, spawn.z)
    const state = createBoundary()
    const clock = createToyClock()
    let semantics: Semantics = 'edge'
    let speedUp = 4
    let resets = 0
    let runClock = 0
    const cv = createCanvas2D(stage)
    const out = controls.readouts()

    // Top-down: x across, z down. Fit the circle and the spawn with a margin.
    const view = () => {
      const minX = Math.min(spec.centre.x - spec.radius, spawn.x)
      const maxX = Math.max(spec.centre.x + spec.radius, spawn.x)
      const minZ = Math.min(spec.centre.z - spec.radius, spawn.z)
      const maxZ = Math.max(spec.centre.z + spec.radius, spawn.z)
      const pad = 0.08
      const s = Math.min(
        cv.width / ((maxX - minX) * (1 + pad * 2)),
        cv.height / ((maxZ - minZ) * (1 + pad * 2)),
      )
      const cx = (minX + maxX) / 2
      const cz = (minZ + maxZ) / 2
      return {
        s,
        px: (x: number) => cv.width / 2 + (x - cx) * s,
        pz: (z: number) => cv.height / 2 + (z - cz) * s,
        wx: (px: number) => cx + (px - cv.width / 2) / s,
        wz: (pz: number) => cz + (pz - cv.height / 2) / s,
      }
    }

    const onPointer = (e: PointerEvent) => {
      const r = cv.canvas.getBoundingClientRect()
      const v = view()
      target.x = v.wx(e.clientX - r.left)
      target.z = v.wz(e.clientY - r.top)
    }
    cv.canvas.addEventListener('pointerdown', onPointer)
    cv.canvas.addEventListener('pointermove', (e) => {
      if (e.buttons) onPointer(e)
    })

    const respawn = () => {
      ship.x = spawn.x
      ship.y = spawn.y
      ship.z = spawn.z
      target.x = spawn.x
      target.z = spawn.z
      runClock = 0
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      const v = view()
      ctx.clearRect(0, 0, w, h)
      const warn = state.phase === 'warning'
      const dying = state.phase === 'dying'
      ctx.beginPath()
      ctx.arc(v.px(spec.centre.x), v.pz(spec.centre.z), spec.radius * v.s, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(111,180,255,0.08)'
      ctx.fill()
      ctx.strokeStyle = dying ? '#ff7a7a' : warn ? '#facf63' : '#6fb4ff'
      ctx.lineWidth = 2
      ctx.stroke()
      // The countdown as an arc around the ship.
      const p = boundaryProgress(state, spec)
      ctx.beginPath()
      ctx.arc(v.px(ship.x), v.pz(ship.z), 16, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2)
      ctx.strokeStyle = dying ? '#ff7a7a' : '#facf63'
      ctx.lineWidth = 3
      ctx.stroke()
      // Spawn marker, the pointer's target, the ship.
      ctx.strokeStyle = '#98a3bd'
      ctx.lineWidth = 1
      ctx.strokeRect(v.px(spawn.x) - 6, v.pz(spawn.z) - 6, 12, 12)
      ctx.beginPath()
      ctx.arc(v.px(target.x), v.pz(target.z), 4, 0, Math.PI * 2)
      ctx.strokeStyle = '#6fb4ff'
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(v.px(ship.x), v.pz(ship.z), 6, 0, Math.PI * 2)
      ctx.fillStyle = dying ? '#ff7a7a' : '#facf63'
      ctx.fill()
      ctx.fillStyle = '#98a3bd'
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.fillText('spawn', v.px(spawn.x) + 10, v.pz(spawn.z) - 8)
    }

    const readouts = () => {
      const count = boundaryCountdown(state, spec)
      out.update([
        { label: 'phase', value: state.phase, tone: state.phase === 'inside' ? 'good' : 'bad' },
        { label: 'armed', value: String(state.armed) },
        { label: 'countdown', value: count === null ? 'none' : `${count} s` },
        { label: 'run clock', value: `${runClock.toFixed(1)} s` },
        { label: 'resets', value: String(resets), tone: resets > 0 ? 'bad' : 'good' },
      ])
    }

    controls.segmented<Semantics>({
      options: [
        { value: 'edge', label: '2016: exit edge' },
        { value: 'level', label: 'level test' },
      ],
      value: semantics,
      onChange: (v) => {
        semantics = v
        resets = 0
        state.armed = false
        state.phase = 'inside'
        state.outsideFor = 0
        respawn()
      },
    })
    controls.slider({
      label: 'speed up',
      min: 1,
      max: 8,
      step: 1,
      value: speedUp,
      format: (v) => `${v}x`,
      onInput: (v) => {
        speedUp = v
      },
    })
    controls.button('respawn', respawn)
    readouts()
    draw()

    return {
      frame(dt) {
        clock.step(dt * speedUp, (fixedDt) => {
          // Fly toward the target at a fixed toy speed, in the fixed step.
          const dx = target.x - ship.x
          const dz = target.z - ship.z
          const d = Math.hypot(dx, dz)
          const move = Math.min(d, FLY_SPEED * fixedDt)
          if (d > 1e-6) {
            ship.x += (dx / d) * move
            ship.z += (dz / d) * move
          }
          if (semantics === 'level') state.armed = true
          runClock += fixedDt
          if (stepBoundary(state, spec, ship, fixedDt)) {
            resets += 1
            respawn()
          }
        })
        readouts()
        draw()
      },
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
