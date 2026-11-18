import { expect, test } from 'claude-code/testing'

import {
  describeTool,
  endLabel,
  firstSentence,
  metaLine,
  progressLine,
  shortModel,
  stepLine,
  summaryLine,
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

const standIn = (on: any, opened: string[] = [], scrolls: any[] = []) => {
  on('clock.now', () => ({ value: NOW }))
  on('env.get', () => ({ value: undefined }))
  on('ui.open', (_: unknown, e: { id: string; title?: string }) => {
    opened.push(e.title ? `${e.id}: ${e.title}` : e.id)

    return { value: { isPlaced: true } }
  })
  // The first spawn is a1; any other is named after its call.
  on('agent.spawn', (_: unknown, e: { tool_use_id: string }) => ({
    model: 'claude-haiku-5-5',
    agentId: e.tool_use_id === 'call-1' ? 'a1' : e.tool_use_id,
  }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.scroll', (_: unknown, e: unknown) => {
    scrolls.push(e)

    return { value: {} }
  })
  on('ui.close', () => ({ value: undefined }))
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

test('a spawned agent shows its model, effort, its calls as they settle, and progress in the sidebar', async ($, on) => {
  standIn(on)

  await $.tool.call({
    tool: 'Agent',
    tool_use_id: 'call-1',
    description: 'Map the repo',
    prompt: 'Look around',
    effort: 'high',
  } as any)
  await $.agent.spawn(SPAWN as any)
  await $.tool.call({ tool: 'Grep', tool_use_id: 'u1', pattern: 'mascot', agentId: 'a1' } as any)
  await $.tool.call({ tool: 'Read', tool_use_id: 'u2', file_path: '/repo/hooks/pill.ts', agentId: 'a1' } as any)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect((await ui.find({ type: 'Text', text: /Map the repo/ }))?.text).toBe('Map the repo')
    expect((await ui.find({ type: 'Text', text: /Haiku 5.5/ }))?.text).toBe(
      'Haiku 5.5 · high effort · Explore',
    )
    // Each call a row of its own, newest last, ticked off with its time.
    const calls = (await ui.findAll({ type: 'Text', text: /Reading pill.ts|Searching for mascot/ })).map(t => t.text)
    expect(calls).toEqual(['Searching for mascot', 'Reading pill.ts'])
    expect((await ui.findAll({ type: 'Text', text: '✓' })).length).toBe(2)
    expect((await ui.find({ type: 'Text', text: /2 tools/ })) !== undefined).toBe(true)
    // Running, the card's action is a real button to watch it live.
    expect((await ui.find({ key: 'open-a1' }))?.text.includes('Watch live')).toBe(true)

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
  expect(opened).toEqual(['usage-pill-agents: Subagents'])
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
  expect(progressLine(run, NOW + 80_000)).toBe('2 tools · 1m 20s · 18k context')
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
    totals: '1m 0s · 0 tools',
  })
})


const PROMPT = { role: 'user', content: [{ type: 'text', text: 'Review the email copy' }] }
const READ = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'The template comes first.' },
    { type: 'text', text: 'Reading the **template** first.' },
    { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/repo/email/1.html' } },
  ],
}
const RESULT = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: '<html>hi</html>' }] }

/**
 * Stands in for a session whose main view can't show an agent, its messages
 * whatever `chat.messages` holds then; the test spawns the agent.
 */
const desktopSession = (on: any, opened: string[] = [], scrolls: any[] = []) => {
  const chat = { messages: [PROMPT] as unknown[] }

  standIn(on, opened, scrolls)
  on('ui.view', () => ({ value: { deny: 'the session draws no main view' } }))
  on('session.messages', (_: unknown, e: { as?: string }) => ({
    value: e.as === 'api' ? chat.messages : [],
  }))

  return chat
}

