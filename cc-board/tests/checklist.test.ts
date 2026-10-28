import { describe, expect, test } from 'claude-code/testing'
import type { Checklist } from '../types'

import {
  addFollowUp,
  addManual,
  applyTaskEvent,
  candidatesHandled,
  cueExcerpts,
  describeChanges,
  EMPTY_CHECKLIST,
  hasLooseEndCue,
  isSimilar,
  keywords,
  markHandled,
  mergeTodos,
  parseFollowUpLines,
  parseHandledIds,
  parseItemId,
  parseReviewLines,
  parseManualLines,
  reconcile,
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

  test('a TaskCreate that reads like an open loose end adopts it, so the task finishing finishes the item', async () => {
    const start = addFollowUp(EMPTY_CHECKLIST, 'Renew the push certificate in the portal').list
    const created = applyTaskEvent(start, { kind: 'created', taskId: 't-9', subject: 'Renew push certificate' })
    expect(created.list.items.length).toBe(1)
    expect(created.item?.taskId).toBe('t-9')
    expect(created.item?.source).toBe('followup')
    const finished = applyTaskEvent(created.list, { kind: 'updated', taskId: 't-9', status: 'completed' })
    expect(finished.list.items[0]?.status).toBe('completed')
    // A completed loose end is not adopted again, and an unrelated task is its own item.
    const other = applyTaskEvent(finished.list, { kind: 'created', taskId: 't-10', subject: 'Renew the push certificate' })
    expect(other.list.items.length).toBe(2)
    const unrelated = applyTaskEvent(start, { kind: 'created', taskId: 't-11', subject: 'Fix the login crash' })
    expect(unrelated.list.items.length).toBe(2)
    // Deleting an adopted task leaves the obligation, without the link; deleting a plain task removes it.
    const dropped = applyTaskEvent(created.list, { kind: 'updated', taskId: 't-9', status: 'deleted' })
    expect(dropped.list.items).toEqual([{ id: 1, text: 'Renew the push certificate in the portal', source: 'followup', status: 'pending', ticked: false }])
    const plain = applyTaskEvent(EMPTY_CHECKLIST, { kind: 'created', taskId: 't-12', subject: 'Fix login' }).list
    expect(applyTaskEvent(plain, { kind: 'updated', taskId: 't-12', status: 'deleted' }).list.items).toEqual([])
  })

  test('replay adopts a MANUAL: step by the task that followed it, and reconcile carries that over the saved file', async () => {
    const replayed = seedFromTranscript([
      { role: 'assistant', text: 'MANUAL: Renew the push certificate in the portal', toolUses: [] },
      { role: 'assistant', text: 'On it.', toolUses: [{ tool: 'TaskCreate', input: { subject: 'Renew push certificate' }, result: { task: { id: 't-9' } } }] },
      { role: 'assistant', text: 'Done.', toolUses: [{ tool: 'TaskUpdate', input: { taskId: 't-9', status: 'completed' }, result: { success: true } }] },
    ])
    expect(replayed.items).toEqual([{ id: 1, text: 'Renew the push certificate in the portal', source: 'manual', status: 'pending', ticked: false, taskId: 't-9', }].map(item => ({ ...item, status: 'completed' })))

    // A file written before the adoption still holds the step open: the replay finishes it instead of adding a twin.
    const saved: Checklist = { items: [{ id: 1, text: 'Renew the push certificate in the portal', source: 'manual', status: 'pending', ticked: false }], nextId: 2 }
    const merged = reconcile(saved, replayed)
    expect(merged.items).toEqual([{ id: 1, text: 'Renew the push certificate in the portal', source: 'manual', status: 'completed', ticked: false, taskId: 't-9' }])

    // Once the file carries the link, a renamed adopted item matches by task id, so no twin appears.
    const linked: Checklist = { items: [{ ...saved.items[0]!, taskId: 't-9' }], nextId: 2 }
    const renamed = { ...replayed, items: [{ ...replayed.items[0]!, text: 'Renew the APNs certificate' }] }
    expect(reconcile(linked, renamed).items.map(item => [item.id, item.status])).toEqual([[1, 'completed']])
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
          { tool: 'TaskUpdate', input: { taskId: 't1', status: 'completed' }, result: { success: false, taskId: 't1', updatedFields: [], error: 'blocked' } },
        ],
      },
      { role: 'assistant', text: '- MANUAL: Rotate the key\n- MANUAL: Submit the build', toolUses: [] },
    ])
    expect(list.items.map(item => [item.id, item.text, item.source, item.status, item.taskId])).toEqual([
      [2, 'Fix login', 'todo', 'in_progress', undefined],
      [3, 'Rotate the key', 'manual', 'pending', undefined],
      [4, 'Add tests', 'todo', 'in_progress', 't1'],
      [5, 'Submit the build', 'manual', 'pending', undefined],
    ])
  })

  test('reconcile adds what the transcript knows without losing ticks or manual steps', async () => {
    const saved = addManual(EMPTY_CHECKLIST, 'Submit build').list
    const ticked = setTicked(saved, 1, true).list
    const replayed = seedFromTranscript([
      {
        role: 'assistant',
        text: 'MANUAL: Submit build',
        toolUses: [
          { tool: 'TaskCreate', input: { subject: 'Fix login', description: 'd' }, result: { task: { id: 't1', subject: 'Fix login' } } },
          { tool: 'TaskUpdate', input: { taskId: 't1', status: 'in_progress' }, result: { success: true, taskId: 't1', updatedFields: ['status'] } },
        ],
      },
    ])
    const list = reconcile(ticked, replayed)
    expect(list.items.map(item => [item.id, item.text, item.status, item.ticked, item.taskId])).toEqual([
      [1, 'Submit build', 'completed', true, undefined],
      [2, 'Fix login', 'in_progress', false, 't1'],
    ])
    expect(reconcile(list, replayed)).toEqual(list)
  })

  test('an empty or task-free transcript seeds nothing', async () => {
    expect(seedFromTranscript([])).toEqual(EMPTY_CHECKLIST)
    expect(seedFromTranscript([{ role: 'assistant', text: 'hi', toolUses: [] }])).toEqual(EMPTY_CHECKLIST)
  })
})

