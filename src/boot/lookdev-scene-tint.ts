// src/boot/lookdev-scene-tint.ts — the scene tint's `?lookdev=1` group. DEV-446.
//
// Matt asked to tint the scene "similar to how I did in 2016", which was in an
// inspector, live, on the scene in front of him. This is that: a colour picker
// and a strength slider on the mission you are flying, and a **Copy JSON** that
// hands back the exact row to paste under `render.sceneTint.missions` in the
// preset file. `lookdev.ts`'s contract holds — nothing here writes a file,
// nothing persists across a reload, and the preset is still the source of
// truth.
//
// It writes the tint's OVERRIDE, never the preset: the override wins while set,
// so the frame shows what the panel says; and it is cleared whenever the panel
// is built for a world, so a course switch starts from the new mission's own
// value rather than wearing the last one's.

import type { Edition } from '@/content/edition-schema'
import { resolveSceneTint, type SceneTint } from '@/render/scene-tint'
import type { LookdevGroup } from './lookdev'

/** Four decimals: finer than the picker's 8 bits can say, so nothing is lost. */
const round4 = (v: number): number => Number(v.toFixed(4))

/**
 * The group, or null where it would be inert: on a preset with the feature
 * off (Classic), the tint resolves to none whatever the panel says, and
 * `buildLookdev`'s rule is that an inert slider is worse than a missing one.
 */
export const sceneTintLookdevGroup = (
  tint: Pick<SceneTint, 'setOverride'>,
  edition: Edition,
  levelId: string,
): LookdevGroup | null => {
  // A new world, a new panel: the last mission's authoring value goes.
  tint.setOverride(null)
  const block = edition.render.sceneTint
  if (!block.enabled) return null

  const start = resolveSceneTint(block, levelId)
  const live = {
    color: [start.color[0], start.color[1], start.color[2]] as [number, number, number],
    strength: start.strength,
  }
  const push = (): void => {
    tint.setOverride({
      color: [live.color[0], live.color[1], live.color[2]],
      strength: live.strength,
    })
  }
  const file = `content/editions/${edition.id}.json`
  const row = `render.sceneTint.missions.${levelId}`

  return {
    title: `scene tint — ${levelId} (DEV-446)`,
    colors: [
      {
        // Brightness is divided out (`render/scene-tint.ts`), so the label
        // says so: a person dragging toward black to "darken" it would
        // otherwise think the control was broken.
        label: 'colour (hue + saturation; its brightness is ignored)',
        get: () => live.color,
        set: (c) => {
          live.color = c
          push()
        },
        source: `${file}  ${row}.color = %`,
      },
    ],
    controls: [
      {
        label: 'strength (0 none — 1 all of it)',
        min: 0,
        max: 1,
        step: 0.01,
        get: () => live.strength,
        set: (v) => {
          live.strength = v
          push()
        },
        source: `${file}  ${row}.strength = %`,
        digits: 2,
      },
    ],
    json: {
      path: `${file} ${row}`,
      value: () => ({ color: live.color.map(round4), strength: round4(live.strength) }),
    },
  }
}
