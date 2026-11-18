import { expect, test } from 'claude-code/testing'

import { doneBody } from '../hooks/notify'
import { NO_SPEND, addUsage, barSvg, blockBar, cacheHit, shares, usedSince } from '../hooks/receipt'

const START = Date.parse('2026-11-04T10:00:00Z')

const usageOf = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
})

const BAND = {
  plugin: 'usage-pill',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const CLOSED: string[] = []

const standIn = (on: any, clock: { now: number }, rate: { five?: number } = { five: 10 }, cost: number | null = 1.234, opened: string[] = []) => {
  on('clock.now', () => ({ value: clock.now }))
  on('env.get', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('ui.close', (_: unknown, e: { id: string }) => {
    CLOSED.push(e.id)

    return { value: undefined }
  })
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('command.register', () => ({ value: { command: 'receipt' } }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: { window: 200_000 },
      rateLimits: rate.five === undefined ? [] : [{ kind: 'five_hour', percentUsed: rate.five }],
      ...(cost === null ? {} : { cost: { usd: cost } }),
    },
  }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: STEP_USAGE.current }
  } as any)
}

const STEP_USAGE: { current: unknown } = { current: null }

const SPAWN = {
  tool_use_id: 'call-1',
  prompt: 'Look around',
  description: 'Map the repo',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  background: false,
  fork: false,
} as const

const step = async ($: any, agentId: string | undefined, usage: ReturnType<typeof usageOf>, model = 'claude-opus-5-5') => {
  STEP_USAGE.current = { ...usage, model }
  const stream = $.turn.step({ turnId: 't1', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  let read = await stream.next()

  while (!read.done) read = await stream.next()
}

test('cache hit is the share of what the main thread read that the cache served', () => {
  expect(cacheHit(NO_SPEND)).toBe(undefined)
  expect(cacheHit(addUsage(NO_SPEND, usageOf(100, 800, 100, 50)))).toBe(0.8)
  expect(cacheHit(addUsage(addUsage(NO_SPEND, usageOf(100, 0, 100, 5)), usageOf(0, 200, 0, 5)))).toBe(0.5)
})

test('spend adds up request by request', () => {
  const s = addUsage(addUsage(NO_SPEND, usageOf(1, 2, 3, 4)), usageOf(10, 20, 30, 40))

  expect(s).toEqual({ input: 11, cacheRead: 22, cacheWrite: 33, output: 44, requests: 2 })
})

test('shares go by agent up to six, and by model past that', () => {
  const agent = (label: string, model: string, n: number) => ({ ...addUsage(NO_SPEND, usageOf(n, 0, 0, 0)), label, model })
  const few = shares({
    main: addUsage(NO_SPEND, usageOf(500, 0, 0, 0)),
    agents: { a: agent('Map', 'claude-haiku-5-5', 300), b: agent('Test', 'claude-haiku-5-5', 200) },
  })

  expect(few.map(s => s.label)).toEqual(['Main thread', 'Map', 'Test'])
  expect(few[0]!.fraction).toBe(0.5)

  const agents = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`a${i}`, agent(`Agent ${i}`, i < 5 ? 'claude-haiku-5-5' : 'claude-opus-5-5', 100)]))
  const many = shares({ main: NO_SPEND, agents })

  expect(many.map(s => s.label)).toEqual(['Haiku 5.5 · 5 agents', 'Opus 5.5 · 2 agents', 'Main thread'])
})

test('the limit moves since the start, and a reset counts what is used now', () => {
  expect(usedSince(34, 10)).toBe(24)
  expect(usedSince(5, 40)).toBe(5)
  expect(usedSince(undefined, 10)).toBe(undefined)
  expect(usedSince(10, undefined)).toBe(undefined)
})

test('the bars keep a sliver for anything spent', () => {
  expect(blockBar(0, 10)).toBe('░'.repeat(10))
  expect(blockBar(0.01, 10)).toBe('█' + '░'.repeat(9))
  expect(blockBar(1, 10)).toBe('█'.repeat(10))
  expect(barSvg(0.5, '#fff', 100, 6).includes('<rect width="50"')).toBe(true)
})

