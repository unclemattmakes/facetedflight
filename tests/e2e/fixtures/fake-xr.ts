/**
 * tests/e2e/fixtures/fake-xr.ts
 *
 * A WebXR **test double**. It is NOT a WebXR implementation and must never be
 * mistaken for one.
 *
 * What it is for: proving, in headless/headed Chromium with no headset and no
 * OpenXR runtime, that FF2's XR *entry path* runs — the capability query, the
 * user-gesture `requestSession`, three.js's `renderer.xr.setSession()` handoff
 * (layer creation, reference space, render state), and the XR frame loop
 * calling back into the app. Those are the things that break silently when
 * someone refactors boot, and they are exactly the things you cannot see from
 * a unit test.
 *
 * What it is NOT for: anything about *how it feels or performs*. It reports a
 * fixed 1024×1024 framebuffer, an identity head pose, a 6.4 cm IPD and a
 * perfect frame every rAF. It cannot tell you about comfort, reprojection,
 * frame timing, foveation, controller ergonomics, or whether the cockpit
 * clips at near 0.08. Only a headset can. See docs/vr-testing.md.
 *
 * Why hand-rolled: `iwer` (Meta's MIT-licensed Immersive Web Emulation
 * Runtime, the engine inside the Immersive Web Emulator extension) does this
 * far better and should replace this file the moment a devDependency can be
 * added — see docs/vr-testing.md §"Replacing the test double". This builder
 * was not permitted to touch package.json or the pnpm lockfile, so this is a
 * ~200-line stub with a deliberately small surface: exactly the members
 * three.js r185's `WebXRManager` and FF2's own boot code touch, and no more.
 *
 * Every function here is serialised by Playwright's `addInitScript` and
 * evaluated in the page **before any app script runs**. That means each
 * exported function must be entirely self-contained: no imports, no
 * module-scope constants, no closure over anything outside itself. If you
 * factor a helper out to module scope, the page throws `ReferenceError`.
 */

/** Options for {@link installFakeXr}. Must stay JSON-serialisable. */
export interface FakeXrOptions {
  /** What `isSessionSupported('immersive-vr')` resolves to. Default `true`. */
  supported?: boolean
  /**
   * Make `isSessionSupported` *reject* rather than resolve false. This is the
   * shape of crbug 40727637 (Chrome + SteamVR, runtime not running), which
   * research doc 09 §3.2 calls out as a case the entry UI must survive.
   */
  rejectQuery?: boolean
  /** Number of views the fake viewer pose reports. Default 2 (stereo). */
  views?: number
  /**
   * Give the fake session one input source with four axes, so code that asks
   * "does this headset have sticks to fly with?" (`hasFlightSticks`) sees a
   * thumbstick. Default `false` — i.e. the Apple Vision Pro shape.
   */
  sticks?: boolean
}

/**
 * The recorder the double leaves on `window.__ff2FakeXr`. Specs assert against
 * this rather than reaching into the app, so the app needs no test hooks.
 */
export interface FakeXrRecord {
  /** Ordered log of every double method the page called. */
  calls: string[]
  /** How many sessions were requested. */
  sessions: number
  /** How many XR frames the double delivered. */
  frames: number
  /** Reference space types asked for, in order. */
  referenceSpaces: string[]
  /** Every feature named in a `requestSession` init, required and optional. */
  requestedFeatures: string[]
  /** How many sessions were ended. */
  ended: number
}

/**
 * Install the fake `navigator.xr` (plus the `XRWebGLLayer` / `XRWebGLBinding`
 * globals and `makeXRCompatible` that three.js needs to reach it).
 *
 * Pass to `page.addInitScript(installFakeXr, { ... })`.
 */
