import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderInput } from 'claude-code'

import type { Ledger, Popover } from '../types'
import { compact, elapsed } from './agents'
import { forecastChartSvg, forecastOf, localClock, outLabel, span } from './forecast'
import {
  CACHE_TTL_MS,
  COOLING_NOTICE_MS,
  bookCoolingNotice,
  cacheStatusOf,
  cancelCoolingNotice,
  compactNow,
  deltaLabel,
  SEGMENT,
  segmentColor,
  terminalBar,
  usedCategories,
  windowBarSvg,
} from './headroom'
import { NO_LEDGER, RECEIPT_PANE, barSvg, blockBar, cacheHit, shares, usedSince } from './receipt'
import { CACHE_COLORS, countdownSvg, inputOf, isColdStart, nextCost, savedOf, splitBarSvg, stripSvg, stripText } from './cache'

// ── The popover under the pill ──────────────────────────────────────────────
// One module at a time, drawn as rows of the band right under the pill: Limits
// (the session and week chips), Context, Cache, and Session (from /receipt).
// The same chip, its ×, or a new prompt closes it.

/** Which module the popover shows; null while it is closed. */
const popover = atom({ plugin: 'usage-pill', key: 'popover' } as const, null)
// Declared here as well: a file reads only the atoms it declares.
const ledger = atom({ plugin: 'usage-pill', key: 'ledger' } as const, NO_LEDGER)
const cache = atom({ plugin: 'usage-pill', key: 'cache' } as const, null)
const limitSamples = atom({ plugin: 'usage-pill', key: 'limitSamples' } as const, [])
const headroom = atom({ plugin: 'usage-pill', key: 'headroom' } as const, null)
const contextOpen = atom({ plugin: 'usage-pill', key: 'contextOpen' } as const, false)
const cacheLog = atom({ plugin: 'usage-pill', key: 'cacheLog' } as const, [])
const coolingWarnOff = atom({ plugin: 'usage-pill', key: 'coolingWarnOff' } as const, false)

/** Where the store keeps whether the cooling warning is off, across sessions. */
const WARN_KEY = 'coolingWarnOff'

/** At session start: the cooling warning as it was last left. */
export async function loadCoolingWarn($: EngineInterface) {
  const stored = await $.store.get(WARN_KEY)

  if (stored === true) await update($, coolingWarnOff, () => true)
}

/** Turns the five-minute cooling warning off or back on, and books or takes back its notification. */
export async function toggleCoolingWarn($: EngineInterface) {
  const isOff = !(await read($, coolingWarnOff))

  await update($, coolingWarnOff, () => isOff)
  await $.store.set(WARN_KEY, isOff).catch(() => undefined)

  if (isOff) {
    await cancelCoolingNotice($)

    return
  }

  const last = await read($, cache)

  if (last?.at !== undefined && last.read + last.written > 0) {
    await bookCoolingNotice($, inputOf(last), CACHE_TTL_MS, (await $.clock.now()) - last.at)
  }
}

/** Shows `kind`, in place of whatever was open. */
export async function openPopover($: EngineInterface, kind: Popover) {
  await update($, popover, () => kind)
}

/** Shows `kind`, or closes it when it is the one open: a chip's press. */
export async function togglePopover($: EngineInterface, kind: Popover) {
  await update($, popover, open => (open === kind ? null : kind))
  if ((await read($, popover)) === null) await foldContext($)
}

export async function closePopover($: EngineInterface) {
  if ((await read($, popover)) !== null) await update($, popover, () => null)
  await foldContext($)
}

/** The Context module opens folded again next time. */
async function foldContext($: EngineInterface) {
  if (await read($, contextOpen)) await update($, contextOpen, () => false)
}

const TITLE: Record<Popover, string> = { limits: 'Session limit', context: 'Context', cache: 'Cache', session: 'Session' }

/** The one accent of the panels that have bars. */
const ACCENT = '#D97757'
/** The bar column of a who-spent row, in cells on both surfaces, and its pixels on a picture. */
const BAR_CELLS = 14
const BAR_PX = 110
/** The right-hand figure of a who-spent row, in cells: `100% · 999k`. */
const FIGURE_CELLS = 12
/** At most this many legend entries; the rest are one `Other`. */
const LEGEND_TOP = 5

