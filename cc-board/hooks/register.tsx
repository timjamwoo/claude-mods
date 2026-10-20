// cc-board: wiring only. The rules live in checklist.ts and board.ts.
//
// What this module does:
//   - keeps this session's checklist (TodoWrite items + manual steps) in $.state
//   - writes it to ~/.claude/board/<session-id>.json after every change
//   - polls that folder and draws every live session in the band above the prompt
//   - draws the checklist as buttons in a pane, and tells Claude what you ticked
//
// Every helper that takes `$` is a top-level function: `claude plugin validate`
// follows `$` only into those.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BoardSession, Checklist, ChecklistItem } from '../types'
import {
  EMPTY_CHECKLIST,
  addManual,
  describeChanges,
  mergeTodos,
  openItems,
  parseItemId,
  parseManualLines,
  setTicked,
  type Change,
  type Todo,
} from './checklist'
import {
  basename,
  boardLine,
  cheapSummary,
  clip,
  fileFor,
  fullBoardText,
  isLive,
  isStale,
  parse,
  serialize,
  sortSessions,
} from './board'

const PANE = 'cc-board'
const POLL_MS = 2000
const FLUSH_MS = 300
const HAIKU_GAP_MS = 5 * 60 * 1000

const checklist = atom({ plugin: 'cc-board', key: 'checklist' } as const, EMPTY_CHECKLIST)
const summary = atom({ plugin: 'cc-board', key: 'summary' } as const, '')
const board = atom({ plugin: 'cc-board', key: 'board' } as const, [])

// ---- Module state (a hot reload resets it; session.start refills it) ------

let useHaiku = true

let sessionId = ''
let cwd = ''
let project = ''
let boardDir = ''

// What the summary is derived from.
let lastPrompt = ''
let lastAnswer = ''
let haikuText = ''
let haikuPrompt = ''
let haikuAt = 0

// Changes not yet told to Claude, flushed as one note after a short pause.
let pending: Change[] = []
let flushTimer: Timer | undefined

// The board files as last read: name -> mtime, and name -> parsed session.
const seenMtime = new Map<string, number>()
const sessions = new Map<string, BoardSession>()
let liveSignature = ''

function log($: EngineInterface, text: string): void {
  $.ui.log(`cc-board: ${text}`, { to: 'debug' })
}

// ---- Board file -----------------------------------------------------------

async function writeBoardFile($: EngineInterface, endedAt?: string): Promise<void> {
  if (boardDir === '' || sessionId === '') return
  try {
    const now = await $.clock.now()
    const list = await read($, checklist)
    const snapshot: BoardSession = {
      sessionId,
      project,
      cwd,
      summary: await read($, summary),
      items: list.items,
      updatedAt: new Date(now).toISOString(),
    }
    if (endedAt !== undefined) snapshot.endedAt = endedAt

    // $.fs.write is not atomic, so write a temp file and rename it into place.
    const target = fileFor(boardDir, sessionId)
    const temp = `${target}.${now}.tmp`
    await $.fs.write(temp, serialize(snapshot))
    const moved = await $.process.run(['mv', '-f', temp, target], { timeoutMs: 5000 })
    if (moved.exitCode !== 0) log($, `mv failed: ${moved.stderr}`)
    await refreshBoard($)
  } catch (error) {
    log($, `board write failed: ${String(error)}`)
  }
}

async function refreshBoard($: EngineInterface): Promise<void> {
  if (boardDir === '') return
  let entries
  try {
    entries = await $.fs.list(boardDir)
  } catch {
    return // No board folder yet: nothing to show.
  }

  let changed = false
  const present = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    present.add(entry.name)
    if (seenMtime.get(entry.name) === entry.mtimeMs) continue
    seenMtime.set(entry.name, entry.mtimeMs)
    try {
      const session = parse(await $.fs.read(`${boardDir}/${entry.name}`))
      if (session === undefined) {
        log($, `skipped malformed board file ${entry.name}`)
        sessions.delete(entry.name)
      } else {
        sessions.set(entry.name, session)
      }
      changed = true
    } catch (error) {
      log($, `could not read ${entry.name}: ${String(error)}`)
    }
  }
  for (const name of [...sessions.keys()]) {
    if (present.has(name)) continue
    sessions.delete(name)
    seenMtime.delete(name)
    changed = true
  }

  // A session also changes when it crosses the 24h stale line with no write.
  const now = await $.clock.now()
  const signature = [...sessions.values()].map(s => `${s.sessionId}:${isLive(s, now)}`).join('|')
  if (signature !== liveSignature) {
    liveSignature = signature
    changed = true
  }
  if (changed) await update($, board, () => [...sessions.values()])
}

// ---- Telling Claude -------------------------------------------------------

function queueChange($: EngineInterface, change: Change): void {
  pending.push(change)
  flushTimer?.cancel()
  flushTimer = $.clock.after(FLUSH_MS, () => flushChanges($))
}

