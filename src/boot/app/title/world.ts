// src/boot/app/title/world.ts: the title screen's world, built, out of
// `bootApp`. APP-SPLIT phase 4, slice 5 (title; `docs/plan/APP-SPLIT.md` §5).
//
// `buildTitleWorld`, whole: the valley, its forest, fog, sky and ambient, the
// logo and its key light, the flypast jets and their trails, the curtain and
// the rows. It writes the title's live handles back through ctx setters (the
// owner record, `handles`, takes them in APP-SPLIT 3.1), and `teardownWorld`
// takes them down. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns (a getter, and a setter where this code
// writes one: the §6 rule 3 bag), and the returned object.

import * as THREE from 'three'
import type { Capabilities } from '@/boot/capability-gate'
import { type LoadProgress, TITLE_CARD_NAME } from '@/boot/load-progress'
import { createSlicer } from '@/boot/slice'
import { stats } from '@/boot/stats-beacon'
import { assetUrl } from '@/content/asset-url'
import { loadNoPropVolumes } from '@/content/no-prop-volumes'
import type { EditionState } from '@/game/edition'
import { ART_POSITION, ART_SCALE, SHIP_MESH_EXTERIOR, SHIP_MODEL_YAW } from '@/game/flight'
import { loadMissionIndex, type MissionCard } from '@/game/mission-index'
import { terrainOriginSim } from '@/game/mission-shape'
import { loadProps } from '@/game/props/load-props'
import { describeVolumes, resolveNoPropVolumes } from '@/game/props/no-prop-volumes'
import { dressRacerHull, racerMaterial } from '@/game/racers'
import { type LoadedTerrain, loadTerrain } from '@/game/terrain/load-terrain'
import {
  createTitleTrails,
  type TitleJet as TitleTrailJet,
  type TitleTrails,
} from '@/game/title-trails'
import type { Bloom } from '@/render/bloom'
import { LOAD_FADE_SECONDS } from '@/render/fade'
import type { FarShadow } from '@/render/far-shadow'
import type { IllustrativeLighting } from '@/render/illustrative'
import { loadMesh } from '@/render/load-mesh'
import type { PauseOption } from '@/render/pause'
import { createPause, type Pause } from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import type { SunShadows } from '@/render/shadows'
import { createSky, type Sky } from '@/render/sky'
import type { SkyVisibility } from '@/render/sky-visibility'
import { createSkyshopProbe, marmosetSunIntensity } from '@/render/skyshop-ibl'
import { createTitle, TITLE_2016, type Title, terrainMeshToWorld } from '@/render/title'
import { createTitleCurtain, EMBLEM_ORDER, type TitleCurtain } from '@/render/title-curtain'
import { placeTitleMenu, TITLE_MENU_HEADING, TITLE_MENU_PLATE } from '@/render/title-menu'
import { createUnityFog, type UnityFog } from '@/render/unity-fog'
import { warmWorld } from '@/render/warm-up'
import { measureWingTips } from '@/render/wing-trails'
import { buildCanopyField } from '@/sim/props/canopy'
import {
  FOG_ENABLED,
  LOGO_KEY_TRIM,
  LOGO_LAYER,
  PROP_CELLS,
  PROP_LOD,
  PROPS_ON,
  TINT_IS_SRGB,
  TITLE_FOG,
  TITLE_IBL,
  TITLE_SUN,
  TITLE_VALLEY_OFFSET,
} from '../pins'

