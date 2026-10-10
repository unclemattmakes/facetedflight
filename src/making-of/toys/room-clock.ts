// Agreeing on GO. Making-of, the rooms chapter.
//
// Your computer's clock and the room's disagree by some amount nobody knows.
// The game finds it the way `room-session.ts` does: ping the room, the room
// answers with its own time, and the game's `RoomClock` turns the samples into
// an estimate. This toy runs that exchange over a pretend connection whose
// true offset it knows, so it can draw how wrong each way of reading the
// samples is.
//
// Three readings of the same samples:
//   - the latest ping alone: its round trip split down the middle;
//   - the fastest round trip in the same window (NTP's classic filter);
//   - the game's `RoomClock`, which takes each direction's fastest trip from
//     whichever samples had it.
// The first two are a line each here, because they are what the game does
// NOT do; the third is the game's class.
//
// The `upload slower` slider is the one error no exchange can see: a path that
// is always slower one way. It lands as half the difference, in all three.

import { ROOM_CLOCK_BURST, ROOM_CLOCK_WINDOW, RoomClock } from '@/net/room-clock'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

/** Samples the chart spans. */
const SPAN = 48
/** The chart's half height, ms. */
const RANGE = 15
/** Pings a second in the toy: faster than the game's 1 Hz, so it is watchable. */
const PINGS_PER_SECOND = 4

interface Sample {
  readonly t0: number
  readonly room: number
  readonly t1: number
}

interface Row {
  readonly latest: number
  readonly fastest: number
  readonly game: number
}

const LINES = [
  { key: 'latest', label: 'latest ping alone', colour: 'rgba(194,200,229,0.55)' },
  { key: 'fastest', label: 'fastest round trip', colour: '#facf63' },
  { key: 'game', label: 'the game’s clock', colour: '#6fb4ff' },
] as const

export const toy: ToyDef = {
  id: 'room-clock',
  title: 'Agreeing on GO',
  caption:
    'Each dot is one ping. The lines are how far off each way of reading the pings is from the room’s real clock. Zero is a perfect start.',
  kind: '2d',
  mount({ stage, controls }) {
    const cv = createCanvas2D(stage)
    const out = controls.readouts()
    let base = 40
    let jitter = 60
    let asymmetry = 0
    let running = true

    let offset = 0
    let clock = new RoomClock()
    let samples: Sample[] = []
    let rows: Row[] = []
    let local = 0
    let sincePing = 0

    const newConnection = () => {
      // The room's clock is some seconds off yours; nobody knows by how much.
      offset = 1500 + Math.random() * 4000
      clock = new RoomClock()
      samples = []
      rows = []
    }

    const ping = () => {
      // Each direction queues on its own, so a trip fast both ways is rare.
      const up = base + asymmetry + jitter * Math.random()
      const down = base + jitter * Math.random()
      const t0 = local
      const room = t0 + up + offset
      const t1 = t0 + up + down
      local = t1
      samples.push({ t0, room, t1 })
      clock.sample(t0, room, t1)
      let fastest = samples[samples.length - 1] as Sample
      for (const s of samples.slice(-ROOM_CLOCK_WINDOW))
        if (s.t1 - s.t0 < fastest.t1 - fastest.t0) fastest = s
      const mid = (s: Sample) => s.room - (s.t0 + s.t1) / 2
      rows.push({
        latest: mid({ t0, room, t1 }) - offset,
        fastest: mid(fastest) - offset,
        game: clock.offset - offset,
      })
      if (rows.length > SPAN) rows.shift()
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      ctx.clearRect(0, 0, w, h)
      const left = 44
      const right = w - 12
      const top = 14
      const bottom = h - 28
      const X = (i: number) => left + ((right - left) * i) / (SPAN - 1)
      const Y = (ms: number) =>
        (top + bottom) / 2 - (Math.max(-RANGE, Math.min(RANGE, ms)) / RANGE) * ((bottom - top) / 2)
      ctx.font = '11px "JetBrains Mono", monospace'
      ctx.fillStyle = 'rgba(194,200,229,0.6)'
      for (const ms of [-RANGE, -RANGE / 2, 0, RANGE / 2, RANGE]) {
        ctx.fillText(`${ms > 0 ? '+' : ''}${ms}`, 4, Y(ms) + 4)
        ctx.beginPath()
        ctx.moveTo(left, Y(ms))
        ctx.lineTo(right, Y(ms))
        ctx.strokeStyle = ms === 0 ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.08)'
        ctx.stroke()
      }
      ctx.fillText('ms off', left + 4, top + 10)
      for (const line of LINES) {
        ctx.beginPath()
        rows.forEach((r, i) => {
          if (i === 0) ctx.moveTo(X(i), Y(r[line.key]))
          else ctx.lineTo(X(i), Y(r[line.key]))
        })
        ctx.strokeStyle = line.colour
        ctx.lineWidth = line.key === 'game' ? 2.5 : 1.5
        ctx.stroke()
        if (line.key === 'latest') {
          rows.forEach((r, i) => {
            ctx.beginPath()
            ctx.arc(X(i), Y(r.latest), 2, 0, Math.PI * 2)
            ctx.fillStyle = line.colour
            ctx.fill()
          })
        }
      }
      ctx.lineWidth = 1
      let x = left
      for (const line of LINES) {
        ctx.fillStyle = line.colour
        ctx.fillRect(x, h - 14, 10, 3)
        ctx.fillStyle = 'rgba(194,200,229,0.8)'
        ctx.fillText(line.label, x + 14, h - 9)
        x += ctx.measureText(line.label).width + 32
      }
    }

    const readouts = () => {
      const last = rows[rows.length - 1]
      const ms = (v: number | undefined) =>
        v === undefined ? 'no pings yet' : `${v >= 0 ? '+' : ''}${v.toFixed(1)} ms`
      out.update([
        { label: 'pings', value: String(samples.length) },
        { label: 'latest ping alone', value: ms(last?.latest) },
        { label: 'fastest round trip', value: ms(last?.fastest) },
        {
          label: 'the game’s clock',
          value: ms(last?.game),
          ...(last && Math.abs(last.game) < 5 ? { tone: 'good' as const } : {}),
        },
      ])
    }

    controls.slider({
      label: 'one-way delay',
      min: 5,
      max: 150,
      step: 5,
      value: base,
      format: (v) => `${v} ms`,
      onInput: (v) => {
        base = v
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
      label: 'upload slower by',
      min: 0,
      max: 24,
      step: 2,
      value: asymmetry,
      format: (v) => `${v} ms`,
      onInput: (v) => {
        asymmetry = v
      },
    })
    controls.toggle({
      label: 'keep pinging',
      value: running,
      onChange: (v) => {
        running = v
      },
    })
    controls.button(`join burst (${ROOM_CLOCK_BURST} pings)`, () => {
      for (let i = 0; i < ROOM_CLOCK_BURST; i++) ping()
      readouts()
      draw()
    })
    controls.button('new connection', () => {
      newConnection()
      readouts()
      draw()
    })

    newConnection()
    return {
      frame: (dt) => {
        if (!running) return
        sincePing += dt
        if (sincePing >= 1 / PINGS_PER_SECOND) {
          sincePing = 0
          ping()
          readouts()
          draw()
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