async function flushChanges($: EngineInterface): Promise<void> {
  if (pending.length === 0) return
  const text = describeChanges(pending)
  pending = []
  try {
    const result = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    if (result.deny !== undefined) log($, `note refused: ${result.deny}`)
  } catch (error) {
    log($, `note failed: ${String(error)}`)
  }
}

// ---- Summary --------------------------------------------------------------

async function refreshSummary($: EngineInterface, mayCallModel: boolean): Promise<void> {
  const list = await read($, checklist)
  const cheap = cheapSummary(list.items, lastPrompt)
  let text = cheap.text

  if (!cheap.fromTodo && lastPrompt !== '') {
    if (haikuPrompt === lastPrompt && haikuText !== '') {
      text = haikuText
    } else if (mayCallModel && useHaiku) {
      const now = await $.clock.now()
      if (now - haikuAt > HAIKU_GAP_MS) {
        haikuAt = now
        haikuPrompt = lastPrompt
        haikuText = await askHaiku($)
        if (haikuText !== '') text = haikuText
      }
    }
  }
  await update($, summary, () => text)
}

async function askHaiku($: EngineInterface): Promise<string> {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system:
        'You summarize what a coding session is working on. Answer with one plain sentence of at most twelve words, no quotes, no preamble.',
      prompt: `User's latest request:\n${clip(lastPrompt, 1500)}\n\nAssistant's latest reply:\n${clip(lastAnswer, 1500)}`,
      maxTokens: 60,
      effort: 'low',
      timeoutMs: 8000,
    })
    if (!reply.isAnswered) {
      log($, `haiku summary skipped: ${reply.reason}`)
      return ''
    }
    return clip(reply.text, 100)
  } catch (error) {
    log($, `haiku summary failed: ${String(error)}`)
    return ''
  }
}

// ---- Checklist edits ------------------------------------------------------

async function toggleItem($: EngineInterface, id: number): Promise<void> {
  let change: Change | undefined
  await update($, checklist, (list: Checklist) => {
    const found = list.items.find(item => item.id === id)
    if (found === undefined) return list
    const ticked = found.status !== 'completed'
    const result = setTicked(list, id, ticked)
    if (result.item !== undefined) change = { kind: ticked ? 'ticked' : 'unticked', item: result.item }
    return result.list
  })
  if (change === undefined) return
  queueChange($, change)
  await refreshSummary($, false)
  await writeBoardFile($)
}

async function applyTodos($: EngineInterface, todos: readonly Todo[]): Promise<void> {
  let kept: ChecklistItem[] = []
  await update($, checklist, (list: Checklist) => {
    const result = mergeTodos(list, todos)
    kept = result.keptDone
    return result.list
  })
  for (const item of kept) queueChange($, { kind: 'kept-done', item })
  await refreshSummary($, false)
  await writeBoardFile($)
}

async function addManualStep($: EngineInterface, text: string): Promise<ChecklistItem | undefined> {
  let added: ChecklistItem | undefined
  await update($, checklist, (list: Checklist) => {
    const result = addManual(list, text)
    added = result.added ? result.item : undefined
    return result.list
  })
  if (added !== undefined) queueChange($, { kind: 'manual-added', item: added })
  return added
}

async function addManualLines($: EngineInterface, text: string): Promise<number> {
  let count = 0
  for (const line of parseManualLines(text)) {
    const added = await addManualStep($, line)
    if (added === undefined) continue
    count += 1
    $.ui.toast(`manual step #${added.id}: ${clip(added.text, 60)}`)
  }
  if (count > 0) await writeBoardFile($)
  return count
}

async function bindSession($: EngineInterface): Promise<void> {
  sessionId = await $.session.id()
  const repo = await $.session.repo().catch(() => null)
  project = basename(repo?.root ?? cwd)
  pending = []
  lastPrompt = ''
  lastAnswer = ''
}

async function registerCommands($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'manual',
    description: 'Add a manual step to this session’s checklist (no Claude turn)',
    argumentHint: '<text>',
    immediate: true,
  })
  await $.command.register({
    name: 'done',
    description: 'Tick a checklist item done by its number (no Claude turn)',
    argumentHint: '<id>',
    immediate: true,
  })
  await $.command.register({
    name: 'board',
    description: 'Print the board of all sessions; “prune” removes stale ones',
    argumentHint: '[prune]',
    immediate: true,
  })
}

async function pruneBoard($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const stale = [...sessions.entries()].filter(
    ([, session]) => session.sessionId !== sessionId && (session.endedAt !== undefined || isStale(session, now)),
  )
  if (stale.length === 0) return 'cc-board: nothing to prune.'
  const answer = await $.ui
    .ask(`Remove ${stale.length} stale or ended session file(s) from the board?`, ['Remove', 'Keep'])
    .catch(() => 'Keep')
  if (answer !== 'Remove') return 'cc-board: kept everything.'
  const paths = stale.map(([name]) => `${boardDir}/${name}`)
  const removed = await $.process.run(['rm', '-f', ...paths], { timeoutMs: 5000 })
  if (removed.exitCode !== 0) return `cc-board: rm failed: ${removed.stderr}`
  await refreshBoard($)
  return `cc-board: removed ${stale.length} session file(s).`
}

