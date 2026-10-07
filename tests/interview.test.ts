import { expect, test } from 'claude-code/testing'

import type { Interview } from '../types'
import { applyMeter, checkAsk, countAnswered, emptyInterview, meterFromInput, panelCandidate, parseMeterInput, recordAnswers } from '../hooks/interview'

const base = {
  clarity: 5,
  topic: 'cockpit',
  phase: 'probing',
  slots: [
    { id: 'approach', label: 'Approach', state: 'open' },
    { id: 'goal', label: 'Goal', state: 'settled' },
  ],
  openItems: [{ id: 'arch', slotId: 'approach', question: 'Hook vs mod', impact: 'high', costOfWrong: 'wrong home for code' }],
}

const meterCall = (event: string, lenses: string[] = ['Risk']) =>
  parseMeterInput({ ...base, event, questions: lenses.map(lens => ({ text: `q ${lens}`, lens, move: 'Dig' })) })

const must = <T,>(parsed: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

const started = (): Interview => must(applyMeter(emptyInterview(), must(meterCall('start')), '1'))

const ask = (current: Interview, toolUseId: string, answered = 1): Interview => {
  const decision = checkAsk(current, null, 1)
  if (decision.block) throw new Error(decision.block)
  return recordAnswers(decision.interview, toolUseId, answered, decision.fromStop)
}

test('rejects a meter call with bad fields', async () => {
  const parsed = parseMeterInput({ event: 'question', clarity: 'high', questions: [] })
  expect(parsed.ok).toBe(false)
})

test('nothing blocks before an interview starts', async () => {
  expect(checkAsk(emptyInterview(), null, 1).block).toBe(null)
})

test('blocks a question without a fresh meter call', async () => {
  let current = started()
  current = ask(current, 't1')
  const decision = checkAsk(current, null, 1)
  expect(decision.block?.includes('call mcp__claude-code-cockpit__meter')).toBe(true)
  expect(decision.interview.blocks).toBe(1)
})

test('blocks the fifth answer until a stop check, then allows it', async () => {
  let current = started()
  current = ask(current, 't1')
  for (const id of ['t2', 't3', 't4']) {
    current = must(applyMeter(current, must(meterCall('question', ['Scope'])), 'x'))
    current = ask(current, id)
  }
  expect(current.answersSinceStop).toBe(4)
  current = must(applyMeter(current, must(meterCall('question', ['User'])), 'x'))
  expect(checkAsk(current, null, 1).block?.includes('4 answers since the last stop check')).toBe(true)
  current = must(applyMeter(current, must(meterCall('stop_check', ['Outcome'])), 'x'))
  expect(current.answersSinceStop).toBe(0)
  expect(checkAsk(current, null, 1).block).toBe(null)
})

test('warns on three questions in one lens', async () => {
  let current = must(applyMeter(emptyInterview(), must(meterCall('start', ['Risk'])), '1'))
  current = ask(current, 't1')
  current = must(applyMeter(current, must(meterCall('question', ['Risk'])), 'x'))
  current = ask(current, 't2')
  current = must(applyMeter(current, must(meterCall('question', ['Risk'])), 'x'))
  const decision = checkAsk(current, null, 1)
  expect(decision.block).toBe(null)
  expect(decision.warnings.some(warning => warning.includes('Risk lens'))).toBe(true)
})

test('counts answers once per tool call and handles free text', async () => {
  expect(countAnswered({ 'Which?': 'A', 'Other?': '' }, undefined, 2)).toBe(1)
  expect(countAnswered({}, 'my own words', 1)).toBe(0 + 1)
  expect(countAnswered({}, 'ambiguous', 2)).toBe(0)
  const once = recordAnswers(started(), 'same', 1, false)
  expect(recordAnswers(once, 'same', 1, false).totalAnswers).toBe(1)
})

test('offers an auto panel after an approach item stays open across two stop checks', async () => {
  let current = started()
  const stop = must(meterCall('stop_check', ['Outcome']))
  current = must(applyMeter(current, stop, 'x'))
  const meter = meterFromInput(null, stop, current)
  expect(panelCandidate(current, meter)).toBe(null)
  current = must(applyMeter(current, stop, 'x'))
  expect(panelCandidate(current, meter)?.id).toBe('arch')
  expect(panelCandidate({ ...current, panelTried: ['arch'] }, meter)).toBe(null)
})
