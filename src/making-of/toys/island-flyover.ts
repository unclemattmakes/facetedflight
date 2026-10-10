// The island fly-over: the prologue's first demo. A 3D toy that loads in a
// moment, because it downloads nothing.
//
// A seeded 4 km island, built chunk by chunk by the game's own terrain
// generator (`generateChunk`, at the game's LOD 1) and drawn with the game's
// terrain material, lit by `int_01_hoverJet`'s own sun, sky and fog through
// the same functions `boot/app.ts` calls (`createSun`, `applyLighting`,
// `applySky`, `missionFog`; DEV-509 made them importable). The only thing the
// toy supplies is the island's COLOUR: the game paints a seeded island from a
// donor island's colour map, which is an asset, so this one uses a plain
// height ramp, and the caption says so.

import * as THREE from 'three'
import { applyLighting, applySky, createSun, missionFog } from '@/boot/app/lighting'
import type { Level } from '@/content/level-schema'
import { validateLevel } from '@/content/level-schema'
import { CAMERA_FAR, CAMERA_NEAR } from '@/render/renderer'
import { chunkGeometry, terrainMaterial } from '@/render/terrain-mesh'
import { generateChunk } from '@/sim/terrain/faceted'
import type { MapSampler, Rgb } from '@/sim/terrain/image-sampler'
import raw from '../../../content/levels/int_01_hoverJet.json'
import { loadSimonetTerrain, makeWholeIsland } from '../shared/island-ground'
import type { ToyDef } from '../shared/toy-host'

/** The game's LOD 1: every second vertex of the grid. */
const LOD = 1

/** Height (0..1 of the summit) to colour. The toy's own; see the header. */
const rampAt = (g: number, out: Rgb): void => {
  const set = (r: number, gg: number, b: number) => {
    out.r = r
    out.g = gg
    out.b = b
  }
  if (g < 0.004) set(0.06, 0.2, 0.32)
  else if (g < 0.04) set(0.72, 0.64, 0.45)
  else if (g < 0.35) set(0.3 + g * 0.3, 0.46 - g * 0.1, 0.2)
  else if (g < 0.7) set(0.46, 0.42, 0.36)
  else set(0.62, 0.6, 0.58)
}

export const toy: ToyDef = {
  id: 'island-flyover',
  title: 'Island fly-over',
  caption:
    'A seeded island built by the game’s terrain generator, under int_01’s own sun, sky and fog. The colours are a simple height ramp; the game paints its islands from a colour map.',
  kind: '3d',
  async mount({ stage, controls, reducedMotion }) {
    const level: Level = validateLevel(raw as unknown as Level)
    const shipped = await loadSimonetTerrain()
    const out = controls.readouts()

    const canvas = document.createElement('canvas')
    stage.append(canvas)
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(60, 1, CAMERA_NEAR, CAMERA_FAR)

    // The game's sun, sky and fog, from the mission's own data.
    const sun = createSun(scene)
    applyLighting(scene, level, sun, 'shipped')
    const sky = applySky(renderer, scene, level, false)
    const fog = missionFog(level.fog, level, { fogEnabled: true, fogTakesSkyColour: true })

    const material = terrainMaterial({ tint: null, shader: null })
    fog.applyTo(material)
    const terrain = new THREE.Group()
    scene.add(terrain)

    let seed = 11
    let orbiting = !reducedMotion
    let angle = 0.6
    let triangles = 0
    let buildMs = 0
    const centre = new THREE.Vector3()

    const build = () => {
      const t0 = performance.now()
      for (const child of [...terrain.children]) {
        terrain.remove(child)
        ;(child as THREE.Mesh).geometry.dispose()
      }
      const island = makeWholeIsland(seed, 0.6, shipped.baseResolution, shipped.randomOffset)
      const colour: MapSampler = {
        width: island.heightMap.width,
        height: island.heightMap.height,
        sample: (u, v, rgb) => {
          island.heightMap.sample(u, v, rgb)
          rampAt(rgb.r, rgb)
        },
      }
      triangles = 0
      const box = new THREE.Box3()
      for (let cx = 0; cx < island.chunksPerSide; cx++) {
        for (let cy = 0; cy < island.chunksPerSide; cy++) {
          const chunk = generateChunk(
            island.grid,
            colour,
            island.heightMap,
            island.params,
            cx,
            cy,
            LOD,
          )
          const geometry = chunkGeometry(chunk)
          triangles += chunk.triangleCount
          const mesh = new THREE.Mesh(geometry, material)
          terrain.add(mesh)
          geometry.computeBoundingBox()
          if (geometry.boundingBox) box.union(geometry.boundingBox)
        }
      }
      box.getCenter(centre)
      buildMs = performance.now() - t0
    }

    const place = () => {
      const r = 2600
      camera.position.set(centre.x + Math.cos(angle) * r, 520, centre.z + Math.sin(angle) * r)
      camera.lookAt(centre.x, 40, centre.z)
    }

    const draw = () => {
      place()
      camera.updateMatrixWorld()
      sky.follow(camera.position)
      fog.update(camera)
      renderer.render(scene, camera)
    }

    const readouts = () =>
      out.update([
        { label: 'triangles', value: triangles.toLocaleString('en-US') },
        { label: 'built in', value: `${buildMs.toFixed(0)} ms` },
        { label: 'downloads', value: 'none' },
      ])

    controls.button('new island', () => {
      seed += 1
      build()
      readouts()
      draw()
    })
    controls.toggle({
      label: 'orbit',
      value: orbiting,
      onChange: (v) => {
        orbiting = v
      },
    })

    build()
    readouts()
    const resize = (w: number, h: number) => {
      renderer.setSize(Math.max(1, w), Math.max(1, h), false)
      camera.aspect = Math.max(1, w) / Math.max(1, h)
      camera.updateProjectionMatrix()
      draw()
    }
    const r0 = stage.getBoundingClientRect()
    resize(r0.width, r0.height)

    return {
      frame(dt) {
        if (orbiting) angle += dt * 0.05
        draw()
      },
      resize,
      dispose: () => {
        for (const child of terrain.children) (child as THREE.Mesh).geometry.dispose()
        material.dispose()
        sky.dispose()
        renderer.dispose()
        renderer.forceContextLoss()
        canvas.remove()
      },
    }
  },
}
