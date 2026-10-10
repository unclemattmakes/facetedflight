// tests/unit/menu-reticle.test.ts: the menus' triangle. DEV-572.
//
// Matt, 2026-10-02: *"we could use a reticle for the menus (triangle to stick
// with our polygonal theme?)"*. `render/menu-reticle.ts` draws it and
// `boot/app.ts` places it once a frame on whatever selects.
//
// The oracles are outside the reticle (CLAUDE.md: a test that compares two of
// our own devices has tested neither):
//
//   §1 the SHAPE is read off the texture as geometry: hollow, closed, and apex
//      UP, by a stroke that is present at the bottom and absent at its mirror,
//      which a flipped upload fails (the orientation lesson: test the geometry,
//      not the belief about it).
//   §2 the PROGRAM: the reticle is drawn in the menus' canvas plates' key. The
//      plates' constructors are read out of their own source and rebuilt here,
//      and every field three's `getParameters` reads for a basic material is
//      compared, so a plate that changes its flags turns this red.
//   §3 the PLACEMENT is checked as world geometry under a moved, turned parent:
//      where it stands, which way it faces, how big it is AT THE EYE.
//   §4 the DRAW ORDER: under the room's labels, over every plate, under every
//      curtain, read against those surfaces' own numbers.
//   §5 stereo: on no eye layer, and on bloom's own UI classification.
//   §6 app.ts places it AFTER every menu has aimed and BEFORE the draw.

import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { isUiObject } from '@/render/bloom'
import {
  createMenuReticle,
  createReticleMaterial,
  createReticleMesh,
  MENU_RETICLE_ANGLE,
  OVER_ORDER,
  RETICLE_FILL,
  RETICLE_HOLLOW,
  RETICLE_OFF,
  RETICLE_ON,
  reticleCoverage,
  reticleMaterial,
  reticleTexture,
  UNDER_ORDER,
} from '@/render/menu-reticle'
import { CURTAIN_ORDER } from '@/render/title-curtain'
import { createUiMaterial } from '@/render/ui-plate'
import { UI_DIM_HEX } from '@/render/ui-tokens'
import { createXrPointer } from '@/render/xr-pointer'
import { appFileThroughWith, codeOnly, inOrder } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