test('where the main view cannot switch, the Subagents pane itself turns into the chat, and back', async ($, on) => {
  const opened: string[] = []
  const chat = desktopSession(on, opened)
  chat.messages = [PROMPT, READ, RESULT]
  await $.agent.spawn(SPAWN as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    opened.length = 0
    const pane = await $.ui.mount({ ...PANE, surface })
    await pane.press({ key: 'open-a1' })
    // The same pane, retitled for the chat: no second pane.
    expect(opened).toEqual(['usage-pill-agents: Chat · Map the repo'])
    expect(await pane.find({ key: 'open-a1' })).toBeUndefined()
    expect((await pane.find({ key: 'chat-back' }))?.text).toBe('← Subagents')

    expect((await pane.find({ type: 'Text', text: /Review the email/ }))?.text).toBe('Review the email copy')
    expect((await pane.find({ type: 'Markdown' }))?.text).toBe('Reading the **template** first.')
    // The thought before its words shows nowhere; the call after them is one dim line.
    expect(await pane.find({ type: 'Text', text: /Thought/ })).toBeUndefined()
    expect((await pane.find({ key: 'atu1' }))?.text).toBe('▸ Read 1.html')
    expect(await pane.find({ key: 'tu1' })).toBeUndefined()
    // Opened, the call is a row; pressed, it opens on what it was given and what came back.
    await pane.press({ key: 'atu1' })
    expect((await pane.find({ key: 'tu1' }))?.text).toBe('Reading 1.html')
    expect(await pane.find({ type: 'Code' })).toBe(undefined)
    await pane.press({ key: 'tu1' })
    const code = (await pane.findAll({ type: 'Code' })).map(c => c.text)
    expect(code[0]!.includes('"file_path": "/repo/email/1.html"')).toBe(true)
    expect(code[1]).toBe('<html>hi</html>')
    await pane.press({ key: 'tu1' })
    await pane.press({ key: 'atu1' })

    // Back: the cards again, under the pane's own title.
    await pane.press({ key: 'chat-back' })
    expect(opened.at(-1)).toBe('usage-pill-agents: Subagents')
    expect(await pane.find({ key: 'chat-back' })).toBeUndefined()
    expect((await pane.find({ key: 'open-a1' }))?.text.includes('Watch live')).toBe(true)
    await pane.unmount()
  }
})

test('a name in the timeline opens its chat in place, and back returns to the timeline where it was scrolled', async ($, on) => {
  const opened: string[] = []
  const scrolls: any[] = []
  const chat = desktopSession(on, opened, scrolls)
  chat.messages = [PROMPT, READ, RESULT]
  await $.agent.spawn(SPAWN as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, scroll: { offset: 7, bodyRows: 20 } } })
    await pane.press({ key: 'view-timeline' })
    await pane.press({ key: 'tl-a1' })
    expect(opened.at(-1)).toBe('usage-pill-agents: Chat · Map the repo')
    expect((await pane.find({ key: 'atu1' }))?.text).toBe('▸ Read 1.html')

    scrolls.length = 0
    await pane.press({ key: 'chat-back' })
    // The timeline, not the cards.
    expect((await pane.find({ key: 'tl-a1' }))?.text).toBe('Map the repo')
    expect(await pane.find({ key: 'open-a1' })).toBeUndefined()
    // Its window back on the row it was at: the pane's own scroll (to its start),
    // as the engine raises it resolved, is moved on to where the list was left.
    // The kit has no window to scroll, so the test raises that move itself.
    const resolved = { component: 'Pane', requestId: 'usage-pill-agents', offset: 0, by: -30, bodyRows: 20, contentRows: 50 }
    await $.ui.scroll({ ...resolved, origin: { kind: 'plugin', name: 'usage-pill' } } as any)
    expect(scrolls.at(-1)).toMatchObject({ offset: 7 })
    // Once: the next move is left alone.
    await $.ui.scroll({ ...resolved, origin: { kind: 'plugin', name: 'usage-pill' } } as any)
    expect(scrolls.at(-1)).toMatchObject({ offset: 0 })
    await pane.press({ key: 'view-cards' })
    await pane.unmount()
  }
})

