/**
 * The asset resolver. FF2's compiled content is not in git (PORT_PLAN §2.5,
 * D12) so every byte the game loads is addressed through `assetUrl()`. The
 * behaviour that matters most here is the *failure*: an unset
 * `VITE_ASSET_BASE_URL` must throw a message a human can act on, because the
 * alternative — king-tide's silent fallback to a `public/` tree that a fresh
 * clone does not have — is a black screen with a console full of 404s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ASSET_BASE_URL_ENV,
  assetBaseUrl,
  assetBaseUrlOrNull,
  assetUrl,
  hasAssetBaseUrl,
  isLocalAssetBase,
  joinAssetUrl,
  MissingAssetBaseUrlError,
} from '@/content/asset-url'

/** Set (or clear, with `undefined`) the env var the resolver reads. */
function setBase(value: string | undefined): void {
  vi.stubEnv(ASSET_BASE_URL_ENV, value)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('joinAssetUrl', () => {
  it('joins a base without a trailing slash', () => {
    expect(joinAssetUrl('https://content.ff2.dev', 'assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
  })

  it('joins a base with a trailing slash without doubling it', () => {
    expect(joinAssetUrl('https://content.ff2.dev/', 'assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
    expect(joinAssetUrl('https://content.ff2.dev///', 'assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
  })

  it('accepts a leading slash on the path', () => {
    expect(joinAssetUrl('https://content.ff2.dev', '/assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
  })

  it('collapses a doubled leading slash instead of reading it as protocol-relative', () => {
    // `//assets/x` against the page origin would 404 and look like a bucket
    // fault. FF2 never emits a protocol-relative URL, so this is a join
    // artefact and is treated as a content path.
    expect(joinAssetUrl('https://content.ff2.dev/', '//assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
  })

  it('keeps a base that carries a path prefix', () => {
    expect(joinAssetUrl('https://cdn.example/ff2/v3/', '/assets/a.glb')).toBe(
      'https://cdn.example/ff2/v3/assets/a.glb',
    )
  })

  it('returns an app-absolute path in local mode', () => {
    expect(joinAssetUrl('/', 'assets/a.glb')).toBe('/assets/a.glb')
    expect(joinAssetUrl('/', '/assets/a.glb')).toBe('/assets/a.glb')
  })

  it('passes absolute URLs through unchanged', () => {
    const https = 'https://other.example/x.glb'
    expect(joinAssetUrl('https://content.ff2.dev', https)).toBe(https)
    expect(joinAssetUrl('https://content.ff2.dev', 'http://legacy.example/x.glb')).toBe(
      'http://legacy.example/x.glb',
    )
    expect(joinAssetUrl('https://content.ff2.dev', 'blob:https://app/1-2-3')).toBe(
      'blob:https://app/1-2-3',
    )
    expect(joinAssetUrl('https://content.ff2.dev', 'data:model/gltf-binary;base64,AAA')).toBe(
      'data:model/gltf-binary;base64,AAA',
    )
  })

  it('throws on a blank base rather than emitting a relative URL', () => {
    expect(() => joinAssetUrl('', 'assets/a.glb')).toThrow(MissingAssetBaseUrlError)
    expect(() => joinAssetUrl('   ', 'assets/a.glb')).toThrow(MissingAssetBaseUrlError)
  })
})

describe('assetUrl', () => {
  it('resolves against the configured base', () => {
    setBase('https://content.ff2.dev')
    expect(assetUrl('assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
  })

  it('tolerates a trailing slash in the environment', () => {
    setBase('https://content.ff2.dev/')
    expect(assetUrl('/assets/ships/hoverjet.glb')).toBe(
      'https://content.ff2.dev/assets/ships/hoverjet.glb',
    )
  })

  it('serves from public/ when the base is explicitly local', () => {
    setBase('/')
    expect(isLocalAssetBase()).toBe(true)
    expect(assetUrl('assets/ships/hoverjet.glb')).toBe('/assets/ships/hoverjet.glb')
  })

  it('throws a message naming the variable and .env.example when unset', () => {
    setBase(undefined)
    expect(hasAssetBaseUrl()).toBe(false)
    expect(assetBaseUrlOrNull()).toBeNull()
    expect(() => assetUrl('assets/ships/hoverjet.glb')).toThrow(MissingAssetBaseUrlError)
    expect(() => assetBaseUrl()).toThrow(/VITE_ASSET_BASE_URL/)
    expect(() => assetBaseUrl()).toThrow(/\.env\.example/)
    expect(() => assetBaseUrl()).toThrow(/docs\/asset-storage\.md/)
  })

  it('treats a blank or whitespace value as unset', () => {
    setBase('')
    expect(hasAssetBaseUrl()).toBe(false)
    expect(() => assetUrl('assets/a.glb')).toThrow(MissingAssetBaseUrlError)
    setBase('   ')
    expect(hasAssetBaseUrl()).toBe(false)
    expect(() => assetUrl('assets/a.glb')).toThrow(MissingAssetBaseUrlError)
  })

  it('passes an absolute URL through even with no base configured', () => {
    setBase(undefined)
    expect(assetUrl('https://content.ff2.dev/assets/a.glb')).toBe(
      'https://content.ff2.dev/assets/a.glb',
    )
  })
})
