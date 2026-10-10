/**
 * tests/unit/loading-emblem.test.ts — the loading plate's spinner is the title's
 * emblem, small, centred over the plate, and only it turns. DEV-434.
 *
 * Matt: *"the loading spinner - let's center it and make it a lil version of the
 * logo from the title screen. but where the text stays put and the logo spins."*
 *
 * Everything here is measured on the built scene in WORLD space, against the
 * plate's own corners and the eye it was shown to, never against the offsets
 * `render/loading-scene.ts` was written with (the orientation lesson: test the
 * geometry, not the rotation). The scene is shown at a heading that is no axis,
 * so a rule that only holds where two conventions agree cannot pass here.
 *
 * The real emblem is `title-logo.glb`, parsed off disk as `medal-art.test.ts`
 * does it; the asset is gitignored (hard rule 7), so that half skips LOUDLY and a
 * stand-in logo covers what needs no asset.
 */
import fs from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROPS } from '@/generated/constants.generated'
import {
  createLoadingScene,
  EMBLEM_AMBIENT,
  EMBLEM_DIFFUSE,
  EMBLEM_GOLD,
  LOADING_EMBLEM_GAP,
  LOADING_EMBLEM_WIDTH,
  LOADING_MARK_SPIN,
  type LoadingScene,
  plateElevation,
  shadeFaces,
  yawFacing,
} from '@/render/loading-scene'
import { TITLE_2016 } from '@/render/title'
import { appSource } from './helpers/app-source'
import { REPO as ROOT } from './helpers/repo-root'

const GLB = path.join(ROOT, 'public/assets/props/title-logo.glb')
const available = fs.existsSync(GLB)

/** Parse the GLB straight out of the file, so no server or fetch is involved. */
const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(GLB)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** Enough of a 2D context for the plate to draw into and nobody to read. */
const stubCanvas = (): void => {
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'measureText' ? () => ({ width: 10 }) : () => undefined),
      set: () => true,
    },
  )
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx }),
  })
}

/**
 * A logo in the glTF's shape: a root, a node turned +90° about x the way the
 * export's is, and three named meshes under it — two emblem parts and the
 * wordmark over them. Boxes, so every face has an obvious normal.
 */
const standIn = (): THREE.Object3D => {
  const root = new THREE.Group()
  const node = new THREE.Group()
  node.name = 'logo'
  node.rotation.x = Math.PI / 2
  root.add(node)
  const part = (name: string, w: number, h: number, up: number): THREE.Mesh => {
    // Built in the node's frame, which the +90° turn maps y -> z and z -> -y,
    // so a box `h` tall in the logo is `h` deep along the node's -z.
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, 1.6, h),
      new THREE.MeshStandardMaterial({ color: 0x808080 }),
    )
    m.name = name
    m.position.z = -up
    return m
  }
  node.add(
    part('logo_top', 18, 8.8, 0),
    part('logo_bottom', 9.7, 6.2, -4.4),
    part('title', 17, 2.9, 5.9),
  )
  return root
}

const TEXT = {
  kicker: 'HoverJet · Ring Attack · Intermediate',
  title: 'Intermediate 1 - HoverJet',
  status: 'Loading Simonet Islands…',
  fraction: 0.25,
}

/** An eye and a gaze that are no axis and inside the plate's band. */
const EYE = new THREE.Vector3(12.5, 1.7, -4.25)
const GAZE = new THREE.Vector3(0.6, -0.25, -0.74)

const showAtOddHeading = (loading: LoadingScene): void => {
  loading.show(EYE, yawFacing(GAZE), plateElevation(GAZE), TEXT)
  loading.object.updateMatrixWorld(true)
}

const byName = (loading: LoadingScene, name: string): THREE.Object3D => {
  const o = loading.object.getObjectByName(name)
  if (!o) throw new Error(`no ${name} in the loading scene`)
  return o
}

/** Every vertex of a mesh, in world space. */
const worldPoints = (mesh: THREE.Mesh): THREE.Vector3[] => {
  mesh.updateWorldMatrix(true, false)
  const pos = mesh.geometry.getAttribute('position')
  const out: THREE.Vector3[] = []
  for (let i = 0; i < pos.count; i++)
    out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld))
  return out
}

