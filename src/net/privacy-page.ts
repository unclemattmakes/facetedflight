// src/net/privacy-page.ts — the /privacy page. DEV-372; D30 names it.
//
// Written from the code rather than beside it: every number on the page is the
// policy constant the server enforces (`lap-policy.ts`), interpolated, so the
// page cannot say "30 days" while the server keeps laps for 31. The claims it
// makes are the ones `tests/unit/lap-server.test.ts` checks against a real
// SQLite: no address in `laps`, no lap in `rate`, the owner key only hashed.
//
// DEV-374 adds what the device keeps (the owner key and the handle, by the
// storage names `game/lap-identity.ts` uses — `tests/unit/lap-admin.test.ts`
// holds the two equal, since this file may not import the game), the delete
// on the results panel, and moderation: blocks and the log, and how long each
// lives.
//
// DEV-470 (D36: rooms and the course editor ship in 1.0) brings it up to what
// ships: a room's seven-character code as well as its link, the tab's code a
// removed player is kept out by (DEV-459), the spectators' feed two seconds
// behind the race (DEV-436), who can fetch a room's judged laps, the courses
// players make (`#c=` links, `.ffcourse` files, the library and the drafts:
// DEV-466 … 469), every other thing the game keeps in the browser, and R2.
// Its numbers and store names are pinned to their sources by
// `tests/unit/privacy-page.test.ts`.
//
// DEV-479 (plan/FF-TV.md §2.4, with the 2026-09-30 exhibition and links
// paragraphs): Faceted Flight TV. "No list of rooms is published" became false
// the day the guide lists races, so it goes in the same change that makes the
// list — the row that makes the promise true carries it.
//
// DEV-571: the results panel ASKS (post to the leaderboard? save as your
// ghost?) and a lap's link asks watch or race. Nothing new is sent or kept:
// the same lap, handle and owner key go on the same yes, and the same ghost
// store holds the same lap. The page's words follow the game's (post, not
// share; the leaderboard; your ghost) and say that the ghost is the player's
// answer now, and that a lap's own link can be watched on TV.
//
// DEV-588 (plan/ANALYTICS.md, Matt, 2026-10-03: "you adjust the privacy page,
// it was made by someone who didn't have analytics in mind"): Cloudflare Web
// Analytics, switched on for the Pages project, which injects its beacon at
// deploy. The opening promise ("nothing leaves your device unless you post a
// lap or join a room") stopped being true with it, so the page now opens with
// what is true of everything below it, and says what the visit counter sends.
// The game's own gameplay statistics (DEV-589 on) add their section here in
// the change that sends the first row, with the field list from their schema.
//
// Served by `functions/privacy.ts`. SERVER-SAFE: a string.

import { FIXED_DT } from '@/sim/constants'
import {
  ADMIN_LOG_DAYS,
  LAP_BOARD_SIZE,
  LAP_SHARE_TTL_DAYS,
  LAP_SUBMITS_PER_HOUR,
} from './lap-policy'
import { NEWSLETTER_URL } from './newsletter'
import { PRIVACY_STATS_SCRIPT_SOURCE } from './privacy-script'
import {
  BROADCAST_DELAY_MS,
  POSE_SEND_TICKS,
  ROOM_CODE_LENGTH,
  ROOM_REJOIN_MS,
} from './room-protocol'
import {
  CRASH_CELL_METRES,
  STATS_BUG_ERRORS,
  STATS_CRASHES_PER_ATTEMPT,
  STATS_ERROR_MESSAGE_MAX,
  STATS_ERRORS_PER_VISIT,
  STATS_KINDS,
  type StatsField,
  type StatsKind,
} from './stats-schema'
import { TV_RESULTS_HOLD_MS } from './tv-protocol'

/**
 * DEV-392: a room's pose rate as the page states it, whole messages a second,
 * from the constants the room and the client use (`POSE_SEND_TICKS` fixed
 * steps a message: 20.49 Hz, "about 20").
 */
