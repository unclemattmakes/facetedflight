// T03, the constants browser. DEV-512 (docs/plan/MAKING-OF.md §4).
//
// Every number the 2016 game ran on, as the extractor read it: its value, its
// unit, how far it can be trusted, and the 2016 scripts that read it. This is
// the file `src/generated/constants.generated.json`, loaded when the toy
// mounts (it is large), and nothing on this page is typed by hand.

import type { ToyDef } from '../shared/toy-host'

interface Entry {
  readonly trust: string
  readonly unit: string | null
  readonly origin: string
  readonly source: string | null
  readonly note: string | null
  readonly consumers: readonly string[] | null
}
interface Sheet {
  readonly provenance: Readonly<Record<string, Entry>>
  readonly [k: string]: unknown
}

const valueAt = (sheet: Sheet, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>((n, part) => (n as Record<string, unknown> | undefined)?.[part], sheet)

const TRUST_HELP: Record<string, string> = {
  verified: 'read from the prefab or scene the game shipped',
  derived: 'computed from verified numbers by a stated formula',
  'code-default': 'only the C# initializer says so, and the field is private',
}

export const toy: ToyDef = {
  id: 'constants-browser',
  title: 'Constants browser',
  caption:
    'Filter by how far a number can be trusted, or search a name. The note column says what the extractor found.',
  kind: '2d',
  async mount({ stage, controls }) {
    stage.classList.add('toy-surface')
    stage.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'poster',
        textContent: 'Loading the sheet',
      }),
    )
    const sheet = (await import('../../generated/constants.generated.json'))
      .default as unknown as Sheet
    const keys = Object.keys(sheet.provenance).sort()
    const trusts = [...new Set(keys.map((k) => sheet.provenance[k]?.trust ?? ''))].sort()
    const out = controls.readouts()
    let trust = 'all'
    let query = ''
    let open: string | null = null

    const scroller = document.createElement('div')
    scroller.className = 'table-scroll'
    stage.replaceChildren(scroller)

    const render = () => {
      const q = query.trim().toLowerCase()
      const rows = keys.filter((k) => {
        const e = sheet.provenance[k]
        if (!e) return false
        if (trust !== 'all' && e.trust !== trust) return false
        return q === '' || k.toLowerCase().includes(q)
      })
      const table = document.createElement('table')
      table.className = 'const-table'
      const head = table.createTHead().insertRow()
      for (const t of ['key', 'value', 'trust']) head.insertCell().textContent = t
      const body = table.createTBody()
      for (const k of rows.slice(0, 200)) {
        const e = sheet.provenance[k] as Entry
        const tr = body.insertRow()
        tr.insertCell().textContent = k
        const v = valueAt(sheet, k)
        const text = typeof v === 'object' ? JSON.stringify(v) : String(v)
        tr.insertCell().textContent = `${text.length > 90 ? `${text.slice(0, 90)}...` : text}${e.unit ? ` ${e.unit}` : ''}`
        tr.insertCell().textContent = e.trust
        tr.addEventListener('click', () => {
          open = open === k ? null : k
          render()
        })
        if (open === k) {
          const d = body.insertRow()
          const cell = d.insertCell()
          cell.colSpan = 3
          cell.className = 'const-detail'
          cell.textContent = [
            e.note,
            e.source ? `source: ${e.source}` : null,
            e.consumers?.length ? `read by: ${e.consumers.slice(0, 4).join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('\n')
        }
      }
      scroller.replaceChildren(table)
      out.update([
        { label: 'showing', value: `${Math.min(rows.length, 200)} of ${rows.length}` },
        { label: 'in the sheet', value: String(keys.length) },
        ...(trust !== 'all' ? [{ label: trust, value: TRUST_HELP[trust] ?? '' }] : []),
      ])
    }

    controls.segmented<string>({
      options: [{ value: 'all', label: 'all' }, ...trusts.map((t) => ({ value: t, label: t }))],
      value: trust,
      onChange: (v) => {
        trust = v
        render()
      },
    })
    controls.search('search a name', (text) => {
      query = text
      render()
    })
    render()
    return { dispose: () => stage.classList.remove('toy-surface') }
  },
}
