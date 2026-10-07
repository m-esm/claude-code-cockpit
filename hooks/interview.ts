import type { Impact, Interview, Lens, Meter, OpenItem, PlannedQuestion, Slot, SlotState } from '../types'

export const LENSES: readonly Lens[] = ['User', 'Outcome', 'Scope', 'Execution', 'Constraint', 'Risk', 'Alternative', 'Contrarian']
export const MOVES: readonly string[] = ['Clarify', 'Dig', 'Explore', 'Challenge', 'Brainstorm', 'Panel', 'Converge']
export const EVENTS = ['start', 'question', 'stop_check', 'finish'] as const
export const STOP_EVERY = 4
const SLOT_STATES: readonly SlotState[] = ['open', 'partial', 'settled']
const IMPACTS: readonly Impact[] = ['low', 'medium', 'high']
const MAX_TEXT = 2000
const MAX_ITEMS = 32

export type MeterEvent = (typeof EVENTS)[number]

export type MeterInput = {
  event: MeterEvent
  topic: string
  phase: string
  picture: string
  buildNow: string
  assuming: string[]
  clarity: number
  slots: Slot[]
  openItems: OpenItem[]
  lensesCovered: Lens[]
  lensesThin: Lens[]
  shifted: string
  questions: PlannedQuestion[]
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export type AskDecision = {
  block: string | null
  warnings: string[]
  interview: Interview
  fromStop: boolean
}

export const emptyInterview = (): Interview => ({
  id: null,
  topic: '',
  permits: [],
  permitFromStop: false,
  answersSinceStop: 0,
  totalAnswers: 0,
  recentLenses: [],
  handled: [],
  warnings: [],
  blocks: 0,
  stopChecks: 0,
  openStreak: {},
  panelTried: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, field: string, errors: string[], max = MAX_TEXT): string => {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    errors.push(`${field} must be a string`)
    return ''
  }
  return value.length > max ? value.slice(0, max) : value
}

const list = (value: unknown, field: string, errors: string[]): unknown[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`)
    return []
  }
  if (value.length > MAX_ITEMS) errors.push(`${field} has more than ${MAX_ITEMS} entries`)
  return value.slice(0, MAX_ITEMS)
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string, errors: string[]): T | null => {
  const match = allowed.find(option => typeof value === 'string' && option.toLowerCase() === value.toLowerCase())
  if (!match) errors.push(`${field} must be one of ${allowed.join(', ')}`)
  return match ?? null
}

const lensList = (value: unknown, field: string, errors: string[]): Lens[] =>
  list(value, field, errors)
    .map((entry, index) => oneOf(entry, LENSES, `${field}[${index}]`, errors))
    .filter((entry): entry is Lens => entry !== null)

export const parseMeterInput = (input: Record<string, unknown>): Parsed<MeterInput> => {
  const errors: string[] = []
  const event = oneOf(input.event, EVENTS, 'event', errors)
  const clarity = typeof input.clarity === 'number' && Number.isFinite(input.clarity) ? Math.max(0, Math.min(10, input.clarity)) : NaN
  if (Number.isNaN(clarity)) errors.push('clarity must be a number from 0 to 10')

  const slots = list(input.slots, 'slots', errors).flatMap((entry, index): Slot[] => {
    if (!isRecord(entry)) {
      errors.push(`slots[${index}] must be an object`)
      return []
    }
    const state = oneOf(entry.state, SLOT_STATES, `slots[${index}].state`, errors)
    const label = text(entry.label, `slots[${index}].label`, errors, 120)
    const id = text(entry.id, `slots[${index}].id`, errors, 80) || label.toLowerCase()
    return state && label ? [{ id, label, state, summary: text(entry.summary, `slots[${index}].summary`, errors, 400) }] : []
  })

  const openItems = list(input.openItems, 'openItems', errors).flatMap((entry, index): OpenItem[] => {
    if (!isRecord(entry)) {
      errors.push(`openItems[${index}] must be an object`)
      return []
    }
    const id = text(entry.id, `openItems[${index}].id`, errors, 80)
    if (!id) errors.push(`openItems[${index}].id is required`)
    const impact = oneOf(entry.impact, IMPACTS, `openItems[${index}].impact`, errors)
    return id && impact
      ? [{
          id,
          slotId: text(entry.slotId, `openItems[${index}].slotId`, errors, 80),
          question: text(entry.question, `openItems[${index}].question`, errors, 400),
          impact,
          costOfWrong: text(entry.costOfWrong, `openItems[${index}].costOfWrong`, errors, 400),
        }]
      : []
  })

  const questions = list(input.questions, 'questions', errors).flatMap((entry, index): PlannedQuestion[] => {
    if (!isRecord(entry)) {
      errors.push(`questions[${index}] must be an object`)
      return []
    }
    const lens = oneOf(entry.lens, LENSES, `questions[${index}].lens`, errors)
    const move = oneOf(entry.move, MOVES, `questions[${index}].move`, errors)
    const questionText = text(entry.text, `questions[${index}].text`, errors, 1000)
    return lens && move ? [{ text: questionText, lens, move }] : []
  })

  if ((event === 'question' || event === 'stop_check') && questions.length === 0) errors.push(`${event} needs 1 to 4 questions`)
  if (questions.length > 4) errors.push('questions has more than 4 entries')
  if (event === 'finish' && questions.length > 0) errors.push('finish takes no questions')

  if (errors.length > 0 || event === null) return { ok: false, error: errors.join('; ') }
  return {
    ok: true,
    value: {
      event,
      topic: text(input.topic, 'topic', errors, 240),
      phase: text(input.phase, 'phase', errors, 40),
      picture: text(input.picture, 'picture', errors),
      buildNow: text(input.buildNow, 'buildNow', errors),
      assuming: list(input.assuming, 'assuming', errors).filter((entry): entry is string => typeof entry === 'string'),
      clarity,
      slots,
      openItems,
      lensesCovered: lensList(input.lensesCovered, 'lensesCovered', errors),
      lensesThin: lensList(input.lensesThin, 'lensesThin', errors),
      shifted: text(input.shifted, 'shifted', errors),
      questions: questions.slice(0, 4),
    },
  }
}

export const meterFromInput = (previous: Meter | null, input: MeterInput, interview: Interview): Meter => {
  const status = input.event === 'finish' ? 'done' : 'interviewing'
  const isNewInterview = input.event === 'start'
  const priorHistory = isNewInterview || previous?.source !== 'tool' ? [] : previous.history
  const history = input.event === 'question' ? priorHistory : [...priorHistory, input.clarity].slice(-20)
  return {
    answers: interview.totalAnswers,
    phase: input.phase,
    picture: input.picture,
    buildNow: input.buildNow,
    assuming: input.assuming.join(' · '),
    clarity: input.clarity,
    settled: input.slots.filter(slot => slot.state === 'settled').map(slot => slot.label),
    open: input.slots.filter(slot => slot.state !== 'settled').map(slot => (slot.state === 'partial' ? `${slot.label} (partial)` : slot.label)),
    lensesCovered: input.lensesCovered,
    lensesThin: input.lensesThin,
    costOfWrong: input.openItems.filter(item => item.costOfWrong).map(item => `${item.question || item.id} -> ${item.costOfWrong}`),
    shifted: input.shifted,
    status,
    history: history.length > 0 ? history : [input.clarity],
    source: 'tool',
    topic: input.topic || previous?.topic || '',
    slots: input.slots,
    openItems: input.openItems,
  }
}

export const applyMeter = (current: Interview, input: MeterInput, newId: string): Parsed<Interview> => {
  if (input.event === 'start') {
    return {
      ok: true,
      value: { ...emptyInterview(), id: newId, topic: input.topic, permits: input.questions, permitFromStop: false },
    }
  }
  if (current.id === null) return { ok: false, error: 'no interview is open: call the meter with event "start" first' }
  if (input.event === 'finish') return { ok: true, value: { ...current, id: null, permits: [], permitFromStop: false } }
  if (input.event === 'question') return { ok: true, value: { ...current, permits: input.questions, permitFromStop: false } }

  const stillOpen = input.openItems.filter(item => item.impact !== 'low')
  const openStreak: Record<string, number> = {}
  for (const item of stillOpen) openStreak[item.id] = (current.openStreak[item.id] ?? 0) + 1
  return {
    ok: true,
    value: {
      ...current,
      permits: input.questions,
      permitFromStop: true,
      answersSinceStop: 0,
      stopChecks: current.stopChecks + 1,
      openStreak,
    },
  }
}

const lensStreak = (recent: readonly Lens[], incoming: readonly Lens[]): Lens | null => {
  const sequence = [...recent, ...incoming]
  for (let index = Math.max(2, recent.length); index < sequence.length; index += 1) {
    const lens = sequence[index]
    if (lens && sequence[index - 1] === lens && sequence[index - 2] === lens) return lens
  }
  return null
}

export const checkAsk = (current: Interview, meter: Meter | null, questionCount: number): AskDecision => {
  if (current.id === null) return { block: null, warnings: [], interview: current, fromStop: false }

  if (current.permits.length === 0) {
    return {
      block: 'Questioning enforcer: call mcp__claude-code-cockpit__meter (event "question" or "stop_check", with this question\'s lens and move) before AskUserQuestion.',
      warnings: [],
      interview: { ...current, blocks: current.blocks + 1 },
      fromStop: false,
    }
  }

  if (!current.permitFromStop && current.answersSinceStop + questionCount > STOP_EVERY) {
    return {
      block: `Questioning enforcer: ${current.answersSinceStop} answers since the last stop check. Print the stop check, call the meter with event "stop_check", then ask.`,
      warnings: [],
      interview: { ...current, blocks: current.blocks + 1 },
      fromStop: false,
    }
  }

  const incoming = current.permits.map(permit => permit.lens)
  const warnings: string[] = []
  const streak = lensStreak(current.recentLenses, incoming)
  if (streak) warnings.push(`Three questions in a row under the ${streak} lens. Pivot to an unused high-impact lens next.`)
  const highOpen = (meter?.openItems ?? []).some(item => item.impact === 'high')
  if (!current.permitFromStop && meter !== null && meter.clarity >= 8 && !highOpen) {
    warnings.push(`Clarity is ${meter.clarity}/10 with nothing high-impact open. Offer the stop check ("Enough, build it") instead of more questions.`)
  }

  return {
    block: null,
    warnings,
    fromStop: current.permitFromStop,
    interview: {
      ...current,
      permits: [],
      permitFromStop: false,
      recentLenses: [...current.recentLenses, ...incoming].slice(-10),
      warnings: [...current.warnings, ...warnings].slice(-10),
    },
  }
}

export const countAnswered = (answers: unknown, response: unknown, questionCount: number): number => {
  const filled = isRecord(answers)
    ? Object.values(answers).filter(value => (typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined)).length
    : 0
  if (filled > 0) return Math.min(filled, questionCount)
  return typeof response === 'string' && response.trim() !== '' && questionCount === 1 ? 1 : 0
}

export const recordAnswers = (current: Interview, toolUseId: string, answered: number, fromStop: boolean): Interview => {
  if (current.handled.includes(toolUseId) || answered === 0) return current
  return {
    ...current,
    handled: [...current.handled, toolUseId].slice(-50),
    totalAnswers: current.totalAnswers + answered,
    answersSinceStop: fromStop ? current.answersSinceStop : current.answersSinceStop + answered,
  }
}

const isPanelSlot = (item: OpenItem, slots: readonly Slot[]): boolean => {
  const slot = slots.find(entry => entry.id === item.slotId)
  return /approach|risk/i.test(`${item.slotId} ${slot?.label ?? ''}`)
}

export const panelCandidate = (current: Interview, meter: Meter | null): OpenItem | null => {
  if (current.id === null || meter === null) return null
  return (
    (meter.openItems ?? []).find(
      item =>
        item.impact !== 'low' &&
        (current.openStreak[item.id] ?? 0) >= 2 &&
        !current.panelTried.includes(item.id) &&
        isPanelSlot(item, meter.slots ?? []),
    ) ?? null
  )
}

export const panelGoal = (meter: Meter, item: OpenItem, decisionsPath: string): string =>
  [
    `# Panel: ${item.question || item.id}`,
    '',
    `Topic: ${meter.topic ?? ''}`,
    '',
    '## The open question',
    item.question || item.id,
    item.costOfWrong ? `Cost of guessing wrong: ${item.costOfWrong}` : '',
    '',
    '## Current picture',
    meter.picture,
    '',
    `Build now: ${meter.buildNow}`,
    `Assuming: ${meter.assuming}`,
    `Settled: ${meter.settled.join(', ') || 'none'}`,
    `Open: ${meter.open.join(', ') || 'none'}`,
    '',
    '## Decisions so far',
    `Read ${decisionsPath} for every answer recorded in this interview.`,
    '',
    '## Deliverable',
    'Two or three distinct option shapes for the open question, each with its tradeoff and the evidence behind it, then your recommendation.',
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n')

export const METER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['event', 'clarity'],
  properties: {
    event: { type: 'string', enum: [...EVENTS], description: 'start opens an interview; question before each ordinary AskUserQuestion; stop_check with the stop check and its question; finish at wrap-up.' },
    topic: { type: 'string' },
    phase: { type: 'string', enum: ['exploring', 'probing', 'converging', 'wrapping up'] },
    picture: { type: 'string' },
    buildNow: { type: 'string' },
    assuming: { type: 'array', items: { type: 'string' } },
    clarity: { type: 'number', minimum: 0, maximum: 10 },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'state'],
        properties: { id: { type: 'string' }, label: { type: 'string' }, state: { type: 'string', enum: [...SLOT_STATES] }, summary: { type: 'string' } },
      },
    },
    openItems: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'impact'],
        properties: {
          id: { type: 'string' },
          slotId: { type: 'string' },
          question: { type: 'string' },
          impact: { type: 'string', enum: [...IMPACTS] },
          costOfWrong: { type: 'string' },
        },
      },
    },
    lensesCovered: { type: 'array', items: { type: 'string', enum: [...LENSES] } },
    lensesThin: { type: 'array', items: { type: 'string', enum: [...LENSES] } },
    shifted: { type: 'string' },
    questions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        required: ['text', 'lens', 'move'],
        properties: { text: { type: 'string' }, lens: { type: 'string', enum: [...LENSES] }, move: { type: 'string', enum: [...MOVES] } },
      },
    },
  },
}

export const METER_DESCRIPTION = [
  'Report the questioning interview state to the cockpit. Call it from the questioning skill only.',
  'event "start" when an interview opens; "question" right before every ordinary AskUserQuestion, listing that call\'s questions with lens and move;',
  '"stop_check" when you print the stop check, listing the stop-check question; "finish" at wrap-up.',
  'Always send the full current picture: clarity, slots with state, open items with id and impact.',
  'Await the result before calling AskUserQuestion. Once started, AskUserQuestion is blocked without a fresh meter call, and after 4 answers without a stop check.',
].join(' ')
