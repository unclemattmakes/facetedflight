// tools/making-of/plugin.ts: the making-of site's build plugin. DEV-506.
//
// The site is pages inside the game's own Vite build (docs/plan/MAKING-OF.md
// §2.1): `making-of/<slug>/index.html`, toy code in `src/making-of/`. This
// plugin does the three things a plain Vite build does not:
//
//   1. adds each BUILDABLE page as a Rollup input. Setting `rollupOptions.input`
//      replaces Vite's default, so the game's own `index.html` is listed too.
//      A release build leaves `draft` chapters out (`chapters.ts`).
//   2. injects the shared nav, chapter header, prev/next, cards and footer at
//      build from `chapters.ts`, so the pages read without JS and there is ONE
//      nav, not twelve copies.
//   3. resolves `data-const` and `data-snippet` (`source-truth.ts`).
//
// Nothing here runs in the game: `apply` is both, but it touches only
// `/making-of/` pages and adds nothing to the game's own input.

import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import {
  builtChapters,
  type Chapter,
  SITE_PAGES,
  visibleChapters,
} from '../../src/making-of/chapters'
import { resolveSources } from './source-truth'

type Channel = 'release' | 'preview'

const escapeHtml = (s: string): string =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const href = (slug: string): string => (slug === 'index' ? '/making-of/' : `/making-of/${slug}/`)

/** Every `making-of/**` page that exists on disk, as a slug. */
export const pagesOnDisk = (root: string): string[] => {
  const dir = path.join(root, 'making-of')
  if (!existsSync(dir)) return []
  const slugs: string[] = []
  if (existsSync(path.join(dir, 'index.html'))) slugs.push('index')
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(path.join(dir, e.name, 'index.html'))) slugs.push(e.name)
  }
  return slugs
}

/** The pages a build of this channel emits: the site's own, plus the buildable chapters. */
export const buildablePages = (root: string, channel: Channel): string[] => {
  const chapters = new Set(builtChapters(channel).map((c) => c.slug))
  return pagesOnDisk(root).filter(
    (slug) => (SITE_PAGES as readonly string[]).includes(slug) || chapters.has(slug),
  )
}

const nav = (): string =>
  `<nav class="site-nav"><span class="nav-left">` +
  // DEV-803's title-screen button, made by the same code at run time (chrome.ts -> render/uncle-matt-link.ts).
  `<a data-uncle-matt-link></a>` +
  `<a class="brand" href="/making-of/">Making of <b>Faceted Flight</b></a></span>` +
  `<span class="links"><a href="/making-of/">Chapters</a>` +
  `<a href="/making-of/playground/">Playground</a>` +
  `<a class="play" href="/">Play the game</a></span></nav>`

const header = (c: Chapter): string =>
  `<header class="page-header"><div class="breadcrumb">${/^\d+$/.test(c.number) ? `Chapter ${escapeHtml(c.number)}` : escapeHtml(c.number)}</div>` +
  `<h1 class="page-title">${escapeHtml(c.title)}</h1>` +
  `<p class="page-subtitle">${escapeHtml(c.pitch)}</p>` +
  (c.status === 'draft' ? `<p class="draft-flag">Draft: visible on preview builds only.</p>` : '') +
  `</header>`

const cards = (channel: Channel): string =>
  `<div class="chapter-cards">${visibleChapters(channel)
    .map((c) => {
      const body =
        `<span class="card-num">${escapeHtml(c.number)}</span>` +
        `<span class="card-title">${escapeHtml(c.title)}</span>` +
        `<span class="card-pitch">${escapeHtml(c.pitch)}</span>` +
        (c.toys.length ? `<span class="tag">demo</span>` : '') +
        (c.status === 'planned' ? `<span class="tag soon">coming</span>` : '') +
        (c.status === 'draft' ? `<span class="tag soon">draft</span>` : '')
      return c.status === 'planned'
        ? `<div class="chapter-card planned">${body}</div>`
        : `<a class="chapter-card" href="${href(c.slug)}">${body}</a>`
    })
    .join('')}</div>`

const pagenav = (slug: string, channel: Channel): string => {
  const order = builtChapters(channel)
  const i = order.findIndex((c) => c.slug === slug)
  if (i < 0) return ''
  const prev = order[i - 1]
  const next = order[i + 1]
  const link = (c: Chapter, dir: string) =>
    `<a href="${href(c.slug)}"><span class="nav-dir">${dir}</span><span class="nav-title">${escapeHtml(c.title)}</span></a>`
  return `<div class="page-nav">${prev ? link(prev, '&larr; Previous') : ''}${next ? link(next, 'Next &rarr;') : ''}</div>`
}

const footer = (): string =>
  `<footer class="site-footer"><p><b>Faceted Flight: 10th Anniversary Edition</b></p>` +
  `<p><a href="/">Play it</a> · <a href="/making-of/">Making of</a> · <a href="/privacy">Privacy</a></p>` +
  // The title screen's own line (version and copyright), filled from the game by chrome.ts.
  `<p class="title-line" data-title-line></p></footer>`

/** The whole pass over one page's HTML. Exported for the unit tests. */
export const transformPage = (
  root: string,
  slug: string,
  html: string,
  channel: Channel,
): string => {
  const chapter = builtChapters(channel).find((c) => c.slug === slug)
  const out = html
    .replace('<!--ff2:nav-->', nav())
    .replace('<!--ff2:header-->', chapter ? header(chapter) : '')
    .replace('<!--ff2:cards-->', cards(channel))
    .replace('<!--ff2:pagenav-->', pagenav(slug, channel))
    .replace('<!--ff2:footer-->', footer())
  return resolveSources(root, out, `making-of/${slug}`)
}

export const makingOfPlugin = (channel: Channel): Plugin => {
  let root = process.cwd()
  return {
    name: 'ff2-making-of',
    config(userConfig, env) {
      root = path.resolve(userConfig.root ?? process.cwd())
      if (env.command !== 'build') return undefined
      const input: Record<string, string> = { main: path.join(root, 'index.html') }
      for (const slug of buildablePages(root, channel)) {
        input[`making-of-${slug}`] = path.join(
          root,
          'making-of',
          slug === 'index' ? 'index.html' : `${slug}/index.html`,
        )
      }
      return { build: { rollupOptions: { input } } }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const m = /^\/making-of\/(?:([^/]+)\/)?index\.html$/.exec(ctx.path)
        if (!m) return html
        return transformPage(root, m[1] ?? 'index', html, channel)
      },
    },
  }
}