describe('§1 the shape: a hollow triangle, point DOWN and flat on top, standing on its point', () => {
  // Matt, 2026-10-02: "flip the reticle in Y (have the point on the bottom,
  // flat on top - like the logo)".
  const N = 64
  /** Alpha at a point of the quad's [-1, 1] square, y up, from the top-down coverage. */
  const at = (alpha: Uint8Array, x: number, y: number): number => {
    const col = Math.min(N - 1, Math.floor(((x + 1) / 2) * N))
    const row = Math.min(N - 1, Math.floor(((1 - y) / 2) * N))
    return alpha[row * N + col] as number
  }
  // The outer triangle's circumradius in the quad is `RETICLE_FILL`; its flat
  // edge stands half that ABOVE the centre, the inner's at that times HOLLOW,
  // and the point a whole circumradius below. The middle of the top stroke is
  // between the two flat edges.
  const outerFlat = RETICLE_FILL / 2
  const innerFlat = outerFlat * RETICLE_HOLLOW
  const strokeMid = (outerFlat + innerFlat) / 2
  const pointMid = -(RETICLE_FILL + RETICLE_FILL * RETICLE_HOLLOW) / 2

  it('is hollow: clear at the centre, solid on the stroke, clear outside', () => {
    const alpha = reticleCoverage()
    expect(at(alpha, 0, 0), 'the centre is the hollow').toBe(0)
    expect(at(alpha, 0, strokeMid), 'the flat stroke is solid').toBeGreaterThan(200)
    expect(at(alpha, 0.95, 0.95), 'a corner of the quad is clear').toBe(0)
    expect(at(alpha, 0, 0.7), 'above the flat edge is clear').toBe(0)
  })

  it('points DOWN: the flat stroke is on top, and the point solid below', () => {
    // Apex-up (the first build) would put the flat stroke at -strokeMid.
    const alpha = reticleCoverage()
    expect(at(alpha, 0, strokeMid)).toBeGreaterThan(200)
    expect(at(alpha, 0, -strokeMid)).toBe(0)
    expect(at(alpha, 0, pointMid), 'the point is solid, low on the axis').toBeGreaterThan(200)
  })

  it('the UPLOAD keeps it so: a DataTexture row 0 is the bottom of the image', () => {
    // three uploads a DataTexture with flipY false, so its first row lands at
    // v = 0, the BOTTOM of the quad. The flat stroke must therefore be in the
    // HIGH rows of the data, and the coverage (top-down) is turned over for it.
    const texture = reticleTexture()
    expect(texture.flipY, 'three does not flip a DataTexture').toBe(false)
    const data = texture.image.data as Uint8Array
    const texelAtV = (y: number, channel: number): number => {
      const row = Math.min(N - 1, Math.floor(((y + 1) / 2) * N))
      return data[(row * N + N / 2) * 4 + channel] as number
    }
    // The stroke is WHITE (so `color` tints it) and solid, high in the data.
    expect(texelAtV(strokeMid, 3), 'flat stroke high in the data').toBeGreaterThan(200)
    expect(texelAtV(strokeMid, 0), 'and white').toBe(255)
    // Its mirror below the centre carries no white at all.
    expect(texelAtV(-strokeMid, 0), 'its mirror has no stroke').toBe(0)
  })

  it('stands on its POINT: the mesh origin is the tip, the body rises along +y', () => {
    // The quad's v runs 0 at its bottom edge to 1 at its top; the tip is at
    // the texture's y = -FILL, which is v = (1 - FILL) / 2.
    const g = createReticleMesh('probe').geometry
    g.computeBoundingBox()
    const box = g.boundingBox as THREE.Box3
    const v = (1 - RETICLE_FILL) / 2
    const tipY = box.min.y + v * (box.max.y - box.min.y)
    expect(tipY, 'the tip, in the mesh, is at its origin').toBeCloseTo(0, 6)
    expect(box.getCenter(new THREE.Vector3()).y, 'and the body above it').toBeGreaterThan(0)
    expect(box.getCenter(new THREE.Vector3()).x).toBeCloseTo(0, 9)
  })

  it('wears a dark KEYLINE round the stroke, and nothing past it', () => {
    // So it reads on any colour: black under the tint, part-opaque, just
    // outside the stroke's flat edge; clear further out.
    const data = reticleTexture().image.data as Uint8Array
    const texelAtV = (y: number, channel: number): number => {
      const row = Math.min(N - 1, Math.floor(((y + 1) / 2) * N))
      return data[(row * N + N / 2) * 4 + channel] as number
    }
    const justOutside = outerFlat + 0.08
    expect(texelAtV(justOutside, 3), 'the keyline is there').toBeGreaterThan(60)
    expect(texelAtV(justOutside, 0), 'and dark').toBe(0)
    expect(texelAtV(0.95, 3), 'clear past it').toBe(0)
    // A clear texel is black, so filtering pulls dark, never white, into the edge.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) expect(data[i]).toBe(0)
    }
  })
})

