// src/editor/desk/prop-panel.ts — the panel's PROPS group: the library, and
// the picked prop's spin, scale and delete. DEV-504
// (docs/plan/EDITOR-PROPS.md, "Editor UI (desk)").
//
// Matt, 2026-09-28: *"ability to add hand-placed props (needs a prop library
// prob?)"*. Its own module on `light-panel.ts`'s pattern, so `panel.ts`
// carries one import, one line in each of its two types, and one line where
// the group is made, placed and drawn.
//
// The library is a list of NAMES grouped by place (`propGroups`), the base's
// own island first. Pick a name and the desk is PLACING it: every click on the
// ground drops one (a garden is several clicks), until Stop, Esc, or another
// tool. A placed prop is picked by clicking it in the world; the group then
// shows its heading, its scale and Delete. Plain DOM, holding no state:
// `render` draws what the desk says, and every control reports an intent.
import { buttonMaker, make, tipper } from '@/editor/ui/dom'

/** One line per control, as `PANEL_TIPS`; the e2e holds every control to having one. */
export const PROP_TIPS = {
  props: 'Props to place by hand: every tree, cactus, rock and spire the islands use.',
  'prop-kind': 'Pick this prop, then click the ground to place it. Each click places another.',
  'prop-stop': 'Stop placing (Esc).',
  'prop-yaw': 'Which way the picked prop faces, in degrees. Or press E and turn its ring.',
  'prop-spin': 'Turn the picked prop with the gizmo’s ring (E). Press again to move it.',
  'prop-scale':
    'The picked prop’s size, a quarter to four times the island’s. Or press R and drag a handle.',
  'prop-delete': 'Remove the picked prop (Delete).',
  'prop-done': 'Put the picked prop down (Esc).',
} as const

export type PropTipName = keyof typeof PROP_TIPS

export interface PropPanelState {
  /** The library by place, the base's island first: its display name and its props. */
  readonly groups: readonly {
    readonly place: string
    readonly entries: readonly { readonly id: string; readonly name: string }[]
  }[]
  /** The kind being placed, or null. */
  readonly placing: string | null
  /** The picked prop, or null. */
  readonly picked: {
    readonly index: number
    readonly name: string
    readonly yaw: number
    readonly scale: number
    readonly min: number
    readonly max: number
    /** The gizmo turns it rather than moves it. */
    readonly spinning: boolean
  } | null
  /** How many the course holds, and the most it may. */
  readonly count: number
  readonly max: number
  /** DEV-533: the most a LINK carries; past it the course is shared as a file. */
  readonly linkMax: number
  readonly busy: boolean
}

export interface PropPanelActions {
  /** Place this kind on the next clicks, or stop (null). */
  place(kind: string | null): void
  /** The picked prop's heading, degrees. */
  yaw(degrees: number): void
  /** The picked prop's scale. `live` while the slider is dragged: one undo step a drag. */
  scale(scale: number, live: boolean): void
  /** The gizmo turns the picked prop, or moves it. */
  spin(): void
  /** Remove the picked prop. */
  remove(): void
  /** Put the picked prop down. */
  done(): void
}

export interface PropGroup {
  readonly element: HTMLElement
  render(state: PropPanelState): void
}

