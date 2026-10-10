// src/render/ski-marks.ts — a difficulty, drawn the way a ski map draws one.
// DEV-420.
//
// Matt, 2026-09-26: *"instead of choosing difficulty and then the terrain, let's
// combine the menu, so we go ring attack > terrain. on each terrain holotable, we
// should indicate difficulty like a ski map (green square, blue circle, black
// diamond). the changing difficulty should change which path is drawn on the
// terrain."* And, asked where: *"the difficulty icons would be vertically aligned
// on the right side of the table, floating above the terrain. looking up at the
// icon would change the path to indicate a different route. should be green on
// top, blue mid, black on bottom."*
//
// This file is the MARKS: their three shapes and colours, and the one mesh a
// mark is. Where a mark stands and what aiming at one does is the room's
// (`render/hangar.ts`, `markLocal` and `gaze()`), which is also where the pick
// changes the route the table draws (`render/diorama.ts`, `setRoute`).
//
// ── A mark is chosen by the rank's PLACE in the order, never by its name ────
//
// Hard rule 6: the ranks are content keys, and their order is 2016's own
// (`slotOrdersFor(...).ranks`, the campaign chain). The first rank in that order
// is the easiest and wears the green square, the second the blue circle, the
// third the black diamond — a ski map's three. A fourth rank, which no content
// has, wears the black diamond too and stands one further step down the column,
// so it is drawn and reachable rather than dropped; its own symbol is a call to
// make when it exists (a double black diamond is the ski map's answer).
//
// ── Why the colours are not the room's ─────────────────────────────────────
//
// Everything else a player picks in this room glows the room's amber. These are
// borrowed vocabulary, and a borrowed symbol is only legible in its own colours:
// a green square IS "easy" to anyone who has stood at the top of a lift. So they
// are the ski map's, flat, one colour a face (pillar 2), on a white card for the
// same reason a trail sign is — a black diamond has to read against a dark
// hangar, and on a sign it reads against white.
//
// ── What they cost ─────────────────────────────────────────────────────────
//
// Every material is a front-faced, opaque `MeshBasicMaterial`: the program the
// room's rims and the tables' craft already hold, so the first place step
// compiles nothing new (DEV-188's rule, CLAUDE.md's cache key). The geometry is
// built once per room and shared by every mark on every table; a mark's state
// is which of the shared materials it wears and how large it is drawn, so a
// pick, a hover or a page turn allocates nothing.

import * as THREE from 'three'

/** A ski map's three marks, easiest first. */
export type SkiMarkShape = 'square' | 'circle' | 'diamond'

/** The mark for the rank at `index` in the rank order. Past the third, the last. */
export const skiMarkShape = (index: number): SkiMarkShape =>
  index <= 0 ? 'square' : index === 1 ? 'circle' : 'diamond'

/**
 * The ski map's colours, by shape. **The three numbers to argue with**, and
 * deliberately the plain ones: a signage green, a signage blue, and near-black
 * rather than pure black so the faceted card's white edge is what carries it.
 */
export const SKI_MARK_COLOURS: Readonly<Record<SkiMarkShape, number>> = {
  square: 0x1fa34a,
  circle: 0x1f63d6,
  diamond: 0x14171b,
}

/**
 * The colour a mark's DRAWN ROUTE takes: the mark's own, so the line on the
 * island and the symbol that picked it are one read — a ski map draws its runs
 * in these colours. The route's white casing (`render/diorama.ts`) is what lets
 * the black one read on dark sea.
 */
export const skiRouteColour = (index: number): number => SKI_MARK_COLOURS[skiMarkShape(index)]

/** How wide a mark's symbol is, in metres. 1.9 degrees at the ~1.5 m a column stands. */
export const SKI_MARK_SIZE = 0.05
/** The white card behind it, as a multiple of the symbol. */
const CARD_SCALE = 1.34

/**
 * How a mark is drawn in each of its states. The PICKED mark — the route the
 * table is drawing — is full size on a white card; the others are smaller and
 * dimmer on a grey one, still plainly there to be looked at. The AIMED one
 * grows, as the aimed table's island does.
 */