test('a run of work between texts folds into one line that opens on each call', async ($, on) => {
  const chat = desktopSession(on)
  chat.messages = [
    PROMPT,
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking around.' },
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', id: 'u2', name: 'Grep', input: { pattern: 'mascot' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'u1', content: 'a' },
        { type: 'tool_result', tool_use_id: 'u2', content: 'no such file', is_error: true },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'One more.' },
        { type: 'tool_use', id: 'u3', name: 'Read', input: { file_path: '/repo/b.ts' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u3', content: 'b' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
  ]
  await $.agent.spawn(SPAWN as any)
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false } as any)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    if (await pane.find({ key: 'open-a1' })) await pane.press({ key: 'open-a1' })

    // Folded: its work counted in words, most first, and its failures apart.
    expect((await pane.find({ key: 'atu1' }))?.text).toBe('▸ Read 2 files, searched once · 1 failed')
    expect(await pane.find({ type: 'Text', text: /✗/ })).toBeUndefined()
    expect(await pane.find({ key: 'tu1' })).toBeUndefined()
    // The words around it are not folded.
    expect((await pane.findAll({ type: 'Markdown' })).map(m => m.text)).toEqual(['Looking around.', 'Done.'])

    await pane.press({ key: 'atu1' })
    expect((await pane.find({ key: 'atu1' }))?.text.startsWith('▾')).toBe(true)
    expect((await pane.find({ key: 'tu3' }))?.text).toBe('Reading b.ts')
    // A grid: the kind of work beside each label, one ✗ for the failed call, no ✓.
    const kinds = (await pane.findAll({ type: 'Text', text: /^(Read|Search|Thought)$/ })).map(t => t.text)
    expect(kinds).toEqual(['Read', 'Search', 'Thought', 'Read'])
    expect((await pane.findAll({ type: 'Text', text: '✗' })).length).toBe(1)
    expect(await pane.find({ type: 'Text', text: /^✓$/ })).toBeUndefined()
    // The thought between its calls is one dim row, openable.
    expect((await pane.find({ key: 'm3.0' }))?.text).toBe('▸ 1 thought')
    await pane.press({ key: 'm3.0' })
    expect((await pane.find({ type: 'Markdown', text: 'One more.' })) !== undefined).toBe(true)
    await pane.press({ key: 'm3.0' })
    await pane.press({ key: 'atu1' })
    await pane.unmount()
  }
})

test('a call being written joins the run before it, and the folded row says what it is doing', async ($, on) => {
  const chat = desktopSession(on)
  chat.messages = [
    PROMPT,
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', id: 'u2', name: 'Grep', input: { pattern: 'pill' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'u1', content: 'a' },
        { type: 'tool_result', tool_use_id: 'u2', content: 'bad pattern', is_error: true },
      ],
    },
  ]
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'tool', index: 0, id: 'u3', name: 'Read' }
    yield { kind: 'input', index: 0, json: '{"file_path":"/repo/hooks/pill.ts"}' }

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null }
  } as any)

  await $.agent.spawn(SPAWN as any)
  const stream = $.turn.step({ turnId: 't1', index: 1, model: 'claude-haiku-5-5', messageCount: 3, agentId: 'a1' })
  while (!(await stream.next()).done) {
    // Drained: the tail now holds the call being written.
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })
    if (await pane.find({ key: 'open-a1' })) await pane.press({ key: 'open-a1' })

    // Live, the line says what it is doing now, behind the spinner.
    expect((await pane.find({ key: 'atu1' }))?.text).toBe(`${'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[Math.floor(NOW / 1000) % 10]} Reading pill.ts · 1 failed`)
    // Opened, the call being written is the last row in it.
    await pane.press({ key: 'atu1' })
    expect((await pane.find({ key: 'row-live-t1-1-0' }))?.text.includes('Reading pill.ts')).toBe(true)
    await pane.press({ key: 'atu1' })
    await pane.unmount()
  }
})

test('a streaming step passes every chunk on untouched and shows in the chat as it comes', async ($, on) => {
  const chat = desktopSession(on)
  const CHUNKS = [
    { kind: 'thinking', index: 0, text: 'Hmm' },
    { kind: 'text', index: 1, text: 'All ' },
    { kind: 'text', index: 1, text: 'good.' },
    { kind: 'stop', stopReason: 'end_turn', usage: null },
  ]
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    for (const chunk of CHUNKS) yield chunk

    return { turnId: e.turnId, index: e.index, answer: 'All good.', toolUses: [], stopReason: 'end_turn', usage: null }
  } as any)

  await $.agent.spawn(SPAWN as any)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'open-a1' })
  await pane.unmount()

  const step = { turnId: 't1', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'a1' }
  const seen: unknown[] = []
  const stream = $.turn.step(step)
  let read = await stream.next()

  while (!read.done) {
    seen.push(read.value)
    read = await stream.next()
  }

  expect(seen).toEqual(CHUNKS)
  expect(read.value.answer).toBe('All good.')

  // The transcript doesn't hold the response yet: the chat shows it from the stream.
  const transcript = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await transcript.find({ type: 'Markdown' }))?.text).toBe('All good.')
  // Its thought, done before its words, shows nowhere.
  expect(await transcript.find({ type: 'Text', text: /Thought|Thinking/ })).toBeUndefined()
  await transcript.unmount()

  // Once it does (by the turn's end at the latest), the stream's copy goes and nothing shows twice.
  chat.messages = [PROMPT, { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hmm' }, { type: 'text', text: 'All good.' }] }]
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: 'All good.', durationMs: 1, isAborted: false } as any)

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.findAll({ type: 'Markdown', text: 'All good.' })).length).toBe(1)
  await after.unmount()
})

