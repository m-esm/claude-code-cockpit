import { expect, test } from 'claude-code/testing'

import { parseMeter, parseStatus, replay } from '../hooks/meter'

const STOP_CHECK = [
  'Here is where we stand.',
  '',
  '```',
  'Progress · 6 answers · phase: probing',
  'Picture:   A Desktop pane that mirrors the questioning stop check,',
  '           updated each time a question is asked.',
  'Build now: A mod with a pane and a band above the prompt.',
  'Assuming:  The meter text format stays stable.',
  'Clarity:   ██████░░░░ 6/10',
  'Settled:   Goal, Who, Scope',
  'Open:      Approach (parse vs tool), Risks',
  'Lenses:    covered User, Outcome, Risk · thin Execution, Contrarian',
  'Cost of guessing wrong:',
  '           Approach -> skill edits break the parser',
  '           Risks -> stale meter after compaction',
  'Shifted:   none',
  '```',
  '',
  'Questioning: interviewing',
].join('\n')

const LATER = STOP_CHECK.replace('6/10', '8/10').replace('Questioning: interviewing', 'Questioning: done')

test('parses every slot of a stop check', async () => {
  const parsed = parseMeter(STOP_CHECK)
  expect(parsed).toBeDefined()
  expect(parsed?.clarity).toBe(6)
  expect(parsed?.answers).toBe(6)
  expect(parsed?.phase).toBe('probing')
  expect(parsed?.picture).toBe('A Desktop pane that mirrors the questioning stop check, updated each time a question is asked.')
  expect(parsed?.settled).toEqual(['Goal', 'Who', 'Scope'])
  expect(parsed?.open).toEqual(['Approach (parse vs tool)', 'Risks'])
  expect(parsed?.lensesCovered).toEqual(['User', 'Outcome', 'Risk'])
  expect(parsed?.lensesThin).toEqual(['Execution', 'Contrarian'])
  expect(parsed?.costOfWrong).toEqual(['Approach -> skill edits break the parser', 'Risks -> stale meter after compaction'])
  expect(parsed?.shifted).toBe('')
  expect(parseStatus(STOP_CHECK)).toBe('interviewing')
})

test('ignores prose without a clarity line', async () => {
  expect(parseMeter('Open: the settings file. Settled: nothing.')).toBe(null)
})

test('replay keeps clarity history and the latest status', async () => {
  const meter = replay(['hello', STOP_CHECK, 'unrelated', LATER])
  expect(meter?.history).toEqual([6, 8])
  expect(meter?.clarity).toBe(8)
  expect(meter?.status).toBe('done')
})
