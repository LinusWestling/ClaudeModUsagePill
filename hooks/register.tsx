import { atom, memberOf, read, update } from 'claude-code'
import type { Color, EngineInterface, ModelUsage, Register, RenderInput } from 'claude-code'

import type { AgentRun, Cache, LiveBlock, Reading, Task, ToolEntry } from '../types'
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
import type { ChatEntry } from './chat'
import {
  MAX_ENTRIES,
  TRANSCRIPT_PANE,
  applyChunk,
  chatEntries,
  isDue,
  liveToolLabel,
  newTail,
  pendingBlocks,
  reportOf,
} from './chat'
import { STATUS_GLYPH, duration, feedView, finishTool, settleTools, spinnerFrame, spinnerSvg, startTool } from './feed'
import { mascotSvg } from './mascot'
import { MACOS, WINDOWS, buildPill } from './pill'
import type { PillModel } from './pill'
import { NO_TASK, PLAN_TOOL, WRAP_UP_TOOL, applyPlan, finishPlan, viewTask } from './task'

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

  return left > 0
    ? { isWarm: true, percentLeft: (left / CACHE_TTL) * 100 }
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
): PillModel => {
  const running = runs.filter(isRunning)

  const windowOf = (kind: string) => {
    const limit = now.limits.find(l => l.kind === kind)

    if (!limit) return undefined

    const remaining = limit.resetsAt ? Date.parse(limit.resetsAt) - time : NaN

    // The reading predates the reset, so the window really is empty now.
    return remaining <= 0
      ? { percent: 0 }
      : {
          percent: limit.percentUsed,
          left: Number.isNaN(remaining) ? undefined : timeLeft(remaining),
        }
  }

  return {
    // Agents left running in the background still need their button.
    task:
      viewTask(currentTask, isWorking) ??
      (running.length > 0 ? { label: 'Agents', count: `${running.length}` } : undefined),
    mascot: { outfit: running[0]?.outfit, running: running.length },
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

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: PANE_TITLE })

const titleOf = (run: AgentRun | undefined) => run?.description || run?.type || 'Subagent'

// A move of the pane's window that could not happen (nothing drawn yet, no
// surface) is no fault of the caller's.
const scrollToEnd = ($: EngineInterface) =>
  void $.ui.scroll({ in: TRANSCRIPT_PANE, to: 'end' }).catch(() => undefined)

/**
 * Blank, as the button lies over the mascot the pill draws beneath it. Its width sets
 * the hover highlight's: measured from a screenshot, 12 of these made it 75px wide.
 */
const MASCOT_LABEL = ' '.repeat(4)

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
const picture = ($: EngineInterface, e: RenderInput, source: string, alt: string, size: number) => {
  const { Svg } = $.ui.resolve(e as RenderInput & { surface: 'desktop' })

  return <Svg source={source} alt={alt} width={size} height={size} />
}

// The transcript pane's agent's messages, read once per change rather than per
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

/**
 * Puts the agent's transcript in the app's own transcript view, as the terminal's
 * tasks list does. Where the session draws no such view (the desktop and other apps
 * answer "no main view here"), it opens as a live chat in a pane of the mod's own,
 * which another agent's button switches over.
 */
const openTranscript = async ($: EngineInterface, run: AgentRun) => {
  const view = await $.ui.view({ agentId: run.id })

  if (!view.deny) return

  await update($, transcriptOf, () => run.id)
  await update($, follow, () => true)
  await loadChat($, run.id)
  await update($, chatRev, n => n + 1)
  await $.ui.open({ id: TRANSCRIPT_PANE, title: `Chat · ${titleOf(run)}` })
  scrollToEnd($)
}

