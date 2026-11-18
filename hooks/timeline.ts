import type { AgentRun, AgentStatus, ToolEntry } from '../types'

/**
 * The Subagents pane's timeline: every agent on one time axis. The geometry is
 * pure, so one scale serves every row and the tests can check it without a pane.
 */

/** The drawing's width in its own units; the surface scales it down to the pane. */
export const TIMELINE_WIDTH = 320

/** A row's height: a thin bar, with room above it for the dot of a failed call. */
export const ROW_HEIGHT = 12

const BAR_TOP = 5
const BAR_HEIGHT = 6
/** The shortest bar drawn, a dot: an agent that ended at once is still there. */
const MIN_BAR = 6
/** Labels closer than this would run into each other. */
const LABEL_GAP = 34
/** The axis names at most this many moments: the start, up to two between, the end. */
const MAX_MIDS = 2

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif`

/** A time as the axis reads it: `0:45`, `1:24`, `1:02:03`. */
export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const s = `${seconds % 60}`.padStart(2, '0')
  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return `${minutes}:${s}`

  return `${Math.floor(minutes / 60)}:${`${minutes % 60}`.padStart(2, '0')}:${s}`
}

/** The span every row is drawn against. */
export type Scale = {
  /** The earliest start of the listed runs. */
  start: number
  /** Now while one runs, else the latest end. */
  end: number
  /** `end - start`, never under a second, so a lone instant agent has a scale. */
  span: number
  /** Whether the right edge is now. */
  isLive: boolean
}

export const scaleOf = (runs: readonly AgentRun[], now: number): Scale => {
  const isLive = runs.some(r => r.status === 'running')
  const start = runs.length === 0 ? now : Math.min(...runs.map(r => r.startedAt))
  const end = isLive || runs.length === 0 ? now : Math.max(...runs.map(r => r.endedAt ?? now))

  return { start, end: Math.max(end, start), span: Math.max(end - start, 1000), isLive }
}

/** Where a moment falls on a row `width` wide, kept to the row. */
export const xAt = (scale: Scale, time: number, width: number): number =>
  Math.min(width, Math.max(0, ((time - scale.start) / scale.span) * width))

/** Oldest first: the order a timeline reads down. */
export const byStart = (runs: readonly AgentRun[]): AgentRun[] =>
  [...runs].sort((a, b) => a.startedAt - b.startedAt)

export type Bar = { x: number; w: number }

/** A run's bar: from its start to its end, or to now while it runs. */
export const barOf = (run: AgentRun, scale: Scale, width: number, now: number): Bar => {
  const x0 = xAt(scale, run.startedAt, width)
  const x1 = xAt(scale, run.status === 'running' ? now : (run.endedAt ?? now), width)
  const w = Math.max(MIN_BAR, x1 - x0)

  // A short bar at the very end stays inside the row.
  return { x: Math.min(x0, Math.max(0, width - w)), w: Math.min(w, width) }
}

export type ErrorDot = { x: number }

/** Where a call failed: the only calls the timeline marks, a small dot above the bar each. */
export const errorsOf = (feed: readonly ToolEntry[], scale: Scale, width: number): ErrorDot[] => {
  const xs = new Set<number>()

  for (const call of feed) {
    if (call.status === 'error') xs.add(Math.round(xAt(scale, call.startedAt, width)))
  }

  return [...xs].sort((a, b) => a - b).map(x => ({ x }))
}

// Steps the axis counts in: seconds for a short span, then whole minutes.
const STEPS = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400].map(s => s * 1000)

/** A moment on the axis: `0s`, `30s`, `5m`, `1h`, `1h 30m`. */
export const axisLabel = (ms: number): string => {
  const seconds = Math.round(ms / 1000)

  if (seconds < 60) return `${seconds}s`

  if (seconds % 60 !== 0) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`

  const minutes = seconds / 60

  if (minutes < 60) return `${minutes}m`

  const rest = minutes % 60

  return rest === 0 ? `${minutes / 60}h` : `${Math.floor(minutes / 60)}h ${rest}m`
}

export type Mark = { x: number; label: string }

/**
 * The axis's labels, few and calm: the start, at most two between, and the end
 * (`now` while it runs, else the whole span). The step is the smallest that keeps it so.
 */
export const marksOf = (scale: Scale, width: number, gap = LABEL_GAP): Mark[] => {
  const midsFor = (step: number) => {
    const mids: Mark[] = []

    for (let t = step; t < scale.span; t += step) {
      const x = (t / scale.span) * width

      // The end's own label takes the right edge.
      if (width - x >= gap && x >= gap) mids.push({ x, label: axisLabel(t) })
    }

    return mids
  }
  const step = STEPS.find(s => midsFor(s).length <= MAX_MIDS) ?? STEPS[STEPS.length - 1]!

  const inMinutes = scale.span >= 120_000
  const end = inMinutes ? axisLabel(Math.round(scale.span / 60_000) * 60_000) : axisLabel(scale.span)

  return [
    { x: 0, label: inMinutes ? '0m' : '0s' },
    ...midsFor(step),
    { x: width, label: scale.isLive ? 'now' : end },
  ]
}

/** The same colour per status in the drawing and beside it in text. */
export const BAR_COLORS: Record<AgentStatus, string> = {
  running: '#9B6BFF',
  done: '#5FAF84',
  failed: '#E5484D',
  stopped: '#E8A317',
}