export const PRIVACY_POSES_PER_SECOND = Math.round(1 / (POSE_SEND_TICKS * FIXED_DT))
/** How long an emptied room keeps anything, in seconds (`ROOM_REJOIN_MS`). */
export const PRIVACY_ROOM_KEEP_SECONDS = ROOM_REJOIN_MS / 1000
/** DEV-470: how far behind the race a viewer watches, in seconds (`BROADCAST_DELAY_MS`, DEV-436). */
export const PRIVACY_WATCH_DELAY_SECONDS = BROADCAST_DELAY_MS / 1000
/** DEV-470: the characters in a room's code (`ROOM_CODE_LENGTH`, DEV-441b/458). */
export const PRIVACY_ROOM_CODE_LENGTH = ROOM_CODE_LENGTH
/** DEV-479: how long a settled race stays on TV's list, in minutes (`TV_RESULTS_HOLD_MS`). */
export const PRIVACY_TV_RESULTS_MINUTES = TV_RESULTS_HOLD_MS / 60_000

/**
 * Where a player asks for a lap to be removed, or about this page: an email
 * address. DEV-535, Matt, 2026-09-29: *"let's hook this up similar to how
 * matt@… works"*, and he picked `privacy@` on his own domain.
 *
 * It replaced this private repository's GitHub issues (DEV-372), which were a
 * 404 to every stranger the page is for. An address needs no public repository,
 * so the D33 cut no longer has to repoint anything here. What makes it deliver
 * is an Email Routing rule on the domain's Cloudflare zone, forwarding it the
 * way Matt's own address is (outside this repository: `docs/RELEASE-CHECKLIST.md`
 * § 1). Since 2026-09-30 it is the game's own domain, `facetedflight.net`
 * (Matt); the same mailbox on `unclemattmakes.com` still forwards, as a fallback.
 *
 * The ONE place the address is written. `pnpm release:list`'s email scan
 * allowlists exactly this file and prints it every run; the address anywhere
 * else in the tracked tree is a hard finding.
 */
export const PRIVACY_CONTACT_EMAIL = 'privacy@facetedflight.net'
/** The page's link to it. */
export const PRIVACY_CONTACT_URL = `mailto:${PRIVACY_CONTACT_EMAIL}`

/**
 * DEV-588: the visit counter, by the name its maker gives it, and the host its
 * script loads from. Cloudflare injects the script into every HTML page of a
 * deploy once Web Analytics is on for the Pages project, so nothing in this
 * repository loads it; that is why the page names it here, and why the host is
 * written down: the one thing a reader can check in their browser's network tab.
 */
export const PRIVACY_VISIT_COUNTER = 'Cloudflare Web Analytics'
export const PRIVACY_VISIT_SCRIPT_HOST = 'static.cloudflareinsights.com'

/**
 * What the game keeps on the device for sharing, by the storage names it uses
 * (`OWNER_KEY_STORE` and `HANDLE_STORE` in `game/lap-identity.ts`). Written
 * here rather than imported, because the Functions bundle may not reach the
 * game (`lap-server-bundle.test.ts`); `lap-admin.test.ts` holds them equal.
 */
export const PRIVACY_DEVICE_STORES = { owner: 'ff2.owner.v1', handle: 'ff2.handle.v1' } as const

/**
 * DEV-470: what rooms and player courses keep in the browser, by the names the
 * game uses. Written here rather than imported, for `PRIVACY_DEVICE_STORES`'s
 * reason; `tests/unit/privacy-page.test.ts` holds each equal to its source.
 */
