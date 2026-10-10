// src/render/tv-panel.ts: TV's on-screen layer. DEV-482 (plan/FF-TV.md §5.2).
//
// Three canvas panels, each a mesh with its own texture: the IDENT
// (`tv-panel-ident`), the LOWER THIRD (`tv-panel-lower-third`) and the RESULTS
// card (`tv-panel-results`). What they say and where they stand is
// `render/tv-panel-layout.ts`, which is pure and unit-tested; this file owns
// the canvases, the meshes, the press on a name, and nothing else.
//
// UI through the bloom's own door: `toneMapped: false` is what
// `render/bloom.ts`'s `classify()` moves onto `UI_LAYER` (3), stereo, crisp,
// drawn after the world. Nothing here sets a layer: 1 and 2 are the WebXR
// eyes (DEV-141, `tests/unit/xr-eye-layers.test.ts`). `depthTest: false`, as
// the HUD has it, because on Classic and in a headset (no bloom, no classify)
// the panel is drawn in the world pass and must not be cut by a hillside.
//
// WHERE: a flat screen hangs the panels on the CAMERA, fitted to its frustum
// (screen-anchored; portrait first on a phone). A headset hangs them on the
// RIG against the head (`createTvCutAnchor`): at launch RIG-LOCKED like a
// cockpit display (placed again only on a camera-mode change or a large head
// drift), because the rig now moves as the flat camera does (DEV-481
// follow-up); with the comfort cuts on, once per cut.
//
// The PRESS: on a flat screen or a phone, a tap or a click on a standings row
// calls `onPick(row.follow)`, which `boot/app.ts` hands the camera's
// `follow(n)`. Plane arithmetic, not three's raycaster: a raycaster tests
// layer 0 only and this mesh may be on layer 3 (DEV-472).

import * as THREE from 'three'
import type { TvMapView } from '@/game/tv/tv-camera'
import { type PlaneHit, rayPlaneHit } from '@/render/ui-pick'
import { readHeadPose, readHeadPosition, type XrCameraSource } from './head-pose'
import { buildEmblem, LOADING_EMBLEM_WIDTH } from './loading-scene'
import { disposeTree } from './scene-walk'
import { buildTvBugParts, type TvBugParts } from './tv-bug'
import { createTvGaps } from './tv-gaps'
import { MAP_CANVAS, paintMapPlate, type TvMapCtx, tvMapKey } from './tv-map-plate'
import {
  BANNER_CANVAS,
  createTvCutAnchor,
  identCanvas,
  LOWER_THIRD_CANVAS,
  type LowerThirdLayout,
  layoutLowerThird,
  lowerThirdKey,
  lowerThirdRowAt,
  paintBanner,
  paintIdent,
  paintLowerThird,
  paintResults,
  RESULTS_CANVAS,
  stepTvPanel,
  TV_BANNER_SECONDS,
  TV_PANEL_IDLE,
  type TvAnchorPolicy,
  type TvBannerKind,
  type TvCtx,
  type TvCue,
  type TvPanelFeed,
  type TvPanelKind,
  type TvPanelPlace,
  type TvPanelShown,
  type TvPanelState,
  tvBannerAlpha,
  tvDrawnName,
  tvFlatPlacement,
  tvHeadsetPlacement,
  tvIdentLine,
} from './tv-panel-layout'

export const TV_PANEL_NAMES = {
  group: 'tv-panel',
  ident: 'tv-panel-ident',
  lowerThird: 'tv-panel-lower-third',
  results: 'tv-panel-results',
  bug: 'tv-panel-bug',
  banner: 'tv-panel-banner',
  map: 'tv-panel-map',
} as const

export interface TvPanelOptions {
  readonly rig: THREE.Object3D
  readonly camera: THREE.PerspectiveCamera
  /** The renderer's canvas: where a press on a name lands. */
  readonly canvas: HTMLElement
  /** `renderer.xr`: whether a headset presents, and the head's pose (through `render/head-pose.ts`). */
  readonly xr: XrCameraSource
  /** A press on a standings row: the camera's `follow(n)`. */
  readonly onPick: (follow: number) => void
  /** The headset anchor's policy, read each frame (`TvAnchorPolicy`). Absent: once per cut. */
  readonly anchor?: () => TvAnchorPolicy
}

