import { expect, test } from 'claude-code/testing'

import type { AgentRun, ToolEntry } from '../types'
import {
  TIMELINE_WIDTH,
  axisSvg,
  barOf,
  byStart,
  clock,
  marksOf,
  errorsOf,
  rowSvg,
  scaleOf,
  statLine,
  textAxis,
  textBar,
  xAt,
} from '../hooks/timeline'

const NOW = Date.parse('2026-11-04T12:00:00Z')
const W = 300

const run = (id: string, patch: Partial<AgentRun> = {}): AgentRun => ({
  id,
  description: id,
  type: '',
  status: 'done',
  tools: 0,
  steps: [],
  startedAt: NOW,
  endedAt: NOW + 60_000,
  outfit: 'explorer',
  ...patch,
})

const call = (id: string, at: number, status: ToolEntry['status'] = 'ok'): ToolEntry => ({
  id,
  tool: 'Read',
  label: `Reading ${id}`,
  startedAt: at,
  endedAt: at + 500,
  status,
})

test('times read as minutes and seconds', () => {
  expect(clock(0)).toBe('0:00')
  expect(clock(84_000)).toBe('1:24')
  expect(clock(3_723_000)).toBe('1:02:03')
  expect(clock(-5)).toBe('0:00')
})

test('every row shares one scale: earliest start to the latest end', () => {
  const a = run('a', { startedAt: NOW, endedAt: NOW + 40_000 })
  const b = run('b', { startedAt: NOW + 20_000, endedAt: NOW + 100_000 })
  const scale = scaleOf([b, a], NOW + 500_000)

  expect(scale).toEqual({ start: NOW, end: NOW + 100_000, span: 100_000, isLive: false })

  // The same figure turns a moment into a place, whichever row asks.
  expect(xAt(scale, NOW + 50_000, W)).toBe(150)
  expect(barOf(a, scale, W, NOW + 500_000)).toEqual({ x: 0, w: 120 })
  expect(barOf(b, scale, W, NOW + 500_000)).toEqual({ x: 60, w: 240 })
  expect(byStart([b, a]).map(r => r.id)).toEqual(['a', 'b'])
})

test('a running agent grows to now and the axis ends at now', () => {
  const done = run('a', { endedAt: NOW + 30_000 })
  const going = run('b', { status: 'running', startedAt: NOW + 10_000, endedAt: undefined })
  const scale = scaleOf([done, going], NOW + 60_000)

  expect(scale.isLive).toBe(true)
  expect(scale.end).toBe(NOW + 60_000)
  expect(barOf(going, scale, W, NOW + 60_000)).toEqual({ x: 50, w: 250 })
  // Time passes and the same run is drawn wider on a wider scale.
  const later = scaleOf([done, going], NOW + 120_000)
  expect(barOf(going, later, W, NOW + 120_000).w).toBe(275)
  expect(marksOf(scale, W).at(-1)).toEqual({ x: W, label: 'now' })
  expect(marksOf(scaleOf([done], NOW + 60_000), W).at(-1)!.label).toBe('30s')
})

test('a finished run keeps its width as time goes on; a short one is still drawn', () => {
  const a = run('a', { endedAt: NOW + 60_000 })
  const instant = run('b', { startedAt: NOW + 60_000, endedAt: NOW + 60_000 })
  const scale = scaleOf([a, instant], NOW + 999_000)

  expect(barOf(a, scale, W, NOW + 999_000).w).toBe(W)
  expect(barOf(instant, scale, W, NOW + 999_000).w).toBeGreaterThan(0)
  expect(barOf(instant, scale, W, NOW + 999_000).x + barOf(instant, scale, W, 0).w).toBeLessThanOrEqual(W)
})

test('only failed calls are marked, where they started', () => {
  const scale = scaleOf([run('a', { endedAt: NOW + 100_000 })], NOW)
  const dots = errorsOf(
    [call('x', NOW), call('y', NOW + 50_000), call('z', NOW + 50_000, 'error'), call('w', NOW + 100_000, 'error')],
    scale,
    W,
  )

  expect(dots).toEqual([{ x: 150 }, { x: 300 }])
  expect(errorsOf([call('x', NOW), call('y', NOW + 10_000)], scale, W)).toEqual([])
})