describe('handled items', () => {
  const items = [
    { id: 1, text: 'Rotate the API key in the portal', source: 'followup' as const, status: 'pending' as const, ticked: false },
    { id: 2, text: 'Bump the version before release', source: 'manual' as const, status: 'pending' as const, ticked: false },
    { id: 3, text: 'Fix the login crash', source: 'todo' as const, status: 'pending' as const, ticked: false },
    { id: 4, text: 'Rotate the signing key', source: 'followup' as const, status: 'completed' as const, ticked: true },
  ]

  test('keywords and isSimilar ignore short and stop words', async () => {
    expect(keywords('Renew the push certificate, then make sure it is done')).toEqual(['renew', 'push', 'certificat'])
    // Stems, so a finished tense still matches the item it finished, and a PR number counts as a word.
    expect(keywords('Merged PR #2309 and rotated the keys')).toEqual(['merg', '2309', 'rotat', 'key'])
    expect(isSimilar('Merge PR #2309 to production', 'Merged #2309 into production')).toBe(true)
    expect(isSimilar('Renew the push certificate in the portal', 'Renew push certificate')).toBe(true)
    expect(isSimilar('Renew the push certificate', 'Fix the login crash')).toBe(false)
    expect(isSimilar('Bump the version', 'Bump the build number before release')).toBe(false)
    expect(isSimilar('Renew production signing certificate', 'Renew staging signing certificate')).toBe(false)
  })

  test('candidatesHandled keeps only open manual steps and loose ends the text touches on', async () => {
    const text = 'User: did you rotate it?\n\nClaude: I rotated the API key in the portal and updated the config.'
    expect(candidatesHandled(items, text).map(item => item.id)).toEqual([1])
    expect(candidatesHandled(items, 'Fixed the login crash.')).toEqual([])
  })

  test('parseHandledIds reads numbers in any common shape and ignores the rest', async () => {
    const candidates = items.slice(0, 2)
    expect(parseHandledIds('#1\n2', candidates)).toEqual([1, 2])
    expect(parseHandledIds('- 2\n- 2\n#3', candidates)).toEqual([2])
    expect(parseHandledIds('NONE', candidates)).toEqual([])
    expect(parseHandledIds('Item 1 is done', candidates)).toEqual([])
  })

  test('markHandled completes the named open items without claiming a tick', async () => {
    const result = markHandled({ items, nextId: 5 }, [1, 4])
    expect(result.items.map(item => item.id)).toEqual([1])
    expect(result.list.items[0]).toEqual({ ...items[0], status: 'completed' })
    const note = describeChanges([{ kind: 'auto-done', item: result.items[0]! }])
    expect(note).toContain('shows them handled')
    expect(note).toContain('#1 "Rotate the API key in the portal"')
    expect(note).toContain('Do not remind')
    const dropped = describeChanges([{ kind: 'dropped', item: result.items[0]! }])
    expect(dropped).toContain('Dropped as no longer relevant')
    expect(dropped).toContain('Do not remind')
  })

  test('parseReviewLines reads one verdict per item and ignores the rest', async () => {
    const candidates = items.slice(0, 2)
    expect(parseReviewLines('#1 done\n#2: obsolete\n#3 done', candidates)).toEqual({ done: [1], dropped: [2] })
    expect(parseReviewLines('- 1 open\n2 done\n2 obsolete', candidates)).toEqual({ done: [2], dropped: [] })
    expect(parseReviewLines('All of them look done.', candidates)).toEqual({ done: [], dropped: [] })
  })
})

