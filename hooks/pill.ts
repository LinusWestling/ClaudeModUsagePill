import { lockPhase, mascotMarkup, mascotStyle } from './mascot'
import { NEUTRAL, inLight } from './scheme'
import type { Outfit } from '../types'
import type { TaskView } from './task'

export type PillModel = {
  task?: TaskView
  /**
   * The 5-hour plan window. `reset` is its reset as a bare local clock (`11:10`),
   * drawn after a `↻`. `out` (`out ~16:40`) is set when its pace runs out before
   * the reset: it turns the limits group amber and takes the place of the week's
   * figure and the clock.
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
const CHIP_PAD = 14
/** The padding of the context and cache chips, which sit side by side in one group. */
const PAIR_PAD = 14
/** The mascot in the task chip, and what it takes from the chip's text. */
// Twice the grid: anything but a whole multiple smears its pixels.
const MASCOT_SIZE = 32
const MASCOT_ROOM = MASCOT_SIZE + 6
const MIN_BAR = 56
/** How far the step bar grows into spare room, and the sweep's length when there are no steps. */
const MAX_BAR = 160
const SWEEP_BAR = 80
/** The hairline between two groups. */
const GAP = 1
/** The thin bars of the limits and context chips, and the two limit bars' length. */
const THIN = 5
const LIMIT_BAR = 56
/** The one limit bar left when the week's is dropped: the room it frees goes to the figures. */
const LIMIT_BAR_ALONE = 36
const CONTEXT_BAR = 40
const DOT = 7
/**
 * The narrowest a chip is drawn: its hover area, less half a cell each side, is
 * then still wider than a one-space Button, which the app would otherwise shrink
 * and fill with an ellipsis.
 */
const MIN_CHIP = 48
const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif`

/** How near a limit is: calm, a warning from 70%, an error from 90%. */
type Level = 0 | 1 | 2

const levelOf = (percent: number): Level => (percent >= 90 ? 2 : percent >= 70 ? 1 : 0)
const worse = (...levels: Level[]) => Math.max(...levels) as Level

/** The classes a level gives: a bar's fill, its figure's text, and the border (red only). */
const FILL = ['fill', 'amber', 'red'] as const
const TONE = ['', ' t-amber', ' t-red'] as const
const EDGE = ['', ' edge-amber', ' edge-red'] as const

/** Measured advances of the system font at weight 600, in em. */
const ADVANCE: Record<string, number> = {
  ' ': 0.2, '%': 0.863, '/': 0.295, '.': 0.232, k: 0.521, M: 0.851, h: 0.569,
  m: 0.843, l: 0.229, e: 0.541, f: 0.338, w: 0.765, a: 0.532, c: 0.53, t: 0.337,
  d: 0.582, S: 0.619, s: 0.498, i: 0.229, o: 0.559, n: 0.56, r: 0.36, W: 0.952, C: 0.704, D: 0.693,
  u: 0.56, ':': 0.255, '~': 0.6, '·': 0.3, '↻': 0.8, x: 0.52, p: 0.58, g: 0.58, y: 0.52,
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

/**
 * Which press target of the bar a chip is: `session` is the limits group (session
 * and week in one), `context` and `cache` the two halves of the last group.
 */
export type ChipKind = 'task' | 'session' | 'context' | 'cache'

/** Where a drawn chip lies across the drawing, in its pixels. */
export type ChipExtent = {
  kind: ChipKind
  x: number
  width: number
  /** The whole segment the chip owns, for its button: between its dividers, or the border. */
  segStart: number
  segEnd: number
}

/**
 * What a narrow bar gives up, words before figures. Each step of `STAGES` keeps
 * everything the one before it did, less what it turns off.
 */
type Detail = {
  /** The `↻ clock` and the `wk` after the week's figure. */
  clock: boolean
  /** The task's label. */
  label: boolean
  /** The `ctx` and the cache's word, leaving its dot. */
  words: boolean
  weekBar: boolean
  cache: boolean
  context: boolean
}

const STAGES: Detail[] = [
  { clock: true, label: true, words: true, weekBar: true, cache: true, context: true },
  { clock: false, label: true, words: true, weekBar: true, cache: true, context: true },
  { clock: false, label: false, words: false, weekBar: true, cache: true, context: true },
  { clock: false, label: false, words: false, weekBar: false, cache: true, context: true },
  { clock: false, label: false, words: false, weekBar: false, cache: false, context: true },
  { clock: false, label: false, words: false, weekBar: false, cache: false, context: false },
]

type Limits = {
  session?: { percent: number; level: Level }
  week?: { percent: number; level: Level }
  strong: string
  /** The figure's dim tail: the week or when the session runs out. */
  dim?: string
  clock?: string
  /** The worse of the two limits. */
  level: Level
  hasWeekBar: boolean
  /** The bars' length. */
  bar: number
}

const limitsOf = (m: PillModel, d: Detail): Limits | undefined => {
  const { session, week } = m

  if (!session && week === undefined) return undefined

  const sessionLevel = worse(levelOf(session?.percent ?? 0), session?.out ? 1 : 0)
  const weekLevel = levelOf(week ?? 0)
  const wk = week === undefined ? '' : `${Math.round(week)}%${d.clock ? ' wk' : ''}`

  return {
    session: session && { percent: session.percent, level: sessionLevel },
    week: week === undefined ? undefined : { percent: week, level: weekLevel },
    strong: session ? `${Math.round(session.percent)}%` : `${Math.round(week!)}%`,
    // Running out at this pace is said instead of the week: it is the warning.
    dim: session ? (session.out ? `· ${session.out}` : week === undefined ? undefined : `· ${wk}`) : d.clock ? 'wk' : undefined,
    clock: session?.reset && d.clock && !session.out ? `↻ ${session.reset}` : undefined,
    level: worse(sessionLevel, weekLevel),
    hasWeekBar: week !== undefined && (d.weekBar || !session),
    bar: d.weekBar || !session || week === undefined ? LIMIT_BAR : LIMIT_BAR_ALONE,
  }
}

type Context = { percent: number; figure: string; word?: string; level: Level }

const contextOf = (m: PillModel, d: Detail): Context | undefined =>
  m.context && {
    percent: m.context.percent,
    // The window's size is in the panel: the chip says what is used.
    figure: m.context.label.split(' / ')[0]!,
    word: d.words ? 'ctx' : undefined,
    level: levelOf(m.context.percent),
  }

type Cache = { word?: string; dot: string; isCooling: boolean }

const cacheOf = (m: PillModel, d: Detail): Cache | undefined => {
  if (!m.cache) return undefined

  const cools = m.cache.isWarm ? m.cache.coolsIn : undefined
  const word = cools !== undefined ? `cools ${cools}m` : m.cache.isWarm ? 'warm' : 'cold'

  return {
    word: d.words ? word : undefined,
    dot: cools !== undefined ? 'amber' : m.cache.isWarm ? 'dot-warm' : 'dot-cold',
    isCooling: cools !== undefined,
  }
}

const limitsContent = (l: Limits) =>
  l.bar + 8 + widthOf(l.strong, true) + (l.dim ? 4 + widthOf(l.dim) : 0) + (l.clock ? 10 + widthOf(l.clock) : 0)

const contextContent = (c: Context) =>
  CONTEXT_BAR + 7 + widthOf(c.figure, true) + (c.word ? 4 + widthOf(c.word) : 0)

const cacheContent = (c: Cache) => DOT + (c.word ? 6 + widthOf(c.word) : 0)

/**
 * What the task chip shows while there is no task: the mascot and a word, no bar.
 * The bar always leads with it, so the figures keep their place on the right and
 * the mascot is there to press for the Subagents pane.
 */
export const IDLE_TASK: TaskView = { label: 'Ready', count: '' }

const isIdle = (task: TaskView) => task === IDLE_TASK

const taskChip = (task: TaskView, bar: number, hasLabel: boolean) =>
  isIdle(task)
    ? CHIP_PAD * 2 + MASCOT_ROOM + (hasLabel ? widthOf(task.label) : 0)
    : CHIP_PAD * 2 +
      MASCOT_ROOM +
      (hasLabel ? widthOf(task.label) + 10 : 0) +
      bar +
      (task.count ? 10 + widthOf(task.count, true) : 0)

/** The chips as the bar draws them, each with the room its content needs. */
const chipsOf = (m: PillModel, d: Detail, bar: number) => {
  const limits = limitsOf(m, d)
  const context = contextOf(m, d)
  const cache = cacheOf(m, d)
  const chips: { kind: ChipKind; least: number }[] = []

  if (m.task) chips.push({ kind: 'task', least: Math.max(MIN_CHIP, taskChip(m.task, bar, d.label)) })
  if (limits) chips.push({ kind: 'session', least: Math.max(MIN_CHIP, limitsContent(limits) + CHIP_PAD * 2) })
  if (context) chips.push({ kind: 'context', least: Math.max(MIN_CHIP, contextContent(context) + PAIR_PAD * 2) })
  if (cache) chips.push({ kind: 'cache', least: Math.max(MIN_CHIP, cacheContent(cache) + PAIR_PAD * 2) })

  return { chips, limits, context, cache }
}

/** The least room the chips can be drawn in. */
const neededWidth = (m: PillModel, d: Detail) => {
  const { chips } = chipsOf(m, d, MIN_BAR)

  return INSET * 2 + chips.reduce((sum, c) => sum + c.least, 0) + Math.max(0, chips.length - 1) * GAP
}

/**
 * The chips' widths, laid from `start`. Given the band's `cell` (in the drawing's
 * pixels; the drawing sits one cell left of the band), every divider is centred
 * on the middle of a cell. A Box is placed in whole cells, so the hover area over
 * each chip, which runs from cell edge to cell edge, then keeps the same half a
 * cell clear of the divider on both sides, on every chip and at any cell size. A
 * divider moves to the nearest such middle, or the next one where that would cut
 * into a chip's content: less than a cell either way. The last chip ends where it did.
 * The context and cache chips have no divider drawn between them, but are laid
 * the same, so each of their hover areas keeps clear of the other's.
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

    // The next chip starts just past a divider centred on a cell's middle: the
    // nearest such place, or the one after where that would cut into the chip's content.
    const offset = cell / 2 + GAP / 2
    let next = Math.round((natural - offset) / cell) * cell + offset

    if (next - GAP - at < c.least) next = Math.ceil((natural - offset) / cell) * cell + offset
    widths.push(next - GAP - at)
    at = next
  })

  return widths
}

const draw = (m: PillModel, d: Detail, width: number, fit: Fit, cell?: number, now = 0, oversize = 1) => {
  const { above, left: rowLeft, right: rowRight } = fit
  const mid = above + ROW / 2
  const text = (x: number, content: string, cls: string): string =>
    `<text x="${x.toFixed(1)}" y="${mid}" dy="0.35em" class="${cls}">${escapeXml(content)}</text>`
  const free = Math.max(0, width - rowLeft - neededWidth(m, d))

  // The bar grows only so far: a step bar into the spare room, a sweep to its own length.
  const bar = !m.task || isIdle(m.task) ? MIN_BAR : Math.min(m.task.steps ? MAX_BAR : SWEEP_BAR, MIN_BAR + free)
  const { chips, limits, context, cache } = chipsOf(m, d, bar)
  // The task leads and takes what is spare, so the figures sit packed at the right
  // at their own width, and the space between reads as the task's.
  const rest = free - (m.task && !isIdle(m.task) ? bar - MIN_BAR : 0)
  const spare = (kind: ChipKind) => (kind === 'task' ? rest : 0)

  let body = ''
  let defs = ''
  let x = rowLeft + INSET
  // What was drawn where, for the buttons laid over the chips.
  const chipsDrawn: ChipExtent[] = []
  const widths = snapToCells(
    chips.map(c => ({ natural: c.least + spare(c.kind), least: c.least })),
    x,
    cell,
  )

  const divider = (at: number) =>
    `<rect x="${at.toFixed(1)}" y="${mid - 9}" width="1" height="18" class="divider"/>`

  // Calm, each bar wears its section's colour; amber or red take over when it is at risk.
  const bars = (at: number, y: number, length: number, percent: number, level: Level, tint: 'c-session' | 'c-week' | 'c-context') => {
    const filled = Math.min(length, Math.max(THIN, (Math.min(100, Math.max(0, percent)) / 100) * length))

    return (
      `<rect x="${at.toFixed(1)}" y="${y}" width="${length}" height="${THIN}" rx="${THIN / 2}" class="track"/>` +
      (percent > 0
        ? `<rect x="${at.toFixed(1)}" y="${y}" width="${filled.toFixed(1)}" height="${THIN}" rx="${THIN / 2}" class="${level === 0 ? tint : FILL[level]}"/>`
        : '')
    )
  }

  // Where each group begins and ends, for the hairline before it.
  const groups: { first: ChipKind; level: Level; from: number; to: number }[] = []

  chips.forEach((chip, index) => {
    const w = widths[index]!
    const isTask = chip.kind === 'task'
    const isPair = chip.kind === 'context' || chip.kind === 'cache'
    const pad = isPair ? PAIR_PAD : CHIP_PAD
    // The contents sit centred in the chip, however wide the spare room made it.
    let at = x + (w - (chip.least - pad * 2)) / 2

    if (isTask && m.task) {
      const { label, steps, count } = m.task
      const barY = mid - 3
      // Its own place, not centred, so the button over it finds it at any width.
      const mascotAt = x + CHIP_PAD - 2 + fit.mascot.x
      const left = x + CHIP_PAD + MASCOT_ROOM
      const start = left + (d.label ? widthOf(label) + 10 : 0)

      defs += `<clipPath id="bar"><rect x="${start.toFixed(1)}" y="${barY}" width="${bar.toFixed(1)}" height="6" rx="3"/></clipPath>`

      const mood = m.mascot?.celebrate ? 'celebrate' : m.mascot && m.mascot.running > 0 ? 'moving' : 'still'

      body += `<g transform="translate(${mascotAt.toFixed(1)} ${mid - MASCOT_SIZE / 2 + fit.mascot.y}) scale(${MASCOT_SIZE / 16})" shape-rendering="crispEdges">${mascotMarkup(mood, m.mascot?.outfit)}</g>`

      if (d.label) body += text(left, label, isIdle(m.task) ? 'dim' : 'label')

      if (isIdle(m.task)) {
        // No task: the mascot and its word alone.
      } else if (steps) {
        // One segment per step: done ones lit, the current one pulsing.
        const split = steps.length > 24 ? 1 : 2
        const segment = (bar - split * (steps.length - 1)) / steps.length
        let segments = ''

        steps.forEach((step, i) => {
          const segAt = (start + i * (segment + split)).toFixed(1)
          const rect = `x="${segAt}" y="${barY}" width="${segment.toFixed(1)}" height="6"`

          segments += `<rect ${rect} class="track"/>`

          if (step.status === 'completed') {
            segments += `<rect ${rect} class="done"/>`
          } else if (step.status === 'in_progress') {
            segments += m.isWorking ? `<rect ${rect} class="pulse"/>` : `<rect ${rect} class="done" opacity=".5"/>`
          }
        })

        body += `<g clip-path="url(#bar)">${segments}</g>`
      } else {
        // No list of steps to count: an honest sweep, not a made-up percentage.
        const sweep = Math.round(bar * 0.2)

        body +=
          `<rect x="${start.toFixed(1)}" y="${barY}" width="${bar.toFixed(1)}" height="6" rx="3" class="track"/>` +
          `<g clip-path="url(#bar)"><rect class="sweep" x="${(start - sweep).toFixed(1)}" y="${barY}" width="${sweep}" height="6" rx="3" style="--travel:${(bar + sweep).toFixed(0)}px"/></g>`
      }

      if (count && !isIdle(m.task)) {
        body += text(start + bar + 10, count, 'value')
      }
    }

    if (chip.kind === 'session' && limits) {
      const { session, week } = limits
      // Only the figure at risk takes the colour, with its own bar: the session's
      // percent, or the week's after it (or the run-out time, which is the session's).
      const strongTone = TONE[session ? session.level : (week?.level ?? 0)]
      const dimTone = session ? TONE[m.session?.out ? session.level : (week?.level ?? 0)] : ''
      const hasWeekBar = limits.hasWeekBar && week !== undefined
      const stacked = session !== undefined && hasWeekBar

      if (session) {
        body += bars(at, stacked ? mid - 7 : mid - THIN / 2, limits.bar, session.percent, session.level, 'c-session')
      }

      if (hasWeekBar && week) {
        body += bars(at, stacked ? mid + 2 : mid - THIN / 2, limits.bar, week.percent, week.level, 'c-week')
      }

      at += limits.bar + 8
      body += text(at, limits.strong, `value${strongTone}`)
      at += widthOf(limits.strong, true)

      if (limits.dim) {
        body += text(at + 4, limits.dim, `dim${dimTone}`)
        at += 4 + widthOf(limits.dim)
      }

      if (limits.clock) {
        body += text(at + 10, limits.clock, 'dim')
      }
    }

    if (chip.kind === 'context' && context) {
      const tone = TONE[worse(context.level)]

      body += bars(at, mid - THIN / 2, CONTEXT_BAR, context.percent, context.level, 'c-context')
      at += CONTEXT_BAR + 7
      body += text(at, context.figure, `value${tone}`)
      at += widthOf(context.figure, true)

      if (context.word) {
        body += text(at + 4, context.word, 'dim')
      }
    }

    if (chip.kind === 'cache' && cache) {
      body += `<circle cx="${(at + DOT / 2).toFixed(1)}" cy="${mid}" r="${DOT / 2}" class="${cache.dot}"/>`

      if (cache.word) {
        body += text(at + DOT + 6, cache.word, `label${cache.isCooling ? TONE[1] : ''}`)
      }
    }

    // The task and the limits are a group of their own; the context and cache chips share one.
    const level: Level = chip.kind === 'session' ? limits!.level : isPair ? (context?.level ?? 0) : 0
    const previous = groups[groups.length - 1]

    if (chip.kind === 'cache' && previous?.first === 'context') {
      previous.to = x + w
    } else {
      groups.push({ first: chip.kind, level, from: x, to: x + w })
    }

    chipsDrawn.push({ kind: chip.kind, x, width: w, segStart: index === 0 ? rowLeft + 1 : x - GAP, segEnd: x + w })
    x += w + GAP
  })

  // A hairline between groups. A warning is told by its bar and its figure alone:
  // no wash behind the group, which crowded the row.
  groups.forEach((g, i) => {
    if (i > 0) body += divider(g.from - GAP)
  })

  const style =
    `text{font:500 ${SIZE}px ${FONT};font-variant-numeric:tabular-nums;letter-spacing:-.05px}` +
    `.divider{fill:rgba(255,255,255,.12)}.track{fill:rgba(255,255,255,.1)}` +
    // Opaque, so the figures keep their contrast even where the image is told the
    // wrong scheme (a light app on a dark system): then it is a dark pill, still readable.
    `.frame{fill:#2B2B29;stroke:url(#edge);stroke-opacity:.8;stroke-width:1.25}` +
    // The sections' colours, left to right: the border runs through them in the same order.
    `.c-session,.s1{fill:#FF7A59;stop-color:#FF7A59}.c-week,.s2{fill:#A98BFF;stop-color:#A98BFF}.c-context,.s3{fill:#4CC9F0;stop-color:#4CC9F0}` +
    `.label{fill:#E8E8EC}.value{fill:#F7F7F8;font-weight:600}.dim{fill:#9A9AA3;font-weight:450}` +
    `.fill{fill:#C4C4CC}.done,.pulse,.sweep{fill:#FF7A59}.amber{fill:#FFB02E}.red{fill:#FF5C5C}` +
    `.dot-warm{fill:#4CC38A}.dot-cold{fill:#5AA9FF}` +
    `.t-amber{fill:#FFB02E}.t-red{fill:#FF8A8A}.edge-amber{stroke:rgba(255,176,46,.85)}.edge-red{stroke:rgba(255,77,77,.85)}` +
    // On a light panel: near-black figures, a dim that still clears 4.5:1, darker hairlines,
    // and amber and red deep enough for text.
    inLight(
      `.divider{fill:rgba(0,0,0,.14)}.track{fill:rgba(0,0,0,.09)}` +
        `.frame{fill:#FFFFFF;stroke:url(#edge);stroke-opacity:.9}` +
        `.c-session,.s1{fill:#D9572F;stop-color:#D9572F}.c-week,.s2{fill:#6E4BD8;stop-color:#6E4BD8}.c-context,.s3{fill:#0B84B5;stop-color:#0B84B5}` +
        `.label{fill:#2E2E33}.value{fill:#141417}.dim{fill:#5F5F68}` +
        `.fill{fill:#5F5F68}.done,.pulse,.sweep{fill:#D9482B}.amber{fill:#C77800}.red{fill:#D12B2B}` +
        `.dot-warm{fill:#1E8E5A}.dot-cold{fill:#2F6FD6}` +
        `.t-amber{fill:#8A5300}.t-red{fill:#B3261E}.edge-amber{stroke:rgba(199,120,0,.85)}.edge-red{stroke:rgba(209,43,43,.85)}`,
    ) +
    `.sweep{animation:sweep 1.8s cubic-bezier(.45,0,.55,1) infinite;${lockPhase(now, 1800)}}` +
    `.pulse{animation:pulse 1.6s ease-in-out infinite;${lockPhase(now, 1600)}}` +
    mascotStyle(now) +
    `@keyframes sweep{to{transform:translateX(var(--travel))}}` +
    `@keyframes pulse{50%{opacity:.4}}` +
    `@media (prefers-reduced-motion:reduce){.sweep,.pulse{animation:none}}`

  const size = Math.ceil(width)

  // One border around everything: this is what makes the row read as one unit.
  // Calm, it runs through the sections' colours; a limit or the context at risk
  // turns it amber, at 90% red, so the whole bar says so from its edge.
  const edge: Level = worse(limits?.level ?? 0, context?.level ?? 0)

  defs +=
    `<linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="${rowLeft}" x2="${size - rowRight}" y1="0" y2="0">` +
    `<stop offset="0" class="s1"/><stop offset=".55" class="s2"/><stop offset="1" class="s3"/></linearGradient>`

  body =
    `<rect class="frame${EDGE[edge]}" x="${rowLeft + 0.5}" y="${above + 0.5}" width="${size - rowLeft - rowRight - 1}" height="${ROW - 1}" rx="${CORNER}"/>` +
    body
  const lastChip = chipsDrawn[chipsDrawn.length - 1]

  if (lastChip) lastChip.segEnd = size - rowRight - 1
  const height = above + ROW
  // Drawn wider than its slot by `oversize`, the image is always narrowed to fill
  // it exactly, so the drawing's units across are the band's cells at any cell
  // size. Only across: the caller fixes its height in pixels (the Svg's `height`),
  // and `preserveAspectRatio="none"` lets it stretch across alone, so a screen
  // with wider cells never makes it taller than the band and cuts off its foot.
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(size * oversize)}" height="${height}" viewBox="0 0 ${size} ${height}"${oversize === 1 ? '' : ' preserveAspectRatio="none"'}>` +
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

/** Fills `width`, giving up words before figures, and whole chips only as a last resort, when it is narrow. */
export const buildPill = (given: PillModel, width: number, fit: Fit = MACOS, cell?: number, now = 0, oversize = 1) => {
  const m: PillModel = given.task ? given : { ...given, task: IDLE_TASK }
  const shown = (d: Detail): PillModel => ({
    ...m,
    cache: d.cache ? m.cache : undefined,
    context: d.context ? m.context : undefined,
  })
  const stage = STAGES.find(d => neededWidth(shown(d), d) <= width - fit.left) ?? STAGES[STAGES.length - 1]!
  const drawn = draw(shown(stage), stage, width, fit, cell, now, oversize)

  // The alt text says what there is: no task is no task, whatever the chip shows.
  return m.task === IDLE_TASK ? { ...drawn, alt: drawn.alt.replace(/^Task: Ready(, )?/, '') } : drawn
}


// ── The buttons over the chips ──────────────────────────────────────────────
// Only a Button is pressable in the band, and a desktop Button is the app's own
// native button, as wide as its label: it has no width of its own. Put in a Box
// narrower than its label, the app shrinks it and draws an ellipsis in it, so
// the Box around each one is given no width at all: the Button always draws
// whole. Its label of no-break spaces is sized to BUTTON_FILL of its chip by the
// measured widths below, and it is placed, in whole cells, at the chip's middle.
// Where a screen's font differs from the measure, its highlight is a little
// shorter or longer than meant, and never cut.

/** The least room kept between a chip's area and the border or a divider, in the drawing's pixels. */
export const HOVER_CLEAR = 2

/**
 * A plain Button's width on the macOS desktop, for a label of `n` no-break
 * spaces: BUTTON_BASE + n * SPACE_WIDTH pixels, measured on a hover screenshot (0.6.1).
 */
export const BUTTON_BASE = 21
export const SPACE_WIDTH = 3.64
/**
 * The share of its chip's area a Button is sized to. A Button in a Box with no
 * width can't be shrunk into an ellipsis, so it is sized to the whole area: where
 * a screen's font is wider than measured, it reaches a little into the half cell
 * kept clear of the divider, which is what that room is for.
 */
export const BUTTON_FILL = 1

/** The no-break spaces of a chip's Button: as wide as BUTTON_FILL of its `cells`, at least one. */
export const fitSpaces = (cells: number, cell: number) =>
  Math.max(1, Math.floor((cells * cell * BUTTON_FILL - BUTTON_BASE) / SPACE_WIDTH))

/**
 * One chip's Button: the chip's area (`left` and `cells`, in band cells), and the
 * Button in it, `spaces` long, placed at `at`, the cell that centres it.
 */
export type ChipButton = { kind: ChipKind; left: number; cells: number; spaces: number; at: number }

/**
 * Where the hover areas go for the chips drawn, the drawing placed one cell left
 * of the band, as the AbovePrompt render places it. `cell` is the band's cell in
 * the drawing's pixels; the drawing is scaled to its cells, so they line up. Each
 * area runs from the first cell edge clear of its segment's left divider (the
 * border, for the first) to the last edge clear of its right one.
 */
export const chipButtons = (chips: readonly ChipExtent[], cell: number): ChipButton[] =>
  chips.map(c => {
    // Drawing edges: the band's cell j starts at (j + 1) * cell.
    const first = Math.ceil((c.segStart + GAP + HOVER_CLEAR) / cell - 1e-6)
    const last = Math.floor((c.segEnd - HOVER_CLEAR) / cell + 1e-6)
    const left = Math.max(0, first - 1)
    const cells = Math.max(1, last - 1 - left)
    const spaces = fitSpaces(cells, cell)
    // The room either side of the Button, by the measure, rounded to whole cells.
    const slack = (cells * cell - (BUTTON_BASE + spaces * SPACE_WIDTH)) / 2

    return { kind: c.kind, left, cells, spaces, at: left + Math.max(0, Math.round(slack / cell)) }
  })