test('the axis names few moments, in whole minutes once it is long', () => {
  const labels = (ms: number, live = false) =>
    marksOf(scaleOf([run('a', { endedAt: NOW + ms, ...(live ? { status: 'running' as const } : {}) })], NOW + ms), W).map(
      m => m.label,
    )

  expect(labels(100_000, true)).toEqual(['0s', '30s', '1m', 'now'])
  expect(labels(100_000)).toEqual(['0s', '30s', '1m', '1m 40s'])
  expect(labels(11 * 60_000, true)).toEqual(['0m', '5m', 'now'])
  expect(labels(11 * 60_000)).toEqual(['0m', '5m', '11m'])

  for (const minutes of [1, 3, 8, 11, 25, 60, 200]) {
    const marks = marksOf(scaleOf([run('a', { endedAt: NOW + minutes * 60_000 })], NOW), W)
    expect(marks.length).toBeLessThanOrEqual(4)
    expect(marks[0]!.x).toBe(0)
    expect(marks.at(-1)!.x).toBe(W)

    for (let i = 1; i < marks.length; i++) expect(marks[i]!.x - marks[i - 1]!.x).toBeGreaterThanOrEqual(30)
  }
})

test('the drawing: one flat colour, a dot per failed call, a pulsing cap only while it runs', () => {
  const scale = scaleOf([run('a')], NOW)
  const finished = rowSvg(run('a'), [call('x', NOW), call('y', NOW + 30_000, 'error')], scale, NOW)

  expect(finished.startsWith('<svg')).toBe(true)
  expect(finished.includes('fill="#5FAF84"')).toBe(true)
  expect(finished.includes('Gradient')).toBe(false)
  expect(finished.includes('<line')).toBe(false)
  expect(finished.match(/<circle/g)?.length).toBe(1)
  expect(finished.includes('class="cap"')).toBe(false)

  const going = run('b', { status: 'running', endedAt: undefined })
  const live = rowSvg(going, [], scaleOf([going], NOW + 10_000), NOW + 10_000)
  expect(live.includes('fill="#9B6BFF"')).toBe(true)
  expect(live.includes('<circle class="cap"')).toBe(true)
  expect(live.includes('prefers-reduced-motion')).toBe(true)
  expect(rowSvg(run('c', { status: 'failed' }), [], scale, NOW).includes('#E5484D')).toBe(true)
  expect(rowSvg(run('d', { status: 'stopped' }), [], scale, NOW).includes('#E8A317')).toBe(true)
  // The axis draws labels only.
  expect(axisSvg(scale).source.includes('>0s<')).toBe(true)
  expect(axisSvg(scale).source.includes('<line')).toBe(false)
  expect(TIMELINE_WIDTH).toBeGreaterThan(0)
})

test('the right-hand text is the tool count and the time', () => {
  expect(statLine(run('a', { tools: 42, endedAt: NOW + 667_000 }), NOW)).toBe('42 tools · 11:07')
  expect(statLine(run('a', { tools: 1, endedAt: NOW + 84_000 }), NOW)).toBe('1 tool · 1:24')
  expect(statLine(run('a', { tools: 3, status: 'running', endedAt: undefined }), NOW + 65_000)).toBe('3 tools · 1:05')
})

test('the terminal bar is one thin line, placed on the same scale', () => {
  const a = run('a', { startedAt: NOW, endedAt: NOW + 50_000 })
  const b = run('b', { startedAt: NOW + 50_000, endedAt: NOW + 100_000 })
  const scale = scaleOf([a, b], NOW)

  expect(textBar(a, scale, 20, NOW)).toEqual({ before: '', fill: '━'.repeat(10) })
  expect(textBar(b, scale, 20, NOW)).toEqual({ before: ' '.repeat(10), fill: '━'.repeat(10) })

  const tiny = textBar(run('c', { startedAt: NOW + 100_000, endedAt: NOW + 100_000 }), scale, 20, NOW)
  expect(tiny.before.length + tiny.fill.length).toBeLessThanOrEqual(20)
  expect(tiny.fill.length).toBeGreaterThanOrEqual(1)

  const axis = textAxis(scale, 40)
  expect(axis.startsWith('0s')).toBe(true)
  expect(axis.endsWith('1m 40s')).toBe(true)
  expect(axis.length).toBeLessThanOrEqual(40)
})

// ── The pane ────────────────────────────────────────────────────────────────

