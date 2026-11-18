import { expect, test } from 'claude-code/testing'

import type { Cache } from '../types'
import { LOG_MAX, appendLog, hitOf, isColdStart, nextCost, savedOf, splitBarSvg, stripSvg, stripText } from '../hooks/cache'

const WARM = { read: 400_000, written: 9_000, uncached: 1_000, at: 1 }
const COLD = { read: 0, written: 30_000, uncached: 10, at: 2 }

test('the next message costs a tenth warm and twice cold, in token-equivalents', () => {
  expect(nextCost(WARM)).toEqual({ tokens: 410_000, warm: 41_000, cold: 820_000 })
})

test('what was read from the cache is saved at nine tenths', () => {
  expect(savedOf({ input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0, requests: 1 })).toBe(900_000)
})

test('a request that wrote more than it read is a cold start', () => {
  expect(isColdStart(COLD)).toBe(true)
  expect(isColdStart(WARM)).toBe(false)
  expect(Math.round(hitOf(WARM) * 100)).toBe(98)
  expect(hitOf({ read: 0, written: 0, uncached: 0 })).toBe(0)
})

test('the log keeps the latest requests only', () => {
  let log: Cache[] = []

  for (let i = 0; i < LOG_MAX + 5; i++) log = appendLog(log, { ...WARM, at: i })

  expect(log.length).toBe(LOG_MAX)
  expect(log[0]!.at).toBe(5)
})

test('the strip marks cold starts and fits its width', () => {
  expect(stripText([COLD, WARM, WARM], 2)).toBe('██')
  expect(stripText([COLD, WARM], 10)).toBe('×█')
  expect((stripSvg([COLD, WARM, WARM], 10, 14).match(/<rect /g) ?? []).length).toBe(2)
  expect(splitBarSvg([{ tokens: 0, color: '#000' }], 100, 6).includes('<g clip-path="url(#cache-split-clip)"></g>')).toBe(true)
})
