// tests/unit/hangar-light.test.ts — the level-select room, lit as 2016 lit it (DEV-437).
//
// `render/hangar-light.ts` builds `Environment_Hangar.prefab`'s spot, key and
// Skyshop ambient from the generated sheet (`PROPS.hangar`). What is tested is
// where the light LANDS, never an angle typed twice: the spot shines down onto
// 2016's own deck, the key comes from above, the ambient a surface receives is
// Marmoset's own `SHLookup` of the sky along an independently derived path, the
// falloff is Unity's own formula within a stated band, and the lights are in
// the room from the first frame at zero.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it, vi } from 'vitest'
import { createHangar, seatEyeLocal } from '@/render/hangar'
import { HANGAR_ROOM_MESH, roomFactsOf, roomMatrix } from '@/render/hangar-art'
import {
  bareHangarLightRig,
  createHangarLight,
  HANGAR_LIGHT_SHEET,
  hangarSpotIntensity,
  unityGammaToLinear,
  unityLightForward,
  unitySpotAttenuation,
  unityToRoom,
} from '@/render/hangar-light'
import { marmosetShLookup, marmosetSunIntensity } from '@/render/skyshop-ibl'
import { hangarSpecFor } from '@/sim/hangar'
import { MAINTAINER_CHECKOUT } from './helpers/checkout'

const sheet = HANGAR_LIGHT_SHEET
const spec = hangarSpecFor()
const ROOM_GLB = `public/${HANGAR_ROOM_MESH}`
const haveRoom = fs.existsSync(ROOM_GLB)

const parse = async (file: string): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(file)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

/** Directions spread over the sphere, deterministic. */
const sphere = (n: number): [number, number, number][] => {
  const out: [number, number, number][] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    out.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r])
  }
  return out
}

describe("2016's room light, from the sheet", () => {
  it('is a spot and a directional key, both live, and a Skyshop ambient', () => {
    expect(sheet.lights.ship.type).toBe('spot')
    expect(sheet.lights.env.type).toBe('directional')
    expect(sheet.lights.ship.live && sheet.lights.env.live).toBe(true)
    expect(sheet.ibl.sh).toHaveLength(27)
  })

  it('shines the spot straight down, and the key from high above', () => {
    expect(unityLightForward(sheet.lights.ship.rotationUnity).y).toBeLessThan(-0.999)
    // 57 degrees up: a key that lights what faces the ceiling well before the walls.
    expect(unityLightForward(sheet.lights.env.rotationUnity).y).toBeLessThan(-0.8)
  })

  it("fits Unity's own spot falloff within 9 % over everything the cone reaches", () => {
    // Marmoset: 2 * N.L * albedo * light * atten(d). three: N.L * albedo / pi *
    // intensity / d^2 under decay 2. From 3 m under the lamp (above the jet's
    // canopy) to the floor 13 m under it.
    const { intensity, range, positionUnity } = sheet.lights.ship
    const drop = positionUnity[1] - sheet.roomAnchor[1]
    const k = hangarSpotIntensity(intensity, range)
    let worst = 0
    for (let d = drop - 3; d <= drop + 0.001; d += 0.05) {
      const unity = 2 * intensity * unitySpotAttenuation(d, range)
      const three = k / (d * d) / Math.PI
      worst = Math.max(worst, Math.abs(three / unity - 1))
    }
    expect(drop).toBeGreaterThan(12)
    expect(worst).toBeLessThan(0.09)
  })

  it('refuses a rig that is not one spot, one directional light and one probe', () => {
    const rig = bareHangarLightRig()
    rig.add(new THREE.PointLight())
    expect(() => createHangarLight(rig)).not.toThrow()
    const two = bareHangarLightRig()
    two.add(new THREE.SpotLight())
    expect(() => createHangarLight(two)).toThrow(/2 spots/)
  })

  it('is dark until it is turned on, and dark again when turned off', () => {
    const light = createHangarLight()
    const levels = () => [light.spot.intensity, light.key.intensity, light.probe.intensity]
    expect(levels()).toEqual([0, 0, 0])
    light.setOn(true)
    expect(levels().every((v) => v > 0)).toBe(true)
    light.setOn(false)
    expect(levels()).toEqual([0, 0, 0])
  })

  it("hands the shader Unity 5.4's light: colour times intensity, linearised WHOLE", () => {
    // DEV-437 addendum. Unity's `GammaToLinearSpace` is the sRGB curve to 1 and
    // x^2.2 past it; at 0.5 it is Unity's linear `unity_ColorSpaceGrey`.
    expect(unityGammaToLinear(0.5)).toBeCloseTo(0.214041, 6)
    expect(sheet.lights.env.intensity).toBe(0.63)
    expect(sheet.lights.ship.intensity).toBe(1.75)
    const light = createHangarLight()
    light.setOn(true)
    // What reaches the surface per unit of Marmoset's direct scale (2 pi), red.
    const per = (l: THREE.Light) => (l.color.r * l.intensity) / marmosetSunIntensity(1)
    // The key: 0.63 in gamma is 0.3547 linear, NOT 0.63 — the room's floor
    // and walls read 30-40 levels over f0030 while it was the product.
    expect(per(light.key)).toBeCloseTo(((0.63 + 0.055) / 1.055) ** 2.4, 4)
    expect(per(light.key)).toBeLessThan(0.6 * 0.63)
    // The spot, white at 1.75: past 1, so 1.75^2.2 = 3.425, not 1.75. Its three
    // intensity carries the falloff fit (r^2 / 25) as well.
    const spotPer = per(light.spot) / (sheet.lights.ship.range ** 2 / 25)
    expect(spotPer).toBeCloseTo(1.75 ** 2.2, 3)
    light.dispose()
  })
})

