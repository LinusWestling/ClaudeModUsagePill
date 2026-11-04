import { expect, test } from 'claude-code/testing'

import { MACOS, WINDOWS, buildPill } from '../hooks/pill'

const placed = (fit: typeof MACOS) => {
  const { source } = buildPill(
    {
      task: { label: 'Agents', count: '1' },
      mascot: { running: 1 },
      isWorking: true,
    },
    800,
    fit,
  )
  const found = /translate\(([\d.-]+) ([\d.-]+)\) scale/.exec(source)

  return { x: Number(found?.[1]), y: Number(found?.[2]) }
}

test('on a Mac the mascot sits centred in the highlight, measured from a screenshot', () => {
  // The row's middle is 30 down, and the 32px mascot is centred on it.
  expect(placed(MACOS).y).toBe(14)
  expect(placed(MACOS).x).toBe(placed({ ...MACOS, mascot: { x: 0, y: 0 } }).x - 4)
})

test('on Windows the mascot stays where it was measured', () => {
  expect(placed(WINDOWS).y).toBe(19)
})
