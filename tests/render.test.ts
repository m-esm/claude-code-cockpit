import { expect, mock, test } from 'claude-code/testing'

import type { HookRow, SsaRun } from '../types'
import { clarityChart, escapeXml, hooksChart, progressBar, quotaChart, quotaRows, runStrip } from '../hooks/charts'
import { parseQuota } from '../hooks/feeds'

const PANE = { plugin: 'questioning-meter', component: 'Pane', requestId: 'questioning-meter' } as const
const PANE_PROPS = { title: 'Cockpit', isFocused: true, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } as const

const METER = {
  topic: 'cockpit visuals',
  phase: 'probing',
  clarity: 6,
  picture: 'Card per section with SVG charts on desktop.',
  buildNow: 'Components file plus chart builders.',
  slots: [
    { id: 'goal', label: 'Goal', state: 'settled' },
    { id: 'approach', label: 'Approach', state: 'partial' },
    { id: 'risks', label: 'Risks', state: 'open' },
  ],
  openItems: [{ id: 'svg-theme', slotId: 'approach', question: 'Does SVG follow dark mode?', impact: 'high', costOfWrong: 'unreadable charts' }],
  lensesCovered: ['User', 'Outcome'],
  lensesThin: ['Contrarian'],
}

const isWellFormed = (source: string): boolean => {
  const opened = (source.match(/<(svg|text|rect|path|line|polyline|circle|title|style)(\s[^>]*)?>/g) ?? []).filter(tag => !tag.endsWith('/>')).length
  const closed = (source.match(/<\/(svg|text|rect|path|line|polyline|circle|title|style)>/g) ?? []).length
  return source.startsWith('<svg') && source.endsWith('</svg>') && opened === closed && !/NaN|undefined|Infinity/.test(source)
}

const run = (id: string, state: SsaRun['state']): SsaRun => ({
  id, type: 'task', kind: 'impl', worker: 'grok', model: '', state, phase: state, exitCode: null, failureClass: '', detail: '', startedAt: 1, updatedAt: 2,
})

test('charts produce well-formed svg for empty, single and full data', async () => {
  const quota = parseQuota(JSON.stringify({ clis: [{ cli: 'codex', available: true, eligible: true, windows: [{ name: 'primary_window', remaining_pct: 0, resets_at: null }] }, { cli: 'kimi', available: false, error: 'login <expired>', windows: [] }], recommendation: { primary_worker: 'codex' } }))
  const rows = quotaRows(quota.clis, quota.primary, () => 'resets in 5m')
  const hookRows: HookRow[] = [{ at: 1, source: 'live', event: 'PreToolUse', tool: 'Bash', ms: 66, outcome: 'ok', detail: '' }, { at: 2, source: 'live', event: 'PreToolUse', tool: 'Bash', ms: 0, outcome: 'deny', detail: '' }]
  const sources = [
    clarityChart(0, []),
    clarityChart(7, [7]),
    clarityChart(10, [2, 5, 7, 9, 10], 600),
    quotaChart(rows),
    quotaChart([]),
    hooksChart([]),
    hooksChart(hookRows),
    runStrip([run('a', 'done'), run('b', 'failed'), run('c', 'expired')]),
    progressBar(1.4, 'warn'),
  ]
  for (const source of sources) expect(isWellFormed(source)).toBe(true)
  expect(quotaChart(rows).includes('login &lt;expired&gt;')).toBe(true)
  expect(escapeXml('a<b & "c"')).toBe('a&lt;b &amp; &quot;c&quot;')
})

test('pane draws cards with svg charts on desktop and text bars on terminal', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-07T09:00:00Z') })
  mock.store(on)
  mock.env(on, { HOME: '/home/test', TMPDIR: '/tmp/' })
  await $.tool.call({ tool: 'mcp__questioning-meter__meter', tool_use_id: 'seed-1', event: 'start', ...METER, questions: [] } as never)
  await $.tool.call({ tool: 'mcp__questioning-meter__meter', tool_use_id: 'seed-2', event: 'stop_check', ...METER, clarity: 7, questions: [{ text: 'Where next?', lens: 'Outcome', move: 'Converge' }] } as never)

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', props: PANE_PROPS })
  expect(await desktop.find({ text: /Cockpit/ })).toBeDefined()
  expect(await desktop.find({ key: 'toggle-questioning' })).toBeDefined()
  expect(await desktop.find({ key: 'toggle-subagents' })).toBeDefined()
  const svgs = await desktop.findAll({ type: 'Svg' })
  expect(svgs.length > 0).toBe(true)
  expect(svgs.every(found => isWellFormed(String(found.props.source)))).toBe(true)
  expect(await desktop.find({ text: /Approach/ })).toBeDefined()
  expect(await desktop.find({ text: /Does SVG follow dark mode/ })).toBeDefined()
  await desktop.press({ key: 'toggle-questioning' })
  expect(await desktop.find({ text: /Does SVG follow dark mode/ })).toBe(undefined)
  await desktop.press({ key: 'toggle-questioning' })
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', props: PANE_PROPS })
  expect((await terminal.findAll({ type: 'Svg' })).length).toBe(0)
  expect(await terminal.find({ text: /7\/10/ })).toBeDefined()
  await terminal.unmount()
})
