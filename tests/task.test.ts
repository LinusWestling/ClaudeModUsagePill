import { expect, test } from 'claude-code/testing'

import { applyPlan, finishPlan, viewTask } from '../hooks/task'

const items = [
  { content: 'a', status: 'in_progress' },
  { content: 'b', status: 'pending' },
  { content: 'c', status: 'pending' },
]

const statuses = (steps: { status: string }[]) => steps.map(s => s.status).join()

test('a list of items replaces the steps', () => {
  expect(statuses(applyPlan([], { items }))).toBe('in_progress,pending,pending')
})

test('advance completes the current step and starts the next', () => {
  const steps = applyPlan(applyPlan([], { items }), { advance: true })
  expect(statuses(steps)).toBe('completed,in_progress,pending')
})

test('done and start move steps out of order, counted from one', () => {
  const steps = applyPlan(applyPlan([], { items }), { done: [1, 2], start: 3 })
  expect(statuses(steps)).toBe('completed,completed,in_progress')
})

test('a wrap-up finishes the list and the view says so', () => {
  const steps = finishPlan(applyPlan([], { items }))
  const view = viewTask({ steps, tools: 0 }, false)
  expect(view?.label).toBe('Done')
  expect(view?.count).toBe('3/3')
})

test('idle with no steps there is no task to show', () => {
  expect(viewTask({ steps: [], tools: 4 }, false)).toBeUndefined()
  expect(viewTask({ steps: [], tools: 4 }, true)?.label).toBe('Working')
})