const tone = (percent: number): Color | undefined => (percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined)

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** `20:30` within the day, `Mon 09:00` further off; `in 2h` where the clock is unknown. */
export const resetLabel = (at: number, now: number): string => {
  const clock = localClock(at)

  if (!clock) return `in ${span(at - now)}`
  if (at - now < 20 * 60 * 60_000) return clock

  let day: string | undefined

  try {
    day = new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(at)
  } catch {
    day = WEEKDAY[new Date(at).getDay()]
  }

  return `${day ?? ''} ${clock}`.trim()
}

/** The legend's entries: the largest few, the rest as one `Other`. */
export const legendOf = <C extends { name: string; tokens: number; color?: string }>(
  categories: readonly C[],
  top = LEGEND_TOP,
): { name: string; tokens: number; color?: string; isOther?: true }[] => {
  const sorted = [...categories].sort((a, b) => b.tokens - a.tokens)
  const rest = sorted.slice(top)
  const head = sorted.slice(0, top).map(c => (c.color ? { name: c.name, tokens: c.tokens, color: c.color } : { name: c.name, tokens: c.tokens }))

  return rest.length === 0 ? head : [...head, { name: 'Other', tokens: rest.reduce((n, c) => n + c.tokens, 0), isOther: true }]
}


/** One row of the Context module: a category with its share of what is used. */
export type ContextRow = { name: string; tokens: number; color?: string; index: number; share: number }
export type ContextGroup = { title: 'Conversation' | 'Always loaded'; tokens: number; share: number; rows: ContextRow[] }

/** Whether a category is the conversation itself: /context names it `Messages`. */
const isConversation = (name: string) => /^messages?$/i.test(name.trim())

/** At most this many rows in Always loaded; the rest are one `Other`. */
const ALWAYS_TOP = 7

/**
 * The used categories in two groups: the conversation, and what is loaded whatever
 * is said (system prompt, tools, skills, memory files, agents). `share` is of what
 * is used. `index` is the category's place by size across both, so a colour is the
 * same in the bar and in its row.
 */
