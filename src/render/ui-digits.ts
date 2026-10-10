// src/render/ui-digits.ts: figures that do not jitter in a face without tabular ones. DEV-848.
//
// CRYSTAL is the UI's face (`ui-tokens.ts`) and its figures are proportional:
// read out of the font, a 1 advances 530 units of 2048 and an 8 advances 1353,
// with no `tnum` feature and no kerning to switch on, and a canvas has no
// `font-variant-numeric` anyway. A clock that ticks 1:11.9 to 1:12.0 would shuffle
// every glyph to its right. So a number that changes is drawn through here: each
// DIGIT is seated, centred, in a cell as wide as the face's widest digit, and
// every other character (a colon, a point, a plus) keeps its own advance. The
// cell is MEASURED, not typed: `measureText` over 0 to 9 in the font the context
// holds, so the same code is right for the fallback stack while CRYSTAL loads
// and for CRYSTAL after.
//
// THREE-FREE AND DOM-FREE: the canvas half takes a context, the DOM half only
// builds strings, so both run in node against a stand-in.

const DIGITS = '0123456789'

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9'

/** The measuring half of a canvas context, structurally. */
export interface DigitMeasure {
  font: string
  measureText(text: string): { width: number }
}

const cellCache = new Map<string, number>()

/** The widest digit's advance in the context's current font, px. Cached per font string. */
export const digitCell = (ctx: DigitMeasure): number => {
  const hit = cellCache.get(ctx.font)
  if (hit !== undefined) return hit
  let widest = 0
  for (const d of DIGITS) widest = Math.max(widest, ctx.measureText(d).width)
  if (cellCache.size > 64) cellCache.clear()
  cellCache.set(ctx.font, widest)
  return widest
}

/**
 * The width `text` takes with its digits seated in cells. Equals
 * `measureText(text).width` for text with no digits.
 */
export const measureCells = (ctx: DigitMeasure, text: string): number => {
  const cell = digitCell(ctx)
  let w = 0
  for (const ch of text) w += isDigit(ch) ? cell : ctx.measureText(ch).width
  return w
}

/** The drawing half of a canvas context, structurally. */
export interface DigitDraw extends DigitMeasure {
  textAlign: CanvasTextAlign
  fillText(text: string, x: number, y: number): void
}

/**
 * `fillText` with the digits in cells. Honours `textAlign` left, center and
 * right (and start and end as left and right, the ltr cases the UI has); the
 * context's align is restored. The caller sets `font`, fill and baseline.
 */
export const fillTextCells = (ctx: DigitDraw, text: string, x: number, y: number): void => {
  const cell = digitCell(ctx)
  const width = measureCells(ctx, text)
  const align = ctx.textAlign
  const left =
    align === 'center' ? x - width / 2 : align === 'right' || align === 'end' ? x - width : x
  ctx.textAlign = 'left'
  let pen = left
  for (const ch of text) {
    if (isDigit(ch)) {
      const w = ctx.measureText(ch).width
      ctx.fillText(ch, pen + (cell - w) / 2, y)
      pen += cell
    } else {
      ctx.fillText(ch, pen, y)
      pen += ctx.measureText(ch).width
    }
  }
  ctx.textAlign = align
}

/** Test seam: forget the measured cells. */
export const resetDigitCellsForTests = (): void => cellCache.clear()

// ── the DOM half ────────────────────────────────────────────────────────────

/**
 * The em width of a digit cell for CRYSTAL: its widest digit (an 8), 1353 units
 * of a 2048 em, read out of the font file. A DOM node cannot be measured the way
 * a canvas can without a layout, and the face it is set in is one file.
 */
export const CRYSTAL_DIGIT_CELL_EM = 1353 / 2048

/** One digit's cell as an inline-block span, the DOM half's unit. */
export const DIGIT_CELL_CLASS = 'ff-digit'

/**
 * The CSS that seats a `.ff-digit` span: a fixed-width, centred inline block.
 * Added once to the stylesheet of any DOM readout that ticks.
 */
export const DIGIT_CELL_CSS = `.${DIGIT_CELL_CLASS} { display: inline-block; width: ${CRYSTAL_DIGIT_CELL_EM.toFixed(4)}em; text-align: center; }`

/**
 * Replace `node`'s content with `text`, each digit in its cell span. Writes
 * only when the text changed (`data-text` is the last text written), so a
 * readout that is set every frame costs nothing on the frames it does not move.
 */
export const setCellText = (node: HTMLElement, text: string): void => {
  if (node.dataset.text === text) return
  node.dataset.text = text
  node.textContent = ''
  for (const ch of text) {
    if (isDigit(ch)) {
      const span = node.ownerDocument.createElement('span')
      span.className = DIGIT_CELL_CLASS
      span.textContent = ch
      node.appendChild(span)
    } else {
      node.appendChild(node.ownerDocument.createTextNode(ch))
    }
  }
}