/** The one mark of status beside a row: the only colour on it. */
export const STATUS_MARK: Record<AgentStatus, { glyph: string; color: string }> = {
  running: { glyph: '●', color: BAR_COLORS.running },
  done: { glyph: '✓', color: 'success' },
  failed: { glyph: '✗', color: 'error' },
  stopped: { glyph: '■', color: 'warning' },
}

const n = (v: number) => +v.toFixed(2)

const open = (width: number, height: number, style: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<style>${style}</style>`

/** One agent's row: a thin flat bar, and a small red dot above it for each failed call. */
export const rowSvg = (
  run: AgentRun,
  feed: readonly ToolEntry[],
  scale: Scale,
  now: number,
  width = TIMELINE_WIDTH,
): string => {
  const bar = barOf(run, scale, width, now)
  const color = BAR_COLORS[run.status]
  const dots = errorsOf(feed, scale, width)
    .map(d => `<circle cx="${Math.min(width - 2, Math.max(2, d.x))}" cy="2" r="1.8" fill="#FF3B47"/>`)
    .join('')
  const style =
    `.cap{animation:cap 1.6s ease-in-out infinite}` +
    `@keyframes cap{0%,100%{opacity:.15}50%{opacity:.85}}` +
    `@media (prefers-reduced-motion:reduce){.cap{animation:none;opacity:.5}}`
  const mid = BAR_TOP + BAR_HEIGHT / 2

  return (
    open(width, ROW_HEIGHT, style) +
    `<rect x="${n(bar.x)}" y="${BAR_TOP}" width="${n(bar.w)}" height="${BAR_HEIGHT}" rx="${BAR_HEIGHT / 2}" fill="${color}"/>` +
    // Only the leading end cap of a running bar softly pulses: it is still growing.
    (run.status === 'running'
      ? `<circle class="cap" cx="${n(bar.x + bar.w - BAR_HEIGHT / 2)}" cy="${mid}" r="${BAR_HEIGHT / 2}" fill="#E4D6FF"/>`
      : '') +
    dots +
    `</svg>`
  )
}

const AXIS_HEIGHT = 12

/** The few labels of the axis, on the same width as every row, so it lines up with the bars. */
export const axisSvg = (scale: Scale, width = TIMELINE_WIDTH): { source: string; height: number; alt: string } => {
  const marks = marksOf(scale, width)
  const text = marks
    .map((m, i) => {
      const anchor = i === 0 ? 'start' : i === marks.length - 1 ? 'end' : 'middle'

      return `<text x="${n(m.x)}" y="9.5" text-anchor="${anchor}">${m.label}</text>`
    })
    .join('')
  const style = `text{font:500 10px ${FONT};fill:#8A8A93;font-variant-numeric:tabular-nums}`

  return {
    source: open(width, AXIS_HEIGHT, style) + text + `</svg>`,
    height: AXIS_HEIGHT,
    alt: `Time axis: ${marks.map(m => m.label).join(', ')}`,
  }
}

/** A row's alt text: for a reader that cannot see the bar. */
export const rowAlt = (run: AgentRun, feed: readonly ToolEntry[], now: number): string => {
  const errors = feed.filter(c => c.status === 'error').length
  const word = run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : run.status === 'failed' ? 'Failed' : 'Stopped'

  return (
    `${word} for ${clock((run.endedAt ?? now) - run.startedAt)}, ${run.tools} ${run.tools === 1 ? 'tool call' : 'tool calls'}` +
    (errors > 0 ? `, ${errors} failed` : '')
  )
}

/** The dim text on the right of a row: `42 tools · 11:07`. Its status mark is drawn beside it. */
export const statLine = (run: AgentRun, now: number): string =>
  `${run.tools} ${run.tools === 1 ? 'tool' : 'tools'} · ${clock((run.endedAt ?? now) - run.startedAt)}`

export type TextBar = { before: string; fill: string }

/** The terminal's bar: one thin line for the run, set at its place among `columns`. */
export const textBar = (run: AgentRun, scale: Scale, columns: number, now: number): TextBar => {
  const bar = barOf(run, scale, columns, now)
  const from = Math.min(columns - 1, Math.max(0, Math.round(bar.x)))
  const cells = Math.max(1, Math.min(columns - from, Math.round(bar.x + bar.w) - from))

  return { before: ' '.repeat(from), fill: '━'.repeat(cells) }
}

/** The terminal's axis: the labels set at their columns, none over another. */
export const textAxis = (scale: Scale, columns: number): string => {
  const cells = new Array<string>(columns).fill(' ')
  let taken = -1

  for (const [i, m] of marksOf(scale, columns, 8).entries()) {
    const isEnd = i > 0 && m.x >= columns
    const at = isEnd ? columns - m.label.length : Math.round(m.x) - (i === 0 ? 0 : Math.floor(m.label.length / 2))
    const from = Math.max(0, Math.min(at, columns - m.label.length))

    if (from <= taken) continue

    for (const [k, ch] of [...m.label].entries()) cells[from + k] = ch

    taken = from + m.label.length + 1
  }

  return cells.join('').trimEnd()
}

/** Terminal columns for the bar: the pane's body less the margin, kept to a sane range. */
export const barColumns = (bodyColumns: number): number => Math.max(12, Math.min(80, Math.floor(bodyColumns)))
