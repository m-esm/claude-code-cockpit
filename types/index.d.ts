export type InterviewStatus = 'interviewing' | 'done' | 'skipped' | 'unknown'

export type Lens = 'User' | 'Outcome' | 'Scope' | 'Execution' | 'Constraint' | 'Risk' | 'Alternative' | 'Contrarian'

export type SlotState = 'open' | 'partial' | 'settled'

export type Slot = { id: string; label: string; state: SlotState; summary: string }

export type Impact = 'low' | 'medium' | 'high'

export type OpenItem = { id: string; slotId: string; question: string; impact: Impact; costOfWrong: string }

export type PlannedQuestion = { text: string; lens: Lens; move: string }

export type Meter = {
  answers: number | null
  phase: string
  picture: string
  buildNow: string
  assuming: string
  clarity: number
  settled: string[]
  open: string[]
  lensesCovered: string[]
  lensesThin: string[]
  costOfWrong: string[]
  shifted: string
  status: InterviewStatus
  history: number[]
  source?: 'tool' | 'text'
  topic?: string
  slots?: Slot[]
  openItems?: OpenItem[]
}

export type Interview = {
  id: string | null
  topic: string
  permits: PlannedQuestion[]
  permitFromStop: boolean
  answersSinceStop: number
  totalAnswers: number
  recentLenses: Lens[]
  handled: string[]
  warnings: string[]
  blocks: number
  stopChecks: number
  openStreak: Record<string, number>
  panelTried: string[]
}

export type PanelPhase = 'idle' | 'countdown' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped'

export type Panel = {
  phase: PanelPhase
  itemId: string
  label: string
  deadline: number
  message: string
  startedAt: number
  goalFile: string
}

export type FeedStatus = 'loading' | 'ok' | 'error'

export type Feed<T> = {
  status: FeedStatus
  data: T | null
  error: string
  lastOkAt: number
  lastAttemptAt: number
}

export type QuotaWindow = { name: string; remainingPct: number | null; resetsAt: string | null; severity: string }

export type QuotaCli = { cli: string; available: boolean; eligible: boolean; error: string; windows: QuotaWindow[] }

export type QuotaSnapshot = { checkedAt: string; clis: QuotaCli[]; primary: string; localLaborOk: boolean }

export type HookSource = 'live' | 'jev' | 'gate'

export type HookRow = { at: number; source: HookSource; event: string; tool: string; ms: number; outcome: string; detail: string }

export type HooksSnapshot = { live: HookRow[]; logs: HookRow[]; inflight: number; lastBlock: HookRow | null }

export type SsaState = 'running' | 'done' | 'failed' | 'expired'

export type SsaRun = {
  id: string
  type: 'task' | 'plan'
  kind: string
  worker: string
  model: string
  state: SsaState
  phase: string
  exitCode: number | null
  failureClass: string
  detail: string
  startedAt: number
  updatedAt: number
}

export type SsaSnapshot = { running: SsaRun[]; recent: SsaRun[] }

export type Sections = { questioning: boolean; quota: boolean; hooks: boolean; subagents: boolean }

declare module 'claude-code' {
  interface PluginState {
    'claude-code-cockpit': {
      meter: Meter | null
      isBandHidden: boolean
      interview: Interview
      panel: Panel
      quota: Feed<QuotaSnapshot>
      hooks: Feed<HooksSnapshot>
      ssa: Feed<SsaSnapshot>
      sections: Sections
    }
  }
}