/** The plate's own frame, read off its own mesh: centre, right, up, and its edges along each. */
const plateFrame = (loading: LoadingScene) => {
  const plate = byName(loading, 'loading-plate') as THREE.Mesh
  const corners = worldPoints(plate)
  const centre = corners
    .reduce((a, p) => a.add(p), new THREE.Vector3())
    .multiplyScalar(1 / corners.length)
  const right = new THREE.Vector3(1, 0, 0).transformDirection(plate.matrixWorld)
  const up = new THREE.Vector3(0, 1, 0).transformDirection(plate.matrixWorld)
  const along = (p: THREE.Vector3, axis: THREE.Vector3) => p.clone().sub(centre).dot(axis)
  const us = corners.map((p) => along(p, right))
  const ws = corners.map((p) => along(p, up))
  return {
    centre,
    right,
    up,
    u: (p: THREE.Vector3) => along(p, right),
    w: (p: THREE.Vector3) => along(p, up),
    left: Math.min(...us),
    rightEdge: Math.max(...us),
    top: Math.max(...ws),
  }
}

const luminance = (a: ArrayLike<number>, i: number): number =>
  0.2126 * (a[i] as number) + 0.7152 * (a[i + 1] as number) + 0.0722 * (a[i + 2] as number)

describe('the loading plate spins the title emblem — DEV-434', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubCanvas()
  })

  it('the mark becomes the emblem, and the wordmark hangs from the plate, not the mark', () => {
    const loading = createLoadingScene()
    expect(
      loading.object.getObjectByName('loading-gem'),
      'the gem until the logo loads',
    ).toBeTruthy()
    expect(loading.emblem(standIn())).toBe(true)
    const mark = byName(loading, 'loading-mark')
    const emblem = byName(loading, 'loading-emblem')
    const word = byName(loading, 'loading-wordmark')
    expect(loading.object.getObjectByName('loading-gem'), 'the gem has gone').toBeUndefined()
    expect(emblem.parent).toBe(mark)
    expect(word.parent?.name).toBe('loading-plate')
    let under = false
    for (let p: THREE.Object3D | null = word; p; p = p.parent) if (p === mark) under = true
    expect(under, 'the wordmark would turn with the mark').toBe(false)
  })

  it('is centred on the plate, over it and clear of it, at every angle of the turn', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    showAtOddHeading(loading)
    const f = plateFrame(loading)
    const emblem = byName(loading, 'loading-emblem') as THREE.Mesh
    const word = byName(loading, 'loading-wordmark') as THREE.Mesh
    const steps = 24
    for (let s = 0; s < steps; s++) {
      const pts = [...worldPoints(emblem), ...worldPoints(word)]
      const us = pts.map(f.u)
      const ws = pts.map(f.w)
      const left = Math.min(...us) - f.left
      const right = f.rightEdge - Math.max(...us)
      // Centred: as far in from the plate's left edge as from its right,
      // measured against the plate's own corners.
      expect(Math.abs(left - right), `step ${s}: off-centre`).toBeLessThan(0.002)
      expect(left, `step ${s}: inside the plate's width`).toBeGreaterThan(0)
      // Over it, and clear: the lowest point is the gap above the plate's top edge.
      expect(Math.min(...ws) - f.top, `step ${s}: clear of the plate`).toBeGreaterThan(
        LOADING_EMBLEM_GAP * 0.99,
      )
      expect(Math.min(...ws) - f.top, `step ${s}: not floating off`).toBeLessThan(
        LOADING_EMBLEM_GAP + 0.01,
      )
      loading.tick((2 * Math.PI) / steps / LOADING_MARK_SPIN)
      loading.object.updateMatrixWorld(true)
    }
  })

  it('only the emblem turns: the wordmark, the plate and its words stay put', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    showAtOddHeading(loading)
    const emblem = byName(loading, 'loading-emblem')
    const word = byName(loading, 'loading-wordmark')
    const plate = byName(loading, 'loading-plate')
    const before = {
      emblem: emblem.matrixWorld.clone(),
      word: word.matrixWorld.clone(),
      plate: plate.matrixWorld.clone(),
      text: loading.text,
    }
    for (let i = 0; i < 30; i++) loading.tick(1 / 90)
    loading.object.updateMatrixWorld(true)
    expect(emblem.matrixWorld.equals(before.emblem), 'the emblem turned').toBe(false)
    expect(word.matrixWorld.equals(before.word), 'the wordmark stayed put').toBe(true)
    expect(plate.matrixWorld.equals(before.plate), 'the plate stayed put').toBe(true)
    expect(loading.text).toBe(before.text)
  })

  it('turns every frame at the gem’s rate, in place, and only while shown', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    const mark = byName(loading, 'loading-mark')
    loading.tick(1)
    expect(mark.rotation.y, 'hidden: no turn').toBe(0)
    showAtOddHeading(loading)
    const emblem = byName(loading, 'loading-emblem') as THREE.Mesh
    const axis = new THREE.Vector3()
    mark.getWorldPosition(axis)
    const up = new THREE.Vector3(0, 1, 0).transformDirection(mark.matrixWorld)
    let last = mark.rotation.y
    for (let frame = 0; frame < 90; frame++) {
      loading.tick(1 / 90)
      const step = (mark.rotation.y - last + 2 * Math.PI) % (2 * Math.PI)
      expect(step, `frame ${frame} turned`).toBeCloseTo(LOADING_MARK_SPIN / 90, 9)
      last = mark.rotation.y
    }
    // In place: the turning part's box stays centred on its own axis. Boxed in
    // the PLATE's frame, which the axis is upright in: a world box of a tipped
    // shape that is not symmetric top to bottom has its centre off the axis
    // whatever the shape does.
    loading.object.updateMatrixWorld(true)
    const plate = byName(loading, 'loading-plate')
    const inPlate = (p: THREE.Vector3) => plate.worldToLocal(p.clone())
    const box = new THREE.Box3().setFromPoints(worldPoints(emblem).map(inPlate))
    const off = box.getCenter(new THREE.Vector3()).sub(inPlate(axis))
    expect(Math.hypot(off.x, off.z), 'turns about its own centre').toBeLessThan(1e-4)
    expect(up.length()).toBeCloseTo(1, 9)
  })

  it('adds no program: the ground’s own material, and the ground’s attributes exactly', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    const ground = byName(loading, 'loading-ground') as THREE.Mesh
    const attrs = (m: THREE.Mesh) => ({
      names: Object.keys(m.geometry.attributes).sort(),
      colourItems: m.geometry.getAttribute('color')?.itemSize,
      morphs: Object.keys(m.geometry.morphAttributes).length,
      kind: [
        (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh === true,
        (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true,
        (m as unknown as { isBatchedMesh?: boolean }).isBatchedMesh === true,
      ],
    })
    for (const name of ['loading-emblem', 'loading-wordmark']) {
      const mesh = byName(loading, name) as THREE.Mesh
      // One MATERIAL, so one program in every pass three can draw it in; and
      // three's key also reads the geometry (`vertexNormals`, `vertexAlphas`,
      // the uv channels, morphs) and the object's kind — all the ground's.
      expect(mesh.material, `${name} shares the ground's material`).toBe(ground.material)
      expect(attrs(mesh), `${name}'s attributes`).toEqual(attrs(ground))
    }
  })

  it('the facet facing you is lit, and a half turn puts it in shade', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    showAtOddHeading(loading)
    const emblem = byName(loading, 'loading-emblem') as THREE.Mesh
    const colours = emblem.geometry.getAttribute('color').array as Float32Array
    const pos = emblem.geometry.getAttribute('position')
    // The face whose normal points most squarely at the eye (the mesh's +z).
    let facing = -1
    let best = -Infinity
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    for (let f = 0; f * 3 < pos.count; f++) {
      a.fromBufferAttribute(pos, f * 3)
      b.fromBufferAttribute(pos, f * 3 + 1).sub(a)
      c.fromBufferAttribute(pos, f * 3 + 2).sub(a)
      const n = b.cross(c).normalize()
      if (n.z > best) {
        best = n.z
        facing = f
      }
    }
    const lit = luminance(colours, facing * 9)
    loading.tick(Math.PI / LOADING_MARK_SPIN)
    const shaded = luminance(colours, facing * 9)
    expect(lit).toBeGreaterThan(shaded * 1.6)
    // And a face turned from the light keeps its ambient share, not black.
    expect(shaded).toBeGreaterThan(0)
  })

  it('silver below, gold above and in the wordmark, as the title paints it', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    const emblem = byName(loading, 'loading-emblem') as THREE.Mesh
    const word = byName(loading, 'loading-wordmark') as THREE.Mesh
    const pos = emblem.geometry.getAttribute('position')
    const colours = emblem.geometry.getAttribute('color').array as Float32Array
    // Every triangle of the stand-in's 18-wide top box has a corner at its
    // ±9 sides; the 9.7-wide bottom box reaches ±4.85. So a face that stays
    // inside ±6 (in the logo's own units, 18 of them across) is the bottom's.
    const p = new THREE.Vector3()
    const inner = (6 / 18) * LOADING_EMBLEM_WIDTH
    let silver = 0
    let gold = 0
    for (let f = 0; f * 3 < pos.count; f++) {
      let reach = 0
      for (let v = 0; v < 3; v++)
        reach = Math.max(reach, Math.abs(p.fromBufferAttribute(pos, f * 3 + v).x))
      const r = colours[f * 9] as number
      const bl = colours[f * 9 + 2] as number
      if (reach < inner) {
        expect(bl, 'logo_bottom is silver: bluer than red').toBeGreaterThan(r)
        silver++
      } else {
        expect(r, 'logo_top is gold: redder than blue').toBeGreaterThan(bl)
        gold++
      }
    }
    expect(silver).toBeGreaterThan(0)
    expect(gold).toBeGreaterThan(0)
    const wc = word.geometry.getAttribute('color').array as Float32Array
    expect(wc[0] as number, 'the wordmark is gold').toBeGreaterThan(wc[2] as number)
  })

  it('the gold is the title’s, and the silver the sheet’s', () => {
    // `render/title.ts` does not export its colour, so its line is read.
    const title = fs.readFileSync(path.join(ROOT, 'src/render/title.ts'), 'utf8')
    const gold = /const LOGO_GOLD = 0x([0-9a-f]{6})/.exec(title)?.[1]
    expect(gold, 'title.ts still carries LOGO_GOLD').toBeTruthy()
    expect(EMBLEM_GOLD).toBe(Number.parseInt(gold as string, 16))
    const silver = /const LOGO_SILVER = 0x([0-9a-f]{6})/.exec(title)?.[1] as string
    const sheet = PROPS.medals.colors.silver
    for (let i = 0; i < 3; i++) {
      const byte = Number.parseInt(silver.slice(i * 2, i * 2 + 2), 16)
      expect(
        Math.abs((sheet[i] as number) * 255 - byte),
        `silver channel ${i}`,
      ).toBeLessThanOrEqual(1)
    }
  })

  it('shadeFaces: the ambient floor, and the full share only square to the light', () => {
    const light = new THREE.Vector3(0, 0, 1)
    const normals = new Float32Array([0, 0, 1, 0, 0, -1, 1, 0, 0])
    const base = new Float32Array([1, 0.5, 0.25, 1, 0.5, 0.25, 1, 0.5, 0.25])
    const out = new Float32Array(27)
    shadeFaces(normals, base, light, out)
    // Float32 out, so six places.
    expect(out[0]).toBeCloseTo(EMBLEM_AMBIENT + EMBLEM_DIFFUSE, 6)
    expect(out[8]).toBeCloseTo(0.25 * (EMBLEM_AMBIENT + EMBLEM_DIFFUSE), 6)
    expect(out[9], 'facing away: ambient only').toBeCloseTo(EMBLEM_AMBIENT, 6)
    expect(out[18], 'edge-on: ambient only').toBeCloseTo(EMBLEM_AMBIENT, 6)
    // All three vertices of a face carry its colour: one colour per face.
    expect(out[3]).toBe(out[0])
    expect(out[6]).toBe(out[0])
  })

  it('a logo with nothing to turn keeps the gem', () => {
    const loading = createLoadingScene()
    const only = new THREE.Group()
    const word = new THREE.Mesh(new THREE.BoxGeometry(17, 2.9, 0.5))
    word.name = 'title'
    only.add(word)
    expect(loading.emblem(only)).toBe(false)
    expect(loading.object.getObjectByName('loading-gem')).toBeTruthy()
    loading.show(new THREE.Vector3(), 0, 0, TEXT)
    loading.tick(1)
    expect(byName(loading, 'loading-mark').rotation.y).toBeCloseTo(LOADING_MARK_SPIN, 9)
  })

  it('is on no eye layer once the emblem is in (DEV-141)', () => {
    const loading = createLoadingScene()
    loading.emblem(standIn())
    loading.object.traverse((o) => {
      expect(o.layers.isEnabled(1), `${o.name} on the left eye's layer`).toBe(false)
      expect(o.layers.isEnabled(2), `${o.name} on the right eye's layer`).toBe(false)
    })
  })

  it('app.ts hands the scene its own copy of the logo', () => {
    const app = appSource()
    expect(app).toMatch(/loadingScene\.emblem\(loaded\.object\)/)
  })
})

