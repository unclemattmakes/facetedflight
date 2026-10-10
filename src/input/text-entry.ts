// src/input/text-entry.ts: "is this key aimed at something being typed into?"
//
// One definition, where five files had written two (code-reuse IA-9): the TV
// camera's keys, the TV controls' M key, the room-code plate's capture
// listener, and the editor's two panels. The union of what they each covered:
// INPUT, SELECT and TEXTAREA, and anything contentEditable.
//
// Duck-typed on `tagName` and `isContentEditable` rather than `instanceof
// HTMLElement`, so a node test can hand in a plain object, as the TV camera's
// tests do, and so a target from another realm (an iframe) still answers.
//
// `attachKeyboard` (keyboard.ts) deliberately does NOT consult this. Every
// shipped text field already stops its own keys (`isolateTextEntryKeys`, or
// room-share's and the island dialog's own `stopPropagation`), so a guard there
// would change nothing for them; it WOULD change the dev-only `?lookdev=1`
// panel, whose sliders and colour inputs are INPUTs that do not stop their
// keys, and any spec that leaves focus in one. Not a refactor: left alone, and
// recorded in docs/plan/code-reuse/progress/reuse-editor.md.

const TEXT_ENTRY_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

/** Is `target` a control the player types into (or picks from with the keyboard)? */
export const isTextEntry = (target: unknown): boolean => {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null
  if (!t) return false
  return (
    (typeof t.tagName === 'string' && TEXT_ENTRY_TAGS.has(t.tagName)) ||
    t.isContentEditable === true
  )
}

/**
 * Keys typed into a field inside `el` are the field's: stop them reaching the
 * window listeners (the editor's shortcuts, the flight keys). Keys aimed
 * anywhere else in `el` pass.
 */
export const isolateTextEntryKeys = (el: EventTarget): void => {
  const stop = (e: Event): void => {
    if (isTextEntry(e.target)) e.stopPropagation()
  }
  el.addEventListener('keydown', stop)
  el.addEventListener('keyup', stop)
}
