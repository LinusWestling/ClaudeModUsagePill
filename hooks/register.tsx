import { atom, memberOf, read, update } from 'claude-code'
import type { Color, EngineInterface, ModelUsage, Register, RenderInput } from 'claude-code'

import type { AgentRun, Cache, LimitSample, LiveBlock, Reading, Task, ToolEntry } from '../types'
import {
  PANE,
  PANE_TITLE,
  compact,
  describeTool,
  elapsed,
  endLabel,
  firstSentence,
  isRunning,
  metaLine,
  progressLine,
  statusOf,
  stepLine,
  summaryLine,
  upsertRun,
} from './agents'
import type { Activity, ActivityCall, ChatEntry, ChatRow, ToolCallEntry } from './chat'
import {
  CATEGORY_LABEL,
  LEGACY_TRANSCRIPT_PANE,
  MAX_ENTRIES,
  activityRuns,
  activitySummary,
  applyChunk,
  categoryOf,
  chatEntries,
  isDue,
  liveToolLabel,
  newTail,
  pendingBlocks,
  reportOf,
  runRows,
} from './chat'
import { STATUS_GLYPH, duration, feedView, finishTool, settleTools, spinnerFrame, spinnerSvg, startTool } from './feed'
import { mascotSvg } from './mascot'
import { forecastOf, loadLimitSamples, localClock, outLabel, recordLimit } from './forecast'
import {
  COOLING_SHOWN_MS,
  bookCoolingNotice,
  cachedTokens,
  coolingText,
  coolingToast,
  headroomAtOf,
  headroomRow,
  headroomViewOf,
  measureHeadroom,
  noteToolResult,
  startTurn,
} from './headroom'
import { MACOS, WINDOWS, buildPill, chipButtons } from './pill'
import { registerNotify } from './notify'
import { registerReceipt } from './receipt'
import { popoverPanel, registerPopover, togglePopover } from './popover'
import type { ChipKind, PillModel } from './pill'
import { NO_TASK, PLAN_TOOL, WRAP_UP_TOOL, applyPlan, finishPlan, viewTask } from './task'
import {
  BAR_COLORS,
  STATUS_MARK,
  axisSvg,
  barColumns,
  byStart,
  rowAlt,
  rowSvg,
  scaleOf,
  statLine,
  textAxis,
  textBar,
} from './timeline'

const reading = atom({ plugin: 'usage-pill', key: 'reading' } as const, null)
const cache = atom({ plugin: 'usage-pill', key: 'cache' } as const, null)
const minute = atom({ plugin: 'usage-pill', key: 'minute' } as const, 0)
const task = atom({ plugin: 'usage-pill', key: 'task' } as const, NO_TASK)
const working = atom({ plugin: 'usage-pill', key: 'isWorking' } as const, false)
// Change the tag when a run's fields change: it declines what an earlier version
// stored, which outlives a reload.
const agents = atom({ plugin: 'usage-pill', key: 'agents' } as const, [], { shape: 'agents-1' })
const agentTick = atom({ plugin: 'usage-pill', key: 'agentTick' } as const, 0)
const transcriptOf = atom({ plugin: 'usage-pill', key: 'transcriptOf' } as const, null)
// One member per agent, so a call of one agent's redraws only what reads that agent.
const toolFeed = atom({ plugin: 'usage-pill', key: 'toolFeed' } as const, [], { shape: 'feed-1' })
const feedOpen = atom({ plugin: 'usage-pill', key: 'feedOpen' } as const, [])
const liveTail = atom({ plugin: 'usage-pill', key: 'liveTail' } as const, null, { shape: 'tail-1' })
const chatRev = atom({ plugin: 'usage-pill', key: 'chatRev' } as const, 0)
const chatOpen = atom({ plugin: 'usage-pill', key: 'chatOpen' } as const, [])
const follow = atom({ plugin: 'usage-pill', key: 'follow' } as const, true)
const paneView = atom({ plugin: 'usage-pill', key: 'paneView' } as const, 'cards')
const celebrateUntil = atom({ plugin: 'usage-pill', key: 'celebrateUntil' } as const, 0)
// Written in forecast.ts and headroom.tsx; read here, where the scan needs them declared.
const limitSamples = atom({ plugin: 'usage-pill', key: 'limitSamples' } as const, [])
const headroom = atom({ plugin: 'usage-pill', key: 'headroom' } as const, null)
/** How long the mascot celebrates a finished task list. */
const CELEBRATE_MS = 8_000


// A cell of the desktop's band, in pixels, measured from a screenshot. A little
// high on purpose: a drawing too wide is scaled down to fit, one too narrow leaves
// a gap.
const CELL_WIDTH = 8.77

// How long the prompt cache holds an entry after its last use. The API doesn't say
// which applies; an hour is what this account's requests have used, and it falls to
// five minutes on extra usage, which this can't see.
const CACHE_TTL = 60 * 60_000

const toCache = (usage: ModelUsage, at?: number): Cache => ({
  read: usage.cache_read_input_tokens,
  written: usage.cache_creation_input_tokens,
  uncached: usage.input_tokens,
  at,
})

const cacheState = (last: Cache, time: number) => {
  // A request that neither read nor wrote it left nothing behind to stay warm.
  if (last.read + last.written === 0) {
    return { isWarm: false, percentLeft: 0 }
  }

  // Seeded from an earlier response with no time on it: all that's known is it was used.
  if (last.at === undefined) {
    return { isWarm: true, percentLeft: 100 }
  }

  const left = CACHE_TTL - (time - last.at)

  // Its last minutes count down, so the person can still catch it warm.
  return left > 0
    ? {
        isWarm: true,
        percentLeft: (left / CACHE_TTL) * 100,
        ...(left < COOLING_SHOWN_MS ? { coolsIn: Math.ceil(left / 60_000) } : {}),
      }
    : { isWarm: false, percentLeft: 0 }
}

const toReading = (e: {
  context: { tokens?: number; window: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}): Reading => ({
  tokens: e.context.tokens,
  window: e.context.window,
  limits: e.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
    kind,
    percentUsed,
    resetsAt,
  })),
})

const timeLeft = (ms: number): string => {
  const minutes = Math.ceil(ms / 60_000)

  if (minutes < 60) return `${minutes}m left`

  const rest = minutes % 60

  return rest === 0
    ? `${Math.floor(minutes / 60)}h left`
    : `${Math.floor(minutes / 60)}h ${rest}m left`
}

