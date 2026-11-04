import type { TaskView } from './task'

export type PillModel = {
  task?: TaskView
  /** The 5-hour plan window. */
  session?: { percent: number; left?: string }
  week?: number
  context?: { percent: number; label: string }
  /** Warm while the prompt cache should still hold it; the ring is the time left. */
  cache?: { isWarm: boolean; percentLeft: number }
  isWorking: boolean
}

// Measured from a screenshot: the app's row is 40px tall with this body, and one
// cell up, where the drawing is placed, starts 10px above the row and is clipped.
const ABOVE = 10
const ROW = 40
const HEIGHT = ABOVE + ROW
// Likewise one cell left starts 1.5px outside the row.
const LEFT = 1.5
const CORNER = 12
const MID = ABOVE + ROW / 2
const SIZE = 11.5
/** The space kept around each section, inside the one border. */
const INSET = 4
const CHIP_PAD = 12
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

const text = (x: number, content: string, cls: string): string =>
  `<text x="${x.toFixed(1)}" y="${MID}" dy="0.35em" class="${cls}">${escapeXml(content)}</text>`

type Gauge = {
  percent: number
  colors: readonly [string, string]
  strong: string
  dim?: string
}

const gaugesOf = (m: PillModel): Gauge[] => {
  const gauges: Gauge[] = []

  if (m.session) {
    gauges.push({
      percent: m.session.percent,
      colors: limitColors(m.session.percent, CORAL),
      strong: `${Math.round(m.session.percent)}%`,
      dim: 'session',
    })
  }

  if (m.week !== undefined) {
    gauges.push({
      percent: m.week,
      colors: limitColors(m.week, VIOLET),
      strong: `${Math.round(m.week)}%`,
      dim: 'week',
    })
  }

  if (m.context) {
    gauges.push({
      percent: m.context.percent,
      colors: limitColors(m.context.percent, CYAN),
      strong: m.context.label,
    })
  }

  if (m.cache) {
    gauges.push({
      percent: m.cache.percentLeft,
      colors: m.cache.isWarm ? WARM : COLD,
      strong: m.cache.isWarm ? 'Warm' : 'Cold',
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

const draw = (m: PillModel, width: number) => {
  const gauges = gaugesOf(m)
  const free = Math.max(0, width - LEFT - neededWidth(m))

  // The bar grows only so far when it has steps to show; the rest is shared by all
  // the chips, so the row is filled edge to edge without the task taking it over.
  const bar = m.task?.steps ? Math.min(MAX_BAR, MIN_BAR + free) : MIN_BAR
  const chips = gauges.length + (m.task ? 1 : 0)
  const spare = chips === 0 ? 0 : (free - (m.task ? bar - MIN_BAR : 0)) / chips

  let body = ''
  let defs = ''
  let x = LEFT + INSET

  const divider = (at: number) =>
    `<rect x="${at.toFixed(1)}" y="${MID - 9}" width="1" height="18" class="divider"/>`

  if (m.task) {
    const { label, steps, count } = m.task
    const barY = MID - 3
    const w = taskChip(m.task, bar) + spare
    const left = x + CHIP_PAD + spare / 2
    const start = left + widthOf(label) + 10

    defs +=
      `<linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="${start.toFixed(1)}" x2="${(start + bar).toFixed(1)}" y1="0" y2="0"><stop offset="0" stop-color="#FF7A59"/><stop offset="1" stop-color="#B46BFF"/></linearGradient>` +
      `<clipPath id="bar"><rect x="${start.toFixed(1)}" y="${barY}" width="${bar.toFixed(1)}" height="6" rx="3"/></clipPath>`

    body += text(left, label, 'label')

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
    const w = gaugeChip(g) + spare

    // The contents sit centred in the chip, however wide the spare room made it.
    let at = x + (w - gaugeWidth(g)) / 2
    const cx = at + 7

    defs += `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${g.colors[0]}"/><stop offset="1" stop-color="${g.colors[1]}"/></linearGradient>`
    body += `<circle cx="${cx.toFixed(1)}" cy="${MID}" r="${r}" fill="none" class="ring" stroke-width="2.2"/>`

    if (dash > 0) {
      body +=
        `<circle cx="${cx.toFixed(1)}" cy="${MID}" r="${r}" fill="none" stroke="url(#${id})" stroke-width="2.2" stroke-linecap="round" ` +
        `stroke-dasharray="${dash.toFixed(2)} ${circumference.toFixed(2)}" transform="rotate(-90 ${cx.toFixed(1)} ${MID})"/>`
    }

    at += 20
    body += text(at, g.strong, 'value')
    at += widthOf(g.strong, true)

    if (g.dim) {
      body += text(at + 4, g.dim, 'dim')
    }

    x += w + GAP

    if (index < gauges.length - 1) {
      body += divider(x - GAP)
    }
  })

  const style =
    `text{font:500 ${SIZE}px ${FONT};font-variant-numeric:tabular-nums;letter-spacing:-.05px}` +
    `.divider{fill:rgba(255,255,255,.12)}.track{fill:rgba(255,255,255,.1)}.ring{stroke:rgba(255,255,255,.12)}` +
    `.label{fill:#E8E8EC}.value{fill:#F7F7F8;font-weight:600}.dim{fill:#9A9AA3;font-weight:450}` +
    `.sweep{animation:sweep 1.8s cubic-bezier(.45,0,.55,1) infinite}` +
    `.pulse{animation:pulse 1.6s ease-in-out infinite}` +
    `@keyframes sweep{to{transform:translateX(var(--travel))}}` +
    `@keyframes pulse{50%{opacity:.4}}` +
    `@media (prefers-reduced-motion:reduce){.sweep,.pulse{animation:none}}`

  const size = Math.ceil(width)

  // One border around everything: this is what makes the row read as one unit.
  // The hottest limit colours it, so the whole element is the warning.
  const worst = Math.max(m.session?.percent ?? 0, m.week ?? 0, m.context?.percent ?? 0)
  const edge = worst >= 90 ? RED_EDGE : worst >= 70 ? AMBER_EDGE : AURORA
  const edgeStops = edge
    .map((c, i) => `<stop offset="${i / (edge.length - 1)}" stop-color="${c}"/>`)
    .join('')

  defs += `<linearGradient id="edge" gradientUnits="userSpaceOnUse" x1="${LEFT}" x2="${size}" y1="0" y2="0">${edgeStops}</linearGradient>`
  body =
    `<rect x="${LEFT + 0.5}" y="${ABOVE + 0.5}" width="${size - LEFT - 2}" height="${ROW - 1}" rx="${CORNER}" fill="url(#edge)" fill-opacity=".05" stroke="url(#edge)" stroke-opacity=".8"/>` +
    body
  const source =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${HEIGHT}" viewBox="0 0 ${size} ${HEIGHT}">` +
    `<style>${style}</style><defs>${defs}</defs>${body}</svg>`

  const parts = [
    m.task && `Task: ${[m.task.label, m.task.count].filter(Boolean).join(', ')}`,
    m.session &&
      `session ${Math.round(m.session.percent)}% used${m.session.left ? `, ${m.session.left}` : ''}`,
    m.week !== undefined && `week ${Math.round(m.week)}% used`,
    m.context && `context ${m.context.label}`,
    m.cache && `prompt cache ${m.cache.isWarm ? 'warm' : 'cold'}`,
  ].filter(Boolean)

  return { source, width: size, height: HEIGHT, alt: parts.join(', ') }
}

/** Fills `width`, giving up the least important figures first when it is narrow. */
export const buildPill = (m: PillModel, width: number) => {
  const attempts: PillModel[] = [
    m,
    { ...m, week: undefined },
    { ...m, week: undefined, cache: undefined },
    { ...m, week: undefined, cache: undefined, context: undefined },
  ]
  const fitting = attempts.find(attempt => neededWidth(attempt) <= width - LEFT)

  return draw(fitting ?? attempts[attempts.length - 1]!, width)
}
