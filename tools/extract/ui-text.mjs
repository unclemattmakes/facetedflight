/**
 * tools/extract/ui-text.mjs -- read 2016's own UI strings out of the ship prefabs.
 *
 * Every UI string the port shows used to be hand-carried: a literal in
 * `src/render/**` or `src/boot/app.ts` with a prefab line in the comment above
 * it. That is the same class of mistake as hand-typing a constant (CLAUDE.md
 * rule 3) -- it is a value copied by eye out of the Unity project, with nothing
 * that fails when the copy is wrong. It WAS wrong: the briefing's apostrophe had
 * been normalised to U+2019, and `SPEED:` is neither of the two things 2016
 * actually writes. See UI_STRINGS below for the full list.
 *
 * ── What a Unity UI label is, in YAML ──────────────────────────────────────
 *
 * `UnityEngine.UI.Text` is a BUILT-IN component, so it is not a `.cs` file in
 * `Assets/` and it has no guid of its own in `_guid_index.tsv`. It serialises as
 * a `!u!114` MonoBehaviour whose script reference is
 *
 *     m_Script: {fileID: 708705254, guid: f5f67c52d1564df4a8936ccd202a3bd8, type: 3}
 *
 * The GUID alone is NOT enough: it is the whole `UnityEngine.UI` assembly, and
 * the same guid carries `CanvasScaler` (1980459831), `Image` (-765806418),
 * `Button`, `Toggle` and a dozen more. It is the fileID that says `Text`.
 * Verified at `Assets/Faceted Flight/Prefabs/dev tools/RecordingObjects.prefab`
 * line 15465, whose `m_Text` two dozen lines later reads `RACE COMPLETE!`.
 * `tools/prototype/unity_scene_to_json.js` already knows this mapping
 * (`BUILTIN_SCRIPTS`), so the flattener names these components `Text` for us and
 * this file never has to touch the guid itself.
 *
 * ── Why the flattener's own `m_Text` cannot be trusted ─────────────────────
 *
 * `tools/prototype/unity_yaml.js` says so in its own header: no multi-line
 * scalars. It drops blank lines before parsing, so a single-quoted scalar that
 * runs over two or more lines comes back as the FIRST LINE ONLY, with its
 * opening quote still attached and its `''` escapes undoubled:
 *
 *     "'Fly through as many rings as you can before time runs out. Don''t CRASH!!"
 *     "'Warning!"
 *
 * Three of the strings this port needs are in that shape, including the mission
 * briefing -- the single most visible piece of text in the game. A reader that
 * returns the first line is the string-shaped version of the trap CLAUDE.md
 * already names for the two YAML dialects: it returns *something*, so nothing
 * looks broken. So `m_Text` is re-read here from the raw file bytes, by fileID,
 * with a scalar decoder that implements YAML flow folding properly.
 *
 * `unity_yaml.js` is not ours to change (it is shared with the prototype tools
 * and with `constants.mjs`), and widening it would change every field every
 * other reader sees. One field, read once, in the tool that needs it.
 */

import { readUnityText } from '../unity/yaml.mjs'

/* ================================================================ scalar decoding == */

/** The `!u!114 &fileID` document header, with the fileID captured. */
const DOC_RE = /^--- !u!(\d+) &(-?\d+)/

/**
 * Every `m_Text:` in a Unity YAML file, keyed by the fileID of the document it
 * sits in, decoded byte-exactly.
 *
 * Scans the raw text rather than the parsed documents because that is the only
 * place a multi-line scalar still exists -- see the header. Cached per file,
 * because the two ship prefabs are read once per mission and there are thirteen.
 */
