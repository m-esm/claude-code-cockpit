import type { Feed, HookRow, QuotaCli, QuotaSnapshot, QuotaWindow, SsaRun, SsaState } from '../types'

export const HISTORY_MAX_RUNS = 100
export const HISTORY_MAX_AGE_MS = 30 * 24 * 3600 * 1000
export const QUOTA_MAX_AGE_MS = 5 * 60 * 1000
export const STALE_RUN_MS = 6 * 3600 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value))

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export const emptyFeed = <T>(): Feed<T> => ({ status: 'loading', data: null, error: '', lastOkAt: 0, lastAttemptAt: 0 })

export const feedOk = <T>(previous: Feed<T>, data: T, now: number): Feed<T> => ({
  ...previous,
  status: 'ok',
  data,
  error: '',
  lastOkAt: now,
  lastAttemptAt: now,
})

export const feedError = <T>(previous: Feed<T>, error: string, now: number): Feed<T> => ({
  ...previous,
  status: 'error',
  error: error.slice(0, 300),
  lastAttemptAt: now,
})

export const parseQuota = (json: string): QuotaSnapshot => {
  const raw: unknown = JSON.parse(json)
  if (!isRecord(raw) || !Array.isArray(raw.clis)) throw new Error('ai-cli-usage output has no clis list')
  const clis: QuotaCli[] = raw.clis.filter(isRecord).map(entry => ({
    cli: str(entry.cli),
    available: entry.available === true,
    eligible: entry.eligible === true,
    error: str(entry.error ?? entry.skip_reason),
    windows: (Array.isArray(entry.windows) ? entry.windows : []).filter(isRecord).map(
      (window): QuotaWindow => ({
        name: str(window.name),
        remainingPct: num(window.remaining_pct) === null ? null : Math.round((num(window.remaining_pct) ?? 0) * 10) / 10,
        resetsAt: typeof window.resets_at === 'string' ? window.resets_at : null,
        severity: str(window.severity) || 'unknown',
      }),
    ),
  }))
  const recommendation = isRecord(raw.recommendation) ? raw.recommendation : {}
  return {
    checkedAt: str(raw.checked_at),
    clis,
    primary: str(recommendation.primary_worker),
    localLaborOk: recommendation.local_labor_ok === true,
  }
}

export type LowestWindow = { cli: string; window: QuotaWindow }

export const lowestWindow = (snapshot: QuotaSnapshot | null): LowestWindow | null => {
  let lowest: LowestWindow | null = null
  for (const cli of snapshot?.clis ?? []) {
    if (!cli.available) continue
    for (const window of cli.windows) {
      if (window.remainingPct === null) continue
      if (lowest === null || window.remainingPct < (lowest.window.remainingPct ?? Infinity)) lowest = { cli: cli.cli, window }
    }
  }
  return lowest
}

export const tightestPct = (cli: QuotaCli): number | null =>
  cli.windows.reduce<number | null>((min, window) => (window.remainingPct === null ? min : min === null ? window.remainingPct : Math.min(min, window.remainingPct)), null)

export const quotaBlocksPanel = (feed: Feed<QuotaSnapshot>, now: number): string | null => {
  if (feed.data === null) return 'no quota data yet'
  if (now - feed.lastOkAt > QUOTA_MAX_AGE_MS) return 'quota data is older than 5 minutes'
  if (!feed.data.clis.some(cli => cli.available && cli.eligible && (tightestPct(cli) ?? 100) > 5)) return 'no eligible worker has quota left'
  return null
}

export const jsonLines = (text: string, isTail: boolean): unknown[] => {
  const lines = text.split('\n')
  if (isTail) lines.shift()
  return lines.flatMap(line => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as unknown]
    } catch {
      return []
    }
  })
}

const timeOf = (value: unknown): number => {
  const parsed = Date.parse(str(value))
  return Number.isNaN(parsed) ? 0 : parsed
}

export const jevRows = (entries: unknown[]): HookRow[] =>
  entries.filter(isRecord).map(entry => ({
    at: timeOf(entry.ts),
    source: 'jev',
    event: str(entry.event) || 'screen',
    tool: str(entry.tool),
    ms: num(entry.ms) ?? 0,
    outcome: entry.deny === true ? 'deny' : 'allow',
    detail: [str(entry.harness), num(entry.noul) !== null ? `p=${num(entry.noul)}` : ''].filter(Boolean).join(' '),
  }))

const firedNames = (fired: unknown): string[] =>
  Array.isArray(fired) ? fired.map(entry => (isRecord(entry) ? str(entry.name ?? entry.gate ?? entry.kind) : str(entry))).filter(Boolean) : []