describe('the ambient a surface receives is Marmoset’s own lookup', () => {
  // The room frame's world rotation is not the identity: the room group is spun
  // (HANGAR_SPIN) and the art turned again inside it (`roomYaw`). The probe is
  // scene-global, so its SH must carry both. Checked against `marmosetShLookup`
  // along a path derived WITHOUT `probeRotationFor`: three world -> the room
  // frame (inverse world rotation) -> Unity (z mirror) -> sky space (inverse of
  // the sky's own rotation).
  for (const [label, world] of [
    ['a yawed room', new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.1)],
    [
      'a room tipped off the vertical',
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.2, 0.2, 'YXZ')),
    ],
  ] as const) {
    it(`matches at 256 directions, for ${label}`, () => {
      const parent = new THREE.Group()
      parent.quaternion.copy(world)
      const light = createHangarLight()
      parent.add(light.group)
      light.setOn(true)
      const sky = new THREE.Quaternion(
        ...(sheet.ibl.rotationUnity as [number, number, number, number]),
      )
      const target = new THREE.Vector3()
      let worst = 0
      for (const n of sphere(256)) {
        const three = new THREE.Vector3(...n)
        light.probe.sh.getIrradianceAt(three, target)
        const mine = target.multiplyScalar(light.probe.intensity / Math.PI)
        const inRoom = three.clone().applyQuaternion(world.clone().invert())
        const unity = new THREE.Vector3(inRoom.x, inRoom.y, -inRoom.z)
        const inSky = unity.applyQuaternion(sky.clone().invert())
        const theirs = marmosetShLookup(sheet.ibl.sh as number[], [inSky.x, inSky.y, inSky.z])
        for (let k = 0; k < 3; k++) {
          const want = (theirs[k] as number) * sheet.ibl.exposure.diffuse
          worst = Math.max(worst, Math.abs(mine.getComponent(k) - want))
        }
      }
      expect(worst).toBeLessThan(1e-5)
    })
  }
})

