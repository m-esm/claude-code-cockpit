import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, Timer } from 'claude-code'

import type { HookRow, HooksSnapshot, Interview, Meter, Panel, QuotaSnapshot, Sections, SsaRun, SsaSnapshot } from '../types'
import { emptyFeed, feedError, feedOk, gateRows, isRunList, jevRows, jsonLines, lowestWindow, mergeHistory, parseQuota, planRun, quotaBlocksPanel, startedAtFromId, taskRun, tightestPct } from './feeds'
import { ago, clock, until } from './format'
import { applyMeter, checkAsk, countAnswered, emptyInterview, METER_DESCRIPTION, METER_SCHEMA, meterFromInput, panelCandidate, panelGoal, parseMeterInput, recordAnswers, STOP_EVERY } from './interview'
import { replay } from './meter'
import { Band, Cockpit } from './components'
import type { CockpitActions, CockpitData } from './components'

const PANE = 'claude-code-cockpit'
const TITLE = 'Cockpit'
const METER_TOOL = 'mcp__claude-code-cockpit__meter'
const COUNTDOWN_MS = 30000
const TICK_MS = 2000
const ACTIVE_WINDOW_MS = 30000
const QUOTA_ACTIVE_MS = 180000
const QUOTA_IDLE_MS = 900000
const FILES_ACTIVE_MS = 4000
const FILES_IDLE_MS = 60000
const LOG_TAIL_BYTES = 65536
const ROWS = 40
const USAGE_SCRIPT = '.claude/scripts/ai-cli-usage.py'
const PANEL_SCRIPT = '.claude/scripts/smart-subagents.sh'
const SSA_URL = 'https://github.com/m-esm/smart-subagents'

const IDLE_PANEL: Panel = { phase: 'idle', itemId: '', label: '', deadline: 0, message: '', startedAt: 0, goalFile: '' }
const ALL_OPEN: Sections = { questioning: true, quota: true, hooks: true, subagents: true }

const meter = atom({ plugin: 'claude-code-cockpit', key: 'meter' } as const, null)
const isBandHidden = atom({ plugin: 'claude-code-cockpit', key: 'isBandHidden' } as const, false)
const interview = atom({ plugin: 'claude-code-cockpit', key: 'interview' } as const, emptyInterview())
const panel = atom({ plugin: 'claude-code-cockpit', key: 'panel' } as const, IDLE_PANEL)
const quota = atom({ plugin: 'claude-code-cockpit', key: 'quota' } as const, emptyFeed<QuotaSnapshot>())
const hooks = atom({ plugin: 'claude-code-cockpit', key: 'hooks' } as const, emptyFeed<HooksSnapshot>())
const ssa = atom({ plugin: 'claude-code-cockpit', key: 'ssa' } as const, emptyFeed<SsaSnapshot>())
const sections = atom({ plugin: 'claude-code-cockpit', key: 'sections' } as const, ALL_OPEN)

const poll = { quotaAt: 0, logsAt: 0, ssaAt: 0, quotaBusy: false, logsBusy: false, ssaBusy: false }
const logs: { jev: HookRow[]; gate: HookRow[]; size: Record<string, number> } = { jev: [], gate: [], size: {} }
const live: { rows: HookRow[]; inflight: number; dirty: boolean } = { rows: [], inflight: 0, dirty: false }
const runs: { history: SsaRun[]; cache: Map<string, { mtime: number; run: SsaRun }>; states: Map<string, string> } = {
  history: [],
  cache: new Map(),
  states: new Map(),
}
const timers: { tick: Timer | null; countdown: Timer | null; countdownTicker: Timer | null } = { tick: null, countdown: null, countdownTicker: null }
const host: { home: string; tmp: string; cwd: string; lastRenderAt: number; lastOpen: string } = { home: '', tmp: '', cwd: '', lastRenderAt: 0, lastOpen: 'not opened' }

const join = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

const isFresh = (before: Meter | null, after: Meter | null): boolean =>
  after !== null && (before === null || (before.status !== 'interviewing' && after.status === 'interviewing'))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hookTool = (e: unknown): string => {
  if (!isRecord(e)) return ''
  const tool = e.tool ?? e.tool_name
  return typeof tool === 'string' ? tool : ''
}

