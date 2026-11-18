import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, Register, RenderInput } from 'claude-code'

import type { Ledger, Popover } from '../types'
import { compact, elapsed } from './agents'
import { forecastChartSvg, forecastOf, localClock, outLabel, span } from './forecast'
import {
  cacheStatusLabel,
  cacheStatusOf,
  compactNow,
  deltaLabel,
  nextMessageLabel,
  segmentColor,
  stackedBarSvg,
  terminalBar,
  usedCategories,
} from './headroom'
import { NO_LEDGER, RECEIPT_PANE, barSvg, blockBar, cacheHit, shares, usedSince } from './receipt'

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

/** Shows `kind`, in place of whatever was open. */
export async function openPopover($: EngineInterface, kind: Popover) {
  await update($, popover, () => kind)
}

/** Shows `kind`, or closes it when it is the one open: a chip's press. */
export async function togglePopover($: EngineInterface, kind: Popover) {
  await update($, popover, open => (open === kind ? null : kind))
}

export async function closePopover($: EngineInterface) {
  if ((await read($, popover)) !== null) await update($, popover, () => null)
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

/**
 * The open module, drawn for the band under the pill, or null while none is
 * open. `width` is the room inside the panel, in the drawing's pixels (charts
 * and bars are drawn to it), and `columns` the same in cells (the terminal's
 * text versions).
 */
export async function popoverPanel($: EngineInterface, e: RenderInput, width: number, columns: number) {
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

  /** The module's first row: its name, its figure, and the ×. */
  const heading = (value: string, color?: Color) => (
    <Box key="popover-head" flexDirection="row" columnGap={2} justifyContent="space-between" alignItems="center">
      <Box flexShrink={1}>
        <Text weight="semibold" wrap="truncate-end">
          {TITLE[kind]}
        </Text>
      </Box>
      <Box flexDirection="row" columnGap={2} flexShrink={0} alignItems="center">
        <Text tabular color={color}>
          {value}
        </Text>
        <Button key="popover-close" plain label="×" onPress={() => void closePopover($)} />
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
    const sessionValue = five
      ? [
          `${Math.round(five.percentUsed)}%`,
          pace?.runsOutAt === undefined ? undefined : outLabel(pace.runsOutAt, now),
          Number.isNaN(resetsAt) ? undefined : `resets ${resetLabel(resetsAt, now)}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'No reading yet'

    rows = [
      heading(sessionValue, five ? (pace?.runsOutAt !== undefined ? (tone(five.percentUsed) ?? 'warning') : tone(five.percentUsed)) : undefined),
      hasPictures && five?.resetsAt && samples.length > 0
        ? picture(
            'limits-chart',
            forecastChartSvg(samples, pace, five.resetsAt, width, 60, false),
            `Session limit ${Math.round(five.percentUsed)}% used${pace?.runsOutAt ? `, ${outLabel(pace.runsOutAt, now)}` : ''}`,
            Math.round(width),
            60,
          )
        : null,
      week
        ? pair(
            'limits-week',
            'Week',
            `${Math.round(week.percentUsed)}%${Number.isNaN(weekResets) ? '' : ` · resets ${resetLabel(weekResets, now)}`}`,
            tone(week.percentUsed),
          )
        : null,
      used === undefined ? null : pair('limits-used', 'This session used', `+${used}%`, used >= 70 ? 'warning' : undefined),
    ]
  } else if (kind === 'context') {
    const { tokens, window } = usage.context
    const share = tokens === undefined || window <= 0 ? undefined : (tokens / window) * 100
    const legend = legendOf(
      usedCategories(
        (usage.context.breakdown?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })),
      ),
    )
    const colorOf = (c: (typeof legend)[number], i: number): Color =>
      c.isOther ? (hasPictures ? '#9A9AA3' : 'subtle') : segmentColor(c, i, hasPictures)
    const described = legend.map(c => `${c.name} ${compact(c.tokens)}`).join(', ')
    // Two to a row, each a dot, a name and its figure on the right.
    const grid: unknown[] = []

    for (let i = 0; i < legend.length; i += 2) {
      grid.push(
        <Box key={`legend-row-${i}`} flexDirection="row">
          {legend.slice(i, i + 2).map((c, j) => (
            <Box key={`legend-${i + j}`} flexDirection="row" columnGap={1} width="50%" paddingRight={j === 0 ? 2 : 0}>
              <Text color={colorOf(c, i + j)}>●</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor wrap="truncate-end">
                  {c.name}
                </Text>
              </Box>
              <Text tabular dimColor>
                {compact(c.tokens)}
              </Text>
            </Box>
          ))}
        </Box>,
      )
    }

    const turn = [
      measured?.lastTurnDelta === undefined ? undefined : deltaLabel(measured.lastTurnDelta),
      measured?.biggest ? `largest: ${measured.biggest.label} ~${compact(measured.biggest.tokens)}` : undefined,
    ].filter(Boolean)

    rows = [
      heading(
        tokens === undefined || share === undefined ? 'No reading yet' : `${compact(tokens)} of ${compact(window)} · ${Math.round(share)}%`,
        share === undefined ? undefined : tone(share),
      ),
      legend.length === 0
        ? null
        : hasPictures
          ? picture(
              'context-bar',
              stackedBarSvg(legend, Math.round(width), 6),
              `Context by category: ${described}`,
              Math.round(width),
              6,
            )
          : (
              <Box key="context-bar">
                {terminalBar(legend, Math.max(8, columns)).map(s =>
                  s.cells > 0 ? (
                    <Text key={`context-bar-${s.index}`} color={colorOf(legend[s.index]!, s.index)}>
                      {'█'.repeat(s.cells)}
                    </Text>
                  ) : null,
                )}
              </Box>
            ),
      legend.length === 0 ? null : (
        <Box key="context-legend" flexDirection="column">
          {grid as never}
        </Box>
      ),
      turn.length === 0 ? null : (
        <Text key="context-turn" dimColor wrap="truncate-end">
          {turn.join(' · ')}
        </Text>
      ),
      <Box key="context-compact" flexDirection="row" marginTop={1}>
        <Button key="popover-compact" label="Compact now" onPress={() => void compactNow($)} />
      </Box>,
    ]
  } else if (kind === 'cache') {
    const status = lastCache ? cacheStatusOf(lastCache, now) : undefined
    const hit = cacheHit(l.main)

    rows = [
      heading(
        status === undefined ? 'No request yet' : cacheStatusLabel(status),
        status === undefined ? undefined : !status.isWarm || (status.coolsIn !== undefined && status.coolsIn <= 10) ? 'warning' : undefined,
      ),
      lastCache && status ? (
        <Text key="cache-next" wrap="truncate-end">
          {nextMessageLabel(lastCache, status.isWarm)}
        </Text>
      ) : null,
      hit === undefined ? null : (
        <Text key="cache-hit" wrap="truncate-end">
          {`Cache hit ${percent(hit)} this session`}
        </Text>
      ),
      <Text key="cache-cold" dimColor size="caption" wrap="truncate-end">
        Cold: the next message re-sends everything at full price
      </Text>,
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
