// tests/unit/unity-fog-instancing.test.ts — the fog measures an INSTANCE where
// it stands, not where its mesh's origin is (DEV-096).
//
// The fog's vertex patch lands at `#include <begin_vertex>`, where three's
// `transformed` is still in the mesh's own frame: `instanceMatrix` is applied
// later, inside `project_vertex`. A world position taken there as
// `modelMatrix * transformed` is right for a plain mesh and wrong for every
// `InstancedMesh` — the palms (`game/props/load-props.ts`) and the scattered
// props (`render/dressing.ts`) — which were all fogged from the terrain group's
// origin, the map's corner, kilometres from where they stand. On Classic that
// was a palm beside the ship wearing a distant palm's fog; under the
// Anniversary haze (DEV-082) it was every palm pale grey.
//
// A text pin, knowingly: the shader cannot run here. What it pins is the
// STRUCTURE — the fold sits under three's own `USE_INSTANCING` guard and before
// `project_vertex` — so a refactor that moves the hook past the projection, or
// drops the guard, fails here rather than in a frame.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { createUnityFog } from '@/render/unity-fog'
import int01 from '../../content/levels/int_01_hoverJet.json'

/** Run a material's `onBeforeCompile` over three's real standard vertex shader. */
const compileVertex = (material: THREE.Material): string => {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  }
  material.onBeforeCompile(
    shader as unknown as THREE.WebGLProgramParametersWithUniforms,
    undefined as unknown as THREE.WebGLRenderer,
  )
  return shader.vertexShader
}

const fog = () =>
  createUnityFog({
    mode: int01.fog.mode,
    density: int01.fog.density,
    linearStart: int01.fog.linearStart,
    linearEnd: int01.fog.linearEnd,
    color: [0.5, 0.4, 0.4],
    distanceFog: true,
    heightFog: true,
    useRadialDistance: true,
    height: int01.fog.height,
    heightDensity: int01.fog.heightDensity,
    startDistance: int01.fog.startDistance,
  })

describe('the fog and instanced meshes (DEV-096)', () => {
  it('folds `instanceMatrix` into the world position under USE_INSTANCING, before three projects the vertex', () => {
    const m = new THREE.MeshStandardMaterial()
    fog().applyTo(m)
    const v = compileVertex(m)

    const guard = v.indexOf('#ifdef USE_INSTANCING')
    const fold = v.indexOf('instanceMatrix * ff2FogLocal')
    const varying = v.indexOf('vUnityFogWorldPos = (modelMatrix * ff2FogLocal).xyz')
    const project = v.indexOf('#include <project_vertex>')

    expect(guard).toBeGreaterThan(-1)
    // Guard, then the fold inside it, then the varying that uses the result.
    expect(fold).toBeGreaterThan(guard)
    expect(varying).toBeGreaterThan(fold)
    // And all of it BEFORE three's own projection, which is where the
    // instance matrix is otherwise applied — after it, `transformed` would
    // still be local and the fold would be doing three's job twice.
    expect(project).toBeGreaterThan(varying)
    // The instance-blind form is gone, not merely joined.
    expect(v).not.toContain('modelMatrix * vec4(transformed, 1.0)')
  })

  it('is applied ONCE per material, so a second applyTo does not redefine the varying', () => {
    const m = new THREE.MeshStandardMaterial()
    const f = fog()
    f.applyTo(m)
    f.applyTo(m)
    const v = compileVertex(m)
    expect(v.split('varying vec3 vUnityFogWorldPos;').length - 1).toBe(1)
  })
})
