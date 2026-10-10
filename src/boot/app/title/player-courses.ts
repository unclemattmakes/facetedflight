// src/boot/app/title/player-courses.ts: player courses in, out of `bootApp`.
// APP-SPLIT phase 4, slice 5 (title; `docs/plan/APP-SPLIT.md` §5).
//
// DEV-467's block, whole: a `#c=` link, a picked or dropped file, CUSTOM
// COURSES (the library, its map store and the ground a course stands on), and
// a player course's own results panel and Share. Every line below was moved
// verbatim from the closure; the plumbing is `ctx.x` where the code reads a
// binding the closure still owns (a getter, so a check narrows as the
// closure's `let` did, and a setter where this code writes one: the §6 rule 3
// bag), and the returned object, which hands the closure what it still calls.

import type { Capabilities } from '@/boot/capability-gate'
import type { Edition } from '@/content/edition-schema'
import type { Level } from '@/content/level-schema'
import { courseGround, loadPlayerCourse } from '@/content/load-player-course'
import { isMapIsland, type PlayerCourse, PlayerCourseError } from '@/content/player-course'
import {
  courseFile,
  courseFileCap,
  courseFileName,
  courseLink,
  courseTokenIn,
  fileTooLarge,
  linkRefusal,
  PLAYER_COURSE_WIRE,
  readCourseFile,
  readCourseToken,
} from '@/content/player-course-wire'
import {
  type CourseLibrary,
  type CourseSource,
  courseTitle,
  type LibraryEntry,
  openCourseLibrary,
} from '@/game/course-library'
import {
  COURSE_SHARE_IDLE,
  type CourseShareState,
  courseCopied,
  coursePanel,
  pressCourseSave,
  pressCourseShare,
} from '@/game/course-share'
import type { Flight } from '@/game/flight'
import { environmentDisplayName } from '@/game/mission-index'
import type { CustomGround } from '@/game/terrain/custom-ground'
import type { TvView } from '@/game/tv/tv-view'
import { createEdge } from '@/input/edge'
import {
  MAKE_A_COURSE_ACTION,
  MAKE_A_COURSE_PHONE_ACTION,
  OPEN_COURSE_FILE_ACTION,
  type ShelfAction,
} from '@/render/course-shelf'
import type { PauseOption } from '@/render/pause'
import type { Renderer } from '@/render/renderer'
import type { RunSummary } from '@/render/results'
import {
  COURSE_REFUSED_ROW_ID,
  courseOfRow,
  courseRefusedRow,
  courseRow,
} from '@/render/title-menu'

/** What `createPlayerCourses` reads from the closure: getters, each read live (APP-SPLIT §3's `ctx`). */
export interface PlayerCoursesCtx {
  readonly beginLoadingTarget: (target: Level) => void
  readonly capabilities: Capabilities
  readonly flight: Flight | null
  readonly goToScreen: (
    to: 'menu' | 'mission' | 'title',
    opts?: {
      readonly outSeconds?: number
      readonly inSeconds?: number
      readonly holdSeconds?: number
      readonly act?: () => void
    },
  ) => void
  readonly lastResult: RunSummary | null
  readonly level: Level
  /** APP-SPLIT: bag, owner in phase 3 (written here). */
  loadingScenePending: boolean
  readonly menuEdition: Edition | null
  readonly menuEditionLoad: Promise<Edition>
  readonly paused: boolean
  readonly quickRaceAsked: boolean
  readonly render: Renderer
  readonly roomClose: () => void
  readonly screen: 'title' | 'menu' | 'mission'
  readonly shareRoute: () => 'flat' | 'xr'
  readonly switchMission: (
    id: string,
    opts?: { readonly skipRide?: boolean; readonly inLoadingScene?: Level; readonly level?: Level },
  ) => Promise<void>
  readonly switching: boolean
  readonly tvView: TvView
}

