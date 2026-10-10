// src/editor/desk/leave.ts: the way out of the editor, and the one question
// it asks. DEV-569.
//
// Matt, 2026-10-02: *"need a way to get back to the main game from the
// editor"*. BACK TO HANGAR stands in the panel's header (`panel.ts`). The
// draft is written to this browser on every edit (`DESK_POLICY.autosaveMs`
// after the last one) and once more as the button is pressed, and MAKE A
// COURSE opens the last one again, so leaving loses nothing and the button
// leaves at once. The one case where it would lose something is a browser
// that refuses to keep the draft (a private window, storage blocked or full:
// `saveDraft` returns false). Then, and only then, it asks: keep editing (and
// save a file from the panel), or leave without it.
//
// Plain DOM, flat only, as the panel is. While it is open it holds the keys
// (the desk reads `isOpen`), and Escape is "keep editing".

/** What the question says, and its two answers. */
export const LEAVE_WORDS = {
  title: 'Leave without your draft?',
  body:
    'This browser would not keep your draft (a private window, or its storage is full or ' +
    'blocked), so it is lost if you leave now. Save file keeps it as a file you can open later.',
  stay: 'Keep editing',
  leave: 'Leave without it',
} as const

/**
 * DEV-889: the same question when starting another course would push the
 * oldest draft off a full shelf. `oldest` is its label.
 */
export const shelfWords = (oldest: string, size: number): LeaveWords => ({
  title: 'Put away your oldest draft?',
  body:
    `Your shelf holds ${size} drafts. Starting another removes the oldest, ` +
    `"${oldest}". Save file first if you want to keep it.`,
  stay: 'Keep editing',
  leave: 'Start anyway',
})

export interface LeaveWords {
  readonly title: string
  readonly body: string
  readonly stay: string
  readonly leave: string
}

/** Leave at once, or ask first: ask only when the draft could not be kept. */
export const leaveAsks = (kept: boolean): boolean => !kept

export interface LeaveDialog {
  /** Ask. `leave` runs on "Leave without it"; nothing runs on "Keep editing". */
  open(leave: () => void, words?: LeaveWords): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

const STYLE = `
#editor-leave{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;
  background:rgba(4,8,12,.55);font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e8f0f8}
#editor-leave .card{width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:18px 18px 16px;
  background:rgb(12,19,28);border:1px solid #33475c;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
#editor-leave h3{margin:0 0 8px;font-size:15px;color:#ffc27a}
#editor-leave p{margin:0 0 14px;color:#b8c6d4}
#editor-leave .buttons{display:flex;gap:8px;justify-content:flex-end}
#editor-leave button{background:#1c2b3b;color:#e8f0f8;border:1px solid #3a5670;border-radius:6px;
  padding:7px 12px;font:inherit;cursor:pointer}
#editor-leave button.stay{background:#1f7a4d;border-color:#2fa56a;font-weight:600}
`

export const createLeaveDialog = (): LeaveDialog => {
  let el: HTMLElement | null = null
  let style: HTMLStyleElement | null = null
  const close = (): void => {
    el?.remove()
    el = null
  }
  return {
    open(leave, words = LEAVE_WORDS) {
      close()
      if (!style) {
        style = document.createElement('style')
        style.textContent = STYLE
        document.head.appendChild(style)
      }
      const root = document.createElement('div')
      root.id = 'editor-leave'
      root.dataset.editor = 'leave-dialog'
      root.dataset.kind = words === LEAVE_WORDS ? 'unkept' : 'shelf'
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-modal', 'true')
      const card = document.createElement('div')
      card.className = 'card'
      const h = document.createElement('h3')
      h.textContent = words.title
      const p = document.createElement('p')
      p.textContent = words.body
      const stay = document.createElement('button')
      stay.type = 'button'
      stay.className = 'stay'
      stay.textContent = words.stay
      stay.dataset.editor = 'leave-stay'
      stay.addEventListener('click', close)
      const go = document.createElement('button')
      go.type = 'button'
      go.textContent = words.leave
      go.dataset.editor = 'leave-anyway'
      go.addEventListener('click', () => {
        close()
        leave()
      })
      const row = document.createElement('div')
      row.className = 'buttons'
      row.append(go, stay)
      card.append(h, p, row)
      root.append(card)
      // The question holds the keys: none reaches the desk or the game, and
      // Escape is the safe answer.
      root.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          close()
        }
      })
      // A click on the dim round the card is "keep editing" too.
      root.addEventListener('pointerdown', (e) => {
        if (e.target === root) close()
      })
      document.body.appendChild(root)
      el = root
      stay.focus()
    },
    close,
    isOpen: () => el !== null,
    dispose() {
      close()
      style?.remove()
      style = null
    },
  }
}