export const installFakeXr = (options: FakeXrOptions = {}): void => {
  const supported = options.supported !== false
  const rejectQuery = options.rejectQuery === true
  const viewCount = typeof options.views === 'number' ? options.views : 2
  const withSticks = options.sticks === true

  const record: FakeXrRecord = {
    calls: [],
    sessions: 0,
    frames: 0,
    referenceSpaces: [],
    requestedFeatures: [],
    ended: 0,
  }
  const note = (name: string): void => {
    record.calls.push(name)
  }

  // A real column-major perspective matrix, not zeros: three.js's
  // `setProjectionFromUnion` divides by these elements to rebuild a combined
  // frustum, and a degenerate matrix quietly produces NaN cameras.
  const perspective = (fovYRadians: number, aspect: number, near: number, far: number) => {
    const f = 1 / Math.tan(fovYRadians / 2)
    const m = new Float32Array(16)
    m[0] = f / aspect
    m[5] = f
    m[10] = (far + near) / (near - far)
    m[11] = -1
    m[14] = (2 * far * near) / (near - far)
    return m
  }

  const translation = (x: number, y: number, z: number) => {
    const m = new Float32Array(16)
    m[0] = 1
    m[5] = 1
    m[10] = 1
    m[15] = 1
    m[12] = x
    m[13] = y
    m[14] = z
    return m
  }

  const rigidTransform = (x: number, y: number, z: number) => ({
    matrix: translation(x, y, z),
    position: { x, y, z, w: 1 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
  })

  // Eye offsets: a 6.4 cm IPD at a seated 1.6 m eye height, so a `local-floor`
  // pose looks plausible rather than sitting on the origin.
  const views: Array<Record<string, unknown>> = []
  for (let i = 0; i < viewCount; i++) {
    const eyeX = viewCount === 1 ? 0 : i === 0 ? -0.032 : 0.032
    views.push({
      eye: viewCount === 1 ? 'none' : i === 0 ? 'left' : 'right',
      projectionMatrix: perspective(1.5, 1, 0.08, 6000),
      transform: rigidTransform(eyeX, 1.6, 0),
      recommendedViewportScale: null,
      requestViewportScale: () => {},
    })
  }

  const viewerPose = {
    transform: rigidTransform(0, 1.6, 0),
    views,
    emulatedPosition: false,
  }

  // --- XRWebGLLayer double -------------------------------------------------
  // `framebuffer: null` means "the default framebuffer", which is legal for
  // `bindFramebuffer` and keeps the double from having to own GL resources.
  class FakeXrWebGLLayer {
    framebuffer: WebGLFramebuffer | null = null
    framebufferWidth = 1024
    framebufferHeight = 1024
    antialias = false
    ignoreDepthValues = false
    constructor() {
      record.calls.push('new XRWebGLLayer')
    }
    getViewport() {
      return { x: 0, y: 0, width: 1024, height: 1024 }
    }
  }

  // three.js takes the projection-layer path when `XRWebGLBinding.prototype`
  // has `createProjectionLayer`. This stub deliberately does not, so the
  // simpler and better-understood base-layer path is exercised instead.
  class FakeXrWebGLBinding {}

  // --- XRSession double ----------------------------------------------------
  const makeSession = (init: XRSessionInit | undefined) => {
    const listeners = new Map<string, Set<(event: unknown) => void>>()
    const inputSources = withSticks
      ? [
          {
            handedness: 'right',
            targetRayMode: 'tracked-pointer',
            profiles: ['generic-trigger-squeeze-thumbstick'],
            gamepad: { mapping: 'xr-standard', axes: [0, 0, 0, 0], buttons: [] },
          },
        ]
      : []

    const session = {
      // Marks this as a double for `src/boot/xr-support.ts`'s emulation check.
      __ff2TestDouble: true,
      renderState: { baseLayer: null as unknown, depthNear: 0.1, depthFar: 1000 },
      environmentBlendMode: 'opaque',
      visibilityState: 'visible',
      enabledFeatures: ['viewer', 'local', 'local-floor'],
      inputSources,
      addEventListener(type: string, fn: (event: unknown) => void) {
        const set = listeners.get(type) ?? new Set()
        set.add(fn)
        listeners.set(type, set)
      },
      removeEventListener(type: string, fn: (event: unknown) => void) {
        listeners.get(type)?.delete(fn)
      },
      dispatchEvent(event: { type: string }) {
        for (const fn of listeners.get(event.type) ?? []) fn(event)
        return true
      },
      updateRenderState(state: Record<string, unknown>) {
        record.calls.push('session.updateRenderState')
        Object.assign(session.renderState, state)
      },
      async requestReferenceSpace(type: string) {
        record.calls.push('session.requestReferenceSpace')
        record.referenceSpaces.push(type)
        return { __space: type }
      },
      requestAnimationFrame(callback: (time: number, frame: unknown) => void) {
        record.calls.push('session.requestAnimationFrame')
        return globalThis.requestAnimationFrame((time: number) => {
          record.frames += 1
          callback(time, frame)
        })
      },
      cancelAnimationFrame(handle: number) {
        globalThis.cancelAnimationFrame(handle)
      },
      async end() {
        record.calls.push('session.end')
        record.ended += 1
        session.dispatchEvent({ type: 'end' })
      },
    }

    const frame = {
      session,
      getViewerPose(space: unknown) {
        record.calls.push('frame.getViewerPose')
        return space ? viewerPose : null
      },
      getPose() {
        return null
      },
    }

    for (const feature of init?.requiredFeatures ?? []) record.requestedFeatures.push(feature)
    for (const feature of init?.optionalFeatures ?? []) record.requestedFeatures.push(feature)

    return session
  }

  // --- navigator.xr double -------------------------------------------------
  const fakeXr = {
    __ff2TestDouble: true,
    async isSessionSupported(mode: string) {
      note(`isSessionSupported:${mode}`)
      if (rejectQuery) throw new DOMException('fake-xr: query rejected', 'NotSupportedError')
      return supported && mode === 'immersive-vr'
    },
    async requestSession(mode: string, init?: XRSessionInit) {
      note(`requestSession:${mode}`)
      if (!supported || mode !== 'immersive-vr') {
        throw new DOMException('fake-xr: mode not supported', 'NotSupportedError')
      }
      record.sessions += 1
      return makeSession(init)
    },
    addEventListener() {},
    removeEventListener() {},
  }

  const define = (target: object, key: string, value: unknown): void => {
    Object.defineProperty(target, key, { value, configurable: true, writable: true })
  }

  define(navigator, 'xr', fakeXr)
  define(globalThis, 'XRWebGLLayer', FakeXrWebGLLayer)
  define(globalThis, 'XRWebGLBinding', FakeXrWebGLBinding)
  define(globalThis, '__ff2FakeXr', record)

  // Chromium's real `makeXRCompatible()` rejects when there is no XR device,
  // which would abort three.js's `setSession` before it ever reaches the
  // layer. The double answers for it.
  const globals = globalThis as unknown as Record<string, unknown>
  const contexts = [globals.WebGLRenderingContext, globals.WebGL2RenderingContext]
  for (const ctor of contexts) {
    const proto = (ctor as { prototype?: object } | undefined)?.prototype
    if (proto) define(proto, 'makeXRCompatible', () => Promise.resolve())
  }
}

/**
 * Install a page where WebXR simply does not exist — Firefox's permanent
 * state (research doc 09 §3.3), and also what an insecure origin looks like.
 * Pass to `page.addInitScript(installNoXr)`.
 */
export const installNoXr = (): void => {
  Object.defineProperty(navigator, 'xr', { value: undefined, configurable: true })
}
