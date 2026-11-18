import { expect, test } from 'claude-code/testing'

import type { ActivityCall, ChatEntry, ChatRow } from '../hooks/chat'
import {
  activityRuns,
  activitySummary,
  applyChunk,
  categoryOf,
  chatEntries,
  doneLabel,
  isDue,
  liveToolLabel,
  newTail,
  pendingBlocks,
  reportOf,
  runRows,
  runningLabel,
} from '../hooks/chat'

test('a transcript reads as chat rows: the prompt, thoughts, words and calls with their outcome', () => {
  const rows = chatEntries([
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>context</system-reminder>' },
        { type: 'text', text: 'Fix the footer' },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Footer first.' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls', description: 'List files' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: [{ type: 'text', text: 'denied' }], is_error: true }] },
    { role: 'assistant', content: 'Done: fixed it.' },
  ])

  expect(rows.map(r => r.kind)).toEqual(['prompt', 'thinking', 'text', 'tool', 'text'])
  expect(rows[0]).toMatchObject({ text: 'Fix the footer', at: 0 })

  const call = rows[3]!
  expect(call).toMatchObject({ key: 'tu1', label: 'List files', result: 'denied', isError: true, at: 1 })
  expect(reportOf(rows)).toBe('Done: fixed it.')
  expect(reportOf(rows.slice(0, 1))).toBe(undefined)
})

test('chunks grow the live tail, and one that changes nothing keeps it as it was', () => {
  let tail = newTail('t1', 0, 3)
  tail = applyChunk(tail, { kind: 'thinking', index: 0, text: 'Hm' })
  tail = applyChunk(tail, { kind: 'text', index: 1, text: 'Hel' })
  tail = applyChunk(tail, { kind: 'text', index: 1, text: 'lo' })
  tail = applyChunk(tail, { kind: 'tool', index: 2, id: 'u9', name: 'Read' })
  tail = applyChunk(tail, { kind: 'input', index: 2, json: '{"file_path":"/a/b.ts' })

  expect(tail.blocks).toEqual([
    { index: 0, kind: 'thinking', text: 'Hm' },
    { index: 1, kind: 'text', text: 'Hello' },
    { index: 2, kind: 'tool', text: '{"file_path":"/a/b.ts', id: 'u9', name: 'Read' },
  ])
  expect(applyChunk(tail, { kind: 'stop', stopReason: 'end_turn', usage: null })).toBe(tail)
  expect(applyChunk(tail, { kind: 'engine', ref: 1 })).toBe(tail)
  // A tool being written already says what it is about.
  expect(liveToolLabel('Read', tail.blocks[2]!.text)).toBe('Reading b.ts')
  expect(liveToolLabel('Bash', '{"comm')).toBe('Bash')
})

test('writes are throttled to one per interval', () => {
  expect(isDue(1_000, 1_100)).toBe(false)
  expect(isDue(1_000, 1_200)).toBe(true)
  expect(isDue(0, 50, 40)).toBe(true)
})

test('the tail shows only what the transcript does not hold yet', () => {
  const before = chatEntries([
    { role: 'user', content: 'Go' },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
  ])
  let tail = newTail('t1', 1, 2)
  tail = applyChunk(tail, { kind: 'text', index: 0, text: 'Let me' })

  // An earlier step said the same words: they are not this step's.
  expect(pendingBlocks(before, tail).map(b => b.text)).toEqual(['Let me'])
  expect(pendingBlocks(before, null)).toEqual([])

  tail = applyChunk(applyChunk(tail, { kind: 'text', index: 0, text: ' fix it.' }), { kind: 'tool', index: 1, id: 'u2', name: 'Edit' })
  const committed = chatEntries([
    { role: 'user', content: 'Go' },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Let me fix it.' }] },
  ])

  // Mid-stream, block by block: its words are in, its call isn't yet.
  expect(pendingBlocks(committed, tail).map(b => b.kind)).toEqual(['tool'])
  // Whole, and any of it in: all of it is.
  expect(pendingBlocks(committed, { ...tail, isDone: true })).toEqual([])
  expect(pendingBlocks(before, { ...tail, isDone: true }).length).toBe(2)
})

// ── A run of work between texts, as one line ────────────────────────────────

const call = (id: string, tool = 'Read', extra: Partial<ChatEntry> = {}): ChatEntry =>
  ({ key: `t${id}`, at: 0, kind: 'tool', id, tool, label: `${tool} ${id}`, input: '{}', ...extra }) as ChatEntry