export const gateRows = (entries: unknown[]): HookRow[] =>
  entries.filter(isRecord).flatMap((entry): HookRow[] => {
    const event = str(entry.event)
    const base = { at: timeOf(entry.ts), source: 'gate' as const, tool: str(entry.harness), ms: num(entry.ms) ?? 0 }
    if (event === 'prompt') {
      const fired = firedNames(entry.fired)
      const scores = ['labor', 'plan', 'substantial', 'unresolved'].filter(key => num(entry[key]) !== null).map(key => `${key}=${num(entry[key])}`)
      return [{ ...base, event: 'gate', outcome: fired.length ? `fired ${fired.join(',')}` : 'quiet', detail: scores.join(' ') }]
    }
    if (event === 'interview-close' || event === 'skip' || event === 'stop') {
      return [{ ...base, event, outcome: str(entry.how ?? entry.why ?? entry.resolution) || event, detail: '' }]
    }
    return []
  })

const PHASE_STATE: Record<string, SsaState> = {
  running: 'running',
  dispatched: 'running',
  started: 'running',
  queued: 'running',
  verifying: 'running',
  reviewing: 'running',
  failed: 'failed',
  error: 'failed',
}

export type TaskFiles = {
  id: string
  events: string
  kind: string
  model: string
  worker: string
  exitCode: string
  startedAt: number
  mtime: number
}

export const taskRun = (files: TaskFiles, now: number): SsaRun => {
  const events = jsonLines(files.events, false).filter(isRecord)
  const last = events[events.length - 1] ?? {}
  const phase = str(last.phase) || (files.exitCode ? 'exited' : 'unknown')
  const exitFile = files.exitCode.trim() === '' ? null : Number(files.exitCode.trim())
  const exitCode = num(last.exit) ?? (exitFile !== null && Number.isFinite(exitFile) ? exitFile : null)
  let state: SsaState = PHASE_STATE[phase] ?? (exitCode !== null && exitCode !== 0 ? 'failed' : 'done')
  const updatedAt = Math.max(timeOf(last.ts), files.mtime)
  if (state === 'running' && now - updatedAt > STALE_RUN_MS) state = 'expired'
  return {
    id: files.id,
    type: 'task',
    kind: files.kind.trim(),
    worker: str(last.worker) || files.worker.trim(),
    model: files.model.trim(),
    state,
    phase,
    exitCode,
    failureClass: str(last.failure_class),
    detail: events.length ? `${events.length} events` : '',
    startedAt: files.startedAt || timeOf(events[0]?.ts) || files.mtime,
    updatedAt,
  }
}

export type PlanFiles = { id: string; names: string[]; mtime: number; startedAt: number }

export const planRun = (files: PlanFiles, now: number): SsaRun => {
  const plans = files.names.filter(name => /^plan-\d+-.+\.md$/.test(name))
  const planners = files.names.filter(name => /^planner-\d+\.pid$/.test(name)).length
  const isDone = files.names.includes('panel-done.txt')
  const workers = plans.map(name => name.replace(/^plan-\d+-[a-z]+-/, '').replace(/\.md$/, ''))
  let state: SsaState = isDone ? 'done' : 'running'
  if (state === 'running' && now - files.mtime > STALE_RUN_MS) state = 'expired'
  return {
    id: files.id,
    type: 'plan',
    kind: 'panel',
    worker: workers.join(','),
    model: '',
    state,
    phase: isDone ? 'done' : `planning ${plans.length}/${planners || 3}`,
    exitCode: null,
    failureClass: '',
    detail: `${plans.length} of ${planners || 3} plans`,
    startedAt: files.startedAt || files.mtime,
    updatedAt: files.mtime,
  }
}

export const mergeHistory = (history: readonly SsaRun[], seen: readonly SsaRun[], now: number): SsaRun[] => {
  const byId = new Map<string, SsaRun>()
  for (const run of history) byId.set(run.id, run)
  const seenIds = new Set(seen.map(run => run.id))
  for (const run of seen) byId.set(run.id, run)
  for (const [id, run] of byId) {
    if (!seenIds.has(id) && run.state === 'running') byId.set(id, { ...run, state: 'expired', detail: 'run folder gone before it finished' })
  }
  return [...byId.values()]
    .filter(run => now - run.updatedAt <= HISTORY_MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_MAX_RUNS)
}

export const isRunList = (value: unknown): value is SsaRun[] =>
  Array.isArray(value) && value.every(entry => isRecord(entry) && typeof entry.id === 'string' && typeof entry.state === 'string')

export const startedAtFromId = (id: string): number => {
  const seconds = Number(id.replace(/^plan-/, '').split('-')[0])
  return Number.isFinite(seconds) && seconds > 1e9 ? seconds * 1000 : 0
}
