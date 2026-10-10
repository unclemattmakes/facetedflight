// src/making-of/toys/registry.ts: every toy, by id. DEV-507.
//
// A chapter page imports `toysFor(ids)` and hands the result to
// `mountToysOnPage`; the playground takes them all. A toy's module is loaded
// only when its page does (dynamic import), so a chapter pays for its own toys.

import type { ToyDef } from '../shared/toy-host'

type Loader = () => Promise<{ toy: ToyDef }>

export const TOY_LOADERS: Readonly<Record<string, Loader>> = {
  'engine-voice': () => import('./engine-voice'),
  'lap-judge': () => import('./lap-judge'),
  'room-clock': () => import('./room-clock'),
  'remote-ship': () => import('./remote-ship'),
  'island-maker': () => import('./island-maker'),
  'pocket-editor': () => import('./pocket-editor'),
  'response-curve': () => import('./response-curve'),
  'island-flyover': () => import('./island-flyover'),
  'live-window': () => import('./live-window'),
  'constants-browser': () => import('./constants-browser'),
  'tick-vs-frame': () => import('./tick-vs-frame'),
  'ghost-scrubber': () => import('./ghost-scrubber'),
  'route-ruler': () => import('./route-ruler'),
  'flight-bench': () => import('./flight-bench'),
  'facet-island': () => import('./facet-island'),
  'flat-vs-steep': () => import('./flat-vs-steep'),
  'medal-calculator': () => import('./medal-calculator'),
  'edge-vs-level': () => import('./edge-vs-level'),
}

export const toysFor = async (ids: readonly string[]): Promise<ToyDef[]> =>
  Promise.all(
    ids.map(async (id) => {
      const load = TOY_LOADERS[id]
      if (!load) throw new Error(`making-of: no toy "${id}" in the registry`)
      return (await load()).toy
    }),
  )