const toModel = (
  now: Reading,
  lastCache: Cache | null,
  currentTask: Task,
  time: number,
  isWorking: boolean,
  runs: AgentRun[],
  samples: LimitSample[] = [],
  isCelebrating = false,
): PillModel => {
  const running = runs.filter(isRunning)

  const windowOf = (kind: string) => {
    const limit = now.limits.find(l => l.kind === kind)

    if (!limit) return undefined

    const remaining = limit.resetsAt ? Date.parse(limit.resetsAt) - time : NaN

    // The reading predates the reset, so the window really is empty now.
    if (remaining <= 0) return { percent: 0 }

    // Only the 5-hour window is sampled: its pace says when it runs out.
    const runsOutAt = kind === 'five_hour' ? forecastOf(samples, limit, time)?.runsOutAt : undefined

    return {
      percent: limit.percentUsed,
      left: Number.isNaN(remaining) ? undefined : timeLeft(remaining),
      ...(runsOutAt === undefined ? {} : { out: outLabel(runsOutAt, time) }),
      // Only the 5-hour window shows its reset in the chip, as a bare clock.
      ...(kind === 'five_hour' && !Number.isNaN(Date.parse(limit.resetsAt ?? '')) && localClock(Date.parse(limit.resetsAt!))
        ? { reset: localClock(Date.parse(limit.resetsAt!)) }
        : {}),
    }
  }

  return {
    // Agents left running in the background still need their button.
    task:
      viewTask(currentTask, isWorking) ??
      (running.length > 0 ? { label: 'Agents', count: `${running.length}` } : undefined),
    mascot: { outfit: running[0]?.outfit, running: running.length, celebrate: isCelebrating },
    session: windowOf('five_hour'),
    week: windowOf('seven_day')?.percent,
    context:
      now.tokens === undefined
        ? undefined
        : {
            percent: (now.tokens / now.window) * 100,
            label: `${compact(now.tokens)} / ${compact(now.window)}`,
          },
    cache: lastCache ? cacheState(lastCache, time) : undefined,
    isWorking,
  }
}

const titleOf = (run: AgentRun | undefined) => run?.description || run?.type || 'Subagent'

const chatTitle = (run: AgentRun | undefined) => `Chat · ${titleOf(run)}`

/** The chat's way back to the list, and what a focus request lands on. */
const BACK_KEY = 'chat-back'

/** Opens (or retitles) the Subagents pane, titled for what it shows: the list, or one agent's chat. */
const openPane = async ($: EngineInterface) => {
  const id = await read($, transcriptOf)
  const run = id === null ? undefined : (await read($, agents)).find(r => r.id === id)

  return $.ui.open({ id: PANE, title: id === null ? PANE_TITLE : chatTitle(run) })
}

// A move of the pane's window that could not happen (nothing drawn yet, no
// surface) is no fault of the caller's.
const scrollToEnd = ($: EngineInterface) =>
  void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)

/**
 * A chip button's label is made of these, as it lies over a chip the pill draws
 * beneath it: no-break spaces, which no surface collapses. Their count sets the
 * button's width and its hover highlight's (`chipButtons` in pill.ts).
 */
const BLANK = '\u00a0'

/**
 * What a press on each chip of the band opens: the task chip the Subagents pane,
 * the others their module of the popover under the pill (popover.tsx), or close it.
 */
const CHIP_POPOVER = { session: 'limits', week: 'limits', context: 'context', cache: 'cache' } as const

const pressChip = ($: EngineInterface, kind: ChipKind) =>
  kind === 'task' ? void openPane($) : void togglePopover($, CHIP_POPOVER[kind])

const STATUS_WORD = { running: 'Running', done: 'Finished', stopped: 'Stopped', failed: 'Failed' } as const
const STATUS_COLOR = { running: 'claude', done: 'success', stopped: 'warning', failed: 'error' } as const
const MOOD = { running: 'moving', done: 'done', stopped: 'still', failed: 'failed' } as const
const TOOL_COLOR = { running: 'claude', ok: 'success', error: 'error' } as const

const refresh = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  await update($, reading, () => toReading(usage))
}

const tone = (percent: number): Color | undefined =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined

/** Adds `key` to an open set, or takes it out; the set kept to its latest hundred. */
const toggle = (keys: readonly string[], key: string): string[] =>
  keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key].slice(-100)

type Chat = { entries: ChatEntry[] } | { deny: string }

/** A drawing, on a surface that has them: the caller checks it isn't the terminal. */
const picture = ($: EngineInterface, e: RenderInput, key: string, source: string, alt: string, size: number) => {
  const { Svg } = $.ui.resolve(e as RenderInput & { surface: 'desktop' })

  return <Svg key={key} source={source} alt={alt} width={size} height={size} />
}

// The chat's agent's messages, read once per change rather than per
// redraw: a stream redraws the pane five times a second. Only a cache: a reload
// empties it, and the next draw reads them again.
let shown: { id: string; chat: Chat } | undefined

const loadChat = async ($: EngineInterface, id: string): Promise<Chat> => {
  const found = await $.session.messages({ agentId: id, as: 'api' })
  const chat = Array.isArray(found) ? { entries: chatEntries(found).slice(-400) } : { deny: found.deny }

  shown = { id, chat }

  return chat
}

/** Reads the shown agent's messages again and redraws the pane; other agents cost nothing. */
const refreshChat = async ($: EngineInterface, id: string): Promise<Chat | undefined> => {
  if ((await read($, transcriptOf)) !== id) return undefined

  const chat = await loadChat($, id)
  await update($, chatRev, n => n + 1)

  return chat
}

/** Drops what finished agents left in the per-agent values. */
const forget = ($: EngineInterface, ids: readonly string[]) =>
  Promise.all(
    ids.flatMap(id => [
      update($, memberOf(toolFeed, { requestId: id }), () => []),
      update($, memberOf(liveTail, { requestId: id }), () => null),
    ]),
  )

// Where the list stood when a chat replaced it, and the move that puts it back
// there: `ui.scroll` takes the pane's next scroll of its own as one to this row
// (a chat opening again forgets it). Only for this load: a reload starts the
// list at its top.
let listOffset: number | undefined
let pendingOffset: number | undefined

/**
 * Brings the Subagents pane forward with what it now shows. `focus` is a request:
 * the surface grants it only while the prompt has the keys over an empty
 * composer, so at a press in the pane (which holds the keys then) it is refused
 * and the pane, already shown, simply redraws. Where the pane is a tab behind
 * another, asking for its ring is tried too, though that is refused to a pane
 * that does not hold the keys. Both are newer than some apps: either may throw.
 */
const showPane = async ($: EngineInterface, title: string) => {
  try {
    await $.ui.open({ id: PANE, title, focus: true })
  } catch {
    await $.ui.open({ id: PANE, title })
  }

  try {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)

    if (pane && !pane.isShown) {
      void Promise.resolve($.ui.focus({ requestId: PANE, key: BACK_KEY })).catch(() => undefined)
    }
  } catch {
    // An app without these calls: the open above is all there is.
  }
}

/**
 * Puts the agent's transcript in the app's own transcript view, as the terminal's
 * tasks list does. Where the session draws no such view (the desktop and other apps
 * answer "no main view here"), the Subagents pane itself turns into the agent's
 * live chat, at its latest row, with a way back to the list. `from` is where the
 * list was scrolled, to return there.
 */
const openTranscript = async ($: EngineInterface, run: AgentRun, from = 0) => {
  const view = await $.ui.view({ agentId: run.id })

  if (!view.deny) return

  if ((await read($, transcriptOf)) === null) listOffset = from

  pendingOffset = undefined
  await update($, transcriptOf, () => run.id)
  await update($, follow, () => true)
  await loadChat($, run.id)
  await update($, chatRev, n => n + 1)
  await showPane($, chatTitle(run))
  scrollToEnd($)
}