const rawTextCache = new Map()
export function rawTextsByFileId(absPath) {
  const key = absPath.replace(/\\/g, '/')
  if (rawTextCache.has(key)) return rawTextCache.get(key)
  const lines = readUnityText(absPath).split(/\r?\n/)
  const out = new Map()
  let docId = null
  for (let i = 0; i < lines.length; i++) {
    const dm = DOC_RE.exec(lines[i])
    if (dm) {
      docId = dm[2]
      continue
    }
    // `  m_Text:` at the MonoBehaviour's own indent (two spaces). A nested
    // `m_Text` at deeper indent would belong to a sub-object, and none exists.
    const tm = /^ {2}m_Text:(?: (.*))?$/.exec(lines[i])
    if (!tm || docId === null) continue
    const { value, next } = decodeScalar(tm[1] ?? '', lines, i)
    out.set(docId, { text: value, line: i + 1 })
    i = next
  }
  rawTextCache.set(key, out)
  return out
}

/**
 * One YAML scalar, starting at the text after `key: ` on line `i`.
 *
 * Returns the decoded string and the index of the LAST line consumed. Handles
 * the four forms Unity 5.4 actually writes for `m_Text`:
 *
 *   plain          `m_Text: RACE COMPLETE!`          -- trailing space stripped
 *   single-quoted  `m_Text: 'Gates:'`                -- `''` is one apostrophe
 *   multi-line     `m_Text: 'Warning!` + more lines  -- YAML flow folding
 *   double-quoted  `m_Text: ""`                -- escapes, incl. \u
 *
 * FLOW FOLDING is the part worth stating, because it is not "join with \n":
 * a line break followed by N EMPTY lines produces N newline characters, and a
 * line break followed by none produces a SPACE. `'Warning!\n\n  Leaving event
 * airspace\n\n  Turn back now!'` is therefore a three-line string, not a
 * five-line one, and `'Fly ... CRASH!!\n\n'` ends in exactly one newline.
 * Leading indentation on a continuation line is flow indentation and is
 * discarded; trailing whitespace on any line is discarded.
 */
export function decodeScalar(first, lines, i) {
  const head = first ?? ''
  if (head === '') return { value: '', next: i }

  if (head[0] === "'") return decodeQuoted(head, lines, i, "'")
  if (head[0] === '"') return decodeQuoted(head, lines, i, '"')
  // Plain scalar: Unity never wraps one, so it is this line with trailing
  // whitespace removed. A `#` comment cannot appear -- Unity writes none.
  return { value: head.replace(/\s+$/, ''), next: i }
}

function decodeQuoted(head, lines, i, q) {
  // Collect the raw lines of the scalar, stopping at the closing quote. For `'`
  // the escape is a doubled quote, so a line ending in an ODD run of quotes is
  // the terminator; for `"` a quote preceded by a backslash is escaped.
  const parts = []
  let cur = head.slice(1)
  let line = i
  for (;;) {
    const end = closingQuoteIndex(cur, q)
    if (end >= 0) {
      parts.push(cur.slice(0, end))
      break
    }
    parts.push(cur)
    line++
    if (line >= lines.length) {
      throw new Error(`ui-text: unterminated ${q} scalar starting at line ${i + 1}`)
    }
    cur = lines[line]
  }

  // Flow folding. Line 0 keeps its leading characters (it starts right after
  // the opening quote); every continuation line loses its flow indentation.
  const content = parts.map((p, n) => (n === 0 ? p : p.replace(/^\s+/, '')).replace(/\s+$/, ''))
  // The LAST line is always a chunk, never an empty line — it is the one the
  // closing quote sits on. Getting that wrong doubles the briefing's trailing
  // newline, which is invisible until something renders it.
  const last = content.length - 1
  let value = content[0]
  let n = 1
  while (n <= last) {
    let blanks = 0
    while (n + blanks < last && content[n + blanks] === '') blanks++
    value += blanks === 0 ? ' ' : '\n'.repeat(blanks)
    value += content[n + blanks]
    n += blanks + 1
  }

  return { value: q === "'" ? value.replace(/''/g, "'") : unescapeDouble(value), next: line }
}

