// The other player's ship, over a connection you can make worse. Making-of,
// the rooms chapter.
//
// A sender flies a loop at the HoverJet's mean lap speed and, every
// `POSE_SEND_TICKS` fixed ticks, writes its pose with the game's own
// `PoseWriter`. Each message crosses a pretend connection: a one-way delay,
// jitter, and the occasional stall. A room's socket is a WebSocket, so it is
// TCP: nothing is lost and nothing arrives out of order, but a stalled message
// holds up every message behind it, and they then arrive in a burst. The
// receiver decodes each one with the game's `decodePose` and feeds the game's
// `RemoteTrack` exactly the way `room-session.ts` does, keyed by the sender's
// tick and with its lateness on the shared clock.
//
// The clocks are taken as already agreed (the room-clock toy is that half), so
// "now" is one number for both ends.

import { decodePose, PoseWriter, poseFrame, poseRecord } from '@/net/pose-codec'
import { drawnPose, RemoteTrack, type TrackMode } from '@/net/remote-track'
import { roomTimeOfTick, sharedTickAt } from '@/net/room-clock'
import { POSE_SEND_TICKS } from '@/net/room-protocol'
import { FIXED_DT } from '@/sim/constants'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

/** The HoverJet's mean speed over a lap, m/s (the racing chapter's figure). */
const SPEED = 159
/** The loop: a figure eight this many metres across and deep. */
const HALF_X = 650
const HALF_Z = 380
const DT_MS = FIXED_DT * 1000
/** How far back the received samples are drawn, as dots. */
const DOTS = 24

type View = 'track' | 'newest'

/** A point on the figure eight at angle `a`. */
const loop = (a: number): [number, number] => [HALF_X * Math.sin(a), HALF_Z * Math.sin(2 * a)]

/** Radians per metre of the loop, averaged: so the sender flies it at `SPEED`. */
const perimeter = (() => {
  let total = 0
  let [px, pz] = loop(0)
  for (let i = 1; i <= 4000; i++) {
    const [x, z] = loop((i / 4000) * Math.PI * 2)
    total += Math.hypot(x - px, z - pz)
    px = x
    pz = z
  }
  return total
})()
const RATE = (Math.PI * 2 * SPEED) / perimeter

interface InFlight {
  readonly bytes: Uint8Array
  readonly at: number
}

