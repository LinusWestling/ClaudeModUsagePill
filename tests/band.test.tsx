import { expect, mock, test } from 'claude-code/testing'

import { coolingText, coolingToast, headroomViewOf, stackedBarSvg } from '../hooks/headroom'
import { mascotMarkup } from '../hooks/mascot'
import { buildPill } from '../hooks/pill'

// The 0.6.0 band: the limit forecast, the cache countdown, the headroom row and
// the celebration.

const BAND = {
  plugin: 'usage-pill',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-17T12:00:00Z')
const MIN = 60_000
const NO_TASK = { steps: [], tools: 0 }
const SURFACES = ['terminal', 'desktop'] as const

const seed = (on: any, values: Record<string, unknown>) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('state.get', (_: unknown, e: { key: string }) => ({
    value: {
      value:
        ({ cache: null, minute: 0, task: NO_TASK, isWorking: false, limitSamples: [], headroom: null, celebrateUntil: 0, ...values } as Record<string, unknown>)[e.key] ?? null,
      version: 1,
    },
  }))
}

const reading = (tokens: number, percentUsed = 50) => ({
  tokens,
  window: 200_000,
  limits: [{ kind: 'five_hour', percentUsed, resetsAt: '2026-11-17T14:00:00Z' }],
})

const HEADROOM = {
  categories: [
    { name: 'Messages', tokens: 120_000, kind: 'used', color: 'claude' },
    { name: 'System tools', tokens: 30_000, kind: 'used', color: 'inactive' },
    { name: 'System prompt', tokens: 8_000, kind: 'used', color: 'promptBorder' },
  ],
  lastTurnDelta: 42_000,
  biggest: { label: 'Reading register.tsx', tokens: 12_400 },
  at: NOW,
}

const svgSource = async (ui: any): Promise<string> => ((await ui.find({ type: 'Svg' })) as any).props.source

// ── Limit forecast ──

test('a pace that runs out before the reset names the time in the session chip, amber', async ($, on) => {
  seed(on, {
    reading: reading(40_000, 50),
    limitSamples: [
      { at: NOW - 60 * MIN, percent: 20 },
      { at: NOW - 30 * MIN, percent: 35 },
      { at: NOW, percent: 50 },
    ],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg: any = await ui.find({ type: 'Svg' })

  // The limits group says when it runs out, in place of the week and the clock, in amber.
  expect(/>· out ~\d\d:\d\d</.test(svg.props.source) || />· out in 1h 40m</.test(svg.props.source)).toBe(true)
  expect(/>↻/.test(svg.props.source)).toBe(false)
  // Amber, though 50% alone would be calm.
  expect(svg.props.source.includes('class="value t-amber"')).toBe(true)
  expect(svg.props.source.includes('class="frame"')).toBe(true)
  expect(/at this pace runs out (~\d\d:\d\d|in 1h 40m)/.test(svg.props.alt)).toBe(true)
  await ui.unmount()

  const text = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(/^50% · out /.test((await text.find({ type: 'Text', text: /out/ }))?.text ?? '')).toBe(true)
  await text.unmount()
})

test('with too few samples the chip stays calm', async ($, on) => {
  seed(on, { reading: reading(40_000, 50), limitSamples: [{ at: NOW, percent: 50 }] })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // No pace: no amber, and the reset's clock is drawn.
  const source = await svgSource(ui)

  expect(/>↻ \d\d:\d\d</.test(source)).toBe(true)
  expect(source.includes('t-amber"')).toBe(false)
  expect(source.includes('class="frame"')).toBe(true)
  await ui.unmount()
})

// ── Cache countdown ──

test('a warm cache with under ten minutes left counts down, amber', async ($, on) => {
  seed(on, { reading: reading(40_000), cache: { read: 98, written: 1, uncached: 1, at: NOW - 56 * MIN } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg: any = await ui.find({ type: 'Svg' })
  expect(svg.props.source.includes('>cools 4m<')).toBe(true)
  expect(svg.props.alt.includes('prompt cache warm, cools in 4m')).toBe(true)
  await ui.unmount()

  const text = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await text.find({ type: 'Text', text: /cache/ }))?.text).toBe('cache cools 4m')
  await text.unmount()
})

test('with more than ten minutes left it is plainly warm', async ($, on) => {
  seed(on, { reading: reading(40_000), cache: { read: 98, written: 1, uncached: 1, at: NOW - 49 * MIN } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const source = await svgSource(ui)
  expect(source.includes('>warm<')).toBe(true)
  expect(source.includes('cools')).toBe(false)
  await ui.unmount()
})

test('the toast comes once per cache write, at five minutes, and only while idle', () => {
  const cache = { read: 400_000, written: 9_000, uncached: 1_000, at: NOW }
  const ttl = 60 * MIN

  expect(coolingToast(cache, false, NOW + 50 * MIN, ttl)).toBe(false)
  expect(coolingToast(cache, true, NOW + 55 * MIN, ttl)).toBe(false)
  expect(coolingToast(cache, false, NOW + 55 * MIN, ttl)).toBe(true)
  expect(coolingToast(cache, false, NOW + 56 * MIN, ttl)).toBe(false)
  expect(coolingToast({ ...cache, at: NOW + 1 }, false, NOW + 56 * MIN, ttl)).toBe(true)
  expect(coolingText(5, 410_000)).toBe('Cache cools in 5 min. Your next message would re-read 410k tokens.')
})

const USAGE = { input_tokens: 1_000, cache_read_input_tokens: 400_000, cache_creation_input_tokens: 9_000, output_tokens: 10 }

const stepper = (on: any, surfaces: string[], calls: string[], booked: any[]) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.usage', () => ({ value: { context: { tokens: 410_000, window: 1_000_000 }, rateLimits: [] } }))
  on('ui.notify', (_: unknown, e: any) => {
    calls.push('notify')
    booked.push(e)

    return { value: { isSent: true, channel: 'client' } }
  })
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
  } as any)
}

const step = async ($: any, index: number) => {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1 })
  let read = await stream.next()

  while (!read.done) read = await stream.next()
}

