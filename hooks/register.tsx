import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, ModelUsage, Register } from 'claude-code'

import type { AgentRun, Cache, Reading, Task } from '../types'
import {
  PANE,
  PANE_TITLE,
  compact,
  describeTool,
  effortLabel,
  isRunning,
  progressLine,
  shortModel,
  statusOf,
  upsertRun,
} from './agents'
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

/**
 * Blank, as the button lies over the mascot the pill draws beneath it. Its width sets
 * the hover highlight's: measured from a screenshot, 12 of these made it 75px wide.
 */
const MASCOT_LABEL = '\u00A0'.repeat(4)

const STATUS_WORD = { running: 'Running', done: 'Finished', stopped: 'Stopped', failed: 'Failed' } as const
const STATUS_COLOR = { running: 'claude', done: 'success', stopped: 'warning', failed: 'error' } as const
const MOOD = { running: 'moving', done: 'done', stopped: 'still', failed: 'failed' } as const

const refresh = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  await update($, reading, () => toReading(usage))
}

const tone = (percent: number): Color | undefined =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined

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
      // The agents' clocks move faster, but only while one runs.
      $.clock.every(5_000, async () => {
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
      await update($, task, () => NO_TASK)
      await update($, agents, runs => runs.filter(isRunning))
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

      await update($, agents, runs =>
        upsertRun(runs, id, { status: statusOf(e.reason), activity: undefined, endedAt: now }, now),
      )
    }

    return next(e)
  })

  // Claude's own task list is the only real measure of a task's progress there is.
  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Parameters<typeof applyPlan>[1]

    if (e.tool === 'Agent' && e.effort) {
      askedEffort.set(e.tool_use_id, e.effort)
    }

    if (e.agentId !== undefined) {
      const id = e.agentId
      const now = await $.clock.now()
      const fields = e as unknown as Record<string, unknown>

      await update($, agents, runs => {
        const run = runs.find(r => r.id === id)

        return upsertRun(
          runs,
          id,
          e.tool === PLAN_TOOL
            ? { steps: applyPlan(run?.steps ?? [], args) }
            : { tools: (run?.tools ?? 0) + 1, activity: describeTool(e.tool, fields) },
          now,
        )
      })
    } else {
      await update($, task, current => ({
        tools: e.tool === PLAN_TOOL ? current.tools : current.tools + 1,
        steps:
          e.tool === PLAN_TOOL
            ? applyPlan(current.steps, args)
            : e.tool === WRAP_UP_TOOL
              ? finishPlan(current.steps)
              : current.steps,
      }))
    }

    return next(e)
  })

  // Each main-loop request, so the pill moves during a long turn. Subagents
  // have their own caches and would make the figure jump.
  on('turn.step', async function* ($, e, next) {
    const loop = e.agentId

    if (loop !== undefined) {
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
    }

    const result = yield* next(e)
    const usage = result.usage

    if (loop !== undefined && usage) {
      const now = await $.clock.now()
      const tokens =
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens

      await update($, agents, runs => upsertRun(runs, loop, { tokens }, now))
    }

    if (e.agentId === undefined && usage) {
      const at = await $.clock.now()
      await update($, cache, () => toCache(usage, at))
      await refresh($)
    }

    return result
  })

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
    await read($, agentTick)
    const now = await $.clock.now()
    const running = runs.filter(isRunning)
    // Those still working first; among the rest, the latest to finish.
    const order = [
      ...running,
      ...runs.filter(r => !isRunning(r)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0)),
    ]
    const heading =
      running.length > 0
        ? `${running.length} running, ${runs.length - running.length} finished`
        : runs.length > 0
          ? `All ${runs.length} finished`
          : 'No subagents yet'

    const details = (run: AgentRun) => {
      const { Box, Text } = $.ui.resolve(e)
      const stepBar = run.steps.map(s => (s.status === 'completed' ? '▰' : '▱')).join('')

      return (
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">
            {run.description || run.type || 'Subagent'}
          </Text>
          <Text dimColor wrap="truncate-end">
            {shortModel(run.model)} · {effortLabel(run.effort)}
            {run.type ? ` · ${run.type}` : ''}
          </Text>
          <Text wrap="truncate-end">
            <Text color={STATUS_COLOR[run.status]}>{STATUS_WORD[run.status]}</Text>
            {run.activity ? `: ${run.activity}` : ''}
          </Text>
          {stepBar ? <Text color="claude">{stepBar}</Text> : null}
          <Text dimColor wrap="truncate-end">
            {progressLine(run, now)}
          </Text>
        </Box>
      )
    }

    if (e.surface === 'terminal') {
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column" rowGap={1}>
          <Text dimColor>{heading}</Text>
          {order.map(run => details(run))}
        </Box>
      )
    }

    const { Box, Svg, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column" rowGap={1}>
        <Text dimColor>{heading}</Text>
        {order.map(run => (
          <Box flexDirection="row" columnGap={1}>
            <Box flexShrink={0}>
              <Svg
                source={mascotSvg(MOOD[run.status], run.outfit, 48)}
                alt={`${STATUS_WORD[run.status]} mascot in a ${run.outfit} outfit`}
                width={48}
                height={48}
              />
            </Box>
            {details(run)}
          </Box>
        ))}
      </Box>
    )
  })
}
