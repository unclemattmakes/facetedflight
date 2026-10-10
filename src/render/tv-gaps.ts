// src/render/tv-gaps.ts: the gap to the leader, and a split on the racer the
// camera follows. DEV-653 (c3).
//
// A broadcast shows a gap as a time ("+1.4"), not as a distance, and a time
// behind is only honest if it is MEASURED AT THE SAME GATE: the clock at which
// the leader crossed gate g, against the clock at which this racer crossed it.
// Never an estimate from speed and distance (the rule DEV-649 gives the
// player's own splits). So this keeps, per racer, the race clock at which each
// gate's crossing was SEEN, and a gap is a difference of two of those.
//
// The clock is the feed's `raceSeconds`, read each frame, so a crossing is
// timed to one display frame (about 14 ms at 72 Hz): finer than the one decimal
// it is printed to. A live race's feed counts a ring once the DRAWN ship has
// flown it (`roomPassedAt`), so a live gap is in the same delayed time for every
// racer and the differences are the race's own.
//
// Pure: plain values in, plain values out.

import type { TvPanelFeed, TvPanelRow, TvSplit } from './tv-panel-layout'

/** A split is taken every this many gates, and at the last. */
export const TV_SPLIT_EVERY = 4
/** And stands this long once it can be said, seconds. */
export const TV_SPLIT_SECONDS = 2.5

export interface TvGaps {
  /** The feed with each row's `gap` and the followed racer's `split` filled in. */
  observe(feed: TvPanelFeed): TvPanelFeed
  /** Forget every clock (a new race). */
  reset(): void
}

export const createTvGaps = (): TvGaps => {
  /** Row key -> the race clock at which each gate (index) was first seen crossed. */
  const times = new Map<string, number[]>()
  let lastClock = Number.NEGATIVE_INFINITY
  let lastCourse = ''
  let pending: { key: string; gate: number; from: number | null } | null = null
  let splitKeyDone = ''
  let shown: { split: TvSplit; until: number } | null = null

  const reset = (): void => {
    times.clear()
    lastClock = Number.NEGATIVE_INFINITY
    pending = null
    splitKeyDone = ''
    shown = null
  }

  const timeAt = (key: string, gate: number): number | undefined => times.get(key)?.[gate]

  return {
    reset,
    observe(feed) {
      if (feed.phase !== 'racing') {
        if (times.size > 0) reset()
        return feed
      }
      const clock = feed.raceSeconds
      if (clock < lastClock - 0.5 || feed.course !== lastCourse) reset()
      lastClock = clock
      lastCourse = feed.course
      for (const row of feed.rows) {
        if (row.rings === null || row.kind === 'ghost') continue
        const list = times.get(row.key) ?? []
        for (let g = list.length; g < row.rings; g++) list[g] = clock
        times.set(row.key, list)
      }
      const leader = feed.rows[0]
      const gapOf = (row: TvPanelRow): number | null => {
        if (row.status !== 'flying' || row.rings === null || row.kind === 'ghost') return null
        if (leader && row.key === leader.key) return 0
        if (leader?.status !== 'flying') return null
        const g = row.rings - 1
        if (g < 0) return null
        const mine = timeAt(row.key, g)
        const theirs = timeAt(leader.key, g)
        return mine === undefined || theirs === undefined ? null : Math.max(0, mine - theirs)
      }
      const rows = feed.rows.map((r) => {
        const gap = gapOf(r)
        return gap === null ? r : { ...r, gap }
      })

      // A split on the followed racer: at each fourth gate and the last.
      const me = feed.followed === null ? undefined : rows.find((r) => r.key === feed.followed)
      if (!me || me.rings === null || me.kind === 'ghost') {
        pending = null
      } else {
        const gate = me.rings
        const due = gate > 0 && (gate % TV_SPLIT_EVERY === 0 || gate === feed.gates)
        if (due && splitKeyDone !== `${me.key}:${gate}`) {
          splitKeyDone = `${me.key}:${gate}`
          pending = { key: me.key, gate, from: null }
        }
        if (pending && pending.key !== me.key) pending = null
      }
      if (pending) {
        const mine = timeAt(pending.key, pending.gate - 1)
        const place = rows.findIndex((r) => r.key === pending?.key)
        // Behind the racer ahead of it; the leader against the one behind it.
        const other = place > 0 ? rows[place - 1] : rows[place + 1]
        const theirs = other ? timeAt(other.key, pending.gate - 1) : undefined
        if (mine !== undefined && theirs !== undefined && other) {
          const seconds = mine - theirs
          pending.from ??= clock
          shown = { split: { gate: pending.gate, seconds }, until: pending.from + TV_SPLIT_SECONDS }
        }
      }
      if (!pending) shown = null
      if (shown && clock > shown.until) {
        shown = null
        pending = null
      }
      return shown ? { ...feed, rows, split: shown.split } : { ...feed, rows }
    },
  }
}