test('each cached request books the notification for five minutes before it cools', async ($, on) => {
  const calls: string[] = []
  const booked: any[] = []

  stepper(on, ['desktop'], calls, booked)
  await step($, 0)
  await step($, 1)

  // The cancel before each, the key, the delay and `untilBack` are a client's: the
  // test's terminal passes on only the text and the title.
  expect(calls).toEqual(['notify', 'notify'])
  expect(booked[1].text).toBe('Cache cools in 5 min. Your next message would re-read 410k tokens.')
  expect(booked[1].title).toBe('Cache cooling')
})

test('a terminal, which would raise it at once, gets no notification', async ($, on) => {
  const calls: string[] = []

  stepper(on, ['terminal'], calls, [])
  await step($, 0)
  expect(calls.length).toBe(0)
})

// ── Context headroom ──

test('past the threshold the band gets a headroom row, on every surface', async ($, on) => {
  seed(on, { reading: reading(172_000), headroom: HEADROOM })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect((await ui.find({ type: 'Text', text: /context$/ }))?.text).toBe('86% context')
    expect((await ui.find({ type: 'Text', text: /last turn/ }))?.text).toBe('+42k last turn')
    expect((await ui.find({ type: 'Text', text: /largest/ }))?.text).toBe('largest: Reading register.tsx ~12k')
    expect((await ui.find({ key: 'compact-now' }))?.text).toBe('Compact now')

    if (surface === 'desktop') {
      // The pill, and the bar of what fills the context, drawn on its own.
      const svgs: any[] = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBe(2)
      expect(svgs[1].props.alt).toBe('Context by category: Messages 120k, System tools 30k, System prompt 8k')
    } else {
      expect((await ui.findAll({ type: 'Text', text: /█/ })).length).toBe(3)
    }

    await ui.unmount()
  }
})

