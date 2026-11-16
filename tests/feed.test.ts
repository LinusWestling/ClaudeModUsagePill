import { expect, test } from 'claude-code/testing'

import type { ToolEntry } from '../types'
import { duration, feedView, finishTool, settleTools, spinnerFrame, startTool } from '../hooks/feed'

const call = (id: string, startedAt = 0): ToolEntry => ({ id, tool: 'Read', label: `Reading ${id}`, startedAt, status: 'running' })

test('calls join at the end, once each, and the oldest leave past the cap', () => {
  let feed: ToolEntry[] = []
  for (const id of ['a', 'b', 'c', 'b']) feed = startTool(feed, call(id), 3)

  expect(feed.map(f => f.id)).toEqual(['a', 'c', 'b'])
  expect(startTool(feed, call('d'), 3).map(f => f.id)).toEqual(['c', 'b', 'd'])
})

test('a call settles where it stands, and what still runs ends with its agent', () => {
  const feed = [call('a'), call('b', 5)]
  const settled = finishTool(feed, 'a', 400, false)

  expect(settled[0]).toMatchObject({ status: 'ok', endedAt: 400 })
  expect(finishTool(feed, 'b', 900, true)[1]).toMatchObject({ status: 'error', endedAt: 900 })
  expect(finishTool(feed, 'gone', 1, false)).toEqual(feed)
  expect(settleTools(settled, 1_000, true).map(f => f.status)).toEqual(['ok', 'error'])
})

test('a card shows the latest calls, newest last, and counts the rest', () => {
  const feed = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => call(id))

  expect(feedView(feed, false)).toMatchObject({ hidden: 2 })
  expect(feedView(feed, false).rows.map(r => r.id)).toEqual(['c', 'd', 'e', 'f', 'g'])
  expect(feedView(feed, true)).toMatchObject({ hidden: 0 })
  expect(feedView(feed, true).rows.length).toBe(7)
  expect(feedView(feed.slice(0, 2), false)).toMatchObject({ hidden: 0 })
})

test('times read in tenths for quick calls, and the spinner turns', () => {
  expect(duration(420)).toBe('0.4s')
  expect(duration(9_960)).toBe('10.0s')
  expect(duration(12_400)).toBe('12s')
  expect(duration(75_000)).toBe('1m 15s')
  expect(duration(-5)).toBe('0.0s')
  expect(spinnerFrame(0) === spinnerFrame(1)).toBe(false)
  expect(spinnerFrame(10)).toBe(spinnerFrame(0))
})
