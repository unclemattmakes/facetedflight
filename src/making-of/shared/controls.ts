// src/making-of/shared/controls.ts: the little controls under a toy's stage.
// DEV-507. A slider, a toggle, a segmented choice, a button and a readout row,
// styled by `.demo-controls` / `.demo-readouts` in site.css. No framework.

export interface Controls {
  slider(opts: {
    label: string
    min: number
    max: number
    step: number
    value: number
    format?: (v: number) => string
    onInput: (v: number) => void
  }): { set(v: number): void }
  toggle(opts: { label: string; value: boolean; onChange: (v: boolean) => void }): void
  segmented<T extends string>(opts: {
    options: readonly { value: T; label: string }[]
    value: T
    onChange: (v: T) => void
  }): void
  button(label: string, onClick: () => void): void
  search(placeholder: string, onInput: (text: string) => void): void
  /** A row of `label: value` pairs. `update` takes the current pairs; a pair may carry a class. */
  readouts(): {
    update(rows: readonly { label: string; value: string; tone?: 'good' | 'bad' }[]): void
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

export const createControls = (host: HTMLElement): Controls => {
  const row = el('div', 'demo-controls')
  host.append(row)
  // Readouts sit in their own row beneath the controls, created on first use.
  let readoutRow: HTMLElement | null = null

  return {
    slider({ label, min, max, step, value, format, onInput }) {
      const wrap = el('label')
      wrap.append(el('span', undefined, label))
      const input = el('input')
      input.type = 'range'
      input.min = String(min)
      input.max = String(max)
      input.step = String(step)
      input.value = String(value)
      const out = el('span', 'readout')
      const fmt = format ?? ((v: number) => String(v))
      out.textContent = fmt(value)
      input.addEventListener('input', () => {
        const v = Number(input.value)
        out.textContent = fmt(v)
        onInput(v)
      })
      wrap.append(input, out)
      row.append(wrap)
      return {
        set(v: number) {
          input.value = String(v)
          out.textContent = fmt(v)
        },
      }
    },
    toggle({ label, value, onChange }) {
      const wrap = el('label')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = value
      box.addEventListener('change', () => onChange(box.checked))
      wrap.append(box, el('span', undefined, label))
      row.append(wrap)
    },
    segmented({ options, value, onChange }) {
      const seg = el('span', 'seg')
      const buttons = options.map((o) => {
        const b = el('button', o.value === value ? 'on' : '', o.label)
        b.type = 'button'
        b.addEventListener('click', () => {
          for (const x of buttons) x.classList.remove('on')
          b.classList.add('on')
          onChange(o.value)
        })
        return b
      })
      seg.append(...buttons)
      row.append(seg)
    },
    search(placeholder, onInput) {
      const input = el('input', 'search')
      input.type = 'search'
      input.placeholder = placeholder
      input.addEventListener('input', () => onInput(input.value))
      row.append(input)
    },
    button(label, onClick) {
      const b = el('button', undefined, label)
      b.type = 'button'
      b.addEventListener('click', onClick)
      row.append(b)
    },
    readouts() {
      if (!readoutRow) {
        readoutRow = el('div', 'demo-readouts')
        host.append(readoutRow)
      }
      const target = readoutRow
      return {
        update(rows) {
          target.replaceChildren(
            ...rows.map((r) => {
              const s = el('span')
              s.append(`${r.label} `)
              s.append(el('b', r.tone ?? '', r.value))
              return s
            }),
          )
        },
      }
    },
  }
}
