// src/boot/app/lookdev-panel.ts — what `?lookdev=1`'s panel reaches: the
// switch, the placement tuning it writes back, and the panel's groups.
//
// Moved verbatim out of `boot/app.ts` (APP-SPLIT phase 1,
// `docs/plan/APP-SPLIT.md`), with `export` added and nothing else.
// `buildLookdev` already took every live value it reads as a parameter, which
// is what let it leave the closure in one piece. The panel's machinery is
// `boot/lookdev.ts`; this is the game's half of it.

import type * as THREE from 'three'
import type {
  EditionCockpit,
  EditionHudPlacement,
  EditionThirdPerson,
} from '@/content/edition-schema'
import type { LoadedClouds } from '@/game/clouds'
import type { EditionState } from '@/game/edition'
import type { Bloom } from '@/render/bloom'
import type { FlatFov } from '@/render/flat-fov'
import type { IllustrativeLighting } from '@/render/illustrative'
import type { Sky, SkyTuning } from '@/render/sky'
import type { UnityFog } from '@/render/unity-fog'
import { createLookdev, type Lookdev, type LookdevControl, type LookdevGroup } from '../lookdev'
import { fogLookdevGroup } from '../lookdev-fog'
import { params } from './pins'

/**
 * `?lookdev=1` — the in-game tuning panel, `L` to toggle.
 *
 * Matt: *"stub out an in-game lookdev menu where i can tune tweakable settings
 * in realtime."* Off by default and never in a headset: it is DOM, and
 * `dom-overlay` is not reliably granted on Quest. Tune on the monitor, fly in
 * the headset.
 */
export const LOOKDEV = params.get('lookdev') === '1'

/**
 * What the lookdev panel can reach, and what it writes back.
 *
 * Deliberately short. Every control here is a number I have already had to
 * guess at least once — the fog multiplier three times, the cloud lift twice —
 * and every one ends in a `source` line saying where it lives, because the
 * point of the panel is to finish with a constant rather than with a mood.
 *
 * Things NOT here, and why: anything that needs the sky dome rebuilt (its
 * colours are baked per face at load and a slider would have to re-run the
 * PMREM), and anything in `src/sim` (a slider on the physics is a different and
 * much more dangerous tool).
 */
/**
 * What the Placement folder reaches (DEV-129): the live values, READ FROM THE
 * PRESET, and the setters that apply a patch to the running ship. Owned by
 * `createApp`, handed in here, because the panel is built before the flight
 * lands and a patch has to survive that — the setters write app state first and
 * the ship second.
 */
export interface PlacementTuning {
  editionId(): string
  /** DEV-362. Which `cockpit.placement` block the flying vehicle reads — `hud` or `jumpSeatHud`. */
  hudKey(): 'hud' | 'jumpSeatHud'
  hud(): EditionHudPlacement
  setHud(p: EditionHudPlacement): void
  cockpit(): EditionCockpit
  setCockpit(c: EditionCockpit): void
  thirdPerson(): EditionThirdPerson
  setThirdPerson(t: EditionThirdPerson): void
}

/**
 * Three metres of travel on a slider whose unit is the metre, and a step a
 * fingertip can feel. Slider RAILS, not tuning: the numbers land in the JSON.
 */
export const PLACE_RANGE_M = 1.5
export const PLACE_STEP_M = 0.005

/**
 * The Placement folder's groups (DEV-129). Matt: *"i'd like a way to fine-tune
 * placement of some elements, like the ships HUD."*
 *
 * Every slider reads the preset's value through `placement.*()` — never a
 * literal here — writes back through `set*` so the frame follows the drag, and
 * each group carries the two things `lookdev.ts` added for this folder: a
 * `storageKey`, so a placement session survives the reload it takes to see a
 * change in a headset mirror, and a `json` block, so the session ends with the
 * EXACT text to paste into `content/editions/<id>.json` at the path named.
 *
 * Reachable cheaply, and therefore here: the readout (`cockpit.placement.hud`),
 * the two cabin lamps and the pilot (`cockpit.lighting.*.offset`,
 * `cockpit.body.offset` — already data, DEV-088), and the readout's seat on the
 * chase camera (`render.thirdPerson.hudOffset` / `hudScale`, DEV-128). NOT the
 * turn indicators: those are course props authored per mission in the level
 * JSON, not cockpit-mounted, and a slider on them is a slider on content.
 */
