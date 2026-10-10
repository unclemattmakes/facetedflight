// T30, the live window. DEV-511 (docs/plan/MAKING-OF.md §2.7, §4).
//
// Some things only the whole game can show. This is the whole game, in a
// frame, loaded only when the reader asks: it boots everything (the world, its
// assets, the shader warm-up), so it never loads on scroll. The switches are
// the game's own development switches, read in `boot/app/pins.ts` and
// `boot/switches.ts`.
//
// `xr=off` is not optional. Asking a browser whether it can enter VR starts the
// machine's OpenXR runtime, which on a SteamVR box launches Steam for every
// reader who loads this frame (CLAUDE.md).

import type { ToyDef } from '../shared/toy-host'

type Pilot = 'autopilot' | 'you'
type Look = 'anniversary' | 'classic'

/** The game's URL for a choice of switches. Exported so the e2e spec checks the same string. */
export const liveWindowUrl = (pilot: Pilot, look: Look): string => {
  const q = new URLSearchParams({ mission: 'int_01_hoverJet', title: '0', menu: '0', xr: 'off' })
  if (pilot === 'autopilot') q.set('autopilot', '1')
  q.set('edition', look)
  return `/?${q.toString()}`
}

export const toy: ToyDef = {
  id: 'live-window',
  title: 'The live window',
  caption:
    'The real game, in a frame. It loads only when you press the button, because it boots everything the game boots.',
  kind: '2d',
  mount({ stage, controls }) {
    let pilot: Pilot = 'autopilot'
    let look: Look = 'anniversary'
    const out = controls.readouts()
    const surface = document.createElement('div')
    surface.className = 'live-window'
    stage.append(surface)

    const idle = () => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'live-start'
      button.textContent = 'Load the game here'
      button.addEventListener('click', () => {
        const frame = document.createElement('iframe')
        frame.src = liveWindowUrl(pilot, look)
        frame.title = 'Faceted Flight, running live'
        frame.allow = 'fullscreen; autoplay'
        surface.replaceChildren(frame)
        update(true)
      })
      surface.replaceChildren(button)
      update(false)
    }

    const update = (live: boolean) =>
      out.update([
        { label: 'state', value: live ? 'running' : 'not loaded' },
        { label: 'url', value: liveWindowUrl(pilot, look) },
      ])

    controls.segmented<Pilot>({
      options: [
        { value: 'autopilot', label: 'watch the autopilot' },
        { value: 'you', label: 'fly it yourself' },
      ],
      value: pilot,
      onChange: (v) => {
        pilot = v
        idle()
      },
    })
    controls.segmented<Look>({
      options: [
        { value: 'anniversary', label: 'Anniversary' },
        { value: 'classic', label: 'Classic' },
      ],
      value: look,
      onChange: (v) => {
        look = v
        idle()
      },
    })
    controls.button('unload', idle)
    idle()
    // Disposal removes the frame with the stage, which stops the game.
    return { dispose: () => surface.remove() }
  },
}
