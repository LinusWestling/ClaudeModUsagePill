import type { TurnStepChunk } from 'claude-code'

import type { LiveBlock, LiveTail } from '../types'
import { describeTool } from './agents'

/** The pane that shows a subagent's transcript where the main view can't switch to it. */
export const TRANSCRIPT_PANE = 'usage-pill-transcript'

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
