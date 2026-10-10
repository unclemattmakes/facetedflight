// tests/unit/title-menu.test.ts: the title's rows, and where they hang.
// DEV-353; the first visit, DEV-379; since DEV-558, START and ENTER VR.
//
// Matt, 2026-10-01: *"Title Screen: Start, Enter VR. Clicking either should
// take us to the Hangar"*. Claims, each one arithmetic somebody could get wrong
// without a screenshot noticing:
//
//   1. The title is START and ENTER VR, START first, so every press that
//      started the game before (A, Enter, a click, the START chip) still goes
//      to the hangar. A phone (no headset) is START alone. A link's row, when a
//      link brought the page, stands first and is aimed.
//   2. The plate hangs below the line under the emblem and inside the frame,
//      on a monitor and on a portrait phone.
//   3. A ray along the flat camera's axis MISSES it. On a flat screen the
//      "gaze" is the centre of the frame, and a row on the centre line would be
//      re-picked every frame and the arrow keys could never move off it: the
//      same property `pause.ts`'s `PANEL_DROP` exists for. And a ray from the
//      eye through a row's centre lands on that row, through the plate's own
//      hit test (`pickLocal`), so what you see and what you hit agree.
//
// The plate's painter needs a canvas and this suite runs in node, so the hit
// test is driven through `pickLocal`, which is the whole of `pick` but the
// matrix inverse, and that inverse is taken here off a real `Object3D` placed
// by the shipped `placeTitleMenu`.

import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { HEADLESS_TITLE_M, panelHeight, pickLocal, rowCentreLocalY } from '@/render/pause'
import {
  COURSE_REFUSED_ROW_ID,
  courseRefusedRow,
  courseRow,
  ENTER_VR_ROW_ID,
  enterVrRow,
  ghostRaceRow,
  ghostWatchRow,
  placeTitleMenu,
  QUICK_RACE_ROW_ID,
  START_ROW,
  TITLE_MENU_BAND_M,
  TITLE_MENU_FLAT_BOOST,
  TITLE_MENU_HEADING,
  TITLE_MENU_MAX_ROWS,
  TITLE_MENU_PLATE,
  type TitleInput,
  titleMenuExtent,
  titleMenuScale,
  titleOpeningAim,
  titleRows,
  WATCH_LAP_ROW_ID,
} from '@/render/title-menu'
import { type TitleVrState, titleVrShown, titleVrText } from '@/render/title-vr'

/** The renderer's own flat lens, vertical degrees (`render/renderer.ts`). */
const FLAT_VFOV = 70

/**
 * The line under the emblem, *"10th Anniversary Edition"* (DEV-285), and
 * where its LOWER edge is, in degrees below the eye.
 *
 * Its centre is 8.15 degrees below the camera axis: `title.ts` says so and
 * `title-placement.test.ts` holds it against 2016's own numbers. Its plane is
 * `MONUMENT_WIDTH * 0.0875` = 6.825 m tall at a scale of 0.1131, i.e. 0.772 m,
 * about 10.9 m out along the sightline: 2.0 degrees each side of centre. A
 * DERIVED number, said so here with its working (DEV-027).
 */
const PROMPT_LOWER_EDGE_DEG = 8.15 + 2.0

const flat = (over: Partial<TitleInput> = {}): TitleInput => ({
  vr: 'connect',
  link: null,
  start: null,
  ...over,
})
const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

