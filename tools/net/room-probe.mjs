#!/usr/bin/env node
// tools/net/room-probe.mjs — two raw WebSocket clients through one room, and a judged lap.
// DEV-386; the judged half DEV-390.
//
// The deployed gate for plan/MULTIPLAYER.md §6.2's route question, and since
// DEV-390 for §6.5's judge: A joins and configures, B joins, both ready, A
// starts, both report `loaded`, both must receive ONE `start` with the same
// `goAt`, each must receive the other's pose with the sender's slot stamped by
// the room. Then the judge, on the real platform: A's lap — a real autopilot
// lap of int_01, flown here from the start the room handed A's seat (DEV-477:
// the judge accepts a seat's lap from its own start and no other, the pad
// included) — is POSTed to `/api/room/<id>/lap`, the Function
// rescores it and hands the verdict to the room over the `ROOMS` binding
// (`src/net/room-link.ts`), and BOTH clients must hear it in `results` with the
// lap's own tick count; the room must serve the kept lap back
// (`GET …/lap?slot=`); B's lap, claiming ten seconds it did not fly, must be
// listed refused with no time; a second POST for A's seat must be refused.
// Last, a third join after START must be closed 4001. Also sends the lobby
// keep-alive and one clock ping.
//
//   node tools/net/room-probe.mjs <ws base> <origin> [room id] [--no-lap] [--watch]
//
//   # route 1, the Pages Function, on a branch preview (Origin = the same host):
//   node tools/net/room-probe.mjs wss://main.ff-10yr.pages.dev https://main.ff-10yr.pages.dev
//   # route 2, the Worker directly (Origin must match its ROOM_ORIGINS; it has no lap route):
//   node tools/net/room-probe.mjs wss://ff10yr-rooms-preview.<account>.workers.dev https://main.ff-10yr.pages.dev --no-lap
//
// Prints one JSON object; exits 0 only when every check held. Node 22+ (its
// WebSocket takes an Origin header, which a browser sets for itself).
//
// The lap is flown by the game's own code: `src/game/autopilot-lap.ts`,
// the lap the unit tests judge — loaded through Vite's SSR loader, because that
// graph holds TypeScript, `@/` imports and a bare JSON import that plain node
// refuses (`tests/e2e/fixtures/ssr-import.ts` says the same). So the rules
// string in the room's settings is `lapRules(...)` for the course, the one the
// DEV-436: `--watch` adds three VIEWERS on `/api/watch/<id>` once the race is
// released: each must hear the broadcaster's keyframe and batches carrying BOTH
// racers' poses, no sooner than the broadcast delay after they were sent.
//
// judge will compare the lap's against, and never a copy. `--no-lap` skips the
// lap and uses a placeholder rules string (a room compares a player's rules
// only with its OWN owner's, so the probe agrees with itself).
//
// DEV-479: `--tv` adds Faceted Flight TV (plan/FF-TV.md §2–§3) once the race is
// released: WATCH ME (`GET /api/room/<id>/tv`) must answer the room's TV id;
// `GET /api/tv` must list it with the room's id nowhere in the body; three TV
// viewers on `/api/tv/<tvId>` must hear both racers no sooner than the delay,
// with the keyframe's players named *Racer N*, and NEITHER the room's id NOR
// a handle (nor any word of one) in any byte they received — nor in the `101`
// a raw handshake is answered with; an unknown TV id must be 404 before any
// upgrade; and `/tv/<tvId>?follow=2` must 302 to `/?tv=<tvId>&follow=2`.

import { readFileSync } from 'node:fs'
import nodeHttp from 'node:http'
import nodeHttps from 'node:https'
import { createSsrServer } from '../lib/ssr.mjs'

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const [base, origin, idArg] = argv.filter((a) => !a.startsWith('--'))
if (!base || !origin) {
  console.error(
    'usage: node tools/net/room-probe.mjs <ws base> <origin> [room id] [--no-lap] [--watch] [--tv]',
  )
  process.exit(2)
}
const WITH_LAP = !flags.has('--no-lap')
const WATCH = flags.has('--watch')
const TV = flags.has('--tv')
const HANDLES = ['Bold Falcon 42', 'Azure Condor 17'] // isHandle's lists and shape: rooms refuse anything else since DEV-850
/** The broadcaster's delay (`BROADCAST_DELAY_MS`), less a margin for clocks. */
const WATCH_DELAY_FLOOR_MS = 1800
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const id =
  idArg ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => BASE32[b & 31]).join('')