/** From a chat back to the list it was opened from (Cards or Timeline), where it was scrolled. */
const backToList = async ($: EngineInterface) => {
  const offset = listOffset

  listOffset = undefined
  await update($, transcriptOf, () => null)
  await $.ui.open({ id: PANE, title: PANE_TITLE })

  if (offset) {
    pendingOffset = offset
    await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
  }
}

/** An opened run's mark column (a failure's ✗, a spinner), as wide as the line's ▸ and its space. */
const MARK_COLUMNS = 2
/** An opened run's kind-of-work column, room for `Thought`. */
const CATEGORY_COLUMNS = 8
/** An opened run's time column, room for `12m 30s`. */
const TIME_COLUMNS = 8

/** A row of the chat streaming now, keyed as its block draws, so it groups with the rows before it. */
const liveEntry = (block: LiveBlock, key: string): ChatEntry =>
  block.kind === 'tool'
    ? {
        key,
        at: Number.MAX_SAFE_INTEGER,
        kind: 'tool',
        id: block.id ?? key,
        tool: block.name ?? 'tool',
        label: liveToolLabel(block.name ?? 'tool', block.text),
        input: block.text,
      }
    : { key, at: Number.MAX_SAFE_INTEGER, kind: block.kind, text: block.text }

/**
 * A subagent's conversation as a live chat, drawn in the Subagents pane in place
 * of its list: a way back, a header with its status, its rows (runs of tool calls
 * folded into one), what it streams now, and its report once done.
 */