describe('in the furnished room from the FIRST frame, before anything loads', () => {
  // The claim `menu-light-compile.spec.ts` cannot make: that spec walks the room
  // after it has been open for seconds, by which time a light that arrived LATE
  // has already arrived — measured, it stays green with the rig built lazily. A
  // light's count is in every lit program's key, so what matters is the room as
  // `createHangar` returns it, synchronously, before any promise has run. Built
  // here with a stub `document` (the room paints its labels on canvases).
  it('holds one spot, one directional light and one probe, all dark, the moment it is built', () => {
    const canvas = () => ({ width: 0, height: 0, getContext: () => null, style: {} })
    vi.stubGlobal('document', { createElement: canvas })
    try {
      const art = createHangar({
        spec,
        seed: 0x48414e47,
        title: '',
        subtitle: '',
        level: null,
        missions: [],
      })
      const found = { spot: [] as number[], directional: [] as number[], probe: [] as number[] }
      art.object.traverse((o) => {
        if ((o as THREE.SpotLight).isSpotLight) found.spot.push((o as THREE.Light).intensity)
        if ((o as THREE.DirectionalLight).isDirectionalLight)
          found.directional.push((o as THREE.Light).intensity)
        if ((o as THREE.LightProbe).isLightProbe) found.probe.push((o as THREE.Light).intensity)
      })
      expect(found).toEqual({ spot: [0], directional: [0], probe: [0] })
      art.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe.skipIf(!haveRoom)("the light, in 2016's room", () => {
  it("stands in the same frame as the GLB: the sheet's anchor is the converter's", async () => {
    // Two tools read the same prefab two ways — the sheet composes TRS down the
    // prefab, the converter composes matrices down the flattened scene. They must
    // agree on the room frame, or the light is somewhere the room is not.
    const room = await parse(ROOM_GLB)
    const facts = room.getObjectByName('hangar-room')?.userData as { anchorUnity: number[] }
    for (let k = 0; k < 3; k++) {
      expect(
        Math.abs((facts.anchorUnity[k] as number) - (sheet.roomAnchor[k] as number)),
      ).toBeLessThan(1e-3)
    }
  })

  it('keeps the key on the side 2016 put it: over the right shoulder, travelling forward-left', async () => {
    // The spot is straight down, so a forgotten mirror cannot show on it. The
    // key can. In Unity's own left-handed frame, from 2016's eye toward the jet
    // (right = (d.z, 0, -d.x)), light_env travels forward and to the LEFT: it
    // comes over the viewer's right shoulder. The same relation, measured here in
    // three with three's own right (forward x up), against the eye and the jet
    // the CONVERTER took into three space — two conversions that must agree.
    const room = await parse(ROOM_GLB)
    const facts = roomFactsOf(room.getObjectByName('hangar-room') as THREE.Object3D)
    const forward = new THREE.Vector3(...facts.jet)
      .sub(new THREE.Vector3(...facts.eye))
      .setY(0)
      .normalize()
    const right = forward.clone().cross(new THREE.Vector3(0, 1, 0))
    const key = unityLightForward(sheet.lights.env.rotationUnity).setY(0).normalize()
    expect(key.dot(forward), 'travelling away from the viewer').toBeGreaterThan(0.7)
    expect(key.dot(right), 'and to their left').toBeLessThan(-0.5)
  })

  it("shines the spot onto 2016's own deck, and the jet stands in its cone", async () => {
    const room = await parse(ROOM_GLB)
    const deck = room.getObjectByName('platform') as THREE.Mesh
    const spot = unityToRoom(sheet.lights.ship.positionUnity, sheet.roomAnchor)
    const down = unityLightForward(sheet.lights.ship.rotationUnity)
    const ray = new THREE.Raycaster(spot, down)
    const hit = ray.intersectObject(
      new THREE.Mesh(deck.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })),
    )[0]
    expect(hit, 'the beam lands on the deck').toBeDefined()
    // The jet, in the same frame: within the inner half of the cone.
    const facts = roomFactsOf(room.getObjectByName('hangar-room') as THREE.Object3D)
    const toJet = new THREE.Vector3(...facts.jet).sub(spot).normalize()
    const half = ((sheet.lights.ship.spotAngleDeg / 2) * Math.PI) / 180
    expect(Math.acos(toJet.dot(down))).toBeLessThan(half / 2)
  })

  it('turns with the room: in the room group, the spot stays over the deck the art stands', async () => {
    const room = await parse(ROOM_GLB)
    const facts = roomFactsOf(room.getObjectByName('hangar-room') as THREE.Object3D)
    const seat = seatEyeLocal(spec)
    const m = roomMatrix(facts, seat, spec.floorY)
    const light = createHangarLight()
    m.decompose(light.group.position, light.group.quaternion, light.group.scale)
    light.group.updateMatrixWorld(true)
    const deck = room.getObjectByName('platform') as THREE.Mesh
    const box = new THREE.Box3().setFromBufferAttribute(
      deck.geometry.getAttribute('position') as THREE.BufferAttribute,
    )
    box.applyMatrix4(m)
    const at = light.spot.getWorldPosition(new THREE.Vector3())
    const aim = light.spot.target.getWorldPosition(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    expect(Math.hypot(at.x - centre.x, at.z - centre.z), 'over the deck').toBeLessThan(1)
    expect(aim.y, 'aimed down').toBeLessThan(at.y)
  })
})

// The loud counterpart asserts only in the maintainer checkout: these are BOUGHT assets,
// which the public export and its content pack never carry (plan/PUBLIC-REPO-facetedflight.md
// §4.3, Matt M4), so a public clone skips both halves. tests/unit/helpers/checkout.ts.
describe.skipIf(haveRoom || !MAINTAINER_CHECKOUT)(
  "the light, in 2016's room: the GLB is not hydrated",
  () => {
    it('says so, rather than passing quietly', () => {
      expect(fs.existsSync(ROOM_GLB), 'run pnpm assets:pull to measure the light in the room').toBe(
        true,
      )
    })
  },
)
