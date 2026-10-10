// src/render/credits-menu.ts: who made the game, and whose work is in it.
// DEV-614, DEV-620, and since DEV-623 a ROLL.
//
// Matt, 2026-10-04: *"credits should scroll the text upwards, like film
// credits - these look like options to adjust. list each song used. see if
// you can dig up the credits from the first game, and incorporate those. show
// this same panel in the hangar on a centered table, instead of a table per
// credit like now"*.
//
// ── One source of truth ──────────────────────────────────────────────────
//
// `creditsRoll` is the text, line by line. Two things draw it and neither
// owns a word of it: the pause plate's CREDITS page (on OPTIONS since DEV-621)
// hangs `render/credits-roll.ts`'s scrolling sheet in the plate's body, and
// the hangar's CREDITS step stands the same sheet on one table. A credit added
// here is on both.
//
// ── What is on it, and which of it a licence REQUIRES ────────────────────
//
//   FACETED FLIGHT  the version and "© 2016 and 2026, Uncle Matt Makes".
//   MUSIC           EVERY song the game loads, title and artist, read off
//                   `SOUNDTRACK` (`content/soundtrack.ts`), which is the list
//                   the player's music actually plays from: one array, one
//                   `.opus` each under `assets/audio/music/`. Not typed here.
//                   CC0 1.0 asks for no credit at all; this is courtesy.
//   TYPE            CRYSTAL, © 2014 Felipe Munoz, CC BY-SA 4.0, unmodified:
//                   the one attribution in the build a licence REQUIRES
//                   (author, title, licence, and that it is unmodified). And
//                   Bitter and Roboto Condensed, SIL OFL 1.1.
//   RENDERER        three.js, MIT. Courtesy; THIRD-PARTY-NOTICES.md carries the notice.
//   2016            Faceted Flight (2016)'s own credits, from its `credits`
//                   scene (`Assets/Faceted Flight/Scenes/credits.unity` in
//                   $FF2_LEGACY): pages `CreditsManager.credit_pages`
//                   cycles, read through the liveness walk. Its music pages
//                   are left out (DEV-833): none of that music is in this build. 2016's font set mixed case for
//                   style ("JorDan", "BurNett"); the names are written here in
//                   ordinary case, and its one typo ("A New Directoin") is
//                   corrected. DEVIATIONS.md DEV-623 has the page map.

import { SOUNDTRACK } from '@/content/soundtrack'
import type { PauseOption } from '@/render/pause'

/** 2016's punctuation, as the pause title and the other pages have it. */
export const CREDITS_TITLE = '- CREDITS -'

/** What the caller still has to do. Only one thing, and it is leaving. */
export type CreditsAction = 'none' | 'back'

/** The row on the OPTIONS page that opens the roll. */
export const CREDITS_OPTION: PauseOption = {
  id: 'credits',
  label: 'Credits',
  note: 'who made it, and whose work is in it',
}

/**
 * The copyright, in Matt's words (2026-10-03: *"fix the wording on the
 * copyright to remove the word "again""*). The roll and the title's own line
 * (`titleLine`) both read it.
 */
export const COPYRIGHT = '© 2016 and 2026, Uncle Matt Makes'

/**
 * The title's one line at its foot: the version and the copyright together.
 * `version` is `BUILD_VERSION`.
 */
export const titleLine = (version: string): string => `${version} · ${COPYRIGHT}`

/**
 * One line of the roll. `heading` is a section's name, drawn in the accent;
 * `name` is who or what, large; `note` is the line under a name, dim; `gap`
 * is air between sections.
 */
export interface CreditLine {
  readonly kind: 'title' | 'heading' | 'name' | 'note' | 'gap'
  readonly text: string
}

/** The most characters any roll line may hold and still fit the sheet unsqueezed. */
export const CREDITS_LINE_MAX = 40

const title = (text: string): CreditLine => ({ kind: 'title', text })
const heading = (text: string): CreditLine => ({ kind: 'heading', text })
const name = (text: string): CreditLine => ({ kind: 'name', text })
const note = (text: string): CreditLine => ({ kind: 'note', text })
const GAP: CreditLine = { kind: 'gap', text: '' }

/** A song as the roll credits it. */
export interface CreditedSong {
  readonly title: string
  readonly author: string
}

/**
 * Faceted Flight (2016)'s credits, from its `credits` scene, in its page
 * order. Each entry is one 2016 page; `credits2016` lays them out.
 */
