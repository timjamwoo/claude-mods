// Drives the hooks module through the engine's own test kit. Nothing sits
// beneath the plugin, so the hooks registered here stand for the engine: an
// in-memory file system, a fixed session id, and so on.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

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
function fakeWorld(on: On) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let tick = 0

  on('fs.write', (_, e) => {
    files.set(e.path, { text: e.text, mtimeMs: ++tick })
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const file = files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: file.text }
  })
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
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', () => ({ value: undefined }))

  on('session.id', () => ({ value: 'sess-A' }))
  on('session.repo', () => ({ value: null }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
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

  return { files, clock, session, boardFile, put, lastNote, noteCount }
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
    expect(mine?.text).toBe('▶ my-app · (no summary yet) · 0 open')
    expect(mine?.props.bold).toBe(true)
    const theirs = await ui.find({ type: 'Text', text: /other-repo/ })
    expect(theirs?.text).toBe('  other-repo · Adding the settings page · 1 open')
    const stale = await ui.find({ type: 'Text', text: /old-repo/ })
    expect(stale?.props.dimColor).toBe(true)
    expect(stale?.text).toContain('stale')
    await ui.unmount()
  }
})
