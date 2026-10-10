// T28, the pocket editor. DEV-522 (docs/plan/MAKING-OF.md §4).
//
// A course in the game is a recipe, not a list of rings: a few control points,
// a spacing, a start and a finish. The game's own editor core (`editor/core`)
// holds the draft and its commands, `evaluateDraft` expands it through the
// one door every player course goes through and reports what is wrong, and
// `courseLink` packs it into the link you share. This toy is those three
// functions with a top-down canvas over `int_01_hoverJet`'s play area.
//
// What it leaves out, said plainly in the chapter: the ground. The real
// editor judges rings against the island's surface; here there is no terrain
// loaded, so the ground warnings (a buried ring, a line under a hill) cannot
// fire, and every point sits at the height of the course's first one.

import type { Level, Vec3Tuple } from '@/content/level-schema'
import { liveRings, validateLevel } from '@/content/level-schema'
import { PLAYER_COURSE_LIMITS, playerCourseArea, randomCourseName } from '@/content/player-course'
import { courseLink } from '@/content/player-course-wire'
import { addPoint, deletePoint, movePoint, setGap } from '@/editor/core/commands'
import { type EditorDraft, newDraft } from '@/editor/core/draft'
import { type DraftEvaluation, evaluateDraft, NO_GROUND } from '@/editor/core/warnings'
import raw from '../../../content/levels/int_01_hoverJet.json'
import { createCanvas2D } from '../shared/canvas2d'
import type { ToyDef } from '../shared/toy-host'

const PICK_PX = 14

/** A course's name is a handle-list pair, as the editor deals one. */
const dealName = () => randomCourseName((n) => Math.floor(Math.random() * n))

