import { lockPhase, mascotMarkup, mascotStyle } from './mascot'
import type { Outfit } from '../types'
import type { TaskView } from './task'

export type PillModel = {
  task?: TaskView
  /**
   * The 5-hour plan window. `reset` is its reset as a bare local clock (`11:10`),
   * which takes the place of the word `session` in the chip. `out` (`out ~16:40`)
   * is set when its pace runs out before the reset: it turns the chip amber and
   * is what the alt text says.
   */
  session?: { percent: number; left?: string; out?: string; reset?: string }
  week?: number
  context?: { percent: number; label: string }
  /**
   * Warm while the prompt cache should still hold it; the ring is the time left.
   * `coolsIn`, in whole minutes, once it is close to going cold.
   */
  cache?: { isWarm: boolean; percentLeft: number; coolsIn?: number }
  isWorking: boolean
  /** Who stands in the task chip: it walks while subagents run. */
  mascot?: { outfit?: Outfit; running: number; celebrate?: boolean }
}

/**
 * Where the app's row lies relative to the drawing, in pixels: measured from
 * screenshots, as a mod can't ask. The drawing is placed one cell up and one left.
 */
export type Fit = {
  /** How far the row's top is below the drawing's; what's above it is clipped. */
  above: number
  /** How far the row's left edge is inside the drawing. */
  left: number
  /** How far the row's right edge is inside the drawing. */
  right: number
  /** Moves the mascot to the centre of the button's hover highlight, which differs. */
  mascot: { x: number; y: number }
}

export const MACOS: Fit = { above: 10, left: 1.5, right: 1, mascot: { x: -4, y: 0 } }
export const WINDOWS: Fit = { above: 17, left: 0, right: 0, mascot: { x: 0, y: -2 } }

