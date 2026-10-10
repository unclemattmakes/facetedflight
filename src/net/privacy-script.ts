// src/net/privacy-script.ts: the /privacy page's statistics button, as TEXT.
// DEV-592.
//
// The one browser script the page carries: it sets or clears the opt-out key
// in this site's local storage, which the game reads at boot
// (`boot/stats-beacon.ts`) and sends nothing while it is set. It is inlined by
// `privacy-page.ts` rather than served as a file, because a production build
// copies nothing out of `public/` (`vite.config.ts`, `publicDir`), so a static
// file there never reaches the site.
//
// This module is in the Functions bundle and holds browser code, which
// `lap-server-bundle.test.ts` forbids everywhere else: it is that guard's ONE
// named exception, and the guard holds it to its shape (a single exported
// template literal with no `${`), so nothing in it can run on the server. The
// key is written out, not interpolated, for the same reason;
// `privacy-page.test.ts` holds it equal to `STATS_OPT_OUT_KEY`.

export const PRIVACY_STATS_SCRIPT_SOURCE = `(() => {
  const key = 'ff2.stats.off.v1'
  const button = document.getElementById('stats-off')
  const state = document.getElementById('stats-state')
  if (!button || !state) return
  const off = () => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  }
  const show = () => {
    const asked = navigator.globalPrivacyControl === true || navigator.doNotTrack === '1'
    button.textContent = off()
      ? 'Send statistics from this browser again'
      : 'Stop sending statistics from this browser'
    state.textContent = asked
      ? 'Your browser asks sites not to track it, so it sends none.'
      : off()
        ? 'This browser sends none.'
        : 'This browser sends them.'
  }
  button.addEventListener('click', () => {
    try {
      if (off()) localStorage.removeItem(key)
      else localStorage.setItem(key, '1')
    } catch {}
    show()
  })
  show()
})()`
