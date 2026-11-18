import type { TurnStepChunk } from 'claude-code'

import type { LiveBlock, LiveTail } from '../types'
import { describeTool } from './agents'
import { PLAN_TOOL, WRAP_UP_TOOL } from './task'

/**
 * The pane an earlier version opened for a subagent's chat. The chat now shows
 * in the Subagents pane itself; this id is only closed, should one be left open.
 */
export const LEGACY_TRANSCRIPT_PANE = 'usage-pill-transcript'

/** How often a streaming step writes what it has so far: smooth, without a redraw per token. */
export const FLUSH_MS = 200

/** The latest rows the pane draws; earlier ones are counted, not drawn. */
export const MAX_ENTRIES = 80

export type ChatEntry = { key: string; at: number } & (
  | { kind: 'prompt' | 'text' | 'thinking'; text: string }
  | {
      kind: 'tool'
      id: string
      tool: string
      label: string
      /** Its arguments as JSON, clipped. */
      input: string
      /** The file it read or changed, where its arguments name one. */
      path?: string
      /** What the model read back, clipped; absent while it runs. */
      result?: string
      isError?: boolean
    }
)

/** A message in the Messages API form `$.session.messages({ as: 'api' })` answers. */
type ApiLike = { role: 'user' | 'assistant'; content: unknown }

type Block = { type?: unknown; [field: string]: unknown }

const clip = (text: string, room: number): string =>
  text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text

const blocksOf = (content: unknown): Block[] =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : Array.isArray(content)
      ? content.filter((b): b is Block => typeof b === 'object' && b !== null)
      : []

/** A tool_result's content as the model read it: a string, or its text blocks joined. */
const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : blocksOf(content)
        .map(b => (b.type === 'text' ? String(b.text ?? '') : b.type === 'image' ? '[image]' : ''))
        .filter(Boolean)
        .join('\n')

// What the engine adds to a user message for the model, not what anyone wrote.
const isReminder = (text: string) => /^\s*<system-reminder>/.test(text)

const json = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

/**
 * An agent's conversation as chat rows: what it was asked, what it thought and
 * said, and each tool it ran with its outcome paired on. `at` is the message's
 * place, so the streaming step can tell which rows are its own.
 */
export const chatEntries = (messages: readonly ApiLike[]): ChatEntry[] => {
  const rows: ChatEntry[] = []
  const tools = new Map<string, Extract<ChatEntry, { kind: 'tool' }>>()

  messages.forEach((m, at) => {
    blocksOf(m.content).forEach((b, j) => {
      const key = `m${at}.${j}`

      if (b.type === 'text') {
        const text = String(b.text ?? '').trim()

        if (!text || isReminder(text)) return

        rows.push({ key, at, kind: m.role === 'user' ? 'prompt' : 'text', text: clip(text, 8_000) })
      } else if (b.type === 'thinking') {
        const text = String(b.thinking ?? '').trim()

        rows.push({ key, at, kind: 'thinking', text: clip(text, 4_000) })
      } else if (b.type === 'tool_use') {
        const id = String(b.id ?? key)
        const tool = String(b.name ?? 'tool')
        const input = (typeof b.input === 'object' && b.input !== null ? b.input : {}) as Record<string, unknown>
        const row = {
          key: `t${id}`,
          at,
          kind: 'tool' as const,
          id,
          tool,
          label: describeTool(tool, input),
          input: clip(json(input), 3_000),
          ...(typeof (input.file_path ?? input.notebook_path) === 'string'
            ? { path: String(input.file_path ?? input.notebook_path) }
            : {}),
        }

        tools.set(id, row)
        rows.push(row)
      } else if (b.type === 'tool_result') {
        const row = tools.get(String(b.tool_use_id ?? ''))

        if (row) {
          row.result = clip(resultText(b.content).trim(), 2_000)
          if (b.is_error === true) row.isError = true
        }
      }
    })
  })

  return rows
}

/** The agent's last words: its report once it has finished. */
export const reportOf = (entries: readonly ChatEntry[]): string | undefined => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!

    if (entry.kind === 'text') return entry.text
    if (entry.kind === 'prompt') return undefined
  }

  return undefined
}

/** A fresh tail for a step that is about to stream. */
export const newTail = (turnId: string, step: number, from: number): LiveTail => ({
  turnId,
  step,
  from,
  blocks: [],
  isDone: false,
})

/**
 * What a chunk adds to the tail: text and thinking grow their block, a tool
 * starts one, its arguments grow it. The tail itself when nothing changes, so a
 * caller can tell there is nothing to write.
 */