const url = `${base}/api/room/${id}`
const watchUrl = `${base}/api/watch/${id}`
const http = base.replace(/^ws(s?):/, 'http$1:')
// Read from the protocol module, never copied: this probe was `1` when DEV-390
// bumped the wire to 2, and the deployed Worker then closed it 4002 — the
// version check working, against a tool that could not follow it.
const PROTOCOL = (() => {
  const src = readFileSync(new URL('../../src/net/room-protocol.ts', import.meta.url), 'utf8')
  const m = /export const ROOM_PROTOCOL = (\d+)/.exec(src)
  if (!m) throw new Error('room-probe: ROOM_PROTOCOL not found in src/net/room-protocol.ts')
  return Number(m[1])
})()
const CONTENT = 'ab12cd34ef56ab12'
const MISSION = 'int_01_hoverJet'
const EDITION = 'anniversary'
const log = (...a) => console.error(new Date().toISOString().slice(11, 23), ...a)

/**
 * The game's own code, through Vite, held open until the lap is flown: the
 * course's rules string at once (the room's settings need it before anybody
 * joins), and a real autopilot lap of the course, as the game's client would
 * post it, flown from start `index` of the course's room starts (DEV-477) —
 * which the room hands out only at START. `close()` when done.
 */
const gameCode = async () => {
  const vite = await createSsrServer()
  try {
    const courses = await vite.ssrLoadModule('/src/net/lap-courses.ts')
    const { flyAutopilotLap } = await vite.ssrLoadModule('/src/game/autopilot-lap.ts')
    const { recordedLap } = await vite.ssrLoadModule('/src/sim/ghost-record.ts')
    const { lapToWire } = await vite.ssrLoadModule('/src/net/lap-client.ts')
    const level = JSON.parse(
      readFileSync(new URL(`../../content/levels/${MISSION}.json`, import.meta.url), 'utf8'),
    )
    const rules = courses.lapRules(MISSION, EDITION, 'standard')
    const course = courses.lapCourse(MISSION)
    if (!rules || !course) throw new Error(`room-probe: no lap course for ${MISSION}/${EDITION}`)
    const starts = course.editions[EDITION]?.rooms?.starts ?? []
    return {
      rules,
      seats: starts.length,
      timeLimit: Math.round(level.timer.timeLimit * 1000),
      fly: async (index) => {
        // SIM space in the artefact; the lap helper takes THREE (z flips).
        const at = starts[index]
        if (!at) throw new Error(`room-probe: ${MISSION} has no room start ${index}`)
        const lap = flyAutopilotLap(level, course.worldOffset, undefined, [at[0], at[1], -at[2]])
        const doc = recordedLap(lap.rec, {
          mission: MISSION,
          mode: 'ringAttack',
          edition: EDITION,
          rules,
          vehicle: courses.lapVehicle('hoverjet', 'standard'),
          build: 'room-probe',
        })
        return {
          start: index,
          wire: await lapToWire(doc),
          seconds: lap.finishAt,
          ticks: lap.finishTick,
        }
      },
      close: () => vite.close(),
    }
  } catch (e) {
    await vite.close()
    throw e
  }
}

const open = (name) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } })
    ws.binaryType = 'arraybuffer'
    const inbox = []
    const waiters = []
    ws.addEventListener('message', (e) => {
      const m =
        typeof e.data === 'string'
          ? e.data.startsWith('{')
            ? JSON.parse(e.data)
            : e.data
          : new Uint8Array(e.data)
      inbox.push(m)
      for (const w of [...waiters]) {
        if (w.test(m)) {
          waiters.splice(waiters.indexOf(w), 1)
          w.resolve(m)
        }
      }
    })
    ws.addEventListener('close', (e) => log(name, 'closed', e.code, e.reason))
    ws.addEventListener('error', () => reject(new Error(`${name}: the handshake failed`)))
    ws.addEventListener('open', () => {
      log(name, 'open')
      resolve({
        ws,
        inbox,
        send: (m) =>
          ws.send(typeof m === 'string' || m instanceof Uint8Array ? m : JSON.stringify(m)),
        wait: (test, ms = 8000, what = 'a message') =>
          new Promise((res, rej) => {
            const hit = inbox.find(test)
            if (hit) return res(hit)
            waiters.push({ test, resolve: res })
            setTimeout(() => rej(new Error(`${name}: timed out waiting for ${what}`)), ms)
          }),
      })
    })
  })

