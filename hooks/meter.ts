import type { InterviewStatus, Meter } from '../types'

type Field =
  | 'progress'
  | 'picture'
  | 'buildNow'
  | 'assuming'
  | 'clarity'
  | 'settled'
  | 'open'
  | 'lenses'
  | 'costOfWrong'
  | 'shifted'

const LABELS: ReadonlyArray<[RegExp, Field]> = [
  [/^progress\b\s*[·:-]?\s*/i, 'progress'],
  [/^picture:\s*/i, 'picture'],
  [/^build now:\s*/i, 'buildNow'],
  [/^assuming:\s*/i, 'assuming'],
  [/^clarity:\s*/i, 'clarity'],
  [/^settled:\s*/i, 'settled'],
  [/^open:\s*/i, 'open'],
  [/^lenses:\s*/i, 'lenses'],
  [/^cost of guessing wrong:\s*/i, 'costOfWrong'],
  [/^shifted:\s*/i, 'shifted'],
]

const STATUS = /^\s*Questioning:\s*(interviewing|done|skipped)\b/im
const FENCE = /^\s*```/

const stripMarkdown = (line: string): string =>
  line.replace(/^\s*[>*-]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '')

const labelOf = (line: string): [Field, string] | null => {
  const bare = stripMarkdown(line).trim()
  for (const [pattern, field] of LABELS) {
    const match = bare.match(pattern)
    if (match) return [field, bare.slice(match[0].length).trim()]
  }
  return null
}

export const splitTop = (value: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(' || char === '[') depth += 1
    if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts.map(part => part.trim()).filter(part => part && !/^(none|-|n\/a)$/i.test(part))
}

const fieldsOf = (text: string): Map<Field, string[]> => {
  const fields = new Map<Field, string[]>()
  let current: Field | null = null
  for (const line of text.split('\n')) {
    if (FENCE.test(line) || STATUS.test(line)) {
      current = null
      continue
    }
    const labelled = labelOf(line)
    if (labelled) {
      const [field, rest] = labelled
      current = field
      fields.set(field, rest ? [rest] : [])
      continue
    }
    if (!current) continue
    const trimmed = stripMarkdown(line).trim()
    if (!trimmed) {
      current = null
      continue
    }
    if (/^\s/.test(line) || current === 'costOfWrong') fields.get(current)?.push(trimmed)
    else current = null
  }
  return fields
}

const joined = (fields: Map<Field, string[]>, field: Field): string => (fields.get(field) ?? []).join(' ').trim()

const lensesOf = (value: string): { covered: string[]; thin: string[] } => {
  const covered = value.match(/covered\s+(.*?)(?:\s+[·|;]\s+|\s+thin\b|$)/i)?.[1] ?? ''
  const thin = value.match(/thin\s+(.*)$/i)?.[1] ?? ''
  return { covered: splitTop(covered), thin: splitTop(thin) }
}

export const parseStatus = (text: string): InterviewStatus | null => {
  const match = text.match(STATUS)
  return match ? (match[1]!.toLowerCase() as InterviewStatus) : null
}

export type ParsedMeter = Omit<Meter, 'status' | 'history'>

export const parseMeter = (text: string): ParsedMeter | null => {
  const fields = fieldsOf(text)
  const clarityText = joined(fields, 'clarity')
  const clarity = clarityText.match(/(\d+(?:\.\d+)?)\s*\/\s*10/)
  if (!clarity) return null
  const progress = joined(fields, 'progress')
  const lenses = lensesOf(joined(fields, 'lenses'))
  return {
    answers: Number(progress.match(/(\d+)\s+answers?/i)?.[1] ?? NaN) || null,
    phase: progress.match(/phase:\s*([a-z ]+?)\s*$/i)?.[1]?.trim() ?? '',
    picture: joined(fields, 'picture'),
    buildNow: joined(fields, 'buildNow'),
    assuming: joined(fields, 'assuming'),
    clarity: Math.max(0, Math.min(10, Number(clarity[1]))),
    settled: splitTop(joined(fields, 'settled')),
    open: splitTop(joined(fields, 'open')),
    lensesCovered: lenses.covered,
    lensesThin: lenses.thin,
    costOfWrong: (fields.get('costOfWrong') ?? []).filter(Boolean),
    shifted: joined(fields, 'shifted').replace(/^(none|-|n\/a)\.?$/i, ''),
  }
}

export const absorb = (previous: Meter | null, text: string): Meter | null => {
  const parsed = parseMeter(text)
  const status = parseStatus(text)
  if (!parsed && !status) return previous
  if (!parsed) return previous ? { ...previous, status: status ?? previous.status } : null
  const history = [...(previous?.history ?? []), parsed.clarity].slice(-20)
  return { ...parsed, status: status ?? previous?.status ?? 'interviewing', history }
}

export const bar = (clarity: number, width = 10): string => {
  const filled = Math.round((clarity / 10) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const trend = (history: number[]): string => {
  if (history.length < 2) return ''
  const delta = history[history.length - 1]! - history[history.length - 2]!
  if (delta > 0) return `▲${delta}`
  if (delta < 0) return `▼${-delta}`
  return '='
}

export const textOfBlocks = (content: ReadonlyArray<{ type: string; text?: string }>): string =>
  content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')

export const replay = (texts: ReadonlyArray<string>): Meter | null =>
  texts.reduce<Meter | null>((current, text) => absorb(current, text), null)
