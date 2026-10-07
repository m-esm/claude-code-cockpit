import type { HookRow, QuotaCli, SsaRun } from '../types'

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted'

type Shade = { light: string; dark: string }

const PALETTE: Record<Tone | 'track' | 'ink' | 'sub' | 'grid', Shade> = {
  good: { light: '#2f9e63', dark: '#4cc38a' },
  warn: { light: '#c27c0e', dark: '#e5b546' },
  bad: { light: '#cf4545', dark: '#f07474' },
  info: { light: '#3478c0', dark: '#6aaee8' },
  muted: { light: '#9aa0a8', dark: '#6b7079' },
  track: { light: '#e7e9ec', dark: '#2b2f35' },
  grid: { light: '#d4d7dc', dark: '#3a3f46' },
  ink: { light: '#1f2328', dark: '#e6e8eb' },
  sub: { light: '#6b7079', dark: '#9aa1ab' },
}

const FILL_CLASSES = Object.keys(PALETTE) as (keyof typeof PALETTE)[]

const STYLE = [
  '<style>',
  'text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}',
  ...FILL_CLASSES.map(name => `.f-${name}{fill:${PALETTE[name].light}}.s-${name}{stroke:${PALETTE[name].light}}`),
  '@media (prefers-color-scheme: dark){',
  ...FILL_CLASSES.map(name => `.f-${name}{fill:${PALETTE[name].dark}}.s-${name}{stroke:${PALETTE[name].dark}}`),
  '}',
  '</style>',
].join('')

export const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (width: number, height: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${STYLE}${body}</svg>`

const round = (value: number): number => Math.round(value * 10) / 10

export const clarityTone = (clarity: number): Tone => (clarity >= 8 ? 'good' : clarity >= 5 ? 'warn' : 'bad')

export const pctTone = (pct: number | null): Tone => (pct === null ? 'muted' : pct < 20 ? 'bad' : pct < 50 ? 'warn' : 'good')

export const runTone = (state: string): Tone =>
  state === 'running' ? 'info' : state === 'failed' ? 'bad' : state === 'expired' ? 'muted' : 'good'

export const hookTone = (outcome: string): Tone =>
  outcome === 'deny' || outcome === 'block' || outcome.startsWith('fired') ? 'bad' : outcome === 'ask' || outcome === 'context' ? 'warn' : 'info'

const arc = (cx: number, cy: number, r: number, from: number, to: number): string => {
  const point = (t: number) => {
    const angle = Math.PI * (1 - t)
    return `${round(cx + r * Math.cos(angle))} ${round(cy - r * Math.sin(angle))}`
  }
  return `M ${point(from)} A ${r} ${r} 0 0 1 ${point(to)}`
}

export const clarityChart = (clarity: number, history: readonly number[], width = 340): string => {
  const height = 96
  const tone = clarityTone(clarity)
  const t = Math.max(0, Math.min(1, clarity / 10))
  const gauge = [
    `<path d="${arc(52, 70, 40, 0, 1)}" class="s-track" stroke-width="10" fill="none" stroke-linecap="round"/>`,
    t > 0 ? `<path d="${arc(52, 70, 40, 0, t)}" class="s-${tone}" stroke-width="10" fill="none" stroke-linecap="round"/>` : '',
    `<text x="52" y="66" text-anchor="middle" font-size="22" font-weight="600" class="f-ink">${round(clarity)}</text>`,
    `<text x="52" y="86" text-anchor="middle" font-size="10" class="f-sub">clarity / 10</text>`,
  ].join('')

  const left = 118
  const right = width - 8
  const top = 14
  const bottom = 78
  const y = (value: number) => round(bottom - (Math.max(0, Math.min(10, value)) / 10) * (bottom - top))
  const points = history.slice(-20)
  const step = points.length > 1 ? (right - left) / (points.length - 1) : 0
  const xy = points.map((value, index) => `${round(points.length > 1 ? left + index * step : (left + right) / 2)},${y(value)}`)
  const trend = [
    `<line x1="${left}" x2="${right}" y1="${y(8)}" y2="${y(8)}" class="s-good" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>`,
    `<text x="${right}" y="${y(8) - 4}" text-anchor="end" font-size="9" class="f-sub">ready at 8</text>`,
    `<line x1="${left}" x2="${right}" y1="${bottom}" y2="${bottom}" class="s-grid" stroke-width="1"/>`,
    points.length > 1 ? `<polyline points="${xy.join(' ')}" fill="none" class="s-${tone}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` : '',
    ...xy.map((pair, index) => {
      const [cx, cy] = pair.split(',')
      const isLast = index === xy.length - 1
      return `<circle cx="${cx}" cy="${cy}" r="${isLast ? 3.5 : 2}" class="f-${isLast ? tone : 'sub'}"/>`
    }),
    `<text x="${left}" y="92" font-size="9" class="f-sub">${points.length} stop check${points.length === 1 ? '' : 's'}</text>`,
  ].join('')

  return svg(width, height, gauge + trend)
}

export type QuotaRow = { cli: string; pct: number | null; window: string; reset: string; available: boolean; isPrimary: boolean; note: string }

