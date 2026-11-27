import type { ChangedFile, Editor, Hunk } from '../types'

/** The most files kept; past it the one edited longest ago is dropped. */
export const MAX_FILES = 200

/** The most diff lines kept for one file; past it the oldest hunks are cut. */
export const MAX_DIFF_LINES = 400

/** The longest a stored line of a diff is, so one minified file can't fill the state. */
const MAX_LINE = 400

/** Lines of context kept either side of a change. */
const CONTEXT = 3

/** The largest middle, in cells, the line diff compares exactly; a bigger one is shown as replaced wholesale. */
const MAX_CELLS = 2_000_000

/** The filter's word for the main loop's own edits, which the state keeps as a null editor. */
export const YOU = 'you'

// ── The line diff ──

type Op = { kind: ' ' | '+' | '-'; text: string }

/** A text as lines; a final newline ends the last line rather than starting an empty one. */
export const linesOf = (text: string): string[] => {
  if (text === '') return []

  const lines = text.replace(/\r\n/g, '\n').split('\n')

  if (lines[lines.length - 1] === '') lines.pop()

  return lines
}

/**
 * The lines in common, then what is left of each, in order: the shared head and
 * tail are peeled off and a longest-common-subsequence table sorts out the middle.
 */
export const diffOps = (a: readonly string[], b: readonly string[]): Op[] => {
  let head = 0

  while (head < a.length && head < b.length && a[head] === b[head]) head++

  let tail = 0

  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const left = a.slice(head, a.length - tail)
  const right = b.slice(head, b.length - tail)
  const ops: Op[] = a.slice(0, head).map(text => ({ kind: ' ', text }))

  if ((left.length + 1) * (right.length + 1) > MAX_CELLS) {
    for (const text of left) ops.push({ kind: '-', text })
    for (const text of right) ops.push({ kind: '+', text })
  } else {
    // table[i][j] is the length of the longest common run of left[i..] and right[j..].
    const width = right.length + 1
    const table = new Uint32Array((left.length + 1) * width)

    for (let i = left.length - 1; i >= 0; i--) {
      for (let j = right.length - 1; j >= 0; j--) {
        table[i * width + j] =
          left[i] === right[j]
            ? (table[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0)
      }
    }

    let i = 0
    let j = 0

    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) {
        ops.push({ kind: ' ', text: left[i] ?? '' })
        i++
        j++
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        ops.push({ kind: '-', text: left[i] ?? '' })
        i++
      } else {
        ops.push({ kind: '+', text: right[j] ?? '' })
        j++
      }
    }

    for (; i < left.length; i++) ops.push({ kind: '-', text: left[i] ?? '' })
    for (; j < right.length; j++) ops.push({ kind: '+', text: right[j] ?? '' })
  }

  for (const text of a.slice(a.length - tail)) ops.push({ kind: ' ', text })

  return ops
}

const clip = (text: string) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text)

/**
 * The hunks that turn `before` into `after`, each with `context` unchanged lines
 * around its changes, and neighbours closer than that merged. `at` is the line
 * the first line of `before` stands at in its file, for a fragment of one.
 */
export const hunksOf = (before: string, after: string, by: string | null, at = 1, context = CONTEXT): Hunk[] => {
  const ops = diffOps(linesOf(before), linesOf(after))
  const changes: number[] = []

  ops.forEach((op, i) => {
    if (op.kind !== ' ') changes.push(i)
  })

  // Each run of changes, joined to the next when their contexts would meet.
  const spans: [number, number][] = []

  for (const i of changes) {
    const last = spans[spans.length - 1]

    if (last && i - last[1] <= 2 * context + 1) last[1] = i
    else spans.push([i, i])
  }

  // The old and new line each op stands at, counted from the start.
  const oldAt: number[] = []
  const newAt: number[] = []
  let o = at
  let n = at

  for (const op of ops) {
    oldAt.push(o)
    newAt.push(n)

    if (op.kind !== '+') o++
    if (op.kind !== '-') n++
  }

  return spans.map(([first, last]) => {
    const from = Math.max(0, first - context)
    const to = Math.min(ops.length - 1, last + context)
    const slice = ops.slice(from, to + 1)

    return {
      oldStart: oldAt[from] ?? at,
      newStart: newAt[from] ?? at,
      lines: slice.map(op => `${op.kind}${clip(op.text)}`),
      by,
    }
  })
}

