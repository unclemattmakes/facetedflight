// tests/unit/launch-look.test.ts: the launch rig wears the HANGAR's curve on any look (DEV-568).
//
// DEV-561 gave the hangar's shaft and the launch's the same colours, face for
// face. They still read differently on Classic, because the hangar is a menu
// and always wears Anniversary's ACES (D35) while the launch was drawn under
// the mission's curve, and Classic's is none. `render/hangar-art.ts` now draws
// the hangar's curve into the rig's own vertex colours whenever the renderer's
// curve is not it, and leaves the material alone, so nothing recompiles.
//
// The oracle for the curve is `acesFilmic`, which `loading-tone.test.ts` holds
// against three's own shader chunk. The oracle for the colours is
// `assembleLaunchArt`'s bake, called directly on the same file: what the rig
// carries after the stand is that bake through the curve, or the bake itself.
//
// The GLB is bought geometry and never in git (hard rule 7), so the half that
// reads it is guarded, the disk work is inside each `it`, and the guard has a
// loud counterpart.

import fs from 'node:fs'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { createElevator } from '@/render/elevator'
import { createHangar } from '@/render/hangar'
import {
  assembleLaunchArt,
  createLaunchArt,
  HANGAR_ROOM_MESH,
  launchLookPieces,
  wearHangarLook,
} from '@/render/hangar-art'
import { acesFilmic, type ToneLook, toneColoursFor, toneLookOf } from '@/render/tone'
import { hangarSpecFor } from '@/sim/hangar'
import { HYDRATED_MAINTAINER_CHECKOUT } from './helpers/checkout'

const FILE = `public/${HANGAR_ROOM_MESH}`
const AVAILABLE = fs.existsSync(FILE)

const editionLook = (id: string): ToneLook =>
  toneLookOf(JSON.parse(fs.readFileSync(`content/editions/${id}.json`, 'utf8')))

/** The menus' look (`MENU_EDITION`, D35) and the one a player can choose instead. */
const HANGAR = editionLook('anniversary')
const CLASSIC = editionLook('classic')

const aces = (rgb: ArrayLike<number>, exposure: number): Float32Array => {
  const out = Float32Array.from(rgb)
  for (let i = 0; i + 2 < out.length; i += 3) acesFilmic(out, i, exposure)
  return out
}

const worst = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  expect(a.length).toBe(b.length)
  let w = 0
  for (let i = 0; i < a.length; i++) w = Math.max(w, Math.abs((a[i] as number) - (b[i] as number)))
  return w
}

describe("the hangar's curve, drawn into colours", () => {
  const base = Float32Array.from([0.05, 0.04, 0.06, 0.3, 0.2, 0.1, 0, 0, 0, 1.4, 0.9, 0.7])

  it('is the shipped pair: the menus on ACES, Classic on none', () => {
    // If either preset moves, the case below that it relies on must be re-read.
    expect(HANGAR.curve).toBe('aces')
    expect(CLASSIC.curve).toBe('none')
  })

  it('under none, is ACES at the hangar exposure, which the clamp then leaves alone', () => {
    const out = new Float32Array(base.length)
    expect(toneColoursFor(base, HANGAR, CLASSIC, out)).toBe(true)
    expect(worst(out, aces(base, HANGAR.exposure))).toBe(0)
    for (const c of out) expect(c >= 0 && c <= 1, 'inside none’s clamp').toBe(true)
    // And it darkens the room's slate, which is the whole of the difference.
    expect(out[0] as number).toBeLessThan(base[0] as number)
  })

  it("under the hangar's own curve, is the bake, scaled by the exposure ratio and nothing else", () => {
    const out = new Float32Array(base.length)
    expect(toneColoursFor(base, HANGAR, HANGAR, out)).toBe(true)
    expect(worst(out, base)).toBe(0)
    expect(toneColoursFor(base, HANGAR, { curve: 'aces', exposure: 2 }, out)).toBe(true)
    expect(
      worst(
        out,
        base.map((c) => (c * HANGAR.exposure) / 2),
      ),
    ).toBeLessThan(1e-7)
  })

  it('refuses a curve under another curve, and leaves the bake as it was', () => {
    const out = new Float32Array(base.length)
    expect(toneColoursFor(base, HANGAR, { curve: 'agx', exposure: 1 }, out)).toBe(false)
    expect(worst(out, base)).toBe(0)
    expect(toneColoursFor(base, CLASSIC, HANGAR, out)).toBe(false)
    expect(worst(out, base)).toBe(0)
  })
})

const parse = async (): Promise<THREE.Object3D> => {
  const bytes = fs.readFileSync(FILE)
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer as ArrayBuffer, '', (gltf) => resolve(gltf.scene), reject)
  })
}

const int01 = fs
  .readdirSync('content/levels')
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(fs.readFileSync(`content/levels/${f}`, 'utf8')))
  .find((l) => l.id === 'int_01_hoverJet')?.spawn?.launch
if (!int01) throw new Error('no int_01_hoverJet launch in content/levels')