/** What `__ff2.tvPanel.probe()` returns: enough for a spec to know what is up and where. */
export interface TvPanelReport {
  readonly shown: TvPanelShown
  readonly portrait: boolean
  readonly presenting: boolean
  readonly ident: string
  readonly rows: readonly string[]
  readonly followed: string | null
  /** Headset placements made: one per cut while a panel stands. */
  readonly cuts: number
  readonly picks: number
  readonly lastPick: number | null
  /** DEV-617: the bug is standing in its corner. */
  readonly bug: boolean
  /** DEV-654: the lower third's line while it stands (`CUTTER takes #1`), or null. */
  readonly banner: string | null
  /** DEV-866: the mini-map plate is standing. */
  readonly map: boolean
  /** DEV-653: the wordmark's and the V's right edges on screen, CSS px, or null. */
  readonly bugEdges: { readonly wordRightPx: number; readonly tvRightPx: number } | null
  /** The lower third's rows as painted, canvas px (`LOWER_THIRD_CANVAS`): where a press lands. */
  readonly layout: {
    readonly top: number
    readonly rows: readonly { readonly follow: number; readonly y: number; readonly h: number }[]
  } | null
}

export interface TvPanel {
  readonly group: THREE.Group
  /**
   * Once a frame, after TV's camera has placed the rig. Returns the cues the
   * moment asks for. `onScreen` false (the loading scene is up) hides the
   * panels but keeps the show's state, so a course load inside one show is not
   * a second sting.
   */
  update(feed: TvPanelFeed | null, dt: number, onScreen?: boolean): TvCue[]
  /**
   * DEV-617: the title's logo arrives, for the BUG (the game's emblem in the
   * corner while TV is on): the glTF root of `assets/props/title-logo.glb`,
   * copied (`buildEmblem`, the loading plate's) and never kept. False if the
   * logo has nothing to draw: TV then shows no bug.
   */
  emblem(logo: THREE.Object3D): boolean
  /**
   * DEV-654: put a line on the lower third (`CUTTER takes #1`, `CUTTER wins`) for
   * `TV_BANNER_SECONDS` of on-screen time. A new line replaces the one standing.
   */
  announce(line: string, kind: TvBannerKind): void
  /**
   * DEV-866: the course and the field for the mini-map plate, and the HUD's speed unit,
   * once a frame before `update`. Null: no plate.
   */
  map(view: TvMapView | null, speedUnit: 'ms' | 'kmh'): void
  report(): TvPanelReport
  dispose(): void
}

interface Panel {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshBasicMaterial
  key: string
}

const makeCanvas = (
  w: number,
  h: number,
): { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } => {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return { canvas, texture }
}

const makePanel = (name: string, texture: THREE.Texture): Panel => {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material)
  mesh.name = name
  mesh.renderOrder = 20
  mesh.visible = false
  mesh.frustumCulled = false
  return { mesh, material, key: '' }
}

const ctxOf = (canvas: HTMLCanvasElement): TvCtx | null =>
  canvas.getContext('2d') as unknown as TvCtx | null

const place = (mesh: THREE.Object3D, p: TvPanelPlace): void => {
  mesh.position.set(p.position[0], p.position[1], p.position[2])
  mesh.rotation.order = 'YXZ'
  mesh.rotation.set(p.pitch, p.yaw, 0)
  mesh.scale.set(p.width, p.height, 1)
}

/** A tap, not a drag: the look is a drag (`tv-camera-input.ts`). */
const TAP_PX = 12
const TAP_MS = 500

