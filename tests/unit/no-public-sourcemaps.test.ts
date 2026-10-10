// tests/unit/no-public-sourcemaps.test.ts — a deployed build carries no source maps.
//
// `vite.config.ts` said `sourcemap: 'hidden'`, meaning "no sourceMappingURL
// comment", and the comment beside it claimed that kept the source private.
// The .map files were still emitted, uploaded and served: the live site
// answered 200 for them (2026-09-26). Matt: "fix the source maps". The config
// is read here as the build reads it, not as text.

import { afterEach, describe, expect, it, vi } from 'vitest'

describe('the deployed build has no source maps', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('emits none by default', async () => {
    vi.stubEnv('SOURCEMAP', '')
    const config = (await import('../../vite.config')).default as {
      build?: { sourcemap?: unknown }
    }
    expect(config.build?.sourcemap).toBe(false)
  })

  it('emits them only when SOURCEMAP=1 asks, for local debugging', async () => {
    vi.stubEnv('SOURCEMAP', '1')
    const config = (await import('../../vite.config')).default as {
      build?: { sourcemap?: unknown }
    }
    expect(config.build?.sourcemap).toBe(true)
  })
})
