import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Limit, LimitSample, StoredSamples } from '../types'

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

/**
 * The window drawn as a chart: what was used over its five hours, the pace carried
 * on as a dashed line, and the limit as a red line at 100%. In the pill's colours,
 * for a dark surface.
 */
export const forecastChartSvg = (
  samples: readonly LimitSample[],
  forecast: Forecast | undefined,
  resetsAt: string | number,
  width: number,
  height: number,
  /** False for a chart set straight into a panel: no frame of its own. */
  framed = true,
): string => {
  const end = typeof resetsAt === 'number' ? resetsAt : Date.parse(resetsAt)
  const w = Math.max(40, Math.round(width))
  const h = Math.max(30, Math.round(height))
  const inset = { left: 6, right: 34, top: 8, bottom: 16 }
  const plotW = w - inset.left - inset.right
  const plotH = h - inset.top - inset.bottom
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  const style =
    `<style>text{font:500 10px ${FONT};font-variant-numeric:tabular-nums;fill:#9A9AA3}` +
    `.grid{stroke:rgba(255,255,255,.08)}.limit{stroke:#FF4D4D;stroke-width:1.2}` +
    `.used{stroke:url(#used);stroke-width:2;fill:none;stroke-linejoin:round;stroke-linecap:round}` +
    `.pace{stroke:#FFB02E;stroke-width:1.5;stroke-dasharray:4 3;fill:none}.out{fill:#FF4D4D}</style>`

  if (!Number.isFinite(end)) return `${head}${style}</svg>`

  const start = end - WINDOW_MS
  const points = inWindow(samples, end)
  const top = 100
  const x = (at: number) => inset.left + ((Math.min(end, Math.max(start, at)) - start) / WINDOW_MS) * plotW
  const y = (percent: number) => inset.top + (1 - Math.min(top, Math.max(0, percent)) / top) * plotH
  const xy = (s: LimitSample) => `${x(s.at).toFixed(1)},${y(s.percent).toFixed(1)}`
  const bottom = inset.top + plotH

  let body =
    (framed ? `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="10" fill="rgba(255,255,255,.03)" stroke="rgba(255,255,255,.1)"/>` : '') +
    `<line class="grid" x1="${inset.left}" x2="${inset.left + plotW}" y1="${y(50)}" y2="${y(50)}"/>` +
    `<line class="grid" x1="${inset.left}" x2="${inset.left + plotW}" y1="${bottom}" y2="${bottom}"/>` +
    `<line class="limit" x1="${inset.left}" x2="${inset.left + plotW}" y1="${y(100)}" y2="${y(100)}"/>` +
    `<text x="${inset.left + plotW + 4}" y="${y(100)}" dy=".35em" style="fill:#FF4D4D">100%</text>` +
    `<text x="${inset.left + plotW + 4}" y="${y(50)}" dy=".35em">50%</text>` +
    `<text x="${inset.left}" y="${h - 4}">−5h</text>` +
    `<text x="${inset.left + plotW}" y="${h - 4}" text-anchor="end">reset</text>`

  const used = forecast ? [...points.filter(p => p.at < forecast.to.at), forecast.to] : points

  if (used.length > 0) {
    const first = used[0]!
    const last = used[used.length - 1]!
    const line = used.map(xy).join(' ')

    body +=
      `<polygon points="${x(first.at).toFixed(1)},${bottom} ${line} ${x(last.at).toFixed(1)},${bottom}" fill="url(#area)"/>` +
      `<polyline class="used" points="${line}"/>`
  }

  if (forecast && forecast.pacePerHour > 0) {
    const stop = Math.min(end, forecast.runsOutAt ?? end)
    const reached = forecast.to.percent + (forecast.pacePerHour * (stop - forecast.to.at)) / (60 * 60_000)

    body += `<polyline class="pace" points="${xy(forecast.to)} ${xy({ at: stop, percent: reached })}"/>`

    if (forecast.runsOutAt !== undefined) {
      body += `<circle class="out" cx="${x(forecast.runsOutAt).toFixed(1)}" cy="${y(100).toFixed(1)}" r="3"/>`
    }
  }

  const defs =
    `<defs><linearGradient id="used" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FF7A59"/><stop offset="1" stop-color="#B46BFF"/></linearGradient>` +
    `<linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF7A59" stop-opacity=".28"/><stop offset="1" stop-color="#FF7A59" stop-opacity="0"/></linearGradient></defs>`

  return `${head}${style}${defs}${body}</svg>`
}