describe('loose ends', () => {
  test('the cue detector fires on things said in passing and not on plain work', async () => {
    expect(hasLooseEndCue("You'll need to rotate the key in the portal later.")).toBe(true)
    expect(hasLooseEndCue('I skipped the store listing for now.')).toBe(true)
    expect(hasLooseEndCue('oh and remind me to bump the version')).toBe(true)
    expect(hasLooseEndCue('Make sure the signing cert is renewed before you ship.')).toBe(true)
    expect(hasLooseEndCue('Fixed the null reference in LoginPage and added a test.')).toBe(false)
  })

  test('cueExcerpts keeps every cue of a long exchange, with context', async () => {
    const filler = 'The parser now handles nested groups correctly. '.repeat(200)
    const text = `${filler}You'll need to rotate the key later.\n${filler}Also remember to bump the version.`
    expect(text.length > 6000).toBe(true)
    const excerpt = cueExcerpts(text)
    expect(excerpt.length <= 6000).toBe(true)
    expect(excerpt).toContain('rotate the key later')
    expect(excerpt).toContain('bump the version')
    expect(cueExcerpts('short text, later')).toBe('short text, later')
  })

  test('parseFollowUpLines strips bullets, drops NONE and repeats, and caps the list', async () => {
    expect(parseFollowUpLines('NONE')).toEqual([])
    expect(parseFollowUpLines('- Rotate the API key in the portal\n2. Bump the version\n• rotate the api key in the portal!\n\nSubmit the build')).toEqual([
      'Rotate the API key in the portal',
      'Bump the version',
    ])
    expect(parseFollowUpLines('a\nb\nc\nd\ne\nf\ng').length).toBe(2)
    // Prose, a heading and anything too long to read at a glance are not items.
    expect(parseFollowUpLines('Here is what remains from the exchange, excluding what is done:\nThe rest looks fine\nRemaining steps:\nMerge PR #2309 to apply the 22 production migrations once the preview run has been checked by hand\nMerge PR #2309')).toEqual(['Merge PR #2309'])
  })

  test('addFollowUp drops a near twin of an item already listed', async () => {
    const first = addFollowUp(EMPTY_CHECKLIST, 'Add a postal address to the two upgrade emails')
    const twin = addFollowUp(first.list, 'Add a postal address to both upgrade emails')
    expect(twin.added).toBe(false)
    expect(twin.list.items.length).toBe(1)
    const other = addFollowUp(first.list, 'Add a postal address to the Halloween broadcast')
    expect(other.added).toBe(true)
  })

  test('addFollowUp dedupes against any item by normalized text', async () => {
    const list = addManual(EMPTY_CHECKLIST, 'Rotate the API key').list
    const again = addFollowUp(list, 'rotate the API key.')
    expect(again.added).toBe(false)
    const fresh = addFollowUp(list, 'Bump the version')
    expect(fresh.item.source).toBe('followup')
    expect(fresh.list.items.length).toBe(2)
  })

  test('describeChanges tells Claude loose ends are noted, not assigned', async () => {
    const item = { id: 4, text: 'Bump the version', source: 'followup' as const, status: 'pending' as const, ticked: false }
    const note = describeChanges([{ kind: 'followup-added', item }])
    expect(note).toContain('Loose ends noted')
    expect(note).toContain('#4 "Bump the version"')
    expect(note).toContain('no action from you')
  })
})