export const placementGroups = (placement: PlacementTuning): LookdevGroup[] => {
  const id = placement.editionId()
  const file = `content/editions/${id}.json`
  const axis = ['x', 'y', 'z'] as const

  // The readout. One mutable copy per group, re-sent whole on every drag —
  // `placeHud` takes the block, so moving y must not reset z.
  const hud = {
    ...placement.hud(),
    offset: [...placement.hud().offset] as [number, number, number],
  }
  const pushHud = (): void => {
    placement.setHud({ ...hud, offset: [...hud.offset] as [number, number, number] })
  }
  // DEV-362. The block the flying vehicle reads — `hud` in the HoverJet's
  // dash, `jumpSeatHud` on the JumpSeat — so the pasted JSON lands where the
  // numbers came from. The HoverJet's memory key is NEW: a session remembered
  // from before this row holds the floating plate's pose, and restoring it
  // would lift the panel straight back out of the recess.
  const key = placement.hudKey()
  const hudGroup: LookdevGroup = {
    title: 'placement — the readout (Esc frees the pointer first)',
    storageKey: key === 'hud' ? 'ff2.lookdev.placement.hud.dash' : `ff2.lookdev.placement.${key}`,
    json: { path: `${file}  cockpit.placement`, value: () => ({ [key]: { ...hud } }) },
    controls: [
      ...axis.map((name, i) => ({
        label: `hud offset ${name} (m from the eye)`,
        min: -PLACE_RANGE_M,
        max: PLACE_RANGE_M,
        step: PLACE_STEP_M,
        get: () => hud.offset[i] as number,
        set: (v: number) => {
          hud.offset[i] = v
          pushHud()
        },
        source: `${file}  cockpit.placement.${key}.offset[${i}] = %`,
      })),
      {
        label: 'hud tilt (rad, about x)',
        min: -1.2,
        max: 1.2,
        step: 0.01,
        get: () => hud.tilt,
        set: (v: number) => {
          hud.tilt = v
          pushHud()
        },
        source: `${file}  cockpit.placement.${key}.tilt = %`,
        digits: 2,
      },
      {
        label: 'hud scale',
        min: 0.3,
        max: 3,
        step: 0.01,
        get: () => hud.scale,
        set: (v: number) => {
          hud.scale = v
          pushHud()
        },
        source: `${file}  cockpit.placement.${key}.scale = %`,
        digits: 2,
      },
    ],
  }

  // The cabin: two lamps and the pilot, all offsets already on the preset
  // (DEV-088). `setInterior` takes the whole cockpit block, so a deep copy of
  // the three offsets is kept and re-sent whole.
  const c = placement.cockpit()
  const cabin = {
    fill: [...c.lighting.fill.offset] as [number, number, number],
    dash: [...c.lighting.dash.offset] as [number, number, number],
    body: [...c.body.offset] as [number, number, number],
  }
  const pushCabin = (): void => {
    const base = placement.cockpit()
    placement.setCockpit({
      ...base,
      lighting: {
        ...base.lighting,
        fill: { ...base.lighting.fill, offset: [...cabin.fill] as [number, number, number] },
        dash: { ...base.lighting.dash, offset: [...cabin.dash] as [number, number, number] },
      },
      body: { ...base.body, offset: [...cabin.body] as [number, number, number] },
    })
  }
  const lampControl = (
    which: 'fill' | 'dash' | 'body',
    path: string,
    i: number,
  ): LookdevControl => ({
    label: `${which} offset ${axis[i]} (m from the eye)`,
    min: -PLACE_RANGE_M,
    max: PLACE_RANGE_M,
    step: PLACE_STEP_M,
    get: () => cabin[which][i] as number,
    set: (v: number) => {
      cabin[which][i] = v
      pushCabin()
    },
    source: `${file}  ${path}[${i}] = %`,
  })
  const cabinGroup: LookdevGroup = {
    title: 'placement — the cabin (lamps and pilot)',
    storageKey: 'ff2.lookdev.placement.cabin',
    json: {
      path: `${file}  cockpit.lighting.{fill,dash}.offset and cockpit.body.offset`,
      value: () => ({
        'lighting.fill.offset': [...cabin.fill],
        'lighting.dash.offset': [...cabin.dash],
        'body.offset': [...cabin.body],
      }),
    },
    controls: [
      ...axis.map((_, i) => lampControl('fill', 'cockpit.lighting.fill.offset', i)),
      ...axis.map((_, i) => lampControl('dash', 'cockpit.lighting.dash.offset', i)),
      ...axis.map((_, i) => lampControl('body', 'cockpit.body.offset', i)),
    ],
  }

  // The readout on the chase camera (DEV-128).
  const tp = {
    hudOffset: [...placement.thirdPerson().hudOffset] as [number, number, number],
    hudScale: placement.thirdPerson().hudScale,
  }
  const pushTp = (): void => {
    placement.setThirdPerson({
      ...placement.thirdPerson(),
      hudOffset: [...tp.hudOffset] as [number, number, number],
      hudScale: tp.hudScale,
    })
  }
  const chaseGroup: LookdevGroup = {
    title: 'placement — the readout on the chase camera',
    storageKey: 'ff2.lookdev.placement.chaseHud',
    json: {
      path: `${file}  render.thirdPerson (hudOffset, hudScale)`,
      value: () => ({ hudOffset: [...tp.hudOffset], hudScale: tp.hudScale }),
    },
    controls: [
      ...axis.map((name, i) => ({
        label: `chase hud offset ${name} (m from the lens)`,
        min: -PLACE_RANGE_M,
        max: PLACE_RANGE_M,
        step: PLACE_STEP_M,
        get: () => tp.hudOffset[i] as number,
        set: (v: number) => {
          tp.hudOffset[i] = v
          pushTp()
        },
        source: `${file}  render.thirdPerson.hudOffset[${i}] = %`,
      })),
      {
        label: 'chase hud scale',
        min: 0.3,
        max: 3,
        step: 0.01,
        get: () => tp.hudScale,
        set: (v: number) => {
          tp.hudScale = v
          pushTp()
        },
        source: `${file}  render.thirdPerson.hudScale = %`,
        digits: 2,
      },
    ],
  }

  // ── DEV-273: the chase camera's FEEL, live ──────────────────────────────
  //
  // Matt: *"i'd like real-time tuning controls for the 3rd person cam. things
  // like follow distance, how 'tight' the camera rotation needs to match the
  // plane, offset position, etc."*
  //
  // Every number here already exists as a named field on `EditionThirdPerson`
  // and is read per frame — `springArm.update(thirdPersonNow(), …)` — so this
  // group is WIRING, not new maths. `setThirdPerson` sets the same patch the
  // chase HUD group above uses, and a preset flip drops it (DEV-129).
  //
  // Split from `chaseGroup` rather than added to it on purpose: that one is
  // where the READOUT sits on the lens, this one is where the LENS sits behind
  // the ship. They are tuned in different sittings and the Reset buttons should
  // not be the same button.
  /** Reach for the chase PIVOT, metres. See the note on the sliders below. */
  const PIVOT_RANGE_M = 8
  const feel = {
    ...placement.thirdPerson(),
    // Same reason the readout's `offset` is copied and cast: the edition's
    // tuple is `readonly`, and a slider writes one axis at a time.
    pivotOffset: [...placement.thirdPerson().pivotOffset] as [number, number, number],
  }
  const pushFeel = (): void => {
    placement.setThirdPerson({
      ...placement.thirdPerson(),
      ...feel,
      pivotOffset: [...feel.pivotOffset] as [number, number, number],
    })
  }
  /** One `EditionThirdPerson` scalar, as a slider. */
  const feelControl = (
    key: 'armLength' | 'minArmLength' | 'armPitchDeg' | 'aimPitchDeg',
    label: string,
    min: number,
    max: number,
    step: number,
    digits = 2,
  ): LookdevControl => ({
    label,
    min,
    max,
    step,
    digits,
    get: () => feel[key],
    set: (v: number) => {
      feel[key] = v
      pushFeel()
    },
    source: `${file}  render.thirdPerson.${key} = %`,
  })
  const lagControl = (
    key: 'positionLagSeconds' | 'rotationLagSeconds' | 'maxLagMetres',
    label: string,
    max: number,
    step: number,
  ): LookdevControl => ({
    label,
    min: 0,
    max,
    step,
    digits: 3,
    get: () => feel[key],
    set: (v: number) => {
      feel[key] = v
      pushFeel()
    },
    source: `${file}  render.thirdPerson.${key} = %`,
  })
  const followControl = (key: 'pitchFollow' | 'rollFollow', label: string): LookdevControl => ({
    label,
    min: 0,
    max: 1,
    step: 0.01,
    digits: 2,
    get: () => feel[key],
    set: (v: number) => {
      feel[key] = v
      pushFeel()
    },
    source: `${file}  render.thirdPerson.${key} = %`,
  })
  const chaseFeelGroup: LookdevGroup = {
    title: 'chase camera — where the lens sits, and how hard it chases',
    storageKey: 'ff2.lookdev.placement.chaseFeel',
    json: {
      path: `${file}  render.thirdPerson (the camera, not the readout)`,
      value: () => ({
        armLength: feel.armLength,
        minArmLength: feel.minArmLength,
        pivotOffset: [...feel.pivotOffset],
        armPitchDeg: feel.armPitchDeg,
        aimPitchDeg: feel.aimPitchDeg,
        positionLagSeconds: feel.positionLagSeconds,
        rotationLagSeconds: feel.rotationLagSeconds,
        maxLagMetres: feel.maxLagMetres,
        pitchFollow: feel.pitchFollow,
        rollFollow: feel.rollFollow,
        probeRadius: feel.probeRadius,
      }),
    },
    controls: [
      // 12.5 m is 2016's own arm (DEV-150). The range goes well past it both
      // ways because "follow distance" is the first thing anybody moves.
      feelControl('armLength', 'follow distance (m, pivot to lens)', 3, 40, 0.1, 1),
      // The probe shortens the arm to this at closest; above `armLength` it
      // would fight the probe every frame, so the slider stops there.
      {
        ...feelControl('minArmLength', 'closest the probe may pull in (m)', 0.5, 40, 0.1, 1),
        set: (v: number) => {
          feel.minArmLength = Math.min(v, feel.armLength)
          pushFeel()
        },
      },
      // NOT `PLACE_RANGE_M`. That is +-1.5 m, which is the right reach for a
      // readout 0.7 m from the eye and the wrong one for a camera pivot on a
      // 12 m arm — the shipped `pivotOffset` is (0, 1.5, 0), so on the HUD's
      // range the y slider is pinned AT its maximum and can only go down.
      // Caught by opening the panel and reading the number off it; nothing in
      // the type system or the suite can see a slider that cannot reach.
      ...axis.map(
        (name, i): LookdevControl => ({
          label: `pivot offset ${name} (m, ship frame)`,
          min: -PIVOT_RANGE_M,
          max: PIVOT_RANGE_M,
          step: 0.05,
          digits: 2,
          get: () => feel.pivotOffset[i] as number,
          set: (v: number) => {
            feel.pivotOffset[i] = v
            pushFeel()
          },
          source: `${file}  render.thirdPerson.pivotOffset[${i}] = %`,
        }),
      ),
      feelControl('armPitchDeg', 'arm pitch (deg above the ship)', -45, 45, 0.5, 1),
      feelControl('aimPitchDeg', 'aim pitch (deg, lens vs the arm)', -45, 45, 0.5, 1),
      // SmoothDamp smoothTime, so bigger is looser. 0 welds the lens to the
      // pose, which is DEV-128's rigid mount and the thing DEV-156 replaced.
      lagControl('positionLagSeconds', 'position lag (s — 0 welds it on)', 1, 0.002),
      // Matt's "how tight the camera rotation needs to match the plane".
      lagControl('rotationLagSeconds', 'rotation lag (s — the TIGHTNESS dial)', 2, 0.005),
      lagControl('maxLagMetres', 'lag leash (m the pivot may trail)', 30, 0.1),
      followControl('pitchFollow', 'pitch follow (0 level, 1 locked to the nose)'),
      followControl('rollFollow', 'roll follow (0 level, 1 barrel-rolls with you)'),
      {
        label: 'probe radius (m, what counts as "inside something")',
        min: 0,
        max: 6,
        step: 0.05,
        digits: 2,
        get: () => feel.probeRadius,
        set: (v: number) => {
          feel.probeRadius = v
          pushFeel()
        },
        source: `${file}  render.thirdPerson.probeRadius = %`,
      },
    ],
  }

  return [hudGroup, cabinGroup, chaseGroup, chaseFeelGroup]
}

