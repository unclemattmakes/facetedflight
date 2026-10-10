// src/content/build-channel.ts — which features a build ships. DEV-411.
//
// Matt, 2026-09-25: *"the variants are awesome but need time to tune - let's
// push them as an update post-ship. let's keep them in preview, but not in
// release if that's possible."* Asked at filing, he put the glider behind the
// same switch.
//
// Cloudflare Pages builds `release` as production and every other branch as
// preview, and it names the branch in the build's environment
// (`CF_PAGES_BRANCH`). `vite.config.ts` turns that into `__FF2_CHANNEL__`. A
// local build is `preview`, which is what `main` ships, so the dev server, the
// unit suite and Playwright all run the preview build: no harness takes a
// different path from a player (CLAUDE.md).
//
// **One choke point.** Every gate on these two features already reads the
// edition: `gameplay.variants.enabled` decides the hangar's variant step,
// `resolveVariant`, a URL's `?variant=` and a remembered choice, and
// `gameplay.glider.enabled` decides the glider's table and its course. So a
// release build loads the preset with each off (`loadEdition`), and every one
// of those gates follows without learning about channels. The lap server's
// rules come from the committed `content/lap-courses.json`, not from the live
// preset, so this moves no board.
//
// DEV-389 added `rooms` (production had no rooms Worker bound) and DEV-466
// `editor` (docs/plan/EDITOR.md §5.7): the course editor and player courses,
// aimed at 1.0 behind this list and decided at release. Their gates are the
// title's rows and the `?room=` / `?watch=` / `#c=` / `?edit=1` doors
// (DEV-441, 436, 467, 469), and they read Anniversary's block, because the
// menus always wear it (D35).
//
// **DEV-470 took both off (D36, Matt, 2026-09-27: *"multiplayer & editor
// ship."*).** A release build has the title's SINGLE PLAYER, MULTIPLAYER and
// COURSES doors. What that commits the release to is in D36 and
// `docs/rooms.md` § Releasing rooms: production's rooms Worker and its
// `ROOMS` binding before the merge to `release`. Without them every room path
// answers 503 (`net/room-route.ts`) and the game says multiplayer is not
// available there, at once (`game/room-client.ts`'s `ROOM_OFF`).
//
// **DEV-480 put `tv` on the list** (Faceted Flight TV, docs/plan/FF-TV.md):
// in 1.0, but shipped only once Matt has worn it (§7). Its gates are the
// title's TV row, the `?tv` links and the results panel's watch link, all
// reading Anniversary's block.
//
// **DEV-578 took `tv` off (Matt, 2026-10-03: *"FF-TV - move to
// production"*).** A release build has the hangar's FF-TV table (its first
// step is four tables, laid by `DOORS_BEARING_STEP` in `render/hangar.ts` so
// all four stand in a flat frame), the `?tv`, `/tv/<id>` and `/tv/lap/<id>`
// links, WATCH ME in a room's lobby, and a lap link's WATCH THIS LAP. What
// TV shows live there is what production's rooms Worker serves: from a
// commit with DEV-479 it lists the races; without one, TV is the exhibition
// alone and says nothing is live (plan/FF-TV.md §0.1 item 6).

import type { Edition } from './edition-schema'

/** Replaced at build time by `vite.config.ts`. Absent under a plain `tsc` or node. */
declare const __FF2_CHANNEL__: string | undefined

export type BuildChannel = 'release' | 'preview'

/** A branch name to a channel. Only `release` is production. */
export const channelFor = (branch: string | undefined): BuildChannel =>
  branch === 'release' ? 'release' : 'preview'

/** This build's channel. */
export const BUILD_CHANNEL: BuildChannel =
  typeof __FF2_CHANNEL__ === 'string' ? channelFor(__FF2_CHANNEL__) : 'preview'

/**
 * The features a release build leaves out, by their `gameplay` block's name.
 * **Pinned by value in `tests/unit/build-channel.test.ts`**: taking one out
 * ships it to production, so the edit has to be made on purpose.
 */
export const PREVIEW_ONLY = ['variants', 'glider'] as const

/**
 * The preset as `channel` ships it. The preview build is the preset itself,
 * the same object. A release build is a copy with each `PREVIEW_ONLY` block's
 * `enabled` off and nothing else moved.
 */
export const forChannel = (edition: Edition, channel: BuildChannel): Edition => {
  if (channel !== 'release') return edition
  const gameplay = { ...edition.gameplay }
  for (const key of PREVIEW_ONLY) {
    ;(gameplay as Record<string, unknown>)[key] = { ...edition.gameplay[key], enabled: false }
  }
  return { ...edition, gameplay }
}
