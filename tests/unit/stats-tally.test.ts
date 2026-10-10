// tests/unit/stats-tally.test.ts: the game's half of a statistics row. DEV-590
// and DEV-591; docs/plan/ANALYTICS.md §4.
//
// Every row the tally builds is put through the SERVER's own check (`toPoint`),
// so a field the game sends and the schema does not list fails here, on the
// machine that wrote it, rather than vanishing silently in production.

import { describe, expect, it } from 'vitest'
import {
  AttemptTally,
  bugRow,
  ErrorTally,
  ownFrame,
  statsAllowed,
  type VisitReading,
  VisitTally,
} from '@/game/stats-tally'
import {
  STATS_CRASHES_PER_ATTEMPT,
  STATS_ERRORS_PER_VISIT,
  type StatsRow,
} from '@/net/stats-schema'
import { toPoint } from '@/net/stats-server'

const reading = (now: number, over: Partial<VisitReading> = {}): VisitReading => ({
  build: 'v0.18.0',
  channel: 'release',
  device: 'desktop',
  gate: 'ok',
  xrBlocker: 'none',
  quality: 'high',
  qualityAuto: true,
  scale: 0.8,
  look: 'anniversary',
  vignette: 'light',
  speedFx: 'full',
  horizon: false,
  now,
  ...over,
})

const valid = async (row: StatsRow) => {
  const point = await toPoint(row, 'NZ')
  expect(point, JSON.stringify(row)).not.toBeNull()
  return point
}

describe('DEV-590: the visit row', () => {
  it('builds a row the server accepts, before and after anything has happened', async () => {
    await valid(new VisitTally().row(reading(0.4)))
    const t = new VisitTally()
    t.titleShown(7.5)
    t.stage('hangar')
    t.stage('mission')
    t.xr('offered')
    t.xrSessionStarted(30)
    t.input('keyboard')
    t.input('xrControllers')
    t.count('attempts', 3)
    t.frameSample(11, 16, 2)
    const row = t.row(reading(400))
    await valid(row)
    expect(row).toMatchObject({
      stage: 'mission',
      xr: 'started',
      toTitle: '5-10',
      visitTime: '3-10m',
      vrTime: '3-10m',
      scale: '0.8',
      frameP50: '90',
      frameP95: '60',
      stageBefore: 0,
      xrBefore: 0,
      keyboard: 1,
      gamepad: 0,
      xrControllers: 1,
      attempts: 3,
      hitches: 2,
    })
  })

  it('only ever moves the stage and the XR outcome forward', () => {
    const t = new VisitTally()
    t.stage('mission')
    t.stage('title')
    t.xr('started')
    t.xr('offered')
    expect(t.row(reading(1))).toMatchObject({ stage: 'mission', xr: 'started' })
  })

  it('a second send carries only what accrued since, and says where the first stood', () => {
    const t = new VisitTally()
    t.titleShown(4)
    t.count('attempts', 2)
    const one = t.row(reading(100))
    expect(one).toMatchObject({ stageBefore: 0, stage: 'title', attempts: 2, toTitle: 'lt5' })
    expect(t.changedSinceSent).toBe(false)

    t.stage('finished')
    t.count('attempts')
    t.count('finishes')
    expect(t.changedSinceSent).toBe(true)
    const two = t.row(reading(130))
    // Index + 1 of `title` in the stage list; the time to title went once.
    expect(two).toMatchObject({
      stageBefore: 2,
      stage: 'finished',
      attempts: 1,
      finishes: 1,
      toTitle: 'none',
    })
    expect(two.visitTime).toBe('lt1m')
    // The funnel rule in docs/stats.md: each stage is reached by exactly one row.
    const stages = ['booted', 'title', 'hangar', 'mission', 'finished']
    for (const s of stages) {
      const at = stages.indexOf(s) + 1
      const reached = [one, two].filter(
        (r) => (r.stageBefore as number) < at && at <= stages.indexOf(r.stage as string) + 1,
      )
      expect(reached, s).toHaveLength(1)
    }
  })

  it('splits time in a headset across sends, and counts an open session up to now', () => {
    const t = new VisitTally()
    t.xrSessionStarted(10)
    expect(t.row(reading(80)).vrTime).toBe('1-3m') // 70 s, still in it
    t.xrSessionEnded(100)
    expect(t.row(reading(500)).vrTime).toBe('lt1m') // the 30 s since
    expect(t.row(reading(900)).vrTime).toBe('0')
  })

  it('reports the most common frame bucket, and none with no samples', () => {
    const t = new VisitTally()
    expect(t.row(reading(1))).toMatchObject({ frameP50: 'none', frameP95: 'none' })
    t.frameSample(16, 30, 0)
    t.frameSample(16.5, 30, 0)
    t.frameSample(10, 12, 0)
    t.frameSample(0, 0, 0) // an empty window is not a sample
    expect(t.row(reading(2))).toMatchObject({ frameP50: '60', frameP95: '30' })
  })

  it('sends a scale off the ladder as `other`', () => {
    expect(new VisitTally().row(reading(1, { scale: 0.73 })).scale).toBe('other')
    expect(new VisitTally().row(reading(1, { scale: 1 })).scale).toBe('1')
  })
})