const ROW = 40
const CORNER = 12
const SIZE = 11.5
/** The space kept around each section, inside the one border. */
const INSET = 4
const CHIP_PAD = 12
/** The mascot in the task chip, and what it takes from the chip's text. */
// Twice the grid: anything but a whole multiple smears its pixels.
const MASCOT_SIZE = 32
const MASCOT_ROOM = MASCOT_SIZE + 6
const MIN_BAR = 56
const MAX_BAR = 120
/** The hairline between two sections. */
const GAP = 1
const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif`

/** The border runs through all of these; hotter sets once a limit is near. */
const AURORA = ['#FF7A59', '#FF4FA3', '#9B6BFF', '#3FD0FF'] as const
const AMBER_EDGE = ['#FFB02E', '#FF8A3D', '#FFD166', '#FF7A59'] as const
const RED_EDGE = ['#FF4D4D', '#FF2E7E', '#FF7A59', '#FF4D4D'] as const

const AMBER = ['#FFB02E', '#FF8A3D'] as const
const RED = ['#FF4D4D', '#FF2E7E'] as const
const CORAL = ['#FF7A59', '#FF4FA3'] as const
const VIOLET = ['#9B6BFF', '#E36BFF'] as const
const CYAN = ['#3FD0FF', '#6B8CFF'] as const
const WARM = ['#FFB02E', '#FF7A59'] as const
const COLD = ['#3FD0FF', '#6B8CFF'] as const

/** For a limit, where filling up is bad. */
const limitColors = (percent: number, calm: readonly [string, string]) =>
  percent >= 90 ? RED : percent >= 70 ? AMBER : calm

/** Measured advances of the system font at weight 600, in em. */
const ADVANCE: Record<string, number> = {
  ' ': 0.2, '%': 0.863, '/': 0.295, '.': 0.232, k: 0.521, M: 0.851, h: 0.569,
  m: 0.843, l: 0.229, e: 0.541, f: 0.338, w: 0.765, a: 0.532, c: 0.53, t: 0.337,
  d: 0.582, S: 0.619, s: 0.498, i: 0.229, o: 0.559, n: 0.56, r: 0.36, W: 0.952, C: 0.704, D: 0.693,
  u: 0.56, ':': 0.255, '~': 0.6,
}

const widthOf = (text: string, isStrong = false): number => {
  let em = 0

  for (const c of text) {
    em += ADVANCE[c] ?? (c >= '0' && c <= '9' ? 0.645 : c >= 'A' && c <= 'Z' ? 0.68 : 0.56)
  }

  return em * SIZE * (isStrong ? 1 : 1.05) - text.length * 0.05
}

const escapeXml = (text: string) =>
  text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** Which section of the bar a chip is. */
export type ChipKind = 'task' | 'session' | 'week' | 'context' | 'cache'

/** Where a drawn chip lies across the drawing, in its pixels. */
export type ChipExtent = {
  kind: ChipKind
  x: number
  width: number
  /** The whole segment the chip owns, for its button: between its dividers, or the border. */
  segStart: number
  segEnd: number
}

type Gauge = {
  kind: Exclude<ChipKind, 'task'>
  percent: number
  colors: readonly [string, string]
  strong: string
  dim?: string
}

const gaugesOf = (m: PillModel): Gauge[] => {
  const gauges: Gauge[] = []

  if (m.session) {
    const colors = limitColors(m.session.percent, CORAL)

    gauges.push({
      kind: 'session',
      percent: m.session.percent,
      // Running out at this pace is a warning whatever the figure says yet.
      colors: m.session.out && colors === CORAL ? AMBER : colors,
      strong: `${Math.round(m.session.percent)}%`,
      dim: m.session.reset ?? 'session',
    })
  }

  if (m.week !== undefined) {
    gauges.push({
      kind: 'week',
      percent: m.week,
      colors: limitColors(m.week, VIOLET),
      strong: `${Math.round(m.week)}%`,
      dim: 'week',
    })
  }

  if (m.context) {
    gauges.push({
      kind: 'context',
      percent: m.context.percent,
      colors: limitColors(m.context.percent, CYAN),
      strong: m.context.label,
    })
  }

  if (m.cache) {
    const cools = m.cache.isWarm ? m.cache.coolsIn : undefined

    gauges.push({
      kind: 'cache',
      percent: m.cache.percentLeft,
      colors: cools !== undefined ? AMBER : m.cache.isWarm ? WARM : COLD,
      strong: cools !== undefined ? `Cools ${cools}m` : m.cache.isWarm ? 'Warm' : 'Cold',
      dim: 'cache',
    })
  }

  return gauges
}

const gaugeWidth = (g: Gauge) =>
  20 + widthOf(g.strong, true) + (g.dim ? 4 + widthOf(g.dim) : 0)

const gaugeChip = (g: Gauge) => gaugeWidth(g) + CHIP_PAD * 2

const taskChip = (task: TaskView, bar: number) =>
  CHIP_PAD * 2 +
  MASCOT_ROOM +
  widthOf(task.label) +
  10 +
  bar +
  (task.count ? 10 + widthOf(task.count, true) : 0)

/** The least room the chips can be drawn in. */
const neededWidth = (m: PillModel) => {
  const gauges = gaugesOf(m)
  const chips = gauges.reduce((sum, g) => sum + gaugeChip(g), 0)
  const task = m.task ? taskChip(m.task, MIN_BAR) : 0
  const gaps = gauges.length - 1 + (m.task ? 1 : 0)

  return INSET * 2 + task + chips + Math.max(0, gaps) * GAP
}

/**
 * The chips' widths, laid from `start`. Given the band's `cell` (in the drawing's
 * pixels; the drawing sits one cell left of the band), every chip after the first
 * starts on a cell's edge: a Box is placed in whole cells, so the button over a
 * chip can then start exactly where the chip does. A divider moves to the nearest
 * edge, or the next one where that would cut into a chip's content: less than a
 * cell either way. The last chip ends where it did.
 */
const snapToCells = (chips: readonly { natural: number; least: number }[], start: number, cell?: number): number[] => {
  if (!cell || chips.length < 2) return chips.map(c => c.natural)

  const end = start + chips.reduce((sum, c) => sum + c.natural, 0) + (chips.length - 1) * GAP
  const widths: number[] = []
  let at = start
  // Where the next chip would start unsnapped: each is snapped from there, so no drift adds up.
  let natural = start

  chips.forEach((c, i) => {
    if (i === chips.length - 1) {
      widths.push(end - at)

      return
    }

    natural += c.natural + GAP

    // The nearest edge, or the one after where that would cut into the chip's content.
    let next = Math.round(natural / cell) * cell

    if (next - GAP - at < c.least) next = Math.ceil(natural / cell) * cell
    widths.push(next - GAP - at)
    at = next
  })

  return widths
}

const draw = (m: PillModel, width: number, fit: Fit, cell?: number, now = 0) => {
  const { above, left: rowLeft, right: rowRight } = fit
  const mid = above + ROW / 2
  const text = (x: number, content: string, cls: string): string =>
    `<text x="${x.toFixed(1)}" y="${mid}" dy="0.35em" class="${cls}">${escapeXml(content)}</text>`
  const gauges = gaugesOf(m)
  const free = Math.max(0, width - rowLeft - neededWidth(m))

  // The bar grows only so far when it has steps to show; the rest is shared by all
  // the chips, so the row is filled edge to edge without the task taking it over.
  const bar = m.task?.steps ? Math.min(MAX_BAR, MIN_BAR + free) : MIN_BAR
  const chips = gauges.length + (m.task ? 1 : 0)
  const spare = chips === 0 ? 0 : (free - (m.task ? bar - MIN_BAR : 0)) / chips

  let body = ''
  let defs = ''
  let x = rowLeft + INSET
  // What was drawn where, for the buttons laid over the chips.
  const chipsDrawn: ChipExtent[] = []
  const widths = snapToCells(
    [
      ...(m.task ? [{ natural: taskChip(m.task, bar) + spare, least: taskChip(m.task, bar) }] : []),
      ...gauges.map(g => ({ natural: gaugeChip(g) + spare, least: gaugeChip(g) })),
    ],
    x,
    cell,
  )
  let chipIndex = 0

  const divider = (at: number) =>
    `<rect x="${at.toFixed(1)}" y="${mid - 9}" width="1" height="18" class="divider"/>`

  if (m.task) {
    const { label, steps, count } = m.task
    const barY = mid - 3
    const w = widths[chipIndex++]!
    // Its own place, not centred, so the button over it finds it at any width.
    const mascotAt = x + CHIP_PAD - 2 + fit.mascot.x
    const left = x + CHIP_PAD + MASCOT_ROOM
    const start = left + widthOf(label) + 10

    defs +=
      `<linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="${start.toFixed(1)}" x2="${(start + bar).toFixed(1)}" y1="0" y2="0"><stop offset="0" stop-color="#FF7A59"/><stop offset="1" stop-color="#B46BFF"/></linearGradient>` +
      `<clipPath id="bar"><rect x="${start.toFixed(1)}" y="${barY}" width="${bar.toFixed(1)}" height="6" rx="3"/></clipPath>`

    const mood = m.mascot?.celebrate ? 'celebrate' : m.mascot && m.mascot.running > 0 ? 'moving' : 'still'

    body +=
      `<g transform="translate(${mascotAt.toFixed(1)} ${mid - MASCOT_SIZE / 2 + fit.mascot.y}) scale(${MASCOT_SIZE / 16})" shape-rendering="crispEdges">${mascotMarkup(mood, m.mascot?.outfit)}</g>` +
      text(left, label, 'label')

    if (steps) {
      // One segment per step: done ones lit, the current one pulsing.
      const split = steps.length > 24 ? 1 : 2
      const segment = (bar - split * (steps.length - 1)) / steps.length
      let segments = ''

      steps.forEach((step, i) => {
        const at = (start + i * (segment + split)).toFixed(1)
        const rect = `x="${at}" y="${barY}" width="${segment.toFixed(1)}" height="6"`

        segments += `<rect ${rect} class="track"/>`

        if (step.status === 'completed') {
          segments += `<rect ${rect} fill="url(#fill)"/>`
        } else if (step.status === 'in_progress') {
          segments += `<rect ${rect} fill="url(#fill)"${m.isWorking ? ' class="pulse"' : ' opacity=".5"'}/>`
        }
      })

      body += `<g clip-path="url(#bar)">${segments}</g>`
    } else {
      // No list of steps to count: an honest sweep, not a made-up percentage.
      const sweep = Math.round(bar * 0.2)

      body +=
        `<rect x="${start.toFixed(1)}" y="${barY}" width="${bar.toFixed(1)}" height="6" rx="3" class="track"/>` +
        `<g clip-path="url(#bar)"><rect class="sweep" x="${(start - sweep).toFixed(1)}" y="${barY}" width="${sweep}" height="6" rx="3" fill="url(#fill)" style="--travel:${(bar + sweep).toFixed(0)}px"/></g>`
    }

    if (count) {
      body += text(start + bar + 10, count, 'value')
    }

    chipsDrawn.push({ kind: 'task', x, width: w, segStart: rowLeft + 1, segEnd: x + w })
    x += w + GAP

    if (gauges.length > 0) {
      body += divider(x - GAP)
    }
  }

  gauges.forEach((g, index) => {
    const id = `g${index}`
    const r = 5.5
    const circumference = 2 * Math.PI * r
    const dash = (Math.min(100, Math.max(0, g.percent)) / 100) * circumference
    const w = widths[chipIndex++]!

    // The contents sit centred in the chip, however wide the spare room made it.
    let at = x + (w - gaugeWidth(g)) / 2
    const cx = at + 7

    defs += `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.colors[0]}"/><stop offset="1" stop-color="${g.colors[1]}"/></linearGradient>`
    body += `<circle cx="${cx.toFixed(1)}" cy="${mid}" r="${r}" fill="none" class="ring" stroke-width="2.2"/>`

    if (dash > 0) {
      body +=
        `<circle cx="${cx.toFixed(1)}" cy="${mid}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="2.2" stroke-linecap="round" ` +
        `stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx.toFixed(1)} ${mid})"/>`
    }

    at += 20
    body += text(at, g.strong, 'value')
    at += widthOf(g.strong, true)

    if (g.dim) {
      body += text(at + 4, g.dim, 'dim')
    }

    chipsDrawn.push({ kind: g.kind, x, width: w, segStart: x - GAP, segEnd: x + w })
    x += w + GAP

    if (index < gauges.length - 1) {
      body += divider(x - GAP)
    }
  })

  const style =
    `text{font:500 ${SIZE}px ${FONT};font-variant-numeric:tabular-nums;letter-spacing:-.05px}` +
    `.divider{fill:rgba(255,255,255,.12)}.track{fill:rgba(255,255,255,.1)}.ring{stroke:rgba(255,255,255,.12)}` +
    `.label{fill:#E8E8EC}.value{fill:#F7F7F8;font-weight:600}.dim{fill:#9A9AA3;font-weight:450}` +
    `.sweep{animation:sweep 1.8s cubic-bezier(.45,0,.55,1) infinite;${lockPhase(now, 1800)}}` +
    `.pulse{animation:pulse 1.6s ease-in-out infinite;${lockPhase(now, 1600)}}` +
    mascotStyle(now) +
    `@keyframes sweep{to{transform:translateX(var(--travel))}}` +
    `@keyframes pulse{50%{opacity:.4}}` +
    `@media (prefers-reduced-motion:reduce){.sweep,.pulse{animation:none}}`

  const size = Math.ceil(width)

  // One border around everything: this is what makes the row read as one unit.
  // The hottest limit colours it, so the whole element is the warning.
  // A session that runs out at this pace counts as amber at least.
  const worst = Math.max(m.session?.percent ?? 0, m.session?.out ? 70 : 0, m.week ?? 0, m.context?.percent ?? 0)
  const edge = worst >= 90 ? RED_EDGE : worst >= 70 ? AMBER_EDGE : AURORA
  const edgeStops = edge
    .map((c, i) => `<stop offset="${i / (edge.length - 1)}" stop-color="${c}"/>`)
    .join('')

  defs += `<linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="${rowLeft}" x2="${size}" y1="0" y2="0">${edgeStops}</linearGradient>`
  body =
    `<rect x="${rowLeft + 0.5}" y="${above + 0.5}" width="${size - rowLeft - rowRight - 1}" height="${ROW - 1}" rx="${CORNER}" fill="url(#edge)" fill-opacity=".05" stroke="url(#edge)" stroke-opacity=".8"/>` +
    body
  const lastChip = chipsDrawn[chipsDrawn.length - 1]

  if (lastChip) lastChip.segEnd = size - rowRight - 1
  const height = above + ROW
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}">` +
    `<style>${style}</style><defs>${defs}</defs>${body}</svg>`

  const parts = [
    m.task && `Task: ${[m.task.label, m.task.count].filter(Boolean).join(', ')}`,
    m.mascot?.celebrate && 'all steps done',
    m.mascot && m.mascot.running > 0 && `${m.mascot.running} subagents running`,
    m.session &&
      `session ${Math.round(m.session.percent)}% used${m.session.left ? `, ${m.session.left}` : ''}` +
        (m.session.reset ? `, resets at ${m.session.reset}` : '') +
        (m.session.out ? `, at this pace runs ${m.session.out}` : ''),
    m.week !== undefined && `week ${Math.round(m.week)}% used`,
    m.context && `context ${m.context.label}`,
    m.cache &&
      `prompt cache ${m.cache.isWarm ? (m.cache.coolsIn !== undefined ? `warm, cools in ${m.cache.coolsIn}m` : 'warm') : 'cold'}`,
  ].filter(Boolean)

  return { source, width: size, height, alt: parts.join(', '), chips: chipsDrawn }
}