export const toy: ToyDef = {
  id: 'remote-ship',
  title: 'Another player’s ship',
  caption:
    'The pose writer, the decoder and the track that draws the other ship are the game’s own. Only the connection is pretend.',
  kind: '2d',
  mount({ stage, controls }) {
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    const writer = new PoseWriter(1)
    const record = poseRecord()
    const frame = poseFrame(1)
    const drawn = drawnPose()
    let track = new RemoteTrack()

    let latency = 60
    let jitter = 25
    let stallsPerMinute = 6
    let view: View = 'track'

    let now = 0
    let nextTick = 0
    let lastArrival = 0
    let bytesPerMessage = 0
    let mode: TrackMode = 'none'
    let behind = 0
    const flight: InFlight[] = []
    const dots: [number, number][] = []

    /** The sender's pose at tick `t`: position, heading, velocity. */
    const truth = (t: number) => {
      const a = t * DT_MS * 0.001 * RATE
      const [x, z] = loop(a)
      const [x2, z2] = loop(a + 0.001)
      const len = Math.hypot(x2 - x, z2 - z) || 1
      return { x, z, vx: ((x2 - x) / len) * SPEED, vz: ((z2 - z) / len) * SPEED }
    }

    const send = (tick: number) => {
      const p = truth(tick)
      record.px = p.x
      record.py = 120
      record.pz = p.z
      record.vx = p.vx
      record.vy = 0
      record.vz = p.vz
      const heading = Math.atan2(p.vx, p.vz)
      record.qx = 0
      record.qy = Math.sin(heading / 2)
      record.qz = 0
      record.qw = Math.cos(heading / 2)
      const bytes = writer.encode(tick, [record], 1).slice()
      // The room writes the sender's slot into the header; nothing else is touched.
      bytes[1] = 1
      bytesPerMessage = bytes.length
      const sent = roomTimeOfTick(tick, 0)
      let at = sent + latency + jitter * Math.random() ** 2
      if (Math.random() < (stallsPerMinute / 60) * (POSE_SEND_TICKS * DT_MS * 0.001)) {
        at += 150 + Math.random() * 250
      }
      // One TCP stream: a message cannot overtake the one in front of it.
      at = Math.max(at, lastArrival)
      lastArrival = at
      flight.push({ bytes, at })
    }

    const receive = () => {
      while (flight.length && (flight[0] as InFlight).at <= now) {
        const m = flight.shift() as InFlight
        if (!decodePose(m.bytes, frame)) continue
        const late = now - roomTimeOfTick(frame.tick, 0)
        const r = frame.records[0]
        if (!r) continue
        track.push(frame.tick, r, late)
        dots.push([r.px, r.pz])
        if (dots.length > DOTS) dots.shift()
      }
    }

    const reset = () => {
      track = new RemoteTrack()
      flight.length = 0
      dots.length = 0
      lastArrival = now
    }

    const frameOf = () => {
      const s = Math.min(cv.width / (HALF_X * 2.25), cv.height / (HALF_Z * 2.6))
      return {
        X: (x: number) => cv.width / 2 + x * s,
        Z: (z: number) => cv.height / 2 + z * s,
      }
    }

    const ship = (x: number, z: number, vx: number, vz: number, fill: string, stroke: string) => {
      const { ctx } = cv
      const v = frameOf()
      const h = Math.atan2(vz, vx)
      ctx.save()
      ctx.translate(v.X(x), v.Z(z))
      ctx.rotate(h)
      ctx.scale(1.5, 1.5)
      ctx.beginPath()
      ctx.moveTo(11, 0)
      ctx.lineTo(-7, -6)
      ctx.lineTo(-4, 0)
      ctx.lineTo(-7, 6)
      ctx.closePath()
      ctx.fillStyle = fill
      ctx.fill()
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      const v = frameOf()
      ctx.clearRect(0, 0, w, h)
      ctx.beginPath()
      for (let i = 0; i <= 200; i++) {
        const [x, z] = loop((i / 200) * Math.PI * 2)
        if (i === 0) ctx.moveTo(v.X(x), v.Z(z))
        else ctx.lineTo(v.X(x), v.Z(z))
      }
      ctx.strokeStyle = 'rgba(194,200,229,0.18)'
      ctx.lineWidth = 10
      ctx.stroke()
      ctx.lineWidth = 1
      dots.forEach(([x, z], i) => {
        ctx.beginPath()
        ctx.arc(v.X(x), v.Z(z), 2.5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(250,207,99,${0.25 + (0.75 * (i + 1)) / dots.length})`
        ctx.fill()
      })
      const real = truth(sharedTickAt(now, 0))
      ship(real.x, real.z, real.vx, real.vz, 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0.7)')
      if (mode !== 'none') {
        ship(drawn.px, drawn.pz, drawn.vx, drawn.vz, '#6fb4ff', '#ffffff')
        ctx.beginPath()
        ctx.moveTo(v.X(drawn.px), v.Z(drawn.pz))
        ctx.lineTo(v.X(real.x), v.Z(real.z))
        ctx.setLineDash([3, 4])
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    const readouts = () => {
      out.update([
        {
          label: 'one message',
          value: `${bytesPerMessage} bytes, ${(1000 / (POSE_SEND_TICKS * DT_MS)).toFixed(1)} a second`,
        },
        {
          label: 'drawn this far in the past',
          value: `${Math.round(view === 'track' ? track.delayMs : now - lastShown)} ms`,
        },
        { label: 'behind the real ship', value: `${Math.round(behind)} m` },
        {
          label: 'the track is',
          value:
            view === 'newest'
              ? 'off: drawing the newest message'
              : mode === 'interp'
                ? 'between two samples'
                : mode === 'extrap'
                  ? 'guessing ahead'
                  : mode === 'hold'
                    ? 'holding: nothing new for too long'
                    : 'waiting',
          ...(mode === 'interp' || view === 'newest' ? {} : { tone: 'bad' as const }),
        },
      ])
    }

    let lastShown = 0
    const step = () => {
      while (roomTimeOfTick(nextTick, 0) <= now) {
        if (nextTick % POSE_SEND_TICKS === 0) send(nextTick)
        nextTick++
      }
      receive()
      if (view === 'track') {
        mode = track.sample(sharedTickAt(now, 0) - track.delayTicks, drawn)
      } else {
        const r = frame.records[0]
        if (track.size > 0 && r) {
          drawn.px = r.px
          drawn.pz = r.pz
          drawn.vx = r.vx
          drawn.vz = r.vz
          lastShown = roomTimeOfTick(frame.tick, 0)
          mode = 'interp'
        }
      }
      const real = truth(sharedTickAt(now, 0))
      behind = mode === 'none' ? 0 : Math.hypot(real.x - drawn.px, real.z - drawn.pz)
    }

    controls.segmented<View>({
      options: [
        { value: 'track', label: 'the game’s track' },
        { value: 'newest', label: 'newest message only' },
      ],
      value: view,
      onChange: (v) => {
        view = v
      },
    })
    controls.slider({
      label: 'one-way delay',
      min: 10,
      max: 250,
      step: 5,
      value: latency,
      format: (v) => `${v} ms`,
      onInput: (v) => {
        latency = v
      },
    })
    controls.slider({
      label: 'jitter',
      min: 0,
      max: 120,
      step: 5,
      value: jitter,
      format: (v) => `up to ${v} ms`,
      onInput: (v) => {
        jitter = v
      },
    })
    controls.slider({
      label: 'stalls',
      min: 0,
      max: 30,
      step: 1,
      value: stallsPerMinute,
      format: (v) => `${v} a minute`,
      onInput: (v) => {
        stallsPerMinute = v
      },
    })
    controls.button('reconnect', reset)

    // Prime the ship a second into its loop, so it is moving when the page arrives.
    now = 1000
    nextTick = Math.ceil(now / DT_MS)
    reset()
    let sinceReadout = 0
    return {
      frame: (dt) => {
        now += Math.min(dt, 0.1) * 1000
        step()
        draw()
        sinceReadout += dt
        if (sinceReadout > 0.2) {
          sinceReadout = 0
          readouts()
        }
      },
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