describe('§2 it compiles nothing: the canvas plates program key', () => {
  // Every material field `WebGLPrograms.getParameters` reads for a
  // MeshBasicMaterial with a map, by name. `color`, `opacity`, `depthTest`,
  // `depthWrite` and `renderOrder` are absent from the list on purpose: they
  // are uniforms and state, not the key, and they are what the reticle varies.
  const KEY_FIELDS = [
    'type',
    'transparent',
    'blending',
    'alphaToCoverage',
    'alphaTest',
    'alphaHash',
    'premultipliedAlpha',
    'toneMapped',
    'fog',
    'side',
    'vertexColors',
    'flatShading',
    'wireframe',
    'combine',
    'dithering',
    'forceSinglePass',
    'precision',
    'envMap',
    'lightMap',
    'aoMap',
    'specularMap',
    'alphaMap',
    'clipShadows',
    'clipIntersection',
    'clippingPlanes',
  ] as const
  const keyOf = (m: THREE.Material) => {
    const r = m as unknown as Record<string, unknown>
    const map = r.map as THREE.Texture | null
    const out: Record<string, unknown> = {}
    for (const k of KEY_FIELDS) out[k] = r[k] ?? null
    out.map = map !== null
    out.mapChannel = map?.channel ?? null
    out.video = (map as { isVideoTexture?: boolean } | null)?.isVideoTexture === true
    out.defines = JSON.stringify(m.defines ?? {})
    out.customKey = m.customProgramCacheKey()
    out.onBeforeCompile = m.onBeforeCompile.toString()
    return out
  }
  /**
   * The plates' own constructors, out of their source. A label is built with
   * a canvas this suite cannot make, so its ARGUMENTS are read and rebuilt
   * with a stand-in map; the key never looks at what kind of image a map holds.
   */
  const PLATES: readonly { file: string; pattern: RegExp }[] = [
    {
      // The tables' labels, and every canvas surface the room builds that way.
      file: 'src/render/hangar.ts',
      pattern:
        /new THREE\.MeshBasicMaterial\(\{ map: texture, transparent: true, toneMapped: false \}\)/,
    },
    {
      // Every overlay plate: the pause plate (and the title's rows and the
      // lobby, on its painter), the room-code plate, results, briefing, the
      // checklist, the perf plate. They shared this constructor by copy until
      // `ui-plate.ts` (UI-1); now it is one place.
      file: 'src/render/ui-plate.ts',
      pattern:
        /new THREE\.MeshBasicMaterial\(\{\s*map,\s*transparent: true,\s*depthWrite: false,[\s\S]*?toneMapped: false,\s*depthTest: false,\s*\}\)/,
    },
  ]

  for (const { file, pattern } of PLATES) {
    it(`shares its key with ${file}'s plate`, () => {
      const source = read(file)
      const found = pattern.exec(source)?.[0]
      expect(found, `${file} still builds its plate this way`).toBeDefined()
      // Nothing between the braces may set a key field the pattern did not.
      const body = (found as string).replace(/\/\/.*$/gm, '')
      for (const k of [
        'fog',
        'side',
        'vertexColors',
        'blending',
        'alphaTest',
        'premultipliedAlpha',
      ]) {
        expect(body.includes(`${k}:`), `${file}'s plate sets no ${k}`).toBe(false)
      }
      const plate = new THREE.MeshBasicMaterial({
        map: new THREE.DataTexture(new Uint8Array(4), 1, 1),
        transparent: true,
        toneMapped: false,
        depthTest: !/depthTest: false/.test(body),
        depthWrite: !/depthWrite: false/.test(body),
      })
      expect(keyOf(createReticleMaterial())).toEqual(keyOf(plate))
    })
  }

  it('shares its key with the material `createUiPlate` really builds, not just the one its source reads as', () => {
    const map = new THREE.DataTexture(new Uint8Array(4), 1, 1)
    expect(keyOf(createReticleMaterial())).toEqual(keyOf(createUiMaterial(map)))
  })

  it('on the plates geometry: a plane, with the same attributes', () => {
    // `vertexNormals` and the uv channels are in the key too.
    const mesh = createReticleMesh('probe')
    const names = Object.keys(mesh.geometry.attributes).sort()
    expect(names).toEqual(Object.keys(new THREE.PlaneGeometry(1, 1).attributes).sort())
  })

  it('and the laser draws the SAME triangle, in the SAME material (one mark, two mounts)', () => {
    // Same parameters were not enough: in a headset the laser's first show
    // linked a program the head's had not (259 to 260). One material instance
    // is one program, whatever patches the world's sweeps put on it.
    const pointer = createXrPointer()
    const reticle = pointer.object.getObjectByName('xr-pointer-reticle') as THREE.Mesh
    const head = createMenuReticle()
    expect(reticle.material, 'the same material instance').toBe(head.object.material)
    expect(reticle.material).toBe(reticleMaterial())
    expect((reticle.material as THREE.MeshBasicMaterial).map, 'the same texture').toBe(
      reticleTexture(),
    )
    // Disposing either leaves the other wearing a live material.
    head.dispose()
    pointer.dispose()
    expect(createReticleMesh('again').material).toBe(reticle.material)
  })

  it('the laser shows its triangle amber even after the head left the material dim', () => {
    const head = createMenuReticle()
    const eye = v(0, 0, 0)
    head.place(eye, v(0, 0, -1), 1, eye, false, 'over')
    expect(head.object.material.color.getHex()).toBe(new THREE.Color(RETICLE_OFF).getHex())
    const xr = read('src/render/xr-pointer.ts')
    // The laser's amber IS the reticle's: it imports `RETICLE_ON` rather than
    // declaring a second 0xffcf7a (UI-2), so there is nothing left to agree.
    expect(xr).toMatch(/reticle\.material\.color\.setHex\(RETICLE_ON\)/)
    expect(xr).not.toMatch(/const ON = 0x/i)
  })
})

