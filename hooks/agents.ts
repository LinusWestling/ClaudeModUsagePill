import type { AgentRun, AgentStatus } from '../types'
import { pickOutfit } from './mascot'

export const PANE = 'usage-pill-agents'
export const PANE_TITLE = 'Subagents'

const MAX_RUNS = 50

/** Applies `patch` to the agent, adding it if this is the first word of it. */
export const upsertRun = (
  runs: AgentRun[],
  id: string,
  patch: Partial<AgentRun>,
  now: number,
): AgentRun[] => {
  const known = runs.find(r => r.id === id)

  if (!known) {
    const run: AgentRun = {
      id,
      description: '',
      type: '',
      status: 'running',
      tools: 0,
      steps: [],
      startedAt: now,
      outfit: pickOutfit(patch.type ?? '', runs.map(r => r.outfit)),
      ...patch,
    }

    return [...runs, run].slice(-MAX_RUNS)
  }

  // Its loop can speak before the spawn answers, when the type wasn't known yet.
  const outfit =
    !known.type && patch.type
      ? pickOutfit(patch.type, runs.filter(r => r.id !== id).map(r => r.outfit))
      : known.outfit

  return runs.map(r => (r.id === id ? { ...r, outfit, ...patch } : r))
}

export const statusOf = (reason: string): AgentStatus =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'

export const isRunning = (run: AgentRun) => run.status === 'running'

/** `claude-opus-5-5` reads Opus 5.5, an alias reads Haiku, and anything else stays as it is. */
export const shortModel = (model: string | undefined): string => {
  if (!model) return 'Model unknown'

  const match = /(fable|opus|sonnet|haiku)(?:-(\d{1,2}))?(?:-(\d{1,2}))?(?![\d])/i.exec(model)

  if (!match) return model

  const name = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1).toLowerCase()
  const version = [match[2], match[3]].filter(Boolean).join('.')

  return version ? `${name} ${version}` : name
}

export const effortLabel = (effort: string | number | undefined): string =>
  effort === undefined ? 'default effort' : `${effort} effort`

const base = (path: unknown): string => String(path ?? '').split(/[\\/]/).pop() ?? ''

const cut = (text: string, room = 80): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length > room ? `${line.slice(0, room - 1)}…` : line
}

const hostOf = (url: unknown): string =>
  /^\w+:\/\/([^/]+)/.exec(String(url ?? ''))?.[1] ?? String(url ?? '')

/** What a tool call is doing, in a few words. */
export const describeTool = (tool: string, args: Record<string, unknown>): string => {
  switch (tool) {
    case 'Read':
      return cut(`Reading ${base(args.file_path)}`)
    case 'Edit':
    case 'NotebookEdit':
      return cut(`Editing ${base(args.file_path ?? args.notebook_path)}`)
    case 'Write':
      return cut(`Writing ${base(args.file_path)}`)
    case 'Bash':
    case 'PowerShell':
      return cut(String(args.description ?? args.command ?? tool))
    case 'Grep':
      return cut(`Searching for ${String(args.pattern ?? '')}`)
    case 'Glob':
      return cut(`Finding ${String(args.pattern ?? '')}`)
    case 'WebFetch':
      return cut(`Fetching ${hostOf(args.url)}`)
    case 'WebSearch':
      return cut(`Searching the web: ${String(args.query ?? '')}`)
    case 'Agent':
      return cut(`Starting an agent: ${String(args.description ?? '')}`)
    default:
      return cut(`Using ${tool.replace(/^mcp__/, '').replace(/__/g, ' ')}`)
  }
}

export const compact = (n: number): string => {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`

  return `${n}`
}

export const elapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) return `${seconds}s`

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

/** The figures really known of its progress: no agent says how far along it is. */
export const progressLine = (run: AgentRun, now: number): string => {
  const done = run.steps.filter(s => s.status === 'completed').length
  const parts = [
    run.steps.length > 0 ? `${done}/${run.steps.length} steps` : undefined,
    `${run.tools} ${run.tools === 1 ? 'tool' : 'tools'}`,
    elapsed((run.endedAt ?? now) - run.startedAt),
    run.tokens === undefined ? undefined : `${compact(run.tokens)} tokens`,
  ]

  return parts.filter(Boolean).join(' · ')
}

// Types every agent call can name without saying anything about the work.
const PLAIN_TYPES = new Set(['', 'general-purpose', 'claude'])

/** Model, then effort and type only where they say something: the defaults are noise. */
export const metaLine = (run: AgentRun): string =>
  [
    shortModel(run.model),
    run.effort === undefined || run.effort === 'medium' ? undefined : effortLabel(run.effort),
    PLAIN_TYPES.has(run.type) ? undefined : run.type,
  ]
    .filter(Boolean)
    .join(' · ')

/** The opening sentence of a report, its markdown dropped: what the agent found, in a line. */
export const firstSentence = (text: string, room = 140): string => {
  const lines = text.split('\n').filter(l => l.trim().length > 0 && !/^[-=|:\s]+$/.test(l))
  // A heading names the report; its first line of prose says what was found.
  const line = lines.find(l => !/^\s*#/.test(l)) ?? lines[0] ?? ''
  const plain = line
    .replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
  const sentence = /^.+?[.!?](?=\s|$)/.exec(plain)?.[0] ?? plain

  return cut(sentence, room)
}

/** How a finished run ended, with how long it took: `✓ 43s`, `Stopped · 12s`. */
export const endLabel = (run: AgentRun, now: number): string => {
  const took = elapsed((run.endedAt ?? now) - run.startedAt)

  return run.status === 'done'
    ? `✓ ${took}`
    : run.status === 'stopped'
      ? `Stopped · ${took}`
      : run.status === 'failed'
        ? `Failed · ${took}`
        : took
}

/** The heading: counts, then the span from the first start to the last end, and tokens. */
export const summaryLine = (runs: AgentRun[], now: number): { counts: string; totals: string } => {
  if (runs.length === 0) return { counts: 'No subagents yet', totals: '' }

  const running = runs.filter(isRunning).length
  const finished = runs.length - running
  const counts =
    running === 0
      ? `All ${finished} finished`
      : finished === 0
        ? `${running} running`
        : `${running} running · ${finished} finished`
  const start = Math.min(...runs.map(r => r.startedAt))
  const end = running > 0 ? now : Math.max(...runs.map(r => r.endedAt ?? now))
  const tokens = runs.reduce((sum, r) => sum + (r.tokens ?? 0), 0)

  return {
    counts,
    totals: [elapsed(end - start), tokens > 0 ? `${compact(tokens)} tokens` : undefined]
      .filter(Boolean)
      .join(' · '),
  }
}