test('under the threshold the band is one row, as before', async ($, on) => {
  seed(on, { reading: reading(150_000), headroom: HEADROOM })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })

    expect(await ui.find({ key: 'compact-now' })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /% context/ })).toBe(undefined)

    if (surface === 'desktop') {
      expect((await ui.findAll({ type: 'Svg' })).length).toBe(1)
    }

    await ui.unmount()
  }
})

test('the threshold is the headroomAt option', { options: { headroomAt: 90 } }, async ($, on) => {
  seed(on, { reading: reading(172_000), headroom: HEADROOM })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'compact-now' })).toBe(undefined)
  await ui.unmount()
})

test('past the threshold before a turn has measured it, the row still offers to compact', async ($, on) => {
  seed(on, { reading: reading(190_000) })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /context$/ }))?.text).toBe('95% context')
  expect(await ui.find({ type: 'Text', text: /last turn/ })).toBe(undefined)
  expect((await ui.find({ key: 'compact-now' }))?.text).toBe('Compact now')
  await ui.unmount()
})

test('Compact now compacts and says how it went', async ($, on) => {
  const toasts: string[] = []

  seed(on, { reading: reading(172_000), headroom: HEADROOM })
  on('session.compact', () => ({
    messages: [{ role: 'user', text: 'Summary', toolUses: [] }],
    tokensBefore: 172_000,
    tokensAfter: 31_000,
  }))
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'compact-now' })
  expect(toasts).toEqual(['Compacted: 172k → 31k tokens'])
  await ui.unmount()
})

test('the view, the bar and their figures', () => {
  const at = (tokens: number) => ({ tokens, window: 200_000, limits: [] })

  expect(headroomViewOf(at(159_000), null, 80)).toBe(undefined)
  expect(headroomViewOf(at(160_000), null, 80)?.percent).toBe(80)
  expect(headroomViewOf({ window: 200_000, limits: [] }, null, 80)).toBe(undefined)
  expect(stackedBarSvg([{ name: 'A', tokens: 1 }, { name: 'B', tokens: 3 }], 120, 6).match(/<rect x=/g)?.length).toBe(2)
})

// ── Celebration ──

test('the celebrating mascot throws its arms up in confetti', () => {
  const party = mascotMarkup('celebrate')

  // Arms up beside the head, none at the sides.
  expect(party.includes('<rect x="1" y="4" width="1" height="2"')).toBe(true)
  expect(party.includes('<rect x="1" y="8" width="2" height="2"')).toBe(false)
  expect(party.includes('#7BE495')).toBe(true)
  expect(party.includes('m-bob')).toBe(true)
  expect(mascotMarkup('still').includes('#7BE495')).toBe(false)

  const pill = buildPill({ task: { label: 'Done', count: '' }, mascot: { running: 0, celebrate: true }, isWorking: false }, 800)
  expect(pill.source.includes('#7BE495')).toBe(true)
  expect(pill.alt.includes('all steps done')).toBe(true)
})

test('the band celebrates until its time is up', async ($, on) => {
  const steps = [{ content: 'Ship it', status: 'completed' }]

  seed(on, { reading: reading(40_000), task: { tools: 1, steps }, celebrateUntil: NOW + 5_000 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await svgSource(ui)).includes('#7BE495')).toBe(true)
  await ui.unmount()
})

test('a finished task list sets the celebration, and it ends eight seconds later', async ($, on: any) => {
  const clock = mock.clock(on, { now: NOW })

  on('env.get', () => ({ value: undefined }))
  on('session.usage', () => ({ value: { context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_: unknown, e: any) => ({ changed: e.changed }))
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))

  const confetti = async () => {
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const source = await svgSource(ui)

    await ui.unmount()

    return source.includes('#7BE495')
  }

  await $.session.measure({ context: { tokens: 40_000, window: 200_000 }, rateLimits: [], changed: ['context'] } as any)
  await $.turn.start({ text: 'go', turnId: 't1' } as any)
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    tool_use_id: 'p1',
    items: [{ content: 'Ship it', status: 'completed' }],
  } as any)
  expect(await confetti()).toBe(false)
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false } as any)

  expect(await confetti()).toBe(true)
  await clock.advance(8_000)
  expect(await confetti()).toBe(false)
})