export const PRIVACY_BROWSER_STORES = {
  /** A tab's own code for rooms, in SESSION storage: `ROOM_PAGE_STORE` (`game/room-client.ts`). */
  roomPage: 'ff2.room.page.v1',
  /** The course library's IndexedDB database: `COURSE_LIBRARY_DB.name` (`game/course-library.ts`). */
  courses: 'ff2-courses',
  /** The editor's list of drafts, in local storage: `DRAFT_INDEX_KEY` (`editor/core/drafts.ts`). */
  drafts: 'ff2.editor.drafts.v1',
  /** DEV-592: the statistics opt-out, in local storage: `STATS_OPT_OUT_KEY` (`game/stats-tally.ts`). */
  statsOff: 'ff2.stats.off.v1',
  /** DEV-593: the count of goes at each course: `STATS_ATTEMPTS_KEY` (`game/stats-tally.ts`). */
  statsAttempts: 'ff2.stats.attempts.v1',
} as const

/**
 * DEV-592: the game's own statistics (`stats-schema.ts`, ANALYTICS.md). Where
 * they are added up, for how long (Analytics Engine keeps a row three months),
 * the smallest total the developer reads (§1's small-cell rule), and the row
 * kinds the game SENDS today: the page lists those kinds' fields and no others,
 * and `privacy-page.test.ts` holds the list to what the game builds, so a kind
 * that starts sending (DEV-593's attempts and crashes) is added here in the
 * change that sends it.
 */
export const PRIVACY_STATS_STORE = 'Cloudflare Workers Analytics Engine'

export const PRIVACY_STATS_KEEP_MONTHS = 3
export const PRIVACY_STATS_SMALLEST = 10
export const PRIVACY_STATS_KINDS: readonly StatsKind[] = [
  'visit',
  'error',
  'attempt',
  'crash',
  'bug',
]

/** One field as the page lists it: its name, and its values or what it holds. */
const fieldText = (f: StatsField): string => {
  switch (f.kind) {
    case 'enum':
      return `${f.name}: one of ${f.values.join(', ')}`
    case 'shape':
      return f.name === 'message' || /^error[0-9]$/.test(f.name)
        ? `${f.name}: the error's words, numbers and addresses removed, at most ${STATS_ERROR_MESSAGE_MAX} characters`
        : `${f.name}: ${FIELD_SHAPES[f.name] ?? 'a short code'}`
    case 'count':
      return `${f.name}: a whole number up to ${f.max}`
    case 'flag':
      return `${f.name}: yes or no`
    case 'seconds':
      return `${f.name}: whole seconds up to ${f.max}`
  }
}

/** What a shaped field holds, in words. */
const FIELD_SHAPES: Readonly<Record<string, string>> = {
  build: "the game's version, such as v0.18.0",
  frame: "a file and line in the game's own code, or none",
  mission: "a course's id, or custom for a player's own course",
  variant: "an aircraft's id",
  cell: 'a square of the course',
}

const NEWLINE = String.fromCharCode(10)

/** The field list for the kinds the game sends, generated from the schema. */
export const statsFieldList = (): string =>
  PRIVACY_STATS_KINDS.map((kind) => {
    const items = STATS_KINDS[kind].map((f) => `<li>${fieldText(f)}</li>`)
    if (kind === 'visit') items.push('<li>country: as Cloudflare gives it for the connection</li>')
    return [`<p>A ${kind} row:</p>`, '<ul>', ...items, '</ul>'].join(NEWLINE)
  }).join(NEWLINE)

const TITLE = 'Privacy · Faceted Flight: 10th Anniversary Edition'

