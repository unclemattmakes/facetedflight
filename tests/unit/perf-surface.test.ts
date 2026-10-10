// tests/unit/perf-surface.test.ts — what `?perf=1` puts on the public page, and
// everything it must not.
//
// DEV-160 / VR-PERF §5.4. `__ff2` is the whole `App` and lives behind
// `import.meta.env.DEV`; this handle SHIPS, to anyone who types eleven
// characters into a query string on ff-10yr.pages.dev. So the tests here are
// not about whether the numbers are right — the other files do that — they are
// about the SHAPE of the thing: an allow-list that cannot grow by accident,
// snapshots that cannot be written through, and no reference to a scene object
// or a renderer anywhere in any of them.
//
// The one that would otherwise be found by a stranger: `census()` draws five
// extra off-screen frames. A console loop calling it every frame turns the
// diagnostic into the thing being diagnosed, so it is guarded to once a frame
// and the guard is asserted here rather than trusted.

import { describe, expect, it, vi } from 'vitest'
import {
  CAPTURE_KEYS,
  createPerfSurface,
  DROPPED,
  IDLE_XR_PROBE,
  nativeFramebufferScale,
  PERF_SURFACE_KEYS,
  type PerfSurfaceDeps,
  refreshXrProbe,
  TRACE_KEYS,
  TRACE_STORAGE_KEY,
  type XrProbeSource,
} from '@/boot/perf-surface'

/**
 * The two poison pills, as CLASS INSTANCES.
 *
 * Instances and not object literals, because that is what the real things are
 * and it is the property the surface actually keys on: a `Mesh` or a
 * `WebGLRenderer` has its own prototype, and a value whose prototype is not
 * `Object.prototype` is not plain data and is never copied out. A literal
 * `{ isObject3D: true }` IS plain data — harmless, unwritable-back — so a
 * fixture made of literals would have proved nothing about the mechanism.
 */
class FakeRenderer {
  isWebGLRenderer = true
  domElement = { width: 1280 }
}
class FakeObject3D {
  isObject3D = true
  position = { x: 1, y: 2, z: 3 }
}

/**
 * A stand-in app. Everything is a plain value EXCEPT the two poison pills —
 * `census()` hands back a row carrying an `Object3D`, and `quality()` an object
 * claiming to be a renderer — because the failure this guards against is a
 * getter that forwards a live reference, and a snapshot made of nothing but
 * numbers cannot demonstrate that it does not.
 */
