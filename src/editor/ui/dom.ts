// src/editor/ui/dom.ts: the DOM builders every editor panel wrote for itself.
//
// `make` was byte-identical in six places (the desk's panel, the light and prop
// groups, the shipped desk, and twice in the island dialog), and `tip` and
// `button` in two or three more, differing only in the tooltip table they read
// (code-reuse UI-9 / XC-13). The editor's end-to-end specs click controls by
// `data-editor`, so `tipper` writes `dataset.editor` exactly as each copy did.

/** `document.createElement(tag)` with `props` assigned and `children` appended. */
export const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

/**
 * Name a control and give it its one-line tooltip from `tips` (DEV-473). The
 * name is what a spec finds it by (`[data-editor="..."]`); the e2e holds every
 * control to having a tip.
 */
export const tipper =
  <N extends string>(tips: Readonly<Record<N, string>>) =>
  <E extends HTMLElement>(node: E, name: N): E => {
    node.dataset.editor = name
    node.title = tips[name]
    return node
  }

/** A `<button type="button">` named and tipped by `tip`, calling `onClick`. */
export const buttonMaker =
  <N extends string>(tip: <E extends HTMLElement>(node: E, name: N) => E) =>
  (name: N, label: string, onClick: () => void, cls = ''): HTMLButtonElement => {
    const b = tip(make('button', { type: 'button', textContent: label, className: cls }), name)
    b.addEventListener('click', onClick)
    return b
  }
