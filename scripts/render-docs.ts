import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { clarityChart, hooksChart, quotaChart, quotaRows, runStrip } from '../hooks/charts.ts'

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs')
const WIDTH = 460

const clis = [
  { cli: 'claude', available: true, eligible: true, error: '', windows: [{ name: 'weekly_all', remainingPct: 62, resetsAt: null, severity: 'ok' }] },
  { cli: 'codex', available: true, eligible: true, error: '', windows: [{ name: 'primary_window', remainingPct: 18, resetsAt: null, severity: 'warn' }] },
  { cli: 'grok', available: true, eligible: true, error: '', windows: [{ name: 'weekly_pool', remainingPct: 45, resetsAt: null, severity: 'ok' }] },
  { cli: 'kimi', available: false, eligible: false, error: 'not logged in', windows: [] },
]

const hookRows = Array.from({ length: 30 }, (_, index) => ({
  at: index,
  source: 'live' as const,
  event: index % 2 ? 'PostToolUse' : 'PreToolUse',
  tool: 'Bash',
  ms: [64, 52, 118, 41, 880, 33, 76][index % 7] ?? 50,
  outcome: index === 19 ? 'deny' : index === 9 ? 'context' : 'ok',
  detail: '',
}))

const states = ['done', 'done', 'failed', 'done', 'expired', 'done', 'done', 'done', 'failed', 'done', 'done', 'done'] as const
const runs = states.map((state, index) => ({
  id: `run-${index}`,
  type: 'task' as const,
  kind: 'impl',
  worker: 'worker',
  model: '',
  state,
  phase: state,
  exitCode: null,
  failureClass: '',
  detail: '',
  startedAt: 0,
  updatedAt: 0,
}))

const files: Record<string, string> = {
  'clarity.svg': clarityChart(7, [4, 5, 5, 6, 7], WIDTH),
  'quota.svg': quotaChart(quotaRows(clis, 'grok', () => 'resets in 2h10m'), WIDTH),
  'hooks.svg': hooksChart(hookRows, WIDTH),
  'runs.svg': runStrip(runs, WIDTH),
}

const isCheck = process.argv.includes('--check')
const stale = Object.entries(files).filter(([name, source]) => {
  const path = join(DOCS, name)
  if (isCheck) {
    try {
      return readFileSync(path, 'utf8') !== `${source}\n`
    } catch {
      return true
    }
  }
  mkdirSync(DOCS, { recursive: true })
  writeFileSync(path, `${source}\n`)
  return false
})

if (stale.length) {
  console.error(`docs out of date: ${stale.map(([name]) => name).join(', ')}. Run: node --experimental-strip-types scripts/render-docs.ts`)
  process.exit(1)
}
console.log(isCheck ? 'docs up to date' : `wrote ${Object.keys(files).length} files to docs/`)