const said = (key: string, kind: 'text' | 'thinking' | 'prompt' = 'text'): ChatEntry => ({ key, at: 0, kind, text: key })
const shape = (rows: ChatRow[]) => rows.map(r => (r.kind === 'activity' ? `[${r.items.map(i => i.key).join(' ')}]` : r.key))
const ok = (tool: string, label = tool, extra: Partial<ActivityCall> = {}): ActivityCall => ({ tool, label, state: 'ok', ...extra })

test('everything between two texts is one run, a single call included; thoughts never stand alone', () => {
  const rows = activityRuns([
    said('p', 'prompt'),
    said('th0', 'thinking'),
    call('1'),
    said('th1', 'thinking'),
    call('2'),
    said('words'),
    call('3'),
    said('more'),
    said('th2', 'thinking'),
    said('end'),
  ])

  expect(shape(rows)).toEqual(['p', '[th0 t1 th1 t2]', 'words', '[t3]', 'more', 'end'])
  // Keyed by its first call, so its open state holds as the run grows.
  expect(rows[1]!.key).toBe('at1')
})

test('a run of thoughts alone shows only while it is being thought', () => {
  const entries = [said('a'), said('th', 'thinking'), said('b')]

  expect(shape(activityRuns(entries))).toEqual(['a', 'b'])
  expect(shape(activityRuns(entries, e => e.key === 'th'))).toEqual(['a', '[th]', 'b'])
})

test('the task-list tools are left out of runs entirely', () => {
  const rows = activityRuns([
    said('a'),
    call('1', 'mcp__ccd_turn__update_plan'),
    call('2', 'Bash'),
    call('3', 'mcp__ccd_turn__wrap_up'),
    said('b'),
    call('4', 'mcp__ccd_turn__update_plan'),
  ])

  expect(shape(rows)).toEqual(['a', '[t2]', 'b'])
})

test('tools fall into kinds of work', () => {
  expect(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'mcp__x__y'].map(categoryOf)).toEqual([
    'read',
    'edit',
    'edit',
    'edit',
    'edit',
    'bash',
    'search',
    'search',
    'web',
    'web',
    'agent',
    'agent',
    'other',
  ])
})

test('a run reads as its kinds of work counted, most first, with failures apart', () => {
  const calls: ActivityCall[] = [
    ok('Read'),
    ok('Bash'),
    ok('Bash'),
    { ...ok('Bash'), state: 'error' },
    ok('Read'),
    ok('Grep'),
    ok('Edit', 'Editing a.ts', { path: '/a.ts' }),
    ok('Edit', 'Editing a.ts', { path: '/a.ts' }),
    ok('Write', 'Writing b.ts', { path: '/b.ts' }),
    ok('WebFetch'),
    ok('Agent'),
    ok('mcp__x__y'),
  ]

  expect(activitySummary(calls)).toEqual({
    text: 'Ran 3 commands, read 2 files, edited 2 files, searched once, 1 web lookup, started 1 agent, 1 other tool',
    failed: 1,
  })
  expect(activitySummary([ok('Grep'), ok('Glob'), ok('Read')]).text).toBe('Searched 2 times, read 1 file')
})

test('a run of one call says it in the past, with its own words', () => {
  expect(activitySummary([ok('Edit', 'Editing headroom.tsx')]).text).toBe('Edited headroom.tsx')
  expect(activitySummary([ok('Bash', 'Check compact number formatter')]).text).toBe('Ran: Check compact number formatter')
  expect(doneLabel('Read', 'Reading pill.ts')).toBe('Read pill.ts')
  expect(doneLabel('Grep', 'Searching for mascot')).toBe('Searched for mascot')
  expect(doneLabel('mcp__x__y', 'Using x y')).toBe('Used x y')
})

test('while a call runs, the line says what it is doing now', () => {
  const now = activitySummary([ok('Read'), { tool: 'Bash', label: 'Check the build', state: 'running' }, { ...ok('Grep'), state: 'error' }])

  expect(now).toEqual({ text: 'Running a command · Check the build', failed: 1, running: 'Check the build' })
  expect(runningLabel('Read', 'Reading pill.ts')).toBe('Reading pill.ts')
  expect(activitySummary([])).toEqual({ text: '', failed: 0 })
})

test('opened, a run is a row per call and one per stretch of thoughts', () => {
  const rows = runRows([said('a', 'thinking'), said('b', 'thinking'), call('1'), said('c', 'thinking'), call('2')])

  expect(rows.map(r => (r.kind === 'tool' ? r.entry.key : `${r.key}×${r.texts.length}`))).toEqual(['a×2', 't1', 'c×1', 't2'])
})

test('a call names the file it touched', () => {
  const rows = chatEntries([{ role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: '/r/a.ts' } }] }])

  expect(rows[0]).toMatchObject({ kind: 'tool', path: '/r/a.ts', label: 'Editing a.ts' })
})
