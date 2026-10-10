// tests/unit/hangar-reflect-shadow.test.ts — the level-select room's reflective
// ambient (DEV-439) and its key light's shadow (DEV-440).
//
// Held against things outside the code under test where there are any: the
// sheet's own SH (Skyshop's measurement of the sky the cube pictures), 2016's
// Fresnel curve as the port's terrain bridge reads it, and the room's own
// geometry for the shadow box. DEV-899 dropped `hangar-sky.hdr` (Skyshop's
// example sky): the room reflects the nine-coefficient sky, always, and these
// tests read nothing from disk.

import fs from 'node:fs'
import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@/boot/settings'
import type { Edition } from '@/content/edition-schema'
import { createEditionState } from '@/game/edition'
import { createHangar } from '@/render/hangar'
import {
  configureReflective,
  createRoomShadows,
  equirectDirection,
  fillReflectiveSky,
  HANGAR_KEY_SHADOW,
  HANGAR_LIGHT_SHEET,
  turnReflectiveSky,
} from '@/render/hangar-light'
import { marmosetSpecularF0 } from '@/render/terrain-mesh'
import { hangarSpecFor } from '@/sim/hangar'
import anniversaryJson from '../../content/editions/anniversary.json'
import classicJson from '../../content/editions/classic.json'

const classic = classicJson as unknown as Edition
const anniversary = anniversaryJson as unknown as Edition

const halfTexture = (w: number, h: number) => {
  const t = new THREE.DataTexture(
    new Uint16Array(w * h * 4),
    w,
    h,
    THREE.RGBAFormat,
    THREE.HalfFloatType,
  )
  return t
}

/** Mean radiance and luminance band 1 of an equirect in the ROOM frame, solid-angle weighted. */
const moments = (texture: THREE.DataTexture) => {
  const { width, height, data } = texture.image as {
    width: number
    height: number
    data: Uint16Array
  }
  const mean = [0, 0, 0]
  const band1 = new THREE.Vector3()
  let wsum = 0
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const d = equirectDirection(i, j, width, height)
      const w = Math.sqrt(1 - d.y * d.y)
      const k = (j * width + i) * 4
      const c = [0, 1, 2].map((q) => THREE.DataUtils.fromHalfFloat(data[k + q] as number))
      for (let q = 0; q < 3; q++) mean[q] = (mean[q] as number) + (c[q] as number) * w
      const lum = 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number)
      band1.addScaledVector(d, lum * w)
      wsum += w
    }
  }
  return { mean: mean.map((v) => v / wsum), band1: band1.normalize() }
}

// ── DEV-439: the reflective materials, against 2016's Fresnel ────────────────

