import type { Step, Task } from '../types'

export const NO_TASK: Task = { steps: [], tools: 0 }

export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

type PlanArgs = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: boolean
  done?: number[]
  start?: number
}

const toStep = (item: { content?: unknown; status?: unknown }): Step => ({
  content: String(item.content ?? ''),
  status:
    item.status === 'completed' || item.status === 'in_progress'
      ? item.status
      : 'pending',
})

/** What a task-list call does to the steps, by its own three ways of saying it. */
export const applyPlan = (steps: Step[], args: PlanArgs): Step[] => {
  if (args.items) return args.items.map(toStep)

  let next = steps

  if (args.advance) {
    const pending = next.findIndex(s => s.status === 'pending')
    next = next.map((s, i) =>
      s.status === 'in_progress'
        ? { ...s, status: 'completed' as const }
        : i === pending
          ? { ...s, status: 'in_progress' as const }
          : s,
    )
  }

  if (args.done || args.start !== undefined) {
    next = next.map((s, i) =>
      args.done?.includes(i + 1)
        ? { ...s, status: 'completed' as const }
        : args.start === i + 1
          ? { ...s, status: 'in_progress' as const }
          : s,
    )
  }

  return next
}

export const finishPlan = (steps: Step[]): Step[] =>
  steps.map(s => ({ ...s, status: 'completed' as const }))

export type TaskView = {
  label: string
  /** Absent: no list of steps, so the bar sweeps instead of filling. */
  steps?: Step[]
  count: string
}

export const viewTask = (task: Task, isWorking: boolean): TaskView | undefined => {
  if (task.steps.length === 0) {
    if (!isWorking) return undefined

    return { label: 'Working', count: '' }
  }

  const done = task.steps.filter(s => s.status === 'completed').length

  // A fixed word: the segments and the count are what mirror the process.
  return {
    label: done === task.steps.length ? 'Done' : 'Working',
    steps: task.steps,
    count: `${done}/${task.steps.length}`,
  }
}