function itemMark(item: ChecklistItem): string {
  if (item.status === 'completed') return '[x]'
  if (item.status === 'in_progress') return '[>]'
  return '[ ]'
}

function itemLabel(item: ChecklistItem): string {
  const source = item.source === 'manual' ? ' (manual)' : ''
  return `${itemMark(item)} #${item.id} ${item.text}${source}`
}

// ---- Hooks ----------------------------------------------------------------

export const register: Register = (on, options) => {
  useHaiku = options.haikuSummary !== false

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try {
      await bindSession($)
      const home = await $.env.get('HOME')
      boardDir = home === undefined || home === '' ? '' : `${home}/.claude/board`
      if (boardDir === '') log($, 'HOME is unset, so no board file is written')
    } catch (error) {
      log($, `start failed: ${String(error)}`)
    }
    try {
      await registerCommands($)
    } catch (error) {
      log($, `command registration failed: ${String(error)}`)
    }

    void $.ui.open({ id: PANE, title: 'cc-board' })
    $.clock.every(POLL_MS, () => refreshBoard($))
    await writeBoardFile($)
    return next(e)
  })

  // /clear, /resume and /branch start a new session id without a session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      cwd = await $.session.cwd()
      await bindSession($)
      await writeBoardFile($)
    } catch (error) {
      log($, `rebind failed: ${String(error)}`)
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const now = await $.clock.now()
    await writeBoardFile($, new Date(now).toISOString())
    return next(e)
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await applyTodos($, e.todos)
      } catch (error) {
        log($, `TodoWrite merge failed: ${String(error)}`)
      }
    }
    return next(e)
  })

  // Lines Claude writes that start with "MANUAL:" become manual steps.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        const text = e.message.content
          .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
          .join('\n')
        await addManualLines($, text)
      } catch (error) {
        log($, `MANUAL scan failed: ${String(error)}`)
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text.trim() !== '') {
      lastPrompt = e.text
      await refreshSummary($, false)
      await writeBoardFile($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      lastAnswer = e.answer
      await refreshSummary($, true)
      await writeBoardFile($)
    }
    return next(e)
  })

  on('command.run', { command: 'manual' }, async ($, e) => {
    const text = e.args.trim()
    if (text === '') return { text: 'Usage: /manual <step you will do by hand>' }
    const added = await addManualStep($, text)
    if (added === undefined) {
      $.ui.toast('that step is already on the checklist')
    } else {
      $.ui.toast(`added manual step #${added.id}`)
      await writeBoardFile($)
    }
    void $.ui.open({ id: PANE, title: 'cc-board' })
    return {}
  })

  on('command.run', { command: 'done' }, async ($, e) => {
    const id = parseItemId(e.args)
    if (id === undefined) return { text: 'Usage: /done <id>  (the number shown in the pane)' }
    const list = await read($, checklist)
    const item = list.items.find(one => one.id === id)
    if (item === undefined) return { text: `cc-board: no item #${id}` }
    if (item.status !== 'completed') await toggleItem($, id)
    $.ui.toast(`#${id} done`)
    return {}
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    await refreshBoard($)
    if (e.args.trim() === 'prune') return { text: await pruneBoard($) }
    void $.ui.open({ id: PANE, title: 'cc-board' })
    const now = await $.clock.now()
    return { text: fullBoardText([...sessions.values()], sessionId, now) }
  })

  // ---- Drawing ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, checklist)
    const current = await read($, summary)
    const open = openItems(list.items).length

    return (
      <Box flexDirection="column">
        <Text bold>
          {project} · {open} open
        </Text>
        {current !== '' && (
          <Text dimColor wrap="truncate-end">
            {current}
          </Text>
        )}
        {list.items.length === 0 && <Text dimColor>No items yet. Claude’s todos and /manual steps show here.</Text>}
        {list.items.map(item => (
          <Button
            key={`item-${item.id}`}
            plain
            dimColor={item.status === 'completed'}
            label={itemLabel(item)}
            onPress={() => void toggleItem($, item.id)}
          />
        ))}
        <Text dimColor>Click or Tab+Enter ticks an item. /done {'<id>'} works too.</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const all = await read($, board)
    const now = await $.clock.now()
    const rows = sortSessions(all, sessionId).filter(session => session.endedAt === undefined)
    if (rows.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rows.map(session => (
          <Text bold={session.sessionId === sessionId} dimColor={isStale(session, now)} wrap="truncate-end">
            {boardLine(session, session.sessionId === sessionId, now)}
          </Text>
        ))}
      </Box>
    )
  })
}