test('the ledger keeps the main thread and each agent apart, and Session draws them on every surface', async ($, on) => {
  const clock = { now: START + 90 * 60_000 }
  standIn(on, clock)

  await $.session.start({ source: 'startup', cwd: '/repo' } as any)
  await $.agent.spawn(SPAWN as any)
  await step($, undefined, usageOf(100, 700, 200, 50))
  await step($, 'a1', usageOf(50, 0, 0, 50), 'claude-haiku-5-5')
  await step($, undefined, usageOf(0, 100, 0, 50))
  await $.command.run({ command: 'receipt', args: '' } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

    expect(text).toContain('Session')
    expect(text).toContain('1h 30m')
    expect(text).toContain('Duration')
    expect(text).toContain('Subagents')
    expect(text).toContain('Map the repo')
    expect(text).toContain('Main thread')
    expect(text).toContain('≈ $1.23 at API prices')
    // Main: 1100 of 1250 tokens, 88%; the agent's 100, 8%: the shares, with their figures.
    expect(text.some((t: string) => /^\d+% · \d+(\.\d)?k?$/.test(t))).toBe(true)

    if (surface === 'desktop') {
      expect((await ui.findAll({ type: 'Svg' })).some((s: any) => s.props.alt.endsWith('%'))).toBe(true)
    } else {
      expect(text.some((t: string) => t.includes('█'))).toBe(true)
    }

    await ui.unmount()
  }
})

test('without a cost there is no dollar line, and nothing spent says so', async ($, on) => {
  standIn(on, { now: START + 60_000 }, { five: undefined }, null)

  await $.session.start({ source: 'startup', cwd: '/repo' } as any)
  await $.command.run({ command: 'receipt', args: '' } as any)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

  expect(text.some((t: string) => t.includes('≈ $') || t.includes('API prices'))).toBe(false)
  expect(text).toContain('Nothing spent yet.')
  await ui.unmount()
})

test('the command opens the Session module, and the old side pane is closed at start', async ($, on) => {
  const opened: string[] = []

  standIn(on, { now: START }, { five: 10 }, 1, opened)
  await $.session.start({ source: 'startup', cwd: '/repo' } as any)
  expect(CLOSED).toContain('usage-pill-receipt')

  const ran = await $.command.run({ command: 'receipt', args: '' } as any)

  // A module under the pill, not a pane.
  expect(opened).toEqual([])
  expect(typeof (ran as any).text).toBe('string')
})

const notifier = (on: any, clock: { now: number }) => {
  const sent: { text: string; options: any }[] = []

  standIn(on, clock)
  on('ui.notify', (_: unknown, e: any) => {
    sent.push({ text: e.text, options: e })

    return { value: { isSent: true, channel: 'client' } }
  })
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_: unknown, e: any) => ({ ...e }))

  return { sent }
}

const turn = async ($: any, clock: { now: number }, minutes: number, extra: Record<string, unknown> = {}) => {
  await $.turn.start({ text: 'go', turnId: 't1', ...extra } as any)
  clock.now += minutes * 60_000
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: minutes * 60_000, isAborted: false, ...extra } as any)
}

test('a turn past the threshold raises one held notification, a shorter one none', async ($, on) => {
  const clock = { now: START }
  const { sent } = notifier(on, clock)

  await turn($, clock, 1)
  expect(sent.length).toBe(0)

  await turn($, clock, 6)
  expect(sent.length).toBe(1)
  expect(sent[0]!.options.title).toBe('Claude finished')
  // The hold (delayMs, untilBack) and the key are a client's: the test's terminal passes on only the text and title.
  expect(sent[0]!.text).toBe('6m 0s')
})

test('the body counts the task steps and the agents this turn started', async ($, on) => {
  const clock = { now: START }
  const { sent } = notifier(on, clock)

  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await $.tool.call({
    tool: 'TaskCreate',
    tool_use_id: 'p1',
  } as any).catch(() => undefined)
  await $.agent.spawn(SPAWN as any)
  clock.now += 372_000
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 372_000, isAborted: false } as any)

  expect(sent[0]!.text).toBe('6m 12s · 1 agent')
  expect(
    doneBody(372_000, { tools: 3, steps: Array.from({ length: 5 }, () => ({ content: 'x', status: 'completed' as const })) }, [], 0),
  ).toBe('6m 12s · 5/5 steps')
})

test('an interrupted turn, and a subagent finishing, raise nothing', async ($, on) => {
  const clock = { now: START }
  const { sent } = notifier(on, clock)

  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  clock.now += 10 * 60_000
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as any)
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true } as any)

  expect(sent.length).toBe(0)
})

test('a new prompt goes on its way even where nothing can be taken back', async ($, on) => {
  notifier(on, { now: START })

  // The cancel itself is a client's: nothing here to observe it by.
  expect(((await $.prompt.submit({ text: 'next' } as any)) as any).text).toBe('next')
})

test('a higher threshold holds a six minute turn back', { options: { notifyAfterMinutes: 10 } }, async ($, on) => {
  const clock = { now: START }
  const { sent } = notifier(on, clock)

  await turn($, clock, 6)
  expect(sent.length).toBe(0)
  await turn($, clock, 11)
  expect(sent.length).toBe(1)
})

test('switched off, it never notifies', { options: { notifyOnDone: false } }, async ($, on) => {
  const clock = { now: START }
  const { sent } = notifier(on, clock)

  await turn($, clock, 30)
  expect(sent.length).toBe(0)
})
