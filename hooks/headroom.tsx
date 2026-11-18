import { atom, read, update } from 'claude-code'
import type { Color, ElementTable, EngineInterface } from 'claude-code'

import type { Cache, Headroom, Reading } from '../types'
import { compact, describeTool } from './agents'

/** What fills the context, measured after a main-thread turn over the threshold. */
export const headroom = atom({ plugin: 'usage-pill', key: 'headroom' } as const, null)

/** The default of the `headroomAt` option: the context percentage the row shows from. */
export const HEADROOM_AT = 80

/** The option as set, or the default for anything that isn't a percentage. */
export const headroomAtOf = (options: Readonly<Record<string, unknown>> | undefined): number => {
  const value = Number(options?.headroomAt)

  return Number.isFinite(value) && value > 0 && value <= 100 ? value : HEADROOM_AT
}

/** How full the context is, as the pill's context figure reads it. */
export const contextPercent = (reading: Reading | null): number | undefined =>
  reading?.tokens === undefined || reading.window <= 0 ? undefined : (reading.tokens / reading.window) * 100

export type HeadroomView = {
  percent: number
  /** What fills the context, from the last measure; empty until one was taken. */
  categories: Headroom['categories']
  lastTurnDelta?: number
  biggest?: Headroom['biggest']
}

/** The row's figures, or undefined below the threshold, where the band stays one row. */
export const headroomViewOf = (
  reading: Reading | null,
  headroom: Headroom | null,
  threshold: number,
): HeadroomView | undefined => {
  const percent = contextPercent(reading)

  if (percent === undefined || percent < threshold) return undefined

  return {
    percent,
    categories: headroom?.categories ?? [],
    lastTurnDelta: headroom?.lastTurnDelta,
    biggest: headroom?.biggest,
  }
}

/** Only the categories that hold tokens in the context, largest first. */
export const usedCategories = (categories: Headroom['categories']): Headroom['categories'] =>
  categories
    .filter(c => c.kind === 'used' && c.tokens > 0)
    .map(({ name, tokens, kind, color }) => (color ? { name, tokens, kind, color } : { name, tokens, kind }))
    .sort((a, b) => b.tokens - a.tokens)

/** `+42k last turn`, or `−30k last turn` after a compaction. */
export const deltaLabel = (delta: number): string =>
  `${delta < 0 ? '−' : '+'}${compact(Math.abs(Math.round(delta)))} last turn`

/** What the toast and the notification say as the cache is about to go cold. */
export const coolingText = (minutes: number, tokens: number): string =>
  `Cache cools in ${minutes} min. Your next message would re-read ${compact(tokens)} tokens.`

/** The pill's own colours, one per category in turn. */
export const SEGMENT = ['#FF7A59', '#9B6BFF', '#3FD0FF', '#FF4FA3', '#FFB02E', '#6B8CFF', '#E36BFF', '#7BE495']

const escapeXml = (text: string) => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** A category's colour as the bars draw it: the pill's on a picture, its theme key on the terminal. */
export const segmentColor = (c: { color?: string }, index: number, hasPictures: boolean): Color =>
  hasPictures ? SEGMENT[index % SEGMENT.length]! : (c.color ?? TERMINAL_COLORS[index % TERMINAL_COLORS.length]!)

