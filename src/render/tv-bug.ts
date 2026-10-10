// src/render/tv-bug.ts: the TV bug's drop shadow and its TV word. DEV-653 (c2).
//
// Matt, 2026-10-05: *"drop shadow behind the TV logo to help it read? also
// should add "TV" in our hud font (same as anniversary text) bottom-right
// aligned to the logo, (right edge of the V aligned with the right edge of the
// T in Flight)"*. The bug is the title's emblem held still in a corner
// (`render/tv-panel.ts`, DEV-617); on a bright sky or sea it lost its edge.
//
// ── The shadow ────────────────────────────────────────────────────────────
//
// DEV-849 (Matt, 2026-10-08: *"TV in CRYSTAL with its drop shadow in the right
// place; a soft blob drop shadow behind the Faceted Flight logo so it pops off
// the screen"*). Two shadows, each painted once at build, nothing per frame, and
// neither lit: the bug is unlit UI and a shadow here is a graphic's.
//
//  1. A BLOB behind the logo: the silhouette of every triangle of the gem and the
//     wordmark, grown a little and blurred wide, depth-tested behind the emblem
//     (an opaque solid), so it haloes the mark and darkens nothing on it. The
//     first version laid one offset silhouette OVER the logo with the depth test
//     off, which tinted the gold it was meant to sit behind.
//  2. The WORD's drop shadow, a child of the TV plane at its own depth, falling
//     down and to the right. On a plane behind the word it landed on the wrong
//     side of the letters: the bug is a real object a metre from the camera, so
//     depth moves a plane toward the screen's centre.
//
// ── The word ──────────────────────────────────────────────────────────────
//
// "TV" is CRYSTAL, the face of the Anniversary line (`hudFace`), on a plane
// whose canvas is cut to the INK of the letters, so the plane's edges ARE the
// letters' edges: `tvWordPlane` puts the V's ink right edge on the wordmark's
// right edge (the T of FLIGHT is the last letter of the one `title` mesh) by
// arithmetic, and `tests/unit/tv-bug.test.ts` projects both to 1080p and holds
// them within a pixel. DEV-804 (Matt, 2026-10-07: *"make the bottom of the 'TV'
// text match the bottom of the point in the FF logo"*): the word no longer
// hangs under the emblem. Its ink BOTTOM is level with the lowest point of the
// gem (`logo_bottom`'s tip, the union box's `min.y`), beside the point and under
// the wordmark's right end; the right-edge rule stands. The same spec holds
// the two bottoms within a pixel. The font may land after the plane is built, so the word
// repaints when CRYSTAL settles and the plane is re-cut to the new ink.

import * as THREE from 'three'
import { UI_INK_DARK, uiFont } from '@/render/ui-tokens'
import { hudFace, whenHudFontSettles } from './hud-font'
import { EMBLEM_GOLD } from './loading-scene'

export const TV_WORD = 'TV'

/** The word's cap height as a share of the wordmark's height. */
export const TV_WORD_SIZE = { cap: 0.85 } as const

/** The shadow: how far down and right (as shares of the logo's size) it falls, and its blur. */
export const TV_SHADOW = {
  /** The word's drop shadow, as shares of the ink's height: down and right, tight. */
  dx: 0.07,
  dy: 0.1,
  blur: 0.05,
  alpha: 0.85,
  /** The room round the ink the shadow's canvas keeps, as a share of the ink's height. */
  wordPad: 0.3,
  /** The logo's blob, as shares of the canvas width: grown, wide, soft, a hair low. */
  blobGrow: 0.012,
  blobBlur: 0.028,
  blobAlpha: 0.7,
  /** DEV-865: the blob falls the SAME way as the word's shadow (one light), this many times its offset. */
  blobFall: 1.7,
  pad: 0.12,
} as const

/** Where the word's plane stands, in the logo's own units. Pure. */
export interface TvWordPlane {
  /** The plane's centre. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** The V's ink right edge: always `wordRight`. */
  readonly inkRight: number
  /** The ink's bottom edge: always `logoBottom` (DEV-804). */
  readonly inkBottom: number
}

/**
 * The plane that puts the word's INK right edge on `wordRight` and its INK
 * bottom on `logoBottom`, the lowest point of the emblem (DEV-804). `inkAspect` is the ink's width over height;
 * `margin` is the clear canvas round the ink, in the same units.
 */
