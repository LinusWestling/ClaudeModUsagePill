import { expect, test } from 'claude-code/testing'

import { applyChunk, chatEntries, isDue, liveToolLabel, newTail, pendingBlocks, reportOf } from '../hooks/chat'

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