const PANE = {
  plugin: 'usage-pill',
  component: 'Pane',
  requestId: 'usage-pill-agents',
  props: {
    title: 'Subagents',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const spawn = (id: string, description: string) =>
  ({
    tool_use_id: id,
    prompt: 'Look around',
    description,
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  }) as any

test('the toggle switches the Subagents pane between cards and the timeline, on every surface', async ($, on) => {
  let t = NOW
  const viewed: unknown[] = []

  on('clock.now', () => ({ value: t }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.spawn', (_: unknown, e: { tool_use_id: string }) => ({ model: 'claude-haiku-5-5', agentId: e.tool_use_id }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.view', (_: unknown, e: unknown) => {
    viewed.push(e)

    return { value: {} }
  })

  // a1 starts first, calls two tools and finishes; a2 starts 20 s later and still runs.
  await $.agent.spawn(spawn('a1', 'Map the repo'))
  t = NOW + 10_000
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u1', pattern: 'mascot', agentId: 'a1' } as any)
  t = NOW + 20_000
  await $.agent.spawn(spawn('a2', 'Write the tests'))
  t = NOW + 30_000
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: '/repo/a.ts', agentId: 'a1' } as any)
  t = NOW + 40_000
  await $.turn.complete({
    agentId: 'a1',
    turnId: 't1',
    reason: 'answer',
    answer: 'Found it.',
    durationMs: 40_000,
    isAborted: false,
  } as any)
  t = NOW + 80_000
  await $.tool.call({ tool: 'Read', tool_use_id: 'u3', file_path: '/repo/b.ts', agentId: 'a2' } as any)
  t = NOW + 100_000

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // Cards are what it opens on.
    expect((await ui.find({ key: 'view-cards' }))?.text).toBe('Cards')
    expect((await ui.find({ key: 'open-a2' })) !== undefined).toBe(true)
    expect(await ui.find({ key: 'tl-a2' })).toBeUndefined()

    await ui.press({ key: 'view-timeline' })

    expect((await ui.find({ key: 'view-timeline' }))?.text).toBe('Timeline')
    expect(await ui.find({ key: 'open-a2' })).toBeUndefined()
    // Oldest first, each name a button, its end beside it.
    expect((await ui.find({ key: 'tl-a1' }))?.text).toBe('Map the repo')
    expect((await ui.find({ key: 'tl-a2' }))?.text).toBe('Write the tests')
    expect((await ui.find({ type: 'Text', text: '✓' }))?.text).toBe('✓')
    expect((await ui.find({ type: 'Text', text: '●' }))?.text).toBe('●')
    expect((await ui.find({ type: 'Text', text: '2 tools · 0:40' }))?.text).toBe('2 tools · 0:40')
    expect((await ui.find({ type: 'Text', text: '1 tool · 1:20' }))?.text).toBe('1 tool · 1:20')
    expect((await ui.find({ type: 'Text', text: /Press a name/ }))?.text).toBe('Press a name to open its chat.')

    if (surface === 'desktop') {
      const drawings = (await ui.findAll({ type: 'Svg' })) as any[]
      const axis = drawings.find(d => d.props.alt.startsWith('Time axis'))
      expect(axis.props.alt).toBe('Time axis: 0s, 30s, 1m, now')

      // One axis for every row: both bars are the same width of drawing.
      const rows = drawings.filter(d => d.props.alt.includes('tool call'))
      expect(rows.length).toBe(2)
      expect(rows.every(r => r.props.source.includes(`width="${TIMELINE_WIDTH}"`))).toBe(true)
      expect(rows[0].props.alt).toBe('Finished for 0:40, 2 tool calls')
      expect(rows[1].props.alt).toBe('Running for 1:20, 1 tool call')
      // a1's bar covers 0 to 40 s of 100 s; a2's runs from 20 s to now.
      expect(rows[0].props.source.includes(`x="0" y="5" width="${0.4 * TIMELINE_WIDTH}"`)).toBe(true)
      expect(rows[1].props.source.includes(`x="${0.2 * TIMELINE_WIDTH}" y="5" width="${0.8 * TIMELINE_WIDTH}"`)).toBe(true)
      // Nothing marks a call that went well.
      expect(rows[0].props.source.includes('<circle')).toBe(false)
    } else {
      expect((await ui.find({ type: 'Text', text: '━'.repeat(16) }))?.text).toBe('━'.repeat(16))
      expect((await ui.find({ type: 'Text', text: /^0s/ }))?.text.endsWith('now')).toBe(true)
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    }

    await ui.press({ key: 'tl-a2' })
    expect(viewed.at(-1)).toEqual({ agentId: 'a2' })

    await ui.press({ key: 'view-cards' })
    expect((await ui.find({ key: 'open-a2' })) !== undefined).toBe(true)
    expect(await ui.find({ key: 'tl-a2' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the timeline of no agents is the same line as the cards', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'view-timeline' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No subagents yet')
  expect(await ui.find({ type: 'Text', text: /Press a name/ })).toBeUndefined()
  await ui.press({ key: 'view-cards' })
  await ui.unmount()
})