export const applyChunk = (tail: LiveTail, chunk: TurnStepChunk): LiveTail => {
  const grow = (index: number, more: string, room: number, start?: LiveBlock): LiveTail => {
    const known = tail.blocks.find(b => b.index === index)

    if (!known) return start ? { ...tail, blocks: [...tail.blocks, { ...start, text: more.slice(0, room) }] } : tail
    if (!more) return tail

    const text = (known.text + more).slice(0, room)

    return text === known.text ? tail : { ...tail, blocks: tail.blocks.map(b => (b === known ? { ...b, text } : b)) }
  }

  switch (chunk.kind) {
    case 'text':
    case 'thinking':
      return grow(chunk.index, chunk.text, 20_000, { index: chunk.index, kind: chunk.kind, text: '' })
    case 'tool':
      return tail.blocks.some(b => b.index === chunk.index)
        ? tail
        : { ...tail, blocks: [...tail.blocks, { index: chunk.index, kind: 'tool', text: '', id: chunk.id, name: chunk.name }] }
    case 'input':
      return grow(chunk.index, chunk.json, 4_000)
    default:
      return tail
  }
}

/** Whether a throttled write is due: at most one per `every` milliseconds. */
export const isDue = (last: number, now: number, every = FLUSH_MS): boolean => now - last >= every

const opening = (text: string) => text.trim().slice(0, 200)

/**
 * The tail's blocks the transcript doesn't hold yet. A tool is matched by its id
 * anywhere; text and thinking only among the rows of this step's own response
 * (`at` from the step's message count), by how they open, so an earlier "Let me"
 * hides nothing. Once the response is whole and any of it is in, all of it is.
 */
export const pendingBlocks = (entries: readonly ChatEntry[], tail: LiveTail | null): LiveBlock[] => {
  if (!tail) return []

  const ids = new Set(entries.flatMap(e => (e.kind === 'tool' ? [e.id] : [])))
  const own = entries.filter(e => e.at >= tail.from && e.kind !== 'tool' && e.kind !== 'prompt')
  const isIn = (b: LiveBlock) =>
    b.kind === 'tool'
      ? b.id !== undefined && ids.has(b.id)
      : own.some(e => e.kind === b.kind && 'text' in e && e.text.startsWith(opening(b.text)))
  const left = tail.blocks.filter(b => !isIn(b))

  if (tail.isDone && left.length < tail.blocks.length) return []

  return left.filter(b => b.kind === 'tool' || b.text.trim() !== '' || !tail.isDone)
}

/** What a tool being written is about, from as much of its arguments as has arrived. */
export const liveToolLabel = (name: string, partial: string): string => {
  for (const attempt of [partial, `${partial}"}`, `${partial}}`]) {
    try {
      const args: unknown = JSON.parse(attempt)

      if (typeof args === 'object' && args !== null) return describeTool(name, args as Record<string, unknown>)
    } catch {
      // Not whole yet: try closing it, then fall back to the name alone.
    }
  }

  return describeTool(name, {})
}

export type ToolCallEntry = Extract<ChatEntry, { kind: 'tool' }>

/**
 * Everything an agent did between two things it said: its calls and its
 * thoughts, as one line of the chat. `items` is what the run holds in order,
 * `tools` its calls alone.
 */
export type Activity = { kind: 'activity'; key: string; items: ChatEntry[]; tools: ToolCallEntry[] }

/** A row of the chat: a prompt, words the agent said, or a run of activity between them. */
export type ChatRow = ChatEntry | Activity

/** The task-list tools: bookkeeping, never shown or counted as work. */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set([PLAN_TOOL, WRAP_UP_TOOL])

/**
 * Folds every run of calls and thoughts between two texts (or prompts) into one
 * activity row; the task-list tools are left out entirely. A run of thoughts
 * alone is dropped, unless `isLive` holds for one of them (it is being thought
 * now, so the line says so). The key is the run's first call's (else its first
 * thought's), so its open state holds while the run grows.
 */
export const activityRuns = (
  entries: readonly ChatEntry[],
  isLive: (entry: ChatEntry) => boolean = () => false,
): ChatRow[] => {
  const rows: ChatRow[] = []
  let run: ChatEntry[] = []

  const close = () => {
    const tools = run.filter((e): e is ToolCallEntry => e.kind === 'tool')

    if (run.length > 0 && (tools.length > 0 || run.some(isLive))) {
      rows.push({ kind: 'activity', key: `a${(tools[0] ?? run[0]!).key}`, items: run, tools })
    }

    run = []
  }

  for (const entry of entries) {
    if (entry.kind === 'tool' && HIDDEN_TOOLS.has(entry.tool)) continue

    if (entry.kind === 'tool' || entry.kind === 'thinking') {
      run.push(entry)
    } else {
      close()
      rows.push(entry)
    }
  }

  close()

  return rows
}

export type Category = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'agent' | 'other'

