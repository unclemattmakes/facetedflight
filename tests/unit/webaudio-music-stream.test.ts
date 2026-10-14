// tests/unit/webaudio-music-stream.test.ts: music plays through an <audio>
// element, not a decoded buffer (DEV-962). Nothing in node can hear it, so this
// pins what the backend DOES with a fake context and a fake element: that no
// track is decoded while streaming works, that an element gets one media node
// ever, that the fade is the same equal-power schedule, that "ended" fires only
// when the track ran out, and that every way streaming can fail ends in the
// decode path the game shipped with before.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebAudioBackend, MUSIC_STREAM_READY_SECONDS } from '@/audio/webaudio'

class FakeParam {
  value = 1
  calls: string[] = []
  cancelScheduledValues(t: number): void {
    this.calls.push(`cancel@${t}`)
  }
  setValueAtTime(v: number, t: number): void {
    this.value = v
    this.calls.push(`set ${v}@${t}`)
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.calls.push(`ramp ${v}@${t}`)
  }
  setTargetAtTime(v: number, t: number): void {
    this.calls.push(`target ${v}@${t}`)
  }
  setValueCurveAtTime(curve: Float32Array, t: number, d: number): void {
    this.calls.push(`curve ${curve[0]}..${curve[curve.length - 1]}@${t}+${d}`)
  }
}

class FakeNode {
  gain = new FakeParam()
  frequency = new FakeParam()
  Q = new FakeParam()
  type = ''
  connections: unknown[] = []
  buffer: unknown = null
  loop = false
  started = false
  stopped = false
  onended: (() => void) | null = null
  connect(to: unknown): unknown {
    this.connections.push(to)
    return to
  }
  disconnect(): void {
    this.connections = []
  }
  start(): void {
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
}

interface World {
  contexts: FakeContext[]
  elements: FakeAudio[]
  /** What the next element does on `src =`: reach canplay, error, or nothing. */
  elementBehaviour: 'canplay' | 'error' | 'silent'
  /** What `play()` does. */
  playBehaviour: 'resolve' | 'reject'
  duration: number
  fetched: string[]
}
let world: World

class FakeContext {
  currentTime = 0
  state = 'running'
  destination = {}
  listener = { setPosition() {}, setOrientation() {} }
  mediaSources: FakeNode[] = []
  sourcesMadeFor = new Set<unknown>()
  bufferSources: FakeNode[] = []
  decodes = 0
  closed = false
  gains: FakeNode[] = []
  constructor() {
    world.contexts.push(this)
  }
  createGain(): FakeNode {
    const g = new FakeNode()
    this.gains.push(g)
    return g
  }
  createBiquadFilter(): FakeNode {
    return new FakeNode()
  }
  createMediaElementSource(el: unknown): FakeNode {
    if (this.sourcesMadeFor.has(el)) throw new Error('InvalidStateError: one node per element')
    this.sourcesMadeFor.add(el)
    const n = new FakeNode()
    this.mediaSources.push(n)
    return n
  }
  createBufferSource(): FakeNode {
    const n = new FakeNode()
    this.bufferSources.push(n)
    return n
  }
  async decodeAudioData(_bytes: ArrayBuffer): Promise<{ duration: number }> {
    this.decodes += 1
    return { duration: 200 }
  }
  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true
  }
}