const stand = async (live: { look: ToneLook }) => {
  const room = createHangar({
    spec: hangarSpecFor(),
    seed: 0x48414e47,
    furnished: false,
    title: '',
    subtitle: '',
    level: null,
  })
  const elevator = createElevator({
    platform: int01.platform,
    shaft: int01.shaft,
    rise: int01.rise,
    hangar: hangarSpecFor(),
    seed: 0x48414e47,
  })
  const anchor = new THREE.Group()
  anchor.add(room.object, elevator.object)
  const loaded = await parse()
  const art = createLaunchArt({
    room: room.object,
    lift: elevator,
    alive: () => true,
    load: async () => loaded,
    look: { hangar: HANGAR, live: () => live.look },
  })
  expect(await art.ready).toBe(true)
  const named = (root: THREE.Object3D, name: string) => {
    const mesh = root.getObjectByName(name) as THREE.Mesh | undefined
    if (!mesh?.isMesh) throw new Error(`no ${name}`)
    return mesh
  }
  return {
    art,
    room: named(room.object, 'launch-room-2016'),
    lamps: named(room.object, 'launch-room-2016-lamps'),
    shaft: named(elevator.object, 'elevator-shaft-2016'),
    deck: named(elevator.object, 'elevator-deck-2016'),
  }
}

const colours = (mesh: THREE.Mesh) => mesh.geometry.getAttribute('color').array as Float32Array

describe.skipIf(!AVAILABLE)("2016's launch rig, on Classic, wears the hangar's curve", () => {
  it("carries the bake through ACES on every piece, so Classic's clamp draws what the hangar draws", async () => {
    const direct = assembleLaunchArt(await parse())
    const live = { look: CLASSIC }
    const rig = await stand(live)
    for (const piece of ['room', 'lamps', 'shaft', 'deck'] as const) {
      expect(worst(colours(rig[piece]), aces(colours(direct[piece]), HANGAR.exposure)), piece).toBe(
        0,
      )
    }
  })

  it('goes back to the bake itself on a flip to the hangar’s own look, and to ACES again on the way back', async () => {
    const direct = assembleLaunchArt(await parse())
    const live = { look: CLASSIC }
    const rig = await stand(live)
    const version = (rig.shaft.geometry.getAttribute('color') as THREE.BufferAttribute).version
    live.look = HANGAR
    rig.art.retone()
    expect(worst(colours(rig.shaft), colours(direct.shaft))).toBe(0)
    expect(worst(colours(rig.room), colours(direct.room))).toBe(0)
    expect(
      (rig.shaft.geometry.getAttribute('color') as THREE.BufferAttribute).version,
      'the new colours are flagged for upload',
    ).toBeGreaterThan(version)
    live.look = CLASSIC
    rig.art.retone()
    expect(worst(colours(rig.shaft), aces(colours(direct.shaft), HANGAR.exposure))).toBe(0)
  })

  it('moves no material: still one, still tone-mapped, never dirtied, so no program changes', async () => {
    // `toneMapped: false` would put the rig on bloom's UI layer
    // (`render/bloom.ts`), and any dirtied material relinks on its next draw.
    const live = { look: HANGAR }
    const rig = await stand(live)
    const material = rig.shaft.material as THREE.MeshBasicMaterial
    const version = material.version
    for (const look of [CLASSIC, HANGAR, CLASSIC]) {
      live.look = look
      rig.art.retone()
    }
    for (const piece of [rig.room, rig.lamps, rig.deck])
      expect(piece.material, 'one material').toBe(material)
    expect(material.toneMapped).toBe(true)
    expect(material.version, 'the material was never dirtied').toBe(version)
  })

  it('finds every piece by its material, the lid and the caps the dress adds included', async () => {
    const rig = await stand({ look: CLASSIC })
    const pieces = launchLookPieces(
      [rig.room.parent as THREE.Object3D, rig.shaft.parent as THREE.Object3D],
      rig.shaft.material as THREE.Material,
    )
    expect(pieces.map((p) => p.mesh.name).sort()).toEqual(
      [
        'elevator-deck-2016',
        'elevator-shaft-2016',
        'launch-room-2016',
        'launch-room-2016-lamps',
      ].sort(),
    )
    // A lid on the same material, as `lift-seal.ts` hangs one, is found too.
    const lid = new THREE.Mesh(new THREE.BufferGeometry(), rig.shaft.material)
    lid.geometry.setAttribute('color', new THREE.Float32BufferAttribute([0.1, 0.1, 0.1], 3))
    ;(rig.shaft.parent as THREE.Object3D).add(lid)
    const withLid = launchLookPieces(
      [rig.shaft.parent as THREE.Object3D],
      rig.shaft.material as THREE.Material,
    )
    expect(withLid.some((p) => p.mesh === lid)).toBe(true)
    expect(wearHangarLook(withLid, HANGAR, CLASSIC)).toBe(true)
    expect(
      worst(lid.geometry.getAttribute('color').array, aces([0.1, 0.1, 0.1], HANGAR.exposure)),
    ).toBe(0)
  })
})

// The loud counterpart asserts only in a HYDRATED maintainer checkout: these are BOUGHT assets,
// which the public export and its content pack never carry (plan/PUBLIC-REPO-facetedflight.md
// §4.3, Matt M4), and a plain clone of this repo (its CI runner) never pulls them: both
// skip both halves. tests/unit/helpers/checkout.ts.
describe.skipIf(AVAILABLE || !HYDRATED_MAINTAINER_CHECKOUT)(
  "the launch rig's look: hangar-room.glb is not hydrated",
  () => {
    it('says so, rather than passing quietly', () => {
      expect(
        fs.existsSync(FILE),
        'run tools/assets/convert-hangar-art.mjs (or pnpm assets:pull) to measure the launch rig',
      ).toBe(true)
    })
  },
)