describe.skipIf(!available)('the loading emblem, built from the real title logo — DEV-434', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    stubCanvas()
  })

  it('the wordmark reads from the eye: FACETED, the longer word, on the left', async () => {
    // A geometric fact about the letters, independent of any rotation chosen:
    // from the front, the space between FACETED and FLIGHT is RIGHT of centre.
    // It is the widest gap in the wordmark's horizontal extent. Read along the
    // plate's own right axis, in world space, from the scene as shown.
    const loading = createLoadingScene()
    expect(loading.emblem(await parse())).toBe(true)
    showAtOddHeading(loading)
    const f = plateFrame(loading)
    const us = worldPoints(byName(loading, 'loading-wordmark') as THREE.Mesh)
      .map(f.u)
      .sort((a, b) => a - b)
    let gapAt = 0
    let widest = 0
    for (let i = 1; i < us.length; i++) {
      const w = (us[i] as number) - (us[i - 1] as number)
      if (w > widest) {
        widest = w
        gapAt = ((us[i] as number) + (us[i - 1] as number)) / 2
      }
    }
    const mid = ((us[0] as number) + (us[us.length - 1] as number)) / 2
    expect(gapAt - mid, 'the word space is right of centre, seen from the eye').toBeGreaterThan(0)
    // And the eye is on the side of the plate the words face.
    const toEye = EYE.clone().sub(f.centre)
    expect(toEye.dot(f.right.clone().cross(f.up)), 'the eye is in front').toBeGreaterThan(0)
  })

  it('the title composition agrees: 2016’s camera sees the logo’s own −z', () => {
    // The other source for the front, and not the loading scene's: the yaws
    // `main_menu.unity` gives its camera and its logo, in three's convention
    // (`boot/app.ts` passes both negated). The camera looks along its facing;
    // the logo is ahead of it, so from the logo the camera is back along it.
    const facing = -(TITLE_2016.cameraYaw * Math.PI) / 180
    const toCamera = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing))
    const logoYaw = -(TITLE_2016.logoYaw * Math.PI) / 180
    toCamera.applyAxisAngle(new THREE.Vector3(0, 1, 0), -logoYaw)
    expect(toCamera.z, 'the title camera is on the logo’s −z side').toBeLessThan(-0.95)
  })

  it('is the width asked for, keeps every face, and is big enough to see', async () => {
    const logo = await parse()
    let sourceTop = 0
    let sourceWord = 0
    logo.traverse((n) => {
      const m = n as THREE.Mesh
      if (!m.isMesh) return
      const tris = (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3
      if (/^title/i.test(m.name)) sourceWord += tris
      else sourceTop += tris
    })
    const loading = createLoadingScene()
    loading.emblem(logo)
    showAtOddHeading(loading)
    const f = plateFrame(loading)
    const emblem = byName(loading, 'loading-emblem') as THREE.Mesh
    const word = byName(loading, 'loading-wordmark') as THREE.Mesh
    expect(emblem.geometry.getAttribute('position').count / 3).toBe(sourceTop)
    expect(word.geometry.getAttribute('position').count / 3).toBe(sourceWord)
    const us = [...worldPoints(emblem), ...worldPoints(word)].map(f.u)
    const width = Math.max(...us) - Math.min(...us)
    expect(width).toBeCloseTo(LOADING_EMBLEM_WIDTH, 3)
    // Orientation lesson §5c: too small to see has been rendered, not reviewed.
    const degrees = (2 * Math.atan(width / 2 / EYE.distanceTo(f.centre)) * 180) / Math.PI
    expect(degrees).toBeGreaterThan(6)
    // And the source is untouched: the title's copy keeps its three meshes.
    const names: string[] = []
    logo.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) names.push(n.name)
    })
    expect(names.sort()).toEqual(['logo_bottom', 'logo_top', 'title'])
  })
})

describe.skipIf(available)('title-logo.glb is not on disk', () => {
  it('so the real-emblem tests above were SKIPPED, not passed', () => {
    expect(available).toBe(false)
  })
})
