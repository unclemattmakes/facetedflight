// src/making-of/chapters.ts: THE manifest of the making-of site. DEV-506.
//
// One row per chapter. The build plugin (`tools/making-of/plugin.ts`) reads it
// to decide which `making-of/<slug>/index.html` pages are Rollup inputs, to
// write the nav, the landing page's cards and every page's prev/next, so the
// order and the titles live HERE and nowhere else (PolyFish hand-copied its nav
// into eleven pages; docs/plan/MAKING-OF.md §1.1).
//
// `status`:
//   planned    no page yet. Shown on a preview build as a card without a link.
//   draft      a page exists. Built on a preview build only: Matt reads it on
//              the preview URL and flipping it to `published` is the edit that
//              ships it (DEV-411's pattern, for prose).
//   published  built everywhere.
//
// A slug is permanent once linked; a title is not (king-tide's rename lesson).
// This file imports nothing: the plugin loads it under plain node.

export type ChapterStatus = 'planned' | 'draft' | 'published'

export interface Chapter {
  readonly slug: string
  /** "Prologue" for the prologue, otherwise the chapter number as it is printed. */
  readonly number: string
  readonly title: string
  readonly pitch: string
  readonly status: ChapterStatus
  /** Toy ids (`src/making-of/toys/registry.ts`) this chapter mounts. */
  readonly toys: readonly string[]
}

export const CHAPTERS: readonly Chapter[] = [
  {
    slug: 'why',
    number: 'Prologue',
    title: 'Soaring out of Early Access',
    pitch:
      "What's in the anniversary edition, and why it's built for WebXR instead of one headset.",
    status: 'published',
    toys: ['island-flyover', 'live-window'],
  },
  {
    slug: 'archaeology',
    number: '01',
    title: 'Digging through the old Unity project',
    pitch:
      "What turned up in the 2016 Unity project: where the real numbers were hiding, two file formats that look alike, and a finish gate that wasn't in the scene.",
    status: 'published',
    toys: ['constants-browser', 'tick-vs-frame'],
  },
  {
    slug: 'flight',
    number: '02',
    title: 'The flight model',
    pitch:
      "The HoverJet flies with gravity switched off, so its speed is thrust against Unity's drag, plus the speed chain.",
    status: 'published',
    toys: ['flight-bench'],
  },
  {
    slug: 'terrain',
    number: '03',
    title: 'Rebuilding the islands from height maps',
    pitch:
      "Gigabytes of baked Unity mesh replaced by a generator checked against it, and a bug that stayed because it's part of the silhouette.",
    status: 'published',
    toys: ['facet-island', 'flat-vs-steep'],
  },
  {
    slug: 'bugs',
    number: '04',
    title: 'What stayed from 2016, and what got fixed',
    pitch:
      'A countdown that only starts when you leave the play area, and a platinum nobody could earn.',
    status: 'published',
    toys: ['medal-calculator', 'edge-vs-level'],
  },
  {
    slug: 'looks',
    number: '05',
    title: 'Classic and Anniversary',
    pitch:
      'Classic is a look only, and both looks fly the same rules, plus how Anniversary lights a flat-colored facet.',
    status: 'published',
    toys: ['response-curve'],
  },
  {
    slug: 'opposition',
    number: '06',
    title: 'AI racers and 2016 ghosts',
    pitch: 'Five autopilots replace the 2016 ghosts, and a ruler that measured the wrong thing.',
    status: 'published',
    toys: ['route-ruler', 'ghost-scrubber'],
  },
  {
    slug: 'racing',
    number: '07',
    title: 'Racing other people',
    pitch:
      'A room is a small server that runs none of the game. Each player flies their own time trial, the clocks agree on one GO, and a lap server checks every time.',
    status: 'published',
    toys: ['room-clock', 'remote-ship', 'lap-judge'],
  },
  {
    slug: 'courses',
    number: '08',
    title: 'The course editor',
    pitch:
      'New routes on the 2016 islands, new islands from a seed or a height map, flown in the real game and shared as a link.',
    status: 'published',
    toys: ['pocket-editor', 'island-maker'],
  },
  {
    slug: 'sound',
    number: '09',
    title: 'Building every sound in the browser',
    pitch:
      "Every sound is built in the browser from oscillators and filtered noise, so there's no file to license.",
    status: 'published',
    toys: ['engine-voice'],
  },
]

/** The site's own pages, which are not chapters. */
export const SITE_PAGES = ['index', 'playground'] as const

/** What a build of this channel shows. `planned` rows have no page, so only a preview lists them. */
export const visibleChapters = (channel: 'release' | 'preview'): readonly Chapter[] =>
  CHAPTERS.filter((c) => (channel === 'release' ? c.status === 'published' : true))

/** The chapters that have a page in a build of this channel, in reading order. */
export const builtChapters = (channel: 'release' | 'preview'): readonly Chapter[] =>
  visibleChapters(channel).filter((c) => c.status !== 'planned')
