// src/making-of/shared/toy-host.ts: how a page mounts its toys. DEV-507
// (docs/plan/MAKING-OF.md §2.2, §2.5).
//
// A toy is a module that exports a `ToyDef`. The host owns everything that is
// not the toy: the frame around it, lazy mounting when it nears the screen,
// DISPOSING it when it is far away (browsers cap WebGL contexts near 16 and
// silently kill the oldest; PolyFish's playground mounted 21 and king-tide
// never disposed), one shared frame loop that runs only while something is
// visible, and the reduced-motion flag.
//
// Sim toys step the REAL fixed clock (`stepFixedToy` below), so a toy's
// physics runs at the game's 81.967 Hz with the game's own accumulator, never a
// `dt`-per-frame imitation (hard rule 5, in a toy too).

import { createClock, type FixedStepClock, stepFixed } from '@/sim/integrator'
import { type Controls, createControls } from './controls'

export interface Toy {
  /** Called once per display frame while visible, with wall seconds. */
  frame?(dt: number): void
  resize?(width: number, height: number): void
  dispose(): void
}

export interface ToyContext {
  readonly stage: HTMLElement
  readonly controls: Controls
  readonly reducedMotion: boolean
}

export type MountToy = (ctx: ToyContext) => Toy | Promise<Toy>

export interface ToyDef {
  readonly id: string
  readonly title: string
  /** One sentence under the stage: what to try. */
  readonly caption: string
  /** 3D toys hold a WebGL context and are capped; 2D ones are only disposed when far. */
  readonly kind: '2d' | '3d'
  readonly mount: MountToy
}

/** Browsers cap contexts near 16; three live is the plan's number (§2.5). */
export const MAX_LIVE_3D = 3

/**
 * Which toys are live, and which to evict. Pure, so the cap is unit-tested
 * without a browser. `admit` returns the ids that must be disposed now.
 */
export const createLiveSet = (max: number) => {
  /** Least recently visible first. */
  const order: string[] = []
  const visible = new Set<string>()
  const touch = (id: string) => {
    const i = order.indexOf(id)
    if (i >= 0) order.splice(i, 1)
    order.push(id)
  }
  return {
    admit(id: string): string[] {
      touch(id)
      visible.add(id)
      const evict: string[] = []
      // The newest is never evicted, and neither is anything on screen.
      for (const old of [...order]) {
        if (order.length - evict.length <= max) break
        if (old !== id && !visible.has(old)) evict.push(old)
      }
      for (const e of evict) order.splice(order.indexOf(e), 1)
      return evict
    },
    seen(id: string) {
      visible.add(id)
      touch(id)
    },
    unseen(id: string) {
      visible.delete(id)
    },
    release(id: string) {
      const i = order.indexOf(id)
      if (i >= 0) order.splice(i, 1)
      visible.delete(id)
    },
    ids: () => [...order],
  }
}

/** The game's fixed clock, for a toy: wall seconds in, whole sim ticks out, an alpha back. */
export const createToyClock = () => {
  const clock: FixedStepClock = createClock()
  return {
    clock,
    /** Returns the interpolation alpha in [0, 1). `onTick` gets the fixed dt and nothing else. */
    step: (frameSeconds: number, onTick: (dt: number, tick: number) => void): number =>
      stepFixed(clock, frameSeconds, onTick),
  }
}

interface Live {
  readonly def: ToyDef
  readonly root: HTMLElement
  readonly stage: HTMLElement
  readonly controlsEl: HTMLElement
  toy: Toy | null
  loading: boolean
  onScreen: boolean
}

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Mount every `<div data-toy="<id>">` on the page whose id is in `defs`. The
 * element becomes the frame; the toy mounts into its stage when it is within a
 * viewport of the screen and is disposed when it has been far away.
 */
export const mountToysOnPage = (defs: readonly ToyDef[]): void => {
  const byId = new Map(defs.map((d) => [d.id, d]))
  const lives: Live[] = []
  const liveSet = createLiveSet(MAX_LIVE_3D)
  const reduced = prefersReducedMotion()

  const build = (root: HTMLElement, def: ToyDef): Live => {
    root.classList.add('demo-container')
    root.innerHTML = ''
    const stage = document.createElement('div')
    stage.className = 'demo-stage'
    const poster = document.createElement('div')
    poster.className = 'poster'
    poster.textContent = def.title
    stage.append(poster)
    const label = document.createElement('div')
    label.className = 'demo-label'
    label.textContent = def.caption
    const controlsEl = document.createElement('div')
    root.append(stage, controlsEl, label)
    return { def, root, stage, controlsEl, toy: null, loading: false, onScreen: false }
  }

  const dispose = (live: Live) => {
    live.toy?.dispose()
    live.toy = null
    live.controlsEl.replaceChildren()
    const poster = document.createElement('div')
    poster.className = 'poster'
    poster.textContent = live.def.title
    live.stage.replaceChildren(poster)
    liveSet.release(live.def.id)
  }

  const mount = async (live: Live) => {
    if (live.toy || live.loading) return
    live.loading = true
    const evicted = live.def.kind === '3d' ? liveSet.admit(live.def.id) : []
    for (const id of evicted) {
      const victim = lives.find((l) => l.def.id === id)
      if (victim) dispose(victim)
    }
    live.stage.replaceChildren()
    live.controlsEl.replaceChildren()
    const controls = createControls(live.controlsEl)
    try {
      const toy = await live.def.mount({ stage: live.stage, controls, reducedMotion: reduced })
      if (!live.onScreen && !isNear(live.root)) {
        live.toy = toy
        dispose(live)
        return
      }
      live.toy = toy
      const r = live.stage.getBoundingClientRect()
      toy.resize?.(r.width, r.height)
    } finally {
      live.loading = false
    }
  }

  const isNear = (el: HTMLElement): boolean => {
    const r = el.getBoundingClientRect()
    return r.bottom > -innerHeight && r.top < innerHeight * 2
  }

  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const live = lives.find((l) => l.root === e.target)
        if (!live) continue
        if (e.isIntersecting) void mount(live)
        else if (live.toy) dispose(live)
      }
    },
    { rootMargin: '100% 0px' },
  )
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const live = lives.find((l) => l.root === e.target)
      if (!live) continue
      live.onScreen = e.isIntersecting
      if (e.isIntersecting) liveSet.seen(live.def.id)
      else liveSet.unseen(live.def.id)
    }
  })

  const resizer = new ResizeObserver((entries) => {
    for (const e of entries) {
      const live = lives.find((l) => l.stage === e.target)
      if (live?.toy) live.toy.resize?.(e.contentRect.width, e.contentRect.height)
    }
  })

  for (const el of document.querySelectorAll<HTMLElement>('[data-toy]')) {
    const def = byId.get(el.dataset.toy ?? '')
    if (!def) {
      console.error(`making-of: no toy "${el.dataset.toy}" is registered`)
      continue
    }
    const live = build(el, def)
    lives.push(live)
    near.observe(el)
    seen.observe(el)
    resizer.observe(live.stage)
  }

  // One loop for the page; a toy's `frame` runs only while it is live and on screen.
  let last = performance.now()
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    for (const l of lives) if (l.toy && l.onScreen && !document.hidden) l.toy.frame?.(dt)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}