export const tvWordPlane = (o: {
  readonly wordRight: number
  readonly logoBottom: number
  readonly capHeight: number
  readonly inkAspect: number
  readonly margin: number
}): TvWordPlane => {
  const inkW = o.capHeight * o.inkAspect
  const inkRight = o.wordRight
  const inkLeft = inkRight - inkW
  const inkBottom = o.logoBottom
  const inkTop = inkBottom + o.capHeight
  return {
    x: (inkLeft + inkRight) / 2,
    y: (inkTop + inkBottom) / 2,
    width: inkW + 2 * o.margin,
    height: o.capHeight + 2 * o.margin,
    inkRight,
    inkBottom,
  }
}

export interface TvBugParts {
  /** Both meshes; the caller adds them to the group the emblem is in. */
  readonly shadow: THREE.Mesh
  readonly word: THREE.Mesh
  /** The wordmark's right edge and the V's ink right edge, logo units: equal by construction. */
  edges(): {
    readonly wordRight: number
    readonly tvRight: number
    /** The lowest point of the emblem and the TV ink's bottom (DEV-804), logo units. */
    readonly pointBottom: number
    readonly tvBottom: number
    readonly z: number
  }
  /** Everything the word and its shadow occupy, logo units, for the bug's aspect. */
  box(): THREE.Box3
  dispose(): void
}

const gold = `#${EMBLEM_GOLD.toString(16).padStart(6, '0')}`

const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D | null => c.getContext('2d')

/** Fill every triangle of `parts` (x, y only) into `ctx`, black, under `map`. */
const fillSilhouette = (
  ctx: CanvasRenderingContext2D,
  parts: readonly Float32Array[],
  map: (x: number, y: number) => readonly [number, number],
  grow = 0,
): void => {
  ctx.fillStyle = UI_INK_DARK
  ctx.beginPath()
  for (const p of parts) {
    for (let i = 0; i + 8 < p.length; i += 9) {
      const [ax, ay] = map(p[i] as number, p[i + 1] as number)
      const [bx, by] = map(p[i + 3] as number, p[i + 4] as number)
      const [cx, cy] = map(p[i + 6] as number, p[i + 7] as number)
      ctx.moveTo(ax, ay)
      ctx.lineTo(bx, by)
      ctx.lineTo(cx, cy)
      ctx.closePath()
    }
  }
  ctx.fill()
  if (grow > 0) {
    // A round stroke on the same path grows the silhouette by `grow` px each way.
    ctx.strokeStyle = UI_INK_DARK
    ctx.lineJoin = 'round'
    ctx.lineWidth = grow * 2
    ctx.stroke()
  }
}

/** A mesh's positions as a flat triangle list (indexed or not). */
const trianglesOf = (mesh: THREE.Mesh): Float32Array => {
  const g = mesh.geometry
  const pos = g.getAttribute('position')
  const index = g.getIndex()
  const n = index ? index.count : pos.count
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const v = index ? index.getX(i) : i
    out[i * 3] = pos.getX(v)
    out[i * 3 + 1] = pos.getY(v)
    out[i * 3 + 2] = pos.getZ(v)
  }
  return out
}

/**
 * Build the shadow and the word for an emblem whose pieces (`spin`, `word`)
 * stand in the group's own frame, front facing +z. The caller adds `shadow`
 * and `word` to that same group.
 */
