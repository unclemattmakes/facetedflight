// tests/unit/bloom-samples.test.ts — the bloom target does not multisample on
// the one browser where three throws the samples away. DEV-330.
//
// three decides by user agent whether to `invalidateFramebuffer` a
// multisampled target's colour after resolving it, and `UnrealBloomPass` then
// composites into that discarded colour: a black frame with only the glow.
// `bloomSamplesFor` echoes three's sniff, so the ORACLE is three's own build,
// read as text. If a three upgrade changes the pattern, this goes red before
// the frame goes black.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLOOM_SAMPLES, bloomSamplesFor, THREE_INVALIDATES_MSAA } from '@/render/bloom'
import { REPO } from './helpers/repo-root'

const three = fs.readFileSync(path.join(REPO, 'node_modules/three/build/three.module.js'), 'utf8')
const iwerHeadsets = fs.readFileSync(
  path.join(REPO, 'node_modules/iwer/lib/device/configs/headset/meta.js'),
  'utf8',
)

describe('bloom samples by user agent (DEV-330)', () => {
  it('uses the same pattern three uses to decide it will invalidate', () => {
    const line =
      /supportsInvalidateFramebuffer\s*=[^\n]*?\/([^/]+)\/g?\.test\(\s*navigator\.userAgent\s*\)/.exec(
        three,
      )
    expect(line, "three's sniff was found in its build").not.toBeNull()
    expect(THREE_INVALIDATES_MSAA.source).toBe(line?.[1])
  })

  it('does not multisample under any of IWER’s emulated Meta headsets', () => {
    const agents = [...iwerHeadsets.matchAll(/userAgent:\s*'([^']+)'/g)].map((m) => m[1] as string)
    expect(agents.length, 'the emulator’s user agents were found').toBeGreaterThan(0)
    for (const ua of agents) expect(bloomSamplesFor(ua), ua).toBe(0)
  })

  it('keeps full MSAA on desktop Chrome, which is how the Steam Frame is driven', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    expect(bloomSamplesFor(chrome)).toBe(BLOOM_SAMPLES)
    expect(BLOOM_SAMPLES).toBeGreaterThan(0)
  })
})
