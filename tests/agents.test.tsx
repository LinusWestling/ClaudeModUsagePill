import { expect, test } from 'claude-code/testing'

import { describeTool, progressLine, shortModel, upsertRun } from '../hooks/agents'
import { OUTFITS, mascotMarkup, mascotSvg, pickOutfit } from '../hooks/mascot'

const NOW = Date.parse('2026-11-04T12:00:00Z')

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

const standIn = (on: any, opened: string[] = []) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
}

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

test('a spawned agent shows its model, effort, doing and progress in the sidebar', async ($, on) => {
  standIn(on)

  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'call-1',
    description: 'Map the repo',
    prompt: 'Look around',
    effort: 'high',
  } as any)
  await $.agent.spawn(SPAWN as any)
  await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/pill.ts', agentId: 'a1' } as any)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Map the repo/ }))?.text).toBe('Map the repo')
    expect((await ui.find({ type: 'Text', text: /Haiku 5.5/ }))?.text).toBe(
      'Haiku 5.5 · high effort · Explore',
    )
    expect((await ui.find({ type: 'Text', text: /Reading pill.ts/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /1 tool/ })) !== undefined).toBe(true)

    if (surface !== 'terminal') {
      expect(((await ui.find({ type: 'Svg' })) as any).props.alt).toBe(
        'Running mascot in a explorer outfit',
      )
    }

    await ui.unmount()
  }
})

test('with no agents the sidebar says so', async ($, on) => {
  standIn(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No subagents yet')
  await ui.unmount()
})

test('the first agent opens the sidebar', async ($, on) => {
  const opened: string[] = []
  standIn(on, opened)

  await $.agent.spawn(SPAWN as any)
  expect(opened).toEqual(['usage-pill-agents'])
})

test('agents side by side wear different outfits, and type picks first', () => {
  expect(pickOutfit('Explore', [])).toBe('explorer')
  expect(pickOutfit('Explore', ['explorer'])).toBe('hardhat')

  let runs = upsertRun([], 'a', { type: 'general-purpose' }, NOW)
  runs = upsertRun(runs, 'b', { type: 'general-purpose' }, NOW)
  expect(runs[0]!.outfit === runs[1]!.outfit).toBe(false)
})

test('a word from its loop before the spawn answers keeps nothing wrong', () => {
  const early = upsertRun([], 'a', { tools: 1 }, NOW)
  const known = upsertRun(early, 'a', { type: 'Explore', description: 'Map' }, NOW + 5)

  expect(known[0]!.tools).toBe(1)
  expect(known[0]!.startedAt).toBe(NOW)
  expect(known[0]!.outfit).toBe('explorer')
})

test('only a moving mascot animates, and every outfit draws', () => {
  expect(mascotMarkup('moving').includes('m-bob')).toBe(true)
  expect(mascotMarkup('still').includes('m-bob')).toBe(false)

  for (const outfit of OUTFITS) {
    expect(mascotSvg('done', outfit, 48).startsWith('<svg')).toBe(true)
  }
})

test('names and figures read plainly', () => {
  expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(shortModel('haiku')).toBe('Haiku')
  expect(shortModel('gpt-x')).toBe('gpt-x')
  expect(shortModel(undefined)).toBe('Model unknown')
  expect(describeTool('Bash', { description: 'Run tests', command: 'npm test' })).toBe('Run tests')
  expect(describeTool('mcp__foo__bar', {})).toBe('Using foo bar')

  const run = upsertRun([], 'a', { tools: 2, tokens: 18_400 }, NOW)[0]!
  expect(progressLine(run, NOW + 80_000)).toBe('2 tools · 1m 20s · 18k tokens')
})