const hookOutcome = (result: unknown): string => {
  if (!isRecord(result)) return 'ok'
  if (typeof result.deny === 'string') return 'deny'
  if (typeof result.block === 'string') return 'block'
  if (typeof result.ask === 'string') return 'ask'
  if (result.permissionDecision === 'deny') return 'deny'
  if (Array.isArray(result.additionalContext) && result.additionalContext.length > 0) return 'context'
  return 'ok'
}

const isBlocking = (row: HookRow): boolean => row.outcome === 'deny' || row.outcome === 'block' || row.outcome.startsWith('fired')

const recordLive = (event: string, tool: string, startedAt: number, outcome: string): void => {
  live.rows = [...live.rows, { at: Date.now(), source: 'live' as const, event, tool, ms: Date.now() - startedAt, outcome, detail: '' }].slice(-ROWS)
  live.dirty = true
}

async function openPane($: Engine, focus = false): Promise<void> {
  try {
    const opened = await $.ui.open(focus ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
    host.lastOpen = opened.isPlaced ? 'placed' : `waiting: ${opened.reason}`
  } catch (error) {
    host.lastOpen = `failed: ${String(error)}`
  }
}

async function paths($: Engine): Promise<{ home: string; tmp: string; cwd: string }> {
  if (!host.home) {
    host.home = (await $.env.get('HOME')) ?? ''
    host.tmp = (await $.env.get('TMPDIR')) ?? '/tmp/'
    const pwd = await $.process.run(['pwd'], { timeoutMs: 5000 }).catch(() => null)
    host.cwd = pwd?.stdout.trim() ?? ''
  }
  return host
}

async function readSmall($: Engine, path: string): Promise<string> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

async function refreshFromText($: Engine, extra?: string): Promise<void> {
  const before = await read($, meter)
  if (before?.source === 'tool') return
  const messages = await $.session.messages()
  if (!Array.isArray(messages)) return
  const texts = messages.filter(message => message.role === 'assistant').map(message => message.text)
  if (extra) texts.push(extra)
  const rebuilt = replay(texts)
  if (rebuilt === null) return
  const tagged: Meter = { ...rebuilt, source: 'text' }
  if (before !== null && JSON.stringify(before) === JSON.stringify(tagged)) return
  await update($, meter, () => tagged)
  if (isFresh(before, tagged)) {
    await update($, isBandHidden, () => false)
    void openPane($)
  }
}

async function pollQuota($: Engine, now: number): Promise<void> {
  if (poll.quotaBusy) return
  poll.quotaBusy = true
  poll.quotaAt = now
  try {
    const { home } = await paths($)
    const script = join(home, USAGE_SCRIPT)
    if (!(await $.fs.exists(script))) throw new Error(`~/${USAGE_SCRIPT} not found. Install smart-subagents (${SSA_URL}) to see quota.`)
    const ran = await $.process.run(['python3', script, '--json'], { timeoutMs: 90000 })
    if (ran.exitCode !== 0) throw new Error(`ai-cli-usage exited ${ran.exitCode}: ${ran.stderr.trim().split('\n').pop() ?? ''}`)
    const snapshot = parseQuota(ran.stdout)
    const at = await $.clock.now()
    await update($, quota, feed => feedOk(feed, snapshot, at))
  } catch (error) {
    const at = await $.clock.now()
    await update($, quota, feed => feedError(feed, String(error), at))
  } finally {
    poll.quotaBusy = false
  }
}

async function tailLog($: Engine, path: string): Promise<unknown[] | null> {
  let size = 0
  try {
    size = (await $.fs.stat(path)).size
  } catch {
    return null
  }
  if (logs.size[path] === size) return null
  logs.size[path] = size
  const ran = await $.process.run(['tail', '-c', String(LOG_TAIL_BYTES), path], { timeoutMs: 5000 })
  return jsonLines(ran.stdout, size > LOG_TAIL_BYTES)
}

async function pollLogs($: Engine, now: number): Promise<void> {
  if (poll.logsBusy) return
  poll.logsBusy = true
  poll.logsAt = now
  try {
    const { home } = await paths($)
    const jev = await tailLog($, join(home, '.claude/cache/jev-hooks.jsonl'))
    if (jev) logs.jev = jevRows(jev).slice(-ROWS)
    const gate = await tailLog($, join(home, '.claude/cache/delegation-gate.jsonl'))
    if (gate) logs.gate = gateRows(gate).slice(-ROWS)
    if (jev || gate) live.dirty = true
  } catch (error) {
    const at = await $.clock.now()
    await update($, hooks, feed => feedError(feed, `hook logs: ${String(error)}`, at))
  } finally {
    poll.logsBusy = false
  }
}

async function flushHooks($: Engine): Promise<void> {
  if (!live.dirty) return
  live.dirty = false
  const merged = [...logs.jev, ...logs.gate].sort((a, b) => a.at - b.at).slice(-ROWS)
  const candidates = [...live.rows, ...merged].filter(isBlocking).sort((a, b) => a.at - b.at)
  const snapshot: HooksSnapshot = { live: live.rows, logs: merged, inflight: live.inflight, lastBlock: candidates[candidates.length - 1] ?? null }
  const at = await $.clock.now()
  await update($, hooks, feed => feedOk(feed, snapshot, at))
}

async function readTask($: Engine, dir: string, id: string, now: number): Promise<SsaRun | null> {
  const entries = await $.fs.list(dir).catch(() => [])
  if (entries.length === 0) return null
  const mtime = Math.max(...entries.map(entry => entry.mtimeMs))
  const cached = runs.cache.get(id)
  if (cached && cached.mtime === mtime) return cached.run
  const names = new Set(entries.map(entry => entry.name))
  const eventsEntry = entries.find(entry => entry.name === 'events.jsonl')
  const events = eventsEntry && eventsEntry.size < 1048576 ? await readSmall($, join(dir, 'events.jsonl')) : ''
  const file = (name: string): Promise<string> => (names.has(name) ? readSmall($, join(dir, name)) : Promise.resolve(''))
  const run = taskRun(
    {
      id,
      events,
      kind: await file('kind.txt'),
      model: await file('model-used.txt'),
      worker: await file('worker.txt'),
      exitCode: await file('exit-code.txt'),
      startedAt: startedAtFromId(id),
      mtime,
    },
    now,
  )
  runs.cache.set(id, { mtime, run })
  return run
}

async function pollSsa($: Engine, now: number): Promise<void> {
  if (poll.ssaBusy) return
  poll.ssaBusy = true
  poll.ssaAt = now
  try {
    const { tmp } = await paths($)
    const root = join(tmp, 'smart-subagents')
    const entries = (await $.fs.exists(root)) ? await $.fs.list(root) : []
    const seen: SsaRun[] = []
    for (const entry of entries) {
      if (entry.kind !== 'dir' || entry.name === 'wt') continue
      const dir = join(root, entry.name)
      if (entry.name.startsWith('plan-')) {
        const files = await $.fs.list(dir).catch(() => [])
        const mtime = files.length ? Math.max(...files.map(file => file.mtimeMs)) : entry.mtimeMs
        seen.push(planRun({ id: entry.name, names: files.map(file => file.name), mtime, startedAt: startedAtFromId(entry.name) }, now))
      } else if (/^\d+-\d+$/.test(entry.name)) {
        const run = await readTask($, dir, entry.name, now)
        if (run) seen.push(run)
      }
    }
    const before = JSON.stringify(runs.history.map(run => [run.id, run.state, run.updatedAt]))
    runs.history = mergeHistory(runs.history, seen, now)
    if (JSON.stringify(runs.history.map(run => [run.id, run.state, run.updatedAt])) !== before) {
      await $.store.set('ssaHistory', runs.history).catch(() => undefined)
    }
    for (const run of seen) {
      const previous = runs.states.get(run.id)
      if (previous === 'running' && run.state !== 'running') $.ui.toast(`Smart Subagents ${run.type} ${run.id} ${run.state}${run.failureClass ? ` (${run.failureClass})` : ''}`)
      runs.states.set(run.id, run.state)
    }
    const snapshot: SsaSnapshot = {
      running: seen.filter(run => run.state === 'running').sort((a, b) => b.updatedAt - a.updatedAt),
      recent: runs.history.filter(run => run.state !== 'running').slice(0, 15),
    }
    const at = await $.clock.now()
    await update($, ssa, feed => feedOk(feed, snapshot, at))
  } catch (error) {
    const at = await $.clock.now()
    await update($, ssa, feed => feedError(feed, String(error), at))
  } finally {
    poll.ssaBusy = false
  }
}

async function tick($: Engine): Promise<void> {
  try {
    const now = await $.clock.now()
    const panelState = await read($, panel)
    const ssaState = await read($, ssa)
    const current = await read($, interview)
    const panes = await $.ui.panes().catch(() => [])
    const isPaneShown = panes.some(pane => pane.id === PANE && pane.isShown)
    const isActive =
      isPaneShown ||
      now - host.lastRenderAt < ACTIVE_WINDOW_MS ||
      (ssaState.data?.running.length ?? 0) > 0 ||
      panelState.phase === 'countdown' ||
      panelState.phase === 'running' ||
      current.id !== null
    if (now - poll.quotaAt >= (isActive ? QUOTA_ACTIVE_MS : QUOTA_IDLE_MS)) void pollQuota($, now)
    const filesEvery = isActive ? FILES_ACTIVE_MS : FILES_IDLE_MS
    if (now - poll.ssaAt >= filesEvery) void pollSsa($, now)
    if (now - poll.logsAt >= filesEvery) void pollLogs($, now)
    await flushHooks($)
  } catch {
    live.dirty = true
  }
}

function stopCountdown(): void {
  timers.countdown?.cancel()
  timers.countdownTicker?.cancel()
  timers.countdown = null
  timers.countdownTicker = null
}

async function markTried($: Engine, itemId: string): Promise<void> {
  await update($, interview, current => (current.panelTried.includes(itemId) ? current : { ...current, panelTried: [...current.panelTried, itemId] }))
}

async function cancelPanel($: Engine): Promise<void> {
  stopCountdown()
  const current = await read($, panel)
  if (current.phase !== 'countdown') return
  await markTried($, current.itemId)
  await update($, panel, (value): Panel => ({ ...value, phase: 'cancelled', message: 'Cancelled by you.' }))
}

async function maybeStartPanel($: Engine): Promise<void> {
  const current = await read($, panel)
  if (current.phase === 'countdown' || current.phase === 'running') return
  const item = panelCandidate(await read($, interview), await read($, meter))
  if (item === null) return
  const now = await $.clock.now()
  const blocked = quotaBlocksPanel(await read($, quota), now)
  if (blocked) {
    await markTried($, item.id)
    await update($, panel, (): Panel => ({ ...IDLE_PANEL, phase: 'skipped', itemId: item.id, label: item.question || item.id, message: `Auto panel skipped: ${blocked}.` }))
    return
  }
  await update($, panel, (): Panel => ({ ...IDLE_PANEL, phase: 'countdown', itemId: item.id, label: item.question || item.id, deadline: now + COUNTDOWN_MS, message: 'Starts in 30s.' }))
  await update($, isBandHidden, () => false)
  void openPane($)
  $.ui.toast(`Auto panel on "${item.question || item.id}" starts in 30s. Cancel in the Cockpit pane.`)
  stopCountdown()
  timers.countdownTicker = $.clock.every(1000, () => {
    void countdownTick($)
  })
  timers.countdown = $.clock.after(COUNTDOWN_MS, () => {
    void launchPanel($)
  })
}

async function countdownTick($: Engine): Promise<void> {
  const now = await $.clock.now()
  await update($, panel, (value): Panel =>
    value.phase === 'countdown' ? { ...value, message: `Starts in ${Math.max(0, Math.ceil((value.deadline - now) / 1000))}s.` } : value,
  )
}

async function panelRepo($: Engine, scratch: string): Promise<string> {
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 }).catch(() => null)
  if (top && top.exitCode === 0 && top.stdout.trim()) return top.stdout.trim()
  await $.process.run(['git', 'init', '-q', '-b', 'panel', scratch], { timeoutMs: 10000 })
  await $.process.run(['git', '-C', scratch, 'commit', '--allow-empty', '-qm', 'panel context'], { timeoutMs: 10000 })
  return scratch
}

