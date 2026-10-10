// src/game/measured.ts: numbers MEASURED off the port's own flight model.
//
// A leaf (no imports) so that the app's pins and the editor's policy, which
// cannot import each other (pins pulls three and reads `location`), and the
// tests that fly the ship, all hold ONE copy. These are not Unity constants:
// the extractor's sheet has no key for them, which is why they are written
// here once rather than generated.

/**
 * The HoverJet's lateral limit, m/s²: a turn of radius 136 m at 149 m/s off its
 * own flight model, 162 (about 5 g). DEV-027. It is `SHIP_LAT_ACCEL` in
 * `boot/app/pins.ts` (the velocity profile's curvature limit) and
 * `EDITOR_POLICY.latAccelMeasured` (the editor's turn radius and bank); a
 * re-measurement moves it here and nowhere else.
 */
export const HOVERJET_LAT_ACCEL_MEASURED = 162
