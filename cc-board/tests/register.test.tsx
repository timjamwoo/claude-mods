// Drives the hooks module through the engine's own test kit. Nothing sits
// beneath the plugin, so the hooks registered here stand for the engine: an
// in-memory file system, a fixed session id, and so on.
import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

import { parse } from '../hooks/board'

const HOME = '/home/tester'
const BOARD_DIR = `${HOME}/.claude/board`

const PANE = {
  plugin: 'cc-board',
  component: 'Pane',
  requestId: 'cc-board',
  props: {
    title: 'cc-board',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'cc-board',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

/** A fake file system that answers $.fs and the mv/rm the mod runs. */
function fakeWorld(on: On, transcript: SessionMessage[] = []) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let tick = 0
  let taskCount = 0

  on('fs.write', (_, e) => {
    files.set(e.path, { text: e.text, mtimeMs: ++tick })
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const file = files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: file.text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.list', (_, e) => {
    const prefix = `${e.path}/`
    const value = [...files.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, file]) => ({ name: path.slice(prefix.length), kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false }))
    return { value }
  })
  on('process.run', (_, e) => {
    const [command, ...args] = e.argv
    if (command === 'mv') {
      const [, from, to] = args
      const file = files.get(from ?? '')
      if (file !== undefined && to !== undefined) {
        files.set(to, { ...file, mtimeMs: ++tick })
        files.delete(from ?? '')
      }
    }
    if (command === 'rm') for (const path of args.slice(1)) files.delete(path)
    const stdout = command === 'hostname' ? 'mbp\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))

  on('session.id', () => ({ value: 'sess-A' }))
  on('session.messages', () => ({ value: transcript }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    // $.ui.ask reaches the test as an AskUserQuestion call: answer "Remove" to every question.
    if (e.tool === 'TaskCreate') return { result: { task: { id: `task-${++taskCount}`, subject: e.subject } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: e.taskId, updatedFields: ['status'] } }
    if (e.tool === 'AskUserQuestion') {
      const answers: Record<string, string> = {}
      for (const question of e.questions) answers[question.question] = 'Remove'
      return { result: { questions: e.questions, answers } }
    }
    return { result: {} }
  })
  mock.env(on, { HOME })

  const clock = mock.clock(on, { now: Date.parse('2026-10-20T12:00:00Z') })
  const session = mock.session(on)

  const boardFile = (id: string) => {
    const file = files.get(`${BOARD_DIR}/${id}.json`)
    return file === undefined ? undefined : parse(file.text)
  }
  const put = (path: string, text: string) => files.set(path, { text, mtimeMs: ++tick })

  /** The text of the newest note the mod appended for Claude, or '' when there is none. */
  const lastNote = () => {
    const row = session.appended().filter(one => one.door === 'note').at(-1)
    const block = row?.message.content[0]
    return block !== undefined && 'text' in block && typeof block.text === 'string' ? block.text : ''
  }
  const noteCount = () => session.appended().filter(one => one.door === 'note').length

  return { files, clock, session, boardFile, put, lastNote, noteCount, toasts }
}

const TODOS = [
  { content: 'Fix login', status: 'in_progress', activeForm: 'Fixing login' },
  { content: 'Rotate key', status: 'pending', activeForm: 'Rotating key' },
] as const

test('TodoWrite writes this session’s board file atomically', async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })

  const written = world.boardFile('sess-A')
  expect(written?.project).toBe('my-app')
  expect(written?.cwd).toBe('/work/my-app')
  expect(written?.summary).toBe('Fix login')
  expect(written?.items.map(item => [item.id, item.text, item.status])).toEqual([
    [1, 'Fix login', 'in_progress'],
    [2, 'Rotate key', 'pending'],
  ])
  // Only the final file is left: the temp file was renamed away.
  expect([...world.files.keys()].filter(path => path.endsWith('.tmp'))).toEqual([])
})