/** What `createTitleWorld` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface TitleWorldCtx {
  readonly bloom: Bloom
  readonly capabilities: Capabilities
  readonly editionState: EditionState
  readonly farShadow: FarShadow
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  firstWorldSettled: boolean
  readonly liveTitleGlows: { dispose(): void }[]
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  liveTitleJets: readonly THREE.Object3D[]
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  liveTitleTrails: TitleTrails | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  liveTitleValley: LoadedTerrain | null
  readonly loading: LoadProgress
  readonly maybeReveal: () => void
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  quickRaceCards: Promise<MissionCard[]> | null
  readonly render: Renderer
  readonly skyVisibility: SkyVisibility
  readonly splash: { covering(): boolean; readonly lifting: Promise<void> } | null
  readonly sunShadows: SunShadows
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  title: Title | null
  readonly titleAim: number
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleCurtain: TitleCurtain | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleFog: UnityFog | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleMenu: Pause | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleProbe: THREE.LightProbe | null
  readonly titleRows: () => readonly PauseOption[]
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleSky: Sky | null
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  titleValleyPropsDispose: (() => void) | null
  readonly warp: IllustrativeLighting
}

export const createTitleWorld = (ctx: TitleWorldCtx) => {
  const {
    bloom,
    capabilities,
    editionState,
    farShadow,
    loading,
    maybeReveal,
    render,
    skyVisibility,
    splash,
    sunShadows,
    titleRows,
    warp,
  } = ctx
  /**
   * The title screen's world, and ONLY the title screen's world. DEV-281.
   *
   * ── What this is for ────────────────────────────────────────────────────
   *
   * Matt, 2026-09-21: *"it shouldn't be loading the islands in the first place
   * is my entire point"*, and *"let's only load worlds when they're needed."*
   * Boot used to build BOTH worlds in one `Promise.all` — two full 4,096 m
   * terrains, of which the visitor is looking at one — and name the other one
   * on the progress line: *"Loading Simonet Islands…"*, over a title screen,
   * for a course nobody had chosen. The island is now generated by
   * `buildWorld`, at the first course selection, and this is what boot builds.
   *
   * ── It owns the whole screen, not just the terrain ──────────────────────
   *
   * The valley, its forest, its fog, its sky, its ambient, the logo and its key
   * light, and the two flypast jets. Everything with `title` in its name in the
   * teardown below is built here. The one thing it does NOT own is the level
   * select: since DEV-076 that room is `menuScene`, a scene of its own, built
   * at boot whatever else happens.
   *
   * ── And it is the LAST thing this build shows before a mission ──────────
   *
   * There is no route back to the title screen — `goToScreen` is called with
   * `'menu'` and `'mission'` and never with `'title'` — so the first course
   * selection tears this down for good, which is what makes it safe for
   * `teardownWorld` to dispose it alongside a mission it never shared a frame
   * with.
   */
  const buildTitleWorld = async (): Promise<{ readonly valley: LoadedTerrain }> => {
    // ── the card names the GAME, not the place (DEV-352) ─────────────────
    //
    // It said *"Loading Alpine Forest… 43%"*, which was DEV-281's honest fix
    // for a line that named Simonet over an alpine valley. Honest, and still
    // the wrong noun for the front door: a visitor who has chosen nothing is
    // waiting for the GAME, and the valley is only where its title stands.
    // Matt: *"name the game on the card, not the environment."* The mission
    // builder still names its place, because there the place IS the choice.
    loading.restart(TITLE_CARD_NAME)
    const valleyProgress = loading.channel()
    // ── the title screen's valley ────────────────────────────────────────
    //
    // A SECOND environment, and the first time this engine has been asked for
    // one. `alpine.forest` was already in the generated sheet — what was
    // missing was the asset publish, because its height map is a Targa and
    // nothing in `tools/` could read one (DEV-041).
    //
    // `LevelArt_AlpineForest` and the title screen's `AlpineTerrain_menu.prefab`
    // carry the same `FacetedTerrain` field for field: 2016 stood its title
    // screen in the Alpine Forest environment. One terrain, one publish, two
    // uses.
    //
    // Parked 30 km from Simonet so the two worlds cannot see each other: the far
    // plane is 6 km, and the ocean's own `visibleRadius` is centred on the
    // island, so nothing here is ever drawn during a mission.
    //
    // ── STARTED here, AWAITED below the emblem (DEV-352) ─────────────────
    //
    // Matt: *"would it be possible to load and light the logo first? then fade
    // in the bg?"* The valley is the long pole — two height maps and a mesh
    // build — and the emblem is one small GLB. They used to run in series, the
    // valley first, so a cold load showed black and a percentage for ~6.5 s
    // before the emblem existed. Now the valley starts first and the emblem
    // is lit, warmed and shown while it is still arriving.
    const valleyLoad = loadTerrain('alpine.forest', {
      worldOffset: TITLE_VALLEY_OFFSET,
      fixDiagonal: editionState.current.terrain.diagonalFix.enabled, // DEV-831
      tintIsSrgb: TINT_IS_SRGB,
      onProgress: valleyProgress,
      // V7 (DEV-092). The title screen and the menu room stand in THIS terrain,
      // so leaving it out would light the one world a player sees before the
      // game starts by a different rule from the one they fly in.
      applyIllustrative: (m) => warp.applyTo(m),
      // ── 2016's own LOD ladder, which this screen never had (DEV-282) ────
      //
      // Every chunk used to be built at LOD 0 — 64 of them, 4,096 m of alpine
      // forest at full facet density, for ONE FIXED CAMERA standing in it. That
      // is not what 2016 does: `AlpineTerrain_menu` carries `lodLevels: 3` and
      // `lodDistance: 700` like every other `FacetedTerrain`, and `Start()`
      // picks each chunk's level by distance before the first frame. The port
      // skipped it because `initialLod` wants a camera and the camera's world
      // position was not known until the group existed — the chicken and the
      // egg its old note recorded (*"measured it costs about a second. Cheaper
      // than the bug."*).
      //
      // `cameraMesh` is that egg cracked: the eye is a CONSTANT in the
      // terrain's own mesh frame, and the loader converts it where the
      // placement is known. See the option's note for why it is the unrotated
      // frame, and for why composing the point out here would be DEV-042's trap
      // for the third time.
      cameraMesh: [TITLE_2016.cameraMesh[0], TITLE_2016.cameraMesh[2]],
      // Nothing ever calls `updateLod` on this terrain — the camera is bolted
      // down — so the regeneration worker would spend an 8 MB structured clone
      // of two `ImageData`s on replies nobody can ask for. What is BUILT is
      // unchanged: `cameraMesh` above still picks every chunk's level.
      lodUpdates: false,
    })
    // Marked handled here; the `await` below still throws. A rejection that
    // landed while the emblem was loading would otherwise be reported as
    // unhandled before anything got the chance to handle it.
    valleyLoad.catch(() => {})

    // ── the valley's FRAME, before the valley (DEV-352) ──────────────────
    //
    // Everything on the title screen is placed through the valley group's
    // matrix — the eye, the emblem, its key light, the flypast — because the
    // terrain's mesh frame is the only frame the two projects share (DEV-042).
    // The emblem now arrives BEFORE the group does, so it is placed through a
    // stand-in carrying the transform the group is about to get:
    // `terrainOriginSim` for where `loadTerrain` puts it (the placement
    // `mission-shape.test.ts` holds against four measured environments) and
    // 2016's rotation for how it is tipped.
    //
    // Two routes to one matrix is the drift the orientation lesson warns about,
    // so the two are COMPARED once the valley lands, below, and the difference
    // is published for `title-emblem-first.spec.ts` to hold at zero.
    const valleyAt = terrainOriginSim('alpine.forest', TITLE_VALLEY_OFFSET)
    const valleyFrame = new THREE.Object3D()
    valleyFrame.position.set(valleyAt.position[0], valleyAt.position[1], -valleyAt.position[2])
    valleyFrame.scale.fromArray(valleyAt.scale)
    valleyFrame.quaternion.fromArray([...TITLE_2016.terrainQuaternion])
    valleyFrame.updateMatrixWorld(true)

    // ── standing in the valley ─────────────────────────────────────────
    //
    // Off the valley's own matrix, so the rig cannot drift from the ground it
    // is standing on, and in the terrain's MESH frame, which is the only
    // frame the two projects share. The lift this replaces existed to rescue
    // a camera that composed 1,022 m away and 410 m underground; with the
    // frame right, 2016's own height carries across and the camera lands
    // **6.172 m** above its own ground with nothing to tune.
    const eye2016 = terrainMeshToWorld(TITLE_2016.cameraMesh, valleyFrame)
    const logo2016 = terrainMeshToWorld(TITLE_2016.logoMesh, valleyFrame)

    const vantage = {
      x: eye2016.x,
      y: eye2016.y,
      z: eye2016.z,
      facing: -(TITLE_2016.cameraYaw * Math.PI) / 180,
    }
    // The logo mesh. `loadMesh` throws on a 404 and a title screen is not
    // worth failing boot for, so a miss falls back to the stand-in monument
    // and says so once.
    let logoMesh: THREE.Object3D | null = null
    try {
      logoMesh = (await loadMesh(assetUrl('assets/props/title-logo.glb'))).object
    } catch (err) {
      console.warn('title: 2016 logo mesh unavailable, using the monument', err)
    }
    ctx.title = createTitle({
      eye: new THREE.Vector3(vantage.x, vantage.y, vantage.z),
      facing: vantage.facing,
      logo: logoMesh,
      logoYaw: -(TITLE_2016.logoYaw * Math.PI) / 180,
      logoScale: TITLE_2016.logoScale,
      logoAt: logo2016,
      logoLayer: LOGO_LAYER,
      logoLight: {
        // Through the same matrix as the camera and the emblem. It used to be
        // composed separately and then have its y overwritten by hand, which
        // is two placements to keep in step; there is now one.
        position: terrainMeshToWorld(TITLE_2016.spotMesh, valleyFrame),
        // 2016's own intensity, trimmed by `LOGO_KEY_TRIM` (DEV-044, then
        // DEV-635: 40 %). A deliberate deviation from the measured value and
        // the only one on this light: the position, range and cone angle are
        // all 2016's.
        intensity: marmosetSunIntensity(TITLE_2016.spotIntensity) * LOGO_KEY_TRIM,
        distance: TITLE_2016.spotRange,
        angle: ((TITLE_2016.spotAngleDeg / 2) * Math.PI) / 180,
      },
      // 2016's own flypast (DEV-215): the two closed Curvy splines its two
      // menu ships actually walk, through the same matrix as the camera and
      // the emblem so the paths belong to the valley rather than to a scene we
      // no longer have. DEV-155 flew a ninth-point spline `main_menu.unity`
      // keeps but switches off; the walkers point elsewhere.
      flypaths: TITLE_2016.flypaths.map((lane) => ({
        path: lane.mesh.map((p) => terrainMeshToWorld(p, valleyFrame)),
        initialF: lane.initialF,
      })),
      // Ignored while there is a logo mesh — `logoAt` wins — and the right
      // answer for the stand-in monument too: it is placed 95 m out, where the
      // valley wall is, not on the floor under the emblem.
      groundAt: null,
      // ── these two are the STAND-IN monument's, and it is not the shipped
      // screen (DEV-284) ────────────────────────────────────────────────────
      //
      // `render/title.ts` draws them on a canvas whose mesh carries
      // `wordmark.visible = !opts.logo`, so they appear ONLY when
      // `title-logo.glb` failed to load. That is the whole of DEV-284's finding:
      // the anniversary name was passed in here, looked shipped, and was on a
      // path a player never sees, because the 3D emblem is 2016's own
      // `logo_polys` and reads FACETED FLIGHT. Photographed in DEV-282's A/B
      // pair, which was taken to compare terrain LOD and was not looking for it.
      //
      // Kept as they are. On the fallback path the edition's name now appears
      // twice — here and on the prompt plane below — which is a duplication in a
      // picture that only exists when an asset 404s, and worth less than the
      // clarity of leaving the stand-in saying the full name on its own.
      title: 'Faceted Flight',
      subtitle: '10th Anniversary Edition',
      // ── the line under the emblem, and it is the EDITION's name (DEV-285) ─
      //
      // Matt, 2026-09-21: *"change the 'Press Start' text to '10th Anniversary
      // Edition'."* It said `press A to start` until then.
      //
      // The ask came straight out of DEV-284's finding, which is what makes it
      // the right slot rather than an arbitrary one: **the shipped title screen
      // stated the anniversary name NOWHERE.** The 3D emblem is 2016's own
      // `logo_polys` and reads FACETED FLIGHT; `subtitle` above carries the
      // edition and is drawn on the stand-in monument's canvas, which
      // `render/title.ts` hides whenever the GLB loads. So the one public-facing
      // screen in the game did not say the public name.
      //
      // **What it costs, said out loud: this was the only instruction on the
      // screen.** On touch the confirm chip still reads START (`CONFIRM_LABEL`),
      // so a phone is unaffected; on a monitor and in a headset there is now
      // nothing saying which button starts the game. That is a deliberate trade
      // and the creative director's call (hard rule 9) — recorded rather than
      // argued, with the restoration named in DEV-285's row for the day it wants
      // making. (DEV-353's two rows under it now say what each press does.)
      prompt: '10th Anniversary Edition',
    })
    render.scene.add(ctx.title.object)
    // ── the camera has to SEE the layer, or the light never arrives ────
    //
    // three gathers lights in `projectObject`, inside
    // `if (object.layers.test(camera.layers))` — so a light restricted to
    // layer 23 while the camera looks only at layer 0 is discarded before it
    // can illuminate anything. Not "dim": absent. The symptom was a key light
    // that did nothing at gain 3 and nothing at gain 60, which is the shape of
    // a light that is not in the list rather than one that is too weak.
    //
    // Enabling it here costs nothing — the logo also carries layer 0, so this
    // changes what the camera GATHERS and not what it draws. And it is enabled
    // WITH the emblem rather than after the valley: "load and light the logo
    // first" is this line (DEV-352).
    render.camera.layers.enable(LOGO_LAYER)
    // Pisa, at its own exposure and with no sky rotation. Added dark and lit
    // by the screen switch below, beside the sun — one place decides which
    // world's light is on. Built with the emblem rather than after the valley
    // because a light probe is in every lit program's cache key: arriving
    // later, it would recompile the gold while the gold was on screen.
    ctx.titleProbe = createSkyshopProbe(TITLE_IBL)
    ctx.titleProbe.name = 'title-skyshop-ibl'
    ctx.titleProbe.intensity = 0
    render.scene.add(ctx.titleProbe)

    // ── and the sky, because a fog with no sky behind it is a SEAM ──────
    //
    // `applySky`'s own header: *"distant terrain fades to exactly the colour
    // behind it"*, which is why the dome's fallback horizon IS the fog
    // colour. Give the valley the menu's cold fog and leave `int_01`'s SkyJ
    // sunset behind it and the two disagree by a whole hue — mountains
    // dissolving into pale blue against a lavender sky. So the title screen
    // gets its own dome, built the way a mission with no decoded skybox gets
    // one.
    //
    // The menu's skybox is `Assets/Faceted Flight/Cubemaps/ForestSky.mat`
    // and nothing here has decoded it, so this is FF2's gradient rather than
    // 2016's sky. That is the same answer the ten missions without a decoded
    // skybox already get, and it is the honest one: D26 says the Marmoset
    // cubemaps cannot ship.
    //
    // Built with the emblem too (DEV-352): the dome's environment map is what
    // the gold's SPECULAR reflects, and a scene environment that arrived with
    // the valley would both recompile the emblem and change its look at the
    // moment the valley fades in. The dome itself is behind the curtain.
    ctx.titleSky = createSky(
      render.renderer,
      {
        sunDirection: [
          TITLE_SUN.direction[0] as number,
          TITLE_SUN.direction[1] as number,
          TITLE_SUN.direction[2] as number,
        ],
        // sRGB on the level's `fog.color` too — `applySky` passes that field
        // straight through and `createSky` converts.
        sunColor: [1, 1, 1],
        horizonColor: [
          TITLE_FOG.colorSrgb[0] as number,
          TITLE_FOG.colorSrgb[1] as number,
          TITLE_FOG.colorSrgb[2] as number,
        ],
        skySh: null,
      },
      { smooth: editionState.current.render.smoothSky.enabled },
    )
    ctx.titleSky.dome.visible = false
    render.scene.add(ctx.titleSky.dome)

    // ── the curtain: the world black, the emblem lit on it (DEV-352) ─────
    //
    // `render/title-curtain.ts` says why this is not the fade: the fade is UI
    // and covers everything, and this covers everything but the emblem. The
    // emblem's meshes sort just after it in the opaque list — `renderOrder`
    // only, which is not in a program's cache key, so the gold compiles once
    // and nothing recompiles when the curtain goes. Whatever `createTitle`
    // drew is lifted over it, which is also the stand-in monument when the
    // GLB 404s; the flypast jets are not built yet, and are held out of the
    // flypast until the curtain lifts (the title block of the frame loop).
    ctx.titleCurtain = createTitleCurtain()
    render.scene.add(ctx.titleCurtain.object)
    document.body.dataset.titleCurtain = ctx.titleCurtain.phase
    ctx.title.object.traverse((node) => {
      if ((node as THREE.Mesh).isMesh) node.renderOrder = EMBLEM_ORDER
    })
    // ── the title's rows (DEV-353; START and ENTER VR since DEV-558) ─────
    //
    // Built with the emblem so its first draw is compiled with it, and shown
    // only once the valley is in (`titleMenuUp`). Under the rig, which the
    // title block of the frame loop parks at the eye; see `render/title-menu.ts`
    // for where it hangs and why it is the pause plate. The index a ghost
    // link's race (and TV) picks from is fetched now, so a press does not wait.
    ctx.titleMenu = createPause(TITLE_MENU_PLATE)
    // DEV-901: placed for the rows it will hold, not for the default three.
    // `titleRows()` caches, and re-places the plate only when the count it
    // CACHED changes, so a read before this plate existed left the count
    // cached and a plate placed for three here was never re-placed for five:
    // its last row ran off a flat frame's lower edge. `__ff2.titleMenu()`
    // polled from load was that read, so every spec that waited on the rows
    // that way measured a plate no player sees.
    const rows = titleRows()
    placeTitleMenu(ctx.titleMenu.object, rows.length, !render.renderer.xr.isPresenting)
    ctx.titleMenu.update({
      options: rows,
      selected: ctx.titleAim,
      // The device the page STARTS with (DEV-396): the frame loop rewords it
      // for the one in use, and `flatDevice` is not declared yet at this point.
      title: TITLE_MENU_HEADING,
    })
    ctx.titleMenu.setVisible(false)
    render.rig.add(ctx.titleMenu.object)
    ctx.quickRaceCards ??= loadMissionIndex()
    // The emblem's first draw, under the boot fade — the scene holds the
    // emblem, its light, the probe, the dome and the curtain and nothing else,
    // which is exactly what the first visible frame will draw. The valley's
    // own warm-up further down compiles the rest under the curtain.
    const emblemWarm = warmWorld(
      render.renderer,
      render.scene,
      render.camera,
      render.scene,
      { offscreen: bloom.willComposite(), alsoDefaultTarget: capabilities.immersiveVr },
      () => performance.now(),
    )
    console.info(
      `title: the emblem is lit, ahead of the valley — first draw in ` +
        `${emblemWarm.ms.toFixed(0)} ms, ${emblemWarm.programs} programs`,
    )
    // The boot fade lifts on THIS, not on the valley. `booted` still settles
    // at the end, where it re-asserts the same flag; see the release below
    // `bootWorld`. L4's guarantee holds — the world still assembles behind
    // black — and the black is now the curtain rather than the fade.
    document.body.dataset.titleEmblem = 'true'
    ctx.firstWorldSettled = true
    stats.titleShown()
    maybeReveal()

    const titleValley = await valleyLoad
    // The terrain is in; the air and the forest are not.
    loading.assembling()
    render.scene.add(titleValley.group)
    // Named so a spec can find it, and so `completion.spec.ts`'s question —
    // *"which worlds are in the scene?"* — has an answer for this one too.
    titleValley.group.name = 'title-valley'
    // ── the title screen: 2016's valley, at 2016's pose ────────────────
    //
    // **The valley carries 2016's own rotation.** `main_menu.unity` hangs
    // `AlpineTerrain_menu` under a `terrainPivot` placed AT THE CAMERA and
    // swings the whole 4 km map around it — yaw −86.922° and **6.671° off
    // vertical**, which is 479 m of rise across the map. That is a
    // composition the artist made, not an accident, and Matt chose to ship it
    // rather than level it: *"option 2 - let's be faithful to 2016"*
    // (2026-09-13). DEV-042 has the three candidate pictures it was chosen
    // from.
    //
    // The rotation goes on the GROUP and the rig stays upright, exactly as
    // 2016 has it — its camera is a pure yaw and the valley is what is
    // tipped. That is also why this is safe here and would not be on a
    // mission terrain: `inRange` and `chunkFootprintDistance` build
    // axis-aligned boxes out of `position`/`scale` and would both be WRONG
    // (not conservative) under a rotation, and `terrainHeightAt` would read
    // the wrong part of the map. None of the three is reachable — the title
    // valley passes no `visibleRadius`, so `inRange` short-circuits on a
    // non-finite radius; `updateLod` is only ever called on the mission
    // terrain and the ocean; and with the lift gone nothing reads this
    // terrain's height field at all. **If you ever give this group a
    // `visibleRadius`, a `camera`, or a height-field query, read DEV-042
    // first.**
    titleValley.group.quaternion.fromArray([...TITLE_2016.terrainQuaternion])
    titleValley.group.updateMatrixWorld(true)
    // ── the stand-in agreed with the valley, or say so (DEV-352) ────────
    //
    // The emblem, the eye, the key light and the flypast were all placed
    // through `valleyFrame` above, before this group existed. Largest
    // element-wise difference between the two world matrices; zero when the
    // two routes agree, which is what `title-emblem-first.spec.ts` holds.
    {
      const a = valleyFrame.matrixWorld.elements
      const b = titleValley.group.matrixWorld.elements
      let drift = 0
      for (let i = 0; i < 16; i++)
        drift = Math.max(drift, Math.abs((a[i] as number) - (b[i] as number)))
      document.body.dataset.titleFrameDrift = String(drift)
      if (drift > 1e-6) {
        console.warn(
          `title: the emblem was placed through a frame ${drift} away from the valley — ` +
            'terrainOriginSim and loadTerrain disagree about where alpine.forest goes',
        )
      }
    }

    // ── the flypast's own two jets (DEV-281) ───────────────────────────────
    //
    // 2016 flies TWO ships past the logo — `npc_aiShip` on `path_ai_02` and
    // `npc_aiShip_02` on `path_ai`, each a `SplineWalker` in `main_menu.unity`
    // — and DEV-215 put them on those two splines. What they FLEW, until now,
    // was two meshes borrowed off the mission's AI racers, with `setVisible`
    // handing them back on the way out so a mission did not start an opponent
    // short.
    //
    // They cannot be borrowed any more, because there is no mission: the island,
    // the ship and the racers are not built until a course is chosen. So the
    // title screen loads its own pair, which is also what `main_menu.unity`
    // does — those walkers carry their own ships and have nothing to do with a
    // level's grid.
    //
    // The LOOK is the racers' own, from one place: `dressRacerHull` (DEV-350)
    // paints the livery's first two colours and wears them on Anniversary, and
    // the hologram — `racerMaterial`, unchanged to the pixel — on Classic. The
    // in-game jets' wing since DEV-412 (Matt, 2026-09-25: *"the same wing geo
    // as the in-game jets"*); DEV-310 and DEV-322 had left it off. Read off the preset the title is
    // built under and never flipped, because nothing returns to this screen.
    //
    // Under `title.object`, so one `setVisible` puts the whole screen down —
    // three's `visible` is not inherited as a property but IS obeyed as an
    // ancestor flag — and so `title.dispose()` frees them with everything else
    // it made. Non-fatal like the logo: a title screen with no flypast is worth
    // shipping, a boot that fails because a GLB 404'd is not.
    const titleJets: THREE.Object3D[] = []
    const titleTrailJets: TitleTrailJet[] = []
    // DEV-359: each jet's look, KEPT — its solid materials for the fog and the
    // far-field term, its meshes for the sun's map. They were thrown away here,
    // which is why the flypast cast nothing and wore no air.
    const titleJetLooks: Awaited<ReturnType<typeof dressRacerHull>>['look'][] = []
    try {
      const jetMaterial = racerMaterial()
      const livery = editionState.current.render.racerLivery
      for (let i = 0; i < TITLE_2016.flypaths.length; i++) {
        const gltf = await loadMesh(assetUrl(SHIP_MESH_EXTERIOR))
        // The same three lines `racers.ts` puts a racer's art under, and for
        // the same reason: the hull GLB is authored around the COCKPIT's
        // origin, so a mesh added raw flies with the pilot's eye on the path
        // instead of the ship. BEFORE the dressing since DEV-412, because the
        // wing tips are measured in this frame, as `racers.ts` measures them.
        gltf.object.position.copy(ART_POSITION)
        gltf.object.rotation.y = SHIP_MODEL_YAW
        gltf.object.scale.copy(ART_SCALE)
        const tips = measureWingTips(gltf.object)
        const { look, glow, colour } = await dressRacerHull(
          gltf.object,
          livery,
          i,
          jetMaterial,
          true,
        )
        titleJetLooks.push(look)
        if (glow) ctx.liveTitleGlows.push(glow)
        const jet = new THREE.Group()
        jet.name = `title-jet:${i}`
        jet.add(gltf.object)
        ctx.title.object.add(jet)
        titleJets.push(jet)
        titleTrailJets.push({ object: jet, tips, colour })
      }
    } catch (err) {
      console.warn('title: the flypast ships did not load', err)
    }
    ctx.liveTitleJets = titleJets
    // DEV-412: and the racers' two trails on them. World-space ribbons, so at
    // the scene ROOT and not under `title.object`.
    if (titleTrailJets.length > 0) {
      ctx.liveTitleTrails = createTitleTrails(titleTrailJets, editionState)
      render.scene.add(ctx.liveTitleTrails.group)
    }

    // ── the menu's own air ─────────────────────────────────────────────
    //
    // DEV-155. `TITLE_SUN` swapped the sun and left the fog and the ambient
    // as `int_01`'s; see `TITLE_FOG` / `TITLE_IBL` for the provenance and
    // for why this is one more instance of the bug Matt already caught once.
    //
    // The valley's own chunks had NO fog at all before this — the loop that
    // fogs the terrain walks `terrain.group.children`, the island's, and the
    // valley was never in it — so the forest above would have faded into a
    // pink that the mountains behind it did not share. Both go through this
    // fog now, and it is the ONLY thing they go through.
    ctx.titleFog = createUnityFog({
      mode: TITLE_FOG.mode,
      density: TITLE_FOG.density,
      linearStart: TITLE_FOG.linearStart,
      linearEnd: TITLE_FOG.linearEnd,
      color: [
        TITLE_FOG.colorSrgb[0] as number,
        TITLE_FOG.colorSrgb[1] as number,
        TITLE_FOG.colorSrgb[2] as number,
      ],
      distanceFog: FOG_ENABLED,
      // No `GlobalFog` on the menu camera. See `TITLE_FOG`.
      heightFog: false,
      useRadialDistance: false,
      height: 0,
      heightDensity: 0,
      startDistance: 0,
      // The flat colour, deliberately: the menu's skybox is
      // `Cubemaps/ForestSky.mat` and nothing in the port has decoded it, so
      // there is no sky to take a ray's colour from. `FOG_TAKES_SKY_COLOUR`
      // is not consulted here because there is nothing for it to choose.
      skySh: null,
      sunDirection: [
        TITLE_SUN.direction[0] as number,
        TITLE_SUN.direction[1] as number,
        TITLE_SUN.direction[2] as number,
      ],
    })
    // `materials`, not the chunks' — see the mission terrain's own loop for
    // why a chunk's material is no longer necessarily the terrain's (DEV-183).
    // The valley has no water and therefore no bands today; it is written the
    // same way so that it cannot acquire the bug by acquiring a sea.
    for (const m of titleValley.materials) {
      ctx.titleFog.applyTo(m)
      // DEV-298. The title screen had NO far-field term at all until now —
      // neither DEV-116's terrain shadow nor DEV-295's canopy — and the reason
      // was a mapping rather than an oversight: this valley's group carries an
      // 87-degree rotation and `(world - origin) / scale` cannot express one.
      // `worldToFieldMatrix` is that mapping, and it resolves to the identity
      // for a mission, so the shipped path is unchanged by wiring this.
      farShadow.applyTo(m, 'ground')
      // DEV-359: the land's third door, DEV-333's, in `applyGroundAtmosphere`'s
      // order — fog, far-field, sky. Keyed on the facet's own uv, so the
      // valley's rotation never reaches it; baked below, with the sweep.
      skyVisibility.applyTo(m)
    }
    // DEV-359: and the jets through the world's door, as a mission's racers'
    // solid materials go through `applyAtmosphere` — the valley's fog and the
    // far-field term. The hologram never did and still does not, so Classic's
    // flypast is unchanged: these materials are on no mesh there.
    // DEV-412: the trails take the title's air, as the jets do.
    for (const m of ctx.liveTitleTrails?.materials ?? []) ctx.titleFog.applyTo(m)
    for (const look of titleJetLooks) {
      for (const m of look.solidMaterials) {
        ctx.titleFog.applyTo(m)
        farShadow.applyTo(m)
      }
    }

    // ── the forest the title screen stands in ──────────────────────────
    //
    // Matt, 2026-09-16: *"i'd like you to revise the title screen to be more
    // accurate to the original. the rough idea is there, but the details are
    // all wrong."* The first detail is that 2016's is IN A FOREST and the
    // port's was a bald valley. DEV-155.
    //
    // The trees are 2016's own and they are a FIFTH environment, `menu`, not
    // a second use of `alpine`. `AlpineTerrain_menu` inside `main_menu.unity`
    // is a disconnected copy of `Prefabs/Menus/AlpineTerrain_menu.prefab`
    // carrying the same height map and terrain params as the mission valley
    // and a DIFFERENT scatter: its enabled pass is baked with **3,999**
    // objects at `ObjectScaleMin 6` .. `ObjectScaleMax 20`,
    // `ObjectProbabilityScale 0.02`, `ObjectHeightOffset -5`. The mission
    // environment's big-tree pass is the one `m_Enabled: 0` with an empty
    // `_StoredChunks` (DEV-102), so `loadProps('alpine')` here would have
    // drawn the wrong pass on Classic and nothing that 2016 shipped.
    //
    // Parented to the VALLEY group, which already carries 2016's rotation, so
    // the trees swing with the ground they stand on and no arithmetic is
    // repeated (the DEV-042 rule).
    //
    // Non-fatal, like the mission's: `public/assets/props/` is gitignored and
    // a clone that has not pulled it must still reach the title screen.
    //
    // Held past the block (DEV-359): the sun's map and the canopy bake below
    // need its meshes and its placements, and both run whether or not it came.
    let titleProps: Awaited<ReturnType<typeof loadProps>> = null
    if (PROPS_ON) {
      try {
        // ── DEV-287: the authored no-prop volumes for this valley ─────
        //
        // No mission stands here, so every anchor would drop; `menu`'s
        // entries are written as explicit points in the terrain's own mesh
        // space, which is the frame `TITLE_2016.cameraMesh` is in — so a
        // volume's coordinates read directly against the camera's, in the
        // same units, two files apart. The origin is passed anyway rather
        // than stubbed, so an anchored volume added here later is resolved
        // rather than silently misplaced.
        const valleyVolumes = resolveNoPropVolumes(await loadNoPropVolumes(), {
          environmentId: 'menu',
          missionId: null,
          origin: terrainOriginSim(titleValley.key, TITLE_VALLEY_OFFSET).position,
          anchors: { gates: [] },
        })
        const valleyProps = await loadProps('menu', {
          terrain: {
            terrainSize: titleValley.params.terrainSize,
            terrainHeight: titleValley.params.terrainHeight,
            chunkSize: titleValley.params.chunkSize,
          },
          heightMap: titleValley.heightMap,
          unbakedPasses: editionState.current.props.unbakedPasses.enabled,
          scale: editionState.current.props.scale,
          groundSnap: editionState.current.props.groundSnap.enabled
            ? {
                params: titleValley.params,
                sink: editionState.current.props.groundSnap.sink,
              }
            : null,
          // None extracted, by decision — `main_menu.unity`'s hand-placed art
          // is the TITLE SCENE (a chair, a parked SR9, three podiums), not the
          // environment's. See `SCENE_SOURCE` in `tools/extract/props.mjs`.
          landmarks: null,
          noPropVolumes: valleyVolumes.volumes,
          ...(PROP_CELLS !== undefined ? { cellsPerAxis: PROP_CELLS } : {}),
          // ── the title valley keeps every prop, on purpose (DEV-225) ────
          //
          // `menu`'s two generators carry their own extracted 800 m and
          // 1024 m, so applying 2016's reveal here would be as faithful as
          // it is everywhere else — and `horizontalDistance` ignores
          // ALTITUDE, which is right for a pilot and is not obviously right
          // for THIS camera. DEV-041 put the title eye deliberately ABOVE
          // everything, where occlusion is impossible rather than unlikely,
          // and a horizontal radius measured from there covers a different
          // patch of valley than 2016's menu camera ever did.
          //
          // Nobody has photographed the difference. This is the first screen
          // a stranger sees, and a thing that is too small, too dark or
          // off-screen has not been reviewed, it has been rendered (DEV-044).
          // So the default here is the frame this screen already has, and
          // `?propLod=<metres>` turns the reveal on for whoever takes that
          // screenshot.
          lodDistance: PROP_LOD ?? Number.POSITIVE_INFINITY,
        })
        if (valleyProps) {
          titleValley.group.add(valleyProps.group)
          ctx.titleValleyPropsDispose = () => valleyProps.dispose()
          for (const child of valleyProps.group.children) {
            for (const inst of child.children) {
              const m = (inst as THREE.Mesh).material as THREE.Material | undefined
              // The VALLEY's fog, not the mission's. A tree standing on
              // unfogged ground inside a pink height fog is the artifact
              // this whole block exists to not ship.
              if (m) ctx.titleFog?.applyTo(m)
              // And the valley's own canopy shade (DEV-298), by the same
              // argument the mission's props take it.
              if (m) farShadow.applyTo(m, 'prop')
            }
          }
          // DEV-298's sweep lived here and moved below, sliced, with the rest
          // of the title's bakes (DEV-359).
          titleProps = valleyProps
          console.info(
            `title props: ${valleyProps.instanceCount} instances in ` +
              `${valleyProps.drawCalls} draw calls (menu, ${editionState.current.id})` +
              `; ${describeVolumes(valleyVolumes)} took out ` +
              `${valleyProps.clearedByVolumes} (DEV-287)`,
          )
        }
      } catch (err) {
        console.warn('title: the menu forest did not load', err)
      }
    }

    // ── DEV-359: the title's shadows, and its bakes, the mission's way ─────
    //
    // Matt: *"titlescreen: trees and ai hoverjet needs shadows & bake pass."*
    // What a mission world had and this one did not, read from the code and
    // confirmed on the frame (DEVIATIONS DEV-359 has the table):
    //
    //  * **The sun's map ran here with NOTHING in it.** `createSunShadows`
    //    turns the map and the sun's `castShadow` on at boot, so on Anniversary
    //    the title paid for a depth pass every frame — and `attach` was only
    //    ever called by `buildWorld`, so not one object cast or received.
    //  * **Which also took half the canopy bake away.** DEV-304 hands the
    //    canopy's DIRECT half to the map whenever the scatter is in the caster
    //    set (`canopyDirectWeight`, a uniform shared by every world). It was in
    //    the set by the preset and absent from the map by this omission, so
    //    since DEV-304 the forest floor here has had the bake's indirect half
    //    and no shadow in place of the other.
    //  * **DEV-333's sky visibility was never wired** (the door is above), and
    //    **DEV-298's sweep marched the world's sun across the valley's rotated
    //    field** — 59.8 degrees off; `sunTravelInFieldFrame` says why.
    //
    // So: the same `attach` a mission makes, handed this world's valley, forest
    // and jets, and the same two bakes, run through a slicer as DEV-355 runs a
    // mission's so the emblem keeps its frames while they go. Classic is
    // untouched by construction — `shadowsEnabled` is false there and `attach`
    // writes no flag, the sweep is inert behind `render.sunHeight`, and the
    // sky bake does not run behind its own gate. Everything here is after the
    // valley landed, so the emblem is not waited on (DEV-352).
    sunShadows.attach({
      terrains: [titleValley],
      scatter: titleProps?.scatterMeshes ?? [],
      landmarks: titleProps?.landmarkMeshes ?? [],
      // A racer's row: casts, does not receive, and only while solid.
      racers: titleJetLooks.flatMap((look) => look.shadowMeshes),
    })
    {
      const titleSlicer = createSlicer()
      // DEV-298's sweep, moved here from the forest block so that it runs
      // whether or not the forest came, and stepped. The group's world matrix
      // is what maps the rotated valley at all — `updateWorldMatrix` first,
      // because three does not recompute a matrix until it renders.
      titleValley.group.updateWorldMatrix(true, false)
      const valleySpec = editionState.current.render.canopyShade
      const valleyCanopy =
        valleySpec.enabled && titleProps
          ? buildCanopyField(titleValley.heightField, titleProps.colliderInputs, valleySpec)
          : null
      await titleSlicer.checkpoint()
      const sweepStart = performance.now()
      const titleSweep = await titleSlicer.drain(
        farShadow.setWorldSteps(
          titleValley.heightField,
          [
            TITLE_SUN.direction[0] as number,
            TITLE_SUN.direction[1] as number,
            TITLE_SUN.direction[2] as number,
          ],
          titleValley.params.randomOffset * (titleValley.heightField.scaleY || 1),
          valleyCanopy,
          titleValley.group.matrixWorld,
        ),
      )
      const sweepMs = performance.now() - sweepStart
      // DEV-333, from the sweep just taken, lit by the sun the frame loop puts
      // on this screen: `TITLE_SUN`'s sRGB colour at Marmoset's 2 pi, which is
      // what `missionSun` carries while `screen === 'title'`.
      const titleSkyBake = await titleSlicer.drain(
        skyVisibility.setWorldSteps(
          titleValley.heightField,
          titleValley.colorMap,
          titleSweep,
          new THREE.Color()
            .setRGB(
              TITLE_SUN.colorSrgb[0],
              TITLE_SUN.colorSrgb[1],
              TITLE_SUN.colorSrgb[2],
              THREE.SRGBColorSpace,
            )
            .multiplyScalar(marmosetSunIntensity(TITLE_SUN.intensity)),
        ),
      )
      await titleSlicer.checkpoint()
      if (valleyCanopy) {
        console.info(
          `title canopy-shade: swept ${valleyCanopy.counted} props ` +
            `(${valleyCanopy.offGrid} off-grid) — ` +
            `${(valleyCanopy.occludedFraction * 100).toFixed(1)} % of the grid, p50 ` +
            `${valleyCanopy.p50Occluded.toFixed(3)}`,
        )
      }
      console.info(
        `title bakes: sun-height ${titleSweep ? `${titleSweep.vertPerSide}² in ${sweepMs.toFixed(0)} ms` : 'off'}` +
          `, sky-visibility ${titleSkyBake ? `${titleSkyBake.samplesPerSide}² in ${skyVisibility.bakeMs.toFixed(0)} ms` : 'off'}` +
          ` (${titleSlicer.yields} yields); sun map ${sunShadows.on ? 'on' : 'off'} — ` +
          `${titleProps?.scatterMeshes.length ?? 0} scatter meshes, ` +
          `${titleJetLooks.length} jets handed to it (DEV-359)`,
      )
    }

    // ── the first draw of the title screen, under the curtain ─────────────
    //
    // The valley used to be warmed by the MISSION's `warmWorld`, as a passenger:
    // `renderer.render(scene, camera)` compiles everything in the scene, and
    // before DEV-281 both worlds were in it by then. With the island gone from
    // boot there is nothing to ride on, and the alternative is compiling the
    // forest, the sky, the emblem and its spot in the clear, on the first frame
    // a visitor sees.
    //
    // The ROOT is the whole scene rather than the valley group, deliberately —
    // `warmWorld` unculls what it is given and the title screen is four roots
    // (terrain, forest, `title.object` with its jets, the dome) plus a probe.
    // At this moment the scene holds the title world and the shell and nothing
    // else, which is exactly the set that wants compiling.
    //
    // `alsoDefaultTarget` for the same reason the mission passes it: this runs
    // under the curtain, before `#enter-vr` has been pressed, so `willComposite`
    // is true on Anniversary and a session would draw through a binding nothing
    // had been compiled against (DEV-239).
    const titleWarm = warmWorld(
      render.renderer,
      render.scene,
      render.camera,
      render.scene,
      { offscreen: bloom.willComposite(), alsoDefaultTarget: capabilities.immersiveVr },
      () => performance.now(),
    )
    console.info(
      `warm-up: first draw of the title screen in ${titleWarm.ms.toFixed(0)} ms — ` +
        `${titleWarm.programs} programs, ${titleWarm.geometries} geometries, ` +
        `${titleWarm.meshes} meshes unculled`,
    )

    ctx.liveTitleValley = titleValley
    // ── and the valley fades in behind the emblem (DEV-352) ──────────────
    //
    // Over 2016's own mission-camera fade, `LOAD_FADE_SECONDS` — the one it
    // tuned for arriving somewhere after real work, which is what this is.
    // The flypast starts its clock on this frame rather than at boot, so the
    // opening pass (278 m to 14 m over 5.6 s, `render/title.ts`) is flown into
    // a valley you can see instead of behind the curtain.
    // DEV-611: behind a splash, on its fade, so the opening pass is SEEN.
    if (splash === null) ctx.titleCurtain?.lift(LOAD_FADE_SECONDS)
    else void splash.lifting.then(() => ctx.titleCurtain?.lift(LOAD_FADE_SECONDS))
    // The counterpart of `data-terrain-ready`, and deliberately NOT the same
    // attribute. `terrain-ready` means *the mission world is in the scene*, and
    // since DEV-281 a boot into the title screen does not build one — so a spec
    // that waited for it here would be waiting for a course nobody has chosen.
    // Two worlds, two facts, two attributes.
    document.body.dataset.titleReady = 'true'
    // DEV-413: the number a pasted console could not give. Matt's log of
    // 2026-09-26 had the probe at 156 ms and every step fast, and no
    // timestamps, so no total. `performance.now()` counts from navigation, and
    // the last response says whether the wait was the network or the work.
    const titleResources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const titleNetDone = titleResources.reduce((m, e) => Math.max(m, e.responseEnd), 0)
    console.info(
      `title: ready ${Math.round(performance.now())} ms after navigation; ` +
        `${titleResources.length} requests, the last done at ${Math.round(titleNetDone)} ms (DEV-413)`,
    )
    loading.ready()
    return { valley: titleValley }
  }
  return {
    buildTitleWorld,
  }
}
