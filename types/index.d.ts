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

declare module 'claude-code' {
  interface PluginState {
    'usage-pill': {
      reading: Reading | null
      cache: Cache | null
      minute: number
      task: Task
      isWorking: boolean
      agents: Shaped<AgentRun[]>
      agentTick: number
      /** The agent whose transcript the mod's own pane shows, where the main view can't. */
      transcriptOf: string | null
      /** Each agent's latest tool calls, oldest first, by agent id. */
      toolFeed: StateFamily<Shaped<ToolEntry[]>>
      /** The agents whose card lists every tool call, not just the latest. */
      feedOpen: string[]
      /** What each agent is streaming now, by agent id; null between steps. */
      liveTail: StateFamily<Shaped<LiveTail | null>>
      /** Bumped when the transcript pane's agent has new messages to read. */
      chatRev: number
      /** The transcript pane's rows opened to their detail, by row key. */
      chatOpen: string[]
      /** Whether the transcript pane keeps to its end as the agent goes on. */
      follow: boolean
    }
  }
}
