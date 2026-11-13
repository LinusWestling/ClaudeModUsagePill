import { expect, test } from 'claude-code/testing'

import {
  describeTool,
  endLabel,
  firstSentence,
  metaLine,
  progressLine,
  shortModel,
  summaryLine,
  transcriptRows,
  upsertRun,
} from '../hooks/agents'
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
  on('turn.complete', () => ({ text: '' }))
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

test('a finished agent shows what it reported, opens its transcript, and clears', async ($, on) => {
  const viewed: unknown[] = []
  standIn(on)
  on('ui.view', (_: unknown, e: unknown) => {
    viewed.push(e)

    return { value: {} }
  })

  await $.agent.spawn(SPAWN as any)
  await $.turn.complete({
    agentId: 'a1',
    turnId: 't1',
    reason: 'answer',
    answer: '## Done\n\nAdded **noindex** to 37 pages. Then I checked the sitemap.',
    durationMs: 1000,
    isAborted: false,
  } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /All 1 finished/ }))?.text).toBe('All 1 finished')
  expect((await ui.find({ type: 'Text', text: /noindex/ }))?.text).toBe('Added noindex to 37 pages.')
  expect((await ui.find({ type: 'Text', text: /^✓/ }))?.text).toBe('✓ 0s')
  expect(((await ui.find({ type: 'Svg' })) as any).props.width).toBe(24)

  await ui.press({ key: 'open-a1' })
  expect(viewed).toEqual([{ agentId: 'a1' }])

  await ui.press({ key: 'clear' })
  expect((await ui.find({ type: 'Text', text: /No subagents yet/ }))?.text).toBe('No subagents yet')
  await ui.unmount()
})

test('the pane offers the way back while an agent is in view', async ($, on) => {
  standIn(on)
  await $.agent.spawn(SPAWN as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, view: { agentId: 'a1' } } })

  expect((await ui.find({ key: 'back-a1' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the default type and effort are left out, a report reads as one sentence', () => {
  const plain = upsertRun([], 'a', { type: 'general-purpose', model: 'claude-sonnet-5-5', effort: 'medium' }, NOW)[0]!
  expect(metaLine(plain)).toBe('Sonnet 5.5')

  const odd = upsertRun([], 'a', { type: 'Explore', model: 'claude-haiku-5-5', effort: 'high' }, NOW)[0]!
  expect(metaLine(odd)).toBe('Haiku 5.5 · high effort · Explore')

  expect(firstSentence('# Summary\n\n- Fixed the [404](x.html) redirect. Also more.')).toBe(
    'Fixed the 404 redirect.',
  )
  expect(firstSentence('')).toBe('')

  const done = { ...plain, status: 'done' as const, endedAt: NOW + 43_000 }
  expect(endLabel(done, NOW + 99_000)).toBe('✓ 43s')
  expect(endLabel({ ...done, status: 'failed' }, NOW)).toBe('Failed · 43s')

  const running = upsertRun([], 'b', { tokens: 20_000 }, NOW + 10_000)[0]!
  expect(summaryLine([{ ...done, tokens: 66_000 }, running], NOW + 60_000)).toEqual({
    counts: '1 running · 1 finished',
    totals: '1m 0s · 86k tokens',
  })
})

test('where the main view cannot switch, the transcript opens in a pane of its own', async ($, on) => {
  const opened: string[] = []
  standIn(on, opened)
  on('ui.view', () => ({ value: { deny: 'the session draws no main view' } }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Review the email copy', toolUses: [] },
      {
        role: 'assistant',
        text: 'Reading the template first.',
        toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: '/repo/email/1.html' } }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [] },
    ],
  }))

  await $.agent.spawn(SPAWN as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'open-a1' })
    expect(opened).toEqual(['usage-pill-transcript'])
    await pane.unmount()

    const transcript = await $.ui.mount({
      ...PANE,
      surface,
      requestId: 'usage-pill-transcript',
      props: { ...PANE.props, title: 'Transcript · Map the repo' },
    })
    expect((await transcript.find({ type: 'Text', text: /Review the email/ }))?.text).toBe('Review the email copy')
    expect((await transcript.find({ type: 'Text', text: /Reading the template/ })) !== undefined).toBe(true)
    expect((await transcript.find({ type: 'Text', text: /Reading 1.html/ }))?.text).toBe('→ Reading 1.html')
    await transcript.unmount()
  }
})

test('a transcript keeps its latest rows and leaves out empty tool results', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    role: 'assistant' as const,
    text: `step ${i}`,
    toolUses: [],
  }))
  const rows = transcriptRows([{ role: 'user', text: '', toolUses: [] }, ...many], 10)
  expect(rows.length).toBe(10)
  expect(rows[9]!.text).toBe('step 99')
})