async function launchPanel($: Engine): Promise<void> {
  stopCountdown()
  const current = await read($, panel)
  if (current.phase !== 'countdown') return
  const fail = (message: string) => update($, panel, (value): Panel => ({ ...value, phase: 'skipped', message }))
  const now = await $.clock.now()
  const iv = await read($, interview)
  const m = await read($, meter)
  const item = m?.openItems?.find(entry => entry.id === current.itemId)
  if (iv.id === null || m === null) return void (await fail('Auto panel skipped: the interview ended.'))
  if (!item) return void (await fail('Auto panel skipped: the item is no longer open.'))
  if (!(await $.fs.exists(join((await paths($)).home, PANEL_SCRIPT)))) return void (await fail(`Auto panel skipped: ~/${PANEL_SCRIPT} not found (${SSA_URL}).`))
  const blocked = quotaBlocksPanel(await read($, quota), now)
  if (blocked) return void (await fail(`Auto panel skipped: ${blocked}.`))
  await markTried($, item.id)
  try {
    const { home, tmp, cwd } = await paths($)
    const dir = join(tmp, `cockpit-panels/${now}`)
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 })
    const decisions = join(home, `.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/questioning.md`)
    const goalFile = join(dir, 'goal.md')
    await $.fs.write(goalFile, panelGoal(m, item, decisions))
    const repo = await panelRepo($, join(dir, 'repo'))
    await update($, panel, (value): Panel => ({ ...value, phase: 'running', startedAt: now, goalFile, message: 'Panel running: 3 planners.' }))
    const stream = $.process.spawn({
      argv: ['bash', join(home, PANEL_SCRIPT), 'plan', '--repo', repo, '--n', '3', '--difficulty', 'hard', '--goal-file', goalFile],
    })
    let output = ''
    for await (const chunk of stream) output = (output + chunk.text).slice(-20000)
    const ended = await stream.result
    const runDir = output.match(/smart-subagents\/(plan-[\d-]+)/)?.[1] ?? ''
    const usable = output.match(/"usable_plans":\s*(\d+)/)?.[1] ?? '?'
    const isOk = ended.code === 0
    await update($, panel, (value): Panel => ({
      ...value,
      phase: isOk ? 'done' : 'failed',
      message: isOk ? `Panel done: ${usable} usable plans in ${runDir || 'the smart-subagents folder'}.` : `Panel failed (exit ${ended.code ?? ended.signal}).`,
    }))
    $.ui.toast(isOk ? `Auto panel finished: ${usable} plans.` : 'Auto panel failed.')
    if (isOk) {
      await $.prompt.fill({
        text: `The auto panel on "${item.question || item.id}" finished (${usable} plans in ${join(tmp, `smart-subagents/${runDir}`)}). Read every plan, reconcile them, and bring back one answer.`,
        mode: 'insert',
      })
    }
  } catch (error) {
    await update($, panel, (value): Panel => ({ ...value, phase: 'failed', message: `Panel failed: ${String(error).slice(0, 200)}` }))
  }
}