export const privacyPage = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<style>
  :root { color-scheme: light dark; --fg: #1d2330; --bg: #f6f4ef; --muted: #5a6273; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e6e1; --bg: #12151c; --muted: #a3a9b6; } }
  body { margin: 0; background: var(--bg); color: var(--fg);
         font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .25rem; }
  h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
  p.lede { color: var(--muted); margin-top: 0; }
  li { margin: .35rem 0; }
</style>
</head>
<body>
<main>
<h1>Privacy</h1>
<p class="lede">Faceted Flight: 10th Anniversary Edition — racing other players' laps,
racing other players in a room, and courses that players make.</p>

<h2>In short</h2>
<ul>
<li>There are no accounts and no advertising, and the game sets no cookies.</li>
<li>The site counts visits, never visitors, and the game counts how it is played,
in rows that carry nothing that could identify you. You can turn the second off
(below).</li>
<li>A lap leaves your device only when you post it or race in a room. A course
leaves it only when you send it to someone yourself.</li>
</ul>

<h2>Counting visits</h2>
<p>The site uses ${PRIVACY_VISIT_COUNTER} to see how many people visit and how
the site performs. When a page loads, a small script from
<code>${PRIVACY_VISIT_SCRIPT_HOST}</code> reports the page's address, the address
of the site that linked to it, how long the page took to load, and your browser,
operating system and type of device. It reports to this site's own address on
Cloudflare, which also works out the country from the connection. The developer
sees only totals: how many visits, from which sites and countries, on which
browsers and devices, and how fast the pages loaded.</p>
<p>It sets no cookie and keeps nothing in your browser. Cloudflare states that it
does not fingerprint visitors by their address, browser or anything else, and that
it does not build profiles of them. A browser that blocks trackers may block the
script, and the game works the same either way.</p>

<h2>How the game is played</h2>
<p>The game counts how it is played, so that the developer can see what works on
players' machines and what does not: whether it loads, how fast it runs, whether
VR starts, and what goes wrong. It sends these as rows to this site's own
address, where ${PRIVACY_STATS_STORE} adds them up and keeps them for
${PRIVACY_STATS_KEEP_MONTHS} months.</p>
<ul>
<li>No row carries anything that identifies you, your device or your visit: no
account, no handle, no id of any kind, no address, no cookie. Rows share no key,
so nothing ties one visit's rows to another visit, or to you. Cloudflare records
when each row arrived, and that is all that rows sent together have in
common.</li>
<li>Times, lengths and frame rates are rounded into broad ranges on your device
before they are sent.</li>
<li>The server refuses a row with any field that is not listed below, or with a
value outside its list. It adds the country Cloudflare gives for the connection
to a visit's row, and keeps nothing else about the connection.</li>
<li>The developer reads only totals, and never a total of fewer than
${PRIVACY_STATS_SMALLEST} rows. The one exception is a bug report, which you send
to be read.</li>
<li>Rows are sent when you leave or hide the page, when the game cannot start,
or when you press SEND on REPORT BUG. Nothing is sent while you play.</li>
</ul>
<p>What is sent:</p>
<ul>
<li>One row for each visit: how far you got (the title, the hangar, a mission, a
finish), how long the title took to appear, whether VR was available, asked for
and started, how long you spent in it, your type of device (computer, phone,
tablet or headset), which kinds of controls you used, the quality and comfort
settings in force, how fast the frames ran, and how many races you started and
finished, rooms you joined, races you watched, laps you posted, ghosts you saved
and errors the game hit. A visit hidden and opened again sends a second row with
what happened since.</li>
<li>One row for each kind of error the game hits, at most
${STATS_ERRORS_PER_VISIT} a visit: the error's own words with every number and
address taken out, and the place in the game's code it came from.</li>
<li>One row for each go at a course, however it ends: which course (a course
you made yourself is sent only as "custom"), the mode, the look, who you raced,
the aircraft, how it ended (finished, quit, restarted or left), the medal, how
many rings you took of how many, your time if you finished, how long you flew
if you did not, and how many crashes and resets. It also says whether this was
your first go at that course, your second or third, up to your tenth, or more:
this browser counts your goes at each course for that, as
<code>${PRIVACY_BROWSER_STORES.statsAttempts}</code>, and only the range is
sent.</li>
<li>One row for each crash or reset, at most ${STATS_CRASHES_PER_ATTEMPT} a go:
which course, the look, what happened, and where, as a square of the course
${CRASH_CELL_METRES} metres across and a band of height. These rows carry no
time and no order, so they show where people crash, not how anyone flew.</li>
<li>A bug report, only when you press SEND on REPORT BUG: where you are (the
screen, the course, and the moment in the run), the game's version, your type of
device, the quality and look in force, and the last ${STATS_BUG_ERRORS} errors
the page saw, cleaned as above. Nothing you type and nothing about you. It is
sent even from a browser that sends no statistics, because pressing SEND is the
asking. The server answers with a short code that names the report and nothing
else, which the game shows you, so that you can mention it if you write in.</li>
</ul>
<details>
<summary>Every field a row can hold, exactly</summary>
${statsFieldList()}
</details>
<p>To stop this browser sending them: <button id="stats-off" type="button">Stop
sending statistics from this browser</button> <span id="stats-state"></span></p>
<p>The choice is kept in this site's storage as
<code>${PRIVACY_BROWSER_STORES.statsOff}</code>. A browser that sends Global Privacy
Control or Do Not Track sends none, without being asked.</p>
<script>${PRIVACY_STATS_SCRIPT_SOURCE}</script>

<h2>Laps and courses leave your device only when you send them</h2>
<p>After every lap the results panel asks whether to post it to the leaderboard,
and the answer is no until you press yes. The game sends a lap to the lap server
only on that yes, or when you finish a race in a room you joined (below). A
course you make or open leaves your device only when you send its link or its
file to someone yourself (below).</p>

<h2>What stays on your device</h2>
<p>The game keeps these in your browser's storage, and nowhere else:</p>
<ul>
<li>Your best times, and the lap you save as your ghost on each course, to race
against. The results panel asks whether to save each lap as your ghost; a lap
that beats the one saved starts as yes, and saying no puts the old one back.
Saving a lap sends nothing. A lap leaves the device only when you post it, or
when you finish a race in a room.</li>
<li>Your settings, and the colour and aircraft you last chose.</li>
<li>An owner key, stored as <code>${PRIVACY_DEVICE_STORES.owner}</code>: a random
code your device makes the first time you post a lap. It goes with each lap you
post and with a request to take one down, so that the server can tell the lap is
yours. The server stores only a one-way hash of it.</li>
<li>The handle you last posted under, stored as
<code>${PRIVACY_DEVICE_STORES.handle}</code>, so that the game offers it again.
It goes with a lap you post, and nowhere else.</li>
<li>A random code for each browser tab you join a room from, made the first time
you join one in that tab and kept in that tab's session storage as
<code>${PRIVACY_BROWSER_STORES.roomPage}</code>. It goes to a room when you join
one, and nowhere else (below).</li>
<li>The courses you have opened from a link or a file, or made yourself, in an
IndexedDB database called <code>${PRIVACY_BROWSER_STORES.courses}</code>: each
course, when it was last kept, and whether it came from a link, a file or this
browser. The title lists them from there.</li>
<li>The course editor's drafts, listed under
<code>${PRIVACY_BROWSER_STORES.drafts}</code> with one entry for each draft.</li>
</ul>
<p>Clearing this site's data in your browser removes all of them. Closing a tab
also removes that tab's code. Switches in the address that are meant for
development, such as <code>?perf=1</code>, keep their readings in the same
storage and send them nowhere.</p>

<h2>What a posted lap contains</h2>
<ul>
<li>The path your ship flew: its position and rotation over the lap, and the
moments it passed a ring, crossed the finish or was reset onto the course.</li>
<li>Which mission, mode and edition it was, and the game's version.</li>
<li>A handle the game made up for you from a fixed list of words, such as
"Swift Kestrel 42". There is no free-text name, account, email or password.</li>
<li>An owner key: a random code your device makes and keeps, so that you can
delete your own laps later. The server stores only a one-way hash of it.</li>
</ul>

<h2>What the server works out and keeps</h2>
<p>The server times the lap itself from its path, and keeps that time, the rings
taken and the lap. It does not keep anything the game claims about the lap.</p>

<h2>Your address</h2>
<p>Your IP address is used for one thing: limiting how many laps one address can
send (${LAP_SUBMITS_PER_HOUR} an hour). The server stores a salted, one-way hash
of it, never the address itself, in a table that holds no laps. For an IPv6
address it hashes only the first half, the part that names your network. Once a hash is a
day old it is deleted the next time anyone sends a lap. It is never stored with
a lap.</p>

<h2>How long laps are kept</h2>
<ul>
<li>A lap in the top ${LAP_BOARD_SIZE} of its leaderboard is kept while it is there.</li>
<li>Any other posted lap, including one that drops off a leaderboard, can be fetched
for ${LAP_SHARE_TTL_DAYS} days. After that it is never served again, and it is
deleted the next time anyone sends a lap.</li>
</ul>

<h2>Who can see a lap</h2>
<p>Anyone with a lap's link can race it, or watch it on Faceted Flight TV where
the game has TV: the link asks which. Laps on the leaderboard are listed publicly
with their handle, time and aircraft. The developer can remove any lap (see
Moderation, below).</p>

<h2>Deleting a lap</h2>
<p>Straight after you post a lap, the results panel offers to take it down: press
its row again, and once more to confirm. The server deletes the lap only if your
device's owner key matches the one it was posted with, and its link stops
working. For a lap you posted earlier, or from a device whose storage has been
cleared, ask (below) with the lap's link; otherwise it expires on the schedule
above.</p>

<h2>Moderation</h2>
<p>The developer can remove any lap; remove every lap posted under a handle and
retire that handle; and stop a device from posting, by the one-way hash of its
owner key that the server already holds. A retired handle or a blocked device
stays on the list until the block is lifted. Each of these is logged with what was
removed, its handle and owner-key hash, and why, and a log entry is deleted
${ADMIN_LOG_DAYS} days after it was written, the next time anyone sends a lap. No
address is stored with a lap, so none can be blocked.</p>

<h2>Racing in a room</h2>
<p>A room is a private race. It has a link and a
${PRIVACY_ROOM_CODE_LENGTH}-character code, and the code is the room's name: anyone
who has the link or the code can join while the room has a free seat and its race
has not started, and can watch its race (below). A room's code is never listed
anywhere. While a room's race is on, it is shown on Faceted Flight TV without its
code and without anyone's handle (below).</p>
<p>When you join, your device sends the room your handle, your aircraft and
colour, which version of the game you have (so that two versions never share a
race), and your tab's code (above). While you race, it sends your ship's
position, rotation, speed and controls about ${PRIVACY_POSES_PER_SECOND} times a
second, and each ring you take, each reset onto the course and your finish as they
happen. The room passes these to the other players in the room at once, and to
anyone watching the race about ${PRIVACY_WATCH_DELAY_SECONDS} seconds later.</p>
<p>When you finish, your lap goes to the lap server to be timed, as a posted lap
is, and the room keeps the lap and its time under your handle, so that the others
can see your result and race your lap. Anyone who has the room's code can fetch a
lap the room keeps, for as long as the room lasts. A lap from a room is never put
on a leaderboard.</p>
<p>The room's owner can remove a player while the room is waiting to start. The
room then keeps that player's seat code and tab code, and refuses both, for as
long as the room lasts, so that a removed player stays out when they reload the
page.</p>
<p>A room keeps nothing once it is empty: its state, its laps and the codes it
refuses are deleted when the last player leaves a room that is waiting to start,
and ${PRIVACY_ROOM_KEEP_SECONDS} seconds after the last player leaves a race. The
room gives your device a random seat code, so that a dropped connection can take
its seat back; it lasts as long as the room does. A room never stores your
address.</p>

<h2>Watching a race</h2>
<p>A room's watch link carries its code. Faceted Flight TV never does (below).
Anyone who opens a watch link sees the race about
${PRIVACY_WATCH_DELAY_SECONDS} seconds behind: every racer's ship, handle and
colour, and the results. A viewer's device sends only a request to watch and a
periodic keep-alive, and a viewer is never a player in the room.</p>

<h2>Faceted Flight TV</h2>
<p>Every race in a room is shown on Faceted Flight TV, about
${PRIVACY_WATCH_DELAY_SECONDS} seconds behind, to anyone who opens it. TV shows
each ship's flight (its position, rotation, speed and controls), its colour and
aircraft, the course, and the race's times and results. It never shows a handle:
racers appear as Racer 1, Racer 2 and so on. The names are removed on the server,
before anything is sent to someone watching TV. TV never shows or sends a room's
code, so nobody can join a room from TV.</p>
<p>To find the races, the server keeps a list of the rooms that are racing: for
each, a random TV number that is not its code, the course, what the race is doing,
and how many are racing. Anyone who opens TV receives that list, without the
codes. A room leaves the list when its players go back to wait for the next race,
when it empties, or ${PRIVACY_TV_RESULTS_MINUTES} minutes after its results are in.
A room keeps its TV number until it empties, so that a link to it still works
between its races; the server forgets the number when the room empties.</p>
<p>When no room is racing, TV shows the game's own AI racers on one of its
courses. Nothing is sent or kept for it.</p>
<p>A TV link names a race by its TV number, never by the room's code, and can say
which racer to follow (Racer 3, say). A player in a room can make one (WATCH ME)
to send to friends; anyone watching TV can make one of what they are watching.
Whoever opens it sees what TV shows everyone: no handles, no code. The link stops
working when the room empties. A lap posted from the results panel can also be
watched on TV, from its own link or from a TV link: either names the lap by the
number the leaderboard already lists it under, and TV flies it with the AI
racers.</p>
<p>Watching TV sends only a request for the list, a request to watch and a
periodic keep-alive. Nothing about who watches is kept. The developer can take one
race off TV, or all of TV off the air for a time; each time is logged, as the
other moderation actions are, with nothing about the racers.</p>

<h2>Courses players make</h2>
<p>A course is its island, its path and rings (and whether its first ring is
anchored to the start pad, and how high), its start pad and finish, its
time limit, a two-word name from a fixed list and,
if its maker set them, the sun's height and direction, a colour tint, a water
level and the props its maker placed (which of the islands' own meshes, where,
which way round and how large).
It holds no handle and nothing else about who made it.</p>
<ul>
<li>A course link carries the whole course after the <code>#</code> in the
address. Browsers never send that part of an address to a server, and the game
sends it nowhere, so the course is seen by whoever you give the link to and by
nobody else.</li>
<li>A course file (<code>.ffcourse</code>) is saved to your own device and opened
from it. The game never uploads one. When a course stands on an island made from
a heightmap you imported, the file carries that map too, and this browser keeps
a copy of it with the course.</li>
<li>Courses you open or make are kept in this browser (above), and so are your
best times and laps on them. A lap on a player's course is never sent to the lap
server.</li>
</ul>

<h2>The newsletter</h2>
<p>The title screen has a link to the developer's newsletter. It opens
<a href="${NEWSLETTER_URL}">a page on unclemattmakes.com</a> in a new tab, and
the game sends nothing when you press it. If you sign up there, your email
address is held by Kit, the newsletter service, under
<a href="https://kit.com/privacy">its own privacy policy</a>, and you are asked
to confirm it by email before anything is sent. Every email has a link to
unsubscribe.</p>

<h2>Asking</h2>
<p>To ask for a lap to be removed, or about anything on this page, email
<a href="${PRIVACY_CONTACT_URL}">${PRIVACY_CONTACT_EMAIL}</a>. Give the lap's
link, and never your owner key.</p>

<h2>Where it runs</h2>
<p>The game and its files, the lap server and the rooms are hosted on Cloudflare
(Pages, R2, D1 and Durable Objects), which processes requests in order to deliver
them. Visits are counted by ${PRIVACY_VISIT_COUNTER}, and the game's own rows are
added up by ${PRIVACY_STATS_STORE} (above). An email to the
address above is forwarded to the developer by Cloudflare Email Routing.</p>
</main>
</body>
</html>
`