export const quotaRows = (clis: readonly QuotaCli[], primary: string, describeReset: (iso: string | null) => string): QuotaRow[] =>
  clis.map(cli => {
    const tightest = cli.windows
      .filter(window => window.remainingPct !== null)
      .sort((a, b) => (a.remainingPct ?? 0) - (b.remainingPct ?? 0))[0]
    return {
      cli: cli.cli,
      pct: tightest?.remainingPct ?? null,
      window: tightest?.name.replace(/_/g, ' ') ?? '',
      reset: tightest ? describeReset(tightest.resetsAt) : '',
      available: cli.available,
      isPrimary: cli.cli === primary,
      note: cli.available ? (cli.eligible ? '' : 'not eligible') : cli.error || 'unavailable',
    }
  })

export const quotaChart = (rows: readonly QuotaRow[], width = 340): string => {
  const rowHeight = 30
  const height = rows.length * rowHeight + 6
  const labelWidth = 74
  const barLeft = labelWidth
  const barRight = width - 8
  const barWidth = barRight - barLeft
  const body = rows
    .map((row, index) => {
      const top = 4 + index * rowHeight
      const tone = row.available ? pctTone(row.pct) : 'muted'
      const fill = row.pct === null ? 0 : Math.max(0, Math.min(100, row.pct)) / 100
      const caption = row.available
        ? row.pct === null
          ? ['no usage window reported', row.note].filter(Boolean).map(escapeXml).join(' · ')
          : `${round(row.pct)}% left · ${escapeXml(row.window)}${row.reset ? ` · ${escapeXml(row.reset)}` : ''}${row.note ? ` · ${escapeXml(row.note)}` : ''}`
        : escapeXml(row.note)
      return [
        `<text x="0" y="${top + 11}" font-size="11.5" font-weight="${row.isPrimary ? 700 : 500}" class="f-${row.available ? 'ink' : 'muted'}">${escapeXml(row.cli)}${row.isPrimary ? ' ★' : ''}</text>`,
        `<rect x="${barLeft}" y="${top + 3}" width="${barWidth}" height="8" rx="4" class="f-track"/>`,
        fill > 0 ? `<rect x="${barLeft}" y="${top + 3}" width="${round(Math.max(8, barWidth * fill))}" height="8" rx="4" class="f-${tone}"/>` : '',
        `<text x="${barLeft}" y="${top + 24}" font-size="9.5" class="f-sub">${caption}</text>`,
      ].join('')
    })
    .join('')
  return svg(width, height, body)
}

export const hooksChart = (rows: readonly HookRow[], width = 340): string => {
  const height = 64
  const recent = rows.slice(-40)
  const maxMs = Math.max(50, ...recent.map(row => row.ms))
  const scale = (ms: number) => Math.log10(1 + ms) / Math.log10(1 + maxMs)
  const top = 6
  const bottom = 48
  const slot = (width - 8) / Math.max(24, recent.length)
  const bars = recent
    .map((row, index) => {
      const h = Math.max(2, scale(row.ms) * (bottom - top))
      return `<rect x="${round(4 + index * slot + slot * 0.15)}" y="${round(bottom - h)}" width="${round(slot * 0.7)}" height="${round(h)}" rx="1.5" class="f-${hookTone(row.outcome)}"><title>${escapeXml(`${row.event} ${row.tool} ${row.ms}ms ${row.outcome}`)}</title></rect>`
    })
    .join('')
  const axis = [
    `<line x1="4" x2="${width - 4}" y1="${bottom}" y2="${bottom}" class="s-grid" stroke-width="1"/>`,
    `<text x="4" y="61" font-size="9" class="f-sub">last ${recent.length} hook runs · tallest ${maxMs} ms (log scale)</text>`,
  ].join('')
  return svg(width, height, recent.length ? bars + axis : `<text x="4" y="30" font-size="11" class="f-sub">No hook runs seen yet</text>`)
}

export const runStrip = (runs: readonly SsaRun[], width = 340): string => {
  const recent = runs.slice(0, 30).reverse()
  const size = 12
  const gap = 4
  const height = 34
  const cells = recent
    .map(
      (run, index) =>
        `<rect x="${index * (size + gap)}" y="2" width="${size}" height="${size}" rx="3" class="f-${runTone(run.state)}"><title>${escapeXml(`${run.id} ${run.state} ${run.worker || run.kind}`)}</title></rect>`,
    )
    .join('')
  const counts = (['done', 'failed', 'expired'] as const).map(state => `${runs.filter(run => run.state === state).length} ${state}`).join(' · ')
  return svg(width, height, `${cells}<text x="0" y="30" font-size="9.5" class="f-sub">oldest → newest · ${counts}</text>`)
}

export const progressBar = (fraction: number, tone: Tone, width = 340): string =>
  svg(
    width,
    8,
    `<rect x="0" y="1" width="${width}" height="6" rx="3" class="f-track"/><rect x="0" y="1" width="${round(Math.max(0, Math.min(1, fraction)) * width)}" height="6" rx="3" class="f-${tone}"/>`,
  )
