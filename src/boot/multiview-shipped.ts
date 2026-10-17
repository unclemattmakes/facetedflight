// src/boot/multiview-shipped.ts: the one name for the headset eye path's
// shipped default. A leaf with no imports, so e2e specs can read it without
// pulling the app's module graph into Playwright's collection.
//
// ON since DEV-990 (Matt, 2026-10-14: "Default to on plz"), after the rig
// timing under DEV-985: on int_01, 182 to 91 draws a frame and +7.5 fps
// against the tier's 4x MSAA. `?multiview=0` is the other eye path.
//
// OFF again 2026-10-14 (DEV-990 addendum): on Matt's Steam Frame, entering VR
// with multiview crashed the page with no script error, which the VRto3D rig
// never did. Off until that crash is understood; `?multiview=1` opts in.
export const MULTIVIEW_SHIPPED = false