/** What kind of work a tool does, for counting a run and for its row's column. */
export const categoryOf = (tool: string): Category => {
  switch (tool) {
    case 'Read':
      return 'read'
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Bash':
    case 'PowerShell':
      return 'bash'
    case 'Grep':
    case 'Glob':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'Agent':
    case 'Task':
      return 'agent'
    default:
      return 'other'
  }
}

/** A category's word in an opened run's column. */
export const CATEGORY_LABEL: Record<Category | 'thought', string> = {
  read: 'Read',
  edit: 'Edit',
  bash: 'Bash',
  search: 'Search',
  web: 'Web',
  agent: 'Agent',
  other: 'Tool',
  thought: 'Thought',
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** A category's share of a run, in plain words. */
const phrase = (category: Category, n: number): string => {
  switch (category) {
    case 'read':
      return `read ${plural(n, 'file', 'files')}`
    case 'edit':
      return `edited ${plural(n, 'file', 'files')}`
    case 'bash':
      return `ran ${plural(n, 'command', 'commands')}`
    case 'search':
      return n === 1 ? 'searched once' : `searched ${n} times`
    case 'web':
      return plural(n, 'web lookup', 'web lookups')
    case 'agent':
      return `started ${plural(n, 'agent', 'agents')}`
    case 'other':
      return plural(n, 'other tool', 'other tools')
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** A finished call, said in the past: `Edited headroom.tsx`, `Ran: Check the build`. */
export const doneLabel = (tool: string, label: string): string => {
  if (categoryOf(tool) === 'bash') return `Ran: ${label}`

  const past: [RegExp, string][] = [
    [/^Reading /, 'Read '],
    [/^Editing /, 'Edited '],
    [/^Writing /, 'Wrote '],
    [/^Searching for /, 'Searched for '],
    [/^Finding /, 'Searched for '],
    [/^Fetching /, 'Fetched '],
    [/^Searching the web/, 'Searched the web'],
    [/^Starting an agent/, 'Started an agent'],
    [/^Using /, 'Used '],
  ]
  const hit = past.find(([from]) => from.test(label))

  return hit ? label.replace(hit[0], hit[1]) : label
}

/** A call still running, as the live line says it: `Running a command · Check the build`. */
export const runningLabel = (tool: string, label: string): string =>
  categoryOf(tool) === 'bash' ? `Running a command · ${label}` : label

/** A call of a run, as the chat knows it now; `path` the file it read or changed, if any. */
export type ActivityCall = { tool: string; label: string; state: 'running' | 'ok' | 'error'; path?: string }

/**
 * What a run's line says. While a call runs, that call (`Running a command ·
 * Check the build`). One call: its own words in the past (`Edited headroom.tsx`).
 * More: each kind of work counted, most first (`Read 7 files, ran 25 commands`),
 * edits by distinct file where the paths are known. `failed` counts the errors.
 */
export const activitySummary = (calls: readonly ActivityCall[]): { text: string; failed: number; running?: string } => {
  const failed = calls.filter(c => c.state === 'error').length
  const running = calls.findLast(c => c.state === 'running')

  if (running) return { text: runningLabel(running.tool, running.label), failed, running: running.label }
  if (calls.length === 0) return { text: '', failed }
  if (calls.length === 1) return { text: doneLabel(calls[0]!.tool, calls[0]!.label), failed }

  const counts = new Map<Category, number>()
  const edited = new Set<string>()

  calls.forEach((call, i) => {
    const category = categoryOf(call.tool)

    // An edit counts once per file; one with no known path counts on its own.
    if (category === 'edit') {
      const file = call.path ?? `#${i}`

      if (edited.has(file)) return
      edited.add(file)
    }

    counts.set(category, (counts.get(category) ?? 0) + 1)
  })

  // Most first; a tie keeps the order the work came in.
  const text = [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([category, n]) => phrase(category, n))
    .join(', ')

  return { text: capital(text), failed }
}

/** A row of an opened run: a call, or the thoughts in a row between calls as one. */
export type RunRow = { kind: 'tool'; entry: ToolCallEntry } | { kind: 'thoughts'; key: string; texts: string[] }

/** An opened run's rows: each call, and each stretch of thoughts folded into one row, keyed by its first. */
export const runRows = (items: readonly ChatEntry[]): RunRow[] => {
  const rows: RunRow[] = []

  for (const item of items) {
    const last = rows[rows.length - 1]

    if (item.kind === 'tool') rows.push({ kind: 'tool', entry: item })
    else if (item.kind === 'thinking') {
      if (last?.kind === 'thoughts') last.texts.push(item.text)
      else rows.push({ kind: 'thoughts', key: item.key, texts: [item.text] })
    }
  }

  return rows
}
