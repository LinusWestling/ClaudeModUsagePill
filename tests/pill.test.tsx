import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-pill',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 },
} as const

const NOW = Date.parse('2026-11-04T12:00:00Z')

const NO_TASK = { steps: [], tools: 0 }

const seed = (on: any, values: Record<string, unknown>) => {
  on('clock.now', () => ({ value: NOW }))
  on('state.get', (_: unknown, e: { key: string }) => ({
    value: {
      value: { cache: null, minute: 0, task: NO_TASK, isWorking: false, ...values }[e.key] ?? null,
      version: 1,
    },
  }))
}

const READING = {
  tokens: 48_200,
  window: 200_000,
  limits: [
    { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-11-04T14:14:00Z' },
    { kind: 'seven_day', percentUsed: 41, resetsAt: '2026-11-08T12:00:00Z' },
  ],
}

const CACHE = { read: 98, written: 1, uncached: 1, at: NOW - 60_000 }

const TASK = {
  tools: 5,
  steps: [
    { content: 'Read the code', status: 'completed' },
    { content: 'Build the bar', status: 'in_progress' },
    { content: 'Run the tests', status: 'pending' },
  ],
}

test('the band draws the task bar with its steps, and every figure as a ring', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK, isWorking: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg: any = await ui.find({ type: 'Svg' })
  const source: string = svg.props.source

  for (const words of ['Working', '1/3', '24%', 'session', '41%', 'week', '48k / 200k', 'Warm', 'cache']) {
    expect(source.includes(`>${words}<`)).toBe(true)
  }

  expect(source.includes('class="pulse"')).toBe(true)
  expect(svg.props.alt.includes('session 24% used, 2h 14m left')).toBe(true)
  await ui.unmount()
})

test('with no list of steps a short bar sweeps, inventing no percentage', async ($, on) => {
  seed(on, { reading: READING, task: { steps: [], tools: 3 }, isWorking: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const source: string = ((await ui.find({ type: 'Svg' })) as any).props.source
  expect(source.includes('>Working<')).toBe(true)
  expect(source.includes('tools')).toBe(false)
  expect(source.includes('class="sweep"')).toBe(true)
  await ui.unmount()
})

test('between turns a finished task stays, and nothing moves', async ($, on) => {
  seed(on, {
    reading: READING,
    task: { tools: 2, steps: [{ content: 'Read', status: 'completed' }] },
  })

  const ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, isWorking: false },
    surface: 'desktop',
  })
  const source: string = ((await ui.find({ type: 'Svg' })) as any).props.source
  expect(source.includes('>Done<')).toBe(true)
  expect(source.includes('>1/1<')).toBe(true)
  expect(source.includes('class="pulse"')).toBe(false)
  await ui.unmount()
})

test('the drawing takes the whole row, inside one border', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg: any = await ui.find({ type: 'Svg' })
  expect(svg.props.source.includes('width="895"')).toBe(true)
  expect(svg.props.source.includes('stroke="url(#edge)"')).toBe(true)
  expect(svg.props.source.match(/stroke="url\(#edge\)"/g)?.length).toBe(1)
  await ui.unmount()
})

test('a turn shows one moving thing at most', async ($, on) => {
  seed(on, { reading: READING, task: TASK, isWorking: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const source: string = ((await ui.find({ type: 'Svg' })) as any).props.source
  expect(source.includes('class="pulse"')).toBe(true)
  expect(source.includes('class="sweep"')).toBe(false)
  await ui.unmount()
})

test('the cache goes cold once its hour has passed', async ($, on) => {
  seed(on, { reading: READING, cache: { ...CACHE, at: NOW - 61 * 60_000 } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(((await ui.find({ type: 'Svg' })) as any).props.source.includes('>Cold<')).toBe(true)
  await ui.unmount()
})

test('a request that missed and wrote nothing reads as cold', async ($, on) => {
  seed(on, { reading: READING, cache: { read: 0, written: 0, uncached: 50, at: NOW } })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(((await ui.find({ type: 'Svg' })) as any).props.source.includes('>Cold<')).toBe(true)
  await ui.unmount()
})

test('a narrow window gives up the weekly figure before the session', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, bodyColumns: 58 },
    surface: 'desktop',
  })
  const source: string = ((await ui.find({ type: 'Svg' })) as any).props.source
  expect(source.includes('>week<')).toBe(false)
  expect(source.includes('>session<')).toBe(true)
  await ui.unmount()
})

test('the terminal draws the same in text', async ($, on) => {
  seed(on, { reading: READING, cache: CACHE, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /▰/ }))?.text).toBe('▰▱▱')
  expect((await ui.find({ type: 'Text', text: /session/ }))?.text).toBe('24% session')
  await ui.unmount()
})

test('a window that has reset reads as empty', async ($, on) => {
  seed(on, {
    reading: {
      ...READING,
      limits: [{ kind: 'five_hour', percentUsed: 80, resetsAt: '2026-11-04T11:00:00Z' }],
    },
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svg: any = await ui.find({ type: 'Svg' })
  expect(svg.props.source.includes('>0%<')).toBe(true)
  await ui.unmount()
})

test('the desktop draws the pill in the band above the prompt', async ($, on) => {
  seed(on, { reading: READING, task: TASK })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const source: string = ((await ui.find({ type: 'Svg' })) as any).props.source
  expect(source.includes('>Working<')).toBe(true)
  expect(source.includes('>1/3<')).toBe(true)
  await ui.unmount()
})

test('no reading yet leaves the band to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