export const contextGroups = <C extends { name: string; tokens: number; color?: string }>(
  categories: readonly C[],
  top = ALWAYS_TOP,
): ContextGroup[] => {
  const sorted = [...categories].filter(c => c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const total = sorted.reduce((n, c) => n + c.tokens, 0)
  const rowOf = (c: C, index: number): ContextRow => ({
    name: c.name,
    tokens: c.tokens,
    ...(c.color ? { color: c.color } : {}),
    index,
    share: total > 0 ? c.tokens / total : 0,
  })
  const all = sorted.map(rowOf)
  const conversation = all.filter(r => isConversation(r.name))
  let always = all.filter(r => !isConversation(r.name))

  if (always.length > top + 1) {
    const rest = always.slice(top)
    const tokens = rest.reduce((n, r) => n + r.tokens, 0)

    always = [...always.slice(0, top), { name: 'Other', tokens, index: top, share: total > 0 ? tokens / total : 0 }]
  }

  const groups: ContextGroup[] = [
    { title: 'Conversation', rows: conversation },
    { title: 'Always loaded', rows: always },
  ].map(g => {
    const tokens = g.rows.reduce((n, r) => n + r.tokens, 0)

    return { ...g, tokens, share: total > 0 ? tokens / total : 0 } as ContextGroup
  })

  return groups.filter(g => g.rows.length > 0)
}

/**
 * The open module, drawn for the band under the pill, or null while none is
 * open. `width` is the room inside the panel, in the drawing's pixels (charts
 * and bars are drawn to it), and `columns` the same in cells (the terminal's
 * text versions).
 */
export async function popoverPanel($: EngineInterface, e: RenderInput, width: number, columns: number, rowsLeft = Infinity) {
  const kind = await read($, popover)

  if (kind === null) return null

  const l = await read($, ledger)
  const lastCache = await read($, cache)
  const samples = (await read($, limitSamples)) ?? []
  const measured = await read($, headroom)
  const now = await $.clock.now()
  const hasPictures = e.surface !== 'terminal'
  const { Box, Button, Text } = $.ui.resolve(e)
  const picture = (key: string, source: string, alt: string, pw: number, ph: number) => {
    const { Svg } = $.ui.resolve(e as RenderInput<'AbovePrompt', 'desktop'>)

    return <Svg key={key} source={source} alt={alt} width={pw} height={ph} />
  }
  // Only Context needs the breakdown, which `summary` estimates locally, sending nothing.
  const usage =
    kind === 'context'
      ? await $.session.usage({ breakdown: 'summary' }).catch(() => $.session.usage())
      : await $.session.usage()

  /** A label on the left, its value right-aligned. */
  const pair = (key: string, label: string, value: string, color?: Color, isDim = false) => (
    <Box key={key} flexDirection="row" columnGap={2} justifyContent="space-between">
      <Box flexShrink={1}>
        <Text dimColor wrap="truncate-end">
          {label}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <Text tabular color={color} dimColor={isDim}>
          {value}
        </Text>
      </Box>
    </Box>
  )

  /** The module's first row: its name, its figure (and a dim rest), and the ×. */
  const heading = (value: string, color?: Color, rest?: string) => (
    <Box key="popover-head" flexDirection="row" columnGap={2} justifyContent="space-between" alignItems="center">
      <Box flexShrink={1}>
        <Text weight="semibold" wrap="truncate-end">
          {TITLE[kind]}
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={1} flexShrink={0} alignItems="center">
        <Text tabular color={color}>
          {value}
        </Text>
        {rest ? (
          <Text tabular dimColor>
            {rest}
          </Text>
        ) : null}
        <Box marginLeft={1}>
          <Button key="popover-close" plain label="×" onPress={() => void closePopover($)} />
        </Box>
      </Box>
    </Box>
  )

  const caption = (key: string, text: string) => (
    <Text key={key} dimColor size="caption">
      {text}
    </Text>
  )

  let rows: unknown[]

  if (kind === 'limits') {
    const five = usage.rateLimits.find(r => r.kind === 'five_hour')
    const week = usage.rateLimits.find(r => r.kind === 'seven_day')
    const pace = five ? forecastOf(samples, five, now) : undefined
    const resetsAt = five?.resetsAt ? Date.parse(five.resetsAt) : NaN
    const weekResets = week?.resetsAt ? Date.parse(week.resetsAt) : NaN
    const used = usedSince(five?.percentUsed, l.sessionLimitAtStart)
    const chartHeight = 116
    const outText = pace?.runsOutAt === undefined ? undefined : outLabel(pace.runsOutAt, now)
    const tiles: { key: string; label: string; value: string; color?: Color }[] = []

    if (pace) {
      tiles.push(
        outText
          ? { key: 'pace-out', label: 'At this pace', value: `Out${outText.slice(3)}`, color: 'warning' }
          : { key: 'pace-end', label: 'At this pace', value: `~${Math.round(pace.atReset)}% at reset` },
      )
    }

    if (used !== undefined) {
      tiles.push({ key: 'session-used', label: 'This session', value: `+${used}%`, ...(used >= 70 ? { color: 'warning' as Color } : {}) })
    }

    if (pace) tiles.push({ key: 'pace-rate', label: 'Pace', value: `~${Math.max(0, Math.round(pace.pacePerHour))}% / h` })

    const weekTone = week ? tone(week.percentUsed) : undefined
    const weekFill = week ? (week.percentUsed >= 90 ? '#E5534B' : week.percentUsed >= 70 ? '#F0A63A' : ACCENT) : ACCENT
    const weekReset = Number.isNaN(weekResets) ? undefined : resetLabel(weekResets, now)
    // The room left for the week's bar, after its label, figure and reset (about 8px a cell).
    const weekBarPx = Math.max(40, Math.round(width) - 220)

    rows = [
      five
        ? heading(
            `${Math.round(five.percentUsed)}%`,
            pace?.runsOutAt !== undefined ? (tone(five.percentUsed) ?? 'warning') : tone(five.percentUsed),
            Number.isNaN(resetsAt) ? undefined : `· resets ${resetLabel(resetsAt, now)}`,
          )
        : heading('No reading yet'),
      hasPictures && five?.resetsAt && samples.length > 0
        ? (
            <Box key="limits-chart" marginTop={1}>
              {picture(
                'limits-chart-svg',
                forecastChartSvg(samples, pace, five.resetsAt, Math.round(width), chartHeight, false, {
                  now,
                  percent: five.percentUsed,
                }),
                `Session limit ${Math.round(five.percentUsed)}% used${outText ? `, ${outText}` : ''}${Number.isNaN(resetsAt) ? '' : `, resets ${resetLabel(resetsAt, now)}`}`,
                Math.round(width),
                chartHeight,
              )}
            </Box>
          )
        : null,
      tiles.length === 0 ? null : (
        <Box key="limits-tiles" flexDirection="row" columnGap={1} marginTop={1}>
          {tiles.map(t => (
            <Box
              key={t.key}
              flexDirection="column"
              flexGrow={1}
              width={`${Math.floor(100 / tiles.length) - 1}%`}
              paddingX={1}
              {...(hasPictures ? { backgroundColor: 'rgba(255,255,255,.05)' } : {})}
            >
              <Text dimColor size="caption" wrap="truncate-end">
                {t.label}
              </Text>
              <Text tabular color={t.color} wrap="truncate-end">
                {t.value}
              </Text>
            </Box>
          ))}
        </Box>
      ),
      week ? (
        <Box key="limits-week" flexDirection="row" columnGap={2} alignItems="center" marginTop={1}>
          <Box flexShrink={0} width={5}>
            <Text dimColor>Week</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {hasPictures ? (
              picture('limits-week-bar', barSvg(week.percentUsed / 100, weekFill, weekBarPx, 6), `Week ${Math.round(week.percentUsed)}%`, weekBarPx, 6)
            ) : (
              <Text color={weekTone ?? 'claude'}>{blockBar(week.percentUsed / 100, 12)}</Text>
            )}
          </Box>
          <Box flexShrink={0}>
            <Text tabular color={weekTone}>{`${Math.round(week.percentUsed)}%`}</Text>
          </Box>
          {weekReset ? (
            <Box flexShrink={0}>
              <Text tabular dimColor>
                {weekReset}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null,
    ]
  } else if (kind === 'context') {
    const { tokens, window } = usage.context
    const used = usedCategories(
      (usage.context.breakdown?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })),
    )
    const isOpen = (await read($, contextOpen)) === true
    // Opened, every category has its row; folded, the smallest share one.
    const groups = contextGroups(used, isOpen ? Infinity : undefined)
    const usedTotal = used.reduce((n, c) => n + c.tokens, 0)
    const shown = tokens ?? usedTotal
    const share = window <= 0 || shown <= 0 ? undefined : (shown / window) * 100
    const colorOf = (c: { color?: string }, i: number): Color => segmentColor(c, i, hasPictures)
    const described = used.map(c => `${c.name} ${compact(c.tokens)}`).join(', ')
    const biggest = groups.flatMap(g => g.rows).sort((a, b) => b.tokens - a.tokens)[0]
    const maxTokens = biggest?.tokens ?? 1
    const lastDelta = measured?.lastTurnDelta
    const heavyTurn = lastDelta !== undefined && window > 0 && lastDelta > window * 0.1
    const ROW_BAR_PX = 64

    // One grid for group headers and rows alike, so every figure lines up:
    // the dot, the name (growing), the bar, the tokens, the share.
    const BAR_COLUMNS = 9
    const TOKEN_COLUMNS = 6
    const SHARE_COLUMNS = 5
    const figures = (key: string, tokens: string, share: string, isDim: boolean) => [
      <Box key={`${key}-tokens`} flexShrink={0} width={TOKEN_COLUMNS} justifyContent="flex-end">
        <Text tabular dimColor={isDim}>
          {tokens}
        </Text>
      </Box>,
      <Box key={`${key}-share`} flexShrink={0} width={SHARE_COLUMNS} justifyContent="flex-end">
        <Text tabular dimColor>
          {share}
        </Text>
      </Box>,
    ]

    // The band scrolls a tree taller than its rows: what doesn't fit folds into one
    // `n more` row per group, the smallest first, so the footer always shows. Fixed:
    // the heading, the bar and its margin, the footer and its margin, and per group
    // a header and its margin.
    const fixed = 1 + 2 + 2 + groups.length * 2
    const budget = Math.max(groups.length, rowsLeft - fixed)
    const fitted = groups.map(g => ({ ...g, rows: [...g.rows], folded: [] as ContextRow[] }))
    const rowCount = () => fitted.reduce((n, g) => n + g.rows.length + (g.folded.length > 0 ? 1 : 0), 0)

    while (!isOpen && rowCount() > budget) {
      // Fold from the group with the most rows; never its last one.
      const g = [...fitted].sort((a, b) => b.rows.length - a.rows.length)[0]

      if (!g || g.rows.length <= 1) break

      g.folded.unshift(g.rows.pop()!)
    }

    const groupRows = fitted.map(g => (
      <Box key={`context-group-${g.title}`} flexDirection="column" marginTop={1}>
        <Box flexDirection="row" columnGap={1} alignItems="center" paddingX={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text dimColor size="caption" wrap="truncate-end">
              {g.title}
            </Text>
          </Box>
          <Box flexShrink={0} width={BAR_COLUMNS} />
          {figures(`context-group-${g.title}`, compact(g.tokens), percent(g.share), true)}
        </Box>
        {g.rows.map(r => {
          const isBiggest = r === biggest
          const isHeavyMcp = g.title === 'Always loaded' && /mcp/i.test(r.name) && r.share > 0.25
          const fill = isHeavyMcp ? 'rgba(240,166,58,.14)' : isBiggest ? 'rgba(217,119,87,.14)' : undefined
          const dot = r.name === 'Other' ? (hasPictures ? '#9A9AA3' : 'subtle') : colorOf(r, r.index)

          return (
            <Box
              key={`context-row-${r.name}`}
              flexDirection="row"
              columnGap={1}
              alignItems="center"
              paddingX={1}
              {...(hasPictures && fill ? { backgroundColor: fill } : {})}
            >
              <Box flexShrink={0}>
                <Text color={dot}>●</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text dimColor={!(isBiggest || isHeavyMcp)} wrap="truncate-end">
                  {r.name}
                </Text>
              </Box>
              <Box flexShrink={0} width={BAR_COLUMNS}>
                {hasPictures ? (
                  picture(
                    `context-rowbar-${r.name}`,
                    barSvg(r.tokens / maxTokens, r.name === 'Other' ? '#9A9AA3' : (SEGMENT[r.index % SEGMENT.length] ?? ACCENT), ROW_BAR_PX, 4),
                    `${r.name} ${percent(r.share)} of used`,
                    ROW_BAR_PX,
                    4,
                  )
                ) : (
                  <Text color={dot}>{blockBar(r.tokens / maxTokens, 8)}</Text>
                )}
              </Box>
              {figures(`context-row-${r.name}`, compact(r.tokens), percent(r.share), false)}
            </Box>
          )
        })}
        {g.folded.length === 0 ? null : (
          <Box key={`context-more-${g.title}`} flexDirection="row" columnGap={1} paddingX={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Button key={`context-more-${g.title}`} plain onPress={() => void update($, contextOpen, () => true)}>
                <Text dimColor size="caption" wrap="truncate-end">
                  {`▾ ${g.folded.length} more: ${g.folded.map(r => r.name).join(', ')}`}
                </Text>
              </Button>
            </Box>
            <Box flexShrink={0} width={BAR_COLUMNS} />
            {figures(
              `context-more-${g.title}`,
              compact(g.folded.reduce((n, r) => n + r.tokens, 0)),
              percent(g.folded.reduce((n, r) => n + r.share, 0)),
              true,
            )}
          </Box>
        )}
      </Box>
    ))

    rows = [
      heading(
        shown <= 0 ? 'No reading yet' : compact(shown),
        share === undefined ? undefined : tone(share),
        share === undefined ? undefined : `of ${compact(window)} · ${Math.round(share)}% · ${compact(Math.max(0, window - shown))} free`,
      ),
      used.length === 0 || window <= 0
        ? null
        : (
            <Box key="context-bar" flexDirection="column" marginTop={1}>
              {hasPictures ? (
                picture(
                  'context-bar-svg',
                  windowBarSvg(used, window, Math.round(width), 8),
                  `Context by category: ${described}`,
                  Math.round(width),
                  8,
                )
              ) : (
                <Box>
                  {terminalBar(used, Math.max(1, Math.round((usedTotal / window) * Math.max(8, columns)))).map(s =>
                    s.cells > 0 ? (
                      <Text key={`context-bar-${s.index}`} color={colorOf(used[s.index]!, s.index)}>
                        {'█'.repeat(s.cells)}
                      </Text>
                    ) : null,
                  )}
                  <Text dimColor>
                    {'░'.repeat(Math.max(0, Math.max(8, columns) - Math.max(1, Math.round((usedTotal / window) * Math.max(8, columns)))))}
                  </Text>
                </Box>
              )}
            </Box>
          ),
      ...groupRows,
      isOpen ? (
        <Box key="context-less" paddingX={1}>
          <Button key="context-less" plain onPress={() => void update($, contextOpen, () => false)}>
            <Text dimColor size="caption">
              ▴ Show less
            </Text>
          </Button>
        </Box>
      ) : null,
      <Box key="context-footer" flexDirection="row" columnGap={2} justifyContent="space-between" alignItems="center" marginTop={1}>
        <Box flexShrink={1} flexDirection="row" columnGap={1}>
          {lastDelta === undefined ? null : (
            <>
              <Text dimColor>Last turn</Text>
              <Text tabular color={heavyTurn ? 'warning' : undefined}>
                {`${lastDelta < 0 ? '−' : '+'}${compact(Math.abs(Math.round(lastDelta)))}`}
              </Text>
            </>
          )}
          {measured?.biggest ? (
            <>
              <Text dimColor>{lastDelta === undefined ? 'Largest' : '· largest'}</Text>
              <Box flexShrink={1}>
                <Text wrap="truncate-end">{`${measured.biggest.label} ~${compact(measured.biggest.tokens)}`}</Text>
              </Box>
            </>
          ) : null}
        </Box>
        <Box flexShrink={0}>
          <Button key="popover-compact" label="Compact now" onPress={() => void compactNow($)} />
        </Box>
      </Box>,
    ]
  } else if (kind === 'cache') {
    const status = lastCache ? cacheStatusOf(lastCache, now) : undefined
    const hit = cacheHit(l.main)
    const log = (await read($, cacheLog)) ?? []
    const isWarnOff = (await read($, coolingWarnOff)) === true
    const cost = lastCache ? nextCost(lastCache) : undefined
    const cooledAt = lastCache?.at === undefined ? undefined : lastCache.at + CACHE_TTL_MS
    const clockOf = (at: number) => localClock(at) ?? `${span(Math.abs(at - now))}`
    const isCooling = status?.isWarm === true && status.coolsIn !== undefined && status.coolsIn <= 10
    const colds = log.filter(isColdStart)
    // Bars sit between a label and a figure, about nine pixels a cell.
    const LABEL_COLUMNS = 14
    const FIGURE_COLUMNS = 8
    const rowBarPx = Math.max(40, Math.round(width - (LABEL_COLUMNS + FIGURE_COLUMNS + 4) * 9))
    const fullPx = Math.max(40, Math.round(width))

    /** A label, a bar to scale, a figure: one row of the cost comparison. */
    const costRow = (key: string, label: string, fraction: number, color: string, figure: string, isDim: boolean) => (
      <Box key={key} flexDirection="row" columnGap={1} alignItems="center">
        <Box flexShrink={0} width={LABEL_COLUMNS}>
          <Text dimColor={isDim} wrap="truncate-end">
            {label}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {hasPictures ? (
            picture(`${key}-bar`, barSvg(fraction, color, rowBarPx, 6), `${label} ${figure}`, rowBarPx, 6)
          ) : (
            <Text color={isDim ? 'warning' : 'success'}>{blockBar(fraction, Math.max(8, columns - LABEL_COLUMNS - FIGURE_COLUMNS - 4))}</Text>
          )}
        </Box>
        <Box flexShrink={0} width={FIGURE_COLUMNS} justifyContent="flex-end">
          <Text tabular dimColor={isDim}>
            {figure}
          </Text>
        </Box>
      </Box>
    )

    const sections: { key: string; rows: number; rank: number; node: unknown }[] = []

    if (status?.isWarm && lastCache?.at !== undefined) {
      const left = Math.max(0, CACHE_TTL_MS - (now - lastCache.at)) / CACHE_TTL_MS

      sections.push({
        key: 'countdown',
        rows: 1,
        rank: 0,
        node: (
          <Box key="cache-countdown">
            {hasPictures ? (
              picture(
                'cache-countdown-svg',
                countdownSvg(left, COOLING_NOTICE_MS / CACHE_TTL_MS, isCooling ? CACHE_COLORS.cooling : CACHE_COLORS.warm, fullPx, 8),
                `${status.coolsIn ?? 60} minutes of the cache's hour left`,
                fullPx,
                8,
              )
            ) : (
              <Text color={isCooling ? 'warning' : 'success'}>{blockBar(left, Math.max(8, columns - 2))}</Text>
            )}
          </Box>
        ),
      })
    }

    if (cost && status) {
      sections.push(
        status.isWarm
          ? {
              key: 'next',
              rows: 3,
              rank: 1,
              node: (
                <Box key="cache-next" flexDirection="column" marginTop={1}>
                  {costRow('cache-next-warm', 'Send now', cost.warm / Math.max(1, cost.cold), CACHE_COLORS.read, `≈ ${compact(cost.warm)}`, false)}
                  {costRow('cache-next-cold', 'After it cools', 1, CACHE_COLORS.miss, `≈ ${compact(cost.cold)}`, true)}
                </Box>
              ),
            }
          : {
              key: 'next',
              rows: 2,
              rank: 1,
              node: (
                <Box key="cache-next" flexDirection="column" marginTop={1}>
                  <Text key="cache-next-cold" color="warning" wrap="truncate-end">
                    {`Your next message re-sends all ${compact(cost.tokens)} at full price (≈ ${compact(cost.cold)})`}
                  </Text>
                </Box>
              ),
            },
      )
    }

    if (lastCache && inputOf(lastCache) > 0) {
      const parts = [
        { name: 'read', tokens: lastCache.read, color: CACHE_COLORS.read },
        { name: 'written', tokens: lastCache.written, color: CACHE_COLORS.written },
        { name: 'uncached', tokens: lastCache.uncached, color: CACHE_COLORS.uncached },
      ]

      sections.push({
        key: 'last',
        rows: hasPictures ? 3 : 2,
        rank: 3,
        node: (
          <Box key="cache-last" flexDirection="column" marginTop={1}>
            {hasPictures ? picture('cache-last-svg', splitBarSvg(parts, fullPx, 6), parts.map(p => `${p.name} ${compact(p.tokens)}`).join(', '), fullPx, 6) : null}
            <Box flexDirection="row" columnGap={2}>
              <Text dimColor>{`Last reply ${compact(inputOf(lastCache))}`}</Text>
              {parts.map(p => (
                <Text key={`cache-last-${p.name}`} wrap="truncate-end">
                  <Text color={hasPictures ? p.color : p.name === 'read' ? 'success' : p.name === 'written' ? 'warning' : 'subtle'}>●</Text>
                  <Text dimColor>{` ${p.name} ${compact(p.tokens)}`}</Text>
                </Text>
              ))}
            </Box>
          </Box>
        ),
      })
    }

    if (hit !== undefined) {
      const coldText =
        colds.length === 0 ? '' : ` (${colds.slice(-2).map(c => (c === log[0] ? 'start' : c.at === undefined ? '?' : clockOf(c.at))).join(', ')})`

      sections.push({
        key: 'session',
        rows: log.length > 0 ? 3 : 2,
        rank: 2,
        node: (
          <Box key="cache-session" flexDirection="column" marginTop={1}>
            {log.length === 0
              ? null
              : hasPictures
                ? picture('cache-strip-svg', stripSvg(log, fullPx, 14), `Cache use per reply, ${colds.length} cold starts`, fullPx, 14)
                : <Text key="cache-strip-text">{stripText(log, Math.max(8, columns - 2))}</Text>}
            <Box flexDirection="row" columnGap={2} justifyContent="space-between">
              <Text dimColor>
                {`${l.main.requests} ${l.main.requests === 1 ? 'reply' : 'replies'} · hit `}
                <Text tabular>{percent(hit)}</Text>
              </Text>
              <Text dimColor>
                Saved <Text tabular>{`≈ ${compact(savedOf(l.main))}`}</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                Cold starts <Text tabular>{`${colds.length}`}</Text>
                {coldText}
              </Text>
            </Box>
          </Box>
        ),
      })
    }

    // The band holds so many rows: the least telling sections go first, the footer stays.
    const fixed = 1 + 2
    let budget = Math.max(0, rowsLeft - fixed)
    const kept = new Set<string>()

    for (const s of [...sections].sort((a, b) => a.rank - b.rank)) {
      if (s.rows <= budget) {
        kept.add(s.key)
        budget -= s.rows
      }
    }

    rows = [
      heading(
        status === undefined ? 'No request yet' : status.isWarm ? 'Warm' : 'Cold',
        status === undefined ? undefined : !status.isWarm || isCooling ? 'warning' : undefined,
        status === undefined
          ? undefined
          : status.isWarm
            ? status.coolsIn === undefined
              ? undefined
              : `· ${status.coolsIn}m left${cooledAt === undefined ? '' : ` · cools ${clockOf(cooledAt)}`}`
            : cooledAt === undefined
              ? undefined
              : `· cooled ${clockOf(cooledAt)}`,
      ),
      ...sections.filter(s => kept.has(s.key)).map(s => s.node),
      <Box key="cache-footer" flexDirection="row" columnGap={2} justifyContent="space-between" alignItems="center" marginTop={1}>
        <Box flexShrink={1}>
          <Text dimColor size="caption" wrap="truncate-end">
            {status?.isWarm === false ? 'Compact first so the cold start re-sends less' : 'Long break ahead? Compact first'}
          </Text>
        </Box>
        <Box flexDirection="row" columnGap={1} flexShrink={0}>
          <Button key="cache-warn" plain label={`Warn at 5m: ${isWarnOff ? 'off' : 'on'}`} onPress={() => void toggleCoolingWarn($)} />
          <Button key="popover-compact" label="Compact now" onPress={() => void compactNow($)} />
        </Box>
      </Box>,
    ]
  } else {
    const agentCount = Object.keys(l.agents).length
    const spenders = shares(l)
    const total = spenders.reduce((n, s) => n + s.tokens, 0)
    const shown = spenders.slice(0, 5)

    rows = [
      heading(usage.cost ? `≈ $${usage.cost.usd.toFixed(2)} at API prices` : ''),
      pair('session-duration', 'Duration', elapsed(now - usage.startedAt)),
      pair('session-agents', 'Subagents', `${agentCount}`),
      // The one spacing unit, between the figures and who spent them.
      <Box key="session-who" marginTop={1}>
        {caption('session-who-label', 'Who spent the tokens')}
      </Box>,
      total === 0 ? (
        <Text key="session-nothing" dimColor>
          Nothing spent yet.
        </Text>
      ) : (
        <Box key="session-rows" flexDirection="column">
          {shown.map(s => (
            <Box key={s.key} flexDirection="row" columnGap={2} alignItems="center">
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{s.label}</Text>
              </Box>
              <Box flexShrink={0} width={BAR_CELLS}>
                {hasPictures ? (
                  picture(`bar-${s.key}`, barSvg(s.fraction, ACCENT, BAR_PX, 6), percent(s.fraction), BAR_PX, 6)
                ) : (
                  <Text color="claude">{blockBar(s.fraction, BAR_CELLS)}</Text>
                )}
              </Box>
              <Box flexShrink={0} width={FIGURE_CELLS} justifyContent="flex-end">
                <Text dimColor tabular>{`${percent(s.fraction)} · ${compact(s.tokens)}`}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      ),
    ]
  }

  // Rows sit tight; the one spacing unit is a row's margin, where a new group starts.
  return (
    <Box
      key="popover"
      flexDirection="column"
      paddingX={1}
      {...(hasPictures ? { borderStyle: 'round', borderDimColor: true } : {})}
    >
      {rows as never}
    </Box>
  )
}

export const registerPopover = (on: Parameters<Register>[0]) => {
  // Whether `/usage` was ours to declare: a Claude Code with a built-in of that name refuses it.
  let hasUsage = false

  on('session.start', {}, async ($, e, next) => {
    const result = await next(e)

    // The Usage side pane of earlier builds: the popover took its place.
    await $.ui.close({ id: RECEIPT_PANE }).catch(() => undefined)
    await $.command.register({ name: 'receipt', description: 'Show what this session has spent, under the bar' })

    try {
      await $.command.register({ name: 'usage', description: 'Show the session and weekly limits, under the bar' })
      hasUsage = true
    } catch {
      hasUsage = false
    }

    return result
  })

  on('command.run', { command: 'receipt' }, async $ => {
    await openPopover($, 'session')

    return { text: 'Session spend shown under the bar.' }
  })

  // Never in the way of a built-in `/usage`: only the one this plugin declared.
  on('command.run', { command: 'usage' }, async ($, e, next) => {
    if (!hasUsage) return next(e)

    await openPopover($, 'limits')

    return { text: 'Limits shown under the bar.' }
  })

  // A new prompt puts the popover away.
  on('prompt.submit', {}, async ($, e, next) => {
    const result = await next(e)

    await closePopover($).catch(() => undefined)

    return result
  })
}