export const createTvPanel = (o: TvPanelOptions): TvPanel => {
  const group = new THREE.Group()
  group.name = TV_PANEL_NAMES.group

  const identWide = makeCanvas(identCanvas(false).width, identCanvas(false).height)
  const identTall = makeCanvas(identCanvas(true).width, identCanvas(true).height)
  const lower = makeCanvas(LOWER_THIRD_CANVAS.width, LOWER_THIRD_CANVAS.height)
  const results = makeCanvas(RESULTS_CANVAS.width, RESULTS_CANVAS.height)
  const bannerCanvas = makeCanvas(BANNER_CANVAS.width, BANNER_CANVAS.height)

  const ident = makePanel(TV_PANEL_NAMES.ident, identWide.texture)
  const lowerThird = makePanel(TV_PANEL_NAMES.lowerThird, lower.texture)
  const card = makePanel(TV_PANEL_NAMES.results, results.texture)
  const banner = makePanel(TV_PANEL_NAMES.banner, bannerCanvas.texture)
  const mapCanvas = makeCanvas(MAP_CANVAS.width, MAP_CANVAS.height)
  const mapPanel = makePanel(TV_PANEL_NAMES.map, mapCanvas.texture)
  group.add(ident.mesh, lowerThird.mesh, card.mesh, banner.mesh, mapPanel.mesh)
  // DEV-866: the view and unit written for this frame, and the seconds since the plate last repainted.
  let mapView: TvMapView | null = null
  let mapUnit: 'ms' | 'kmh' = 'kmh'
  let mapSince = 1
  let mapUp = false
  // DEV-654: the line standing on the lower third, its kind, and its seconds left.
  let bannerLine = ''
  let bannerKind: TvBannerKind = 'overtake'
  let bannerLeft = 0

  // ── DEV-617: the bug ───────────────────────────────────────────────────
  // The emblem the loading plate turns (`buildEmblem`), held still and shaded
  // once, in a group whose origin is the emblem's CENTRE, so `place` can stand
  // it like a panel. Unlit, as the panels are (`toneMapped: false` is the
  // UI's door, `render/bloom.ts`); the loading plate's own material
  // parameters, so it links the plate's program rather than a new one.
  // Depth-tested against itself: it is a solid, and drawn without a depth
  // test its back faces would land over its front.
  const bugMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  })
  const bug = new THREE.Group()
  bug.name = TV_PANEL_NAMES.bug
  bug.visible = false
  let bugAspect = 1
  let bugBuilt = false
  let bugParts: TvBugParts | null = null
  let bugCentre: THREE.Group | null = null
  let bugShown = false
  group.add(bug)

  let state: TvPanelState = TV_PANEL_IDLE
  let boardAlpha = 0
  const gaps = createTvGaps()
  let shown: TvPanelShown = { ident: false, lowerThird: false, results: false }
  let feedNow: TvPanelFeed | null = null
  let layout: LowerThirdLayout | null = null
  let portrait = false
  let presentingNow = false
  let picks = 0
  let lastPick: number | null = null
  const anchor = createTvCutAnchor()

  const _rigPose: [number, number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0, 1]
  const _head = new THREE.Vector3()

  const paintIf = (panel: Panel, key: string, paint: () => void): void => {
    if (panel.key === key) return
    panel.key = key
    paint()
    const map = panel.material.map
    if (map) map.needsUpdate = true
  }

  const aspectOf = (kind: TvPanelKind): number => {
    if (kind === 'bug') return bugAspect
    if (kind === 'banner') return BANNER_CANVAS.width / BANNER_CANVAS.height
    if (kind === 'map') return MAP_CANVAS.width / MAP_CANVAS.height
    if (kind === 'lowerThird') return LOWER_THIRD_CANVAS.width / LOWER_THIRD_CANVAS.height
    if (kind === 'results') return RESULTS_CANVAS.width / RESULTS_CANVAS.height
    const c = identCanvas(portrait)
    return c.width / c.height
  }

  /** The head at the last cut, in a session (read every frame, shown or not); null on a flat screen. */
  const anchorHead = (presenting: boolean): readonly [number, number, number] | null => {
    if (!presenting) {
      anchor.reset()
      return null
    }
    const r = o.rig
    _rigPose[0] = r.position.x
    _rigPose[1] = r.position.y
    _rigPose[2] = r.position.z
    _rigPose[3] = r.quaternion.x
    _rigPose[4] = r.quaternion.y
    _rigPose[5] = r.quaternion.z
    _rigPose[6] = r.quaternion.w
    // The head, through the one door (`render/head-pose.ts`), taken into the rig's frame.
    readHeadPosition(o.xr, o.camera, _head)
    r.worldToLocal(_head)
    return anchor.update(_rigPose, [_head.x, _head.y, _head.z], o.anchor?.()).head
  }

  const placeAll = (head: readonly [number, number, number] | null): void => {
    const parent = head ? o.rig : o.camera
    if (group.parent !== parent) parent.add(group)
    const view = { fovDeg: o.camera.fov, aspect: o.camera.aspect }
    for (const [kind, panel] of [
      ['ident', ident],
      ['lowerThird', lowerThird],
      ['results', card],
      ['banner', banner],
      ['map', mapPanel],
    ] as const) {
      if (!panel.mesh.visible) continue
      place(
        panel.mesh,
        head
          ? tvHeadsetPlacement(kind, head, aspectOf(kind))
          : tvFlatPlacement(
              kind,
              view,
              aspectOf(kind),
              // The board hangs from its margin, whatever it holds (DEV-653).
              kind === 'lowerThird' && layout ? layout.top / LOWER_THIRD_CANVAS.height : 0,
            ),
      )
    }
    if (bug.visible) {
      const p = head
        ? tvHeadsetPlacement('bug', head, bugAspect)
        : tvFlatPlacement('bug', view, bugAspect)
      place(bug, p)
      // A solid, not a 1 x 1 plane: scaled evenly, from the emblem's own width.
      bug.scale.setScalar(p.width / LOADING_EMBLEM_WIDTH)
    }
  }

  /**
   * DEV-653: where the wordmark's right edge (the T of FLIGHT) and the V's ink
   * right edge are on the canvas, CSS px, as the camera sees them now: a spec
   * holds them within a pixel at 1080p. Null while the bug is not showing.
   */
  const _edge = new THREE.Vector3()
  const bugEdgesPx = (): { wordRightPx: number; tvRightPx: number } | null => {
    if (!bugShown || !bugParts || !bugCentre) return null
    const { wordRight, tvRight, z } = bugParts.edges()
    const w = o.canvas.clientWidth
    bug.updateWorldMatrix(true, true)
    o.camera.updateMatrixWorld(true)
    const px = (x: number): number => {
      _edge.set(x, 0, z)
      bugCentre?.localToWorld(_edge)
      _edge.project(o.camera)
      return ((_edge.x + 1) / 2) * w
    }
    return { wordRightPx: px(wordRight), tvRightPx: px(tvRight) }
  }

  // ── a press on a name ────────────────────────────────────────────────────
  const downs = new Map<number, { x: number; y: number; t: number }>()
  const _o = new THREE.Vector3()
  const _d = new THREE.Vector3()
  const _q = new THREE.Quaternion()
  const _inv = new THREE.Matrix4()
  const _lo = new THREE.Vector3()
  const _ld = new THREE.Vector3()
  const _hit: PlaneHit = { x: 0, y: 0 }
  const onDown = (ev: Event): void => {
    const e = ev as PointerEvent
    if (e.pointerType === 'mouse' && e.button !== 0) return
    downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp })
  }
  const onUp = (ev: Event): void => {
    const e = ev as PointerEvent
    const d = downs.get(e.pointerId)
    downs.delete(e.pointerId)
    if (!d || presentingNow || !shown.lowerThird || !layout || boardAlpha < 0.5) return
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX || e.timeStamp - d.t > TAP_MS) return
    const rect = o.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ny = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
    // The matrices the frame on screen was drawn with: what the viewer pressed.
    readHeadPose(o.xr, o.camera, _o, _q)
    _d.set(nx, ny, 0.5)
      .applyMatrix4(o.camera.projectionMatrixInverse)
      .normalize()
      .applyQuaternion(_q)
    const mesh = lowerThird.mesh
    _inv.copy(mesh.matrixWorld).invert()
    // NOT `toPanelLocal`: this is the matrix the frame on screen was drawn with
    // (see above), so no refresh. The local direction carries the panel's scale,
    // so it is not a unit vector and the solve takes its own epsilon.
    _lo.copy(_o).applyMatrix4(_inv)
    _ld.copy(_o).add(_d).applyMatrix4(_inv).sub(_lo)
    if (!rayPlaneHit(_hit, _lo.x, _lo.y, _lo.z, _ld.x, _ld.y, _ld.z, 1e-9)) return
    const u = _hit.x + 0.5
    const v = 0.5 - _hit.y
    if (u < 0 || u > 1 || v < 0 || v > 1) return
    const row = lowerThirdRowAt(layout, u * LOWER_THIRD_CANVAS.width, v * LOWER_THIRD_CANVAS.height)
    if (!row) return
    picks++
    lastPick = row.follow
    o.onPick(row.follow)
  }
  o.canvas.addEventListener('pointerdown', onDown)
  o.canvas.addEventListener('pointerup', onUp)

  return {
    group,
    update(feedIn, dt, onScreen = true) {
      // DEV-653: the ident's and the board's seconds are ON-SCREEN seconds: a
      // course load under the loading scene does not spend them.
      const step = stepTvPanel(state, feedIn, onScreen ? dt : 0)
      state = step.state
      shown = step.shown
      boardAlpha = step.board
      // The gap to the leader and the followed racer's split (`render/tv-gaps.ts`).
      let feed: TvPanelFeed | null = feedIn
      if (feedIn) feed = gaps.observe(feedIn)
      else gaps.reset()
      feedNow = feed
      presentingNow = o.xr.isPresenting
      portrait = !presentingNow && o.camera.aspect < 1
      if (!onScreen) shown = { ident: false, lowerThird: false, results: false }
      ident.mesh.visible = shown.ident
      lowerThird.mesh.visible = shown.lowerThird
      lowerThird.material.opacity = boardAlpha
      card.mesh.visible = shown.results
      // DEV-654: the line counts ON-SCREEN seconds, as the board's do.
      if (onScreen && bannerLeft > 0) bannerLeft = Math.max(0, bannerLeft - dt)
      const bannerUp = feed !== null && onScreen && bannerLeft > 0
      banner.mesh.visible = bannerUp
      banner.material.opacity = tvBannerAlpha(bannerLeft)
      // DEV-617: the bug stands for as long as TV is on screen, through every panel.
      // DEV-792 (item 11): not in a headset, which has no screen corner (Matt, 2026-10-07).
      bugShown = feed !== null && onScreen && bugBuilt && !presentingNow
      bug.visible = bugShown
      // DEV-866: the mini-map stands for the whole flight (the board fades; where the racer is
      // does not), under the ident's few seconds and the results' card.
      mapUp =
        feed !== null &&
        onScreen &&
        mapView !== null &&
        feed.phase === 'racing' &&
        !shown.ident &&
        !shown.results
      mapPanel.mesh.visible = mapUp
      mapPanel.material.opacity = 1
      mapSince += dt
      group.visible =
        shown.ident || shown.lowerThird || shown.results || bugShown || bannerUp || mapUp
      // Cuts are counted while TV is on, shown or not, so a panel that comes up
      // mid-hold stands against the head as it was at the cut.
      const head = feed ? anchorHead(presentingNow) : null
      if (!feed) anchor.reset()
      if (!feed || !group.visible) return step.cues
      if (shown.ident) {
        const which = portrait ? identTall : identWide
        if (ident.material.map !== which.texture) {
          ident.material.map = which.texture
          ident.key = ''
        }
        paintIf(ident, `${portrait}|${feed.show}|${tvIdentLine(feed)}`, () => {
          const ctx = ctxOf(which.canvas)
          if (ctx) paintIdent(ctx, feed, portrait)
        })
      }
      if (shown.lowerThird) {
        const next = layoutLowerThird(feed)
        paintIf(lowerThird, lowerThirdKey(feed), () => {
          layout = next
          const ctx = ctxOf(lower.canvas)
          if (ctx) paintLowerThird(ctx, feed, next)
        })
      }
      if (mapUp && mapView) {
        const view = mapView
        // At most ~12 repaints a second: the dots move every frame, a canvas upload is not free.
        const key = tvMapKey(feed, view, mapUnit)
        if (mapPanel.key === '' || (key !== mapPanel.key && mapSince >= 0.08)) {
          mapSince = 0
          paintIf(mapPanel, key, () => {
            const ctx = mapCanvas.canvas.getContext('2d') as unknown as TvMapCtx | null
            if (ctx) paintMapPlate(ctx, feed, view, mapUnit)
          })
        }
      }
      if (bannerUp) {
        paintIf(banner, `${bannerKind}|${bannerLine}`, () => {
          const ctx = ctxOf(bannerCanvas.canvas)
          if (ctx) paintBanner(ctx, bannerLine, bannerKind)
        })
      }
      if (shown.results) {
        paintIf(card, lowerThirdKey({ ...feed, phase: 'results' }), () => {
          const ctx = ctxOf(results.canvas)
          if (ctx) paintResults(ctx, feed)
        })
      }
      placeAll(head)
      return step.cues
    },
    map(view, speedUnit) {
      mapView = view
      mapUnit = speedUnit
    },
    announce(line, kind) {
      bannerLine = line
      bannerKind = kind
      bannerLeft = TV_BANNER_SECONDS
    },
    emblem(logo) {
      if (bugBuilt) return true
      const e = buildEmblem(logo, bugMaterial)
      if (!e) return false
      // Held still, lit once from the plate's own light at rest.
      e.shade(0)
      const centre = new THREE.Group()
      centre.add(e.spin)
      if (e.word) centre.add(e.word)
      // DEV-653: the TV word under it, and a soft shadow behind (`render/tv-bug.ts`).
      bugParts = buildTvBugParts(e.spin, e.word)
      centre.add(bugParts.word)
      const box = new THREE.Box3().setFromObject(centre)
      centre.add(bugParts.shadow)
      bugCentre = centre
      const size = box.getSize(new THREE.Vector3())
      const mid = box.getCenter(new THREE.Vector3())
      centre.position.set(-mid.x, -mid.y, -mid.z)
      for (const m of [e.spin, e.word]) {
        if (!m) continue
        // The panels' own order: the menus' reticle (`OVER_ORDER`) draws over every plate.
        m.renderOrder = 20
        m.frustumCulled = false
      }
      bug.add(centre)
      // Width over height, as a panel's canvas aspect; scaled from `LOADING_EMBLEM_WIDTH`.
      bugAspect = size.x / Math.max(1e-6, size.y)
      bugBuilt = true
      return true
    },
    report: () => ({
      shown,
      portrait,
      presenting: presentingNow,
      ident: feedNow ? tvIdentLine(feedNow) : '',
      rows: feedNow ? feedNow.rows.map(tvDrawnName) : [],
      followed: feedNow?.followed ?? null,
      cuts: anchor.cuts,
      picks,
      lastPick,
      bug: bugShown,
      banner: bannerLeft > 0 && feedNow !== null ? bannerLine : null,
      map: mapUp,
      bugEdges: bugEdgesPx(),
      layout: layout
        ? {
            top: layout.top,
            rows: layout.rows.map((r) => ({ follow: r.row.follow, y: r.y, h: r.h })),
          }
        : null,
    }),
    dispose() {
      o.canvas.removeEventListener('pointerdown', onDown)
      o.canvas.removeEventListener('pointerup', onUp)
      group.removeFromParent()
      for (const p of [ident, lowerThird, card, banner, mapPanel]) {
        p.mesh.geometry.dispose()
        p.material.dispose()
      }
      for (const c of [identWide, identTall, lower, results, bannerCanvas, mapCanvas])
        c.texture.dispose()
      // Geometry only: the bug's material is `bugMaterial`, freed below. Everything
      // under the bug is a Mesh (the emblem's spin and word), so the walk reaches
      // what the old unfiltered `geometry?.dispose()` did.
      disposeTree(bug, { materials: false })
      bugMaterial.dispose()
      bugParts?.dispose()
    },
  }
}