/** DEV-436: a viewer's socket, every message stamped with when it arrived. */
const openWatch = (name) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(watchUrl, { headers: { Origin: origin } })
    ws.binaryType = 'arraybuffer'
    const heard = []
    ws.addEventListener('message', (e) => {
      heard.push({
        at: performance.now(),
        data: typeof e.data === 'string' ? e.data : new Uint8Array(e.data),
      })
    })
    ws.addEventListener('close', (e) => log(name, 'closed', e.code, e.reason))
    ws.addEventListener('error', () => reject(new Error(`${name}: the watch handshake failed`)))
    ws.addEventListener('open', () => {
      log(name, 'watching')
      ws.send(JSON.stringify({ type: 'watch', protocol: PROTOCOL }))
      resolve({ ws, heard })
    })
  })

/** DEV-479: a TV viewer's socket on `/api/tv/<tvId>`, every message stamped with when it arrived. */
const openTv = (name, tv) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/api/tv/${tv}`, { headers: { Origin: origin } })
    ws.binaryType = 'arraybuffer'
    const heard = []
    ws.addEventListener('message', (e) => {
      heard.push({
        at: performance.now(),
        data: typeof e.data === 'string' ? e.data : new Uint8Array(e.data),
      })
    })
    ws.addEventListener('close', (e) => log(name, 'closed', e.code, e.reason))
    ws.addEventListener('error', () => reject(new Error(`${name}: the TV handshake failed`)))
    ws.addEventListener('open', () => {
      log(name, 'watching TV')
      ws.send(JSON.stringify({ type: 'watch', protocol: PROTOCOL }))
      resolve({ ws, heard })
    })
  })

/**
 * DEV-479: a raw upgrade to `/api/tv/<tvId>`, for what a WebSocket client never
 * shows: the status and every header of the answer. The socket is dropped at
 * once; it never sends `watch`, so it is never a viewer.
 */
const rawTvHandshake = (tv) =>
  new Promise((resolve) => {
    const u = new URL(`${http}/api/tv/${tv}`)
    const lib = u.protocol === 'https:' ? nodeHttps : nodeHttp
    const req = lib.request(u, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
          'base64',
        ),
        Origin: origin,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode, headers: res.rawHeaders.join('\n') })
    })
    req.on('response', (res) => {
      res.resume()
      resolve({ status: res.statusCode, headers: res.rawHeaders.join('\n') })
    })
    req.on('error', (e) => resolve({ status: 0, headers: String(e) }))
    req.end()
  })

/** A batch's frames: [slot, tick] each; null for anything that is not a batch. */
const batchFrames = (b) => {
  if (!(b instanceof Uint8Array) || b[0] !== 0x20 || b.length < 12) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const count = v.getUint16(2, true)
  const out = []
  let at = 12
  for (let i = 0; i < count; i++) {
    const len = v.getUint16(at, true)
    out.push([b[at + 2 + 1], v.getUint32(at + 2 + 4, true)])
    at += 2 + len
  }
  return out
}

const type = (t) => (m) => typeof m === 'object' && !(m instanceof Uint8Array) && m.type === t
const join = (handle, colour) => ({
  type: 'join',
  protocol: PROTOCOL,
  handle,
  variant: 'standard',
  colour,
  content: CONTENT,
})
/** One pose message, one record, its slot byte forged to 99: the room must overwrite it. */
const pose = (tick) => {
  const b = new Uint8Array(8 + 36)
  const v = new DataView(b.buffer)
  b[0] = 0x10
  b[1] = 99
  b[2] = 1
  v.setUint32(4, tick, true)
  v.setInt32(12, 123456, true)
  return b
}
/** POST a lap to the room's judge, as `lap-client.ts`'s `submitRoomLap` does. */
const postLap = async (body) => {
  const r = await fetch(`${http}/api/room/${id}/lap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  return { status: r.status, json, text: json ? undefined : text.slice(0, 200) }
}

