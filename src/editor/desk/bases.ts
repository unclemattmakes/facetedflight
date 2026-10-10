// src/editor/desk/bases.ts — what the editor calls a course's BASE. DEV-499.
//
// Matt, 2026-09-28: *"change 'sky' to 'base' and list the place instead of
// mission"*. A course borrows a shipped mission's world and its default light
// (the format's `sky` field, which keeps its name so no id moves); the picker
// now names the PLACE (`mission-index.ts`'s environment names, the level
// select's own) and, where one place has two bases, a word DERIVED from the
// bases' own data — never typed per mission:
//
//   - always the sun: `low sun` under `BASE_LABEL.lowSunDeg` of elevation,
//     else `high sun` (alpine's two: the 0.08° sunset against 46°);
//   - and for a place whose bases still read alike, the FIRST of these that
//     tells that group apart: the sun's elevation to the degree (the canyon's
//     two high suns, 43° and 53°); the compass point of the base's lift from
//     the world's origin (three space: +x east, -z north), for bases with the
//     same light, which Simonet's two have; the mission's title, which no
//     shipped base reaches.
//
// `tests/unit/editor-bases.test.ts` holds all seven HoverJet bases distinct.

import type { Level } from '@/content/level-schema'
import { environmentDisplayName } from '@/game/mission-index'

/** Policy, pinned by value in the test. */
export const BASE_LABEL = {
  /** Degrees of sun elevation under which a base is a `low sun` one. */
  lowSunDeg: 20,
} as const

const POINTS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const

/** The compass point of (x, z) in three space (+x east, -z north), from the origin. */
export const compassPoint = (x: number, z: number): (typeof POINTS)[number] => {
  // Bearing clockwise from north, in eighths.
  const bearing = Math.atan2(x, -z) / (Math.PI / 4)
  const i = ((Math.round(bearing) % 8) + 8) % 8
  return POINTS[i] as (typeof POINTS)[number]
}

const sunWord = (l: Level): string => {
  const sun = l.lighting?.sun
  if (!sun) return 'no sun'
  return sun.elevationDeg < BASE_LABEL.lowSunDeg ? 'low sun' : 'high sun'
}

/**
 * Each base's label, `Place · sun[ · word]`, keyed by mission id: the place and
 * its sun, and for bases of one place that still read alike, the FIRST of the
 * header's tie-breaks that tells that group apart (see the header).
 */
export const baseLabels = (levels: readonly Level[]): ReadonlyMap<string, string> => {
  const breaks: ((l: Level) => string)[] = [
    (l) => `${Math.round(l.lighting?.sun?.elevationDeg ?? 0)}°`,
    (l) => `${compassPoint(l.spawn.pos[0], l.spawn.pos[2])} lift`,
    (l) => l.title,
  ]
  const label = new Map<string, string>(
    levels.map((l) => [l.id, `${environmentDisplayName(l.environment)} · ${sunWord(l)}`]),
  )
  const groups = new Map<string, Level[]>()
  for (const l of levels) {
    const k = label.get(l.id) as string
    groups.set(k, [...(groups.get(k) ?? []), l])
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const tell = breaks.find((f) => new Set(group.map(f)).size === group.length) ?? breaks[2]
    if (!tell) continue
    for (const l of group) label.set(l.id, `${label.get(l.id)} · ${tell(l)}`)
  }
  return label
}