/** Fills `width`, giving up the least important figures first when it is narrow. */
export const buildPill = (m: PillModel, width: number, fit: Fit = MACOS, cell?: number, now = 0) => {
  const attempts: PillModel[] = [
    m,
    { ...m, week: undefined },
    { ...m, week: undefined, cache: undefined },
    { ...m, week: undefined, cache: undefined, context: undefined },
  ]
  const fitting = attempts.find(attempt => neededWidth(attempt) <= width - fit.left)

  return draw(fitting ?? attempts[attempts.length - 1]!, width, fit, cell, now)
}

// ── The buttons over the chips ──────────────────────────────────────────────
// The desktop band places a Box only in whole cells, and a Button has no width:
// a plain one is as wide as its label. So each chip gets an invisible Button of
// no-break spaces. Drawn with `cell`, every chip after the first starts on a
// cell's edge, just after its divider, so its button starts there; the button
// takes as many spaces as fit before the segment's far divider (the border, for the
// last), BUTTON_INSET short of it, so its hover highlight fills the segment
// without reaching into the next chip.

/**
 * A plain Button's width on the macOS desktop, in pixels, for a label of `n`
 * no-break spaces: `BUTTON_BASE + n * SPACE_WIDTH`, the base being the native
 * button's own padding. From two screenshots: 12 spaces made it 75px wide, and
 * the highlight of 4, placed at the band's left edge, was centred 18.7px into it.
 */
