// src/boot/lookdev-fog.ts — the fog's `?lookdev=1` group: every parameter that
// shapes it. DEV-455.
//
// Matt, 2026-09-27: *"let's keep our height fog - is it all tunable with
// lookdev enabled?"* It was not: the group had DEV-018's thinning, the plane's
// height, the start distance and the inverted switch. This is all of it — the
// two densities on their own, the colour, the linear pair where the mission's
// mode reads it, and the switches for each half of the fog and for the sky's
// colour — every one a uniform through `UnityFog.retune`, so dragging anything
// recompiles nothing.
//
// `lookdev.ts`'s contract holds: every control starts where the build is (read
// off `fog.tuning`), ends in a `source` line naming where its number lives, and
// nothing is written anywhere. A control this mission's fog would not read is
// left out rather than shown inert: the linear pair appears on a `mode` 1 fog
// only (no shipped mission has one), and the sky switch only where there is a
// decoded sky to fog toward.
//
// ── Where the numbers live, and which of them are 2016's ─────────────────
//
// Two homes, and the source lines say which: FF2's own replacement fog
// (`unity-fog.ts`: `FF2_FOG_THINNING`, `FF2_FOG_REPLACEMENT`, `FF2_FOG_INVERTED`,
// DEV-018 / DEV-031 / DEV-098 — the amount, the plane, which half is dense) and
// the mission's own 2016 values in the level JSON (the colour, the start, the
// mode's pair, the two flags). The level JSON is GENERATED, so a change there
// is not a paste: it is a per-mission override in `ff2Fog`, with a row. The
// line says so rather than inviting a hand edit.

import { FF2_FOG_INVERTED, FF2_FOG_THINNING, FOG_LINEAR, type UnityFog } from '@/render/unity-fog'
import type { LookdevControl, LookdevGroup, LookdevToggle } from './lookdev'

/** The level JSON is generated: a change there is an override with a row, not an edit. */
const LEVEL = 'level JSON (generated: a change is an ff2Fog override + a DEVIATIONS row)'

export const fogLookdevGroup = (fog: UnityFog, levelId: string): LookdevGroup => {
  const start = fog.tuning
  // The two densities BEFORE the thinning, which is how `unity-fog.ts` writes
  // them (`density: 0.00025 * FF2_FOG_THINNING`), so each slider's number
  // pastes where it lives and the thinning stays the one multiplier over both.
  const state = {
    thinning: 1,
    density: start.density / FF2_FOG_THINNING,
    heightDensity: start.heightDensity / FF2_FOG_THINNING,
  }
  const pushDensities = (): void => {
    fog.retune({
      density: state.density * FF2_FOG_THINNING * state.thinning,
      heightDensity: state.heightDensity * FF2_FOG_THINNING * state.thinning,
    })
  }

  const controls: LookdevControl[] = [
    {
      // `tests/e2e/lookdev.spec.ts` finds this slider by the word in its label,
      // so no other control in the panel may carry that word — the two density
      // labels below say "the multiplier above" for that reason.
      label: 'thinning x (both densities)',
      min: 0.1,
      max: 2,
      step: 0.01,
      get: () => state.thinning,
      set: (v) => {
        state.thinning = v
        pushDensities()
      },
      source: `unity-fog.ts  FF2_FOG_THINNING = ${FF2_FOG_THINNING} * %`,
      digits: 2,
    },
  ]
  // The distance fog's own density, where the mode reads one (2 and 3).
  if (start.mode !== FOG_LINEAR) {
    controls.push({
      label: `distance density (base, x the multiplier above; mode ${start.mode === 2 ? 'exp' : 'exp2'})`,
      min: 0,
      max: 0.002,
      step: 0.00001,
      get: () => state.density,
      set: (v) => {
        state.density = v
        pushDensities()
      },
      source: 'unity-fog.ts  FF2_FOG_REPLACEMENT.density = % * FF2_FOG_THINNING',
      digits: 5,
    })
  }
  controls.push(
    {
      label: 'height density (base, x the multiplier above)',
      min: 0,
      max: 0.3,
      step: 0.001,
      get: () => state.heightDensity,
      set: (v) => {
        state.heightDensity = v
        pushDensities()
      },
      source: 'unity-fog.ts  FF2_FOG_REPLACEMENT.heightDensity = % * FF2_FOG_THINNING',
      digits: 3,
    },
    {
      label: 'plane height (m)',
      min: 0,
      max: 900,
      step: 1,
      get: () => start.height,
      set: (v) => fog.retune({ height: v }),
      source: 'unity-fog.ts  FF2_FOG_REPLACEMENT.height = %',
      digits: 0,
    },
    {
      label: 'start distance (m)',
      min: 0,
      max: 2000,
      step: 10,
      get: () => start.startDistance,
      set: (v) => fog.retune({ startDistance: v }),
      source: `${LEVEL}  ${levelId} fog.startDistance = %`,
      digits: 0,
    },
  )
  // Linear mode's pair, only where the mode reads it. No shipped mission's does
  // (every one is 2 or 3), so on the thirteen this block is absent by design.
  if (start.mode === FOG_LINEAR) {
    controls.push(
      {
        label: 'linear start (m)',
        min: 0,
        max: 6000,
        step: 10,
        get: () => start.linearStart,
        set: (v) => fog.retune({ linearStart: v }),
        source: `${LEVEL}  ${levelId} fog.linearStart = %`,
        digits: 0,
      },
      {
        label: 'linear end (m)',
        min: 0,
        max: 12000,
        step: 10,
        get: () => start.linearEnd,
        set: (v) => fog.retune({ linearEnd: v }),
        source: `${LEVEL}  ${levelId} fog.linearEnd = %`,
        digits: 0,
      },
    )
  }

  const toggles: LookdevToggle[] = [
    {
      label: 'dense ABOVE the plane',
      get: () => FF2_FOG_INVERTED,
      set: (v: boolean) => fog.retune({ inverted: v }),
      source: 'unity-fog.ts  FF2_FOG_INVERTED = %',
    },
    {
      label: 'distance fog on',
      get: () => start.distanceFog,
      set: (v: boolean) => fog.retune({ distanceFog: v }),
      source: `${LEVEL}  ${levelId} fog.distanceFog = %`,
    },
    {
      label: 'height fog on (FF2 keeps it: DEV-455)',
      get: () => start.heightFog,
      set: (v: boolean) => fog.retune({ heightFog: v }),
      source: `${LEVEL}  ${levelId} fog.heightFog = %`,
    },
  ]
  if (start.skyAvailable) {
    toggles.push({
      label: "fog takes the sky's colour (DEV-030; off = the flat colour)",
      get: () => start.skyColour,
      set: (v: boolean) => fog.retune({ skyColour: v }),
      source: 'app.ts  FOG_TAKES_SKY_COLOUR (?fogsky=off) = %',
    })
  }

  return {
    title: 'fog',
    colors: [
      {
        // Where the fog takes the sky's colour this is not what it fades to;
        // the label says so rather than leaving a picker that seems broken.
        label: start.skyAvailable
          ? 'colour, sRGB (used when the sky-colour switch is off)'
          : 'colour, sRGB (RenderSettings.m_FogColor)',
        get: () => start.colorSrgb,
        set: (c) => fog.retune({ colorSrgb: c }),
        source: `${LEVEL}  ${levelId} fog.color = %`,
      },
    ],
    controls,
    toggles,
  }
}
