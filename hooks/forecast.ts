import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Limit, LimitSample, StoredSamples } from '../types'
import { inLight } from './scheme'

/** The 5-hour window's readings this session holds, oldest first. */
export const limitSamples = atom({ plugin: 'usage-pill', key: 'limitSamples' } as const, [])

/** Where the samples outlive the session, since a window spans several. */
export const SAMPLES_KEY = 'fiveHourSamples'

/** How long the 5-hour window lasts: it starts this long before it resets. */
export const WINDOW_MS = 5 * 60 * 60_000
/** How far back the pace is read from: recent enough to follow a change of pace. */
export const LOOKBACK_MS = 90 * 60_000
/** The least time the samples must span before a pace means anything. */
export const MIN_SPAN_MS = 10 * 60_000
/** Kept per window: far more than the readings that move it. */
const MAX_SAMPLES = 300
/** A reading that hasn't moved is kept only this often. */
const SAME_EVERY_MS = 5 * 60_000
/** Two `resetsAt` this close name the same window, whatever their seconds say. */
const SAME_WINDOW_MS = 10 * 60_000

const HOUR = 60 * 60_000

export type Forecast = {
  /** Percentage points an hour, over the recent samples. */
  pacePerHour: number
  /** Where the fit begins: the oldest recent sample. */
  from: LimitSample
  /** Where the projection begins: the latest reading, held until now. */
  to: LimitSample
  /** When the window resets, epoch ms. */
  resetsAt: number
  /** What the window would read at its reset, at this pace. */
  atReset: number
  /** When the pace reaches 100%; only set when that comes before the reset. */
  runsOutAt?: number
}

/** Whether two `resetsAt` name the same window. */
export const sameWindow = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false

  const x = Date.parse(a)
  const y = Date.parse(b)

  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < SAME_WINDOW_MS
}

/** The samples inside the window that resets at `resetsAt`, oldest first, one per moment. */
export const inWindow = (samples: readonly LimitSample[], resetsAt: number): LimitSample[] => {
  const start = resetsAt - WINDOW_MS
  const byTime = new Map<number, LimitSample>()

  for (const s of samples ?? []) {
    if (s.at >= start && s.at <= resetsAt && Number.isFinite(s.percent)) byTime.set(s.at, s)
  }

  return [...byTime.values()].sort((a, b) => a.at - b.at)
}

/**
 * Adds a reading to the window's samples, dropping what came before its reset. A
 * reading that hasn't moved is kept only every few minutes, so idle stretches
 * still show as flat without filling the list.
 */
export const addSample = (
  samples: readonly LimitSample[],
  sample: LimitSample,
  resetsAt: number,
): LimitSample[] => {
  const kept = inWindow(samples, resetsAt)
  const last = kept[kept.length - 1]

  if (last && last.percent === sample.percent && sample.at - last.at < SAME_EVERY_MS) return kept
  // A window only fills: an older reading arriving late, or a lower one, says nothing new.
  if (last && (sample.at < last.at || sample.percent < last.percent)) return kept

  return [...kept, sample].slice(-MAX_SAMPLES)
}

/**
 * The window's pace, from its samples of the last 90 minutes, and when it runs out
 * at that pace. The latest reading holds until `now`: nothing used since it is
 * nothing used, so an idle stretch slows the pace rather than freezing it.
 *
 * Undefined with no reset time, once the window has reset, or with fewer than two
 * recent samples ten minutes apart.
 */
export const forecastOf = (
  samples: readonly LimitSample[],
  limit: Limit | undefined,
  now: number,
): Forecast | undefined => {
  const resetsAt = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN

  if (!limit || !Number.isFinite(resetsAt) || resetsAt <= now) return undefined

  const recent = inWindow(samples, resetsAt).filter(s => s.at >= now - LOOKBACK_MS && s.at <= now)
  const from = recent[0]
  const last = recent[recent.length - 1]

  if (!from || !last || recent.length < 2 || last.at - from.at < MIN_SPAN_MS) return undefined

  const to = { at: now, percent: Math.max(...recent.map(s => s.percent), limit.percentUsed) }
  const pacePerHour = ((to.percent - from.percent) / (to.at - from.at)) * HOUR
  const atReset = to.percent + (pacePerHour * (resetsAt - now)) / HOUR
  const forecast: Forecast = { pacePerHour, from, to, resetsAt, atReset }

  if (to.percent >= 100) return { ...forecast, runsOutAt: now }
  if (pacePerHour <= 0) return forecast

  const runsOutAt = now + ((100 - to.percent) / pacePerHour) * HOUR

  return runsOutAt < resetsAt ? { ...forecast, runsOutAt: Math.round(runsOutAt) } : forecast
}

const isStored = (value: unknown): value is StoredSamples =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as StoredSamples).resetsAt === 'string' &&
  Array.isArray((value as StoredSamples).samples)