export const BUTTON_BASE = 18.75
export const SPACE_WIDTH = 4.69
/**
 * Kept clear inside a segment's right divider, or the border for the last one. The
 * highlight is the button's whole box, whose padding is already in BUTTON_BASE.
 */
export const BUTTON_INSET = 3
/** A button starts at the first cell edge this far after its segment's left divider. */
export const BUTTON_LEAD = GAP

/** One invisible Button over a chip: its left edge in band cells, its label in spaces. */
export type ChipButton = { kind: ChipKind; left: number; spaces: number }

/**
 * Where the buttons go for the chips drawn, the drawing placed one cell left of
 * the band, as the AbovePrompt render places it. `cell` is the band's cell in
 * the drawing's pixels; the drawing is scaled to its cells, so they line up.
 */
export const chipButtons = (chips: readonly ChipExtent[], cell: number): ChipButton[] =>
  chips.map(c => {
    // The first cell edge at or after the segment's start (the drawing sits one cell left of the band).
    const left = Math.max(0, Math.ceil((c.segStart + BUTTON_LEAD) / cell - 1 - 1e-6))
    // The room from the button's left edge to the segment's end, in the band's pixels.
    const room = c.segEnd - BUTTON_INSET - (left + 1) * cell
    const spaces = Math.max(1, Math.floor((room - BUTTON_BASE) / SPACE_WIDTH))

    return { kind: c.kind, left, spaces }
  })

/** The width the desktop gives a Button of `spaces`, by the measure above. */
export const buttonWidth = (spaces: number) => BUTTON_BASE + spaces * SPACE_WIDTH