const fakeDeps = () => {
  const calls = { census: 0, start: [] as number[], stop: 0, toggle: 0 }
  let frame = 0
  const deps: PerfSurfaceDeps = {
    version: () => ({ version: 'dev+test', mode: 'test' }),
    edition: () => ({ id: 'anniversary', speedFx: 1 }),
    mission: () => ({ id: 'int_01_hoverJet', mode: 'ringAttack' }),
    settings: () => ({ quality: 'high', foveation: true, adaptiveResolution: true }),
    stats: () =>
      ({
        frames: 268,
        seconds: 3,
        fps: 89.3,
        meanMs: 11.2,
        p50Ms: 10.9,
        p95Ms: 12.4,
        maxMs: 31,
        hitches: 2,
        hitchFraction: 0.0075,
        engagedFrames: 0,
        engagedFraction: 0,
        targetMs: 11.1,
      }) as ReturnType<PerfSurfaceDeps['stats']>,
    budget: () => ({
      ms: 11.1,
      hz: 90,
      source: 'measured',
      // DEV-161: the worn shape, a 90 Hz display with the app in SteamVR's
      // half-rate tier. Chosen over 90/90 on purpose — a fixture where the two
      // are equal cannot tell the two fields apart.
      displayHz: 90,
      tierHz: 45,
      // DEV-179: this window really did contain a 90, so the rate in force is
      // not being held over from an earlier one.
      sticky: false,
      dropping: 0.6,
      modal: { hz: 45, share: 0.6, frames: 260 },
    }),
    quality: () =>
      ({
        quality: 'high',
        framebufferScale: 1,
        pixelRatio: null,
        foveation: 1,
        scale: 1,
        engaged: 0,
        frameSeconds: 0.011,
        targetSeconds: 1 / 90,
        targetSource: 'measured',
        frames: 500,
        engagedFrames: 0,
        // The poison pill. Not a field the real report has — it is here to prove
        // the WALK finds one wherever it is put.
        renderer: new FakeRenderer(),
      }) as unknown as ReturnType<PerfSurfaceDeps['quality']>,
    gpu: () => ({
      supported: true,
      enabled: true,
      frames: 240,
      medianMs: 7.8,
      p95Ms: 9.9,
      maxMs: 14,
      last: 7.9,
      harvested: 1024,
    }),
    info: () => ({
      frame: 500,
      calls: 540,
      triangles: 5_900_000,
      points: 0,
      lines: 0,
      programs: 41,
      geometries: 812,
      textures: 33,
    }),
    sim: () => ({ tick: 4100, elapsed: 50.02, ticksPerSecond: 81.967, snapped: false }),
    session: () => IDLE_XR_PROBE,
    census: () => {
      calls.census += 1
      return {
        calls: 270,
        triangles: 2_960_000,
        programs: 41,
        geometries: 812,
        textures: 33,
        rows: [
          {
            group: 'world-terrain',
            calls: 196,
            triangles: 1_830_000,
            transparentCalls: 0,
            // The second poison pill, one level deeper and inside an array.
            object: new FakeObject3D(),
          },
        ],
        overdraw: { issued: 1.9, issuedOpaque: 1.5, shaded: 1.53, shadedOpaque: 1.4, max: 12 },
      } as unknown as ReturnType<PerfSurfaceDeps['census']>
    },
    frameIndex: () => frame,
    trace: {
      start: (s) => calls.start.push(s),
      stop: () => {
        calls.stop += 1
      },
      status: () => 'idle',
      frames: () => 0,
      summary: () =>
        ({ status: 'idle', frames: 0, worst: [] }) as unknown as ReturnType<
          PerfSurfaceDeps['trace']['summary']
        >,
      dump: () => 'header\ncols\nrow',
    },
    // A capture that holds one run, with a POISON PILL in it for the same
    // reason `census()` has one: `payload()` must hand back plain data, and a
    // payload made of nothing but strings cannot show that it does.
    errors: () => ({ count: 0, last: '' }),
    // DEV-537: a page in a room racing one other ship.
    room: () => ({
      inRoom: true,
      status: 'open',
      phase: 'racing',
      slot: 0,
      synced: true,
      rttMs: 42.5,
      offsetMs: -3.1,
      ships: [
        {
          slot: 1,
          handle: 'Swift Kestrel 42',
          mode: 'interp',
          stale: false,
          delayMs: 118,
          renderTick: 2010.4,
          newestTick: 2022,
        },
      ],
    }),
    capture: {
      recording: () => true,
      runs: () => 1,
      missions: () => ['int_01_hoverJet'],
      toggle: () => {
        calls.toggle++
      },
      payload: () => ({
        kind: 'ff2-perf-capture',
        version: 1,
        runs: [{ index: 1, mission: 'int_01_hoverJet', csv: 'dt_ms', live: new FakeObject3D() }],
      }),
      digest: () => ({ kind: 'ff2-perf-capture-digest', version: 1, runs: [] }),
    },
  }
  return { deps, calls, nextFrame: () => (frame += 1) }
}

const memoryStorage = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
  }
}

/** Every value reachable from `value`, snapshots and arrays included. */
const walk = (value: unknown, seen: unknown[] = []): unknown[] => {
  if (value === null || typeof value !== 'object') return seen
  seen.push(value)
  for (const v of Object.values(value as Record<string, unknown>)) walk(v, seen)
  return seen
}

