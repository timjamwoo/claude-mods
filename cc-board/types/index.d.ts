// The mod's type contract. `claude plugin validate` checks every `$.state`
// value the hooks module names against `PluginState` below, and the hooks
// module imports these types from '../types'.

/** Where a checklist item came from. */
export type ItemSource = 'todo' | 'manual'

/** The same three states TodoWrite uses. */
export type ItemStatus = 'pending' | 'in_progress' | 'completed'

/** One line of this session's checklist. */
export type ChecklistItem = {
  /** Short number shown in the pane and typed after /done. Stable for the session. */
  id: number
  text: string
  source: ItemSource
  status: ItemStatus
  /** True once the person ticked it themselves. A ticked item stays done. */
  ticked: boolean
}

/** The checklist plus the counter that hands out ids. */
export type Checklist = {
  items: ChecklistItem[]
  nextId: number
}

/** What one session writes to ~/.claude/board/<session-id>.json. */
export type BoardSession = {
  sessionId: string
  project: string
  cwd: string
  /** One sentence on what the session is handling right now. */
  summary: string
  items: ChecklistItem[]
  /** ISO 8601 time of the last write. */
  updatedAt: string
  /** ISO 8601 time the session ended, once it has. */
  endedAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cc-board': {
      checklist: Checklist
      summary: string
      board: BoardSession[]
    }
  }
}