export const createPropGroup = (actions: PropPanelActions): PropGroup => {
  const tip = tipper<PropTipName>(PROP_TIPS)
  const button = buttonMaker(tip)

  const summary = tip(make('summary', { textContent: 'Props' }), 'props')
  summary.style.cssText = 'cursor:pointer;color:#b8c6d4'
  const countEl = make('div', { className: 'readout' })
  countEl.dataset.editor = 'prop-count'
  const placingEl = make('div', { className: 'facts' })
  placingEl.dataset.editor = 'prop-placing'
  const stopB = button('prop-stop', 'Stop placing', () => actions.place(null))
  const placingRow = make('div', { className: 'buttons' }, placingEl, stopB)

  // ── the picked prop ──
  const pickedHead = make('div', { className: 'head' })
  pickedHead.dataset.editor = 'prop-picked'
  const yawIn = tip(
    make('input', { type: 'number', step: '1', min: '-180', max: '180' }),
    'prop-yaw',
  )
  let typingYaw = false
  yawIn.addEventListener('input', () => {
    typingYaw = true
  })
  yawIn.addEventListener('change', () => {
    typingYaw = false
    const v = Number.parseFloat(yawIn.value)
    if (Number.isFinite(v)) actions.yaw(v)
  })
  const scaleIn = tip(make('input', { type: 'range', step: '0.01' }), 'prop-scale')
  scaleIn.addEventListener('input', () => actions.scale(Number.parseFloat(scaleIn.value), true))
  scaleIn.addEventListener('change', () => actions.scale(Number.parseFloat(scaleIn.value), false))
  // As DEV-473's sliders: a mouse drag gives the keys back on release.
  scaleIn.addEventListener('pointerup', () => setTimeout(() => scaleIn.blur(), 0))
  const scaleOut = make('span', { className: 'readout' })
  const spinB = button('prop-spin', 'Spin', actions.spin)
  const deleteB = button('prop-delete', 'Delete prop', actions.remove)
  const doneB = button('prop-done', 'Done', actions.done)
  const pickedGroup = make(
    'div',
    { className: 'group' },
    pickedHead,
    make(
      'div',
      { className: 'sentence', title: PROP_TIPS['prop-yaw'] },
      make('span', { textContent: 'Faces' }),
      yawIn,
      make('span', { textContent: 'degrees' }),
    ),
    make(
      'div',
      { className: 'row' },
      make('label', { textContent: 'Size', title: PROP_TIPS['prop-scale'] }),
      scaleIn,
      scaleOut,
    ),
    make('div', { className: 'buttons' }, spinB, deleteB, doneB),
  )

  const list = make('div', { className: 'group' })
  list.dataset.editor = 'prop-library'
  const element = make(
    'details',
    { className: 'group' },
    summary,
    countEl,
    placingRow,
    pickedGroup,
    list,
  )
  element.dataset.editor = 'prop-group'

  let listKey = ''
  const kindButtons = new Map<string, HTMLButtonElement>()

  return {
    element,
    render(s) {
      const key = s.groups
        .map((g) => `${g.place}:${g.entries.map((e) => e.id).join(',')}`)
        .join('|')
      if (key !== listKey) {
        listKey = key
        kindButtons.clear()
        list.replaceChildren(
          ...s.groups.map((g) =>
            make(
              'div',
              { className: 'group' },
              make('div', { className: 'readout', textContent: g.place }),
              make(
                'div',
                { className: 'buttons' },
                ...g.entries.map((e) => {
                  const b = button('prop-kind', e.name, () => actions.place(e.id))
                  b.dataset.kind = e.id
                  b.style.cssText = 'padding:3px 7px;font-size:12px'
                  kindButtons.set(e.id, b)
                  return b
                }),
              ),
            ),
          ),
        )
      }
      for (const [id, b] of kindButtons) {
        b.disabled = s.busy || (s.count >= s.max && s.placing !== id)
        b.style.outline = s.placing === id ? '2px solid #7fd3ff' : ''
      }
      if (s.placing !== null || s.picked !== null) element.open = true
      // DEV-533: said as it happens, not only when Copy link is refused.
      countEl.textContent =
        s.count > s.linkMax
          ? `${s.count} of ${s.max} props placed · over ${s.linkMax}, share it as a file, not a link`
          : `${s.count} of ${s.max} props placed`
      const placingName = s.groups.flatMap((g) => g.entries).find((e) => e.id === s.placing)?.name
      placingRow.style.display = s.placing === null ? 'none' : ''
      placingEl.textContent = placingName ? `Click the ground to place: ${placingName}` : ''
      stopB.disabled = s.busy
      const p = s.picked
      pickedGroup.style.display = p ? '' : 'none'
      if (p) {
        pickedHead.textContent = `Prop ${p.index + 1}: ${p.name}`
        if (!typingYaw && yawIn.value !== String(p.yaw)) yawIn.value = String(p.yaw)
        scaleIn.min = String(p.min)
        scaleIn.max = String(p.max)
        if (scaleIn.value !== String(p.scale)) scaleIn.value = String(p.scale)
        scaleOut.textContent = `× ${p.scale.toFixed(2)}`
        spinB.textContent = p.spinning ? 'Move' : 'Spin'
      }
      for (const c of [yawIn, scaleIn, spinB, deleteB, doneB]) c.disabled = s.busy
      element.dataset.placing = s.placing ?? ''
      element.dataset.picked = p ? String(p.index) : ''
      element.dataset.count = String(s.count)
    },
  }
}
