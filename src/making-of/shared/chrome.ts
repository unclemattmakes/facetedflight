// src/making-of/shared/chrome.ts: the parts of every page's header and footer
// that come from the game at run time. The build plugin writes the markup
// (`tools/making-of/plugin.ts`); this fills it.
//
//  - The footer's line is the title screen's own: `titleLine(BUILD_VERSION)`,
//    the version and the copyright, from `render/credits-menu.ts`.
//  - The header's Uncle Matt Makes portrait is the title screen's button,
//    made by the same code (`render/uncle-matt-link.ts`, DEV-803).

import { BUILD_VERSION } from '@/boot/version'
import { titleLine } from '@/render/credits-menu'
import { applyUncleMattLink } from '@/render/uncle-matt-link'

export const fillChrome = (): void => {
  for (const el of document.querySelectorAll<HTMLElement>('[data-title-line]')) {
    el.textContent = titleLine(BUILD_VERSION)
  }
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-uncle-matt-link]')) {
    applyUncleMattLink(a)
  }
}