/** Index of the closing quote in `s`, or -1. */
function closingQuoteIndex(s, q) {
  for (let k = 0; k < s.length; k++) {
    if (s[k] !== q) continue
    if (q === "'") {
      if (s[k + 1] === "'") {
        k++ // a doubled quote is one apostrophe, not the end
        continue
      }
      return k
    }
    // double-quoted: count the backslashes immediately before
    let b = 0
    while (k - 1 - b >= 0 && s[k - 1 - b] === '\\') b++
    if (b % 2 === 0) return k
  }
  return -1
}

const DOUBLE_ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', '/': '/' }
function unescapeDouble(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, e) => {
    if (e[0] === 'u') return String.fromCharCode(Number.parseInt(e.slice(1), 16))
    if (e[0] === 'x') return String.fromCharCode(Number.parseInt(e.slice(1), 16))
    return DOUBLE_ESCAPES[e] ?? e
  })
}

/* ================================================================== reading a prefab == */

/**
 * Which HUD a label belongs to, from its path.
 *
 * It matters, and this is the only reason the selector below is not one grep:
 * the two HUDs disagree. The third-person console says `SpeeD :` and the
 * first-person one says `Speed :` -- a real difference in the shipped bytes,
 * found by sweeping rather than by picking a root and trusting it (the
 * "agreement lesson"). FF2 is a cockpit game, so the FIRST-PERSON one is the
 * one that ships; the other is recorded as a variant so the disagreement is
 * data rather than a decision nobody wrote down.
 *
 * The two vehicles spell the same idea differently -- the HoverJet nests its
 * under `art_pivot/Art/FirstPerson/FirstPersonHUDRoot` (plus a second
 * `FirstPersonHUDRoot_pause` that holds only the pause panel), the JumpSeat
 * under `art_pivot (1)/art_firstPerson`.
 */
function hudRootOf(p) {
  if (/\/(FirstPerson|art_firstPerson)(\/|$)/.test(p)) return 'firstPerson'
  if (/(CamRoot_3rdPerson|art_thirdPerson|Ship_HUD 3rd Person)/.test(p)) return 'thirdPerson'
  return 'other'
}

/**
 * Every `UnityEngine.UI.Text` in a prefab, with its text read from the bytes.
 *
 * `live` is `activeInHierarchy` as the prefab authored it -- which for a HUD is
 * "showing at t=0", not "never shown": `panel_pause` is authored inactive and is
 * switched on by code. So liveness is REPORTED and never filters, unlike rings
 * and clouds where an inactive object is content that does not exist.
 */
export function readPrefabTexts(absPath, flat) {
  const raw = rawTextsByFileId(absPath)
  const rows = []
  for (const o of flat.objects) {
    for (const s of o.scripts || []) {
      if (s.name !== 'Text') continue
      const r = raw.get(String(s.fileID))
      rows.push({
        path: o.path,
        name: o.name,
        hud: hudRootOf(o.path || ''),
        live: o.activeInHierarchy !== false,
        enabled: Number(s.enabled ?? 1) !== 0,
        // A label whose fileID is missing from the raw scan is a reader bug, not
        // an empty label: say so rather than emitting "".
        text: r ? r.text : null,
        fileID: String(s.fileID),
        line: r ? r.line : null,
      })
    }
  }
  // Path first (so a selector's matches are contiguous), then the m_Text LINE,
  // which is file order. File order is what `occurrence` disambiguates on, and
  // it is the only discriminator two same-named siblings have — see the note on
  // `totalScore` / `medalLabel`, the one pair in the table that needs it.
  rows.sort(
    (a, b) =>
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      Number(a.fileID) - Number(b.fileID),
  )
  return rows
}

/* ====================================================================== the selector == */

