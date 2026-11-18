import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentRun, Task } from '../types'
import { elapsed } from './agents'
import { NO_TASK } from './task'

export const NOTIFY_KEY = 'turn-done'

/**
 * How long a client holds the notification before raising it. With `untilBack` it
 * is dropped if the person returns to the session in that time, so it only reaches
 * someone who has left.
 */
export const NOTIFY_DELAY_MS = 20_000

const turnStartedAt = atom({ plugin: 'usage-pill', key: 'turnStartedAt' } as const, null)
// The same declarations as register.tsx's: one value, read from two places.
const task = atom({ plugin: 'usage-pill', key: 'task' } as const, NO_TASK)
const agents = atom({ plugin: 'usage-pill', key: 'agents' } as const, [], { shape: 'agents-1' })

/** `6m 12s · 5/5 steps · 3 agents`: what the turn did, in the words the pill uses. */
export const doneBody = (ms: number, current: Task, runs: readonly AgentRun[], since: number): string => {
  const steps = current.steps.length
  const started = runs.filter(r => r.startedAt >= since).length

  return [
    elapsed(ms),
    steps > 0 ? `${current.steps.filter(s => s.status === 'completed').length}/${steps} steps` : undefined,
    started > 0 ? `${started} ${started === 1 ? 'agent' : 'agents'}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

export const registerNotify = (on: Parameters<Register>[0], options: Parameters<Register>[1] = {}) => {
  on('turn.start', {}, async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, turnStartedAt, () => now)
    }

    return next(e)
  })

  // A new prompt means the person is back: what is booked for them is stale.
  on('prompt.submit', {}, async ($, e, next) => {
    // A Claude Code older than `cancelNotify` (2.1.318 has none) throws before any promise.
    try {
      await $.ui.cancelNotify(NOTIFY_KEY)
    } catch {
      // Nothing to take back.
    }

    return next(e)
  })

  on('turn.complete', {}, async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) return result

    const since = await read($, turnStartedAt)

    await update($, turnStartedAt, () => null)

    const isOn = options.notifyOnDone !== false
    const minutes = typeof options.notifyAfterMinutes === 'number' ? options.notifyAfterMinutes : 2

    if (!isOn || since === null || e.reason === 'aborted') return result

    const ms = (await $.clock.now()) - since

    if (ms < minutes * 60_000) return result

    const body = doneBody(ms, await read($, task), await read($, agents), since)

    // Held a moment by the client and thrown away if the person is back by then.
    await $.ui
      .notify(body, { title: 'Claude finished', key: NOTIFY_KEY, delayMs: NOTIFY_DELAY_MS, untilBack: true })
      .catch(() => undefined)

    return result
  })
}
