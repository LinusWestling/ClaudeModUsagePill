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
  SEGMENT,
  segmentColor,
  terminalBar,
  usedCategories,
  windowBarSvg,
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

  if (always.length > ALWAYS_TOP + 1) {
    const rest = always.slice(ALWAYS_TOP)
    const tokens = rest.reduce((n, r) => n + r.tokens, 0)

    always = [...always.slice(0, ALWAYS_TOP), { name: 'Other', tokens, index: ALWAYS_TOP, share: total > 0 ? tokens / total : 0 }]
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
    const groups = contextGroups(used)
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

    const groupRows = groups.map((g, gi) => (
      <Box key={`context-group-${g.title}`} flexDirection="column" marginTop={gi === 0 ? 1 : 1}>
        <Box flexDirection="row" columnGap={2} justifyContent="space-between" paddingX={1}>
          <Text dimColor size="caption">
            {g.title}
          </Text>
          <Text dimColor size="caption" tabular>{`${compact(g.tokens)} · ${percent(g.share)}`}</Text>
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
              <Text color={dot}>●</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text dimColor={!(isBiggest || isHeavyMcp)} wrap="truncate-end">
                  {r.name}
                </Text>
              </Box>
              <Box flexShrink={0} width={9} justifyContent="flex-end">
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
              <Box flexShrink={0} width={5} justifyContent="flex-end">
                <Text tabular>{compact(r.tokens)}</Text>
              </Box>
              <Box flexShrink={0} width={4} justifyContent="flex-end">
                <Text tabular dimColor>
                  {percent(r.share)}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    ))

    rows = [
      heading(
        shown <= 0 ? 'No reading yet' : compact(shown),
        share === undefined ? undefined : tone(share),
        share === undefined ? undefined : `of ${compact(window)} · ${Math.round(share)}%`,
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
              <Box flexDirection="row" justifyContent="space-between">
                <Text dimColor size="caption" tabular>{`used ${compact(shown)}`}</Text>
                <Text dimColor size="caption" tabular>{`${compact(Math.max(0, window - shown))} free`}</Text>
              </Box>
            </Box>
          ),
      ...groupRows,
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
