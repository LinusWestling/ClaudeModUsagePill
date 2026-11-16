import type { ToolEntry } from '../types'

/** Enough history for the expanded card, little enough that `$.state` stays small. */
export const MAX_FEED = 50

/** How many of the latest calls a card shows before `+N earlier`. */
export const FEED_ROWS = 5

/** Adds a call at the end, once: a call raised again keeps one row. */
export const startTool = (feed: readonly ToolEntry[], entry: ToolEntry, max = MAX_FEED): ToolEntry[] =>
  [...feed.filter(f => f.id !== entry.id), entry].slice(-max)

/** Settles a call where it stands; a call no longer kept is left alone. */
export const finishTool = (
  feed: readonly ToolEntry[],
  id: string,
  endedAt: number,
  isError: boolean,
): ToolEntry[] =>
  feed.map(f => (f.id === id ? { ...f, endedAt, status: isError ? 'error' : 'ok' } : f))

/** Settles what still runs when the agent ends: its calls end with it. */
export const settleTools = (feed: readonly ToolEntry[], endedAt: number, isError: boolean): ToolEntry[] =>
  feed.some(f => f.status === 'running')
    ? feed.map(f => (f.status === 'running' ? { ...f, endedAt, status: isError ? 'error' : 'ok' } : f))
    : [...feed]

/**
 * The rows a card draws, newest last, so a new call arrives at the bottom and the
 * oldest slides off the top; `hidden` is what `+N earlier` stands for.
 */
export const feedView = (
  feed: readonly ToolEntry[],
  isOpen: boolean,
  rows = FEED_ROWS,
): { rows: ToolEntry[]; hidden: number } => {
  if (isOpen || feed.length <= rows) return { rows: [...feed], hidden: 0 }

  return { rows: feed.slice(-rows), hidden: feed.length - rows }
}

/** A call's time: tenths under ten seconds, where most calls land. */
export const duration = (ms: number): string => {
  const at = Math.max(0, ms)

  if (at < 10_000) return `${(at / 1000).toFixed(1)}s`

  const seconds = Math.round(at / 1000)

  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const STATUS_GLYPH = { ok: '✓', error: '✗' } as const

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

/** A spinner frame for a surface that can only redraw text: one step per tick. */
export const spinnerFrame = (tick: number): string => SPINNER[Math.abs(Math.floor(tick)) % SPINNER.length]!

/**
 * A spinner that turns by itself, for a surface that draws SVG: no redraw
 * needed, and still where the person asked for reduced motion.
 */
export const spinnerSvg = (size: number, color = '#D97757'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16">` +
  `<style>.s{transform-origin:8px 8px;animation:s .8s linear infinite}` +
  `@keyframes s{to{transform:rotate(360deg)}}` +
  `@media (prefers-reduced-motion:reduce){.s{animation:none}}</style>` +
  `<circle cx="8" cy="8" r="6" fill="none" stroke="${color}" stroke-opacity=".25" stroke-width="2"/>` +
  `<path class="s" d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`