test("a finished agent's report is marked and can be copied", async ($, on) => {
  const copied: string[] = []
  const chat = desktopSession(on)
  on('ui.copy', (_: unknown, e: { text: string }) => {
    copied.push(e.text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  chat.messages = [PROMPT, { role: 'assistant', content: [{ type: 'text', text: 'Fixed 3 links.' }] }]
  await $.agent.spawn(SPAWN as any)

  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: 'Fixed 3 links.', durationMs: 1, isAborted: false } as any)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ key: 'open-a1' }))?.text).toBe('Open chat')
  await pane.press({ key: 'open-a1' })

  expect((await pane.find({ type: 'Text', text: /Final report/ }))?.text).toBe('✓ Final report')
  await pane.press({ key: 'copy-report' })
  expect(copied).toEqual(['Fixed 3 links.'])
  await pane.unmount()
})

test('a card keeps its latest calls and folds the rest behind a count', async ($, on) => {
  standIn(on)
  await $.agent.spawn(SPAWN as any)

  for (let i = 1; i <= 7; i++) {
    await $.tool.call({ tool: 'Read', tool_use_id: `u${i}`, file_path: `/repo/f${i}.ts`, agentId: 'a1' } as any)
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'feed-a1' }))?.text).toBe('+2 earlier')
  expect(await ui.find({ type: 'Text', text: 'Reading f2.ts' })).toBe(undefined)
  await ui.press({ key: 'feed-a1' })
  expect((await ui.find({ type: 'Text', text: 'Reading f1.ts' })) !== undefined).toBe(true)
  expect((await ui.find({ key: 'feed-a1' }))?.text).toBe('Show fewer')
  await ui.unmount()
})

// ── Only the person leaves a chat ──────────────────────────────────────────

/** Opens a1's chat in a mounted pane on the desktop, a1 finished. */
const inChat = async ($: any, on: any) => {
  desktopSession(on)
  on('session.start', () => ({ cwd: '/repo' }))
  on('command.register', () => ({ value: { command: 'subagents' } }))
  on('session.usage', () => ({ value: { context: { window: 200_000 }, rateLimits: [] } }))
  on('prompt.submit', (_: unknown, e: any) => ({ ...e }))
  await $.agent.spawn(SPAWN as any)
  await $.turn.complete({ agentId: 'a1', turnId: 't1', reason: 'answer', answer: 'Done.', durationMs: 1, isAborted: false } as any)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: 'open-a1' })
  expect((await pane.find({ key: 'chat-back' })) !== undefined).toBe(true)

  return pane
}

test('a reload mid-chat stays in the chat', async ($, on) => {
  const pane = await inChat($, on)

  await $.session.start({ source: 'startup', cwd: '/repo' } as any)
  expect((await pane.find({ key: 'chat-back' })) !== undefined).toBe(true)
  await pane.unmount()
})

test("a new prompt mid-chat keeps the finished agent's chat, header and all", async ($, on) => {
  const pane = await inChat($, on)

  await $.prompt.submit({ text: 'next' } as any)
  expect((await pane.find({ key: 'chat-back' })) !== undefined).toBe(true)
  expect((await pane.find({ type: 'Text', text: 'Map the repo' }))?.text).toBe('Map the repo')
  await pane.unmount()
})

test('a new agent mid-chat leaves the chat on show', async ($, on) => {
  const pane = await inChat($, on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-2', description: 'Second' } as any)
  expect((await pane.find({ key: 'chat-back' })) !== undefined).toBe(true)
  expect((await pane.find({ type: 'Text', text: 'Map the repo' }))?.text).toBe('Map the repo')
  await pane.unmount()
})