describe('the reflective materials (DEV-439)', () => {
  for (const part of ['deck', 'shaft'] as const) {
    it(`meets 2016's reflectance at BOTH ends of the curve: the ${part}`, () => {
      const record = HANGAR_LIGHT_SHEET.specular[part]
      const m = configureReflective(new THREE.MeshPhysicalMaterial(), record)
      // three, at metalness 0: F0 = min(0.04 x colour, 1) x intensity; F90 = intensity.
      const f0 = [m.specularColor.r, m.specularColor.g, m.specularColor.b].map(
        (c) => Math.min(0.04 * c, 1) * m.specularIntensity,
      )
      const marmoset = marmosetSpecularF0(record.specInt, record.fresnel, record.specColorSrgb)
      for (let c = 0; c < 3; c++) expect(f0[c], 'face-on').toBeCloseTo(marmoset[c] as number, 6)
      // Marmoset's grazing end is `_SpecInt x _SpecColor`, never white.
      expect(m.specularIntensity, 'grazing').toBeCloseTo(record.specInt, 6)
      expect(m.envMapIntensity, "the sky's specular exposure").toBe(
        HANGAR_LIGHT_SHEET.ibl.exposure.specular,
      )
    })
  }

  it('turns the reflected sky with the room: three looks the sky up at the room-frame direction', () => {
    const m = new THREE.MeshPhysicalMaterial()
    const yaw = 1.234
    turnReflectiveSky(m, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
    // three's lookup matrix for a prefiltered map is the rotation by the NEGATED
    // Euler: a world direction goes to the room frame, whose turn is `yaw`.
    const e = m.envMapRotation.clone()
    const look = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-e.x, -e.y, -e.z))
    const inRoom = new THREE.Vector3(0, 0, -1)
    const world = inRoom.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
    const back = world.clone().transformDirection(look)
    expect(back.distanceTo(inRoom)).toBeLessThan(1e-9)
  })

  it('refuses a tilted room: the reflected sky only turns about y', () => {
    const m = new THREE.MeshPhysicalMaterial()
    expect(() =>
      turnReflectiveSky(
        m,
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3),
      ),
    ).toThrow(/tilted/)
  })

  // The program the deck and the shaft draw with has to exist before the art
  // lands, or it compiles in the clear when it does. So the room, as
  // `createHangar` returns it synchronously, already DRAWS that class: a primer
  // wearing a reflective material with the room's sky texture, at the sky's size.
  it("draws the reflective class from the room's FIRST frame, at the sky's size, named for the key's shadow", () => {
    const canvas = () => ({ width: 0, height: 0, getContext: () => null, style: {} })
    vi.stubGlobal('document', { createElement: canvas })
    try {
      const art = createHangar({
        spec: hangarSpecFor(),
        seed: 0x48414e47,
        title: '',
        subtitle: '',
        level: null,
        missions: [],
      })
      const primer = art.object.getObjectByName('hangar-2016-reflective-primer') as THREE.Mesh
      expect(primer, 'the primer is in the room the moment it is built').toBeDefined()
      expect(primer.visible && primer.frustumCulled === false, 'and drawn').toBe(true)
      const m = primer.material as THREE.MeshPhysicalMaterial
      expect(m.isMeshPhysicalMaterial && m.vertexColors && m.flatShading).toBe(true)
      const sky = m.envMap as THREE.DataTexture
      expect([sky.image.width, sky.image.height], "the sky's size").toEqual([512, 256])
      expect(sky.mapping).toBe(THREE.EquirectangularReflectionMapping)
      // DEV-440: `boot/app.ts` finds the key by name at boot.
      const key = art.object.getObjectByName('hangar-2016-key') as THREE.DirectionalLight
      expect(key?.isDirectionalLight).toBe(true)
      art.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe("the room's reflected sky: the nine coefficients, always (DEV-899)", () => {
  it("wears the colour of 2016's own ambient: its mean agrees with the sheet SH channel for channel", () => {
    const t = halfTexture(512, 256)
    fillReflectiveSky(t)
    const { mean } = moments(t)
    const dc = [0, 1, 2].map((c) => (HANGAR_LIGHT_SHEET.ibl.sh[c] as number) * 0.28209479)
    const ratio = [0, 1, 2].map((c) => (mean[c] as number) / (dc[c] as number))
    expect(Math.max(...ratio) / Math.min(...ratio) - 1, 'channel spread').toBeLessThan(0.02)
  })

  it('stands the sky the right way up: the zenith is the blue end', () => {
    const t = halfTexture(512, 256)
    fillReflectiveSky(t)
    const { width, height, data } = t.image as { width: number; height: number; data: Uint16Array }
    const bandBlue = (row: number) => {
      let r = 0
      let b = 0
      for (let i = 0; i < width; i++) {
        r += THREE.DataUtils.fromHalfFloat(data[(row * width + i) * 4] as number)
        b += THREE.DataUtils.fromHalfFloat(data[(row * width + i) * 4 + 2] as number)
      }
      return b / Math.max(r, 1e-9)
    }
    // Row `height - 1` is v = 1, straight up (`equirectDirection`).
    expect(equirectDirection(0, height - 1, width, height).y).toBeGreaterThan(0.99)
    expect(bandBlue(height - 8), 'blue over red, up').toBeGreaterThan(bandBlue(height / 2 + 4))
  })

  it('writes every texel: the empty texture the room began with is gone', () => {
    const t = halfTexture(512, 256)
    fillReflectiveSky(t)
    expect((t.image.data as Uint16Array).some((v) => v !== 0)).toBe(true)
  })

  it('never requests the Skyshop picture: no source file names it', () => {
    // The structural guard: nothing under src/ may build the file's URL again.
    // Described, not spelled, so this sweep does not match itself.
    const hit = (dir: string): string[] => {
      const out: string[] = []
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`
        if (e.isDirectory()) out.push(...hit(p))
        else if (
          /\.(ts|mjs)$/.test(e.name) &&
          fs.readFileSync(p, 'utf8').includes(['hangar', 'sky.hdr'].join('-'))
        )
          out.push(p)
      }
      return out
    }
    expect(hit('src')).toEqual([])
  })
})

// ── DEV-440: the key light's shadows ────────────────────────────────────────

describe("the key light's shadows (DEV-440)", () => {
  const room = () => {
    const group = new THREE.Group()
    const lit = () => new THREE.MeshStandardMaterial()
    const floor = new THREE.Mesh(new THREE.BoxGeometry(40, 0.2, 40), lit())
    floor.name = 'floor'
    floor.userData.castShadow = false
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(1, 30, 1), lit())
    pillar.position.set(6, 15, -4)
    const label = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial())
    group.add(floor, pillar, label)
    const key = new THREE.DirectionalLight(0xffffff, 0)
    key.position.set(-10, 15, -3)
    group.add(key, key.target)
    group.updateMatrixWorld(true)
    return { group, floor, pillar, label, key }
  }

  it("casts under the same switch as the mission sun's map: Anniversary yes, Classic no, quality low no", () => {
    for (const [edition, quality, want] of [
      [anniversary, 'high', true],
      [classic, 'high', false],
      [anniversary, 'low', false],
    ] as const) {
      const { group, key } = room()
      const state = createEditionState(edition, { ...DEFAULT_SETTINGS, quality })
      const shadows = createRoomShadows(group, key, state)
      // Set at construction — before any frame compiles against the light count.
      expect(key.castShadow, `${edition.id} at ${quality}`).toBe(want)
      expect(shadows.on).toBe(want)
      shadows.dispose()
    }
  })

  it('follows a flip of the preset, both ways', () => {
    const { group, key } = room()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createRoomShadows(group, key, state)
    state.setLook(classic)
    expect(key.castShadow).toBe(false)
    state.setLook(anniversary)
    expect(key.castShadow).toBe(true)
    shadows.dispose()
  })

  it("draws no map while the room's light is dark, then fits one round everything that stands in the room", () => {
    const { group, floor, pillar, label, key } = room()
    const state = createEditionState(anniversary, DEFAULT_SETTINGS)
    const shadows = createRoomShadows(group, key, state)
    shadows.update()
    expect(key.shadow.autoUpdate, 'no pass while dark').toBe(false)
    expect(shadows.fit).toBe(null)
    key.intensity = 3
    shadows.update()
    expect(key.shadow.autoUpdate, 'the pass runs once lit').toBe(true)
    // Flags: lit meshes cast and receive; a mesh 2016 told not to cast does not;
    // an unlit one is left alone.
    expect(pillar.castShadow && pillar.receiveShadow).toBe(true)
    expect(floor.castShadow).toBe(false)
    expect(floor.receiveShadow).toBe(true)
    expect(label.castShadow || label.receiveShadow).toBe(false)
    // Every corner of every caster sits inside the shadow camera's box.
    const cam = key.shadow.camera
    cam.position.copy(key.getWorldPosition(new THREE.Vector3()))
    cam.lookAt(key.target.getWorldPosition(new THREE.Vector3()))
    cam.updateMatrixWorld(true)
    const view = cam.matrixWorldInverse
    for (const mesh of [pillar, floor]) {
      mesh.geometry.computeBoundingBox()
      const b = (mesh.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(mesh.matrixWorld)
      for (const x of [b.min.x, b.max.x])
        for (const y of [b.min.y, b.max.y])
          for (const z of [b.min.z, b.max.z]) {
            const p = new THREE.Vector3(x, y, z).applyMatrix4(view)
            expect(p.x, 'lateral').toBeGreaterThanOrEqual(cam.left - 1e-6)
            expect(p.x).toBeLessThanOrEqual(cam.right + 1e-6)
            expect(p.y).toBeGreaterThanOrEqual(cam.bottom - 1e-6)
            expect(p.y).toBeLessThanOrEqual(cam.top + 1e-6)
            expect(-p.z, 'depth').toBeGreaterThanOrEqual(cam.near - 1e-6)
            expect(-p.z).toBeLessThanOrEqual(cam.far + 1e-6)
          }
    }
    shadows.dispose()
  })

  it('keeps an unlit mesh that asks to cast in the fit and casting: the baked shaft (DEV-561)', () => {
    // The menu's shaft wears an unlit material since DEV-561 and is still the
    // bore the key comes down. Without the flag it would leave the fit and stop
    // casting, and the key would reach the room through it.
    const { group, label, key } = room()
    const shaft = new THREE.Mesh(
      new THREE.BoxGeometry(2, 60, 2),
      new THREE.MeshBasicMaterial({ vertexColors: true }),
    )
    shaft.position.set(0, 50, 0)
    shaft.userData.castShadow = true
    group.add(shaft)
    group.updateMatrixWorld(true)
    const shadows = createRoomShadows(group, key, createEditionState(anniversary, DEFAULT_SETTINGS))
    key.intensity = 3
    shadows.update()
    expect(shaft.castShadow, 'the flagged unlit mesh casts').toBe(true)
    expect(shaft.receiveShadow, 'and receives nothing: it is unlit').toBe(false)
    expect(label.castShadow || label.receiveShadow, 'an unflagged unlit mesh is left alone').toBe(
      false,
    )
    // In the fit: its top corner sits inside the shadow camera's box.
    const cam = key.shadow.camera
    cam.position.copy(key.getWorldPosition(new THREE.Vector3()))
    cam.lookAt(key.target.getWorldPosition(new THREE.Vector3()))
    cam.updateMatrixWorld(true)
    const top = new THREE.Vector3(1, 80, 1).applyMatrix4(cam.matrixWorldInverse)
    expect(top.y, 'the shaft top is inside the fit').toBeLessThanOrEqual(cam.top + 1e-6)
    expect(top.y).toBeGreaterThanOrEqual(cam.bottom - 1e-6)
    expect(-top.z).toBeGreaterThanOrEqual(cam.near - 1e-6)
    shadows.dispose()
  })

  it("is 2016's shadow: the strength the scene set, and a hard edge", () => {
    expect(HANGAR_KEY_SHADOW, "light_env's m_Shadows, scene overrides applied").toEqual({
      strength: 0.689,
      type: 1,
    })
    const { group, key } = room()
    const shadows = createRoomShadows(group, key, createEditionState(anniversary, DEFAULT_SETTINGS))
    expect(key.shadow.intensity).toBe(HANGAR_KEY_SHADOW.strength)
    expect(key.shadow.radius, 'hard: PCF radius 1').toBe(1)
    expect(key.shadow.mapSize.x, "the preset's map size").toBe(anniversary.render.shadows.mapSize)
    shadows.dispose()
  })
})
