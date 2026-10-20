import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_CHECKLIST,
  addManual,
  describeChanges,
  mergeTodos,
  parseItemId,
  parseManualLines,
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
