import { expect, test } from 'claude-code/testing'

import type { QuotaSnapshot } from '../types'

import { emptyFeed, feedOk, gateRows, jevRows, jsonLines, lowestWindow, mergeHistory, parseQuota, planRun, quotaBlocksPanel, taskRun } from '../hooks/feeds'

const QUOTA = JSON.stringify({
  checked_at: '2026-10-06T18:00:00Z',
  clis: [
    { cli: 'claude', available: true, eligible: true, windows: [{ name: '5h_session', remaining_pct: 61, resets_at: '2026-10-06T21:00:00Z', severity: 'ok' }] },
    { cli: 'grok', available: true, eligible: true, windows: [{ name: 'day', remaining_pct: 40, resets_at: null, severity: 'warn' }] },
    { cli: 'kimi', available: false, eligible: false, error: 'login expired', windows: [] },
    { cli: 'codex', available: true, eligible: true, windows: [{ name: 'primary_window', remaining_pct: 37.19999999999999, resets_at: null, severity: 'ok' }] },
  ],
  recommendation: { primary_worker: 'codex', local_labor_ok: true },
})

const EVENTS = [
  '{"seq": 13, "ts": "2026-10-06T16:05:43Z", "phase": "exited", "worker": "deepseek", "exit": 0, "failure_class": null}',
  '{"seq": 14, "ts": "2026-10-06T16:07:24Z", "phase": "failed", "worker": "deepseek", "exit": 1, "failure_class": "verify-fail"}',
  '{"seq": 16, "ts": "2026-10-06T16:11:44Z", "phase": "running", "worker": "deepseek", "pid": 45438, "exit": null}',
].join('\n')

test('parses quota and finds the tightest window', async () => {
  const snapshot = parseQuota(QUOTA)
  expect(snapshot.clis.length).toBe(4)
  expect(snapshot.clis[3]?.windows[0]?.remainingPct).toBe(37.2)
  expect(lowestWindow(snapshot)?.cli).toBe('codex')
  expect(snapshot.localLaborOk).toBe(true)
})

test('quota gate for the auto panel', async () => {
  const now = Date.parse('2026-10-06T18:01:00Z')
  const fresh = feedOk(emptyFeed<QuotaSnapshot>(), parseQuota(QUOTA), now)
  expect(quotaBlocksPanel(fresh, now)).toBe(null)
  expect(quotaBlocksPanel(fresh, now + 6 * 60 * 1000)).toBe('quota data is older than 5 minutes')
  expect(quotaBlocksPanel(emptyFeed<QuotaSnapshot>(), now)).toBe('no quota data yet')
  const drained = feedOk(emptyFeed<QuotaSnapshot>(), { ...parseQuota(QUOTA), localLaborOk: false, clis: [] }, now)
  expect(quotaBlocksPanel(drained, now)).toBe('no eligible worker has quota left')
  const localTight = feedOk(emptyFeed<QuotaSnapshot>(), { ...parseQuota(QUOTA), localLaborOk: false }, now)
  expect(quotaBlocksPanel(localTight, now)).toBe(null)
})

test('a retry after verify-fail reads as running, not failed', async () => {
  const now = Date.parse('2026-10-06T16:12:00Z')
  const run = taskRun({ id: '1791301186-34551', events: EVENTS, kind: 'impl\n', model: 'deepseek-v4', worker: '', exitCode: '1', startedAt: 0, mtime: now }, now)
  expect(run.state).toBe('running')
  expect(run.worker).toBe('deepseek')
})

test('a failed last event reads as failed with its class', async () => {
  const now = Date.parse('2026-10-06T16:08:00Z')
  const run = taskRun({ id: 'a-1', events: EVENTS.split('\n').slice(0, 2).join('\n'), kind: '', model: '', worker: '', exitCode: '', startedAt: 0, mtime: now }, now)
  expect(run.state).toBe('failed')
  expect(run.failureClass).toBe('verify-fail')
})

test('panel runs count finished plans', async () => {
  const run = planRun({ id: 'plan-1791309439-64150', names: ['plan-0-pragmatic-grok.md', 'planner-0.pid', 'planner-1.pid', 'planner-2.pid'], mtime: 1, startedAt: 1 }, 2)
  expect(run.state).toBe('running')
  expect(run.detail).toBe('1 of 3 plans')
  const done = planRun({ id: 'plan-1', names: ['panel-done.txt'], mtime: 1, startedAt: 1 }, 2)
  expect(done.state).toBe('done')
})

test('history marks vanished running runs expired and prunes old ones', async () => {
  const now = Date.parse('2026-10-06T18:00:00Z')
  const running = taskRun({ id: 'r-1', events: EVENTS, kind: '', model: '', worker: '', exitCode: '', startedAt: 0, mtime: now }, now)
  const merged = mergeHistory([running, { ...running, id: 'old', state: 'done', updatedAt: now - 40 * 24 * 3600 * 1000 }], [], now)
  expect(merged.length).toBe(1)
  expect(merged[0]?.state).toBe('expired')
})

test('hook log rows', async () => {
  const jev = jevRows(jsonLines('{"ts": "2026-10-06T20:54:39+0300", "tool": "Bash", "event": "command", "noul": 0.02, "deny": false}\n', false))
  expect(jev[0]?.outcome).toBe('allow')
  const tail = jsonLines('partial line}\n{"ts": "2026-10-06T20:49:02+0300", "harness": "grok", "event": "prompt", "labor": 0.13, "fired": []}\n', true)
  const gate = gateRows(tail)
  expect(gate.length).toBe(1)
  expect(gate[0]?.outcome).toBe('quiet')
})