describe('DEV-591: the error rows', () => {
  const who = { build: 'v0.18.0', channel: 'release', device: 'phone' } as const

  it('keeps one row per distinct cleaned message, up to the cap, and the server accepts each', async () => {
    const t = new ErrorTally()
    expect(t.note('error', 'chunk 12 failed', 'assets/index-a.js:10', who)).toBe(true)
    expect(t.note('error', 'chunk 977 failed', 'assets/index-a.js:10', who)).toBe(false)
    expect(t.note('rejection', 'chunk 12 failed', 'assets/index-a.js:10', who)).toBe(true)
    for (let i = 0; i < 10; i++) t.note('error', `distinct ${'x'.repeat(i)}`, 'none', who)
    const rows = t.take()
    expect(rows).toHaveLength(STATS_ERRORS_PER_VISIT)
    expect(rows[0]?.message).toBe('chunk # failed')
    for (const row of rows) await valid(row)
    expect(t.take()).toEqual([])
  })

  it('finds our own frame and nobody else’s', () => {
    const origin = 'https://facetedflight.net'
    const stack = [
      'TypeError: x is undefined',
      '    at chrome-extension://abcdef/content.js:1:2',
      `    at run (${origin}/assets/index-B4x9.js?v=2:4211:17)`,
      `    at ${origin}/assets/other.js:1:1`,
    ].join('\n')
    expect(ownFrame(stack, origin)).toBe('assets/index-B4x9.js:4211')
    expect(ownFrame(`at go (${origin}/src/boot/app.ts:120:3)`, origin)).toBe('src/boot/app.ts:120')
    expect(ownFrame('at chrome-extension://abcdef/content.js:1:2', origin)).toBe('none')
    expect(ownFrame(undefined, origin)).toBe('none')
  })
})

describe('DEV-590: when a page sends nothing at all', () => {
  const player = {
    production: true,
    hostname: 'facetedflight.net',
    search: '',
    gpc: false,
    dnt: false,
    optedOut: false,
  }

  it('a player on the live site, with or without a link the game hands out, sends', () => {
    expect(statsAllowed(player)).toBe(true)
    for (const search of [
      '?room=K7QX4M2',
      '?tv=12&follow=3',
      '?ghost=abc',
      '?mission=int_01_hoverJet&edition=classic',
      '?utm_source=steam&utm_medium=page',
      '?fbclid=xyz',
    ]) {
      expect(statsAllowed({ ...player, search }), search).toBe(true)
    }
  })

  it('an opt-out, Global Privacy Control or Do Not Track sends nothing', () => {
    expect(statsAllowed({ ...player, optedOut: true })).toBe(false)
    expect(statsAllowed({ ...player, gpc: true })).toBe(false)
    expect(statsAllowed({ ...player, dnt: true })).toBe(false)
  })

  it('a development build, this machine or a LAN address sends nothing', () => {
    expect(statsAllowed({ ...player, production: false })).toBe(false)
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      '[::1]',
      'ff.localhost',
      'ff.test',
      'box.local',
      '192.168.1.20',
      '10.0.0.5',
      '172.20.1.1',
    ]) {
      expect(statsAllowed({ ...player, hostname }), hostname).toBe(false)
    }
    expect(statsAllowed({ ...player, hostname: 'ff-10yr.pages.dev' })).toBe(true)
    expect(statsAllowed({ ...player, hostname: '172.32.0.1' })).toBe(true)
  })

  it('any development or measurement switch sends nothing, a presentation one included', () => {
    for (const search of [
      '?perf=1',
      '?quality=low',
      '?view=cam',
      '?trace=30',
      '?lookdev=1',
      '?room=A&perf=1',
    ]) {
      expect(statsAllowed({ ...player, search }), search).toBe(false)
    }
  })
})