export const CREDITS_2016: readonly {
  readonly heading: string
  readonly names: readonly string[]
}[] = [
  { heading: 'Concept, development and art', names: ['Matt Scott'] },
  { heading: 'Executive producer', names: ['Joe Harkins'] },
  { heading: 'Additional engineering', names: ['Jean Simonet'] },
  { heading: 'Concept art', names: ['Alice Duke', 'Jordan Saia'] },
  { heading: 'Additional art', names: ['Jonah Lobe', 'Quantum Theory Entertainment'] },
  {
    heading: 'Special thanks',
    names: [
      'Katie & Ollie',
      'Mom, Dad, & the family',
      'Jenn Hawkins',
      'Aaron Lemke',
      'Alex Schwartz',
      'Joel Burgess',
      'Callum Underwood',
      'Matt Kessler',
      'Chet Faliszek',
      'Jim Vaughn',
      'Trey Davis',
      'Geoff Skow',
      'Robert Brackenridge',
      'Peyton & Kendall Burnett',
      'Roudy, Micky, and Dusty Burnett',
      'Dallas VR Meetup Group',
      'Dallas Unity Meetup Group',
      'Austin VR Meetup Group',
    ],
  },
]

/**
 * The whole roll, top to bottom. `version` is `BUILD_VERSION`; `songs` is the
 * soundtrack the game loads, `SOUNDTRACK` unless a test hands another.
 */
export const creditsRoll = (
  version: string,
  songs: readonly CreditedSong[] = SOUNDTRACK,
): readonly CreditLine[] => [
  // DEV-873 (Matt, 2026-10-08: "start with the 2016 credits"): the original
  // game's people first, then what the anniversary added.
  title('Faceted Flight (2016)'),
  GAP,
  ...CREDITS_2016.flatMap((page) => [heading(page.heading), ...page.names.map(name), GAP]),
  title('Faceted Flight'),
  note('10th Anniversary Edition'),
  note(version),
  note(COPYRIGHT),
  GAP,
  heading('Music'),
  ...songs.flatMap((s) => [name(s.title), note(s.author)]),
  note('CC0 1.0, from the Retro Wave collection'),
  GAP,
  heading('Type'),
  name('CRYSTAL'),
  note('© 2014 Felipe Munoz'),
  note('CC BY-SA 4.0, unmodified'),
  name('Bitter'),
  note('© 2011 The Bitter Project Authors'),
  note('SIL Open Font License 1.1'),
  name('Roboto Condensed'),
  note('© 2011 Google Inc.'),
  note('SIL Open Font License 1.1'),
  GAP,
  heading('Renderer'),
  name('three.js'),
  note('© 2010-2026 three.js authors'),
  note('MIT licence'),
  GAP,
  note('Thanks for playing!'),
]

/** BACK, the roll page's one row: everything else on it is read, not pressed. */
export const CREDITS_BACK: PauseOption = { id: 'back', label: 'Back', note: 'to more' }

/**
 * How fast the roll climbs, in sheet-WIDTHS per second (so a small sheet and
 * a large one read at the same pace in lines), and the factor while A is
 * held. A name's line is 0.06 of the width (`credits-roll.ts`), so this is
 * about two names a second. DEV-833 (Matt, 2026-10-08): the roll was too slow, so
 * the pace doubled in every edition. Taste, and Matt's to move.
 */
export const ROLL_PACE = 0.12
export const ROLL_FAST = 4

/** Press A on row `index`: BACK leaves; anywhere else speeds the roll. */
export const activateCreditsRow = (index: number): CreditsAction => (index === 0 ? 'back' : 'none')

// ── The little state machine `app.ts` holds, mirroring EditionMenu ─────────

export interface CreditsMenu {
  readonly open: boolean
  /** One row, BACK. Feed straight to `pause.update({ options })`. */
  readonly rows: readonly PauseOption[]
  readonly title: string
  /** The roll's text. */
  readonly roll: readonly CreditLine[]
  openPage(): void
  closePage(): void
  activate(index: number): CreditsAction
}

export interface CreditsMenuOptions {
  /** `BUILD_VERSION`. */
  readonly version: string
}

export const createCreditsMenu = (options: CreditsMenuOptions): CreditsMenu => {
  let open = false
  const rows = [CREDITS_BACK]
  const roll = creditsRoll(options.version)
  return {
    get open() {
      return open
    },
    get rows() {
      return rows
    },
    get title() {
      return CREDITS_TITLE
    },
    get roll() {
      return roll
    },
    openPage() {
      open = true
    },
    closePage() {
      open = false
    },
    activate(index) {
      const action = activateCreditsRow(index)
      if (action === 'back') open = false
      return action
    },
  }
}
