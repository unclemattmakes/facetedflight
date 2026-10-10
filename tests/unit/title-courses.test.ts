// tests/unit/title-courses.test.ts: DEV-467: a shared course on the title
// (`render/title-menu.ts`), and COPY LINK / SAVE FILE on a player course's
// results panel (`game/course-share.ts`).
//
// DEV-558 took the title to START and ENTER VR (Matt, 2026-10-01), and DEV-467's
// COURSES hub off it: OPEN A COURSE FILE and MAKE A COURSE stand on the Custom
// Courses shelf in the hangar now (`render/course-shelf.ts`, held by
// `course-shelf.test.ts`). What is left on the title is a shared course's LINK:
// its row, first and aimed, or why it was refused. Those rows are pinned here.

import { describe, expect, it } from 'vitest'
import {
  COURSE_SHARE_IDLE,
  courseCopied,
  coursePanel,
  pressCourseSave,
  pressCourseShare,
  shortLink,
} from '@/game/course-share'
import { SHARE_KEYS } from '@/game/lap-share'
import {
  COURSE_REFUSED_ROW_ID,
  type CourseRowSource,
  courseOfRow,
  courseRefusedRow,
  courseRow,
  courseRowId,
  START_ROW,
  titleOpeningAim,
  titleRows,
} from '@/render/title-menu'

const entry = (i: number): CourseRowSource => ({
  id: `pc_${String(i).padStart(12, '0')}`,
  name: `Amber Heron ${i}`,
  place: 'Simonet Islands',
  source: i % 2 ? 'file' : 'link',
})

describe('DEV-467, DEV-558: a shared course on the title', () => {
  it('a course row names its course, its island, and where it came from', () => {
    const row = courseRow(entry(0))
    expect(row).toMatchObject({
      label: 'Amber Heron 0',
      value: 'Simonet Islands',
      note: 'from a link',
    })
    expect(row.id).toBe(courseRowId(entry(0).id))
    expect(courseOfRow(row.id)).toBe(entry(0).id)
    expect(courseOfRow(START_ROW.id)).toBeNull()
    expect(courseOfRow(undefined)).toBeNull()
  })

  it('a refusal is a row to read, in the accent, and says where it came from', () => {
    expect(courseRefusedRow('link', 'link: is damaged: not base64url')).toMatchObject({
      id: COURSE_REFUSED_ROW_ID,
      label: 'Shared Course',
      value: 'refused',
      note: 'link: is damaged: not base64url',
      accentNote: true,
    })
    expect(courseRefusedRow('file', 'x').label).toBe('Course File')
  })

  it('a link opens the title on its row; a refused one on START', () => {
    const linked = titleRows({ vr: 'connect', link: courseRow(entry(1)), start: null })
    expect(linked[0]?.id).toBe(courseRowId(entry(1).id))
    expect(titleOpeningAim(linked)).toBe(0)
    const refused = titleRows({
      vr: 'connect',
      link: courseRefusedRow('link', 'is not a course'),
      start: null,
    })
    expect(refused[titleOpeningAim(refused)]?.id).toBe(START_ROW.id)
  })
})

describe('DEV-467 — COPY LINK and SAVE FILE on a player course’s panel', () => {
  const base = {
    again: 'A or ENTER for the hangar',
    race: 'Y or R to race this lap',
    back: 'START or BACKSPACE to fly again',
  }

  it('idle offers it on the race line, or on the second line when there is no lap', () => {
    const p = coursePanel(COURSE_SHARE_IDLE, 'flat', base, 'Amber Heron')
    expect(p.race).toBe(`${base.race} · ${SHARE_KEYS.flat.share} to share the course`)
    expect(p.block).toBeNull()
    const noLap = coursePanel(COURSE_SHARE_IDLE, 'flat', { ...base, race: '' }, 'Amber Heron')
    expect(noLap.race).toBe('')
    expect(noLap.back).toBe(`${base.back} · ${SHARE_KEYS.flat.share} to share the course`)
    expect(coursePanel(COURSE_SHARE_IDLE, 'xr', base, 'x').race).toMatch(/THE LEFT to share/)
  })

  it('two presses copy: the first asks, the second copies; the race press saves only while it asks', () => {
    const asked = pressCourseShare(COURSE_SHARE_IDLE)
    expect(asked).toMatchObject({ copy: false, next: { phase: 'picking' } })
    const panel = coursePanel(asked.next, 'flat', base, 'Amber Heron')
    expect(panel.again).toBe(`${SHARE_KEYS.flat.share} to copy its link`)
    expect(panel.race).toBe(`${SHARE_KEYS.flat.race} to save it as a file`)
    expect(panel.block).toMatchObject({ heading: 'SHARE THIS COURSE', line: 'AMBER HERON' })
    expect(pressCourseSave(COURSE_SHARE_IDLE, 'a.ffcourse')).toBeNull()
    expect(pressCourseSave(asked.next, 'amber-heron.ffcourse')).toMatchObject({
      save: true,
      next: { phase: 'saved', file: 'amber-heron.ffcourse' },
    })
    const copying = pressCourseShare(asked.next)
    expect(copying).toMatchObject({ copy: true, next: { phase: 'copying' } })
    // A press while the clipboard is being written does nothing.
    expect(pressCourseShare(copying.next)).toMatchObject({ copy: false, next: copying.next })
    const link = `https://ff-10yr.pages.dev/#c=ffc1.${'A'.repeat(600)}`
    const copied = courseCopied(copying.next, link, true)
    const shown = coursePanel(copied, 'flat', base, 'Amber Heron').block
    expect(shown?.heading).toBe(`LINK COPIED · ${link.length} CHARACTERS`)
    expect(shown?.line.length).toBeLessThanOrEqual(48)
    expect(shown?.line.startsWith('ff-10yr.pages.dev/#c=ffc1.')).toBe(true)
    // …and the next press asks again.
    expect(pressCourseShare(copied).next.phase).toBe('picking')
    expect(courseCopied(copying.next, link, false).phase).toBe('failed')
  })

  it('shortens a link to fit, keeping its host and its end', () => {
    expect(shortLink('https://a.b/#c=x')).toBe('a.b/#c=x')
    const long = `https://ff-10yr.pages.dev/#c=ffc1.${'Q'.repeat(100)}END`
    const s = shortLink(long)
    expect(s.length).toBe(48)
    expect(s.endsWith('END')).toBe(true)
    expect(s).toContain('…')
  })
})
