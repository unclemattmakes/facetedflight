// src/game/course-share.ts — COPY LINK and SAVE FILE, on the results panel of
// a player course. DEV-467, E1.
//
// docs/plan/EDITOR-DISPATCH.md, DEV-467 step 5: *"On a run of a player course,
// the results panel offers Copy link and Save file."* A player course keeps
// its laps on this device (`LOCAL_LAP_RULES`: the lap server has no board for
// it), so DEV-373's Share — post the LAP — is never offered on one, and its
// button is free. This is what that button does there instead: share the
// COURSE, which is what somebody who flew one wants to send.
//
// The same two-press shape as Share, on the same two buttons, so nothing new
// is bound and the prompts read the way Share's already do:
//
//   idle     the panel offers it: "… · SELECT or G to share the course"
//   picking  the first press: "SHARE THIS COURSE", its name; the share button
//            again copies its LINK, the race button saves it as a FILE
//   copying  the clipboard is being written
//   copied   the link, shortened to fit, and how long it is
//   saved    the file name it was saved as
//   failed   why the clipboard refused, with the link to read instead
//
// Nothing leaves the browser: a link is text on the clipboard and a file is a
// download (EDITOR.md §5.6, "creators host their own files").
//
// PURE: state in, state out, and the panel's words for each state. `boot/app.ts`
// owns the presses, the clipboard and the download.

import { SHARE_KEYS, type ShareBlock, type SharePanel, type ShareRoute } from './lap-share'

export type CourseSharePhase = 'idle' | 'picking' | 'copying' | 'copied' | 'saved' | 'failed'

export interface CourseShareState {
  readonly phase: CourseSharePhase
  /** The link, once one has been made (`copying` on). */
  readonly link: string | null
  /** The file name, once saved. */
  readonly file: string | null
  /** Why the clipboard refused. */
  readonly reason: string | null
}

export const COURSE_SHARE_IDLE: CourseShareState = {
  phase: 'idle',
  link: null,
  file: null,
  reason: null,
}

/**
 * The share button. From `idle` (or after a copy, a save or a refusal) it
 * opens the choice; from the choice it COPIES — `copy` is true exactly then.
 * While the clipboard is being written it does nothing.
 */
export const pressCourseShare = (
  state: CourseShareState,
): { readonly next: CourseShareState; readonly copy: boolean } => {
  switch (state.phase) {
    case 'picking':
      return { next: { ...state, phase: 'copying' }, copy: true }
    case 'copying':
      return { next: state, copy: false }
    default:
      return { next: { ...state, phase: 'picking' }, copy: false }
  }
}

/**
 * The race button, which saves a FILE — but only while the choice is up. Null
 * everywhere else: the press is not this panel's, and "race this lap" keeps it.
 */
export const pressCourseSave = (
  state: CourseShareState,
  file: string,
): { readonly next: CourseShareState; readonly save: true } | null =>
  state.phase === 'picking' ? { next: { ...state, phase: 'saved', file }, save: true } : null

/** The clipboard answered. */
export const courseCopied = (
  state: CourseShareState,
  link: string,
  ok: boolean,
  reason = 'the clipboard refused',
): CourseShareState =>
  ok
    ? { ...state, phase: 'copied', link, reason: null }
    : { ...state, phase: 'failed', link, reason }

/**
 * A link, cut to be read on the panel: its host, the start of the course, and
 * its end — the whole of it is on the clipboard.
 */
export const shortLink = (link: string, max = 48): string => {
  const bare = link.replace(/^https?:\/\//, '')
  if (bare.length <= max) return bare
  const tail = Math.floor(max / 4)
  return `${bare.slice(0, max - tail - 1)}…${bare.slice(-tail)}`
}

/**
 * The panel as this leaves it: its three prompts, and the block where the
 * board would be. `base` is the run's own three prompts (`race` empty when the
 * run left no lap); `name` the course's two words.
 */
export const coursePanel = (
  state: CourseShareState,
  route: ShareRoute,
  base: { readonly again: string; readonly race: string; readonly back: string },
  name: string,
): SharePanel => {
  const keys = SHARE_KEYS[route]
  const tail = (verb: string): string =>
    route === 'xr' ? `, THE LEFT to ${verb}` : ` · ${keys.share} to ${verb}`
  // The offer rides the race line where there is one (as Share's does), and
  // the second line where the run left no lap to race.
  const offer = (verb: string): Pick<SharePanel, 'race' | 'back'> =>
    base.race.length > 0
      ? { race: `${base.race}${tail(verb)}`, back: base.back }
      : { race: base.race, back: `${base.back} · ${keys.share} to ${verb}` }
  const block = (heading: string, line: string, tone: ShareBlock['tone']): ShareBlock => ({
    heading,
    line,
    tone,
  })
  const title = name.toUpperCase()
  switch (state.phase) {
    case 'idle':
      return { again: base.again, ...offer('share the course'), block: null }
    case 'picking':
      return {
        again: `${keys.share} to copy its link`,
        race: `${keys.race} to save it as a file`,
        back: base.again,
        block: block('SHARE THIS COURSE', title, 'accent'),
      }
    case 'copying':
      return { ...base, block: block('COPYING THE LINK', title, 'dim') }
    case 'copied':
      return {
        again: base.again,
        ...offer('share it again'),
        block: block(
          `LINK COPIED · ${(state.link ?? '').length} CHARACTERS`,
          shortLink(state.link ?? ''),
          'ink',
        ),
      }
    case 'saved':
      return {
        again: base.again,
        ...offer('share it again'),
        block: block('SAVED AS A FILE', state.file ?? '', 'ink'),
      }
    case 'failed':
      return {
        again: base.again,
        ...offer('try again'),
        block: block(
          `NOT COPIED: ${(state.reason ?? '').toUpperCase()}`,
          shortLink(state.link ?? ''),
          'dim',
        ),
      }
  }
}
