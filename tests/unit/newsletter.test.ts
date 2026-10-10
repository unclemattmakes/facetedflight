// tests/unit/newsletter.test.ts: the title's newsletter row. DEV-658.
//
// The game opens a page and sends nothing, so what is worth pinning is that
// the row and the privacy page name the same place, that the link goes to the
// Faceted Flight list and not the whole site's, that the row sits last on the
// title's plate with no note (Matt: "remove the extra text"), and that
// `app.ts` keeps it out of a headset and opens it in a new tab.

import { describe, expect, it } from 'vitest'
import { NEWSLETTER_LABEL, NEWSLETTER_URL } from '@/net/newsletter'
import { privacyPage } from '@/net/privacy-page'
import {
  ENTER_VR_ROW_ID,
  MAKING_OF_PATH,
  MAKING_OF_ROW_ID,
  makingOfRow,
  NEWSLETTER_ROW_ID,
  newsletterRow,
  START_ROW,
  titleRows,
} from '@/render/title-menu'
import { appFileWith, codeOnly } from './helpers/app-source'

describe('DEV-658: the newsletter row', () => {
  it('goes to the signup page with only the Faceted Flight list ticked', () => {
    const url = new URL(NEWSLETTER_URL)
    expect(url.protocol).toBe('https:')
    expect(url.searchParams.get('list')).toBe('ff')
  })

  it("carries Matt's words and an envelope, and no note", () => {
    const row = newsletterRow()
    expect(NEWSLETTER_LABEL).toBe('Join the flight club')
    expect(row.label).toBe(`${String.fromCodePoint(0x2709)} Join the flight club`)
    expect(row.note).toBe('')
    expect(row.accentNote).toBeUndefined()
  })

  it('says what to do, in the accent, when the browser blocked the tab', () => {
    const row = newsletterRow(true)
    expect(row.note).not.toBe('')
    expect(row.accentNote).toBe(true)
  })

  it('is last on the title, under START and ENTER VR, and absent when not offered', () => {
    const base = { vr: 'connect' as const, link: null, start: null }
    const ids = (input: Parameters<typeof titleRows>[0]) => titleRows(input).map((r) => r.id)
    expect(ids({ ...base, newsletter: newsletterRow() })).toEqual([
      START_ROW.id,
      ENTER_VR_ROW_ID,
      NEWSLETTER_ROW_ID,
    ])
    expect(ids({ ...base, newsletter: null })).toEqual([START_ROW.id, ENTER_VR_ROW_ID])
  })

  it('DEV-802: the making-of row sits just above it, and goes nowhere in a headset', () => {
    const base = { vr: null, link: null, start: null }
    const ids = (input: Parameters<typeof titleRows>[0]) => titleRows(input).map((r) => r.id)
    expect(ids({ ...base, makingOf: makingOfRow(), newsletter: newsletterRow() })).toEqual([
      START_ROW.id,
      MAKING_OF_ROW_ID,
      NEWSLETTER_ROW_ID,
    ])
    expect(makingOfRow().label).toBe('The making-of')
    expect(MAKING_OF_PATH).toBe('/making-of/')
    expect(codeOnly(appFileWith('makingOfRow()').text)).toContain(
      'makingOf: render.renderer.xr.isPresenting ? null : makingOfRow()',
    )
    expect(codeOnly(appFileWith('MAKING_OF_ROW_ID) {').text)).toContain(
      'globalThis.location.assign(MAKING_OF_PATH)',
    )
  })

  it('app.ts keeps it out of a headset and opens it in a new tab', () => {
    expect(codeOnly(appFileWith('newsletterRow(newsletterBlocked)').text)).toContain(
      'newsletter: render.renderer.xr.isPresenting ? null : newsletterRow(newsletterBlocked)',
    )
    expect(codeOnly(appFileWith('NEWSLETTER_ROW_ID) {').text)).toContain(
      "globalThis.open(NEWSLETTER_URL, '_blank')",
    )
  })

  it('is on the privacy page, at the same address, with who holds the list', () => {
    const page = privacyPage()
    expect(page).toContain('<h2>The newsletter</h2>')
    expect(page).toContain(`href="${NEWSLETTER_URL}"`)
    expect(page).toContain('https://kit.com/privacy')
  })
})