class FakeAudio extends EventTarget {
  crossOrigin: string | null = null
  preload = ''
  duration = Number.NaN
  currentTime = 0
  paused = true
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  playCalls = 0
  released = false
  private source = ''
  constructor() {
    super()
    world.elements.push(this)
  }
  set src(value: string) {
    this.source = value
    if (world.elementBehaviour === 'canplay') {
      queueMicrotask(() => {
        this.duration = world.duration
        this.dispatchEvent(new Event('canplay'))
      })
    } else if (world.elementBehaviour === 'error') {
      queueMicrotask(() => this.dispatchEvent(new Event('error')))
    }
  }
  get src(): string {
    return this.source
  }
  play(): Promise<void> {
    this.playCalls += 1
    this.paused = false
    return world.playBehaviour === 'resolve'
      ? Promise.resolve()
      : Promise.reject(new Error('NotAllowedError'))
  }
  pause(): void {
    this.paused = true
  }
  removeAttribute(_name: string): void {
    this.released = true
    this.source = ''
  }
  load(): void {}
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

const makeBackend = async () => {
  const backend = createWebAudioBackend()
  await backend.resume()
  const context = world.contexts[0]
  if (!context) throw new Error('no context was built')
  return { backend, context }
}

beforeEach(() => {
  world = {
    contexts: [],
    elements: [],
    elementBehaviour: 'canplay',
    playBehaviour: 'resolve',
    duration: 180,
    fetched: [],
  }
  vi.stubGlobal('AudioContext', FakeContext)
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal('fetch', async (src: string) => {
    world.fetched.push(src)
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'audio/ogg' },
      arrayBuffer: async () => new ArrayBuffer(8),
    }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('DEV-962: music streams through an element', () => {
  it('decodes nothing, and reports the element duration', async () => {
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    expect(buffer).toEqual({ src: '/a.opus', durationSeconds: 180 })
    expect(context.decodes).toBe(0)
    expect(world.fetched).toEqual([])
    const element = world.elements[0]
    expect(element?.crossOrigin).toBe('anonymous')
  })

  it('routes the element into a gain on the music bus, silent until faded in', async () => {
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    const voice = backend.playMusic(buffer)
    expect(voice.live).toBe(true)
    expect(context.mediaSources).toHaveLength(1)
    const element = world.elements[0]
    expect(element?.playCalls).toBe(1)
    const voiceGain = context.gains.at(-1)
    expect(voiceGain?.gain.calls[0]).toBe('set 0@0')
    voice.fadeIn(2)
    expect(voiceGain?.gain.calls.some((c) => c.startsWith('curve 0..1@0+2'))).toBe(true)
    voice.fadeOut(2)
    expect(voiceGain?.gain.calls.some((c) => /^curve 1\.\..*@0\+2$/.test(c))).toBe(true)
    expect(voice.live).toBe(false)
  })

  it('makes one media node per element, ever', async () => {
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    backend.playMusic(buffer)
    expect(() => backend.playMusic(buffer)).not.toThrow()
    expect(context.mediaSources).toHaveLength(1)
  })

  it('calls back when the track runs out, and not when it was faded out', async () => {
    const { backend } = await makeBackend()
    const a = await backend.loadMusic('/a.opus')
    const b = await backend.loadMusic('/b.opus')
    if (!a || !b) throw new Error('no buffer')
    const ran = backend.playMusic(a)
    const faded = backend.playMusic(b)
    const onRan = vi.fn()
    const onFaded = vi.fn()
    ran.onEnded(onRan)
    faded.onEnded(onFaded)
    faded.fadeOut(0.5)
    world.elements[0]?.onended?.()
    world.elements[1]?.onended?.()
    expect(onRan).toHaveBeenCalledTimes(1)
    expect(onFaded).not.toHaveBeenCalled()
    expect(ran.live).toBe(false)
  })

  it('stops and releases the element once the fade-out has finished', async () => {
    vi.useFakeTimers()
    const { backend } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    const voice = backend.playMusic(buffer)
    voice.fadeOut(1)
    const element = world.elements[0]
    expect(element?.released).toBe(false)
    vi.advanceTimersByTime(1100)
    expect(element?.released).toBe(true)
    expect(element?.paused).toBe(true)
  })

  it('dispose releases every element a voice is still playing', async () => {
    const { backend } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    backend.playMusic(buffer)
    backend.dispose()
    expect(world.elements[0]?.released).toBe(true)
  })
})

describe('DEV-962: every way streaming fails ends in the decode path', () => {
  it('a refused play() decodes the track instead, re-applies the fade, and stops streaming', async () => {
    world.playBehaviour = 'reject'
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    const voice = backend.playMusic(buffer)
    voice.fadeIn(2)
    const voiceGain = context.gains.at(-1)
    await flush()
    expect(context.decodes).toBe(1)
    expect(context.bufferSources).toHaveLength(1)
    expect(context.bufferSources[0]?.started).toBe(true)
    // The fade-in was scheduled again from the moment the source started.
    expect(voiceGain?.gain.calls.filter((c) => c.startsWith('curve 0..1')).length).toBe(2)
    // The next track does not even try an element.
    const before = world.elements.length
    await backend.loadMusic('/b.opus')
    expect(world.elements.length).toBe(before)
    expect(context.decodes).toBe(2)
  })

  it('a faded-out voice does not start the fallback source late', async () => {
    world.playBehaviour = 'reject'
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    const voice = backend.playMusic(buffer)
    voice.fadeOut(0.01)
    await flush()
    expect(context.bufferSources).toHaveLength(0)
  })

  it('an element that errors (404, html body, no CORS) falls to the decode path', async () => {
    world.elementBehaviour = 'error'
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    expect(buffer).toEqual({ src: '/a.opus', durationSeconds: 200 })
    expect(context.decodes).toBe(1)
    expect(world.fetched).toEqual(['/a.opus'])
    const voice = backend.playMusic(buffer ?? { src: '', durationSeconds: 0 })
    expect(voice.live).toBe(true)
    expect(context.bufferSources[0]?.started).toBe(true)
  })

  it('an element that never reaches canplay (iOS) times out, decodes, and stops streaming', async () => {
    vi.useFakeTimers()
    world.elementBehaviour = 'silent'
    const { backend, context } = await makeBackend()
    const pending = backend.loadMusic('/a.opus')
    await vi.advanceTimersByTimeAsync(MUSIC_STREAM_READY_SECONDS * 1000 + 50)
    const buffer = await pending
    expect(buffer).toEqual({ src: '/a.opus', durationSeconds: 200 })
    expect(world.elements[0]?.released).toBe(true)
    const before = world.elements.length
    await backend.loadMusic('/b.opus')
    expect(world.elements.length).toBe(before)
    expect(context.decodes).toBe(2)
  })

  it('an unknown duration is not a stream', async () => {
    world.duration = Number.POSITIVE_INFINITY
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    expect(buffer?.durationSeconds).toBe(200)
    expect(context.decodes).toBe(1)
  })

  it('with no Audio constructor it decodes, as before', async () => {
    vi.stubGlobal('Audio', undefined)
    const { backend, context } = await makeBackend()
    const buffer = await backend.loadMusic('/a.opus')
    expect(buffer?.durationSeconds).toBe(200)
    expect(context.decodes).toBe(1)
  })

  it('a context that cannot make an element node falls back too', async () => {
    const { backend, context } = await makeBackend()
    context.createMediaElementSource = () => {
      throw new Error('boom')
    }
    const buffer = await backend.loadMusic('/a.opus')
    if (!buffer) throw new Error('no buffer')
    const voice = backend.playMusic(buffer)
    voice.fadeIn(1)
    await flush()
    expect(context.decodes).toBe(1)
    expect(context.bufferSources[0]?.started).toBe(true)
  })
})