/**
 * The strings FF2 actually shows, and where each one comes from.
 *
 * A selector is a path SUFFIX (`panel/leaf`), matched against every `Text` in
 * the vehicle's own prefab. It is a selector, not a value: nothing here is a
 * string copied out of Unity, which is the whole point of the exercise. The
 * extractor throws if a selector matches nothing, so a prefab that is
 * restructured fails the build instead of quietly shipping an empty label.
 *
 * `ff2` names the literal in the port that this replaces, so the handover from
 * "hand-carried" to "read from data" is a table rather than a hunt. Where the
 * port's current wording DIFFERS from 2016's, the difference is stated -- those
 * are findings, not a licence to normalise (`_CORRECTIONS.md` quotes the medal
 * banner as `"<medal> Medal AwarDeD!"`; the bytes say `________ medal AwarDeD!`,
 * lower-case `medal`, and eight underscores rather than a placeholder token).
 */
export const UI_STRINGS = [
  // ── the instrument panel (src/render/hud.ts) ────────────────────────────
  {
    id: 'gatesLabel',
    select: 'panel_shipUI/text_gates',
    vehicles: ['hoverjet'],
    ff2: "src/render/hud.ts — the caller passes `countLabel`; app.ts sends 'GATES'",
    note: '2016 writes `Gates:` in sentence case. The port upper-cases it.',
  },
  {
    id: 'timeLabel',
    select: 'panel_shipUI/text_time',
    vehicles: ['hoverjet'],
    ff2: "src/render/hud.ts — literal 'TIME:'",
  },
  {
    id: 'speedLabel',
    select: 'panel_shipUI/panel_speedUI/text_speed',
    vehicles: ['hoverjet'],
    ff2: "src/render/hud.ts — literal 'SPEED:'",
    note:
      'The two HUDs disagree: first-person `Speed :`, third-person `SpeeD :`. ' +
      'Both carry a space before the colon, which the port drops.',
  },
  {
    id: 'timeEmpty',
    select: 'panel_shipUI/val_time',
    vehicles: ['hoverjet'],
    ff2: "src/render/hud.ts — literal '--' for a mission with no timer",
  },
  {
    id: 'countPlaceholder',
    select: 'panel_shipUI/val_gates',
    vehicles: ['hoverjet'],
    ff2: 'src/render/hud.ts `pad2` — the `00/50` shape is why counts are two-digit padded',
  },
  {
    id: 'fuelLabel',
    select: 'panel_jumpSeatUI/text_fuel',
    vehicles: ['jumpseat'],
    ff2: 'nothing yet — the JumpSeat HUD is unbuilt (NEXT.md)',
  },
  {
    id: 'fuelFull',
    select: 'panel_jumpSeatUI/val_fuel',
    vehicles: ['jumpseat'],
    ff2: 'nothing yet — the JumpSeat HUD is unbuilt',
  },

  // ── the launch (src/boot/app.ts launchBanner) ───────────────────────────
  {
    id: 'launchPrompt',
    select: 'panel_preLaunch/text_poweringOn',
    ff2: "src/boot/app.ts — literal 'Press A to launch'",
  },
  {
    id: 'launching',
    select: 'panel_Startup/text_poweringOn',
    ff2: "src/boot/app.ts — literal 'Powering On...'",
  },

  // ── the boundary warning (src/boot/app.ts launchBanner) ─────────────────
  {
    id: 'outOfBounds',
    select: 'panel_outofBounds/text_end',
    ff2: "src/boot/app.ts `launchBanner()` — literals 'OUT OF BOUNDS' and 'RETURN — <n>'",
    note:
      'THREE lines, not one: `Warning!` / `Leaving event airspace` / `Turn back now!`. ' +
      'The countdown is a separate label parented to this one.',
  },
  {
    id: 'outOfBoundsCountdown',
    select: 'panel_outofBounds/text_end/text_warning_countdown',
    ff2: 'src/boot/app.ts — the number in `RETURN — <n>`',
    note: 'Authored as `12`, one less than the 13 s `PlayerBoundary.resetDelay` every scene ships.',
  },

  // ── the pause menu (src/render/pause.ts) ────────────────────────────────
  { id: 'pauseTitle', select: 'lbl_pause', ff2: "src/render/pause.ts — literal '- PAUSE -'" },
  { id: 'pauseResume', select: 'lbl_resume', ff2: "src/boot/app.ts — label 'Resume'" },
  { id: 'pauseRestart', select: 'lbl_restart', ff2: "src/boot/app.ts — label 'Restart'" },
  { id: 'pauseExit', select: 'lbl_exit', ff2: "src/boot/app.ts — label 'Exit'" },

  // ── the end of a run (src/render/results.ts) ────────────────────────────
  {
    id: 'courseComplete',
    select: 'panel_endUI/text_end',
    vehicles: ['hoverjet'],
    ff2: 'src/render/results.ts — the port leads with the medal instead',
  },
  {
    id: 'gatesCleared',
    select: 'panel_endUI/text_gatesCleared',
    vehicles: ['hoverjet'],
    ff2: "src/render/results.ts — literal 'GATES' after the count",
  },
  {
    id: 'medalLabel',
    select: 'panel_endUI/text_score',
    vehicles: ['hoverjet'],
    occurrence: 0,
    ff2: 'src/render/results.ts — the medal is drawn with no label',
    note:
      'TWO GameObjects under `panel_endUI` are both named `text_score`, so the only ' +
      'discriminator either has is FILE ORDER, and this is the first. That is a weak ' +
      'selector and it is deliberately used only here, on two labels FF2 does not draw: ' +
      'if Unity ever rewrote the prefab the pair would swap silently. Both strings are ' +
      'in `_meta.variants`, so the swap is at least visible in the output.',
  },
  {
    id: 'totalScore',
    select: 'panel_endUI/text_score',
    vehicles: ['hoverjet'],
    occurrence: 1,
    ff2: 'src/render/results.ts — the score is drawn with no label',
    note: 'The second `text_score` in file order. See `medalLabel`.',
  },
  {
    id: 'medalAwarded',
    select: 'panel_medalAwarded/text_end',
    ff2: 'nothing — FF2 has no medal-award banner',
    note:
      '`_CORRECTIONS.md` quotes this as "<medal> Medal AwarDeD!". The bytes say ' +
      '`________ medal AwarDeD!` — eight underscores, lower-case `medal`.',
  },
  {
    id: 'explorationEnding',
    select: 'panel_endUI_exploration/text_end',
    vehicles: ['hoverjet'],
    ff2: 'nothing — Free Flight has no end screen in FF2 yet',
  },
  {
    id: 'orbsFound',
    select: 'panel_endUI_exploration/text_orbsCleared',
    vehicles: ['hoverjet'],
    ff2: "src/boot/app.ts — literal 'ORBS' as the non-Ring-Attack count label",
  },

  // ── chrome FF2 does not show, kept because it is one line to keep ───────
  {
    id: 'changeView',
    select: 'panel_viewSwitch/Text',
    vehicles: ['hoverjet'],
    ff2: 'nothing — FF2 has no view-switch prompt',
  },
]