describe('DEV-558: the title is START and ENTER VR', () => {
  it('is two rows on a monitor, START first, its id the hangar row’s', () => {
    const rows = titleRows(flat())
    expect(ids(rows)).toEqual([START_ROW.id, ENTER_VR_ROW_ID])
    expect(rows.map((r) => r.label)).toEqual(['Start', 'Connect VR headset'])
    // START keeps the hangar row's id: it goes where that row went.
    expect(START_ROW.id).toBe('hangar')
    // DEV-619 (Matt, 2026-10-03: "let's remove "-Fly-" from the title screen
    // menu panel"): no heading, drawn or reported.
    expect(TITLE_MENU_HEADING).toBe('')
  })

  it('DEV-619: the plate has no heading band, so it closes up around its rows', () => {
    expect(TITLE_MENU_PLATE.heading).toBe(false)
    expect(TITLE_MENU_BAND_M).toBe(HEADLESS_TITLE_M)
    // Shorter than a plate with its heading by exactly the band it lost.
    expect(panelHeight(2) - panelHeight(2, TITLE_MENU_BAND_M)).toBeGreaterThan(0.05)
  })

  it('opens aimed at START', () => {
    expect(titleOpeningAim(titleRows(flat()))).toBe(0)
  })

  it('names ENTER VR in Matt’s words for every state, the plate’s note under it', () => {
    const states: TitleVrState[] = [
      'enter',
      'connect',
      'checking',
      'starting',
      'needs-key',
      'refused',
      'off',
    ]
    for (const state of states) {
      const row = enterVrRow(state)
      expect(row.id, state).toBe(ENTER_VR_ROW_ID)
      expect(row.label, state).toBe(titleVrText(state).label)
      expect(row.note, state).toBe(titleVrText(state).note)
    }
    expect(enterVrRow('enter').label).toBe('Enter VR')
    expect(enterVrRow('connect').label).toBe('Connect VR headset')
  })

  it('keeps DEV-557’s gamepad note on the row, in the accent', () => {
    // A gamepad press is not an activation-triggering input: a pad cannot
    // start a session, and the row says what will.
    const row = enterVrRow('needs-key')
    expect(row.note).toBe('a pad cannot: press H, or click')
    expect(row.accentNote).toBe(true)
    expect(enterVrRow('enter').accentNote ?? false).toBe(false)
  })

  it('is START alone where ENTER VR stands nowhere: a phone, or in a headset', () => {
    // `titleVrShown` is the rule; `app.ts` passes `vr: null` when it says no.
    expect(titleVrShown({ presenting: false, touch: true, state: 'connect' })).toBe(false)
    expect(titleVrShown({ presenting: true, touch: false, state: 'enter' })).toBe(false)
    expect(titleVrShown({ presenting: false, touch: false, state: 'connect' })).toBe(true)
    expect(ids(titleRows(flat({ vr: null })))).toEqual([START_ROW.id])
  })

  it('puts a link’s row first and aims it: a shared lap', () => {
    const ghost = ghostRaceRow('Bold Heron 77', 61.44, 'speed')
    expect(ghost.id).toBe(QUICK_RACE_ROW_ID)
    expect(ghost.value).toBe('Bold Heron 77')
    // DEV-571: in a stranger's words: what pressing it does, not "a ghost".
    expect(ghost.label).toBe('Race this lap')
    expect(ghost.note).toBe('fly against their 61.4 s, speed jet')
    const rows = titleRows(flat({ link: ghost }))
    expect(ids(rows)).toEqual([QUICK_RACE_ROW_ID, START_ROW.id, ENTER_VR_ROW_ID])
    expect(titleOpeningAim(rows)).toBe(0)
  })

  it('asks WATCH or RACE of a shared lap where the build can watch, aimed at RACE (DEV-571)', () => {
    const race = ghostRaceRow('Bold Heron 77', 61.44, 'speed')
    const watch = ghostWatchRow('Bold Heron 77', 61.44)
    expect(watch).toMatchObject({
      id: WATCH_LAP_ROW_ID,
      label: 'Watch this lap',
      value: 'Bold Heron 77',
      note: 'see their 61.4 s flown, on FF-TV',
    })
    const rows = titleRows(flat({ link: race, watch }))
    expect(ids(rows)).toEqual([QUICK_RACE_ROW_ID, WATCH_LAP_ROW_ID, START_ROW.id, ENTER_VR_ROW_ID])
    expect(titleOpeningAim(rows), 'one press is still the race the link was sent for').toBe(0)
    // A WATCH with no lap's row is nobody's: never drawn alone.
    expect(ids(titleRows(flat({ watch })))).toEqual([START_ROW.id, ENTER_VR_ROW_ID])
  })

  it('a shared course is its own row, aimed; a refused one is read, and START is aimed', () => {
    const course = courseRow({ id: 'pc_a', name: 'Amber Heron', place: 'Kauai', source: 'link' })
    expect(titleOpeningAim(titleRows(flat({ link: course })))).toBe(0)
    const refused = courseRefusedRow('link', 'is not a course')
    const rows = titleRows(flat({ link: refused }))
    expect(ids(rows)).toEqual([COURSE_REFUSED_ROW_ID, START_ROW.id, ENTER_VR_ROW_ID])
    expect(titleOpeningAim(rows)).toBe(1)
  })

  it('says a room link’s lobby, or a refused link, on START, in the accent; nothing moves', () => {
    const rows = titleRows(
      flat({ start: { note: 'room K7Q X4M2: its lobby is in the hangar', accent: true } }),
    )
    expect(ids(rows)).toEqual([START_ROW.id, ENTER_VR_ROW_ID])
    expect(rows[0]?.note).toContain('K7Q X4M2')
    expect(rows[0]?.accentNote).toBe(true)
    expect(rows[0]?.label).toBe('Start')
    expect(titleRows(flat())[0]).toBe(START_ROW)
  })

  it('never holds more than its cap', () => {
    const most = titleRows(
      flat({ link: ghostRaceRow('A', 60, 'standard'), watch: ghostWatchRow('A', 60) }),
    )
    expect(most.length).toBe(TITLE_MENU_MAX_ROWS)
    expect(new Set(ids(most)).size).toBe(most.length)
  })
})

