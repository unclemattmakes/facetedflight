// src/game/watch-open.ts, a watch socket opened in the page, logged. DEV-480.
//
// DEV-436's `?watch=` made its `WatchClient` once, at boot, inside
// `boot/app.ts`. Faceted Flight TV opens one, switches races and closes it
// (plan/FF-TV.md §9, DEV-480: the watch made in-page), so the construction is
// here and `app.ts`'s `watchStart` only keeps the handle. The page's
// `data-watch` and the log follow the socket while it is the current one
// (`current`), so a socket that was replaced cannot speak for its successor.

import { WatchClient } from './watch-client'

export const openWatch = (
  url: string,
  label: string,
  /** The DEV-470 diagnosis GET's status, after a handshake that never opened. */
  probed: (status: number) => void,
  current: (c: WatchClient) => boolean,
): WatchClient => {
  const c: WatchClient = new WatchClient({
    url,
    now: () => performance.now(),
    // DEV-470: a watch that never opened is diagnosed as a room is.
    probe: (u) =>
      fetch(u).then((r) => {
        probed(r.status)
        return r.status
      }),
    onStatus: (status, notice) => {
      if (!current(c)) return
      document.body.dataset.watch = status
      console.info(`watch ${label}: ${status}${notice ? `, ${notice}` : ''}`)
    },
  })
  c.connect()
  return c
}
