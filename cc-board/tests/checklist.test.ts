import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_CHECKLIST,
  addManual,
  applyTaskEvent,
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

describe('applyTaskEvent', () => {
  test('TaskCreate adds a task once, TaskUpdate changes it, deleted removes it', async () => {
    const created = applyTaskEvent(EMPTY_CHECKLIST, { kind: 'created', taskId: 't1', subject: 'Fix login' })
    expect(created.item?.id).toBe(1)
    expect(created.item?.taskId).toBe('t1')
    const again = applyTaskEvent(created.list, { kind: 'created', taskId: 't1', subject: 'Fix login' })
    expect(again.list.items.length).toBe(1)

    const started = applyTaskEvent(again.list, { kind: 'updated', taskId: 't1', status: 'in_progress', subject: 'Fix the login crash' })
    expect(started.item).toEqual({ id: 1, text: 'Fix the login crash', source: 'todo', status: 'in_progress', ticked: false, taskId: 't1' })
    expect(applyTaskEvent(started.list, { kind: 'updated', taskId: 'unknown', status: 'completed' }).list).toEqual(started.list)
    expect(applyTaskEvent(started.list, { kind: 'updated', taskId: 't1', status: 'deleted' }).list.items).toEqual([])
  })

  test('a ticked task stays done when TaskUpdate reopens it, and is reported', async () => {
    const created = applyTaskEvent(EMPTY_CHECKLIST, { kind: 'created', taskId: 't1', subject: 'Rotate key' }).list
    const ticked = setTicked(created, 1, true).list
    const reopened = applyTaskEvent(ticked, { kind: 'updated', taskId: 't1', status: 'pending' })
    expect(reopened.list.items[0]?.status).toBe('completed')
    expect(reopened.keptDone?.id).toBe(1)
  })

  test('a TaskCreate for a todo of the same text attaches the id instead of duplicating', async () => {
    const fromTodo = mergeTodos(EMPTY_CHECKLIST, [{ content: 'Fix login', status: 'pending', activeForm: 'x' }]).list
    const { list } = applyTaskEvent(fromTodo, { kind: 'created', taskId: 't9', subject: 'Fix login' })
    expect(list.items).toEqual([{ id: 1, text: 'Fix login', source: 'todo', status: 'pending', ticked: false, taskId: 't9' }])
  })
})

describe('seedFromTranscript', () => {
  const todoUse = (todos: unknown, agentId?: string) => ({ tool: 'TodoWrite', input: { todos }, ...(agentId === undefined ? {} : { agentId }) })

  test('replays TodoWrite, the Task tools and MANUAL: lines from the main loop only', async () => {
    const list = seedFromTranscript([
      { role: 'user', text: 'MANUAL: not from Claude, ignored', toolUses: [] },
      { role: 'assistant', text: 'Starting.', toolUses: [todoUse([{ content: 'Old item', status: 'pending' }])] },
      { role: 'assistant', text: 'MANUAL: Rotate the key', toolUses: [todoUse([{ content: 'Fix login', status: 'in_progress' }, { content: 'bad', status: 'nope' }, 42])] },
      { role: 'assistant', text: 'Subagent work', toolUses: [todoUse([{ content: 'Agent item', status: 'pending' }], 'agent-1')] },
      {
        role: 'assistant',
        text: 'Planned.',
        toolUses: [
          { tool: 'TaskCreate', input: { subject: 'Add tests', description: 'd' }, result: { task: { id: 't1', subject: 'Add tests' } } },
          { tool: 'TaskCreate', input: { subject: 'Agent task', description: 'd' }, result: { task: { id: 't2', subject: 'Agent task' } }, agentId: 'agent-1' },
          { tool: 'TaskUpdate', input: { taskId: 't1', status: 'in_progress' }, result: { success: true, taskId: 't1', updatedFields: ['status'] } },
        ],
      },
      { role: 'assistant', text: '- MANUAL: Rotate the key\n- MANUAL: Submit the build', toolUses: [] },
    ])
    expect(list.items.map(item => [item.id, item.text, item.source, item.status, item.taskId])).toEqual([
      [2, 'Fix login', 'todo', 'in_progress', undefined],
      [3, 'Add tests', 'todo', 'in_progress', 't1'],
      [4, 'Rotate the key', 'manual', 'pending', undefined],
      [5, 'Submit the build', 'manual', 'pending', undefined],
    ])
  })

  test('an empty or task-free transcript seeds nothing', async () => {
    expect(seedFromTranscript([])).toEqual(EMPTY_CHECKLIST)
    expect(seedFromTranscript([{ role: 'assistant', text: 'hi', toolUses: [] }])).toEqual(EMPTY_CHECKLIST)
  })
})