describe('§3 where it stands, which way it faces, and its size at the eye', () => {
  /** A rig moved and turned, so local and world differ in every component. */
  const rigged = () => {
    const scene = new THREE.Scene()
    const rig = new THREE.Group()
    rig.position.set(3, 1.2, -7)
    rig.rotation.y = 0.9
    scene.add(rig)
    const reticle = createMenuReticle()
    rig.add(reticle.object)
    return { scene, rig, reticle }
  }

  it('stands its point on the ray, faces the eye, rises upright, and subtends the angle', () => {
    const { scene, reticle } = rigged()
    const eye = v(2.4, 1.9, -5)
    const direction = v(0.3, -0.4, -1).normalize()
    const distance = 1.47
    reticle.place(eye, direction, distance, eye, true, 'under')
    scene.updateMatrixWorld(true)
    const o = reticle.object
    const centre = o.getWorldPosition(new THREE.Vector3())
    const hit = eye.clone().addScaledVector(direction, distance)
    expect(centre.distanceTo(hit)).toBeLessThan(1e-9)
    // Its +z (the face) points at the eye.
    const face = v(0, 0, 1).transformDirection(o.matrixWorld)
    expect(face.dot(eye.clone().sub(centre).normalize())).toBeCloseTo(1, 9)
    // Its +y (from the point up to the flat edge) has world up in it: not
    // upside down, not on its side.
    const apex = v(0, 1, 0).transformDirection(o.matrixWorld)
    expect(apex.y).toBeGreaterThan(0.9)
    // One local unit is the circumradius: the centroid stands one unit above
    // the tip, and that subtends MENU_RETICLE_ANGLE.
    const edge = o.localToWorld(v(0, 1, 0))
    expect(edge.distanceTo(centre) / centre.distanceTo(eye)).toBeCloseTo(
      Math.tan(MENU_RETICLE_ANGLE),
      9,
    )
    expect(o.visible).toBe(true)
    expect(o.userData).toMatchObject({ on: true, distance, layer: 'under' })
  })

  it('is amber on something, dim ink on nothing, and goes away', () => {
    const { reticle } = rigged()
    const eye = v(0, 1.5, 0)
    reticle.place(eye, v(0, 0, -1), 1, eye, true, 'over')
    expect(reticle.object.material.color.getHex()).toBe(new THREE.Color(RETICLE_ON).getHex())
    reticle.place(eye, v(0, 0, -1), 1, eye, false, 'over')
    expect(reticle.object.material.color.getHex()).toBe(new THREE.Color(RETICLE_OFF).getHex())
    reticle.hide()
    expect(reticle.object.visible).toBe(false)
    expect(reticle.object.userData).toMatchObject({ on: false, distance: null, layer: null })
  })

  it('the palette is the rooms: the rim and the header ink', () => {
    const hangar = read('src/render/hangar.ts')
    const rim = Number(/const HOLO_COLOUR = (0x[0-9a-f]{6})/i.exec(hangar)?.[1])
    expect(RETICLE_ON).toBe(rim)
    // DEV-647: the header ink is the dim TOKEN now, and the reticle's off colour is that
    // token's own number (ui-tokens.test.ts pins the pair), so the room still draws its
    // header in the colour the reticle goes to.
    expect(RETICLE_OFF).toBe(UI_DIM_HEX)
    expect(codeOnly(hangar)).toContain('fillStyle = UI_DIM')
  })
})

