export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** The last main-loop request's use of the prompt cache, and when it was made. */
export type Cache = { read: number; written: number; uncached: number; at?: number }

export type Reading = {
  tokens?: number
  window: number
  limits: Limit[]
}

export type StepStatus = 'pending' | 'in_progress' | 'completed'

export type Step = { content: string; status: StepStatus }

/** The task the current prompt started: the steps Claude listed, and tools run. */
export type Task = { steps: Step[]; tools: number }

export type Outfit =
  | 'explorer'
  | 'hardhat'
  | 'wizard'
  | 'tophat'
  | 'cowboy'
  | 'pirate'
  | 'chef'
  | 'royal'
  | 'shades'
  | 'headphones'

export type AgentStatus = 'running' | 'done' | 'stopped' | 'failed'

/** One subagent of this session, as its own events tell it. */
export type AgentRun = {
  id: string
  description: string
  type: string
  model?: string
  effort?: string | number
  status: AgentStatus
  /** What it is doing now: a tool's label, or `Thinking` between tools. */
  activity?: string
  tools: number
  /** The context its last request carried. */
  tokens?: number
  /** Its own task list, when it keeps one. */
  steps: Step[]
  startedAt: number
  endedAt?: number
  outfit: Outfit
  /** The report it handed back, cut to its opening sentence. */
  answer?: string
}

export type ToolStatus = 'running' | 'ok' | 'error'

/** One tool call of a subagent, as its `tool.call` started and settled it. */
export type ToolEntry = {
  /** The call's `tool_use_id`. */
  id: string
  tool: string
  /** What it does, in a few words: `Reading pill.ts`. */
  label: string
  startedAt: number
  endedAt?: number
  status: ToolStatus
}

/** A block of the response a subagent is streaming now, as its chunks arrived. */
export type LiveBlock = {
  /** The block's place in the response, as its chunks number it. */
  index: number
  kind: 'text' | 'thinking' | 'tool'
  /** The text so far; for a tool, its arguments' JSON so far. */
  text: string
  /** A tool's `tool_use_id` and name. */
  id?: string
  name?: string
}

/** The step a subagent is streaming, until its transcript holds what it said. */
export type LiveTail = {
  turnId: string
  step: number
  /** How many messages the step's request carried: its own response comes after them. */
  from: number
  blocks: LiveBlock[]
  /** The response is whole: no caret, and it goes once the transcript has it. */
  isDone: boolean
}

// ── 0.6.0 additions ─────────────────────────────────────────────────────────

/** One reading of a rate-limit window, kept to project when it runs out. (Agent A) */
export type LimitSample = { at: number; percent: number }

/** What fills the context, as /context's categories put it, and what the last turn added. (Agent A) */
export type Headroom = {
  /** `color` is the theme key /context draws the category in. */
  categories: { name: string; tokens: number; kind: string; color?: string }[]
  /** Context tokens the last main-thread turn added; negative after a compaction. */
  lastTurnDelta?: number
  /** The main thread's largest tool result in the last turn, by estimated tokens. */
  biggest?: { label: string; tokens: number }
  at: number
}

// ── $.store (Agent A) ──
// `$.store` is untyped (`get` resolves `unknown`); these are the shapes this mod
// keeps there, checked on read.

/** Under the store key `fiveHourSamples`: the 5-hour window's samples, which outlive a session. */
export type StoredSamples = { resetsAt: string; samples: LimitSample[] }

/** Tokens one loop spent, summed over its requests. (Agent C) */
export type Spend = {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  requests: number
}

/** What the session spent and on whom, for /receipt. (Agent C) */
export type Ledger = {
  main: Spend
  /** By agent id, with what to call it. */
  agents: Record<string, Spend & { label: string; model?: string }>
  /** The 5-hour window's percent when this session was first measured. */
  sessionLimitAtStart?: number
  weekLimitAtStart?: number
}

/** A module of the popover under the pill: Limits, Context and Cache from their chips, Session from /receipt. */
export type Popover = 'limits' | 'context' | 'cache' | 'session'

/** One stretch of a file's diff: its lines each led by a space (kept), `+` (added) or `-` (removed). */
export type Hunk = {
  /** The line the hunk starts at in the file before the edit, and after it. */
  oldStart: number
  newStart: number
  lines: string[]
  /** The agent id that made it; null for the main loop. */
  by: string | null
}

/** What one editor, the main loop (null) or an agent, did to a file. */
export type Editor = { by: string | null; edits: number; added: number; removed: number }

/** A file edited this session, with its diff, for the Changed files section of the Subagents pane. */
export type ChangedFile = {
  /** Absolute. */
  path: string
  /** A is a Write to a file that wasn't there; a file can't be told to be deleted, so there is no D. */
  status: 'M' | 'A'
  added: number
  removed: number
  edits: number
  editors: Editor[]
  /** Newest edit first, within one edit by line. */
  hunks: Hunk[]
  /** Diff lines dropped to keep a file's diff within its cap. */
  cut: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-pill': {
      // ── 0.7.0: Changed files ──
      /** Every file an Edit, MultiEdit, Write or NotebookEdit changed this session, the latest edit first. */
      changedFiles: Shaped<ChangedFile[]>
      /** The rows of the Changed files section opened to their diff (a path), and their folded hunks opened (`more:` and the path). */
      filesOpen: string[]
      /** Whose files the section lists: `all`, `you`, or an agent id. */
      filesFilter: string
      // ── 0.6.3 ──
      /** The main thread's requests this session, oldest first, for the Cache module's strip. */
      cacheLog: Cache[]
      /** Whether the Context module shows every row, the folded ones too. */
      contextOpen: boolean
      /** Whether the five-minute cooling warning is off; kept across sessions in the store. */
      coolingWarnOff: boolean
      // ── 0.6.0: Agent A (band) ──
      /** The 5-hour window's readings since its last reset, oldest first. */
      limitSamples: LimitSample[]
      /** What fills the context; null until measured above the headroom threshold. */
      headroom: Headroom | null
      /** Until when the pill's mascot celebrates a finished task. */
      celebrateUntil: number
      // ── 0.6.0: Agent B (timeline) ──
      /** Which view the Subagents pane shows. */
      paneView: 'cards' | 'timeline'
      // ── 0.6.0: Agent C (receipt, notify) ──
      ledger: Ledger
      /** When the current main-thread turn began; null while idle. */
      turnStartedAt: number | null
      /** The module the popover under the pill shows; null while it is closed. */
      popover: Popover | null
      // ── 0.5.0 ──
      reading: Reading | null
      cache: Cache | null
      minute: number
      task: Task
      isWorking: boolean
      agents: Shaped<AgentRun[]>
      agentTick: number
      /** The agent whose chat the Subagents pane shows in place of its list, where the main view can't; null on the list. */
      transcriptOf: string | null
      /** Each agent's latest tool calls, oldest first, by agent id. */
      toolFeed: StateFamily<Shaped<ToolEntry[]>>
      /** The agents whose card lists every tool call, not just the latest. */
      feedOpen: string[]
      /** What each agent is streaming now, by agent id; null between steps. */
      liveTail: StateFamily<Shaped<LiveTail | null>>
      /** Bumped when the chat's agent has new messages to read. */
      chatRev: number
      /** The chat's rows and tool groups opened to their detail, by row key. */
      chatOpen: string[]
      /** Whether the chat keeps to its end as the agent goes on. */
      follow: boolean
    }
  }
}