export const buildTvBugParts = (spin: THREE.Mesh, wordmark: THREE.Mesh | null): TvBugParts => {
  const logo = new THREE.Box3().setFromObject(spin)
  const wordBox = wordmark ? new THREE.Box3().setFromObject(wordmark) : logo.clone()
  if (wordmark) logo.union(wordBox)
  const wordHeight = Math.max(1e-6, wordBox.max.y - wordBox.min.y)
  const capHeight = wordHeight * TV_WORD_SIZE.cap
  const wordRight = wordBox.max.x

  // ── the word ──
  const wordCanvas = document.createElement('canvas')
  const wordTexture = new THREE.CanvasTexture(wordCanvas)
  wordTexture.colorSpace = THREE.SRGBColorSpace
  const wordMaterial = new THREE.MeshBasicMaterial({
    map: wordTexture,
    transparent: true,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    fog: false,
  })
  const word = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), wordMaterial)
  word.name = 'tv-bug-word'
  word.renderOrder = 20
  word.frustumCulled = false
  // The word stands at the wordmark's own FRONT FACE, not the gem's: the bug is a real 3D object
  // at a metre from the camera, so a plane even a few millimetres nearer lands several pixels
  // further from the screen's centre at 1080p, and the V would overshoot the T.
  const zFront = wordmark ? wordBox.max.z : logo.max.z
  const zBack = logo.min.z

  // ── the shadow ──
  const shadowCanvas = document.createElement('canvas')
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas)
  shadowTexture.colorSpace = THREE.SRGBColorSpace
  // DEPTH-TESTED (DEV-849): the emblem is opaque and writes depth, so a shadow
  // behind its back face is hidden by the logo itself. With the test off, a
  // transparent plane always draws after the opaque pass and laid its darkness
  // OVER the gem.
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: shadowTexture,
    transparent: true,
    toneMapped: false,
    depthTest: true,
    depthWrite: false,
    fog: false,
  })
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMaterial)
  shadow.name = 'tv-bug-shadow'
  shadow.renderOrder = 19
  shadow.frustumCulled = false

  // The word's own drop shadow: a child of the word's plane (see `place`).
  const wordShadowCanvas = document.createElement('canvas')
  const wordShadowTexture = new THREE.CanvasTexture(wordShadowCanvas)
  wordShadowTexture.colorSpace = THREE.SRGBColorSpace
  const wordShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: wordShadowTexture,
      transparent: true,
      toneMapped: false,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  )
  wordShadow.name = 'tv-bug-word-shadow'
  wordShadow.renderOrder = 19
  wordShadow.frustumCulled = false
  word.add(wordShadow)

  const triangles: Float32Array[] = [trianglesOf(spin)]
  if (wordmark) triangles.push(trianglesOf(wordmark))

  let inkRightWorld = wordRight
  let inkBottomWorld = logo.min.y
  let plane: TvWordPlane = tvWordPlane({
    wordRight,
    logoBottom: logo.min.y,
    capHeight,
    inkAspect: 1.6,
    margin: 0,
  })
  const everything = new THREE.Box3()

  const place = (): void => {
    // The word's canvas, cut to its ink.
    const font = (px: number): string => hudFace(px, (p) => uiFont(p, 700))
    const probe = ctx2d(wordCanvas)
    if (!probe) return
    const px = 160
    probe.font = font(px)
    const m = probe.measureText(TV_WORD)
    const left = m.actualBoundingBoxLeft
    const inkW = Math.max(1, m.actualBoundingBoxRight + left)
    const inkH = Math.max(1, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent)
    const pad = 6
    wordCanvas.width = Math.ceil(inkW + 2 * pad)
    wordCanvas.height = Math.ceil(inkH + 2 * pad)
    const c = ctx2d(wordCanvas)
    if (!c) return
    c.font = font(px)
    c.textAlign = 'left'
    c.textBaseline = 'alphabetic'
    c.fillStyle = gold
    c.fillText(TV_WORD, pad + left, pad + m.actualBoundingBoxAscent)
    wordTexture.dispose() // the canvas was resized (CRYSTAL landed): rebuild the GL storage
    wordTexture.needsUpdate = true
    const unit = capHeight / inkH
    plane = tvWordPlane({
      wordRight,
      logoBottom: logo.min.y,
      capHeight,
      inkAspect: inkW / inkH,
      margin: pad * unit,
    })
    // Where the ink REALLY ends: the rightmost opaque column of the canvas just painted, so the
    // edge the spec reads is the letters' and not the plan's. (A slack of a pixel or so is the
    // antialiased edge; more would mean the measured ink and the drawn ink disagree.)
    const rgba = c.getImageData(0, 0, wordCanvas.width, wordCanvas.height).data
    let lastCol = -1
    for (let x = wordCanvas.width - 1; x >= 0 && lastCol < 0; x--) {
      for (let y = 0; y < wordCanvas.height; y++) {
        if ((rgba[(y * wordCanvas.width + x) * 4 + 3] as number) > 40) {
          lastCol = x
          break
        }
      }
    }
    const slackPx = lastCol < 0 ? 0 : wordCanvas.width - pad - (lastCol + 1)
    inkRightWorld = plane.inkRight - slackPx * (plane.width / wordCanvas.width)
    // And the lowest opaque row, for the bottom (DEV-804).
    let lastRow = -1
    for (let y = wordCanvas.height - 1; y >= 0 && lastRow < 0; y--) {
      for (let x = 0; x < wordCanvas.width; x++) {
        if ((rgba[(y * wordCanvas.width + x) * 4 + 3] as number) > 40) {
          lastRow = y
          break
        }
      }
    }
    const slackRows = lastRow < 0 ? 0 : wordCanvas.height - pad - (lastRow + 1)
    inkBottomWorld = plane.inkBottom + slackRows * (plane.height / wordCanvas.height)
    word.position.set(plane.x, plane.y, zFront)
    word.scale.set(plane.width, plane.height, 1)

    // The shadow: the logo and the word's own ink, black, blurred, offset.
    everything.copy(logo)
    everything.expandByPoint(
      new THREE.Vector3(plane.x - plane.width / 2, plane.y - plane.height / 2, 0),
    )
    const size = everything.getSize(new THREE.Vector3())
    const padW = size.x * TV_SHADOW.pad
    const x0 = everything.min.x - padW
    const y0 = everything.min.y - padW
    const w = size.x + 2 * padW
    const h = size.y + 2 * padW
    const cw = 512
    const ch = Math.max(1, Math.ceil((cw * h) / w))
    const k = cw / w
    const tmp = document.createElement('canvas')
    tmp.width = cw
    tmp.height = ch
    const t = ctx2d(tmp)
    const s = ctx2d(shadowCanvas)
    if (!t || !s) return
    shadowCanvas.width = cw
    shadowCanvas.height = ch
    const to = (x: number, y: number): readonly [number, number] => [
      (x - x0) * k,
      ch - (y - y0) * k,
    ]
    // The BLOB (DEV-849): the logo's whole silhouette (gem and wordmark), grown a
    // little, blurred wide and laid straight behind it, only a hair low, so the
    // mark lifts off a bright picture all round instead of wearing a hard offset
    // copy. It stands behind the emblem and is depth-tested, so the logo hides
    // the part under it and nothing is darkened ON the gold.
    const blur = (px: number): void => {
      if ('filter' in s) s.filter = `blur(${Math.max(1, Math.round(px))}px)`
    }
    s.clearRect(0, 0, cw, ch)
    fillSilhouette(t, triangles, to, cw * TV_SHADOW.blobGrow)
    s.globalAlpha = TV_SHADOW.blobAlpha
    blur(cw * TV_SHADOW.blobBlur)
    // DEV-865 (Matt: the logo's shadow and the TV's differed): one light, so the blob falls down and
    // right by the word's own offset (world units, shares of the cap height), scaled up a little for
    // the logo's size.
    s.drawImage(
      tmp,
      Math.round(capHeight * TV_SHADOW.dx * TV_SHADOW.blobFall * k),
      Math.round(capHeight * TV_SHADOW.dy * TV_SHADOW.blobFall * k),
    )

    // The WORD's drop shadow (DEV-849): the TV letters' own ink, black, blurred
    // tight and offset down and to the right, the side every shadow on the plate
    // falls to (the emblem is lit from up and left). It is a child of the word's
    // plane, so it stands at the word's own depth: a shadow on a plane BEHIND the
    // word slides toward the screen's centre by parallax (the bug is a real
    // object a metre from the camera) and lands on the wrong side of the letters.
    const q = Math.ceil(inkH * TV_SHADOW.wordPad)
    const sw = wordCanvas.width + 2 * q
    const sh = wordCanvas.height + 2 * q
    wordShadowCanvas.width = sw
    wordShadowCanvas.height = sh
    const ws = ctx2d(wordShadowCanvas)
    if (ws) {
      const ink = document.createElement('canvas')
      ink.width = wordCanvas.width
      ink.height = wordCanvas.height
      const i = ctx2d(ink)
      if (i) {
        i.drawImage(wordCanvas, 0, 0)
        i.globalCompositeOperation = 'source-in'
        i.fillStyle = UI_INK_DARK
        i.fillRect(0, 0, ink.width, ink.height)
        ws.clearRect(0, 0, sw, sh)
        ws.globalAlpha = TV_SHADOW.alpha
        if ('filter' in ws) ws.filter = `blur(${Math.max(1, Math.round(inkH * TV_SHADOW.blur))}px)`
        ws.drawImage(ink, q + Math.round(inkH * TV_SHADOW.dx), q + Math.round(inkH * TV_SHADOW.dy))
      }
    }
    wordShadowTexture.dispose()
    wordShadowTexture.needsUpdate = true
    wordShadow.scale.set(sw / wordCanvas.width, sh / wordCanvas.height, 1)
    wordShadow.position.set(0, 0, -0.0001)
    shadowTexture.dispose() // the canvas was resized: GL storage is immutable, so the texture is rebuilt
    shadowTexture.needsUpdate = true
    shadow.position.set(x0 + w / 2, y0 + h / 2, zBack - 0.0005)
    shadow.scale.set(w, h, 1)
  }
  place()
  // CRYSTAL may land after this: re-cut the word to its real ink then.
  whenHudFontSettles(place)

  return {
    shadow,
    word,
    edges: () => ({
      wordRight,
      tvRight: inkRightWorld,
      pointBottom: logo.min.y,
      tvBottom: inkBottomWorld,
      z: zFront,
    }),
    box: () => everything.clone().union(logo),
    dispose() {
      for (const mesh of [shadow, word, wordShadow]) {
        mesh.geometry.dispose()
        ;(mesh.material as THREE.MeshBasicMaterial).dispose()
      }
      wordTexture.dispose()
      shadowTexture.dispose()
      wordShadowTexture.dispose()
    },
  }
}
