// tests/unit/eye-buffer.test.ts: the eye buffer's arithmetic, its pins, and
// the lines of three it stands on. DEV-994, DEV-995, DEV-997.
//
// The pixels are `tests/e2e/eye-buffer.spec.ts`'s. What is here is what the
// spec cannot see coming: three moving one of the five lines
// `render/eye-buffer.ts` depends on (`three` is pinned exact, so a bump that
// moves one goes red HERE, not in a headset), and the pin parsing.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EYE_BUFFER_SHIPPED,
  EYE_SCALE_PIN_RANGE,
  parseEyeBufferPins,
  parseEyeMsaaPin,
  parseEyeScalePin,
} from '@/boot/eye-buffer-pin'
import { clampEyeScale, liveSize, scaleRect } from '@/render/eye-buffer'
import { EYE_SCALE_CEILING, EYE_SCALE_FLOOR, EYE_SCALE_PIN_MIN } from '@/render/eye-scale'

const ROOT = path.join(__dirname, '..', '..')

/** The built module three ships, read inside the `it`. */
const threeBuild = (): string =>
  fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js'), 'utf8')

/** The index of `needle`, failing loudly when three no longer has it. */
const at = (haystack: string, needle: string): number => {
  const i = haystack.indexOf(needle)
  expect(i, `three's build no longer contains: ${needle}`).toBeGreaterThanOrEqual(0)
  return i
}

describe('eye-buffer: the scaled eyes', () => {
  const left = { x: 0, y: 0, z: 1620, w: 1620 }
  const right = { x: 1620, y: 0, z: 1620, w: 1620 }

  it('at 1 an eye is its own rectangle, value for value', () => {
    expect(scaleRect(left, 1)).toEqual(left)
    expect(scaleRect(right, 1)).toEqual(right)
  })

  it('side by side stays side by side at every step', () => {
    for (const s of [0.9, 0.8, 0.7, 0.55]) {
      const l = scaleRect(left, s)
      const r = scaleRect(right, s)
      expect(r.x, `the right eye starts where the left ends at ${s}`).toBe(l.x + l.z)
      expect(r.z, `both eyes the same width at ${s}`).toBe(l.z)
      expect(liveSize([l, r])).toEqual({ width: l.z + r.z, height: l.w })
    }
  })

  it('an odd eye still rounds to whole pixels', () => {
    const r = scaleRect({ x: 1511, y: 0, z: 1511, w: 1513 }, 0.9)
    for (const v of [r.x, r.y, r.z, r.w]) expect(Number.isInteger(v)).toBe(true)
  })

  it('a pinned scale is clamped to what the eye buffer can draw', () => {
    expect(clampEyeScale(2)).toBe(EYE_SCALE_CEILING)
    expect(clampEyeScale(0.1)).toBe(EYE_SCALE_PIN_MIN)
    expect(clampEyeScale(Number.NaN)).toBe(1)
    expect(clampEyeScale(0.8)).toBe(0.8)
    // A pin may look past the controller's floor; the floor is the controller's.
    expect(EYE_SCALE_PIN_MIN).toBeLessThan(EYE_SCALE_FLOOR)
  })
})