test('a ticked item stays done when TodoWrite reopens it, and Claude is told', async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const row = await ui.find({ key: 'item-2' })
    expect(row?.props.label).toBe('[ ] #2 Rotate key')
    await ui.unmount()
  }

  // Tick item 2 in the pane.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'item-2' })
  expect((await ui.find({ key: 'item-2' }))?.props.label).toBe('[x] #2 Rotate key')
  await ui.unmount()
  expect(world.boardFile('sess-A')?.items[1]).toEqual({ id: 2, text: 'Rotate key', source: 'todo', status: 'completed', ticked: true })

  // The note for Claude goes out once the short pause has passed.
  await world.clock.advance(300)
  expect(world.noteCount()).toBe(1)
  expect(world.lastNote()).toContain('ticked these done')
  expect(world.lastNote()).toContain('#2 "Rotate key"')

  // Claude's next TodoWrite says it is pending again: it stays done, and Claude hears why.
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Fix login', status: 'completed', activeForm: 'Fixing login' },
      { content: 'Rotate key', status: 'pending', activeForm: 'Rotating key' },
    ],
  })
  const after = world.boardFile('sess-A')
  expect(after?.items.map(item => [item.id, item.status, item.ticked])).toEqual([
    [1, 'completed', false],
    [2, 'completed', true],
  ])
  await world.clock.advance(300)
  expect(world.noteCount()).toBe(2)
  expect(world.lastNote()).toContain('stay done')
  expect(world.lastNote()).toContain('#2 "Rotate key"')
})

test('a MANUAL: line in Claude’s reply and /manual both add manual steps', async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: [{ type: 'text', text: 'Parser fixed.\nMANUAL: Submit the build in App Store Connect' }],
    },
    door: 'response',
    origin: { kind: 'model', model: 'test' },
    uuid: 'row-1',
  })
  await $.command.run({ command: 'manual', args: 'Rotate the key in the portal', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

  const items = world.boardFile('sess-A')?.items ?? []
  expect(items.map(item => [item.id, item.text, item.source])).toEqual([
    [1, 'Submit the build in App Store Connect', 'manual'],
    [2, 'Rotate the key in the portal', 'manual'],
  ])

  await world.clock.advance(300)
  // Both additions landed within the pause, so Claude gets one note, not two.
  expect(world.noteCount()).toBe(1)
  expect(world.lastNote()).toContain('manual steps')
  expect(world.lastNote()).toContain('#1 "Submit the build in App Store Connect"')
  expect(world.lastNote()).toContain('#2 "Rotate the key in the portal"')
})

test('the band lists every live session, marks this one and dims stale ones', async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  const other = {
    sessionId: 'sess-B',
    project: 'other-repo',
    cwd: '/work/other-repo',
    summary: 'Adding the settings page',
    items: [{ id: 1, text: 'Add settings page', source: 'todo', status: 'pending', ticked: false }],
    updatedAt: '2026-10-20T11:55:00Z',
  }
  world.put(`${BOARD_DIR}/sess-B.json`, JSON.stringify(other))
  world.put(`${BOARD_DIR}/sess-C.json`, JSON.stringify({ ...other, sessionId: 'sess-C', project: 'old-repo', updatedAt: '2026-10-10T11:55:00Z' }))
  world.put(`${BOARD_DIR}/broken.json`, '{ this is not json')

  // The next poll picks the files up.
  await world.clock.advance(2000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const mine = await ui.find({ type: 'Text', text: /my-app/ })
    expect(mine?.text).toBe('▶ my-app · — · 0 open')
    expect(mine?.props.bold).toBe(true)
    const theirs = await ui.find({ type: 'Text', text: /other-repo/ })
    expect(theirs?.text).toBe('  other-repo · Adding the settings page · 1 open')
    const stale = await ui.find({ type: 'Text', text: /old-repo/ })
    expect(stale?.props.dimColor).toBe(true)
    expect(stale?.text).toContain('stale')
    await ui.unmount()
  }
})

test('a restarted or resumed session takes its checklist back from its own board file', async ($, on) => {
  const world = fakeWorld(on)
  world.put(
    `${BOARD_DIR}/sess-A.json`,
    JSON.stringify({
      sessionId: 'sess-A',
      project: 'my-app',
      cwd: '/work/my-app',
      summary: 'Fixing login',
      items: [
        { id: 1, text: 'Fix login', source: 'todo', status: 'in_progress', ticked: false },
        { id: 4, text: 'Rotate key', source: 'manual', status: 'completed', ticked: true },
      ],
      updatedAt: '2026-10-20T11:00:00Z',
      endedAt: '2026-10-20T11:30:00Z',
    }),
  )
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'item-4' }))?.props.label).toBe('[x] #4 Rotate key (manual)')
  await ui.unmount()

  // The file is live again, and a new manual step gets the next free id.
  const file = world.boardFile('sess-A')
  expect(file?.endedAt).toBe(undefined)
  expect(file?.summary).toBe('Fixing login')
  await $.command.run({ command: 'manual', args: 'Submit build', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(world.boardFile('sess-A')?.items.map(item => item.id)).toEqual([1, 4, 5])
})

