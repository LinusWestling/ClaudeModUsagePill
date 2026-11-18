import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { Ledger, Spend } from '../types'
import { shortModel } from './agents'

/** The side pane of earlier builds, which the popover under the bar replaced: closed at start. */
export const RECEIPT_PANE = 'usage-pill-receipt'

/** More agents than this are grouped by the model that ran them. */
export const GROUP_ABOVE = 6

export const NO_SPEND: Spend = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 }
export const NO_LEDGER: Ledger = { main: NO_SPEND, agents: {} }

const ledger = atom({ plugin: 'usage-pill', key: 'ledger' } as const, NO_LEDGER)

/** What one request adds to a loop's spend. */
export const addUsage = <S extends Spend>(spend: S, usage: ModelUsage): S => ({
  ...spend,
  input: spend.input + usage.input_tokens,
  cacheRead: spend.cacheRead + usage.cache_read_input_tokens,
  cacheWrite: spend.cacheWrite + usage.cache_creation_input_tokens,
  output: spend.output + usage.output_tokens,
  requests: spend.requests + 1,
})

/** Every token the loop's requests carried or wrote. */
export const totalOf = (s: Spend): number => s.input + s.cacheRead + s.cacheWrite + s.output

/** How much of what the main thread read came from the prompt cache, 0 to 1; undefined before any request. */
export const cacheHit = (s: Spend): number | undefined => {
  const all = s.input + s.cacheRead + s.cacheWrite

  return all === 0 ? undefined : s.cacheRead / all
}

export type Share = { key: string; label: string; tokens: number; fraction: number }

/**
 * Who spent the tokens, biggest first, the main thread among them: each agent on
 * its own, or grouped by model once there are more than `GROUP_ABOVE` of them.
 */
export const shares = (l: Ledger, groupAbove = GROUP_ABOVE): Share[] => {
  const agents = Object.entries(l.agents)
  const rows: { key: string; label: string; tokens: number }[] = [
    { key: 'main', label: 'Main thread', tokens: totalOf(l.main) },
  ]

  if (agents.length > groupAbove) {
    const byModel = new Map<string, { label: string; tokens: number; count: number }>()

    for (const [, a] of agents) {
      const name = shortModel(a.model)
      const row = byModel.get(name) ?? { label: name, tokens: 0, count: 0 }

      byModel.set(name, { label: name, tokens: row.tokens + totalOf(a), count: row.count + 1 })
    }

    for (const [name, row] of byModel) {
      rows.push({ key: `model-${name}`, label: `${row.label} · ${row.count} agents`, tokens: row.tokens })
    }
  } else {
    for (const [id, a] of agents) rows.push({ key: `agent-${id}`, label: a.label, tokens: totalOf(a) })
  }

  const sum = rows.reduce((n, r) => n + r.tokens, 0)

  return rows
    .map(r => ({ ...r, fraction: sum === 0 ? 0 : r.tokens / sum }))
    .sort((x, y) => y.tokens - x.tokens)
}

/**
 * How far a window has moved since the session began. A window that reset in
 * between reads lower than it started: what is used now is all since the reset.
 */
export const usedSince = (now: number | undefined, start: number | undefined): number | undefined => {
  if (now === undefined) return undefined
  if (start === undefined) return undefined

  return Math.round(now >= start ? now - start : now)
}

const TRACK = '░'
const FILL = '█'

/** A bar for the terminal: whole blocks, at least one for anything non-zero. */
export const blockBar = (fraction: number, width = 14): string => {
  const filled = fraction <= 0 ? 0 : Math.max(1, Math.round(fraction * width))

  return FILL.repeat(Math.min(width, filled)) + TRACK.repeat(Math.max(0, width - filled))
}

/** A thin bar for surfaces that draw pictures. */
export const barSvg = (fraction: number, color: string, width = 240, height = 6): string => {
  const filled = fraction <= 0 ? 0 : Math.max(height, Math.round(fraction * width))
  const r = height / 2

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="#888" fill-opacity="0.25"/>` +
    (filled > 0 ? `<rect width="${Math.min(width, filled)}" height="${height}" rx="${r}" fill="${color}"/>` : '') +
    `</svg>`
  )
}

const emptyAgent = (label: string, model?: string) => ({ ...NO_SPEND, label, model })

/** Records the first reading of each window this session saw. */
const rememberStart = async ($: EngineInterface) => {
  const current = await read($, ledger)

  if (current.sessionLimitAtStart !== undefined && current.weekLimitAtStart !== undefined) return

  const usage = await $.session.usage()
  const five = usage.rateLimits.find(l => l.kind === 'five_hour')?.percentUsed
  const week = usage.rateLimits.find(l => l.kind === 'seven_day')?.percentUsed

  if (five === undefined && week === undefined) return

  await update($, ledger, l => ({
    ...l,
    sessionLimitAtStart: l.sessionLimitAtStart ?? five,
    weekLimitAtStart: l.weekLimitAtStart ?? week,
  }))
}

export const registerReceipt = (on: Parameters<Register>[0], _options?: Parameters<Register>[1]) => {
  on('session.start', {}, async ($, e, next) => {
    const result = await next(e)

    await rememberStart($).catch(() => undefined)

    return result
  })

  // The spawn names the agent; its first request may come before the spawn returns.
  on('agent.spawn', {}, async ($, e, next) => {
    const result = await next(e)
    const id = result.agentId

    if (id) {
      const label = e.description || e.subagentType || 'Subagent'

      await update($, ledger, l => ({
        ...l,
        agents: {
          ...l.agents,
          [id]: { ...(l.agents[id] ?? emptyAgent(label, result.model)), label, model: result.model ?? l.agents[id]?.model },
        },
      }))
    }

    return result
  })

  on('turn.step', {}, async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result.usage

    if (usage) {
      const id = e.agentId

      await update($, ledger, l =>
        id === undefined
          ? { ...l, main: addUsage(l.main, usage) }
          : {
              ...l,
              agents: {
                ...l.agents,
                [id]: addUsage(l.agents[id] ?? emptyAgent('Subagent', e.model), usage),
              },
            },
      )

      // Late: a session measured only now still gets a start to count from.
      if (id === undefined) await rememberStart($).catch(() => undefined)
    }

    return result
  })
}
