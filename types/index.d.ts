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

declare module 'claude-code' {
  interface PluginState {
    'usage-pill': {
      reading: Reading | null
      cache: Cache | null
      minute: number
      task: Task
      isWorking: boolean
    }
  }
}
