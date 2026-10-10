// src/render/uncle-matt-link.ts: the Uncle Matt Makes portrait button, in one
// place. DEV-803 (Matt, 2026-10-07: "add the 'uncle matt makes' portrait a
// clickable button anchored to the bottom left of the screen").
//
// Two pages show it: the game's title screen (`src/main.ts`, placed by
// index.html's #uncle-matt-link) and every making-of page's header
// (`src/making-of/shared/chrome.ts`, Matt: "re-use the code from the title
// screen"). Both hand an empty <a> to `applyUncleMattLink`, which makes it the
// link, and `uncle-matt-link.css` makes it the round button. So the address,
// the label, the image and the look cannot drift between the two.

import { SPLASH_PORTRAIT_PATH } from '@/boot/dev-splash'
import { assetUrl } from '@/content/asset-url'
import './uncle-matt-link.css'

export const UNCLE_MATT_URL = 'https://unclemattmakes.com'
export const UNCLE_MATT_LABEL = 'Uncle Matt Makes'

/** Make `a` the portrait link: a labelled new-tab link to the maker, with the splash's portrait. */
export const applyUncleMattLink = (a: HTMLAnchorElement): void => {
  a.classList.add('uncle-matt-link')
  a.href = UNCLE_MATT_URL
  a.target = '_blank'
  a.rel = 'noopener'
  a.setAttribute('aria-label', UNCLE_MATT_LABEL)
  a.title = UNCLE_MATT_LABEL
  let img = a.querySelector('img')
  if (!img) {
    img = document.createElement('img')
    img.alt = ''
    img.width = 384
    img.height = 384
    img.decoding = 'async'
    a.append(img)
  }
  img.src = assetUrl(SPLASH_PORTRAIT_PATH)
}