describe('DEV-593: attempts and crashes', () => {
  const run = {
    mission: 'int_01_hoverJet',
    mode: 'ringAttack',
    look: 'classic',
    opponents: 'ai',
    variant: 'standard',
    ringsTaken: 21,
    ringsTotal: 21,
    crashes: 2,
    elapsed: 83.6,
  } as const
  const who = { build: 'v0.20.0', channel: 'release', device: 'headset' } as const

  it('writes nothing with no attempt open', () => {
    const t = new AttemptTally()
    expect(t.crash('crash', { x: 0, y: 0, z: 0 }, run, who)).toBeNull()
    expect(t.end('quit', 'none', run, who)).toBeNull()
  })

  it('a finish carries its medal and whole seconds; a quit its bucket and no medal; the server takes both', async () => {
    const t = new AttemptTally()
    t.start(1)
    const done = t.end('finished', 'gold', run, who)
    expect(done).toMatchObject({
      ending: 'finished',
      medal: 'gold',
      seconds: 84,
      quitTime: 'none',
      attemptNo: '1',
    })
    await valid(done as StatsRow)
    t.start(12)
    const quit = t.end('quit', 'gold', { ...run, ringsTaken: 9, elapsed: 70 }, who)
    expect(quit).toMatchObject({
      medal: 'none',
      seconds: 0,
      quitTime: '1-3m',
      lastRing: 9,
      attemptNo: '11+',
    })
    await valid(quit as StatsRow)
    expect(t.isOpen).toBe(false)
  })

  it('caps crash rows per go, counts every reset, and a crash row carries no time or order', async () => {
    const t = new AttemptTally()
    t.start(2)
    const rows = []
    for (let i = 0; i < 12; i++) {
      const row = t.crash(
        i % 2 ? 'out-of-bounds' : 'crash',
        { x: i * 100, y: 30, z: -i * 100 },
        run,
        who,
      )
      if (row) rows.push(row)
    }
    expect(rows).toHaveLength(STATS_CRASHES_PER_ATTEMPT)
    for (const row of rows) {
      await valid(row)
      expect(Object.keys(row).sort()).toEqual([
        'altitude',
        'build',
        'cause',
        'cell',
        'channel',
        'k',
        'look',
        'mission',
      ])
    }
    expect(rows[1]).toMatchObject({ cause: 'out-of-bounds', cell: '2:-2', altitude: '25-100' })
    expect(t.end('restarted', 'none', run, who)).toMatchObject({ resets: 6 })
  })
})

describe('DEV-622: a bug report', () => {
  it('carries where the player is and the last errors, cleaned and padded, and the server takes it', async () => {
    const row = bugRow(
      { screen: 'hangar', mission: 'custom', tick: 0 },
      {
        build: 'v0.20.0',
        channel: 'release',
        device: 'phone',
        quality: 'ultra',
        scale: 0.7,
        look: 'anniversary',
      },
      ['old one', 'chunk 12 failed at https://x.example/a.js'],
    )
    expect(row).toMatchObject({
      k: 'bug',
      screen: 'hangar',
      scale: '0.7',
      error1: 'old one',
      error2: 'chunk # failed at <url>',
      error3: 'none',
    })
    await valid(row)
    const keys = Object.keys(row)
    for (const personal of ['handle', 'owner', 'text', 'note', 'email', 'name'])
      expect(keys).not.toContain(personal)
  })
})
