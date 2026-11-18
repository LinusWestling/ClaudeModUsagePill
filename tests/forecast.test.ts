import { expect, test } from 'claude-code/testing'

import { WINDOW_MS, addSample, forecastChartSvg, forecastOf, inWindow, outLabel, span } from '../hooks/forecast'

const NOW = Date.parse('2026-11-17T12:00:00Z')
const RESETS = '2026-11-17T14:00:00Z'
const MIN = 60_000

const limit = (percentUsed: number, resetsAt = RESETS) => ({ kind: 'five_hour', percentUsed, resetsAt })
const at = (minutesAgo: number, percent: number) => ({ at: NOW - minutesAgo * MIN, percent })

test('the pace over the last hour and a half says when the window runs out', () => {
  const samples = [at(60, 20), at(30, 35), at(0, 50)]
  const forecast = forecastOf(samples, limit(50), NOW)

  expect(forecast?.pacePerHour).toBe(30)
  // 50 points left at 30 an hour: 100 minutes, before the reset at 14:00.
  expect(forecast?.runsOutAt).toBe(NOW + 100 * MIN)
})

test('a pace that reaches 100% only after the reset runs out of nothing', () => {
  const forecast = forecastOf([at(60, 20), at(0, 30)], limit(30), NOW)

  expect(forecast?.pacePerHour).toBe(10)
  expect(forecast?.runsOutAt).toBe(undefined)
  expect(forecast?.atReset).toBe(50)
})

test('too few samples, or too close together, make no forecast', () => {
  expect(forecastOf([at(0, 50)], limit(50), NOW)).toBe(undefined)
  expect(forecastOf([at(5, 40), at(0, 50)], limit(50), NOW)).toBe(undefined)
  expect(forecastOf([], limit(50), NOW)).toBe(undefined)
})

test('samples from before the reset, or older than the lookback, are left out', () => {
  const before = { at: Date.parse(RESETS) - WINDOW_MS - MIN, percent: 0 }

  // The window began at 09:00; a reading of the window before it says nothing.
  expect(inWindow([before, at(30, 10)], Date.parse(RESETS)).length).toBe(1)
  // Two hours ago is outside the 90 minutes read, so one sample is left: no pace.
  expect(forecastOf([at(120, 0), at(0, 50)], limit(50), NOW)).toBe(undefined)
})

test('a window that has reset, or has no reset time, makes no forecast', () => {
  const samples = [at(60, 20), at(0, 50)]

  expect(forecastOf(samples, limit(50, '2026-11-17T11:00:00Z'), NOW)).toBe(undefined)
  expect(forecastOf(samples, { kind: 'five_hour', percentUsed: 50 }, NOW)).toBe(undefined)
})

test('the latest reading holds until now, so idling slows the pace', () => {
  // Last moved 30 minutes ago: the pace runs from 60 minutes ago to now.
  const forecast = forecastOf([at(60, 20), at(30, 50)], limit(50), NOW)

  expect(forecast?.pacePerHour).toBe(30)
  expect(forecast?.to).toEqual({ at: NOW, percent: 50 })
})

test('a full window is out now', () => {
  expect(forecastOf([at(30, 90), at(0, 100)], limit(100), NOW)?.runsOutAt).toBe(NOW)
  expect(outLabel(NOW, NOW)).toBe('out now')
})

test('samples: a reading that has not moved is kept every few minutes, a lower one never', () => {
  const resets = Date.parse(RESETS)
  let samples = addSample([], at(10, 20), resets)

  samples = addSample(samples, at(9, 20), resets)
  expect(samples.length).toBe(1)
  samples = addSample(samples, at(4, 20), resets)
  expect(samples.length).toBe(2)
  samples = addSample(samples, at(3, 15), resets)
  expect(samples.length).toBe(2)
  samples = addSample(samples, at(2, 21), resets)
  expect(samples.map(s => s.percent)).toEqual([20, 20, 21])
})

test('the run-out time reads as a clock in the local zone, or as a span where none is known', () => {
  const out = NOW + 100 * MIN

  expect(outLabel(out, NOW, 'Europe/Stockholm')).toBe('out ~14:40')
  expect(outLabel(out, NOW, 'America/New_York')).toBe('out ~08:40')
  expect(outLabel(out, NOW, 'UTC')).toBe('out in 1h 40m')
  expect(span(45 * MIN)).toBe('45m')
  expect(span(120 * MIN)).toBe('2h')
})

test('the chart draws the used line, the dashed pace and the red limit', () => {
  const samples = [at(60, 20), at(30, 35), at(0, 50)]
  const forecast = forecastOf(samples, limit(50), NOW)
  const svg = forecastChartSvg(samples, forecast, RESETS, 320, 120)

  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg.includes('width="320" height="120"')).toBe(true)
  expect(svg.includes('class="used"')).toBe(true)
  expect(svg.includes('class="pace"')).toBe(true)
  expect(svg.includes('class="limit"')).toBe(true)
  expect(svg.includes('class="out"')).toBe(true)

  // No forecast: the used line alone.
  const plain = forecastChartSvg(samples, undefined, Date.parse(RESETS), 320, 120)

  expect(plain.includes('class="pace"')).toBe(false)
  expect(plain.includes('class="used"')).toBe(true)
})