describe('§4 under the tables words, over every plate, under every curtain', () => {
  it('UNDER sorts before the room labels; OVER after every plate and before every curtain', () => {
    const orderIn = (file: string): number[] =>
      [...codeOnly(read(file)).matchAll(/renderOrder(?: =|:) (-?\d[\d_]*)/g)].map((m) =>
        Number((m[1] as string).replace(/_/g, '')),
      )
    // The room's labels set none (three's 0), and nothing the room stands on a
    // table sorts below 0: read so, rather than assumed.
    expect(UNDER_ORDER).toBeLessThan(0)
    for (const file of [
      'src/render/hangar.ts',
      'src/render/hangar-art.ts',
      'src/render/hangar-doors.ts',
      'src/render/diorama.ts',
      'src/render/holo-ship.ts',
      'src/render/mode-mark.ts',
      // Not `medal.ts`: its -1 is a GROUP's (the outline shell's holder),
      // which three sorts as a group order ahead of every mesh order, and the
      // shell is a border with no words on it.
    ]) {
      for (const o of orderIn(file)) expect(UNDER_ORDER, file).toBeLessThan(o)
    }
    for (const file of [
      'src/render/pause.ts',
      'src/render/room-code-plate.ts',
      'src/render/tv-panel.ts',
    ]) {
      const orders = orderIn(file)
      expect(orders.length, `${file} has a render order`).toBeGreaterThan(0)
      for (const o of orders) expect(OVER_ORDER, file).toBeGreaterThan(o)
    }
    expect(OVER_ORDER).toBeLessThan(CURTAIN_ORDER)
    const fade = orderIn('src/render/vignette.ts')
    expect(Math.max(...fade)).toBeGreaterThan(OVER_ORDER)
  })

  it('the room passes UNDER to the laser too', () => {
    const { text } = appFileThroughWith('hangar?.aimDistance ?? null, cameraWorld')
    expect(text).toMatch(
      /xrPointer\.show\(roomPointing, hangar\?\.aimDistance \?\? null, cameraWorld, 'under'\)/,
    )
  })
})

describe('§5 it is UI, on both eyes', () => {
  it('on no eye layer, and classified as UI by bloom', () => {
    const reticle = createMenuReticle()
    expect(reticle.object.layers.isEnabled(1)).toBe(false)
    expect(reticle.object.layers.isEnabled(2)).toBe(false)
    expect(isUiObject(reticle.object)).toBe(true)
  })
})

describe('§6 app.ts places it after every menu has aimed, before the draw', () => {
  it('one call, after the last laser and every aimer, before the draw', () => {
    const { text } = appFileThroughWith('menuReticleFrame()\n')
    const code = codeOnly(text)
    const calls = code.match(/\bmenuReticleFrame\(\)/g) ?? []
    expect(calls, 'exactly one call').toHaveLength(1)
    const call = code.indexOf('menuReticleFrame()\n')
    expect(code.lastIndexOf('xrPointer.show('), 'every laser is shown first').toBeLessThan(call)
    // The aimers the frame runs, in the frame, before it.
    inOrder(code, [
      'titleMenu?.setVisible(titleMenuUp() && !optionsOnTitle)',
      'lobbyFrame(roomPointing)',
    ])
    expect(code.indexOf('lobbyFrame(roomPointing)')).toBeLessThan(call)
    expect(code.indexOf('flight.pause.update({')).toBeLessThan(call)
    expect(code.indexOf('if (!bloom.render(stage, render.camera))')).toBeGreaterThan(call)
  })
})