/** How many lines of a hunk a side of the diff holds, and so the counts in its header. */
export const sizeOf = (h: Pick<Hunk, 'lines'>) => ({
  old: h.lines.filter(l => l[0] !== '+').length,
  added: h.lines.filter(l => l[0] === '+').length,
  removed: h.lines.filter(l => l[0] === '-').length,
  new: h.lines.filter(l => l[0] !== '-').length,
})

/** `@@ -12,5 +12,7 @@`, a unified diff's own header; an empty side stands one line before where it would start. */
export const headerOf = (h: Hunk): string => {
  const s = sizeOf(h)

  return `@@ -${s.old === 0 ? h.oldStart - 1 : h.oldStart},${s.old} +${s.new === 0 ? h.newStart - 1 : h.newStart},${s.new} @@`
}

/** The diff as the unified text a `Code` element draws. */
export const unified = (hunks: readonly Hunk[]): string =>
  hunks.map(h => [headerOf(h), ...h.lines].join('\n')).join('\n')

/** What a run of hunks adds and removes. */
export const countOf = (hunks: readonly Hunk[]) =>
  hunks.reduce(
    (sum, h) => {
      const s = sizeOf(h)

      return { added: sum.added + s.added, removed: sum.removed + s.removed }
    },
    { added: 0, removed: 0 },
  )

// ── What an edit changed ──

/** What the tool was asked to do to one file, read from its arguments. */
export type Change = {
  tool: 'Edit' | 'MultiEdit' | 'Write' | 'NotebookEdit'
  path: string
  /** Each pair an Edit or MultiEdit replaces; a Write's whole new text is `content`. */
  edits?: { oldText: string; newText: string; all: boolean }[]
  content?: string
  /** A notebook cell edit's mode, and the cell's new text. */
  mode?: 'replace' | 'insert' | 'delete'
  cellId?: string
}

export const FILE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] as const

const textOf = (v: unknown) => (typeof v === 'string' ? v : '')

/** The change a call to a file tool asks for, or undefined for any other call or one with no path. */
export const changeOf = (args: Record<string, unknown>): Change | undefined => {
  const tool = args.tool

  if (tool !== 'Edit' && tool !== 'MultiEdit' && tool !== 'Write' && tool !== 'NotebookEdit') return undefined

  const path = textOf(tool === 'NotebookEdit' ? args.notebook_path : args.file_path)

  if (path === '') return undefined

  if (tool === 'Write') return { tool, path, content: textOf(args.content) }

  if (tool === 'NotebookEdit') {
    const mode = args.edit_mode === 'insert' || args.edit_mode === 'delete' ? args.edit_mode : 'replace'

    return { tool, path, content: textOf(args.new_source), mode, cellId: typeof args.cell_id === 'string' ? args.cell_id : undefined }
  }

  const raw = tool === 'MultiEdit' && Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [args]

  return {
    tool,
    path,
    edits: raw.map(r => ({ oldText: textOf(r.old_string), newText: textOf(r.new_string), all: r.replace_all === true })),
  }
}

/** The text with one edit made, or undefined where the text it replaces isn't there. */
const applied = (text: string, edit: { oldText: string; newText: string; all: boolean }): string | undefined => {
  if (edit.oldText === '') return undefined

  const at = text.indexOf(edit.oldText)

  if (at < 0) return undefined

  return edit.all
    ? text.split(edit.oldText).join(edit.newText)
    : text.slice(0, at) + edit.newText + text.slice(at + edit.oldText.length)
}