const surface = () => {
  const { deps, calls, nextFrame } = fakeDeps()
  return { s: createPerfSurface(deps, { storage: memoryStorage() }), calls, nextFrame }
}

describe('the __ff2perf allow-list', () => {
  it('has exactly the keys it declares, and no others', () => {
    // Asserted against the exported list rather than against a copy of it: a
    // copy is the thing that goes stale, and the failure mode would be a key
    // shipping that nobody reviewed.
    const { s } = surface()
    expect(Object.keys(s).sort()).toEqual([...PERF_SURFACE_KEYS].sort())
  })

  it("reads a room's clock and each other ship's track, as plain numbers (DEV-537)", () => {
    const { s } = surface()
    const r = s.room() as { rttMs: number; ships: { delayMs: number; mode: string }[] }
    expect(r.rttMs).toBe(42.5)
    expect(r.ships.map((x) => [x.mode, x.delayMs])).toEqual([['interp', 118]])
  })

  it('its trace sub-object has exactly its own eight keys', () => {
    const { s } = surface()
    expect(Object.keys(s.trace).sort()).toEqual([...TRACE_KEYS].sort())
    expect(Object.keys(s.capture).sort()).toEqual([...CAPTURE_KEYS].sort())
  })

  it('exposes nothing that writes to the GAME', () => {
    // Named explicitly, because "we did not add it" is not a test. These are the
    // handles `__ff2` has that would change what is drawn, simulated or stored.
    const s = surface().s as unknown as Record<string, unknown>
    for (const forbidden of [
      'render',
      'renderer',
      'scene',
      'camera',
      'rig',
      'flight',
      'racers',
      'traffic',
      'edition', // the STATE object with `.set` — `edition()` the getter is fine
      'stage',
      'snap',
      'hangarAim',
      'start',
      'stop',
      'reveal',
      'perf',
      'world',
      'touch',
      'capabilities',
    ]) {
      if (forbidden === 'edition') {
        // `edition` IS a key — as a function returning a frozen snapshot, never
        // the `EditionState` object whose `.set` swaps the preset mid-run.
        expect(typeof s.edition).toBe('function')
        continue
      }
      expect(s[forbidden], forbidden).toBeUndefined()
    }
  })

  it('is frozen, and so is everything it hands back', () => {
    const { s } = surface()
    expect(Object.isFrozen(s)).toBe(true)
    expect(Object.isFrozen(s.trace)).toBe(true)
    for (const key of PERF_SURFACE_KEYS) {
      // `trace` and `capture` are objects of getters, not getters.
      if (key === 'trace' || key === 'capture') continue
      const value = (s as unknown as Record<string, () => unknown>)[key]?.()
      expect(typeof value === 'object' && value !== null, key).toBe(true)
      for (const node of walk(value)) expect(Object.isFrozen(node), key).toBe(true)
    }
  })

  it('every value on it is a function or a frozen plain object', () => {
    const { s } = surface()
    for (const [key, value] of Object.entries(s)) {
      const ok = typeof value === 'function' || (typeof value === 'object' && value !== null)
      expect(ok, key).toBe(true)
      if (typeof value === 'object') expect(Object.isFrozen(value), key).toBe(true)
    }
  })

  it('never hands out an Object3D or a renderer, however deep it is buried', () => {
    // The walk is the test. Both poison pills in the fixture are inside a
    // snapshot the surface forwards — one nested in an array — and a surface
    // that passed the live object through would fail here and only here.
    const { s } = surface()
    for (const key of PERF_SURFACE_KEYS) {
      // `trace` and `capture` are objects of getters, not getters.
      if (key === 'trace' || key === 'capture') continue
      const value = (s as unknown as Record<string, () => unknown>)[key]?.()
      for (const node of walk(value)) {
        const record = node as Record<string, unknown>
        expect(record.isObject3D, `${key}.isObject3D`).toBeUndefined()
        expect(record.isWebGLRenderer, `${key}.isWebGLRenderer`).toBeUndefined()
        expect(record.isMesh, `${key}.isMesh`).toBeUndefined()
        expect(record.isMaterial, `${key}.isMaterial`).toBeUndefined()
        // Nothing that came back is an instance of anything: every object is a
        // plain one this file built. That is the property, and the `is*` checks
        // above are the named symptoms of breaking it.
        const proto = Object.getPrototypeOf(node)
        expect(proto === Object.prototype || proto === Array.prototype, key).toBe(true)
      }
    }
  })
})