describe('eye-buffer: the pins (DEV-997)', () => {
  const pins = (query: string) => {
    const warnings: string[] = []
    const pin = parseEyeBufferPins(new URLSearchParams(query), (m) => warnings.push(m))
    return { pin, warnings }
  }

  it('is off by default and absent installs nothing', () => {
    expect(EYE_BUFFER_SHIPPED).toBe(false)
    expect(pins('').pin).toBeNull()
    expect(pins('eyeBuffer=0').pin).toBeNull()
  })

  it('?eyeBuffer=1 installs the controller at the default samples', () => {
    expect(pins('eyeBuffer=1').pin).toEqual({ scale: null, msaa: null })
    expect(pins('eyeBuffer=on').pin).toEqual({ scale: null, msaa: null })
  })

  it('?eyeScale= and ?eyeMsaa= ride on the switch', () => {
    expect(pins('eyeBuffer=1&eyeScale=0.8&eyeMsaa=2').pin).toEqual({ scale: 0.8, msaa: 2 })
    expect(pins('eyeBuffer=1&eyeScale=0.9').pin).toEqual({ scale: 0.9, msaa: null })
  })

  it('without the switch they warn and install nothing', () => {
    const { pin, warnings } = pins('eyeScale=0.8')
    expect(pin).toBeNull()
    expect(warnings.join(' ')).toContain('need ?eyeBuffer=1')
  })

  it('a bad value warns and falls back rather than silently changing the arm', () => {
    const w: string[] = []
    expect(parseEyeScalePin('0.2', (m) => w.push(m))).toBeNull()
    expect(parseEyeScalePin('1.5', (m) => w.push(m))).toBeNull()
    expect(parseEyeScalePin('x', (m) => w.push(m))).toBeNull()
    expect(parseEyeMsaaPin('3', (m) => w.push(m))).toBeNull()
    expect(w).toHaveLength(4)
    expect(parseEyeScalePin(String(EYE_SCALE_PIN_RANGE.min))).toBe(EYE_SCALE_PIN_RANGE.min)
    expect(parseEyeMsaaPin('0')).toBe(0)
    expect(parseEyeMsaaPin('4')).toBe(4)
  })
})

describe("eye-buffer: the lines of three it stands on (three's build)", () => {
  it('a renderer built with the default output type draws a session straight into the layer', () => {
    // So there is no internal hop to reuse, and the eye buffer adds the only one.
    const build = threeBuild()
    at(build, 'if ( _outputBufferType !== UnsignedByteType ) {')
    const renderer = fs.readFileSync(path.join(ROOT, 'src/render/renderer.ts'), 'utf8')
    expect(renderer.includes('outputBufferType'), 'renderer.ts sets no output type').toBe(false)
  })

  it('an XR-flagged target keys programs on its texture colour space and keeps tone mapping', () => {
    const build = threeBuild()
    at(
      build,
      'outputColorSpace: ( currentRenderTarget === null ) ? renderer.outputColorSpace : ( currentRenderTarget.isXRRenderTarget === true ? currentRenderTarget.texture.colorSpace : ColorManagement.workingColorSpace ),',
    )
    at(
      build,
      'if ( currentRenderTarget === null || currentRenderTarget.isXRRenderTarget === true ) {',
    )
  })

  it("a texture's internalFormat name wins over its colour space (the RGBA8 storage)", () => {
    const build = threeBuild()
    at(build, 'if ( _gl[ internalFormatName ] !== undefined ) return _gl[ internalFormatName ];')
  })

  it("the MSAA resolve blits the target's width and height, so the live corner is all it resolves", () => {
    const build = threeBuild()
    const from = at(build, 'function updateMultisampleRenderTarget( renderTarget ) {')
    const body = build.slice(from, from + 4000)
    at(body, 'const width = renderTarget.width;')
    at(body, 'const height = renderTarget.height;')
    at(body, '_gl.blitFramebuffer( 0, 0, width, height, 0, 0, width, height, mask, _gl.NEAREST );')
  })

  it("three hands its XR target over every frame, before the app's callback", () => {
    const build = threeBuild()
    const textures = at(build, 'renderer.setRenderTargetTextures(')
    const framebuffer = at(
      build,
      'renderer.setRenderTargetFramebuffer( newRenderTarget, glBaseLayer.framebuffer );',
    )
    const callback = at(
      build,
      'if ( onAnimationFrameCallback ) onAnimationFrameCallback( time, frame );',
    )
    expect(textures).toBeLessThan(callback)
    expect(framebuffer).toBeLessThan(callback)
    // And builds the target's buffers lazily, so `samples` set on first sight still counts.
    at(build, '} else if ( renderTargetProperties.__webglFramebuffer === undefined ) {')
  })
})
