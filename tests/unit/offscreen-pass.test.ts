import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  createPcfDepthTarget,
  measuredRender,
  type OffscreenColourRenderer,
  withOffscreenTarget,
} from '../../src/render/offscreen-pass'

interface Stub extends OffscreenColourRenderer {
  readonly log: string[]
}

const stub = (): Stub => {
  let target: THREE.WebGLRenderTarget | null = null
  const colour = new THREE.Color(0x336699)
  let alpha = 0.25
  const log: string[] = []
  const self: Stub = {
    log,
    autoClear: true,
    xr: { enabled: true },
    shadowMap: { autoUpdate: true },
    state: { buffers: { depth: { setMask: (m: boolean) => void log.push(`mask:${m}`) } } },
    info: { autoReset: true, render: { calls: 10, triangles: 100 } },
    getRenderTarget: () => target,
    setRenderTarget: (t) => {
      target = t
      log.push(t ? `target:${t.width}` : 'target:prev')
    },
    clear: (c, d, s) => void log.push(`clear:${c},${d},${s}`),
    getClearColor: (out) => out.copy(colour),
    getClearAlpha: () => alpha,
    setClearColor: (c, a = 1) => {
      colour.set(c)
      alpha = a
      log.push(`clearColor:${colour.getHexString()}:${a}`)
    },
    render: () => {
      self.info.render.calls += 7
      self.info.render.triangles += 70
    },
  }
  return self
}

describe('withOffscreenTarget', () => {
  it('switches the renderer for the draw and hands every field back', () => {
    const r = stub()
    const t = new THREE.WebGLRenderTarget(64, 64)
    let seen: Record<string, unknown> = {}
    withOffscreenTarget(r, t, () => {
      seen = {
        xr: r.xr.enabled,
        autoUpdate: r.shadowMap.autoUpdate,
        autoClear: r.autoClear,
        autoReset: r.info.autoReset,
      }
    })
    expect(seen).toEqual({ xr: false, autoUpdate: false, autoClear: false, autoReset: false })
    expect(r.xr.enabled).toBe(true)
    expect(r.shadowMap.autoUpdate).toBe(true)
    expect(r.autoClear).toBe(true)
    expect(r.info.autoReset).toBe(true)
    expect(r.getRenderTarget()).toBeNull()
  })

  it('without a clear option: target, depth mask on, depth-only clear, then the draw', () => {
    const r = stub()
    const t = new THREE.WebGLRenderTarget(64, 64)
    withOffscreenTarget(r, t, () => r.log.push('draw'))
    expect(r.log).toEqual([
      'target:64',
      'mask:true',
      'clear:false,true,false',
      'draw',
      'target:prev',
    ])
  })

  it('with a clear option: colour is cleared too and the renderer clear colour comes back', () => {
    const r = stub()
    const t = new THREE.WebGLRenderTarget(32, 32)
    withOffscreenTarget(r, t, () => r.log.push('draw'), { hex: 0x000000, alpha: 0 })
    expect(r.log).toEqual([
      'target:32',
      'clearColor:000000:0',
      'mask:true',
      'clear:true,true,false',
      'draw',
      'clearColor:336699:0.25',
      'target:prev',
    ])
  })

  it('hands everything back when the draw throws', () => {
    const r = stub()
    const t = new THREE.WebGLRenderTarget(32, 32)
    expect(() =>
      withOffscreenTarget(
        r,
        t,
        () => {
          throw new Error('context lost')
        },
        { hex: 0, alpha: 0 },
      ),
    ).toThrow('context lost')
    expect(r.xr.enabled).toBe(true)
    expect(r.autoClear).toBe(true)
    expect(r.shadowMap.autoUpdate).toBe(true)
    expect(r.info.autoReset).toBe(true)
    expect(r.getRenderTarget()).toBeNull()
    expect(r.getClearAlpha()).toBe(0.25)
  })
})

describe('measuredRender', () => {
  it('reports what the render added to the counters', () => {
    const r = stub()
    const drew = measuredRender(r, new THREE.Scene(), new THREE.PerspectiveCamera())
    expect(drew.calls).toBe(7)
    expect(drew.triangles).toBe(70)
    expect(r.info.render.calls).toBe(17)
  })
})

describe('createPcfDepthTarget', () => {
  it('is three PCF shadow target: a compared, linearly filtered depth texture', () => {
    const t = createPcfDepthTarget(128, 'x.map')
    const d = t.depthTexture as THREE.DepthTexture
    expect([t.width, t.height]).toEqual([128, 128])
    expect(d.type).toBe(THREE.UnsignedIntType)
    expect(d.format).toBe(THREE.DepthFormat)
    expect(d.compareFunction).toBe(THREE.LessEqualCompare)
    expect(d.minFilter).toBe(THREE.LinearFilter)
    expect(d.magFilter).toBe(THREE.LinearFilter)
    expect(d.name).toBe('x.map')
  })
})