describe('where the plate hangs', () => {
  const extent = titleMenuExtent()

  it('ends inside the flat frame at its most rows, with room to spare', () => {
    expect(-titleMenuExtent(TITLE_MENU_MAX_ROWS).bottomDeg).toBeLessThan(FLAT_VFOV / 2 - 3)
  })

  it('a fourth row shrinks the plate to end where three do; three or fewer are drawn as before (DEV-571)', () => {
    expect(titleMenuScale(3)).toBe(1.6)
    expect(titleMenuScale(2)).toBe(1.6)
    expect(titleMenuScale(4)).toBeLessThan(1.6)
    expect(titleMenuExtent(4).bottomDeg).toBeCloseTo(titleMenuExtent(3).bottomDeg, 9)
    expect(titleMenuExtent(4).topDeg).toBeCloseTo(titleMenuExtent(3).topDeg, 9)
  })

  it('is 1.4 times larger on a flat screen and exactly as it was in a headset (DEV-648)', () => {
    expect(TITLE_MENU_FLAT_BOOST).toBe(1.4)
    expect(titleMenuScale(3)).toBe(1.6)
    expect(titleMenuScale(3, false)).toBe(1.6)
    expect(titleMenuScale(3, true)).toBeCloseTo(1.6 * 1.4, 12)
    // The top edge does not move; the plate grows down and out, and still ends
    // inside the flat frame at its most rows.
    expect(titleMenuExtent(3, true).topDeg).toBeCloseTo(titleMenuExtent(3).topDeg, 9)
    expect(-titleMenuExtent(TITLE_MENU_MAX_ROWS, true).bottomDeg).toBeLessThan(FLAT_VFOV / 2 - 3)
    // A fourth row still ends where three do, boosted or not.
    expect(titleMenuExtent(4, true).bottomDeg).toBeCloseTo(titleMenuExtent(3, true).bottomDeg, 9)
  })

  it('starts below the line under the emblem', () => {
    expect(-extent.topDeg).toBeGreaterThan(PROMPT_LOWER_EDGE_DEG)
  })

  it('fits the width of a portrait phone', () => {
    // 9 : 19.5 at the same 70-degree vertical lens. Matt plays on a phone,
    // portrait-first.
    const halfWidth =
      (Math.atan(Math.tan(((FLAT_VFOV / 2) * Math.PI) / 180) * (9 / 19.5)) * 180) / Math.PI
    expect(extent.halfWidthDeg).toBeLessThan(halfWidth)
  })
})

describe('what a ray from the eye hits', () => {
  const plate = new THREE.Object3D()
  placeTitleMenu(plate)
  plate.updateMatrixWorld(true)
  const inverse = plate.matrixWorld.clone().invert()
  const eye = new THREE.Vector3(0, 0, 0)
  const rows = titleRows(flat())

  const hit = (direction: THREE.Vector3): number => {
    const o = eye.clone().applyMatrix4(inverse)
    const d = direction.clone().transformDirection(inverse)
    return pickLocal(o.x, o.y, o.z, d.x, d.y, d.z, rows.length, TITLE_MENU_BAND_M)
  }

  it('misses along the flat camera axis, so the keys keep what they chose', () => {
    expect(hit(new THREE.Vector3(0, 0, -1))).toBe(-1)
  })

  it('lands on each row through that row centre, ENTER VR included', () => {
    rows.forEach((_, i) => {
      const centre = new THREE.Vector3(0, rowCentreLocalY(i, rows.length, TITLE_MENU_BAND_M), 0)
      plate.localToWorld(centre)
      expect(hit(centre.sub(eye)), `row ${i}`).toBe(i)
    })
  })
})
