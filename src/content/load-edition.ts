// src/content/load-edition.ts — the only way a preset enters the game.
//
// The same shape as `load-level.ts`, for the same reasons: presets live in
// `content/editions/*.json`, are small, textual and versioned in git, and are
// pulled in by Vite as lazy dynamic imports. `import.meta.glob` means a typo in
// a preset id is a build-time list you can print, not a 404 at runtime — and
// that adding a third preset is one file and no code.

import { BUILD_CHANNEL, forChannel } from './build-channel'
import { type Edition, validateEdition } from './edition-schema'
import { globIds } from './glob-tree'

const modules = import.meta.glob<{ default: Edition }>('/content/editions/*.json')

const pathFor = (id: string): string => `/content/editions/${id}.json`

/** Every preset id the build knows about. Sorted, so a menu is stable. */
export const editionIds = (): string[] => globIds(modules, '/content/editions/')

export const loadEdition = async (id: string): Promise<Edition> => {
  const load = modules[pathFor(id)]
  if (!load) {
    throw new Error(`loadEdition("${id}"): no such edition. Known: ${editionIds().join(', ')}`)
  }
  // DEV-411: a release build loads the preset without its preview-only
  // features (`build-channel.ts`). The preview build gets the preset itself.
  return forChannel(validateEdition((await load()).default), BUILD_CHANNEL)
}
