import { expect, test } from 'claude-code/testing'

import type { ToolEntry } from '../types'
import { bashLabel, duration, feedView, fileLabel, finishTool, settleTools, shortPath, spinnerFrame, spinnerSvg, startTool } from '../hooks/feed'
import { describeTool } from '../hooks/agents'
import { mascotSvg } from '../hooks/mascot'

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

test('a shell call reads as its description, else its command without the leading cd', () => {
  expect(bashLabel({ description: 'Run tests', command: 'npm test' })).toBe('Run tests')
  expect(bashLabel({ command: 'cd /Users/me/.claude/dev-mods/abc/usage-pill && npm test' })).toBe('npm test')
  expect(bashLabel({ command: "cd '/Users/me/x y'; ls -la" })).toBe('ls -la')
  expect(bashLabel({ command: 'git status' })).toBe('git status')
  expect(bashLabel({})).toBe('Bash')
  expect(describeTool('Bash', { command: 'cd /Users/me/.claude/dev-mods/85f2b57a/usage-pill && claude plugin test .' })).toBe('claude plugin test .')
})

test('paths in a label lose the home folder and all but their last two segments', () => {
  expect(shortPath('/Users/me/notes.md')).toBe('~/notes.md')
  expect(shortPath('/Users/me/a/b')).toBe('~/a/b')
  expect(shortPath('/Users/me/.claude/dev-mods/85f2b57a/usage-pill')).toBe('…/85f2b57a/usage-pill')
  expect(shortPath('/var/log/system/deep/file.log')).toBe('…/deep/file.log')
  expect(bashLabel({ command: 'ls /Users/me/.claude/dev-mods/85f2b57a/usage-pill/hooks' })).toBe('ls …/usage-pill/hooks')
})

test('file tools show the file name, with its folder for a bare index', () => {
  expect(fileLabel('/Users/me/a/b/pill.ts')).toBe('pill.ts')
  expect(fileLabel('/Users/me/site/blog/index.html')).toBe('blog/index.html')
  expect(describeTool('Read', { file_path: '/Users/me/a/pill.ts' })).toBe('Reading pill.ts')
  expect(describeTool('Edit', { file_path: 'C:\\Users\\me\\a\\x.ts' })).toBe('Editing x.ts')
})

test('animations lock to the wall clock, so a redraw carries on instead of restarting', () => {
  expect(spinnerSvg(12, undefined, 1_000_300)).toContain('animation-delay:-300ms')
  expect(spinnerSvg(12, undefined, 1_000_300)).toBe(spinnerSvg(12, undefined, 2_000_300))
  expect(mascotSvg('moving', undefined, 28, 1_000_120)).toContain('animation-delay:-120ms')
})