/**
 * The mission briefing -- the one string that is CONTENT rather than chrome.
 *
 * It lives on the ship prefab, not on the mission scene, so it reaches a level
 * through `Level.ShipPrefab`: the same resolution that decides the vehicle. That
 * is why it is emitted per level rather than once (CLAUDE.md rule 6, content is
 * data) even though all seven HoverJet missions resolve to the same prefab and
 * therefore the same words. A mission that ever shipped its own copy would
 * simply differ, with no code change anywhere.
 *
 * `panel_mission` is killed at 3.8 s by its OWN `disableAfterDelay` —
 * `disableDelay: 3.8`, enabled, targeting itself, on BOTH ship prefabs
 * (`PlayerShip_SR14_Photon.prefab:10176`/`:12320`,
 * `JumpSeat_Photon.prefab:45182`/`:48673`). Whether it is ever SEEN is per
 * prefab and is reported as `liveAtSpawn`, not asserted here — see
 * `briefingNote` (`docs/research/_ui-flow.md` §4).
 *
 * **Do not "correct" that 3.8 to 4.12.** `HUD_Ship.DelayedStart` hides the panel
 * a SECOND time at `0.12f + 4f` (`HUD_Ship.cs:88-99`), against something that
 * has been inactive for 0.32 s. Both numbers are real; only 3.8 is observable.
 * DEV-200 made exactly that trade on the strength of a citation pointing at
 * `HUD_Ship.cs` instead of the prefab, and DEV-217 undid it.
 */
