import type { Cache, Spend } from '../types'
import { inLight } from './scheme'

// ── The Cache module's figures and pictures ─────────────────────────────────
// Prices are in token-equivalents of an uncached input token, so they hold
// whatever a token costs: a read from the cache is a tenth, a write to the
// one-hour cache twice.

export const READ_PRICE = 0.1
export const WRITE_PRICE = 2
/** At most this many main-thread requests are kept for the session's strip. */
export const LOG_MAX = 120

/** The tokens one request carried in. */
export const inputOf = (c: Cache) => c.read + c.written + c.uncached

/** What the next message costs: read from a warm cache, or all written afresh once cold. */
export const nextCost = (last: Cache) => {
  const tokens = inputOf(last)

  return { tokens, warm: Math.round(tokens * READ_PRICE), cold: Math.round(tokens * WRITE_PRICE) }
}

/** What the cache spared the main thread so far, against sending it all uncached. */
export const savedOf = (s: Spend) => Math.round(s.cacheRead * (1 - READ_PRICE))

/** The share of a request read from the cache, 0 to 1. */
export const hitOf = (c: Cache) => {
  const all = inputOf(c)

  return all === 0 ? 0 : c.read / all
}

/** A request that wrote more than it read started the cache afresh. */
export const isColdStart = (c: Cache) => c.written > c.read

/** The log with one more request, the oldest dropped past `max`. */
export const appendLog = (log: readonly Cache[], entry: Cache, max = LOG_MAX): Cache[] => [...log, entry].slice(-max)

const GREEN = '#3FB68B'
const AMBER = '#F0A63A'
const CORAL = '#E0714A'
const GRAY = '#888780'
const TRACK = `fill="#888" fill-opacity="0.25"`

export const CACHE_COLORS = { read: GREEN, written: AMBER, uncached: GRAY, miss: CORAL, warm: GREEN, cooling: AMBER } as const

const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`

/** The hour the cache holds, filled with what is left, and a tick where the warning comes. */
export const countdownSvg = (left: number, warnAt: number, color: string, width: number, height: number): string => {
  const r = height / 2
  const filled = left <= 0 ? 0 : Math.max(height, Math.round(Math.min(1, left) * width))
  const tick = Math.round(Math.min(1, Math.max(0, warnAt)) * width)

  return svg(
    width,
    height,
    `<rect width="${width}" height="${height}" rx="${r}" ${TRACK}/>` +
      (filled > 0 ? `<rect width="${filled}" height="${height}" rx="${r}" fill="${color}"/>` : '') +
      `<style>.tick{fill:#fff;fill-opacity:.7}${inLight('.tick{fill:#000;fill-opacity:.55}')}</style>` +
        `<rect class="tick" x="${Math.max(0, tick - 1)}" width="1.5" height="${height}"/>`,
  )
}

/** One bar split end to end by parts, each in its colour, with a hairline between. */
export const splitBarSvg = (parts: readonly { tokens: number; color: string }[], width: number, height: number): string => {
  const total = parts.reduce((n, p) => n + p.tokens, 0)
  const r = height / 2
  let x = 0
  let body = ''

  if (total > 0) {
    for (const p of parts) {
      if (p.tokens <= 0) continue

      const w = Math.max(2, (p.tokens / total) * width)

      body += `<rect x="${x.toFixed(1)}" width="${Math.max(0, Math.min(w, width - x) - 1).toFixed(1)}" height="${height}" fill="${p.color}"/>`
      x += w
    }
  }

  return svg(
    width,
    height,
    `<clipPath id="cache-split-clip"><rect width="${width}" height="${height}" rx="${r}"/></clipPath>` +
      `<rect width="${width}" height="${height}" rx="${r}" ${TRACK}/><g clip-path="url(#cache-split-clip)">${body}</g>`,
  )
}

/** One bar a request, its height the share read from the cache, a cold start in coral. */
export const stripSvg = (log: readonly Cache[], width: number, height: number): string => {
  const slot = 5
  const shown = log.slice(-Math.max(1, Math.floor(width / slot)))
  const bar = Math.max(1, slot - 2)
  const x0 = width - shown.length * slot

  return svg(
    width,
    height,
    shown
      .map((c, i) => {
        const cold = isColdStart(c)
        const h = cold ? height : Math.max(2, Math.round(hitOf(c) * height))

        return `<rect x="${x0 + i * slot}" y="${height - h}" width="${bar}" height="${h}" rx="1" fill="${cold ? CORAL : GREEN}" fill-opacity="${cold ? 1 : 0.75}"/>`
      })
      .join(''),
  )
}

const BLOCKS = '▁▂▃▄▅▆▇█'

/** The same strip for the terminal: one block a request, `×` for a cold start. */
export const stripText = (log: readonly Cache[], columns: number): string =>
  log
    .slice(-Math.max(1, columns))
    .map(c => (isColdStart(c) ? '×' : BLOCKS[Math.min(BLOCKS.length - 1, Math.round(hitOf(c) * (BLOCKS.length - 1)))]))
    .join('')