test('a session that predates the mod is seeded from its transcript, without a note to Claude', async ($, on) => {
  const world = fakeWorld(on, [
    { role: 'user', text: 'Fix the login crash', toolUses: [] },
    {
      role: 'assistant',
      text: 'On it.\nMANUAL: Rotate the API key in the portal',
      toolUses: [{ tool_use_id: 't1', tool: 'TodoWrite', input: { todos: [{ content: 'Fix login', status: 'in_progress', activeForm: 'Fixing login' }] } }],
    },
  ])
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  const file = world.boardFile('sess-A')
  expect(file?.items.map(item => [item.id, item.text, item.source])).toEqual([
    [1, 'Fix login', 'todo'],
    [2, 'Rotate the API key in the portal', 'manual'],
  ])
  expect(file?.summary).toBe('Fix login')
  await world.clock.advance(300)
  expect(world.noteCount()).toBe(0)
})

test('a saved file is topped up with tasks the transcript knows, keeping its ticks', async ($, on) => {
  const world = fakeWorld(on, [
    {
      role: 'assistant',
      text: 'Planned.',
      toolUses: [{ tool_use_id: 'x', tool: 'TaskCreate', input: { subject: 'Fix login', description: 'd' }, result: { task: { id: 't1', subject: 'Fix login' } } }],
    },
  ])
  world.put(
    `${BOARD_DIR}/sess-A.json`,
    JSON.stringify({ sessionId: 'sess-A', project: 'my-app', cwd: '/work/my-app', summary: 'Fixing login', items: [{ id: 1, text: 'Rotate key', source: 'manual', status: 'completed', ticked: true }], updatedAt: '2026-10-20T11:00:00Z' }),
  )
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  expect(world.boardFile('sess-A')?.items.map(item => [item.id, item.text, item.status, item.ticked, item.taskId])).toEqual([
    [1, 'Rotate key', 'completed', true, undefined],
    [2, 'Fix login', 'pending', false, 't1'],
  ])
  expect(world.boardFile('sess-A')?.summary).toBe('Fixing login')
})

test('a board file with no items still restores its saved summary', async ($, on) => {
  const world = fakeWorld(on, [{ role: 'user', text: 'Rotate the signing key', toolUses: [] }])
  world.put(
    `${BOARD_DIR}/sess-A.json`,
    JSON.stringify({ sessionId: 'sess-A', project: 'my-app', cwd: '/work/my-app', summary: 'Rotating the signing key', items: [], updatedAt: '2026-10-20T11:00:00Z' }),
  )
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  expect(world.boardFile('sess-A')?.summary).toBe('Rotating the signing key')
  expect(world.boardFile('sess-A')?.items).toEqual([])
})