export const BRIEFING_SELECT = 'panel_mission/Text'

/**
 * Does `path` end with `select`, ignoring Unity's duplicate suffixes?
 *
 * Unity renames a duplicated GameObject `name (1)`, `name (2)`, and both ship
 * prefabs are full of them: the first-person view prompt is `panel_viewSwitch
 * (1)/Text` and the first-person pause menu is `panel_pause (1)`, while their
 * third-person twins keep the bare name. A selector written against the bare
 * name therefore matched the THIRD-person copy and silently preferred it — the
 * one string in the table that came out of the wrong HUD before this existed.
 * So each segment is compared with its ` (N)` suffix stripped.
 */
const stripDup = (seg) => seg.replace(/ \(\d+\)$/, '')
const matchesSelect = (p, select) => {
  const want = select.split('/').map(stripDup)
  const have = String(p).split('/').map(stripDup)
  if (have.length < want.length) return false
  return want.every((w, k) => have[have.length - want.length + k] === w)
}

/**
 * Resolve every selector against one prefab's labels.
 *
 * Preference order inside a selector's matches is FIRST-PERSON, then whatever
 * else is there -- see `hudRootOf`. Every distinct string a selector matched is
 * reported in `variants`, so a disagreement between the two HUDs is visible in
 * the output instead of being silently resolved by whichever node sorted first.
 */
export function selectUiStrings(rows, vehicle, { prefabRel }) {
  const strings = {}
  const meta = {}
  const problems = []

  const pick = (select, occurrence) => {
    let hits = rows.filter((r) => matchesSelect(r.path, select))
    const fp = hits.filter((r) => r.hud === 'firstPerson')
    const chosenHud = fp.length ? 'firstPerson' : hits.length ? hits[0].hud : null
    if (fp.length) hits = fp
    if (occurrence !== undefined) {
      // Disambiguate same-named siblings by document order, which is the order
      // `readPrefabTexts` sorted them into (path, then fileID).
      hits = hits.length > occurrence ? [hits[occurrence]] : []
    }
    return { hits, chosenHud }
  }

  for (const spec of UI_STRINGS) {
    if (spec.vehicles && !spec.vehicles.includes(vehicle)) continue
    const { hits, chosenHud } = pick(spec.select, spec.occurrence)
    if (!hits.length) {
      problems.push(`ui.${spec.id}: selector "${spec.select}" matched no Text in ${prefabRel}`)
      continue
    }
    const chosen = hits[0]
    if (chosen.text === null) {
      problems.push(`ui.${spec.id}: no m_Text decoded for fileID ${chosen.fileID} in ${prefabRel}`)
      continue
    }
    strings[spec.id] = chosen.text
    const all = rows.filter((r) => matchesSelect(r.path, spec.select) && r.text !== null)
    const variants = [...new Set(all.map((r) => r.text))].filter((t) => t !== chosen.text)
    meta[spec.id] = {
      select: spec.select,
      path: chosen.path,
      fileID: chosen.fileID,
      line: chosen.line,
      hud: chosenHud,
      liveAtSpawn: chosen.live,
      matched: all.length,
      ff2: spec.ff2,
      ...(spec.note ? { note: spec.note } : {}),
      ...(variants.length
        ? {
            variants: variants.map((t) => ({
              text: t,
              at: all.filter((r) => r.text === t).map((r) => `${r.hud}:${r.path}#${r.fileID}`),
            })),
          }
        : {}),
    }
  }
  return { strings, meta, problems }
}