const fiveHour = (limits: readonly Limit[]) => {
  const limit = limits.find(l => l.kind === 'five_hour')
  const resetsAt = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN

  return limit?.resetsAt && Number.isFinite(resetsAt) ? { limit, iso: limit.resetsAt, resetsAt } : undefined
}

/** What the store holds for the window that resets at `iso`; nothing for an older one. */
async function storedFor($: EngineInterface, iso: string): Promise<LimitSample[]> {
  const stored = await $.store.get(SAMPLES_KEY)

  return isStored(stored) && sameWindow(stored.resetsAt, iso)
    ? stored.samples.filter(s => typeof s?.at === 'number' && typeof s?.percent === 'number')
    : []
}

const isSame = (a: readonly LimitSample[], b: readonly LimitSample[]) =>
  a.length === b.length && a.every((s, i) => s.at === b[i]!.at && s.percent === b[i]!.percent)

/**
 * Adds the 5-hour window's reading to its samples, in the session's state and in
 * the store, which other sessions of this window add to as well. Samples from
 * before the window's last reset are dropped.
 */
export async function recordLimit($: EngineInterface, limits: readonly Limit[], now: number) {
  const window = fiveHour(limits)

  if (!window || window.resetsAt <= now) return

  const held = (await read($, limitSamples)) ?? []
  const merged = addSample(
    [...(await storedFor($, window.iso)), ...held],
    { at: now, percent: window.limit.percentUsed },
    window.resetsAt,
  )

  if (isSame(merged, held)) return

  await update($, limitSamples, () => merged)
  await $.store.set(SAMPLES_KEY, { resetsAt: window.iso, samples: merged } satisfies StoredSamples)
}

/** Takes up what the store kept of the current window, after a reload or in a new session. */
export async function loadLimitSamples($: EngineInterface, limits: readonly Limit[]) {
  const window = fiveHour(limits)

  if (!window) return

  const held = (await read($, limitSamples)) ?? []
  const merged = inWindow([...(await storedFor($, window.iso)), ...held], window.resetsAt)

  if (!isSame(merged, held)) await update($, limitSamples, () => merged)
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The time of day at `at`, as the clock on the person's wall reads it, or undefined
 * where the environment can't say. A hooks module has no Node, but it has `Intl`
 * and a `Date` that read the host's zone; a sandbox with no zone data reports
 * plain UTC, which is taken as not knowing.
 */
export const localClock = (at: number, zone = currentZone()): string | undefined => {
  if (!zone || zone === 'UTC' || zone === 'Etc/UTC') return undefined

  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zone,
    }).formatToParts(at)
    const hours = parts.find(p => p.type === 'hour')?.value
    const minutes = parts.find(p => p.type === 'minute')?.value

    if (hours && minutes) return `${hours}:${minutes}`
  } catch {
    // No zone data for it: the host's own clock below.
  }

  const date = new Date(at)
  const hours = date.getHours()
  const minutes = date.getMinutes()

  return Number.isFinite(hours) && Number.isFinite(minutes) ? `${pad(hours)}:${pad(minutes)}` : undefined
}

const currentZone = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** `1h 20m`, `45m`, `2h`: a stretch of time, to the minute, rounded up. */
export const span = (ms: number): string => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000))

  if (minutes < 60) return `${minutes}m`

  const rest = minutes % 60

  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`
}

/** The session chip's word when the pace runs out first: `out ~16:40`, else `out in 1h 20m`. */
export const outLabel = (runsOutAt: number, now: number, zone?: string): string => {
  if (runsOutAt <= now) return 'out now'

  const clock = localClock(runsOutAt, zone)

  return clock ? `out ~${clock}` : `out in ${span(runsOutAt - now)}`
}

const FONT = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif`

const CORAL = '#D97757'
const AMBER = '#F0A63A'
const RED = '#E5534B'
const MUTED = '#77767a'
const PANEL = '#2b2a27'

/** A rough width of `text` at 10px tabular figures, for the label chips. */
const labelWidth = (text: string) => Math.round(text.length * 5.8 + 10)

export type ChartOptions = {
  /** Where "now" lies; defaults to the forecast's, else the newest sample. */
  now?: number
  /** The percent used at now; defaults to the forecast's, else the newest sample. */
  percent?: number
  /** The time zone the clock labels read in; the host's by default. */
  zone?: string
}

/**
 * The window drawn as a chart for a dark panel, on a real local clock: what was
 * used over its five hours, the pace carried on as a dashed amber line, the limit
 * as a dashed red line at 100%, and the time you'd be blocked shaded red when the
 * pace runs out before the reset. The future part of the window is a touch lighter.
 */