/** The lines of a notebook cell's source, found by its id, from the notebook's JSON. */
const cellSource = (notebook: string, cellId: string | undefined): string | undefined => {
  const cells = (JSON.parse(notebook) as { cells?: { id?: string; source?: string | string[] }[] }).cells ?? []
  const cell = cellId === undefined ? undefined : cells.find(c => c.id === cellId)

  return cell === undefined ? undefined : Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')
}

/**
 * The hunks a successful change made, and whether it created the file.
 *
 * `before` is the file as it was read ahead of the call, undefined when it
 * didn't exist or couldn't be read. With it, an Edit is made again here on the
 * text, so the hunks sit at the file's real lines and carry real context;
 * without it each edit's two strings are compared on their own and numbered from 1.
 */
export const hunksOfChange = (change: Change, before: string | undefined, by: string | null): { hunks: Hunk[]; isNew: boolean } => {
  if (change.tool === 'Write') {
    return { hunks: hunksOf(before ?? '', change.content ?? '', by), isNew: before === undefined }
  }

  if (change.tool === 'NotebookEdit') {
    let old = ''

    try {
      old = before === undefined ? '' : (cellSource(before, change.cellId) ?? '')
    } catch {
      // A notebook that doesn't parse has no cell to compare with.
    }

    const next = change.mode === 'delete' ? '' : (change.content ?? '')

    return { hunks: hunksOf(change.mode === 'insert' ? '' : old, next, by), isNew: false }
  }

  const edits = change.edits ?? []

  if (before !== undefined) {
    let text: string | undefined = before

    for (const edit of edits) text = text === undefined ? undefined : applied(text, edit)

    if (text !== undefined) return { hunks: hunksOf(before, text, by), isNew: false }
  }

  return { hunks: edits.flatMap(edit => hunksOf(edit.oldText, edit.newText, by)), isNew: false }
}

// ── The list ──

/** Trims a file's hunks, newest first, to the cap; says how many diff lines went. */
export const capHunks = (hunks: Hunk[], cut: number): { hunks: Hunk[]; cut: number } => {
  const kept: Hunk[] = []
  let room = MAX_DIFF_LINES
  let lost = cut

  for (const h of hunks) {
    const size = h.lines.length

    if (size <= room) {
      kept.push(h)
      room -= size
    } else if (room > 0) {
      // One hunk past the room: its first lines stay, and its header follows them.
      kept.push({ ...h, lines: h.lines.slice(0, room) })
      lost += size - room
      room = 0
    } else {
      lost += size
    }
  }

  return { hunks: kept, cut: lost }
}

/** The list with one more edit of a file in it, that file at the head; the oldest-edited past the cap go. */
export const addEdit = (
  list: readonly ChangedFile[],
  path: string,
  by: string | null,
  made: { hunks: Hunk[]; isNew: boolean },
): ChangedFile[] => {
  const old = list.find(f => f.path === path)
  const { added, removed } = countOf(made.hunks)
  const editors: Editor[] = old ? [...old.editors] : []
  const index = editors.findIndex(x => x.by === by)
  const mine = editors[index] ?? { by, edits: 0, added: 0, removed: 0 }
  const updated: Editor = { by, edits: mine.edits + 1, added: mine.added + added, removed: mine.removed + removed }

  if (index < 0) editors.push(updated)
  else editors[index] = updated

  const capped = capHunks([...made.hunks, ...(old?.hunks ?? [])], old?.cut ?? 0)
  const file: ChangedFile = {
    path,
    // A file made this session stays added however often it is edited after.
    status: old ? old.status : made.isNew ? 'A' : 'M',
    added: (old?.added ?? 0) + added,
    removed: (old?.removed ?? 0) + removed,
    edits: (old?.edits ?? 0) + 1,
    editors,
    hunks: capped.hunks,
    cut: capped.cut,
  }

  return [file, ...list.filter(f => f.path !== path)].slice(0, MAX_FILES)
}

/** The files one actor edited, with only that actor's share of each; `all` leaves the list as it is. */
export const filtered = (list: readonly ChangedFile[], who: string): ChangedFile[] => {
  if (who === 'all') return [...list]

  const by = who === YOU ? null : who

  return list.flatMap(f => {
    const mine = f.editors.find(x => x.by === by)

    return mine
      ? [{ ...f, added: mine.added, removed: mine.removed, edits: mine.edits, hunks: f.hunks.filter(h => h.by === by) }]
      : []
  })
}