export const SKI_MARK_SCALE = { picked: 1, other: 0.78, aimed: 1.22 } as const
const DIM = 0.5

/** The shared parts every mark in one room is built from. */
export interface SkiMarkKit {
  /** One mark, facing +z: its symbol over its card. Positioned and turned by the caller. */
  mark(shape: SkiMarkShape): THREE.Group
  /** Put a built mark into a state: picked or not, aimed or not. Allocates nothing. */
  style(mark: THREE.Group, shape: SkiMarkShape, picked: boolean, aimed: boolean): void
  dispose(): void
}

export const createSkiMarkKit = (): SkiMarkKit => {
  const s = SKI_MARK_SIZE
  // A diamond is a square on its point: the same area as the square reads as
  // smaller, so it is drawn at the square's DIAGONAL across, as trail signs do.
  const diamond = new THREE.PlaneGeometry(s * 0.78, s * 0.78)
  diamond.rotateZ(Math.PI / 4)
  const symbols: Record<SkiMarkShape, THREE.BufferGeometry> = {
    square: new THREE.PlaneGeometry(s * 0.86, s * 0.86),
    // Twelve sides: a circle at 2 degrees, and still a faceted one.
    circle: new THREE.CircleGeometry(s * 0.5, 12),
    diamond,
  }
  const cardFor = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    const card = g.clone()
    card.scale(CARD_SCALE, CARD_SCALE, 1)
    // Behind the symbol, a millimetre: far enough apart that depth never
    // fights at 1.5 m, near enough to read as one sign.
    card.translate(0, 0, -0.001)
    return card
  }
  const cards: Record<SkiMarkShape, THREE.BufferGeometry> = {
    square: cardFor(symbols.square),
    circle: cardFor(symbols.circle),
    diamond: cardFor(symbols.diamond),
  }
  const face = (colour: number) => new THREE.MeshBasicMaterial({ color: colour })
  const faces: Record<
    SkiMarkShape,
    { lit: THREE.MeshBasicMaterial; dim: THREE.MeshBasicMaterial }
  > = {
    square: {
      lit: face(SKI_MARK_COLOURS.square),
      dim: face(new THREE.Color(SKI_MARK_COLOURS.square).multiplyScalar(DIM).getHex()),
    },
    circle: {
      lit: face(SKI_MARK_COLOURS.circle),
      dim: face(new THREE.Color(SKI_MARK_COLOURS.circle).multiplyScalar(DIM).getHex()),
    },
    diamond: {
      lit: face(SKI_MARK_COLOURS.diamond),
      dim: face(SKI_MARK_COLOURS.diamond),
    },
  }
  const whiteCard = face(0xf4f6f8)
  const greyCard = face(0x6d7a86)

  return {
    mark(shape) {
      const group = new THREE.Group()
      group.name = 'difficulty-mark'
      const card = new THREE.Mesh(cards[shape], greyCard)
      card.name = 'difficulty-mark-card'
      const symbol = new THREE.Mesh(symbols[shape], faces[shape].dim)
      symbol.name = 'difficulty-mark-symbol'
      group.add(card)
      group.add(symbol)
      group.userData.shape = shape
      return group
    },
    style(mark, shape, picked, aimed) {
      const [card, symbol] = mark.children as [THREE.Mesh, THREE.Mesh]
      card.material = picked || aimed ? whiteCard : greyCard
      symbol.material = picked || aimed ? faces[shape].lit : faces[shape].dim
      mark.scale.setScalar(
        aimed ? SKI_MARK_SCALE.aimed : picked ? SKI_MARK_SCALE.picked : SKI_MARK_SCALE.other,
      )
      mark.userData.picked = picked
      mark.userData.aimed = aimed
    },
    dispose() {
      for (const g of [...Object.values(symbols), ...Object.values(cards)]) g.dispose()
      for (const f of Object.values(faces)) {
        f.lit.dispose()
        f.dim.dispose()
      }
      whiteCard.dispose()
      greyCard.dispose()
    },
  }
}