/**
 * The note that rides with the briefing, DERIVED rather than hard-coded.
 *
 * It was one constant string for every level until DEV-217, which made it wrong
 * for the six JumpSeat missions in three ways at once: it asserted
 * `m_IsActive: 1` while the `liveAtSpawn` key two lines above it in the same
 * block said `false`; it cited the HoverJet prefab's line numbers; and it
 * described a second hide that only the HoverJet has. `HUD_Gameplay` -- the
 * JumpSeat's HUD -- has no `HideMissionUI` at all.
 *
 * Note what it no longer does: **restate `liveAtSpawn`.** A note that repeats a
 * fact the block already carries is a second copy of a derivable value, and it
 * went stale exactly the way CLAUDE.md says a copied count does -- by
 * contradicting the original in six of thirteen files, in the same object.
 *
 * The two vehicles DO agree on the figure: `disableDelay` is 3.8 on every
 * `panel_mission` either prefab has. That is the part worth stating once.
 */
const briefingNote = (prefabRel) => {
  const hoverJet = prefabRel.endsWith('PlayerShip_SR14_Photon.prefab')
  const at = hoverJet
    ? 'PlayerShip_SR14_Photon.prefab:10176 and :12320'
    : 'JumpSeat_Photon.prefab:45182 and :48673'
  const second = hoverJet
    ? 'HUD_Ship.DelayedStart (HUD_Ship.cs:88-99) then hides it a SECOND time at 0.12+4=4.12 s, ' +
      'against a panel already inactive for 0.32 s. 4.12 is real but it is NOT the figure: ' +
      'DEV-200 made that trade on the strength of a citation pointing at HUD_Ship.cs rather than ' +
      'at the prefab, and DEV-217 undid it. '
    : 'There is no second hide on this vehicle -- the JumpSeat HUD is HUD_Gameplay, which has no ' +
      'HideMissionUI. '
  return (
    'panel_mission carries its own disableAfterDelay: disableDelay 3.8, enabled, targeting ' +
    `itself, at ${at}, mechanism in disableAfterDelay.cs:8-16. disableDelay is a public float ` +
    'with NO initialiser, so 3.8 is shipped behaviour and not a code default. A panel live at ' +
    'spawn (see liveAtSpawn above) is therefore killed 3.8 s after spawn; one that is not does ' +
    'not start its countdown until something activates it, because Start() does not run on an ' +
    'inactive GameObject. What activates it, if anything, is NOT traced here. ' +
    second +
    'Ends in a newline, which is in the shipped bytes.'
  )
}

/** The briefing, resolved the same way but returned on its own -- it is content. */
export function selectBriefing(rows, { prefabRel }) {
  const hits = rows.filter((r) => matchesSelect(r.path, BRIEFING_SELECT))
  if (!hits.length) {
    return { text: null, meta: { select: BRIEFING_SELECT, problem: `no match in ${prefabRel}` } }
  }
  const fp = hits.filter((r) => r.hud === 'firstPerson')
  const chosen = (fp.length ? fp : hits)[0]
  const variants = [...new Set(hits.map((r) => r.text))].filter((t) => t !== chosen.text)
  return {
    text: chosen.text,
    meta: {
      select: BRIEFING_SELECT,
      path: chosen.path,
      fileID: chosen.fileID,
      line: chosen.line,
      hud: chosen.hud,
      prefab: prefabRel,
      liveAtSpawn: chosen.live,
      matched: hits.length,
      ...(variants.length ? { variants } : {}),
      note: briefingNote(prefabRel),
    },
  }
}