/** A fake cc_board table behind the Supabase REST API: records every request and serves its rows. */
function fakeTable(on: On, rows: Record<string, unknown>) {
  const calls: { method: string; url: string; status: number; headers: Record<string, string>; body?: string }[] = []
  const table = new Map(Object.entries(rows))
  on('http.fetch', (_, e) => {
    const method = e.init?.method ?? 'GET'
    const headers = e.init?.headers ?? {}
    const call = { method, url: e.url, status: 200, headers, body: e.init?.body }
    calls.push(call)
    if (headers.apikey !== 'secret') {
      call.status = 401
      return { value: { status: 401, ok: false, headers: {}, text: '{"message":"Invalid API key"}' } }
    }
    if (method === 'GET') {
      // Newest first, capped as PostgREST caps a read.
      const limit = Number(/limit=(\d+)/.exec(e.url)?.[1] ?? 1000)
      const rows = [...table.values()] as { updatedAt: string }[]
      rows.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      const text = JSON.stringify(rows.slice(0, limit).map(payload => ({ payload })))
      return { value: { status: 200, ok: true, headers: {}, text } }
    }
    if (method === 'POST') {
      for (const row of JSON.parse(e.init?.body ?? '[]') as { session_id: string; payload: unknown }[]) table.set(row.session_id, row.payload)
      call.status = 201
      return { value: { status: 201, ok: true, headers: {}, text: '' } }
    }
    if (method === 'DELETE') {
      const url = decodeURIComponent(e.url)
      const byId = /session_id=in\.\((.*)\)$/.exec(url)
      for (const id of (byId?.[1] ?? '').split(',').map(one => one.replace(/"/g, '')).filter(one => one !== '')) table.delete(id)
      const before = /updated_at=lt\.(.*)$/.exec(url)?.[1]
      if (before !== undefined) {
        for (const [id, payload] of [...table.entries()] as [string, { updatedAt: string }][]) {
          if (Date.parse(payload.updatedAt) < Date.parse(before)) table.delete(id)
        }
      }
      call.status = 204
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    call.status = 405
    return { value: { status: 405, ok: false, headers: {}, text: '' } }
  })
  return { calls, table }
}

const OPTIONS = { options: { boardUrl: 'https://proj.supabase.co', boardKey: 'secret' } }

test('with a shared board configured, this session’s row is upserted after a short pause', { ...OPTIONS }, async ($, on) => {
  const world = fakeWorld(on)
  const remote = fakeTable(on, {})
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
  await world.clock.advance(2000)

  const writes = remote.calls.filter(call => call.method === 'POST')
  expect(writes.length).toBe(1)
  expect(writes[0]?.url).toBe('https://proj.supabase.co/rest/v1/cc_board')
  expect(writes[0]?.headers.prefer).toContain('merge-duplicates')
  const mirrored = parse(JSON.stringify(remote.table.get('sess-A')))
  expect(mirrored?.items.map(item => item.text)).toEqual(['Fix login', 'Rotate key'])
  expect(mirrored?.machine).toBe('mbp')
  expect(JSON.stringify(remote.table.get('sess-A'))).toBe(JSON.stringify(JSON.parse(world.files.get(`${BOARD_DIR}/sess-A.json`)?.text ?? '')))
})

test('sessions from the shared board join the band, and prune deletes from both stores', { ...OPTIONS }, async ($, on) => {
  const world = fakeWorld(on)
  const cloud = {
    sessionId: 'sess-cloud',
    project: 'other-repo',
    cwd: '/work/other-repo',
    summary: 'Adding the settings page',
    items: [{ id: 1, text: 'Add settings page', source: 'todo', status: 'pending', ticked: false }],
    updatedAt: '2026-10-20T11:55:00Z',
    machine: 'cloud',
  }
  const old = { ...cloud, sessionId: 'sess-old', project: 'old-repo', updatedAt: '2026-10-10T11:55:00Z' }
  // Enough forgotten sessions that a capped read never returns the oldest ones.
  const forgotten: Record<string, unknown> = {}
  for (let i = 0; i < 600; i += 1) forgotten[`sess-gone-${i}`] = { ...old, sessionId: `sess-gone-${i}`, updatedAt: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z` }
  const remote = fakeTable(on, { 'sess-cloud': cloud, 'sess-old': old, ...forgotten })

  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await world.clock.advance(15000)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /other-repo/ }))?.text).toBe('  other-repo · Adding the settings page · 1 open · @cloud')
  expect((await ui.find({ type: 'Text', text: /old-repo/ }))?.props.dimColor).toBe(true)
  await ui.unmount()

  // The capped read holds 500 rows, so some stale rows were never seen; prune still removes them by time.
  expect(remote.table.size).toBe(603)
  const result = await $.command.run({ command: 'board', args: 'prune', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(result?.text).toContain('from the shared board')
  expect([...remote.table.keys()].sort()).toEqual(['sess-A', 'sess-cloud'])
})

test('a refused key shows one toast and leaves the local board working', { options: { boardUrl: 'https://proj.supabase.co', boardKey: 'wrong' } }, async ($, on) => {
  const world = fakeWorld(on)
  fakeTable(on, {})
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TodoWrite', todos: [...TODOS] })
  await world.clock.advance(15000)
  expect(world.toasts.filter(text => text.startsWith('shared board')).length).toBe(1)
  expect(world.boardFile('sess-A')?.items.length).toBe(2)
})

test('TaskCreate and TaskUpdate drive the checklist, and a ticked task survives a reopen', async ($, on) => {
  const world = fakeWorld(on)
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Fix login', description: 'The null ref' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Rotate key', description: 'In the portal' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'task-1', status: 'in_progress' })

  let file = world.boardFile('sess-A')
  expect(file?.items.map(item => [item.id, item.text, item.status, item.taskId])).toEqual([
    [1, 'Fix login', 'in_progress', 'task-1'],
    [2, 'Rotate key', 'pending', 'task-2'],
  ])
  expect(file?.summary).toBe('Fix login')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'item-2' })
  await ui.unmount()
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'task-2', status: 'in_progress' })
  file = world.boardFile('sess-A')
  expect(file?.items[1]?.status).toBe('completed')
  await world.clock.advance(300)
  expect(world.lastNote()).toContain('stay done')
  expect(world.lastNote()).toContain('#2 "Rotate key"')
})

test('a Haiku summary stays until the next one, and the raw prompt is only a first fallback', async ($, on) => {
  const world = fakeWorld(on)
  let asked = 0
  on('model.complete', () => {
    asked += 1
    return { value: { isAnswered: true, text: 'Fixing the login crash', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  const typed = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })
  await typed('<task-notification>\n<status>x</status>\n</task-notification>\nthe login page crashes on launch')
  await $.turn.start({ text: 'the login page crashes on launch', turnId: 't1' })
  expect(world.boardFile('sess-A')?.summary).toBe('the login page crashes on launch')
  await $.turn.complete({ turnId: 't1', answer: 'On it.', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(world.boardFile('sess-A')?.summary).toBe('Fixing the login crash')
  expect(asked).toBe(1)

  // A new prompt within the five-minute gap keeps the Haiku sentence instead of the raw prompt.
  await world.clock.advance(60_000)
  await typed('ok and what about the claude prompt update?')
  await $.turn.start({ text: 'ok and what about the claude prompt update?', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(world.boardFile('sess-A')?.summary).toBe('Fixing the login crash')
  expect(asked).toBe(1)

  // Past the gap, the next completed turn asks again.
  await world.clock.advance(5 * 60_000)
  await typed('now the settings page')
  await $.turn.start({ text: 'now the settings page', turnId: 't3' })
  await $.turn.complete({ turnId: 't3', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(asked).toBe(2)

  // A background notification is not a request: it neither becomes the summary nor calls Haiku.
  await world.clock.advance(5 * 60_000)
  await $.prompt.submit({ text: 'Task finished: build 42', origin: { kind: 'task-notification' }, wait: false })
  await $.turn.start({ text: 'Task finished: build 42', turnId: 't4' })
  await $.turn.complete({ turnId: 't4', answer: 'Noted.', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(asked).toBe(2)
  expect(world.boardFile('sess-A')?.summary).toBe('Fixing the login crash')
})

test('a completed turn that mentions something for later puts it on the checklist as a loose end', async ($, on) => {
  const world = fakeWorld(on)
  const asked: string[] = []
  on('model.complete', (_, e) => {
    asked.push(e.prompt)
    const isScan = e.prompt.startsWith('Already on the checklist')
    const text = isScan ? '- Rotate the API key in the portal\n- Bump the version before release' : 'Fixing the login crash'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

  // No cue phrase: no scan.
  await $.prompt.submit({ text: 'fix the login crash', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'fix the login crash', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', answer: 'Fixed the null reference and added a test.', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(asked.filter(prompt => prompt.startsWith('Already on the checklist')).length).toBe(0)
  expect(world.boardFile('sess-A')?.items).toEqual([])

  // A cue phrase in the reply: one scan, two loose ends, one note to Claude.
  await $.prompt.submit({ text: 'and the key?', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'and the key?', turnId: 't2' })
  await $.turn.complete({ turnId: 't2', answer: "Done. You'll need to rotate the API key in the portal later, and bump the version before release.", durationMs: 10, isAborted: false, reason: 'answer' })
  expect(asked.filter(prompt => prompt.startsWith('Already on the checklist')).length).toBe(1)
  expect(world.boardFile('sess-A')?.items.map(item => [item.id, item.text, item.source])).toEqual([
    [1, 'Rotate the API key in the portal', 'followup'],
    [2, 'Bump the version before release', 'followup'],
  ])
  await world.clock.advance(300)
  expect(world.lastNote()).toContain('Loose ends noted')
  expect(world.lastNote()).toContain('#1 "Rotate the API key in the portal"')

  // The same loose ends again: the scan sees them on the checklist, nothing is added twice.
  await $.prompt.submit({ text: 'remind me what is left', origin: { kind: 'composer' }, wait: false })
  await $.turn.start({ text: 'remind me what is left', turnId: 't3' })
  await $.turn.complete({ turnId: 't3', answer: 'Rotate the API key in the portal later.', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(world.boardFile('sess-A')?.items.length).toBe(2)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ key: 'item-1' }))?.props.label).toBe('[ ] #1 Rotate the API key in the portal (loose end)')
  await ui.unmount()
})