describe('the census guard', () => {
  it('runs once per frame however often it is called', () => {
    // `renderCensus` draws five extra off-screen frames and stalls the one it is
    // called on. A console loop, or a plate row, calling it per frame would be
    // the cost it exists to explain.
    const { s, calls, nextFrame } = surface()
    s.census()
    s.census()
    s.census()
    expect(calls.census).toBe(1)
    nextFrame()
    s.census()
    expect(calls.census).toBe(2)
  })

  it('returns the SAME answer to a repeat call, not a stale-looking new one', () => {
    const { s } = surface()
    expect(s.census()).toBe(s.census())
  })
})

describe('the trace handle', () => {
  it('starts and stops the recorder, and nothing else', () => {
    const { deps, calls } = fakeDeps()
    const s = createPerfSurface(deps, { storage: memoryStorage() })
    s.trace.start(20)
    s.trace.stop()
    expect(calls.start).toEqual([20])
    expect(calls.stop).toBe(1)
  })

  it('reads the stored trace back, and null when there is none', () => {
    const { deps } = fakeDeps()
    const empty = createPerfSurface(deps, { storage: memoryStorage() })
    expect(empty.trace.last()).toBeNull()

    const stored = createPerfSurface(deps, {
      storage: memoryStorage({ [TRACE_STORAGE_KEY]: 'header\ncols\nrow' }),
    })
    expect(stored.trace.last()).toBe('header\ncols\nrow')
  })

  it('survives storage that throws, and a download with nothing to save', () => {
    // A private window, a webview with site data off, a quota. Reading the
    // property is what throws, so the guard has to be round the access — the
    // lesson `game/personal-best.ts` already paid for.
    const { deps } = fakeDeps()
    const hostile = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const s = createPerfSurface(deps, { storage: hostile })
    expect(s.trace.last()).toBeNull()
    expect(s.trace.download()).toBe(false)

    const none = createPerfSurface(deps, { storage: null })
    expect(none.trace.last()).toBeNull()
    expect(none.trace.download()).toBe(false)
  })
})