export const register: Register = on => {
  let isTicking = false
  // The Agent call says the effort asked for; its spawn doesn't.
  const askedEffort = new Map<string, string>()
  // Also runs on a reload, so the pill shows without waiting for a response.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // An earlier version of this mod opened a side panel; leave none behind.
    await $.ui.close({ id: 'usage-pill' })
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

    // Keeps the reset of the limits honest while nothing else redraws the pill.
    if (!isTicking) {
      isTicking = true
      $.clock.every(60_000, async () => {
        const time = await $.clock.now()
        await update($, minute, () => Math.floor(time / 60_000))
      })
      // The agents' clocks tick by the second, but only while one runs.
      $.clock.every(1_000, async () => {
        if ((await read($, agents)).some(isRunning)) {
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

    return next(e)
  })

  // A prompt typed while idle starts a task; one typed mid-turn joins the running one.
  on('prompt.submit', async ($, e, next) => {
    if (e.turnId === undefined) {
      const gone = (await read($, agents)).filter(r => !isRunning(r)).map(r => r.id)

      await update($, task, () => NO_TASK)
      await update($, agents, runs => runs.filter(isRunning))
      await forget($, gone)
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => true)
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

      return next(e)
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
        await update($, cache, () => toCache(result.usage!, at))
        await refresh($)
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
    const result = await next(e)

    if (e.requestId !== TRANSCRIPT_PANE || e.origin.kind !== 'person' || result.deny) return result

    const isAtEnd = e.offset >= e.contentRows - e.bodyRows - 1

    if (isAtEnd !== (await read($, follow))) {
      await update($, follow, () => isAtEnd)

      if (isAtEnd) scrollToEnd($)
    }

    return result
  }).catch(($, e, next) => next(e))

  // Closed, the pane shows no agent: the cards offer to open it again.
  on('ui.close', async ($, e, next) => {
    const result = await next(e)

    if (e.id === TRANSCRIPT_PANE) {
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

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    const model = toModel(
      now,
      lastCache,
      currentTask,
      await $.clock.now(),
      e.props.isWorking,
      runs,
    )

    if (e.surface === 'desktop') {
      const { Box, Button, Svg } = $.ui.resolve(e)
      // Two cells wider and taller than the row's body, to reach over the app's own
      // padding, which is one cell on each side: the border lands on the rectangle.
      // The body flips between neighbouring widths while the row doesn't: use the even one.
      const columns = Math.ceil(e.props.bodyColumns / 2) * 2
      const fit = (await $.env.get('OS')) === 'Windows_NT' ? WINDOWS : MACOS
      const pill = buildPill(model, (columns + 2) * CELL_WIDTH, fit)

      return (
        <Box height={1}>
          <Box position="absolute" top={-1} left={-1} right={-1}>
            <Svg source={pill.source} alt={pill.alt} />
          </Box>
          {model.task ? (
            <Box position="absolute" top={0} left={0}>
              <Button key="agents" plain label={MASCOT_LABEL} onPress={() => void openPane($)} />
            </Box>
          ) : null}
        </Box>
      )
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const steps = model.task?.steps
    const stepBar = steps
      ?.map(s => (s.status === 'completed' ? '▰' : '▱'))
      .join('')

    return (
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
        {model.session ? (
          <Text
            color={tone(model.session.percent)}
            dimColor={tone(model.session.percent) === undefined}
          >
            {Math.round(model.session.percent)}% session
          </Text>
        ) : null}
        {model.week === undefined ? null : (
          <Text color={tone(model.week)} dimColor={tone(model.week) === undefined}>
            {Math.round(model.week)}% week
          </Text>
        )}
        {model.context ? (
          <Text
            color={tone(model.context.percent)}
            dimColor={tone(model.context.percent) === undefined}
          >
            {model.context.label}
          </Text>
        ) : null}
        {model.cache ? (
          <Text color={model.cache.isWarm ? undefined : 'warning'} dimColor={model.cache.isWarm}>
            cache {model.cache.isWarm ? 'warm' : 'cold'}
          </Text>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const runs = await read($, agents)
    const tick = await read($, agentTick)
    const inPane = await read($, transcriptOf)
    const openFeeds = await read($, feedOpen)
    const now = await $.clock.now()
    const running = runs.filter(isRunning)
    const feeds = new Map(
      await Promise.all(running.map(async r => [r.id, await read($, memberOf(toolFeed, { requestId: r.id }))] as const)),
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
          {picture($, e, mascotSvg(MOOD[run.status], run.outfit, size), `${STATUS_WORD[run.status]} mascot in a ${run.outfit} outfit`, size)}
        </Box>
      ) : null

    const spinner = () =>
      hasPictures ? (
        <Box flexShrink={0} width={2} alignItems="center">
          {picture($, e, spinnerSvg(12), 'Running', 12)}
        </Box>
      ) : (
        <Text color="claude">{spinnerFrame(beat)}</Text>
      )

    // A real button, not a link: watching a running agent is the card's one action.
    const chatButton = (run: AgentRun) => {
      if (viewing === run.id) {
        return <Button key={`back-${run.id}`} plain label="← Back to main" onPress={() => void $.ui.view({})} />
      }

      if (inPane === run.id) {
        return (
          <Button key={`viewing-${run.id}`} onPress={() => void openTranscript($, run)}>
            <Text color="success">✓</Text> Viewing
          </Button>
        )
      }

      return isRunning(run) ? (
        <Button key={`open-${run.id}`} onPress={() => void openTranscript($, run)}>
          <Text color="claude" dimColor={beat % 2 === 1}>
            ●
          </Text>{' '}
          Watch live
        </Button>
      ) : (
        <Button key={`open-${run.id}`} label="Open chat" onPress={() => void openTranscript($, run)} />
      )
    }

    const toolRow = (call: ToolEntry, age: number) => (
      <Box key={`call-${call.id}`} flexDirection="row" columnGap={1}>
        {call.status === 'running' ? (
          spinner()
        ) : (
          <Box flexShrink={0} width={2}>
            <Text color={TOOL_COLOR[call.status]}>{STATUS_GLYPH[call.status]}</Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1}>
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
          {spinner()}
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
          borderColor={viewing === run.id || inPane === run.id ? 'suggestion' : 'claude'}
          paddingX={1}
        >
          <Box flexDirection="row" columnGap={1}>
            {mascot(run, 40)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" columnGap={1} justifyContent="space-between">
                <Box flexShrink={1}>
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
                  <Box flexShrink={1}>
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
            <Box flexShrink={1}>
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
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box flexDirection="row" columnGap={1} justifyContent="space-between">
            <Box flexShrink={1}>
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
            <Box flexShrink={1}>
              <Text dimColor size="caption" wrap="truncate-end">
                {metaLine(run)} · {progressLine(run, now)}
              </Text>
            </Box>
            <Box flexShrink={0}>{chatButton(run)}</Box>
          </Box>
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1} justifyContent="space-between">
          <Text bold>{summary.counts}</Text>
          {summary.totals ? <Text dimColor>{summary.totals}</Text> : null}
        </Box>
        {running.map(live)}
        {finished.length > 0 ? (
          <Box flexDirection="row" columnGap={1} justifyContent="space-between">
            <Text dimColor>{`Finished · ${finished.length}`}</Text>
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
          </Box>
        ) : null}
        {finished.map(done)}
      </Box>
    )
  })

  // A subagent's conversation as a live chat, where the main view can't switch to it.
  on('ui.render', { component: 'Pane', requestId: TRANSCRIPT_PANE }, async ($, e) => {
    const id = await read($, transcriptOf)
    const runs = await read($, agents)
    const tick = await read($, agentTick)
    // Subscribes the drawing to new messages; they are read where they change.
    await read($, chatRev)
    const opened = await read($, chatOpen)
    const isFollowing = await read($, follow)
    const { Box, Button, Code, Markdown, Progress, Text } = $.ui.resolve(e)
    const close = (
      <Button
        key="close-transcript"
        plain
        dimColor
        label="Close"
        onPress={async () => {
          await update($, transcriptOf, () => null)
          await $.ui.close({ id: TRANSCRIPT_PANE })
        }}
      />
    )

    if (!id) {
      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>No agent picked. Open one from the Subagents panel.</Text>
          {close}
        </Box>
      )
    }

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
    const hidden = Math.max(0, entries.length - MAX_ENTRIES)
    const visible = entries.slice(-MAX_ENTRIES)
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

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {hasPictures && run ? (
            <Box flexShrink={0}>
              {picture($, e, mascotSvg(MOOD[status], run.outfit, 28), `${STATUS_WORD[status]} mascot in a ${run.outfit} outfit`, 28)}
            </Box>
          ) : null}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
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

    const toolRow = (key: string, glyph: string, color: Color, label: string, time: string | undefined, isPressable: boolean) => (
      <Button key={key} plain onPress={isPressable ? flip(key) : () => undefined}>
        <Text color={color}>{glyph}</Text> {label}
        {time ? <Text dimColor>{`  ${time}`}</Text> : null}
        {isPressable ? <Text dimColor>{isOpen(key) ? '  ▾' : '  ▸'}</Text> : null}
      </Button>
    )

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
        case 'thinking':
          return row.text ? (
            <Box key={row.key} flexDirection="column">
              {toolRow(row.key, '∴', 'subtle', 'Thought', undefined, true)}
              {isOpen(row.key) ? (
                <Box paddingLeft={2}>
                  <Markdown key={`md-${row.key}`} dimColor text={row.text} />
                </Box>
              ) : null}
            </Box>
          ) : (
            <Text key={row.key} dimColor>
              ∴ Thought
            </Text>
          )
        case 'tool': {
          const call = timing.get(row.id)
          const state = row.isError || call?.status === 'error' ? 'error' : row.result !== undefined || call?.status === 'ok' ? 'ok' : isLive ? 'running' : 'ok'
          const time = call ? duration((call.endedAt ?? now) - call.startedAt) : undefined

          return (
            <Box key={row.key} flexDirection="column">
              {toolRow(row.key, state === 'running' ? spinnerFrame(beat) : STATUS_GLYPH[state], TOOL_COLOR[state], row.label, time, true)}
              {isOpen(row.key) ? (
                <Box flexDirection="column" paddingLeft={2} rowGap={1}>
                  <Box flexDirection="column">
                    <Text dimColor size="caption">
                      {row.tool}
                    </Text>
                    <Code language="json" source={row.input} />
                  </Box>
                  {row.result === undefined ? null : (
                    <Box flexDirection="column">
                      <Text dimColor size="caption" color={row.isError ? 'error' : undefined}>
                        {row.isError ? 'Error' : 'Result'}
                      </Text>
                      {row.result ? <Code source={row.result} /> : <Text dimColor>(no output)</Text>}
                    </Box>
                  )}
                </Box>
              ) : null}
            </Box>
          )
        }
      }
    }

    // The step streaming now, under what the transcript holds: a caret while it writes.
    const liveBlock = (block: LiveBlock, isLast: boolean) => {
      const key = `live-${tail?.turnId}-${tail?.step}-${block.index}`
      const isStreaming = isLast && tail?.isDone === false

      if (block.kind === 'text') {
        return <Markdown key={key} text={`${block.text}${isStreaming ? ' ▍' : ''}`} />
      }

      if (block.kind === 'thinking') {
        const dots = isStreaming ? '.'.repeat((Math.floor(now / 400) % 3) + 1) : ''

        return (
          <Box key={key} flexDirection="column">
            {toolRow(key, '∴', isStreaming ? 'claude' : 'subtle', isStreaming ? `Thinking${dots}` : 'Thought', undefined, block.text !== '')}
            {isOpen(key) ? (
              <Box paddingLeft={2}>
                <Markdown key={`md-${key}`} dimColor text={block.text} />
              </Box>
            ) : null}
          </Box>
        )
      }

      return (
        <Box key={key}>
          {toolRow(key, spinnerFrame(beat), 'claude', liveToolLabel(block.name ?? 'tool', block.text), undefined, false)}
        </Box>
      )
    }

    const isWaiting = isLive && tail !== null && !tail.isDone && pending.length === 0

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        {'deny' in chat ? <Text color="warning">{chat.deny}</Text> : null}
        {hidden > 0 ? <Text dimColor size="caption">{`${hidden} earlier rows not shown`}</Text> : null}
        {visible.length === 0 && pending.length === 0 && 'entries' in chat ? (
          <Text dimColor>Nothing in its transcript yet.</Text>
        ) : null}
        {visible.map(entry)}
        {pending.map((block, i) => liveBlock(block, i === pending.length - 1))}
        {isWaiting ? (
          <Text color="claude">{`${spinnerFrame(beat)} Thinking${'.'.repeat((Math.floor(now / 400) % 3) + 1)}`}</Text>
        ) : null}
        <Box flexDirection="row" columnGap={1} justifyContent="flex-end">
          {report ? (
            <Button
              key="copy-report"
              label="Copy report"
              onPress={async press => {
                const copied = await $.ui.copy({ text: report, surface: press.surface })

                $.ui.toast(copied.isCopied ? 'Report copied' : 'This app can’t copy from a mod yet')
              }}
            />
          ) : null}
          {close}
        </Box>
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
  })
}