const out = { url, origin, protocol: PROTOCOL }
const game = WITH_LAP ? await gameCode() : null
try {
  const rules = game?.rules ?? '1.28a93c83'
  // ROOM_PROTOCOL 2 (DEV-390): the settings carry the course's time limit.
  const SETTINGS = {
    mission: MISSION,
    edition: EDITION,
    bots: true,
    // DEV-477: the course's starts, one ship each (six on every Ring Attack course).
    seats: game?.seats ?? 6,
    colours: 6,
    countdown: 3000,
    timeLimit: game?.timeLimit ?? 180_000,
    rules: { standard: rules },
  }

  const a = await open('A')
  a.send(join(HANDLES[0], 0))
  const ha = await a.wait(type('hello'), 8000, 'hello')
  a.send('ka')
  out.keepalive = await a
    .wait((m) => m === 'ka!', 3000)
    .then(
      () => 'answered',
      () => 'no answer',
    )
  a.send({ type: 'ping', t0: performance.now() })
  const pong = await a.wait(type('pong'), 8000, 'pong')
  out.rttMs = +(performance.now() - pong.t0).toFixed(1)
  a.send({ type: 'configure', settings: SETTINGS })
  const b = await open('B')
  b.send(join(HANDLES[1], 0))
  const hb = await b.wait(type('hello'), 8000, 'hello')
  out.colours = [ha.players[ha.slot].colour, hb.players[hb.slot].colour]
  for (const c of [a, b]) c.send({ type: 'ready', ready: true, rules })
  await a
    .wait(
      (m) =>
        type('lobby')(m) &&
        m.settings !== null &&
        Object.keys(m.players).length === 2 &&
        Object.values(m.players).every((p) => p.ready),
      8000,
      'a lobby with both ready',
    )
    .catch((e) => {
      // Say WHY the lobby never got there: the room's own error, if it sent one.
      const errors = [...a.inbox, ...b.inbox].filter(type('error'))
      throw new Error(
        `${e.message}${errors.length ? ` — room said ${JSON.stringify(errors)}` : ''}`,
      )
    })
  a.send({ type: 'start' })
  const loading = await a.wait(type('loading'), 8000, 'loading')
  await b.wait(type('loading'), 8000, 'loading')
  // DEV-477: every seat on its own start. Two people, the first two, one each;
  // A's lap is flown from A's, the only start the judge will take it from.
  out.starts = [loading.race.starts[ha.slot], loading.race.starts[hb.slot]]
  out.startsDistinct =
    out.starts.every((s) => Number.isInteger(s)) &&
    out.starts[0] !== out.starts[1] &&
    [...out.starts].sort().join() === '0,1'
  const lap = game ? await game.fly(out.starts[0]) : null
  if (lap) {
    log(
      `lap flown from start ${lap.start}: ${lap.ticks} ticks, ${lap.seconds.toFixed(4)} s, rules ${rules}`,
    )
    out.lapFlown = { start: lap.start, ticks: lap.ticks, seconds: +lap.seconds.toFixed(4), rules }
  }
  for (const c of [a, b]) c.send({ type: 'loaded' })
  const [sa, sb] = await Promise.all([
    a.wait(type('start'), 8000, 'start'),
    b.wait(type('start'), 8000, 'start'),
  ])
  out.goAtAgree = sa.goAt === sb.goAt
  a.send(pose(40))
  const pb = await b.wait((m) => m instanceof Uint8Array, 8000, 'a pose')
  out.poseSlotStamped = pb[1] === ha.slot
  b.send(pose(44))
  const pa = await a.wait((m) => m instanceof Uint8Array, 8000, 'a pose')
  out.poseBack = pa[1] === hb.slot && new DataView(pa.buffer).getUint32(4, true) === 44

  // ── the broadcaster, on the platform (DEV-436) ─────────────────────────
  let watchOk = true
  if (WATCH) {
    const viewers = await Promise.all(['V1', 'V2', 'V3'].map(openWatch))
    // Give the broadcaster its feed, then race: both players, every 50 ms.
    await sleep(500)
    const sentAt = new Map()
    for (let i = 0; i < 60; i++) {
      const t = 100 + i * 4
      sentAt.set(t, performance.now())
      a.send(pose(t))
      b.send(pose(t))
      await sleep(50)
    }
    await sleep(3500)
    out.watch = viewers.map((v) => {
      const keyframes = v.heard.filter(
        (h) => typeof h.data === 'string' && h.data.includes('"keyframe"'),
      ).length
      let batches = 0
      const slots = new Set()
      let soonest = Number.POSITIVE_INFINITY
      for (const h of v.heard) {
        const frames = batchFrames(h.data)
        if (!frames) continue
        batches++
        for (const [slot, tick] of frames) {
          slots.add(slot)
          const sent = sentAt.get(tick)
          if (sent !== undefined) soonest = Math.min(soonest, h.at - sent)
        }
      }
      return { keyframes, batches, slots: [...slots].sort(), delayMs: Math.round(soonest) }
    })
    for (const v of viewers) v.ws.close(1000, 'done')
    watchOk = out.watch.every(
      (w) =>
        w.keyframes >= 1 &&
        w.batches > 0 &&
        w.slots.includes(ha.slot) &&
        w.slots.includes(hb.slot) &&
        w.delayMs >= WATCH_DELAY_FLOOR_MS,
    )
  }

  // ── Faceted Flight TV, on the platform (DEV-479) ──────────────────────
  let tvOk = true
  if (TV) {
    const t = {}
    out.tv = t
    // WATCH ME: the room's TV id, asked for by a client that holds the code.
    const me = await fetch(`${http}/api/room/${id}/tv`, { headers: { Origin: origin } })
    t.watchMe = { status: me.status, cache: me.headers.get('cache-control') }
    const tv = me.ok ? (await me.json()).tv : null
    t.id = tv
    t.idShape = typeof tv === 'string' && /^tv_[a-z2-7]{16}$/.test(tv)
    // The list: this race under its TV id, and the room's id nowhere in it.
    await sleep(500)
    const listed = await fetch(`${http}/api/tv`, { headers: { Origin: origin } })
    const listText = await listed.text()
    let races = []
    try {
      races = JSON.parse(listText).races ?? []
    } catch {}
    t.list = {
      status: listed.status,
      cache: listed.headers.get('cache-control'),
      listed: races.some((r) => r.tv === tv),
      roomIdInList: listText.includes(id),
    }
    // A stale id: 404 before any upgrade.
    const stale = await fetch(`${http}/api/tv/tv_${'a'.repeat(16)}`, {
      headers: { Origin: origin },
    })
    t.staleStatus = stale.status
    // The short link.
    const short = await fetch(`${http}/tv/${tv}?follow=2`, {
      redirect: 'manual',
      headers: { Origin: origin },
    })
    t.shortLink = { status: short.status, location: short.headers.get('location') }
    // The 101, raw: no header may name the room or a racer.
    const hs = await rawTvHandshake(tv)
    t.handshake = {
      status: hs.status,
      roomId: hs.headers.includes(id),
      handle: HANDLES.some((h) => hs.headers.includes(h)),
    }
    // Three TV viewers through a stretch of the race.
    const viewers = await Promise.all(['T1', 'T2', 'T3'].map((n) => openTv(n, tv)))
    await sleep(500)
    const sentAt = new Map()
    for (let i = 0; i < 60; i++) {
      const tick = 400 + i * 4
      sentAt.set(tick, performance.now())
      a.send(pose(tick))
      b.send(pose(tick))
      await sleep(50)
    }
    await sleep(3500)
    const secrets = [
      id,
      ...HANDLES,
      ...HANDLES.flatMap((h) => h.split(' ')).filter((w) => w.length >= 4),
    ]
    t.viewers = viewers.map((v) => {
      let batches = 0
      let soonest = Number.POSITIVE_INFINITY
      const slots = new Set()
      const leaks = new Set()
      let racerNames = []
      for (const h of v.heard) {
        const text = typeof h.data === 'string' ? h.data : Buffer.from(h.data).toString('latin1')
        for (const s of secrets) if (text.includes(s)) leaks.add(s)
        if (typeof h.data === 'string' && h.data.includes('"keyframe"')) {
          racerNames = Object.values(JSON.parse(h.data).players ?? {}).map((p) => p.handle)
        }
        const frames = batchFrames(h.data)
        if (!frames) continue
        batches++
        for (const [slot, tick] of frames) {
          slots.add(slot)
          const sent = sentAt.get(tick)
          if (sent !== undefined) soonest = Math.min(soonest, h.at - sent)
        }
      }
      return {
        batches,
        slots: [...slots].sort(),
        delayMs: Math.round(soonest),
        racerNames: racerNames.sort(),
        leaks: [...leaks],
      }
    })
    for (const v of viewers) v.ws.close(1000, 'done')
    tvOk =
      me.status === 200 &&
      t.idShape &&
      t.watchMe.cache === 'no-store' &&
      listed.status === 200 &&
      t.list.listed &&
      !t.list.roomIdInList &&
      t.staleStatus === 404 &&
      t.shortLink.status === 302 &&
      t.shortLink.location === `/?tv=${tv}&follow=2` &&
      t.handshake.status === 101 &&
      !t.handshake.roomId &&
      !t.handshake.handle &&
      t.viewers.every(
        (v) =>
          v.batches > 0 &&
          v.slots.includes(ha.slot) &&
          v.slots.includes(hb.slot) &&
          v.delayMs >= WATCH_DELAY_FLOOR_MS &&
          v.leaks.length === 0 &&
          v.racerNames.includes(`Racer ${ha.slot + 1}`) &&
          v.racerNames.includes(`Racer ${hb.slot + 1}`),
      )
  }

  // ── the judge, on the platform (DEV-390) ──────────────────────────────
  let judgedOk = true
  if (lap) {
    const judged = await postLap({
      lap: lap.wire,
      seconds: lap.seconds,
      seat: ha.seat,
      tainted: false,
    })
    const v = judged.json?.verdict ?? null
    out.judged = {
      status: judged.status,
      verdict: v?.verdict ?? null,
      ticks: v?.ticks ?? null,
      body: judged.text,
    }
    const heard = (c) =>
      c
        .wait(
          (m) =>
            type('results')(m) &&
            m.results.some(
              (r) => r.slot === ha.slot && r.verdict === 'ok' && r.ticks === lap.ticks,
            ),
          8000,
          'the verdict in results',
        )
        .then(
          () => true,
          () => false,
        )
    out.resultsHeard = await Promise.all([heard(a), heard(b)])
    const kept = await fetch(`${http}/api/room/${id}/lap?slot=${ha.slot}`)
    const keptBody = kept.ok ? await kept.json() : null
    out.keptLap = { status: kept.status, same: keptBody?.lap === lap.wire }
    const forged = await postLap({
      lap: lap.wire,
      seconds: lap.seconds - 10,
      seat: hb.seat,
      tainted: false,
    })
    const fv = forged.json?.verdict ?? null
    out.forged = {
      status: forged.status,
      verdict: fv?.verdict ?? null,
      seconds: fv?.seconds ?? null,
    }
    const again = await postLap({
      lap: lap.wire,
      seconds: lap.seconds,
      seat: ha.seat,
      tainted: false,
    })
    out.secondPost = again.status
    judgedOk =
      judged.status === 200 &&
      v?.verdict === 'ok' &&
      v?.ticks === lap.ticks &&
      out.resultsHeard.every(Boolean) &&
      out.keptLap.status === 200 &&
      out.keptLap.same &&
      forged.status === 200 &&
      fv?.verdict !== 'ok' &&
      fv?.seconds === null &&
      again.status === 403
  }

  const c = await open('C')
  const closed = new Promise((r) => c.ws.addEventListener('close', (e) => r(e.code)))
  c.send(join('Brave Comet 33', 2))
  out.lateJoin = await closed
  a.ws.close(1000, 'done')
  b.ws.close(1000, 'done')
  out.ok =
    out.goAtAgree &&
    out.startsDistinct &&
    out.poseSlotStamped &&
    out.poseBack &&
    out.lateJoin === 4001 &&
    out.colours[0] !== out.colours[1] &&
    judgedOk &&
    watchOk &&
    tvOk
} catch (e) {
  out.error = String(e)
  out.ok = false
} finally {
  await game?.close()
}
console.log(JSON.stringify(out, null, 1))
setTimeout(() => process.exit(out.ok ? 0 : 1), 200)