describe('the XR probe', () => {
  const source = (over: Partial<Record<string, unknown>> = {}): XrProbeSource =>
    ({
      isPresenting: true,
      getSession: () => ({
        frameRate: 90,
        supportedFrameRates: [72, 90, 120],
        enabledFeatures: ['local', 'layers'],
      }),
      getFrame: () => ({
        getViewerPose: () => ({
          views: [
            { recommendedViewportScale: 0.9, requestViewportScale: () => {} },
            { recommendedViewportScale: null, requestViewportScale: () => {} },
          ],
        }),
      }),
      getReferenceSpace: () => ({}),
      getBaseLayer: () => {
        class XRWebGLLayer {
          framebufferWidth = 2016
          framebufferHeight = 2016
        }
        return new XRWebGLLayer()
      },
      ...over,
    }) as unknown as XrProbeSource

  it('is the idle probe out of session', () => {
    expect(refreshXrProbe(source({ isPresenting: false }))).toBe(IDLE_XR_PROBE)
  })

  it('reads the layer by CONSTRUCTOR NAME, the rates, the features and the views', () => {
    const p = refreshXrProbe(source())
    expect(p.presenting).toBe(true)
    // Spike 0's answer lives in this one string: `XRWebGLLayer` means three took
    // the legacy path, `XRProjectionLayer` means it took the layers one.
    expect(p.layer).toBe('XRWebGLLayer')
    expect(p.frameRate).toBe(90)
    expect(p.supportedFrameRates).toEqual([72, 90, 120])
    expect(p.enabledFeatures).toEqual(['local', 'layers'])
    expect(p.framebuffer).toEqual({ w: 2016, h: 2016 })
    expect(p.views).toHaveLength(2)
    expect(p.views[0]?.recommendedViewportScale).toBe(0.9)
    expect(p.views[0]?.requestViewportScale).toBe(true)
    expect(p.views[1]?.recommendedViewportScale).toBeNull()
  })

  it('asks the VIEW whether it can scale, and never the layer — DEV-236', () => {
    // The probe has read `views[n].requestViewportScale` since before anything
    // called it, and it was right the whole time. What was wrong was
    // `render/quality.ts`, which called the method on
    // `renderer.xr.getBaseLayer()`, and `perf-format.ts`'s prose, which said
    // the layer was where it lived. So this row is the NEGATIVE CONTROL the
    // probe never had: a layer that carries the method and views that do not.
    //
    // No real `XRProjectionLayer` or `XRWebGLLayer` has one — which is exactly
    // why DEV-208's call was a silent early return rather than a TypeError —
    // so the layer double here exists only so that a probe reading the wrong
    // object would report `true` and fail.
    const p = refreshXrProbe(
      source({
        getBaseLayer: () => {
          class XRProjectionLayer {
            textureWidth = 2016
            textureHeight = 2016
            // The whole point of the double.
            requestViewportScale(_s: number) {}
            recommendedViewportScale = 0.5
          }
          return new XRProjectionLayer()
        },
        getFrame: () => ({
          getViewerPose: () => ({
            views: [{ recommendedViewportScale: null }, { recommendedViewportScale: null }],
          }),
        }),
      }),
    )
    expect(p.layer, 'the layer really is the one carrying the method').toBe('XRProjectionLayer')
    expect(p.views[0]?.requestViewportScale, 'this view cannot scale').toBe(false)
    expect(p.views[1]?.requestViewportScale).toBe(false)
    expect(p.views[0]?.recommendedViewportScale, "and the layer's hint is not a view's").toBeNull()
  })

  it('reads a PROJECTION layer-s size, which is not the field it used to read', () => {
    // The worn bug (DEV-160 §4, fixed in DEV-178's branch): three built an
    // `XRProjectionLayer` on this rig and the probe read
    // `framebufferWidth/Height`, which that layer does not have. The XR row
    // said `0 x 0` for the whole session — and the session turned out to be
    // ABOUT its resolution.
    //
    // 3522 x 1761 is the number that was actually on the headset.
    const p = refreshXrProbe(
      source({
        getBaseLayer: () => {
          class XRProjectionLayer {
            textureWidth = 3522
            textureHeight = 1761
            fixedFoveation = 1
          }
          return new XRProjectionLayer()
        },
      }),
    )
    expect(p.layer).toBe('XRProjectionLayer')
    expect(p.framebuffer).toEqual({ w: 3522, h: 1761 })
  })

  it('still reads an XRWebGLLayer-s size — both names are live', () => {
    // The fallback is not legacy politeness: three picks the layer class from a
    // prototype test at session start, so which pair exists is a property of
    // the BROWSER, and a probe that only knew the new names would go blind on
    // any runtime without `createProjectionLayer`.
    expect(refreshXrProbe(source()).framebuffer).toEqual({ w: 2016, h: 2016 })
  })

  it('reports the NATIVE scale, which is the denominator for the size', () => {
    // 1761 per eye means nothing on its own. 1761 per eye with a native scale
    // of 1 means we asked for 0.6 of what the runtime recommended, which is
    // the whole finding. The static lives on `XRWebGLLayer` even when a
    // projection layer is in use.
    expect(nativeFramebufferScale({})).toBeNull()
    vi.stubGlobal('XRWebGLLayer', { getNativeFramebufferScaleFactor: () => 1 })
    try {
      expect(nativeFramebufferScale({})).toBe(1)
      expect(refreshXrProbe(source()).nativeScale).toBe(1)
      // No session, nothing to ask about.
      expect(nativeFramebufferScale(null)).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not take the frame loop down when the runtime throws on the scale', () => {
    vi.stubGlobal('XRWebGLLayer', {
      getNativeFramebufferScaleFactor: () => {
        throw new Error('InvalidStateError')
      },
    })
    try {
      expect(nativeFramebufferScale({})).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports whether the LIVE layer has fixedFoveation at all, not just its value', () => {
    // The finding this pair exists for: `'fixedFoveation' in
    // XRWebGLLayer.prototype` is FALSE on this desktop's Chromium, so
    // `renderer.xr.setFoveation()` writes a value nothing reads and the only
    // live knob the adaptive controller has does nothing. A probe that reported
    // only the VALUE would say `null` and leave "off" and "not there" looking
    // identical — which is exactly how the layer-23 light bug hid (DEV-043).
    const absent = refreshXrProbe(source())
    expect(absent.hasFixedFoveation).toBe(false)
    expect(absent.fixedFoveation).toBeNull()

    const present = refreshXrProbe(
      source({
        getBaseLayer: () => {
          // `textureWidth/Height`, not `framebufferWidth/Height`: this fake
          // used to carry the latter, which no real projection layer has, and
          // that fiction is exactly why the worn XR row read 0 x 0.
          class XRProjectionLayer {
            fixedFoveation = 0
            textureWidth = 2160
            textureHeight = 2160
          }
          return new XRProjectionLayer()
        },
      }),
    )
    expect(present.layer).toBe('XRProjectionLayer')
    expect(present.hasFixedFoveation).toBe(true)
    expect(present.fixedFoveation).toBe(0)
  })

  it('falls back to idle rather than throwing when a view read fails', () => {
    // `XRView` reads throw `InvalidStateError` outside their own frame, and
    // tracking loss makes `getViewerPose` return null. Neither may take the
    // frame loop down — the probe is called from inside it.
    const throwing = refreshXrProbe(
      source({
        getFrame: () => ({
          getViewerPose: () => {
            throw new Error('InvalidStateError')
          },
        }),
      }),
    )
    expect(throwing).toBe(IDLE_XR_PROBE)

    const noPose = refreshXrProbe(source({ getFrame: () => ({ getViewerPose: () => null }) }))
    expect(noPose.presenting).toBe(true)
    expect(noPose.views).toEqual([])
  })

  it('is frozen all the way down', () => {
    const p = refreshXrProbe(source())
    for (const node of walk(p)) expect(Object.isFrozen(node)).toBe(true)
  })
})

describe('the capture surface hands out plain data', () => {
  it('snapshots the payload rather than forwarding the live object', () => {
    // Same failure this whole file exists for: a getter that returns a live
    // reference turns a read-only handle into a way to reach into the running
    // game. The payload carries CSVs a reader wants, so it is the one most
    // likely to be forwarded whole for the sake of not copying half a megabyte.
    const { deps } = fakeDeps()
    const s = createPerfSurface(deps, { storage: null })
    const payload = s.capture.payload() as { runs: { live: unknown }[] }
    expect(payload.runs[0]?.live).toBe(DROPPED)
  })

  it('freezes capture in its own right, because freezing the surface is shallow', () => {
    const { deps } = fakeDeps()
    const s = createPerfSurface(deps, { storage: null })
    expect(Object.isFrozen(s.capture)).toBe(true)
  })

  it('forwards toggle to the app rather than doing anything itself', () => {
    const { deps, calls } = fakeDeps()
    const s = createPerfSurface(deps, { storage: null })
    s.capture.toggle()
    s.capture.toggle()
    expect(calls.toggle).toBe(2)
  })
})