/** Who edited anything, the person first and then each agent in the order they first did. */
export const actorsOf = (list: readonly ChangedFile[]): (string | null)[] => {
  const seen: (string | null)[] = []

  // The list is newest first, so the order they first edited is read from its end.
  for (const f of [...list].reverse()) {
    for (const x of f.editors) if (!seen.includes(x.by)) seen.push(x.by)
  }

  return [...seen.filter(x => x === null), ...seen.filter(x => x !== null)]
}

/** A path from the session's directory, or as it is where it lies outside. */
export const relativeTo = (path: string, cwd: string): string => {
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`

  return cwd !== '' && path.startsWith(base) ? path.slice(base.length) : path
}

// ── From a transcript ──

type Block = { type?: unknown; [field: string]: unknown }

const blocksOf = (content: unknown): Block[] =>
  Array.isArray(content) ? content.filter((b): b is Block => typeof b === 'object' && b !== null) : []

const resultText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : blocksOf(content)
        .map(b => (b.type === 'text' ? String(b.text ?? '') : ''))
        .join('\n')

/** A file tool's call found in a transcript that went through: what it asked, and what it said back. */
export type PastChange = { change: Change; result: string }

/**
 * The file changes a conversation made, oldest first, read from its messages in
 * the API form: each Edit, MultiEdit, Write or NotebookEdit call whose result
 * came back without an error. What a session did before this mod was watching.
 */
export const changesInTranscript = (messages: readonly { role: string; content: unknown }[]): PastChange[] => {
  const calls = new Map<string, Change>()
  const done: PastChange[] = []

  for (const m of messages) {
    for (const b of blocksOf(m.content)) {
      if (b.type === 'tool_use') {
        const input = typeof b.input === 'object' && b.input !== null ? (b.input as Record<string, unknown>) : {}
        const change = changeOf({ ...input, tool: b.name })

        if (change) calls.set(String(b.id ?? ''), change)
      } else if (b.type === 'tool_result') {
        const change = calls.get(String(b.tool_use_id ?? ''))

        if (change && b.is_error !== true) done.push({ change, result: resultText(b.content) })
      }
    }
  }

  return done
}

/**
 * Hunks numbered from 1, moved to where `text` (the file as it is now) holds
 * the edit's new lines: the nearest a change read back from a transcript can get
 * to its real place. Left as they are where the text isn't found.
 */
export const placeHunks = (hunks: Hunk[], text: string | undefined, newText: string): Hunk[] => {
  if (text === undefined || newText === '') return hunks

  const at = text.indexOf(newText)

  if (at < 0) return hunks

  const shift = text.slice(0, at).split('\n').length - 1

  return hunks.map(h => ({ ...h, oldStart: h.oldStart + shift, newStart: h.newStart + shift }))
}

/**
 * The subagents a conversation started, read from its Agent calls: the id their
 * result names (`agentId: …`) and the description they were given.
 */
export const agentsInTranscript = (messages: readonly { role: string; content: unknown }[]): { id: string; name: string }[] => {
  const asked = new Map<string, string>()
  const found: { id: string; name: string }[] = []

  for (const m of messages) {
    for (const b of blocksOf(m.content)) {
      if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
        const input = typeof b.input === 'object' && b.input !== null ? (b.input as Record<string, unknown>) : {}

        asked.set(String(b.id ?? ''), textOf(input.description) || textOf(input.subagent_type) || 'Subagent')
      } else if (b.type === 'tool_result' && asked.has(String(b.tool_use_id ?? ''))) {
        const id = /agentId:\s*([A-Za-z0-9_-]+)/.exec(resultText(b.content))?.[1]

        if (id && !found.some(a => a.id === id)) found.push({ id, name: asked.get(String(b.tool_use_id))! })
      }
    }
  }

  return found
}