export const buildLookdev = (
  fog: UnityFog,
  sun: THREE.DirectionalLight | null,
  clouds: LoadedClouds | null,
  sky: Sky | null,
  scene: THREE.Scene,
  // Appended rather than threaded in at the front on purpose: four agents are
  // editing this file for Phase 1 and a signature that grows at the end merges.
  renderer: THREE.WebGLRenderer,
  editionState: EditionState,
  flatFov: FlatFov,
  warp: IllustrativeLighting,
  bloom: Bloom,
  placement: PlacementTuning,
  sceneTintGroup: LookdevGroup | null,
  // DEV-455: for the fog group's source lines, which name the mission.
  levelId: string,
  // DEV-528: the buffet's engine curve; null where it would be inert.
  shakeGroup: LookdevGroup | null,
): Lookdev => {
  // The fog's shipped values are read by `fogLookdevGroup` off `fog.tuning`
  // (DEV-455), so a slider starts where the build is.

  // Accumulated sky edits. The group's `rebuild` applies all of them at once,
  // so moving one slider does not reset the others to the shipped value.
  const skyEdits: { -readonly [K in keyof SkyTuning]?: SkyTuning[K] } = {}

  const cloudMaterial = clouds?.group.children[0] as THREE.Mesh | undefined
  const cloudStandard = cloudMaterial?.material as THREE.MeshStandardMaterial | undefined

  // ── the Anniversary render knobs, and why they are CONDITIONAL ──────────
  //
  // Present only when the live preset actually has the feature — the same
  // shape as the `sky` group below, which appears only when there is a dome to
  // rebuild. On Classic the tone curve is `none`, so three never compiles the
  // chunk that reads `toneMappingExposure` and an exposure slider would move
  // nothing; and Classic's haze numbers are its NO-OP numbers (tint black,
  // range 1), so those sliders would darken the world toward black rather than
  // show the effect. An inert slider is worse than a missing one: it costs a
  // minute of dragging before you work out the tool is lying.
  //
  // `haze` is a live copy because `setHaze` takes the whole block — moving one
  // knob has to re-send the other four, or dragging `strength` would silently
  // reset `range`.
  //
  // These write to the RENDERER and to the FOG, not to `editionState`: the
  // preset is content, and the panel's job is to end with a number for the
  // JSON, which is what each `source` line says. Flipping the preset from the
  // pause menu mid-session overwrites them, which is correct and is why the
  // copy button exists.
  const edition = editionState.current
  const haze = { ...edition.render.haze }
  const pushHaze = (): void => {
    fog.setHaze(haze)
  }

  // ── S7's knobs, and why `base` is NOT behind the flag (DEV-093) ──────────
  //
  // `base` is the flat lens itself, and ANNIVERSARY.md §1.5 item 8's question —
  // *is 70° too wide for a monitor?* — is asked of the GAME, not of the
  // Anniversary preset: it would move every A/B frame ever taken under either
  // one. The slider does exactly what it says on Classic too, so it is not the
  // inert kind this block's header refuses. The three that ARE behind the flag
  // would be inert without it: Classic's curve is flat at zero, so scaling it
  // and timing the ease of nothing are both dragging for a minute to learn the
  // tool is lying.
  //
  // The curve slider moves the TOP of the shipped shape rather than authoring a
  // new one — "is 9 degrees too much" is the question a person has, and keeping
  // the breakpoints' x means the answer is still argued from the game's own
  // speeds. The `source` line says what to do with the number, because a scale
  // factor pasted into a JSON array is not a paste.
  const fovCurve = edition.render.flatFov.addBySpeed
  const fovTop = fovCurve.reduce((m, [, y]) => Math.max(m, y), 0)
  const setFovTop = (deg: number): void => {
    const k = fovTop > 0 ? deg / fovTop : 0
    flatFov.tune({ addBySpeed: fovCurve.map(([x, y]) => [x, y * k] as const) })
  }

  // V5's live copy, same shape and same reason as the haze's (DEV-090).
  const cloudLook = { ...edition.render.clouds }
  const pushCloudLook = (): void => {
    clouds?.setCloudLook(cloudLook)
  }
  // V7's ramp (DEV-092), and the same live-copy reason as the haze's: `warp.set`
  // takes the whole block, so moving one channel has to re-send the rest.
  //
  // PER CHANNEL, not per stop, and that is the only way the copy button can
  // produce something pasteable: a "coolness" knob would be a number with no
  // home in the JSON, which is how a good tuning session produces nothing (see
  // `LookdevControl.source`). `lit` is NOT here — it is the key light's level
  // rather than its colour, and `render.exposure` is the knob for that.
  const illustrative = {
    ...edition.render.illustrative,
    shadow: [...edition.render.illustrative.shadow] as [number, number, number],
    terminator: [...edition.render.illustrative.terminator] as [number, number, number],
    lit: [...edition.render.illustrative.lit] as [number, number, number],
  }
  const pushWarp = (): void => {
    warp.set(illustrative)
  }
  const warpStopControls = (key: 'shadow' | 'terminator', max: number): readonly LookdevControl[] =>
    (['r', 'g', 'b'] as const).map((channel, i) => ({
      label: `${key} ${channel}`,
      min: 0,
      max,
      step: 0.002,
      get: () => illustrative[key][i] as number,
      set: (v: number) => {
        illustrative[key][i] = v
        pushWarp()
      },
      source: `content/editions/${edition.id}.json  render.illustrative.${key}[${i}] = %`,
      digits: 3,
    }))

  // V2 / DEV-091. A live copy for the same reason the haze has one: `setBloom`
  // takes the whole block, so moving `strength` has to re-send `threshold` or the
  // other knobs would snap back. Conditional on the preset having the feature,
  // like the tone group — on Classic there is no composer to tune and three of
  // these sliders would move nothing at all.
  const bloomBlock = { ...edition.render.bloom }
  const pushBloom = (): void => {
    bloom.setBloom(bloomBlock)
  }

  return createLookdev([
    {
      title: 'lens — flat only, never in VR',
      controls: [
        {
          label: 'base fov (deg, vertical)',
          // 45 to 95 brackets both answers: the renderer's 70 and §1.5 item 8's
          // 55-60, with room on the far side to see what a wider one costs.
          min: 45,
          max: 95,
          step: 0.5,
          get: () => flatFov.base,
          set: (v: number) => {
            flatFov.setBase(v)
          },
          source: `content/editions/${edition.id}.json  render.flatFov.base = %`,
          digits: 1,
        },
      ],
    },
    ...(edition.render.flatFov.enabled
      ? [
          {
            title: 'lens — the speed curve',
            controls: [
              {
                label: 'top added (deg, at 340 m/s)',
                min: 0,
                max: 25,
                step: 0.5,
                get: () => fovTop,
                set: setFovTop,
                source:
                  `content/editions/${edition.id}.json  render.flatFov.addBySpeed — ` +
                  'scale every y so the last one is %',
                digits: 1,
              },
              {
                label: 'attack (s)',
                min: 0.02,
                max: 2,
                step: 0.01,
                get: () => edition.render.flatFov.attackSeconds,
                set: (v: number) => {
                  flatFov.tune({ attackSeconds: v })
                },
                source: `content/editions/${edition.id}.json  render.flatFov.attackSeconds = %`,
                digits: 2,
              },
              {
                label: 'release (s)',
                min: 0.02,
                max: 4,
                step: 0.01,
                get: () => edition.render.flatFov.releaseSeconds,
                set: (v: number) => {
                  flatFov.tune({ releaseSeconds: v })
                },
                source: `content/editions/${edition.id}.json  render.flatFov.releaseSeconds = %`,
                digits: 2,
              },
            ],
          },
        ]
      : []),
    ...(edition.render.toneMapping === 'none'
      ? []
      : [
          {
            title: `tone — ${edition.render.toneMapping}`,
            controls: [
              {
                label: 'exposure',
                min: 0.2,
                max: 3,
                step: 0.01,
                get: () => renderer.toneMappingExposure,
                set: (v: number) => {
                  renderer.toneMappingExposure = v
                },
                // No `rebuild`: the exposure is a uniform three pushes on every
                // draw, not a define, so this is live with nothing recompiled.
                // See DEV-081.
                source: `content/editions/${edition.id}.json  render.exposure = %`,
                digits: 2,
              },
            ],
          },
        ]),
    ...(edition.render.haze.enabled
      ? [
          {
            title: 'haze — aerial perspective',
            controls: [
              {
                label: 'start distance (m)',
                min: 0,
                max: 3000,
                step: 10,
                get: () => haze.startDistance,
                set: (v: number) => {
                  haze.startDistance = v
                  pushHaze()
                },
                source: `content/editions/${edition.id}.json  render.haze.startDistance = %`,
                digits: 0,
              },
              {
                label: 'range (m)',
                min: 100,
                max: 6000,
                step: 50,
                get: () => haze.range,
                set: (v: number) => {
                  haze.range = v
                  pushHaze()
                },
                // 6000 is CAMERA_FAR: nothing is drawn past it, so a range
                // beyond it is a knob that never reaches full strength anywhere
                // in the world.
                source: `content/editions/${edition.id}.json  render.haze.range = %`,
                digits: 0,
              },
              {
                label: 'tint strength',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => haze.strength,
                set: (v: number) => {
                  haze.strength = v
                  pushHaze()
                },
                source: `content/editions/${edition.id}.json  render.haze.strength = %`,
                digits: 2,
              },
              {
                label: 'desaturate',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => haze.desaturate,
                set: (v: number) => {
                  haze.desaturate = v
                  pushHaze()
                },
                source: `content/editions/${edition.id}.json  render.haze.desaturate = %`,
                digits: 2,
              },
            ],
          },
        ]
      : []),
    ...(edition.render.illustrative.enabled
      ? [
          {
            title: 'warp — illustrative diffuse',
            controls: [
              {
                label: 'strength',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => illustrative.strength,
                set: (v: number) => {
                  illustrative.strength = v
                  pushWarp()
                },
                // The A/B dial, and 0 is the EXACT stock Lambert response rather
                // than nearly — see `render/illustrative.ts`. So dragging this
                // to the left is the same picture Classic renders, live, without
                // reloading anything.
                source: `content/editions/${edition.id}.json  render.illustrative.strength = %`,
                digits: 2,
              },
              {
                label: 'overbright',
                min: 0.6,
                max: 1.6,
                step: 0.01,
                get: () => illustrative.overbright,
                set: (v: number) => {
                  illustrative.overbright = v
                  pushWarp()
                },
                // The whole ramp's gain, which is the knob for the one number the
                // row flags: against Lambert the curve peaks at 1.19x around
                // N.L = 0.75, and this scales that peak along with everything
                // else.
                source: `content/editions/${edition.id}.json  render.illustrative.overbright = %`,
                digits: 2,
              },
              // 0.2 and 0.4 rather than 1: these are RESPONSES on a surface whose
              // direct diffuse carries Marmoset's 2x against a sun of intensity
              // 1.3, so the shipped stops are 0.014-0.066 and a slider to 1 would
              // spend 95 % of its travel past anything usable.
              ...warpStopControls('shadow', 0.2),
              ...warpStopControls('terminator', 0.4),
            ],
          },
        ]
      : []),
    ...(edition.render.bloom.enabled
      ? [
          {
            title: 'bloom — flat build only',
            controls: [
              {
                // 2016's own number, and it means the same thing here — see the
                // schema's `threshold` description for why the domain carries
                // over. 1.5 rather than 1 at the top of the range because the
                // composer's buffer is HalfFloat and a threshold above white is
                // now a legal thing to ask for (DEV-081's headroom).
                label: 'threshold (linear luminance)',
                min: 0,
                max: 1.5,
                step: 0.01,
                get: () => bloomBlock.threshold,
                set: (v: number) => {
                  bloomBlock.threshold = v
                  pushBloom()
                },
                source: `content/editions/${edition.id}.json  render.bloom.threshold = %`,
                digits: 2,
              },
              {
                // The one to argue with. 0.059 is where a large bright area gets
                // exactly 2016's `intensity: 0.53` of added light; everything
                // that should glow here is far smaller than the kernels, so the
                // useful range is above it.
                label: 'strength',
                min: 0,
                max: 1,
                step: 0.005,
                get: () => bloomBlock.strength,
                set: (v: number) => {
                  bloomBlock.strength = v
                  pushBloom()
                },
                source: `content/editions/${edition.id}.json  render.bloom.strength = %`,
                digits: 3,
              },
              {
                label: 'radius (tight 0 - wide 1)',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => bloomBlock.radius,
                set: (v: number) => {
                  bloomBlock.radius = v
                  pushBloom()
                },
                source: `content/editions/${edition.id}.json  render.bloom.radius = %`,
                digits: 2,
              },
            ],
          },
        ]
      : []),
    // DEV-455: every parameter that shapes the fog, in its own module.
    fogLookdevGroup(fog, levelId),
    {
      title: 'lighting',
      controls: [
        {
          label: 'sun intensity',
          min: 0,
          max: 20,
          step: 0.05,
          get: () => sun?.intensity ?? 0,
          set: (v) => {
            if (sun) sun.intensity = v
          },
          // Through `marmosetSunIntensity`, which is the 2 * PI the Marmoset
          // port needs — so what goes back into the level JSON is this over
          // that factor, not this.
          source: 'level JSON  lighting.sun.intensity = % / (2 * Math.PI)',
          digits: 2,
        },
      ],
    },
    // ── the sky ────────────────────────────────────────────────────────
    //
    // Every slider here needs the dome REBUILT: its colours are baked per face
    // at load, so there is no uniform to poke. `rebuild` is on the group rather
    // than on each control, so dragging one slider pays for one rebuild and not
    // three — and `scene.environment` is reassigned because the prefilter is a
    // new texture each time, not a mutated one.
    //
    // At subdivision 5 a rebuild is 20,480 faces of SH plus a PMREM pass: a few
    // milliseconds, which is a visible hitch while dragging and no reason to
    // make the tool worse. Let go of the slider and it settles.
    ...(sky
      ? [
          {
            title: 'sky',
            rebuild: () => {
              scene.environment = sky.retune(skyEdits)
            },
            controls: [
              {
                label: 'subdivisions',
                min: 2,
                max: 5,
                step: 1,
                get: () => sky.tuning.subdivisions,
                set: (v: number) => {
                  skyEdits.subdivisions = v
                },
                // 5 is the cap on purpose: 6 is 81,920 faces, and a rebuild
                // that takes half a second is a tool nobody drags.
                source: 'render/sky.ts  SKY_SUBDIVISIONS = %',
                digits: 0,
              },
              {
                label: 'cloud banks',
                min: 0,
                max: 30,
                step: 1,
                get: () => sky.tuning.cloudLobes,
                set: (v: number) => {
                  skyEdits.cloudLobes = v
                },
                source: 'render/sky.ts  SKY_CLOUD_LOBES = %',
                digits: 0,
              },
              {
                label: 'cloud depth',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => sky.tuning.cloudDepth,
                set: (v: number) => {
                  skyEdits.cloudDepth = v
                },
                source: 'render/sky.ts  SKY_CLOUD_DEPTH = %',
                digits: 2,
              },
              {
                // Inert on a SMOOTH sky (DEV-320), which drops the cell
                // variation entirely — Anniversary's default. The label says
                // so rather than leaving a slider that moves nothing.
                label: 'facet variation (faceted sky only)',
                min: 0,
                max: 0.3,
                step: 0.005,
                get: () => sky.tuning.facetJitter,
                set: (v: number) => {
                  skyEdits.facetJitter = v
                },
                source: 'render/sky.ts  SKY_FACET_JITTER = %',
                digits: 3,
              },
              {
                // DEV-294. Matt: "i'd love to be able to tweak the sun's size."
                //
                // A MULTIPLE of DEV-293's 1.812-degree rim, not a number of
                // degrees, so the readout is *"how much bigger than it was"* —
                // which is the question being asked. 1 is DEV-293's sun, 3 is
                // what ships.
                //
                // It rebuilds the dome like every other slider in this group,
                // and for the same reason: the disc is vertex colours baked at
                // load, so there is no uniform to poke. But unlike the others
                // it moves no vertex COUNT — the cap's rings and segments are
                // fixed and only its angles scale — so nothing downstream of
                // it (the census, the two dome-count assertions) is a function
                // of where this is left.
                label: 'sun size',
                min: 0.25,
                max: 8,
                step: 0.25,
                get: () => sky.tuning.sunSize,
                set: (v: number) => {
                  skyEdits.sunSize = v
                },
                source: 'render/sky.ts  SUN_DISC_SIZE = %',
                digits: 2,
              },
            ],
          },
        ]
      : []),
    {
      title: 'clouds',
      controls: [
        {
          label: 'emissive lift',
          min: 0,
          max: 1,
          step: 0.01,
          get: () => cloudStandard?.emissiveIntensity ?? 0,
          set: (v) => {
            if (!clouds) return
            // One material, shared by all nineteen.
            for (const child of clouds.group.children) {
              const m = (child as THREE.Mesh).material as THREE.MeshStandardMaterial
              m.emissiveIntensity = v
            }
          },
          source: 'game/clouds.ts  CLOUD_EMISSIVE = %',
          digits: 2,
        },
      ],
    },
    // ── Anniversary systems: V5's knobs (DEV-090) ─────────────────────────
    //
    // CONDITIONAL, for the reason the haze group is: on Classic `wrap` and
    // `rimStrength` are zero and the shader returns before it reads anything, so
    // every one of these sliders would move nothing and cost a minute of
    // dragging before you worked out the tool was lying.
    //
    // They write the UNIFORMS through `setCloudLook`, not `editionState`, which
    // is the same contract the haze group keeps: the panel's job is to end with a
    // number for the JSON, and each `source` line says which key. A live copy,
    // because `setCloudLook` takes the whole block — moving one knob has to
    // re-send the rest or dragging `wrap` would silently reset `rimPower`.
    ...(edition.render.clouds.enabled && clouds
      ? [
          {
            title: 'clouds — the Anniversary look',
            controls: [
              {
                label: 'sun wrap',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => cloudLook.wrap,
                set: (v: number) => {
                  cloudLook.wrap = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.wrap = %`,
                digits: 2,
              },
              {
                label: 'rim strength',
                min: 0,
                max: 3,
                step: 0.05,
                get: () => cloudLook.rimStrength,
                set: (v: number) => {
                  cloudLook.rimStrength = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.rimStrength = %`,
                digits: 2,
              },
              {
                label: 'rim power',
                // Never 0: `x^0` is 1, which is a full-strength rim over the
                // whole body. The schema refuses it and so does this.
                min: 0.5,
                max: 12,
                step: 0.1,
                get: () => cloudLook.rimPower,
                set: (v: number) => {
                  cloudLook.rimPower = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.rimPower = %`,
                digits: 1,
              },
              {
                label: 'sun tint',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => cloudLook.sunTint,
                set: (v: number) => {
                  cloudLook.sunTint = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.sunTint = %`,
                digits: 2,
              },
              {
                label: 'emissive floor',
                min: 0,
                max: 1,
                step: 0.01,
                get: () => cloudLook.emissive,
                set: (v: number) => {
                  cloudLook.emissive = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.emissive = %`,
                digits: 2,
              },
              {
                label: 'scale x',
                min: 0.5,
                max: 3,
                step: 0.01,
                get: () => cloudLook.scaleMultiplier,
                set: (v: number) => {
                  cloudLook.scaleMultiplier = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.scaleMultiplier = %`,
                digits: 2,
              },
              {
                label: 'altitude lift (m)',
                // 0 is 2016's own placement, so the range starts there rather
                // than going negative: a preset that BURIED the layer would be
                // doing the opposite of what §1.5 asked for.
                min: 0,
                max: 1200,
                step: 10,
                get: () => cloudLook.altitudeLift,
                set: (v: number) => {
                  cloudLook.altitudeLift = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.altitudeLift = %`,
                digits: 0,
              },
              {
                label: 'drift (m/s)',
                min: 0,
                max: 20,
                step: 0.1,
                get: () => cloudLook.driftSpeed,
                set: (v: number) => {
                  cloudLook.driftSpeed = v
                  pushCloudLook()
                },
                source: `content/editions/${edition.id}.json  render.clouds.driftSpeed = %`,
                digits: 1,
              },
            ],
          },
        ]
      : []),
    // DEV-446. The scene tint, on the mission being flown; null on a preset
    // whose flag is off, where it would be inert.
    ...(sceneTintGroup ? [sceneTintGroup] : []),
    // DEV-528. The buffet's three engine weights, on the ship being flown.
    ...(shakeGroup ? [shakeGroup] : []),
    // DEV-129. Last, and on both presets: a placement has no flag to be inert on.
    ...placementGroups(placement),
  ])
}
