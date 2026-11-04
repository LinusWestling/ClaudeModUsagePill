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
  /** What it is doing now. */
  activity?: string
  tools: number
  /** The context its last request carried. */
  tokens?: number
  /** Its own task list, when it keeps one. */
  steps: Step[]
  startedAt: number
  endedAt?: number
  outfit: Outfit
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
    }
  }
}
