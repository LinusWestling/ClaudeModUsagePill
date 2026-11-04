import { atom, read, update } from 'claude-code'
import type { Color, EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Cache, Reading, Task } from '../types'
import { buildPill } from './pill'
import type { PillModel } from './pill'
import { NO_TASK, PLAN_TOOL, WRAP_UP_TOOL, applyPlan, finishPlan, viewTask } from './task'

const reading = atom({ plugin: 'usage-pill', key: 'reading' } as const, null)
const cache = atom({ plugin: 'usage-pill', key: 'cache' } as const, null)
const minute = atom({ plugin: 'usage-pill', key: 'minute' } as const, 0)
const task = atom({ plugin: 'usage-pill', key: 'task' } as const, NO_TASK)
const working = atom({ plugin: 'usage-pill', key: 'isWorking' } as const, false)


// A cell of the desktop's band, in pixels, measured from a screenshot. A little
// high on purpose: a drawing too wide is scaled down to fit, one too narrow leaves
// a gap.
const CELL_WIDTH = 8.77

// How long the prompt cache holds an entry after its last use. The API doesn't say
// which applies; an hour is what this account's requests have used, and it falls to
// five minutes on extra usage, which this can't see.
const CACHE_TTL = 60 * 60_000

const compact = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`

  return `${n}`
}

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
): PillModel => {
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
    task: viewTask(currentTask, isWorking),
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

const refresh = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  await update($, reading, () => toReading(usage))
}

const tone = (percent: number): Color | undefined =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : undefined

export const register: Register = on => {
  let isTicking = false

  // Also runs on a reload, so the pill shows without waiting for a response.
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // An earlier version of this mod opened a side panel; leave none behind.
    await $.ui.close({ id: 'usage-pill' })

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
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => true)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => false)
    }

    return next(e)
  })

  // Claude's own task list is the only real measure of a task's progress there is.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      const args = e as unknown as Parameters<typeof applyPlan>[1]

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
    const result = yield* next(e)
    const usage = result.usage

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
    )

    if (e.surface === 'desktop') {
      const { Box, Svg } = $.ui.resolve(e)
      // Two cells wider and taller than the row's body, to reach over the app's own
      // padding, which is one cell on each side: the border lands on the rectangle.
      // The body flips between neighbouring widths while the row doesn't: use the even one.
      const columns = Math.ceil(e.props.bodyColumns / 2) * 2
      const pill = buildPill(model, (columns + 2) * CELL_WIDTH)

      return (
        <Box height={1}>
          <Box position="absolute" top={-1} left={-1} right={-1}>
            <Svg source={pill.source} alt={pill.alt} />
          </Box>
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
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
}