export const createPlayerCourses = (ctx: PlayerCoursesCtx) => {
  // ── DEV-467: player courses in: a `#c=` link, a picked or dropped file, and CUSTOM COURSES ──
  //
  // docs/plan/EDITOR.md §5.2 and §5.6; the wire is `content/player-course-wire.ts`,
  // the list `game/course-library.ts`. Gated on the MENUS' preset's
  // `gameplay.editor` (DEV-466; it ships since DEV-470, D36), never on the
  // edition the player chose (D35): a build without the editor reads no
  // fragment, offers no table and takes no drop.
  //
  // A course comes in by three doors and leaves by one:
  //   · a LINK (`#c=ffc1.…`) is read at boot, checked against its donor, kept
  //     in the library, and the title opens on ITS row (DEV-558; on the list
  //     page until then): one press flies it, as a lap's link aims Race a
  //     Ghost (DEV-373). A link that cannot be read says why in that row;
  //     nothing throws.
  //   · a FILE, picked (the Custom Courses shelf's OPEN A COURSE FILE, in the
  //     hangar since DEV-558) or dropped anywhere on the window while the title
  //     or the hangar is up, is read (its size asked first), kept, and flown at
  //     once: the press that picked it was the press that chose it. A refusal
  //     is said on that table.
  //   · a table of the Custom Courses shelf (DEV-488) flies the course it names.
  // From the title a course flies by one fade into the loading scene, then
  // `switchMission(id, { inLoadingScene })`; from the hangar it is loaded IN
  // the room (DEV-465), as a shipped course is. The fragment is cleared at
  // that press, so a reload does not fly it again; the library still lists it.
  // (Matt, 2026-10-01: *"change "your courses" to "custom courses""*.)
  const editorOn = (): boolean => ctx.menuEdition?.gameplay.editor.enabled ?? false
  /** The courses flown this page, by id: what COPY LINK and SAVE FILE share (`coursePanel`). */
  const playerCourses = new Map<string, PlayerCourse>()
  /** Its entries, newest first, as the shelf lists them. Read after every put. */
  let courseEntries: readonly LibraryEntry[] = []
  /** A link's or a file's refusal, said on the title's row or the shelf's file table; null when nothing was refused. */
  let courseRefusal: { readonly from: 'link' | 'file'; readonly reason: string } | null = null
  /** The course a `#c=` link named, once it is read and kept: the title's first row (DEV-558). */
  let courseLinkId: string | null = null
  /** A course has been pressed on the title: it is on its way out, and a second press is spent. */
  let playerCourseAsked = false
  const COURSE_TOKEN = courseTokenIn(location.hash)
  /**
   * The library (IndexedDB, or memory where it will not open), opened on first
   * use — which is only ever on a build with the editor.
   */
  let courseLibraryOpen: Promise<CourseLibrary> | null = null
  const courseLibrary = (): Promise<CourseLibrary> => {
    courseLibraryOpen ??= openCourseLibrary().then((lib) => {
      if (!lib.durable)
        console.info('courses: no IndexedDB here; this session keeps them in memory')
      return lib
    })
    return courseLibraryOpen
  }
  const readCourseEntries = async (): Promise<void> => {
    courseEntries = await (await courseLibrary()).list()
    document.body.dataset.courseLibrary = String(courseEntries.length)
  }
  /** Keep a course in the library, and list it. Never throws. */
  /**
   * DEV-490: the ground `course` stands on — null on its sky's own island —
   * its map the bytes given, or else the library's copy.
   */
  const groundOfCourse = async (
    course: PlayerCourse,
    map: Uint8Array | null = null,
  ): Promise<CustomGround | null> => {
    const g = course.ground
    // DEV-493: a seeded island is made again from its numbers; no bytes to find.
    if (!isMapIsland(g)) return g ? courseGround(course, null) : null
    return courseGround(course, map ?? (await (await courseLibrary()).getMap(g.map)))
  }
  /** DEV-490: keep a map's bytes in the library under their SHA-256. */
  const keepMap = async (sha: string, bytes: Uint8Array): Promise<boolean> =>
    (await courseLibrary()).putMap(sha, bytes)
  const keepCourse = async (
    course: PlayerCourse,
    source: CourseSource,
    map: Uint8Array | null = null,
  ): Promise<void> => {
    // DEV-490: the map first, so a listed course always has its ground.
    if (map && isMapIsland(course.ground)) await keepMap(course.ground.map, map)
    try {
      await (await courseLibrary()).put(course, source)
      await readCourseEntries()
    } catch (err: unknown) {
      console.warn('courses: could not keep the course', err)
    }
  }
  /** The first reason a refusal gives, short enough for a row's note. */
  const refusalText = (err: unknown): string => {
    const first = err instanceof PlayerCourseError ? err.errors[0] : null
    const text = first ? `${first[0] ? `${first[0]} ` : ''}${first[1]}` : 'could not be read'
    return text.length > 60 ? `${text.slice(0, 57)}...` : text
  }
  const refuseCourse = (from: 'link' | 'file', err: unknown): void => {
    courseRefusal = { from, reason: refusalText(err) }
    document.body.dataset[from === 'link' ? 'courseLink' : 'courseFile'] = 'refused'
    console.warn(`courses: the ${from} was refused — ${courseRefusal.reason}`)
  }
  /** Drop the course from the address bar, keeping everything else in it. */
  const clearCourseFragment = (): void => {
    if (courseTokenIn(location.hash) === null) return
    try {
      history.replaceState(history.state, '', `${location.pathname}${location.search}`)
    } catch {
      // A sandboxed frame; the link just stays in the bar.
    }
  }
  /**
   * Fly a course: check it against its donor, keep it, and go. From the title,
   * one fade into the loading scene (a link's row, or a dropped file); from the
   * hangar (DEV-558: the shelf's OPEN A COURSE FILE, or a dropped file), loaded
   * in the room, as the shelf's own tables are (DEV-465). A refusal is said
   * where the press came from: the title's row, or the shelf's file table.
   */
  const flyPlayerCourse = (
    course: PlayerCourse,
    source: CourseSource,
    map: Uint8Array | null = null,
  ): void => {
    if (ctx.switching) return
    if (ctx.screen === 'title') {
      if (playerCourseAsked || ctx.quickRaceAsked || ctx.tvView.asked()) return
    } else if (ctx.screen !== 'menu') return
    const fromRoom = ctx.screen === 'menu'
    playerCourseAsked = true
    // DEV-389: flying anything else is leaving a room a link joined.
    ctx.roomClose()
    void (async () => {
      try {
        // DEV-490: over its own island when it has one.
        const next = await loadPlayerCourse(course, { ground: await groundOfCourse(course, map) })
        await keepCourse(course, source, map)
        playerCourses.set(next.id, course)
        clearCourseFragment()
        document.body.dataset.playerCourse = next.id
        console.info(`courses: flying ${next.id} (${next.title}, ${source})`)
        if (fromRoom) {
          // In the room, as a shipped course is boarded from a table.
          void ctx.switchMission(next.id, { level: next }).finally(() => {
            playerCourseAsked = false
          })
          return
        }
        ctx.goToScreen('menu', {
          act: () => {
            ctx.beginLoadingTarget(next)
            ctx.loadingScenePending = true
            void ctx.switchMission(next.id, { inLoadingScene: next })
          },
        })
      } catch (err: unknown) {
        playerCourseAsked = false
        refuseCourse(source === 'link' ? 'link' : 'file', err)
      }
    })()
  }
  /** A `.ffcourse`, picked or dropped: its size asked BEFORE it is read. */
  const takeCourseFile = async (file: File): Promise<void> => {
    try {
      if (fileTooLarge(file.size)) {
        throw new PlayerCourseError([['file', `is larger than ${courseFileCap} bytes`]])
      }
      const read = await readCourseFile(new Uint8Array(await file.arrayBuffer()))
      if (!read.ok) throw new PlayerCourseError(read.errors)
      courseRefusal = null
      document.body.dataset.courseFile = 'read'
      // On the title or in the hangar it flies; anywhere else it is kept for the shelf.
      if (ctx.screen === 'title' || ctx.screen === 'menu')
        flyPlayerCourse(read.course, 'file', read.map)
      else await keepCourse(read.course, 'file', read.map)
    } catch (err: unknown) {
      refuseCourse('file', err)
    }
  }
  /** The picker. Made once the editor is known to be on; a spec answers it with `filechooser`. */
  let courseFileInput: HTMLInputElement | null = null
  const openCourseFilePicker = (): void => {
    if (!courseFileInput) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = PLAYER_COURSE_WIRE.fileExtension
      input.id = 'course-file'
      input.hidden = true
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        input.value = ''
        if (file) void takeCourseFile(file)
      })
      document.body.append(input)
      courseFileInput = input
    }
    courseFileInput.click()
  }
  void ctx.menuEditionLoad.then(() => {
    if (!editorOn()) {
      if (COURSE_TOKEN !== null) {
        document.body.dataset.courseLink = 'off'
        console.info('courses: this build has no player courses; the link is not read')
      }
      return
    }
    void readCourseEntries()
    // A drop anywhere on the window, while the title or the hangar is up
    // (DEV-558: the hangar holds the file table now). `dragover` must be
    // cancelled for the drop to be delivered at all.
    const carriesFiles = (e: DragEvent): boolean =>
      e.dataTransfer?.types.includes('Files') === true &&
      (ctx.screen === 'title' || ctx.screen === 'menu')
    globalThis.addEventListener('dragover', (e) => {
      if (carriesFiles(e)) e.preventDefault()
    })
    globalThis.addEventListener('drop', (e) => {
      if (!carriesFiles(e)) return
      e.preventDefault()
      const file = e.dataTransfer?.files[0]
      if (file) void takeCourseFile(file)
    })
    if (COURSE_TOKEN === null) return
    document.body.dataset.courseLink = 'reading'
    void (async () => {
      try {
        const read = await readCourseToken(COURSE_TOKEN)
        if (!read.ok) throw new PlayerCourseError(read.errors)
        // The donor's half of the check, before the course is listed.
        // DEV-493: a link's seeded island is built to check the course against it.
        const level = await loadPlayerCourse(read.course, {
          ground: await groundOfCourse(read.course),
        })
        await keepCourse(read.course, 'link')
        // DEV-558: the title's first row, aimed (`titleRows`).
        courseLinkId = level.id
        document.body.dataset.courseLink = level.id
        console.info(`courses: a link to ${level.id} (${level.title})`)
      } catch (err: unknown) {
        refuseCourse('link', err)
      }
    })()
  })
  /**
   * DEV-558: the title's row for a course LINK: the course, once it is read
   * and kept, or why it was refused; null where there is no link (or no editor).
   */
  const courseLinkRow = (): PauseOption | null => {
    if (!editorOn()) return null
    if (courseLinkId !== null) {
      const entry = courseEntries.find((e) => e.id === courseLinkId)
      return entry
        ? courseRow({
            id: entry.id,
            name: entry.name,
            place: environmentDisplayName(entry.island),
            source: entry.source,
          })
        : null
    }
    return courseRefusal?.from === 'link' ? courseRefusedRow('link', courseRefusal.reason) : null
  }
  /**
   * The title's press of a course row (DEV-558: the link's own), or false for
   * any other row. The refusal is a row to read, not to press.
   */
  const titleCoursePress = (row: string | undefined): boolean => {
    if (!editorOn() || row === undefined) return false
    if (row === COURSE_REFUSED_ROW_ID) return true
    const id = courseOfRow(row)
    if (id === null) return false
    const entry = courseEntries.find((e) => e.id === id)
    if (entry) flyPlayerCourse(entry.course, entry.source)
    return true
  }
  /**
   * DEV-558: the Custom Courses shelf's two action tables, the COURSES hub's
   * rows moved off the title: OPEN A COURSE FILE (not in a headset, where a
   * file dialog cannot be seen; its note says a refusal) and MAKE A COURSE
   * (DEV-469: a desktop, not a headset and not a phone).
   */
  const shelfActions = (): readonly ShelfAction[] => {
    if (!editorOn()) return []
    const presenting = ctx.render.renderer.xr.isPresenting
    const refused = courseRefusal?.from === 'file' ? courseRefusal.reason : null
    return [
      // DEV-878: a phone is told the editor needs a computer, not left without the row.
      ...(!presenting
        ? [ctx.capabilities.touch ? MAKE_A_COURSE_PHONE_ACTION : MAKE_A_COURSE_ACTION]
        : []),
      ...(!presenting
        ? [
            refused === null
              ? OPEN_COURSE_FILE_ACTION
              : { ...OPEN_COURSE_FILE_ACTION, note: `refused: ${refused}`, refused: true },
          ]
        : []),
    ]
  }
  // The results panel of a player course: COPY LINK and SAVE FILE
  // (`game/course-share.ts`). Its laps are local (`LOCAL_LAP_RULES`), so
  // Share never offers itself there (`shareable`), and its button shares the
  // COURSE instead; the race button saves the file while the choice is up.
  let courseShare: CourseShareState = COURSE_SHARE_IDLE
  /** The run `courseShare` belongs to: a new run on the panel starts idle. */
  let courseShareRun: RunSummary | null = null
  const courseShareKey = createEdge()
  const courseSaveKey = createEdge()
  /** The course being flown, when it is a player course and the build has the editor. */
  const playerCourseNow = (): PlayerCourse | null =>
    editorOn() ? (playerCourses.get(ctx.level.id) ?? null) : null
  const courseShareNow = (): CourseShareState => {
    if (courseShareRun !== ctx.lastResult) {
      courseShareRun = ctx.lastResult
      courseShare = COURSE_SHARE_IDLE
    }
    return courseShare
  }
  /** The panel with this block's prompts, or null when the run is not a player course's. */
  const coursePanelOf = (summary: RunSummary): RunSummary | null => {
    const course = playerCourseNow()
    if (!course || !ctx.lastResult) return null
    const panel = coursePanel(
      courseShareNow(),
      ctx.shareRoute(),
      { again: summary.again, race: summary.race ?? '', back: summary.back },
      courseTitle(course),
    )
    return {
      ...summary,
      again: panel.again,
      race: panel.race,
      back: panel.back,
      share: panel.block,
    }
  }
  const copyCourseLink = async (course: PlayerCourse): Promise<void> => {
    const run = ctx.lastResult
    // DEV-490: an imported island has no link, nor (DEV-533) a course past a
    // link's 128 props; the panel says so, and SAVE FILE is beside it.
    const noLink = linkRefusal(course)
    if (noLink) {
      courseShare = courseCopied(courseShare, '', false, noLink.short)
      document.body.dataset.courseShare = courseShare.phase
      console.info(`courses: ${noLink.why}`)
      return
    }
    // The page's own address, bare: a course link carries no switches.
    const link = await courseLink(course, `${location.origin}${location.pathname}`)
    document.body.dataset.courseShareLink = link
    let ok = true
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      ok = false
    }
    if (courseShareRun !== run) return
    courseShare = courseCopied(courseShare, link, ok)
    document.body.dataset.courseShare = courseShare.phase
    console.info(`courses: ${ok ? 'copied' : 'could not copy'} a ${link.length}-character link`)
  }
  const saveCourseFile = async (course: PlayerCourse): Promise<void> => {
    // DEV-490: an imported island's map rides in the file.
    const g = course.ground
    const map = isMapIsland(g) ? await (await courseLibrary()).getMap(g.map) : null
    if (isMapIsland(g) && !map) throw new Error('its heightmap is not in this browser')
    const bytes = await courseFile(course, map)
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], { type: 'application/octet-stream' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = courseFileName(course)
    document.body.append(a)
    a.click()
    a.remove()
    // Long enough for the browser to have taken the bytes.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    console.info(`courses: saved ${a.download}, ${bytes.length} bytes`)
  }
  /**
   * Every frame: the share and race buttons, as held, on a player course's
   * panel. True when the race press was this panel's (SAVE FILE), so "race
   * this lap" does not also take it.
   */
  const coursePanelPresses = (wantShare: boolean, wantRace: boolean): boolean => {
    const shareEdge = courseShareKey.step(wantShare)
    const raceEdge = courseSaveKey.step(wantRace)
    const course = playerCourseNow()
    if (!course || !ctx.lastResult || !ctx.flight || ctx.screen !== 'mission' || ctx.paused)
      return false
    let state = courseShareNow()
    let took = false
    if (raceEdge) {
      const saved = pressCourseSave(state, courseFileName(course))
      if (saved) {
        state = saved.next
        took = true
        void saveCourseFile(course)
      }
    }
    if (shareEdge && !took) {
      const pressed = pressCourseShare(state)
      state = pressed.next
      if (pressed.copy) void copyCourseLink(course)
    }
    courseShare = state
    document.body.dataset.courseShare = state.phase
    return took
  }
  return {
    coursePanelOf,
    playerCourseNow,
    editorOn,
    groundOfCourse,
    shelfActions,
    openCourseFilePicker,
    playerCourses,
    courseLinkRow,
    courseLibrary,
    keepCourse,
    keepMap,
    saveCourseFile,
    titleCoursePress,
    coursePanelPresses,
    get courseEntries() {
      return courseEntries
    },
    get courseLinkId() {
      return courseLinkId
    },
    get courseRefusal() {
      return courseRefusal
    },
    get playerCourseAsked() {
      return playerCourseAsked
    },
  }
}