/** A thin bar of what fills the context, one segment per category, end to end. */
export const stackedBarSvg = (
  categories: readonly { name: string; tokens: number }[],
  width: number,
  height: number,
): string => {
  const total = categories.reduce((sum, c) => sum + c.tokens, 0)
  const r = height / 2
  let x = 0
  let segments = ''

  categories.forEach((c, i) => {
    const w = total > 0 ? (c.tokens / total) * width : 0

    segments += `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - (i < categories.length - 1 ? 1 : 0)).toFixed(1)}" height="${height}" fill="${SEGMENT[i % SEGMENT.length]}"><title>${escapeXml(`${c.name}: ${compact(c.tokens)}`)}</title></rect>`
    x += w
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<clipPath id="round"><rect width="${width}" height="${height}" rx="${r}"/></clipPath>` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="rgba(255,255,255,.1)"/>` +
    `<g clip-path="url(#round)">${segments}</g></svg>`
  )
}

/**
 * A bar of what fills the whole context window: one segment per category for the
 * used part, the rest an empty track. Rounded, `height` tall.
 */
export const windowBarSvg = (
  categories: readonly { name: string; tokens: number }[],
  window: number,
  width: number,
  height: number,
): string => {
  const r = height / 2
  let x = 0
  let segments = ''

  categories.forEach((c, i) => {
    const w = window > 0 ? Math.min(width - x, (c.tokens / window) * width) : 0

    if (w <= 0) return

    segments += `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - (i < categories.length - 1 ? 1 : 0)).toFixed(1)}" height="${height}" fill="${SEGMENT[i % SEGMENT.length]}"><title>${escapeXml(`${c.name}: ${compact(c.tokens)}`)}</title></rect>`
    x += w
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<clipPath id="round"><rect width="${width}" height="${height}" rx="${r}"/></clipPath>` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="rgba(255,255,255,.1)"/>` +
    `<g clip-path="url(#round)">${segments}</g></svg>`
  )
}

/** The terminal's bar: cells shared out by tokens, each category in its own theme colour. */
export const terminalBar = (
  categories: readonly { name: string; tokens: number }[],
  cells: number,
): { cells: number; index: number }[] => {
  const total = categories.reduce((sum, c) => sum + c.tokens, 0)

  if (total <= 0) return []

  let given = 0

  return categories.map((c, i) => {
    const until = Math.round(((given + c.tokens) / total) * cells)
    const share = { cells: until - Math.round((given / total) * cells), index: i }

    given += c.tokens

    return share
  })
}

export const TERMINAL_COLORS: readonly Color[] = ['claude', 'suggestion', 'success', 'warning', 'permission', 'error', 'subtle']

/** Asks the engine to compact, and says how it went. */
export async function compactNow($: EngineInterface) {
  try {
    const result = await $.session.compact()

    if (result.skip !== undefined) {
      $.ui.toast(`Compaction skipped: ${result.skip}`)

      return
    }

    // What filled the context before is gone with it; the compaction stands either way.
    await update($, headroom, () => null).catch(() => undefined)
    $.ui.toast(
      result.tokensBefore !== undefined && result.tokensAfter !== undefined
        ? `Compacted: ${compact(result.tokensBefore)} → ${compact(result.tokensAfter)} tokens`
        : 'Compacted the conversation',
    )
  } catch (error) {
    $.ui.toast(`Couldn’t compact: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type Elements = Pick<ElementTable<'desktop'>, 'Box' | 'Text' | 'Button'> & {
  Svg?: ElementTable<'desktop'>['Svg']
}

const BAR_WIDTH = 120
const BAR_HEIGHT = 6

/**
 * The band's second row, once the context passes the threshold: how full it is, a
 * thin bar of what fills it, what the last turn added and its largest tool result,
 * and a button to compact. Native elements, under the pill rather than in it: the
 * pill keeps its one fitted row. With no `Svg` (the terminal) the bar is text.
 */
export function headroomRow($: EngineInterface, els: Elements, view: HeadroomView) {
  const { Box, Button, Text, Svg } = els
  const percent = Math.round(view.percent)
  const color: Color = view.percent >= 90 ? 'error' : 'warning'
  const used = usedCategories(view.categories)
  const breakdown = used.map(c => `${c.name} ${compact(c.tokens)}`).join(', ')

  const bar =
    used.length === 0 ? null : Svg ? (
      <Box flexShrink={0}>
        <Svg
          source={stackedBarSvg(used, BAR_WIDTH, BAR_HEIGHT)}
          alt={`Context by category: ${breakdown}`}
          width={BAR_WIDTH}
          height={BAR_HEIGHT}
        />
      </Box>
    ) : (
      <Box flexShrink={0}>
        {terminalBar(used, 16).map(s =>
          s.cells > 0 ? (
            <Text
              key={`bar-${s.index}`}
              color={used[s.index]?.color ?? TERMINAL_COLORS[s.index % TERMINAL_COLORS.length]}
            >
              {'█'.repeat(s.cells)}
            </Text>
          ) : null,
        )}
      </Box>
    )

  return (
    <Box key="headroom" flexDirection="row" columnGap={2} alignItems="center">
      <Box flexShrink={0}>
        <Text color={color} bold>
          {`${percent}% context`}
        </Text>
      </Box>
      {bar}
      {view.lastTurnDelta === undefined ? null : (
        <Box flexShrink={0}>
          <Text dimColor>{deltaLabel(view.lastTurnDelta)}</Text>
        </Box>
      )}
      {view.biggest ? (
        <Box flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {`largest: ${view.biggest.label} ~${compact(view.biggest.tokens)}`}
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        <Button key="compact-now" label="Compact now" onPress={() => void compactNow($)} />
      </Box>
    </Box>
  )
}

// ── The main thread's last turn ─────────────────────────────────────────────
// Kept in the module: a reload loses one turn's figures, which the next turn brings back.

let turnStartTokens: number | undefined
let biggest: Headroom['biggest']

/** A main-thread turn begins: what the context held, and no tool result yet. */
export const startTurn = (tokens: number | undefined) => {
  turnStartTokens = tokens
  biggest = undefined
}

/** Keeps a main-thread tool result if it is the turn's largest, at four characters a token. */
export const noteToolResult = (tool: string, args: Record<string, unknown>, text: string | undefined) => {
  const tokens = Math.round((text?.length ?? 0) / 4)

  if (tokens > 0 && tokens > (biggest?.tokens ?? 0)) {
    biggest = { label: describeTool(tool, args), tokens }
  }
}

/**
 * After a main-thread turn: over the threshold, what fills the context by category,
 * what the turn added and its largest tool result; under it, nothing kept.
 */
export async function measureHeadroom($: EngineInterface, reading: Reading | null, threshold: number, now: number) {
  const percent = contextPercent(reading)

  if (percent === undefined || percent < threshold) {
    if ((await read($, headroom)) !== null) await update($, headroom, () => null)

    return
  }

  // A breakdown that can't be had leaves the row its figures from the reading.
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)

  if (!usage) return

  const tokens = usage.context.tokens ?? reading?.tokens
  const categories = usedCategories(
    (usage.context.breakdown?.categories ?? []).map(c => ({
      name: c.name,
      tokens: c.tokens,
      kind: c.kind,
      color: c.color,
    })),
  )
  const next: Headroom = {
    categories,
    ...(tokens !== undefined && turnStartTokens !== undefined ? { lastTurnDelta: tokens - turnStartTokens } : {}),
    ...(biggest ? { biggest } : {}),
    at: now,
  }

  await update($, headroom, () => next)
}

// ── The cache going cold ────────────────────────────────────────────────────

/** How long before the cache goes cold the person hears of it. */
export const COOLING_NOTICE_MS = 5 * 60_000
/** From how long before it goes cold the gauge counts down. */
export const COOLING_SHOWN_MS = 10 * 60_000
const NOTIFY_KEY = 'cache-cold'

/** The tokens the next request would read afresh once the cache is cold. */
export const cachedTokens = (last: Cache) => last.read + last.written + last.uncached

/**
 * How long the prompt cache holds an entry after its last use, as the band
 * counts it (its `CACHE_TTL`): an hour, five minutes on extra usage, which no
 * reading says.
 */
export const CACHE_TTL_MS = 60 * 60_000

/** Warm or cold, as the band's cache chip reads it, and the minutes left while warm. */
export const cacheStatusOf = (last: Cache, time: number, ttl = CACHE_TTL_MS): { isWarm: boolean; coolsIn?: number } => {
  // A request that neither read nor wrote it left nothing behind to stay warm.
  if (last.read + last.written === 0) return { isWarm: false }
  // Seeded from an earlier response with no time on it: all that's known is it was used.
  if (last.at === undefined) return { isWarm: true }

  const left = ttl - (time - last.at)

  return left > 0 ? { isWarm: true, coolsIn: Math.ceil(left / 60_000) } : { isWarm: false }
}

/** `Warm · cools in 42m`, `Warm`, or `Cold`. */
export const cacheStatusLabel = (status: { isWarm: boolean; coolsIn?: number }): string =>
  !status.isWarm ? 'Cold' : status.coolsIn === undefined ? 'Warm' : `Warm · cools in ${status.coolsIn}m`

/** What the next message would read: from the cache while it is warm, afresh once it is cold. */
export const nextMessageLabel = (last: Cache, isWarm: boolean): string =>
  isWarm
    ? `Next message reads ${compact(cachedTokens(last))} tokens from the cache`
    : `Next message re-reads ${compact(cachedTokens(last))} tokens`

// The cache write the toast last spoke of: once per write.
let toastedFor: number | undefined

/**
 * From the minute tick: with five minutes or less before the cache goes cold and
 * the main thread idle, a toast says so, once per cache write.
 */
export const coolingToast = (last: Cache | null, isBusy: boolean, time: number, ttl: number): boolean => {
  if (!last || last.at === undefined || last.read + last.written === 0 || isBusy || toastedFor === last.at) {
    return false
  }

  const left = ttl - (time - last.at)

  if (left <= 0 || left > COOLING_NOTICE_MS) return false

  toastedFor = last.at

  return true
}

// Each cancel waits on the notification before it: a cancel sent before the
// notification is out takes back nothing.
let notices: Promise<unknown> = Promise.resolve()

/**
 * After a main-loop request that used the cache: books a native notification for
 * five minutes before it goes cold, taking back the one booked before. `untilBack`
 * drops it if the person comes back first, so it only reaches someone away. A
 * terminal raises any notification at once, so only an app's surface gets one.
 */
export function bookCoolingNotice($: EngineInterface, tokens: number, ttl: number): Promise<unknown> {
  notices = notices
    .then(async () => {
      const surfaces = await $.session.surfaces()

      if (surfaces.length === 0 || surfaces.includes('terminal')) return

      // Sent again under its key it would replace the last one; taken back first all
      // the same, so no host keeps two. A failed cancel still books the new one, and
      // a Claude Code older than `cancelNotify` (2.1.318 has none: the call throws) skips it.
      try {
        await $.ui.cancelNotify(NOTIFY_KEY)
      } catch {
        // Nothing to take back here.
      }
      await $.ui.notify(coolingText(COOLING_NOTICE_MS / 60_000, tokens), {
        key: NOTIFY_KEY,
        delayMs: ttl - COOLING_NOTICE_MS,
        untilBack: true,
        title: 'Cache cooling',
      })
    })
    .catch(() => undefined)

  return notices
}