export const forecastChartSvg = (
  samples: readonly LimitSample[],
  forecast: Forecast | undefined,
  resetsAt: string | number,
  width: number,
  height: number,
  /** False for a chart set straight into a panel: no frame of its own. */
  framed = true,
  options: ChartOptions = {},
): string => {
  const end = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt)
  const w = Math.max(40, Math.round(width))
  const h = Math.max(30, Math.round(height))
  const inset = { left: 8, right: 8, top: 8, bottom: 20 }
  const plotW = w - inset.left - inset.right
  const plotH = h - inset.top - inset.bottom
  const right = inset.left + plotW
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  const style =
    `<style>text{font:500 10px ${FONT};font-variant-numeric:tabular-nums;fill:${MUTED}}` +
    `.grid{stroke:rgba(255,255,255,.06)}.base{stroke:rgba(255,255,255,.14)}` +
    `.limit{stroke:${RED};stroke-opacity:.7;stroke-width:1;stroke-dasharray:4 3}` +
    `.used{stroke:${CORAL};stroke-width:2;fill:none;stroke-linejoin:round;stroke-linecap:round}` +
    `.pace{stroke:${AMBER};stroke-width:1.5;stroke-dasharray:4 3;fill:none;stroke-linecap:round}` +
    `.now{stroke:rgba(255,255,255,.4);stroke-width:1;stroke-dasharray:1 3;stroke-linecap:round}` +
    `.chip{font-weight:700;fill:${PANEL}}.mark{fill:#c9c8cc}.quiet{fill:#5f5e62}.halo,.out{stroke:${PANEL}}.hollow{fill:${PANEL}}` +
    `.frame{fill:rgba(255,255,255,.03);stroke:rgba(255,255,255,.1)}.ahead{fill:rgba(255,255,255,.035)}` +
    // On a light panel the hairlines darken, the grey text deepens and the dots' halos turn white.
    inLight(
      `text{fill:#5F5E63}.grid{stroke:rgba(0,0,0,.08)}.base{stroke:rgba(0,0,0,.2)}.now{stroke:rgba(0,0,0,.45)}` +
        `.mark{fill:#3A393D}.quiet{fill:#8A898E}.halo,.out{stroke:#fff}.hollow{fill:#fff}` +
        `.frame{fill:rgba(0,0,0,.02);stroke:rgba(0,0,0,.12)}.ahead{fill:rgba(0,0,0,.035)}`,
    ) +
    `</style>`

  if (!Number.isFinite(end)) return `${head}${style}</svg>`

  const start = end - WINDOW_MS
  const points = inWindow(samples, end)
  const newest = points[points.length - 1]
  const now = Math.min(end, Math.max(start, options.now ?? forecast?.to.at ?? newest?.at ?? start))
  const current = options.percent ?? forecast?.to.percent ?? newest?.percent
  const zone = options.zone
  const clock = (at: number) => (zone === undefined ? localClock(at) : localClock(at, zone))
  const x = (at: number) => inset.left + ((Math.min(end, Math.max(start, at)) - start) / WINDOW_MS) * plotW
  const y = (percent: number) => inset.top + (1 - Math.min(100, Math.max(0, percent)) / 100) * plotH
  const xy = (s: LimitSample) => `${x(s.at).toFixed(1)},${y(s.percent).toFixed(1)}`
  const bottom = inset.top + plotH
  const nowX = x(now)
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
  const hasClock = clock(start) !== undefined

  let body = framed
    ? `<rect class="frame" x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="10"/>`
    : ''

  // Past and future: the future part of the window reads a touch lighter.
  if (nowX < right) {
    body += `<rect x="${nowX.toFixed(1)}" y="${inset.top}" width="${(right - nowX).toFixed(1)}" height="${plotH}" class="ahead"/>`
  }

  // The time you'd be blocked: from the run-out to the reset.
  if (forecast?.runsOutAt !== undefined) {
    const from = x(forecast.runsOutAt)

    body += `<rect x="${from.toFixed(1)}" y="${inset.top}" width="${Math.max(0, right - from).toFixed(1)}" height="${plotH}" fill="${RED}" fill-opacity=".12"/>`
  }

  body +=
    `<line class="grid" x1="${inset.left}" x2="${right}" y1="${y(50).toFixed(1)}" y2="${y(50).toFixed(1)}"/>` +
    `<text x="${right - 2}" y="${(y(50) - 3).toFixed(1)}" text-anchor="end" class="quiet">50%</text>` +
    `<line class="base" x1="${inset.left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>` +
    `<line class="limit" x1="${inset.left}" x2="${right}" y1="${y(100)}" y2="${y(100)}"/>` +
    `<text x="${inset.left + 4}" y="${y(100) + 11}" style="fill:${RED};fill-opacity:.85">Limit</text>`

  // The clock: an hourly tick from the window's start, the labels thinned to what fits.
  const labelRow = h - 5
  const wide = plotW >= 520
  const labelled = new Set(wide ? [0, 1, 2, 3, 4, 5] : [0, 2.5, 5])

  for (let k = 0; k <= 5; k++) {
    const at = start + k * 60 * 60_000
    const tx = x(at).toFixed(1)

    body += `<line class="base" x1="${tx}" x2="${tx}" y1="${bottom}" y2="${bottom + 3}"/>`
  }

  for (const k of labelled) {
    const at = start + k * 60 * 60_000
    const tx = x(at)
    const text = hasClock ? clock(at) : k === 0 ? '−5h' : k === 5 ? 'reset' : undefined

    if (!text) continue
    // The now label has this spot; the edges' labels are kept inside the drawing.
    if (k !== 0 && k !== 5 && Math.abs(tx - nowX) < 44) continue
    if ((k === 0 || k === 5) && Math.abs(tx - nowX) < 40) continue

    const anchor = k === 0 ? 'start' : k === 5 ? 'end' : 'middle'

    body += `<text x="${tx.toFixed(1)}" y="${labelRow}" text-anchor="${anchor}">${text}</text>`
  }

  if (nowX > inset.left + 1 && nowX < right - 1 && current !== undefined) {
    body += `<text x="${nowX.toFixed(1)}" y="${labelRow}" text-anchor="middle" class="mark">now</text>`
  }

  // What was used, to now.
  const used: LimitSample[] = points.filter(p => p.at < now)

  if (current !== undefined) used.push({ at: now, percent: current })

  if (used.length > 1) {
    const first = used[0]!
    const line = used.map(xy).join(' ')

    body +=
      `<polygon points="${x(first.at).toFixed(1)},${bottom} ${line} ${nowX.toFixed(1)},${bottom}" fill="${CORAL}" fill-opacity=".2"/>` +
      `<polyline class="used" points="${line}"/>`
  }

  if (nowX < right) {
    body += `<line class="now" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${inset.top}" y2="${bottom}"/>`
  }

  // The pace carried on, and where it ends.
  let outChip = ''

  if (forecast && forecast.pacePerHour > 0) {
    const stop = Math.min(end, forecast.runsOutAt ?? end)
    const reached = forecast.to.percent + (forecast.pacePerHour * (stop - forecast.to.at)) / HOUR
    const stopX = x(stop)
    const stopY = y(reached)

    body += `<polyline class="pace" points="${xy({ at: now, percent: forecast.to.percent })} ${stopX.toFixed(1)},${stopY.toFixed(1)}"/>`

    if (forecast.runsOutAt !== undefined) {
      const text = `out ~${clock(forecast.runsOutAt) ?? `in ${span(forecast.runsOutAt - now)}`}`
      const cw = labelWidth(text)
      // Right of the dot, in the blocked stretch, kept inside the plot.
      const cx = clamp(stopX + 7, inset.left + 2, right - cw - 2)
      const overlaps = cx < stopX + 4
      const cy = overlaps ? stopY + 8 : stopY + 5

      body += `<circle class="out" cx="${stopX.toFixed(1)}" cy="${stopY.toFixed(1)}" r="3.5" fill="${AMBER}" stroke-width="1.5"/>`
      outChip =
        `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cw}" height="15" rx="7.5" fill="${AMBER}"/>` +
        `<text class="chip" x="${(cx + cw / 2).toFixed(1)}" y="${(cy + 10.5).toFixed(1)}" text-anchor="middle">${text}</text>`
    } else {
      const text = `~${Math.round(forecast.atReset)}% at reset`

      body +=
        `<circle cx="${stopX.toFixed(1)}" cy="${stopY.toFixed(1)}" r="2.5" class="hollow" stroke="${AMBER}" stroke-width="1.2"/>` +
        `<text x="${(right - 4).toFixed(1)}" y="${clamp(stopY - 7, inset.top + 20, bottom - 4).toFixed(1)}" text-anchor="end">${text}</text>`
    }
  }

  // The dot at now, and its figure just left of and above it.
  if (current !== undefined) {
    const dy = y(current)
    const text = `${Math.round(current)}%`
    const cw = labelWidth(text)
    const cx = clamp(nowX - cw - 8, inset.left + 2, right - cw - 2)
    const cy = clamp(dy - 21, inset.top + 14, bottom - 17)

    body +=
      `<circle cx="${nowX.toFixed(1)}" cy="${dy.toFixed(1)}" r="3.5" fill="${CORAL}" class="halo" stroke-width="1.5"/>` +
      `<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${cw}" height="15" rx="7.5" fill="${CORAL}"/>` +
      `<text class="chip" x="${(cx + cw / 2).toFixed(1)}" y="${(cy + 10.5).toFixed(1)}" text-anchor="middle">${text}</text>`
  }

  return `${head}${style}${body}${outChip}</svg>`
}