export const toy: ToyDef = {
  id: 'pocket-editor',
  title: 'Pocket editor',
  caption:
    'Tap to add a control point, drag one to move it. The rings, the warnings and the share link are all the game’s own.',
  kind: '2d',
  mount({ stage, controls }) {
    const donor = validateLevel(raw as unknown as Level)
    const area = playerCourseArea(donor)
    let draft: EditorDraft = newDraft(donor, dealName())
    let evaluation: DraftEvaluation = evaluateDraft(draft, donor, NO_GROUND)
    let linkLength: number | null = null
    let dragging: number | null = null
    let linkSeq = 0
    const cv = createCanvas2D(stage)
    const out = controls.readouts()

    const height = (): number => draft.course.path.points[0]?.[1] ?? donor.spawn.pos[1] ?? 0

    // The view: the play area if the donor has one, else the donor's rings.
    const frame = () => {
      let cx = 0
      let cz = 0
      let r = 1000
      if (area?.kind === 'sphere') {
        cx = area.centre[0]
        cz = area.centre[2]
        r = area.radius
      } else if (area?.kind === 'box') {
        cx = (area.min[0] + area.max[0]) / 2
        cz = (area.min[2] + area.max[2]) / 2
        r = Math.max(area.max[0] - area.min[0], area.max[2] - area.min[2]) / 2
      }
      const s = (Math.min(cv.width, cv.height) * 0.48) / r
      return {
        s,
        r,
        cx,
        cz,
        px: (x: number) => cv.width / 2 + (x - cx) * s,
        pz: (z: number) => cv.height / 2 + (z - cz) * s,
        wx: (px: number) => cx + (px - cv.width / 2) / s,
        wz: (pz: number) => cz + (pz - cv.height / 2) / s,
      }
    }

    const refresh = () => {
      evaluation = evaluateDraft(draft, donor, NO_GROUND)
      const seq = ++linkSeq
      const course = evaluation.course
      if (!course) linkLength = null
      else
        void courseLink(course, location.origin).then(
          (link) => {
            if (seq === linkSeq) {
              linkLength = link.length
              readouts()
            }
          },
          () => {
            if (seq === linkSeq) linkLength = null
          },
        )
      readouts()
      draw()
    }

    const readouts = () => {
      const level = evaluation.level
      const errors = evaluation.warnings.filter((w) => w.severity === 'error')
      const first = evaluation.warnings[0]
      out.update([
        { label: 'points', value: String(draft.course.path.points.length) },
        { label: 'rings', value: level ? String(liveRings(level).length) : 'none yet' },
        {
          label: 'share link',
          value: linkLength === null ? 'not shareable yet' : `${linkLength} characters`,
          tone: linkLength === null ? 'bad' : 'good',
        },
        ...(first
          ? [
              errors.length
                ? { label: 'refused', value: first.message, tone: 'bad' as const }
                : { label: first.severity, value: first.message },
            ]
          : []),
      ])
    }

    const draw = () => {
      const { ctx, width: w, height: h } = cv
      const v = frame()
      ctx.clearRect(0, 0, w, h)
      ctx.beginPath()
      ctx.arc(w / 2, h / 2, v.r * v.s, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(111,180,255,0.06)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(111,180,255,0.4)'
      ctx.stroke()
      const level = evaluation.level
      const route = level?.route as readonly (readonly number[])[] | undefined
      if (route && route.length > 1) {
        ctx.beginPath()
        route.forEach((p, i) => {
          const X = v.px(p[0] as number)
          const Z = v.pz(p[2] as number)
          if (i === 0) ctx.moveTo(X, Z)
          else ctx.lineTo(X, Z)
        })
        ctx.strokeStyle = 'rgba(194,200,229,0.5)'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      if (level) {
        for (const ring of liveRings(level)) {
          ctx.beginPath()
          ctx.arc(v.px(ring.pos[0]), v.pz(ring.pos[2]), 4, 0, Math.PI * 2)
          ctx.strokeStyle = '#facf63'
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }
      const start = draft.course.start.pos
      ctx.fillStyle = '#7ee0a4'
      ctx.fillRect(v.px(start[0]) - 5, v.pz(start[2]) - 5, 10, 10)
      draft.course.path.points.forEach((p, i) => {
        ctx.beginPath()
        ctx.arc(v.px(p[0]), v.pz(p[2]), 6, 0, Math.PI * 2)
        ctx.fillStyle = i === draft.selection ? '#ffffff' : '#6fb4ff'
        ctx.fill()
      })
      for (const warning of evaluation.warnings) {
        if (!warning.at) continue
        ctx.beginPath()
        ctx.arc(v.px(warning.at[0]), v.pz(warning.at[2]), 10, 0, Math.PI * 2)
        ctx.strokeStyle = warning.severity === 'error' ? '#ff7a7a' : 'rgba(255,122,122,0.5)'
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.lineWidth = 1
    }

    const pointAt = (px: number, pz: number): number | null => {
      const v = frame()
      let best: number | null = null
      let bestD = PICK_PX
      draft.course.path.points.forEach((p, i) => {
        const d = Math.hypot(v.px(p[0]) - px, v.pz(p[2]) - pz)
        if (d < bestD) {
          bestD = d
          best = i
        }
      })
      return best
    }
    const local = (e: PointerEvent) => {
      const r = cv.canvas.getBoundingClientRect()
      return [e.clientX - r.left, e.clientY - r.top] as const
    }
    const toWorld = (px: number, pz: number): Vec3Tuple => {
      const v = frame()
      return [v.wx(px), height(), v.wz(pz)]
    }
    cv.canvas.addEventListener('pointerdown', (e) => {
      const [x, z] = local(e)
      const hit = pointAt(x, z)
      if (hit !== null) {
        dragging = hit
        cv.canvas.setPointerCapture(e.pointerId)
        return
      }
      draft = addPoint(draft, toWorld(x, z))
      refresh()
    })
    cv.canvas.addEventListener('pointermove', (e) => {
      if (dragging === null) return
      const [x, z] = local(e)
      draft = movePoint(draft, dragging, toWorld(x, z))
      refresh()
    })
    cv.canvas.addEventListener('pointerup', () => {
      dragging = null
    })

    controls.slider({
      label: 'ring spacing',
      min: PLAYER_COURSE_LIMITS.gapMetres.min,
      max: PLAYER_COURSE_LIMITS.gapMetres.max,
      step: 10,
      value: draft.course.path.gap,
      format: (v) => `${v} m`,
      onInput: (v) => {
        draft = setGap(draft, v)
        refresh()
      },
    })
    controls.button('delete last point', () => {
      const n = draft.course.path.points.length
      if (n > 1) {
        draft = deletePoint(draft, n - 1)
        refresh()
      }
    })
    controls.button('start again', () => {
      draft = newDraft(donor, dealName())
      refresh()
    })
    refresh()
    return {
      resize: (w, h) => {
        cv.resize(w, h)
        draw()
      },
      dispose: () => cv.dispose(),
    }
  },
}