async function chatView($: EngineInterface, e: RenderInput<'Pane'>, id: string) {
  const runs = await read($, agents)
  const tick = await read($, agentTick)
  // Subscribes the drawing to new messages; they are read where they change.
  await read($, chatRev)
  const opened = await read($, chatOpen)
  const isFollowing = await read($, follow)
  const { Box, Button, Code, Markdown, Progress, Text } = $.ui.resolve(e)
  const run = runs.find(r => r.id === id)
  const status = run?.status ?? 'done'
  const isLive = status === 'running'
  const tail = await read($, memberOf(liveTail, { requestId: id }))
  const feed = await read($, memberOf(toolFeed, { requestId: id }))
  const chat = shown?.id === id ? shown.chat : await loadChat($, id)
  const entries = 'entries' in chat ? chat.entries : []
  const pending = pendingBlocks(entries, tail)
  const now = await $.clock.now()
  const beat = Math.floor((tick || now) / 1000)
  const timing = new Map(feed.map(c => [c.id, c]))
  const report = isLive ? undefined : reportOf(entries)
  // The row that holds it, marked once the agent is done.
  const reportKey = report === undefined ? undefined : entries.findLast(r => r.kind === 'text')?.key
  const hasPictures = e.surface !== 'terminal'
  const isOpen = (key: string) => opened.includes(key)
  const flip = (key: string) => () => void update($, chatOpen, keys => toggle(keys, key))

  if (e.props.placement === 'widget') {
    const latest = feed[feed.length - 1]

    return (
      <Box flexDirection="column">
        <Text weight="semibold" wrap="truncate-end">
          {titleOf(run)}
        </Text>
        <Text color={STATUS_COLOR[status]} wrap="truncate-end">
          {isLive ? `● ${run?.activity ?? latest?.label ?? 'Starting'}` : run ? endLabel(run, now) : STATUS_WORD[status]}
        </Text>
      </Box>
    )
  }

  // What streams now joins the rows the transcript holds, so a call being written
  // folds into the run of work before it.
  const liveKey = (block: LiveBlock) => `live-${tail?.turnId}-${tail?.step}-${block.index}`
  const live = new Map(pending.map(block => [liveKey(block), block]))
  const lastLive = pending.length === 0 ? undefined : liveKey(pending[pending.length - 1]!)
  // Text is the chat; what the agent did between two texts is one line. A run of
  // thoughts alone shows only while it is being thought.
  const isThoughtNow = (row: ChatEntry) => row.kind === 'thinking' && row.key === lastLive && tail?.isDone === false
  const rows = activityRuns([...entries, ...pending.map(block => liveEntry(block, liveKey(block)))], isThoughtNow)
  const hidden = Math.max(0, rows.length - MAX_ENTRIES)
  const visible = rows.slice(-MAX_ENTRIES)

  const back = (
    <Box flexDirection="row">
      <Button key={BACK_KEY} label="← Subagents" onPress={() => void backToList($)} />
    </Box>
  )

  const header = (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} alignItems="center">
        {hasPictures && run ? (
          <Box flexShrink={0}>
            {picture($, e, `chat-mascot-${run.id}`, mascotSvg(MOOD[status], run.outfit, 28, now), `${STATUS_WORD[status]} mascot in a ${run.outfit} outfit`, 28)}
          </Box>
        ) : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text weight="semibold" wrap="truncate-end">
            {titleOf(run)}
          </Text>
          {run ? (
            <Text dimColor size="caption" wrap="truncate-end">
              {metaLine(run)}
            </Text>
          ) : null}
        </Box>
        <Box flexShrink={0} borderStyle="round" borderColor={STATUS_COLOR[status]} paddingX={1}>
          <Text color={STATUS_COLOR[status]} tabular>
            {run ? (isLive ? `● Live · ${elapsed(now - run.startedAt)}` : endLabel(run, now)) : STATUS_WORD[status]}
          </Text>
        </Box>
      </Box>
      {run ? (
        <Text dimColor size="caption" wrap="truncate-end">
          {progressLine(run, now)}
        </Text>
      ) : null}
      {run && run.steps.length > 0 ? (
        <Box marginTop={1}>
          <Progress
            color="claude"
            label={stepLine(run) ?? 'Steps'}
            value={run.steps.filter(s => s.status === 'completed').length}
            max={run.steps.length}
          />
        </Box>
      ) : null}
    </Box>
  )

  /** How long calls took, first start to last end (now, for one still running). */
  const spanOf = (calls: readonly ToolEntry[]): number | undefined =>
    calls.length === 0 ? undefined : Math.max(...calls.map(c => c.endedAt ?? now)) - Math.min(...calls.map(c => c.startedAt))

  /**
   * One row of an opened run, in a grid: a narrow mark column (empty for what went
   * well, a red ✗ for a failure, the spinner while it runs), the kind of work,
   * dim, the label, pressable where it opens, and a dim time from a second up,
   * right-aligned. Opened, its detail sits under the label. No gaps between rows.
   */
  const gridRow = (
    key: string,
    cells: {
      category: string
      label: string
      mark?: 'running' | 'error'
      ms?: number
      onPress?: () => void
      detail?: ReturnType<typeof Box> | null
      isQuiet?: true
    },
  ) => {
    const text = (
      <Text size="caption" wrap="truncate-end" dimColor={cells.isQuiet} italic={cells.isQuiet}>
        {cells.label}
      </Text>
    )

    return (
      <Box key={`row-${key}`} flexDirection="column">
        <Box flexDirection="row">
          <Box width={MARK_COLUMNS} flexShrink={0}>
            {cells.mark === 'running' ? (
              <Text dimColor size="caption">
                {spinnerFrame(beat)}
              </Text>
            ) : cells.mark === 'error' ? (
              <Text color="error" size="caption">
                ✗
              </Text>
            ) : null}
          </Box>
          <Box width={CATEGORY_COLUMNS} flexShrink={0}>
            <Text dimColor size="caption">
              {cells.category}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            {cells.onPress ? (
              <Button key={key} plain onPress={cells.onPress}>
                {text}
              </Button>
            ) : (
              text
            )}
          </Box>
          <Box width={TIME_COLUMNS} flexShrink={0} justifyContent="flex-end">
            {cells.ms !== undefined && cells.ms >= 1000 ? (
              <Text dimColor size="caption" tabular>
                {duration(cells.ms)}
              </Text>
            ) : null}
          </Box>
        </Box>
        {cells.detail ? (
          <Box flexDirection="column" paddingLeft={MARK_COLUMNS + CATEGORY_COLUMNS}>
            {cells.detail}
          </Box>
        ) : null}
      </Box>
    )
  }

  /** How a call stands: being written or run, back with an error, or done. */
  const stateOf = (row: ToolCallEntry): ActivityCall['state'] => {
    if (live.has(row.key)) return 'running'

    const call = timing.get(row.id)

    return row.isError || call?.status === 'error'
      ? 'error'
      : row.result !== undefined || call?.status === 'ok'
        ? 'ok'
        : isLive
          ? 'running'
          : 'ok'
  }

  /** A call in an opened run; pressed, what it was given and what came back. */
  const callRow = (row: ToolCallEntry) => {
    const call = timing.get(row.id)
    const state = stateOf(row)
    const isWritten = live.has(row.key)

    return gridRow(row.key, {
      category: CATEGORY_LABEL[categoryOf(row.tool)],
      label: row.label,
      mark: state === 'ok' ? undefined : state,
      ms: call ? spanOf([call]) : undefined,
      onPress: isWritten ? undefined : flip(row.key),
      detail:
        !isWritten && isOpen(row.key) ? (
          <Box flexDirection="column">
            <Code language="json" source={row.input} />
            {row.result === undefined ? null : (
              <Text dimColor size="caption" color={row.isError ? 'error' : undefined}>
                {row.isError ? 'Error' : 'Result'}
              </Text>
            )}
            {row.result === undefined ? null : row.result ? (
              <Code source={row.result} />
            ) : (
              <Text dimColor size="caption">
                (no output)
              </Text>
            )}
          </Box>
        ) : null,
    })
  }

  /** Thoughts in a row between calls, as one dim row; opened, what they thought. */
  const thoughtsRow = (key: string, texts: readonly string[]) => {
    const text = texts.filter(Boolean).join('\n\n')
    const count = texts.length === 1 ? '1 thought' : `${texts.length} thoughts`

    return gridRow(key, {
      category: CATEGORY_LABEL.thought,
      label: text ? `${isOpen(key) ? '▾' : '▸'} ${count}` : count,
      isQuiet: true,
      onPress: text ? flip(key) : undefined,
      detail: text && isOpen(key) ? <Markdown key={`md-${key}`} dimColor text={text} /> : null,
    })
  }

  const entry = (row: ChatEntry, i: number) => {
    switch (row.kind) {
      case 'prompt': {
        const isLong = row.text.length > 480

        return (
          <Box key={row.key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text dimColor size="caption">
              {i === 0 && hidden === 0 ? 'Prompt' : 'Message'}
            </Text>
            <Text wrap="wrap">{isLong && !isOpen(row.key) ? `${row.text.slice(0, 479).trimEnd()}…` : row.text}</Text>
            {isLong ? (
              <Button key={`more-${row.key}`} plain dimColor label={isOpen(row.key) ? 'Show less' : 'Show all'} onPress={flip(row.key)} />
            ) : null}
          </Box>
        )
      }
      case 'text':
        return row.key === reportKey ? (
          <Box key={row.key} flexDirection="column" borderStyle="round" borderColor={STATUS_COLOR[status]} paddingX={1}>
            <Text color={STATUS_COLOR[status]} weight="semibold">
              {status === 'done' ? '✓ Final report' : 'Last words'}
            </Text>
            <Markdown key={`md-${row.key}`} text={row.text} />
          </Box>
        ) : (
          <Markdown key={`md-${row.key}`} text={row.text} />
        )
      default:
        // Calls and thoughts only show inside a run's line.
        return null
    }
  }

  // Words streaming now, under what the transcript holds: a caret while they come.
  const liveText = (block: LiveBlock, key: string) => (
    <Markdown key={key} text={`${block.text}${key === lastLive && tail?.isDone === false ? ' ▍' : ''}`} />
  )

  /**
   * What the agent did between two texts, as one dim line: counted by kind of
   * work, or the one call it was (`Edited headroom.tsx`), or while live, what it
   * is doing now. Opened, a row per call and per stretch of thoughts.
   */
  const activity = (a: Activity) => {
    const summary = activitySummary(a.tools.map(t => ({ tool: t.tool, label: t.label, state: stateOf(t), path: t.path })))
    const last = a.items[a.items.length - 1]
    const isThinkingNow = last !== undefined && isThoughtNow(last)
    const isNow = summary.running !== undefined || isThinkingNow
    const text = summary.running === undefined && isNow ? 'Thinking…' : summary.text
    const runningCall = a.tools.findLast(t => stateOf(t) === 'running')
    const timed = (summary.running === undefined ? a.tools : runningCall ? [runningCall] : []).flatMap(t => timing.get(t.id) ?? [])
    const ms = spanOf(timed)
    const time = ms !== undefined && ms >= 100 && !(isNow && summary.running === undefined) ? ` · ${duration(ms)}` : ''
    const isLineOpen = isOpen(a.key)

    return (
      <Box key={`row-${a.key}`} flexDirection="column">
        <Button key={a.key} plain onPress={flip(a.key)}>
          <Text dimColor size="caption" wrap="truncate-end">{`${isNow ? spinnerFrame(beat) : isLineOpen ? '▾' : '▸'} ${text}${time}`}</Text>
          {summary.failed > 0 ? <Text color="error" size="caption">{` · ${summary.failed} failed`}</Text> : null}
        </Button>
        {isLineOpen ? (
          <Box flexDirection="column" paddingLeft={MARK_COLUMNS}>
            {runRows(a.items).map(row => (row.kind === 'tool' ? callRow(row.entry) : thoughtsRow(row.key, row.texts)))}
          </Box>
        ) : null}
      </Box>
    )
  }

  const rowView = (row: ChatRow, i: number) =>
    row.kind === 'activity' ? activity(row) : live.has(row.key) ? liveText(live.get(row.key)!, row.key) : entry(row, i)

  const isWaiting = isLive && tail !== null && !tail.isDone && pending.length === 0

  // Text is the chat: a run's line sits right under the words before it, and a
  // blank row comes before the next words.
  const spaceAbove = (i: number) => (i === 0 ? 0 : visible[i]!.kind === 'activity' && visible[i - 1]!.kind === 'text' ? 0 : 1)

  return (
    <Box flexDirection="column" rowGap={1}>
      {back}
      {header}
      {'deny' in chat ? <Text color="warning">{chat.deny}</Text> : null}
      {hidden > 0 ? <Text dimColor size="caption">{`${hidden} earlier rows not shown`}</Text> : null}
      {rows.length === 0 && 'entries' in chat ? <Text dimColor>Nothing in its transcript yet.</Text> : null}
      <Box flexDirection="column">
        {visible.map((row, i) => (
          <Box key={`at-${row.key}`} flexDirection="column" marginTop={spaceAbove(i)}>
            {rowView(row, i)}
          </Box>
        ))}
        {isWaiting ? (
          <Text dimColor size="caption">{`${spinnerFrame(beat)} Thinking…`}</Text>
        ) : null}
      </Box>
      {report ? (
        <Box flexDirection="row" columnGap={1} justifyContent="flex-end">
          <Button
            key="copy-report"
            label="Copy report"
            onPress={async press => {
              const copied = await $.ui.copy({ text: report, surface: press.surface })

              $.ui.toast(copied.isCopied ? 'Report copied' : 'This app can’t copy from a mod yet')
            }}
          />
        </Box>
      ) : null}
      {isFollowing ? null : (
        // Pinned to the top of the window wherever it is scrolled: the pane redraws on each move.
        <Box position="absolute" top={e.props.scroll.offset} right={0}>
          <Button
            key="jump"
            variant="primary"
            label="Jump to latest ↓"
            onPress={async () => {
              await update($, follow, () => true)
              scrollToEnd($)
            }}
          />
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  let isTicking = false
  // The context percentage from which the band shows its headroom row.
  const headroomAt = headroomAtOf(options)
  // The Agent call says the effort asked for; its spawn doesn't.
  const askedEffort = new Map<string, string>()
  // Also runs on a reload, so the pill shows without waiting for a response.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Earlier versions of this mod opened a side panel and a chat pane of their
    // own; leave none behind. The chat now shows in the Subagents pane.
    await $.ui.close({ id: 'usage-pill' })
    await $.ui.close({ id: LEGACY_TRANSCRIPT_PANE })
    await $.command.register({
      name: 'subagents',
      description: 'Show the subagents of this session in a sidebar',
    })

    const usage = await $.session.usage({ breakdown: 'summary' })
    await update($, reading, () => toReading(usage))
    const last = usage.context.breakdown?.apiUsage

    // A reload keeps what is known; only a new session starts from the response.
    if (last && (await read($, cache)) === null) {
      await update($, cache, () => toCache(last))
    }

    // The 5-hour window spans sessions: take up the pace the store kept of it.
    await loadLimitSamples($, usage.rateLimits)

    // Keeps the reset of the limits honest while nothing else redraws the pill.
    if (!isTicking) {
      isTicking = true
      $.clock.every(60_000, async () => {
        const time = await $.clock.now()
        await update($, minute, () => Math.floor(time / 60_000))

        const lastCache = await read($, cache)

        if (coolingToast(lastCache, await read($, working), time, CACHE_TTL) && lastCache?.at !== undefined) {
          $.ui.toast(coolingText(Math.ceil((CACHE_TTL - (time - lastCache.at)) / 60_000), cachedTokens(lastCache)))
        }
      })
      // The agents' clocks tick by the second, but only while one runs and the
      // pane that shows them is on screen: nothing else reads the tick.
      $.clock.every(1_000, async () => {
        if (!(await read($, agents)).some(isRunning)) return

        const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown)

        if (shown) {
          const time = await $.clock.now()
          await update($, agentTick, () => time)
        }
      })
    }

    return result
  })

  on('command.run', { command: 'subagents' }, async $ => {
    await openPane($)

    return { text: 'Subagents sidebar opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId

    if (id) {
      const now = await $.clock.now()
      const effort = askedEffort.get(e.tool_use_id)
      const wasIdle = !(await read($, agents)).some(run => isRunning(run) && run.id !== id)

      askedEffort.delete(e.tool_use_id)
      await update($, agents, runs =>
        upsertRun(
          runs,
          id,
          {
            description: e.description,
            type: e.subagentType,
            model: result.model,
            ...(effort ? { effort } : {}),
          },
          now,
        ),
      )

      if (wasIdle) {
        void openPane($)
      }
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, reading, () => toReading(e))
    await recordLimit($, e.rateLimits, await $.clock.now())

    return next(e)
  })

  // A prompt typed while idle starts a task; one typed mid-turn joins the running one.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      // The agent whose chat is on show stays, finished or not, so its chat keeps its header.
      const viewed = await read($, transcriptOf)
      const stays = (r: AgentRun) => isRunning(r) || r.id === viewed
      const gone = (await read($, agents)).filter(r => !stays(r)).map(r => r.id)

      await update($, task, () => NO_TASK)
      await update($, agents, runs => runs.filter(stays))
      await forget($, gone)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => true)
      // What the context held before the turn, for what the turn added.
      startTurn((await read($, reading))?.tokens)
    } else {
      const id = e.agentId
      const now = await $.clock.now()

      await update($, agents, runs => upsertRun(runs, id, { status: 'running', endedAt: undefined }, now))
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => false)

      const now = await $.clock.now()
      const steps = (await read($, task)).steps

      await measureHeadroom($, await read($, reading), headroomAt, now)

      // A list of steps all done: the mascot celebrates for a few seconds.
      if (e.reason === 'answer' && steps.length > 0 && steps.every(s => s.status === 'completed')) {
        await update($, celebrateUntil, () => now + CELEBRATE_MS)
        $.clock.after(CELEBRATE_MS, async () => {
          // Its end redraws the pill, unless a newer celebration holds it.
          if ((await read($, celebrateUntil)) <= (await $.clock.now())) {
            await update($, celebrateUntil, () => 0)
          }
        })
      }
    } else {
      const id = e.agentId
      const now = await $.clock.now()
      const status = statusOf(e.reason)

      await update($, agents, runs =>
        upsertRun(
          runs,
          id,
          {
            status,
            activity: undefined,
            endedAt: now,
            // Kept to its opening sentence: the whole report is in the transcript.
            ...(e.answer ? { answer: firstSentence(e.answer) } : {}),
          },
          now,
        ),
      )
      await update($, memberOf(toolFeed, { requestId: id }), feed => settleTools(feed, now, status !== 'done'))
      await refreshChat($, id)
      await update($, memberOf(liveTail, { requestId: id }), () => null)
    }

    return next(e)
  })

  // Claude's own task list is the only real measure of a task's progress there is.
  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Parameters<typeof applyPlan>[1]

    if (e.tool === 'Agent' && e.effort) {
      askedEffort.set(e.tool_use_id, e.effort)
    }

    if (e.agentId === undefined) {
      await update($, task, current => ({
        tools: e.tool === PLAN_TOOL ? current.tools : current.tools + 1,
        steps:
          e.tool === PLAN_TOOL
            ? applyPlan(current.steps, args)
            : e.tool === WRAP_UP_TOOL
              ? finishPlan(current.steps)
              : current.steps,
      }))

      const result = await next(e)

      // The turn's largest result, for the headroom row; it never fails the call.
      try {
        noteToolResult(e.tool, e as unknown as Record<string, unknown>, result.text)
      } catch {
        // Nothing to keep.
      }

      return result
    }

    const id = e.agentId
    const now = await $.clock.now()

    if (e.tool === PLAN_TOOL) {
      await update($, agents, runs =>
        upsertRun(runs, id, { steps: applyPlan(runs.find(r => r.id === id)?.steps ?? [], args) }, now),
      )

      return next(e)
    }

    const label = describeTool(e.tool, e as unknown as Record<string, unknown>)
    const call: ToolEntry = { id: e.tool_use_id, tool: e.tool, label, startedAt: now, status: 'running' }

    await update($, agents, runs =>
      upsertRun(runs, id, { tools: (runs.find(r => r.id === id)?.tools ?? 0) + 1, activity: label }, now),
    )
    await update($, memberOf(toolFeed, { requestId: id }), feed => startTool(feed, call))

    // Past `next`, a failure must not run the tool again: the catch replays what it settled to.
    const result = await next(e)
    const end = await $.clock.now()

    await update($, memberOf(toolFeed, { requestId: id }), feed =>
      finishTool(feed, call.id, end, result.isError === true || result.deny !== undefined),
    )
    // Its result is in the transcript now.
    await refreshChat($, id)

    return result
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId

    // Each main-loop request, so the pill moves during a long turn. Subagents
    // have their own caches and would make the figure jump.
    if (loop === undefined) {
      const result = yield* next(e)

      if (result.usage) {
        const at = await $.clock.now()
        const used = toCache(result.usage, at)

        await update($, cache, () => used)
        await refresh($)

        // Booked for five minutes before it goes cold, for someone who has left.
        if (used.read + used.written > 0) {
          await bookCoolingNotice($, cachedTokens(used), CACHE_TTL)
        }
      }

      return result
    }

    const now = await $.clock.now()

    // Asked of this very request, so these outrank what the spawn said.
    await update($, agents, runs =>
      upsertRun(
        runs,
        loop,
        {
          model: e.model,
          ...(e.effort === undefined ? {} : { effort: e.effort }),
          activity: 'Thinking',
        },
        now,
      ),
    )

    // The response is mirrored into the agent's live tail as it streams, every
    // chunk passed on untouched. Writes are throttled and chained, so the stream
    // never waits on one and they land in order.
    const tailRef = memberOf(liveTail, { requestId: loop })
    let tail = newTail(e.turnId, e.index, e.messageCount)
    let flushedAt = Date.now()
    let isWriting = false
    let writes: Promise<unknown> = Promise.resolve()
    const flush = () => {
      const snapshot = tail
      writes = writes.then(() => update($, tailRef, () => snapshot)).catch(() => undefined)
    }
    const stream = next(e)

    // Read below only when the stream ran to its end; an early close rejects it.
    stream.result.catch(() => undefined)
    flush()

    try {
      for await (const chunk of stream) {
        yield chunk

        const after = applyChunk(tail, chunk)

        if (after === tail) continue

        tail = after

        // Its first words: the card says it is writing, once per step.
        if (!isWriting && chunk.kind === 'text') {
          isWriting = true
          writes = writes
            .then(() => update($, agents, runs => upsertRun(runs, loop, { activity: 'Writing' }, now)))
            .catch(() => undefined)
        }

        const at = Date.now()

        if (isDue(flushedAt, at)) {
          flushedAt = at
          flush()
        }
      }
    } finally {
      tail = { ...tail, isDone: true }
      flush()
      await writes
    }

    const result = await stream.result
    const usage = result.usage

    if (usage) {
      const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

      await update($, agents, runs => upsertRun(runs, loop, { tokens }, now))
    }

    // Once the transcript holds the whole response, the tail has done its job.
    const chat = await refreshChat($, loop)

    if (chat && 'entries' in chat && pendingBlocks(chat.entries, tail).length === 0) {
      await update($, tailRef, () => null)
    }

    return result
  })

  // A person's scroll up in the chat stops it following the agent; back at the end, it follows again.
  on('ui.scroll', async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)

    // Back from a chat: the list's own scroll to its start lands where it was left.
    if (e.origin?.kind === 'plugin' && pendingOffset !== undefined) {
      const offset = pendingOffset

      pendingOffset = undefined

      return next({ ...e, offset })
    }

    const result = await next(e)

    if (e.origin?.kind !== 'person' || result.deny || (await read($, transcriptOf)) === null) return result

    const isAtEnd = e.offset >= e.contentRows - e.bodyRows - 1

    if (isAtEnd !== (await read($, follow))) {
      await update($, follow, () => isAtEnd)

      if (isAtEnd) scrollToEnd($)
    }

    return result
  }).catch(($, e, next) => next(e))

  // Closed by the person, the pane shows no agent: it opens again on the list.
  // Nothing else leaves a chat: not a reload (whose close of the old chat pane,
  // open or not, may still be raised here), an unload, or a close of the mod's own.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)

    // Only the Subagents pane itself closing leaves the chat. The old chat pane is
    // closed at every start and reload, and must not take the chat with it.
    if (e.id === PANE && e.origin?.kind !== 'unload') {
      await update($, transcriptOf, () => null)
    }

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)
    const lastCache = await read($, cache)
    const currentTask = await read($, task)
    const runs = await read($, agents)
    await read($, minute)
    // A value from before 0.6.0 is unset: none of these may be there yet.
    const samples = (await read($, limitSamples)) ?? []
    const measured = await read($, headroom)
    const celebrating = (await read($, celebrateUntil)) ?? 0

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    const time = await $.clock.now()
    const model = toModel(now, lastCache, currentTask, time, e.props.isWorking, runs, samples, celebrating > time)
    // Past the threshold, a second row under the pill; under it, the band as it was.
    const room = headroomViewOf(now, measured, headroomAt)

    if (e.surface === 'desktop') {
      const { Box, Button, Svg, Text } = $.ui.resolve(e)
      // Two cells wider and taller than the row's body, to reach over the app's own
      // padding, which is one cell on each side: the border lands on the rectangle.
      // The body flips between neighbouring widths while the row doesn't: use the even one.
      const columns = Math.ceil(e.props.bodyColumns / 2) * 2
      const fit = (await $.env.get('OS')) === 'Windows_NT' ? WINDOWS : MACOS
      // With the cell given, the chips' dividers land on cell edges, where the buttons can start.
      const pill = buildPill(model, (columns + 2) * CELL_WIDTH, fit, CELL_WIDTH, time)
      const row = (
        <Box height={1}>
          <Box position="absolute" top={-1} left={-1} right={-1}>
            <Svg key="pill" source={pill.source} alt={pill.alt} />
          </Box>
          {/* One blank button over each chip the pill drew (pill.ts places them); the
              task chip's keeps its old key. Each draws the native hover highlight. */}
          {chipButtons(pill.chips, CELL_WIDTH).map(b => (
            <Box key={`hit-${b.kind}`} position="absolute" top={0} left={b.left}>
              <Button
                key={b.kind === 'task' ? 'agents' : `chip-${b.kind}`}
                plain
                label={BLANK.repeat(b.spaces)}
                onPress={() => pressChip($, b.kind)}
              />
            </Box>
          ))}
        </Box>
      )

      // A chip's module, as wide as the band, its insides less a border and padding.
      const panel = await popoverPanel($, e, (e.props.bodyColumns - 4) * CELL_WIDTH, e.props.bodyColumns - 4)
      // The pill reaches a row below its own: what goes under it starts under that.
      return room || panel ? (
        <Box flexDirection="column">
          {row}
          <Box marginTop={1} flexDirection="column">
            {panel}
            {room ? headroomRow($, { Box, Button, Svg, Text }, room) : null}
          </Box>
        </Box>
      ) : (
        row
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const steps = model.task?.steps
    const stepBar = steps
      ?.map(s => (s.status === 'completed' ? '▰' : '▱'))
      .join('')
    const sessionTone = model.session?.out ? (tone(model.session.percent) ?? 'warning') : tone(model.session?.percent ?? 0)
    const cools = model.cache?.isWarm ? model.cache.coolsIn : undefined

    const line = (
      <Box flexDirection="row" columnGap={2}>
        {model.task ? (
          <Box columnGap={1}>
            <Text>{model.task.label}</Text>
            {stepBar ? <Text color="claude">{stepBar}</Text> : null}
            <Text bold>{model.task.count}</Text>
            {runs.length > 0 ? (
              <Button key="agents" plain label="Agents" onPress={() => void openPane($)} />
            ) : null}
          </Box>
        ) : null}
        {/* Each figure is a plain Button around its own coloured text: a press opens its module. */}
        {model.session ? (
          <Button key="chip-session" plain onPress={() => pressChip($, 'session')}>
            <Text color={sessionTone} dimColor={sessionTone === undefined}>
              {`${Math.round(model.session.percent)}% session${model.session.out ? ` · ${model.session.out}` : ''}`}
            </Text>
          </Button>
        ) : null}
        {model.week === undefined ? null : (
          <Button key="chip-week" plain onPress={() => pressChip($, 'week')}>
            <Text color={tone(model.week)} dimColor={tone(model.week) === undefined}>
              {`${Math.round(model.week)}% week`}
            </Text>
          </Button>
        )}
        {model.context ? (
          <Button key="chip-context" plain onPress={() => pressChip($, 'context')}>
            <Text
              color={tone(model.context.percent)}
              dimColor={tone(model.context.percent) === undefined}
            >
              {model.context.label}
            </Text>
          </Button>
        ) : null}
        {model.cache ? (
          <Button key="chip-cache" plain onPress={() => pressChip($, 'cache')}>
            <Text
              color={model.cache.isWarm && cools === undefined ? undefined : 'warning'}
              dimColor={model.cache.isWarm && cools === undefined}
            >
              {cools !== undefined ? `cache cools ${cools}m` : `cache ${model.cache.isWarm ? 'warm' : 'cold'}`}
            </Text>
          </Button>
        ) : null}
      </Box>
    )

    const panel = await popoverPanel($, e, 0, Math.max(20, e.props.bodyColumns - 2))

    return room || panel ? (
      <Box flexDirection="column">
        {line}
        {panel}
        {room ? headroomRow($, { Box, Button, Text }, room) : null}
      </Box>
    ) : (
      line
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const inPane = await read($, transcriptOf)

    // A third view besides Cards and Timeline: one agent's chat, in place of the list.
    if (inPane !== null) return chatView($, e, inPane)

    const runs = await read($, agents)
    const tick = await read($, agentTick)
    const openFeeds = await read($, feedOpen)
    const now = await $.clock.now()
    const running = runs.filter(isRunning)
    const mode = await read($, paneView)
    // Cards read the calls of running agents; the timeline ticks every run's.
    const feeds = new Map(
      await Promise.all(
        (mode === 'timeline' ? runs : running).map(
          async r => [r.id, await read($, memberOf(toolFeed, { requestId: r.id }))] as const,
        ),
      ),
    )
    // The latest to finish first.
    const finished = runs.filter(r => !isRunning(r)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
    const summary = summaryLine(runs, now)
    const viewing = e.props.view?.agentId
    const { Box, Button, Text } = $.ui.resolve(e)
    const hasPictures = e.surface !== 'terminal'
    // A beat a second, for what pulses where nothing animates by itself.
    const beat = Math.floor(tick / 1000)

    const mascot = (run: AgentRun, size: number) =>
      hasPictures ? (
        <Box flexShrink={0}>
          {picture($, e, `mascot-${run.id}`, mascotSvg(MOOD[run.status], run.outfit, size, now), `${STATUS_WORD[run.status]} mascot in a ${run.outfit} outfit`, size)}
        </Box>
      ) : null

    const spinner = (id: string) =>
      hasPictures ? (
        <Box flexShrink={0} width={2} alignItems="center">
          {picture($, e, `spin-${id}`, spinnerSvg(12, undefined, now), 'Running', 12)}
        </Box>
      ) : (
        <Text color="claude">{spinnerFrame(beat)}</Text>
      )

    // Opens a chat in this same pane, remembering where the list was scrolled.
    const openChat = (run: AgentRun) => () => void openTranscript($, run, e.props.scroll.offset)

    // A real button, not a link: watching a running agent is the card's one action.
    const chatButton = (run: AgentRun) => {
      if (viewing === run.id) {
        return <Button key={`back-${run.id}`} plain label="← Back to main" onPress={() => void $.ui.view({})} />
      }

      return isRunning(run) ? (
        <Button key={`open-${run.id}`} onPress={openChat(run)}>
          <Text color="claude" dimColor={beat % 2 === 1}>
            ●
          </Text>{' '}
          Watch live
        </Button>
      ) : (
        <Button key={`open-${run.id}`} label="Open chat" onPress={openChat(run)} />
      )
    }

    const toolRow = (call: ToolEntry, age: number) => (
      <Box key={`call-${call.id}`} flexDirection="row" columnGap={1}>
        {call.status === 'running' ? (
          spinner(call.id)
        ) : (
          <Box flexShrink={0} width={2}>
            <Text color={TOOL_COLOR[call.status]}>{STATUS_GLYPH[call.status]}</Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text
            color={call.status === 'error' ? 'error' : undefined}
            // The two latest read at full strength; what came before fades back.
            dimColor={call.status !== 'running' && age > 1}
            wrap="truncate-end"
          >
            {call.label}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor={call.status !== 'running'} color={call.status === 'running' ? 'claude' : undefined} tabular>
            {duration((call.endedAt ?? now) - call.startedAt)}
          </Text>
        </Box>
      </Box>
    )

    // What it does between calls, where no call runs: the step's own words.
    const pauseRow = (run: AgentRun, feed: readonly ToolEntry[]) => {
      if (feed.some(c => c.status === 'running')) return null

      const doing = run.activity === 'Writing' ? 'Writing' : run.activity === 'Thinking' || feed.length === 0 ? 'Thinking' : undefined

      return doing ? (
        <Box key={`pause-${run.id}`} flexDirection="row" columnGap={1}>
          {spinner(`pause-${run.id}`)}
          <Text dimColor italic>{`${feed.length === 0 && !run.activity ? 'Starting' : doing}…`}</Text>
        </Box>
      ) : null
    }

    // Running: the big mascot, where it is in its own steps, and its calls as they
    // come and go, in a card of its own.
    const live = (run: AgentRun) => {
      const stepBar = run.steps
        .map(s => (s.status === 'completed' ? '▰' : s.status === 'in_progress' ? '▣' : '▱'))
        .join('')
      const step = stepLine(run)
      const feed = feeds.get(run.id) ?? []
      const isOpen = openFeeds.includes(run.id)
      const view = feedView(feed, isOpen)

      return (
        <Box
          key={`run-${run.id}`}
          flexDirection="column"
          rowGap={1}
          borderStyle="round"
          borderColor={viewing === run.id ? 'suggestion' : 'claude'}
          paddingX={1}
          overflow="hidden"
        >
          <Box flexDirection="row" columnGap={1}>
            {mascot(run, 40)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Box flexDirection="row" columnGap={1} justifyContent="space-between">
                <Box flexShrink={1} minWidth={0}>
                  <Text weight="semibold" wrap="truncate-end">
                    {titleOf(run)}
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  <Text color="claude" tabular>
                    {elapsed(now - run.startedAt)}
                  </Text>
                </Box>
              </Box>
              <Text dimColor size="caption" wrap="truncate-end">
                {metaLine(run)}
              </Text>
              {step ? (
                <Box flexDirection="row" columnGap={1}>
                  {stepBar ? <Text color="claude">{stepBar}</Text> : null}
                  <Box flexShrink={1} minWidth={0}>
                    <Text size="caption" wrap="truncate-end">
                      {step}
                    </Text>
                  </Box>
                </Box>
              ) : null}
            </Box>
          </Box>
          <Box flexDirection="column">
            {view.hidden > 0 || isOpen ? (
              <Button
                key={`feed-${run.id}`}
                plain
                dimColor
                label={isOpen ? 'Show fewer' : `+${view.hidden} earlier`}
                onPress={() => void update($, feedOpen, ids => toggle(ids, run.id))}
              />
            ) : null}
            {view.rows.map((call, i) => toolRow(call, view.rows.length - 1 - i))}
            {pauseRow(run, feed)}
          </Box>
          <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor size="caption" wrap="truncate-end">
                {progressLine(run, now)}
              </Text>
            </Box>
            <Box flexShrink={0}>{chatButton(run)}</Box>
          </Box>
        </Box>
      )
    }

    // Finished: a small mascot, how it ended, what it reported, and what it took.
    const done = (run: AgentRun) => (
      <Box key={`done-${run.id}`} flexDirection="row" columnGap={1}>
        {mascot(run, 24)}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Box flexDirection="row" columnGap={1} justifyContent="space-between">
            <Box flexShrink={1} minWidth={0}>
              <Text weight="semibold" wrap="truncate-end">
                {titleOf(run)}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={STATUS_COLOR[run.status]}>{endLabel(run, now)}</Text>
            </Box>
          </Box>
          {run.answer ? (
            <Text wrap="wrap">{run.answer}</Text>
          ) : run.status === 'done' ? null : (
            <Text color={STATUS_COLOR[run.status]} wrap="truncate-end">
              {run.status === 'stopped' ? 'Stopped before it reported back' : 'Ended before it reported back'}
            </Text>
          )}
          <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor size="caption" wrap="truncate-end">
                {metaLine(run)} · {progressLine(run, now)}
              </Text>
            </Box>
            <Box flexShrink={0}>{chatButton(run)}</Box>
          </Box>
        </Box>
      </Box>
    )

    const clear = (
      <Button
        key="clear"
        plain
        dimColor
        label="Clear"
        onPress={async () => {
          await update($, agents, list => list.filter(isRunning))
          await forget($, finished.map(r => r.id))
        }}
      />
    )

    // Cards or Timeline: two quiet text tabs, the one on show at full strength.
    const tabs = (
      <Box flexDirection="row" columnGap={1}>
        {(['cards', 'timeline'] as const).map(which => (
          <Button
            key={`view-${which}`}
            plain
            dimColor={mode !== which}
            label={which === 'cards' ? 'Cards' : 'Timeline'}
            onPress={() => void update($, paneView, () => which)}
          />
        ))}
      </Box>
    )

    // Every run on one time axis: its name and how it ended, and a thin bar under the name.
    const timeline = () => {
      const listed = byStart(runs)
      const scale = scaleOf(listed, now)
      const columns = barColumns(e.props.bodyColumns)

      const drawing = (key: string, source: string, alt: string, size?: { width: number; height: number }) => {
        const { Svg } = $.ui.resolve(e as RenderInput & { surface: 'desktop' })

        return <Svg key={key} source={source} alt={alt} {...size} />
      }

      // Where the mascot stands in a row, kept empty above it so the axis lines up with the bars.
      const indent = (
        <Box flexShrink={0}>{drawing('tl-gap', '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"/>', '', { width: 24, height: 12 })}</Box>
      )

      const row = (run: AgentRun) => {
        const feed = feeds.get(run.id) ?? []
        const bar = textBar(run, scale, columns, now)
        const mark = STATUS_MARK[run.status]

        return (
          <Box key={`tl-row-${run.id}`} flexDirection="row" columnGap={1}>
            {mascot(run, 24)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
                <Box flexShrink={1} minWidth={0}>
                  <Button key={`tl-${run.id}`} plain label={titleOf(run)} onPress={openChat(run)} />
                </Box>
                <Box flexShrink={0} flexDirection="row" columnGap={1}>
                  <Text color={mark.color}>{mark.glyph}</Text>
                  <Text dimColor tabular>
                    {statLine(run, now)}
                  </Text>
                </Box>
              </Box>
              {hasPictures ? (
                drawing(`tl-bar-${run.id}`, rowSvg(run, feed, scale, now), rowAlt(run, feed, now))
              ) : (
                <Box flexDirection="row">
                  <Text>{bar.before}</Text>
                  <Text color={BAR_COLORS[run.status]}>{bar.fill}</Text>
                </Box>
              )}
            </Box>
          </Box>
        )
      }

      const axis = axisSvg(scale)

      return listed.length === 0 ? null : (
        <Box flexDirection="column" rowGap={1}>
          {hasPictures ? (
            <Box flexDirection="row" columnGap={1}>
              {indent}
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                {drawing('tl-axis', axis.source, axis.alt)}
              </Box>
            </Box>
          ) : (
            <Text dimColor>{textAxis(scale, columns)}</Text>
          )}
          {listed.map(row)}
          <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor size="caption" wrap="wrap">
                Press a name to open its chat.
              </Text>
            </Box>
            {finished.length > 0 ? <Box flexShrink={0}>{clear}</Box> : null}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1} justifyContent="space-between" alignItems="center">
          <Box flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">
              {summary.counts}
            </Text>
          </Box>
          <Box flexShrink={0}>{tabs}</Box>
        </Box>
        {summary.totals ? <Text dimColor>{summary.totals}</Text> : null}
        {mode === 'timeline' ? timeline() : null}
        {mode === 'timeline' ? null : running.map(live)}
        {mode !== 'timeline' && finished.length > 0 ? (
          <Box flexDirection="row" columnGap={1} justifyContent="space-between">
            <Text dimColor>{`Finished · ${finished.length}`}</Text>
            {clear}
          </Box>
        ) : null}
        {mode === 'timeline' ? null : finished.map(done)}
      </Box>
    )
  })

  registerReceipt(on, options)
  registerPopover(on)
  registerNotify(on, options)
}