async function recoverPanel($: Engine): Promise<void> {
  const current = await read($, panel)
  if (current.phase === 'running') {
    await update($, panel, (value): Panel => ({ ...value, phase: 'failed', message: 'Interrupted: the mod reloaded while the panel ran. Its run folder may still finish; check Subagents.' }))
    return
  }
  if (current.phase !== 'countdown') return
  const remaining = Math.max(1000, current.deadline - (await $.clock.now()))
  stopCountdown()
  timers.countdownTicker = $.clock.every(1000, () => {
    void countdownTick($)
  })
  timers.countdown = $.clock.after(remaining, () => {
    void launchPanel($)
  })
}

async function handleMeter($: Engine, input: Record<string, unknown>): Promise<string> {
  const parsed = parseMeterInput(input)
  if (!parsed.ok) return `Rejected: ${parsed.error}. Fix the fields and call the meter again.`
  const now = await $.clock.now()
  const before = await read($, interview)
  const applied = applyMeter(before, parsed.value, String(now))
  if (!applied.ok) return `Rejected: ${applied.error}.`
  const next: Interview = applied.value
  await update($, interview, () => next)
  const previous = await read($, meter)
  const built = meterFromInput(previous, parsed.value, next)
  await update($, meter, () => built)
  if (parsed.value.event === 'start') {
    await update($, isBandHidden, () => false)
    await update($, panel, () => IDLE_PANEL)
    void openPane($)
  }
  if (parsed.value.event === 'stop_check') await maybeStartPanel($)
  if (parsed.value.event === 'finish') return `Recorded finish. Interview closed after ${next.totalAnswers} answers.`
  const allowed = next.permits.length
  return [
    `Recorded ${parsed.value.event}. ${next.totalAnswers} answers so far, ${next.answersSinceStop} since the last stop check (stop check due at ${STOP_EVERY}).`,
    allowed ? `You may now ask ${allowed} question${allowed === 1 ? '' : 's'} with AskUserQuestion.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

async function statusReport($: Engine): Promise<string> {
  const now = await $.clock.now()
  const current = await read($, meter)
  const iv = await read($, interview)
  const panelState = await read($, panel)
  const quotaFeed = await read($, quota)
  const hooksFeed = await read($, hooks)
  const ssaFeed = await read($, ssa)
  const lowest = lowestWindow(quotaFeed.data)
  const feed = (status: string, error: string, lastOkAt: number) => ({ status, error: error || undefined, lastOk: ago(lastOkAt, now) })
  return JSON.stringify(
    {
      questioning: {
        meter: current ? { clarity: current.clarity, status: current.status, source: current.source ?? 'text', history: current.history, open: current.open } : null,
        interview: { armed: iv.id !== null, totalAnswers: iv.totalAnswers, answersSinceStop: iv.answersSinceStop, blocks: iv.blocks, stopChecks: iv.stopChecks, warnings: iv.warnings.slice(-3), openStreak: iv.openStreak },
        panel: { phase: panelState.phase, item: panelState.label, message: panelState.message },
      },
      quota: {
        ...feed(quotaFeed.status, quotaFeed.error, quotaFeed.lastOkAt),
        lowest: lowest ? `${lowest.cli} ${lowest.window.remainingPct}% ${lowest.window.name} ${until(lowest.window.resetsAt, now)}` : null,
        primary: quotaFeed.data?.primary,
        localLaborOk: quotaFeed.data?.localLaborOk,
        clis: (quotaFeed.data?.clis ?? []).map(cli => `${cli.cli}:${cli.available ? tightestPct(cli) ?? '?' : 'unavailable'}`),
      },
      hooks: {
        ...feed(hooksFeed.status, hooksFeed.error, hooksFeed.lastOkAt),
        inflight: hooksFeed.data?.inflight ?? 0,
        live: (hooksFeed.data?.live ?? []).slice(-5).map(row => `${clock(row.at)} ${row.event} ${row.tool} ${row.ms}ms ${row.outcome}`),
        logs: (hooksFeed.data?.logs ?? []).slice(-5).map(row => `${clock(row.at)} ${row.source} ${row.event} ${row.tool} ${row.outcome}`),
        lastBlock: hooksFeed.data?.lastBlock ? `${clock(hooksFeed.data.lastBlock.at)} ${hooksFeed.data.lastBlock.source} ${hooksFeed.data.lastBlock.outcome} ${hooksFeed.data.lastBlock.tool}` : null,
      },
      subagents: {
        ...feed(ssaFeed.status, ssaFeed.error, ssaFeed.lastOkAt),
        running: (ssaFeed.data?.running ?? []).map(run => `${run.id} ${run.type} ${run.worker} ${run.phase}`),
        recent: (ssaFeed.data?.recent ?? []).slice(0, 5).map(run => `${run.id} ${run.state} ${run.kind} ${run.worker} ${run.failureClass}`.trim()),
        historySize: runs.history.length,
      },
      pane: { lastRender: ago(host.lastRenderAt, now), lastOpen: host.lastOpen, panes: (await $.ui.panes()).map(pane => `${pane.id}${pane.isShown ? ' shown' : ' hidden'}`) },
    },
    null,
    1,
  )
}

async function cockpitData($: Engine, columns: number): Promise<CockpitData> {
  return {
    now: Date.now(),
    width: columns,
    meter: await read($, meter),
    interview: await read($, interview),
    panel: await read($, panel),
    quota: await read($, quota),
    hooks: await read($, hooks),
    ssa: await read($, ssa),
    open: await read($, sections),
  }
}

async function refreshAll($: Engine): Promise<void> {
  poll.quotaAt = 0
  poll.logsAt = 0
  poll.ssaAt = 0
  logs.size = {}
  await tick($)
}

function cockpitActions($: Engine): CockpitActions {
  return {
    toggle: key => void update($, sections, value => ({ ...value, [key]: !value[key] })),
    cancelPanel: () => void cancelPanel($),
    refresh: () => void refreshAll($),
    openPane: () => void openPane($, true),
    hideBand: () => void update($, isBandHidden, () => true),
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cockpit', description: 'Open the Cockpit pane: questioning, quota, hooks and Smart Subagents.' })
    await $.command.register({ name: 'clarity', description: 'Open the Cockpit pane. "/clarity reset" clears the questioning meter and interview.' })
    await $.tool.register({ name: 'meter', description: METER_DESCRIPTION, inputSchema: METER_SCHEMA })
    await $.tool.register({ name: 'status', description: 'Read the Cockpit: questioning meter and enforcer state, AI quota per CLI, recent settings-hook runs and gate/Jev log rows, Smart Subagents runs now and recent history. Read-only, returns JSON.', inputSchema: { type: 'object', properties: {} } })
    const stored = await $.store.get('ssaHistory').catch(() => undefined)
    if (isRunList(stored)) runs.history = stored
    await refreshFromText($)
    await recoverPanel($)
    void openPane($)
    timers.tick?.cancel()
    timers.tick = $.clock.every(TICK_MS, () => {
      void tick($)
    })
    void tick($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timers.tick?.cancel()
    stopCountdown()
    return next(e)
  })

  on('tool.call', { tool: METER_TOOL }, async ($, e) => {
    const { tool, tool_use_id, ...input } = e
    void tool
    void tool_use_id
    return { result: await handleMeter($, input) }
  })

  on('tool.call', { tool: 'mcp__claude-code-cockpit__status' }, async $ => ({ result: await statusReport($) }))

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const questionCount = e.questions.length
    const decision = checkAsk(await read($, interview), await read($, meter), questionCount)
    await update($, interview, () => decision.interview)
    if (decision.block) return { deny: decision.block }
    await refreshFromText($)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    const answered = isRecord(ran.result) ? countAnswered(ran.result.answers, ran.result.response, questionCount) : 0
    await update($, interview, current => recordAnswers(current, e.tool_use_id, answered, decision.fromStop))
    if (decision.warnings.length === 0) return ran
    return { ...ran, context: [...(ran.context ?? []), `Questioning enforcer: ${decision.warnings.join(' ')}`] }
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const startedAt = Date.now()
    live.inflight += 1
    live.dirty = true
    try {
      const result = await next(e)
      recordLive('PreToolUse', hookTool(e), startedAt, hookOutcome(result))
      return result
    } finally {
      live.inflight -= 1
    }
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const startedAt = Date.now()
    live.inflight += 1
    try {
      const result = await next(e)
      recordLive('PostToolUse', hookTool(e), startedAt, hookOutcome(result))
      return result
    } finally {
      live.inflight -= 1
    }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const startedAt = Date.now()
    live.inflight += 1
    try {
      const result = await next(e)
      recordLive('UserPromptSubmit', '', startedAt, hookOutcome(result))
      return result
    } finally {
      live.inflight -= 1
    }
  })

  on('classic.Stop', async ($, e, next) => {
    const startedAt = Date.now()
    live.inflight += 1
    try {
      const result = await next(e)
      recordLive('Stop', '', startedAt, hookOutcome(result))
      return result
    } finally {
      live.inflight -= 1
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await refreshFromText($, e.answer)
    return next(e)
  })

  on('command.run', { command: ['clarity', 'cockpit'] }, async ($, e) => {
    if (/^\s*reset\s*$/i.test(e.args)) {
      stopCountdown()
      await update($, meter, () => null)
      await update($, interview, () => emptyInterview())
      await update($, panel, () => IDLE_PANEL)
      await update($, isBandHidden, () => false)
      return { text: 'Questioning meter and interview cleared.' }
    }
    await update($, isBandHidden, () => false)
    await update($, sections, () => ALL_OPEN)
    await openPane($, true)
    void tick($)
    const current = await read($, meter)
    return { text: current ? `Cockpit open. Clarity ${current.clarity}/10.` : 'Cockpit open.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const ui = $.ui.resolve(e)
    const band = Band({ ui, data: await cockpitData($, 0), actions: cockpitActions($) })
    return band ?? next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    host.lastRenderAt = Date.now()
    const ui = $.ui.resolve(e)
    return <Cockpit ui={ui} data={await cockpitData($, e.props.bodyColumns)} actions={cockpitActions($)} />
  })
}
