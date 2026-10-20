import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_CHECKLIST,
  addManual,
  checklistFromSeed,
  describeChanges,
  mergeTodos,
  parseItemId,
  parseManualLines,
  seedFromTranscript,
  setTicked,
} from '../hooks/checklist'

describe('parseManualLines', () => {
  test('finds MANUAL: lines in plain text, bullets and bold', async () => {
    const text = [
      'Done with the parser.',
      'MANUAL: Rotate the API key in the portal',
      '- MANUAL: Submit the build to TestFlight',
      '2. **MANUAL:** Enable push in the Apple developer portal',
      'manual: lower case is not a marker',
      'Not a MANUAL: line because it does not start the line',
    ].join('\n')

    expect(parseManualLines(text)).toEqual([
      'Rotate the API key in the portal',
      'Submit the build to TestFlight',
      'Enable push in the Apple developer portal',
    ])
  })

  test('drops repeats and empty steps', async () => {
    expect(parseManualLines('MANUAL: same\nMANUAL: same\nMANUAL:   ')).toEqual(['same'])
  })
})

describe('mergeTodos', () => {
  test('gives new todos ids in order and drops todos Claude removed', async () => {
    const first = mergeTodos(EMPTY_CHECKLIST, [
      { content: 'Fix login', status: 'in_progress', activeForm: 'Fixing login' },
      { content: 'Rotate key', status: 'pending', activeForm: 'Rotating key' },
    ]).list
    expect(first.items.map(item => [item.id, item.text, item.status])).toEqual([
      [1, 'Fix login', 'in_progress'],
      [2, 'Rotate key', 'pending'],
    ])

    const second = mergeTodos(first, [{ content: 'Rotate key', status: 'completed', activeForm: 'Rotating key' }]).list
    expect(second.items.map(item => [item.id, item.status])).toEqual([[2, 'completed']])
    expect(second.nextId).toBe(3)
  })

  test('keeps a ticked item done when TodoWrite reopens it, and reports it', async () => {
    const start = mergeTodos(EMPTY_CHECKLIST, [{ content: 'Rotate key', status: 'pending', activeForm: 'x' }]).list
    const ticked = setTicked(start, 1, true).list
    expect(ticked.items[0]?.status).toBe('completed')

    const { list, keptDone } = mergeTodos(ticked, [{ content: 'Rotate key', status: 'pending', activeForm: 'x' }])
    expect(list.items[0]?.status).toBe('completed')
    expect(list.items[0]?.ticked).toBe(true)
    expect(keptDone.map(item => item.id)).toEqual([1])
  })

  test('leaves manual items alone', async () => {
    const withManual = addManual(EMPTY_CHECKLIST, 'Submit build').list
    const { list } = mergeTodos(withManual, [{ content: 'Fix login', status: 'pending', activeForm: 'x' }])
    expect(list.items.map(item => [item.id, item.source])).toEqual([
      [2, 'todo'],
      [1, 'manual'],
    ])
  })
})

describe('addManual and setTicked', () => {
  test('does not add the same step twice', async () => {
    const once = addManual(EMPTY_CHECKLIST, 'Submit build')
    const twice = addManual(once.list, '  Submit build ')
    expect(twice.added).toBe(false)
    expect(twice.list.items.length).toBe(1)
  })

  test('unticking returns an item to pending', async () => {
    const list = addManual(EMPTY_CHECKLIST, 'Submit build').list
    const done = setTicked(list, 1, true).list
    const back = setTicked(done, 1, false)
    expect(back.item?.status).toBe('pending')
    expect(back.item?.ticked).toBe(false)
    expect(setTicked(list, 99, true).item).toBe(undefined)
  })
})

describe('describeChanges and parseItemId', () => {
  test('mentions only what changed', async () => {
    const item = { id: 3, text: 'Rotate key', source: 'todo' as const, status: 'completed' as const, ticked: true }
    const note = describeChanges([{ kind: 'ticked', item }])
    expect(note).toContain('#3 "Rotate key"')
    expect(note).toContain('ticked these done')
    expect(note).toContain('Do not remind')
    expect(note).not.toContain('manual steps')
  })

  test('parses /done arguments', async () => {
    expect(parseItemId('3')).toBe(3)
    expect(parseItemId(' #12 ')).toBe(12)
    expect(parseItemId('three')).toBe(undefined)
  })
})

describe('seedFromTranscript', () => {
  const todoUse = (todos: unknown, agentId?: string) => ({ tool: 'TodoWrite', input: { todos }, ...(agentId === undefined ? {} : { agentId }) })

  test('takes the last main-loop TodoWrite and every MANUAL: line', async () => {
    const seed = seedFromTranscript([
      { role: 'user', text: 'MANUAL: not from Claude, ignored', toolUses: [] },
      { role: 'assistant', text: 'Starting.', toolUses: [todoUse([{ content: 'Old item', status: 'pending' }])] },
      { role: 'assistant', text: 'MANUAL: Rotate the key', toolUses: [todoUse([{ content: 'Fix login', status: 'in_progress' }, { content: 'bad', status: 'nope' }, 42])] },
      { role: 'assistant', text: 'Subagent work', toolUses: [todoUse([{ content: 'Agent item', status: 'pending' }], 'agent-1')] },
      { role: 'assistant', text: '- MANUAL: Rotate the key\n- MANUAL: Submit the build', toolUses: [] },
    ])
    expect(seed.todos).toEqual([{ content: 'Fix login', status: 'in_progress' }])
    expect(seed.manualLines).toEqual(['Rotate the key', 'Submit the build'])

    const list = checklistFromSeed(seed)
    expect(list.items.map(item => [item.id, item.text, item.source, item.status])).toEqual([
      [1, 'Fix login', 'todo', 'in_progress'],
      [2, 'Rotate the key', 'manual', 'pending'],
      [3, 'Submit the build', 'manual', 'pending'],
    ])
  })

  test('an empty or todo-free transcript seeds nothing', async () => {
    expect(seedFromTranscript([])).toEqual({ todos: undefined, manualLines: [] })
    expect(checklistFromSeed(seedFromTranscript([{ role: 'assistant', text: 'hi', toolUses: [] }]))).toEqual(EMPTY_CHECKLIST)
  })
})
