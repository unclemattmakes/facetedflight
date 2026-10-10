// src/net/newsletter.ts: where the newsletter lives, and what the game calls
// it. DEV-658.
//
// Matt, 2026-10-05: the newsletter goes on now (Ko-fi waits for players). It
// is a row on the title's plate under START (`render/title-menu.ts`,
// `newsletterRow`: *"add it to the same panel as the start button, remove the
// extra text"*), and a press opens the signup page in a new tab. The signup is
// unclemattmakes.com's own page, with only this game's list ticked; Kit holds
// the list. The game sends nothing: what the visitor types is typed on that
// page, never on this one. The privacy page says so (`privacy-page.ts`, "The
// newsletter") and reads the address from here.
//
// Ko-fi is deliberately not here: Matt, 2026-10-05, off until there are
// enough players to warrant it.

/** The signup page, with only the Faceted Flight list ticked. */
export const NEWSLETTER_URL = 'https://unclemattmakes.com/newsletter?list=ff'

/** The row's words. Matt, 2026-10-05: "join the flight club". */
export const NEWSLETTER_LABEL = 'Join the flight club'
