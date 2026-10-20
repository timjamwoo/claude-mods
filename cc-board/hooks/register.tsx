// cc-board: wiring only. The rules live in checklist.ts and board.ts.
//
// What this module does:
//   - keeps this session's checklist (TodoWrite items + manual steps) in $.state
//   - writes it to ~/.claude/board/<session-id>.json after every change
//   - polls that folder and draws every live session in the band above the prompt
//   - optionally mirrors the same document to a Supabase table (one row per
//     session), so sessions on other machines and in the cloud share one board
//   - draws the checklist as buttons in a pane, and tells Claude what you ticked
//
// Every helper that takes `$` is a top-level function: `claude plugin validate`
// follows `$` only into those.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { BoardSession, Checklist, ChecklistItem } from '../types'
import {
  EMPTY_CHECKLIST,
  addManual,
  applyTaskEvent,
  describeChanges,
  mergeTodos,
  openItems,
  parseItemId,
  parseManualLines,
  reconcile,
  seedFromTranscript,
  setTicked,
  type Change,
  type TaskEvent,
  type Todo,
} from './checklist'
import {
  basename,
  boardLine,
  cheapSummary,
  cleanPrompt,
  clip,
  fileFor,
  fullBoardText,
  isLive,
  isStale,
  mergeSessions,
  parse,
  serialize,
  sortSessions,
  STALE_AFTER_MS,
} from './board'
import { deleteBeforeUrl, deleteUrl, parseRows, readUrl, sharedHeaders, tableUrl, upsertBody, upsertHeaders } from './shared'

const PANE = 'cc-board'
const POLL_MS = 2000
const REMOTE_POLL_MS = 15000
const REMOTE_PUSH_MS = 2000
const FLUSH_MS = 300
const HAIKU_GAP_MS = 5 * 60 * 1000

const checklist = atom({ plugin: 'cc-board', key: 'checklist' } as const, EMPTY_CHECKLIST)
const summary = atom({ plugin: 'cc-board', key: 'summary' } as const, '')
const board = atom({ plugin: 'cc-board', key: 'board' } as const, [])

// ---- Module state (a hot reload resets it; session.start refills it) ------

let useHaiku = true
let pluginOptions: PluginOptions = {}

let sessionId = ''
let cwd = ''
let project = ''
let machine = ''
let boardDir = ''

// The shared table, when configured.
let boardUrl = ''
let boardKey = ''
let remoteFailures = 0
let pushTimer: Timer | undefined
let pendingPush: BoardSession | undefined
let lastPushed = ''

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
// The shared table's sessions as last read, by session id.
const remoteSessions = new Map<string, BoardSession>()
let boardSignature = ''

function isRemoteConfigured(): boolean {
  return boardUrl !== '' && boardKey !== ''
}

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
    if (machine !== '') snapshot.machine = machine

    // $.fs.write is not atomic, so write a temp file and rename it into place.
    const target = fileFor(boardDir, sessionId)
    const temp = `${target}.${now}.tmp`
    await $.fs.write(temp, serialize(snapshot))
    const moved = await $.process.run(['mv', '-f', temp, target], { timeoutMs: 5000 })
    if (moved.exitCode !== 0) log($, `mv failed: ${moved.stderr}`)
    await refreshBoard($)
    schedulePush($, snapshot, endedAt !== undefined)
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

  await publishBoard($, changed)
}

/** Puts the merged board (local files + gist) into state when it differs from what is drawn. */
async function publishBoard($: EngineInterface, changed: boolean): Promise<void> {
  const merged = mergeSessions([...sessions.values()], [...remoteSessions.values()])
  // A session also changes when it crosses the 24h stale line with no write.
  const now = await $.clock.now()
  const signature = merged.map(s => `${s.sessionId}:${s.updatedAt}:${isLive(s, now)}`).join('|')
  if (signature !== boardSignature) {
    boardSignature = signature
    changed = true
  }
  if (changed) await update($, board, () => merged)
}

// ---- Shared board in a Supabase table --------------------------------------

async function configureRemote($: EngineInterface): Promise<void> {
  const option = (name: string) => {
    const value = pluginOptions[name]
    return typeof value === 'string' ? value.trim() : ''
  }
  boardUrl = option('boardUrl') || ((await $.env.get('CC_BOARD_URL')) ?? '').trim()
  boardKey = option('boardKey') || ((await $.env.get('CC_BOARD_KEY')) ?? '').trim()
  if (boardUrl !== '' && boardKey === '') log($, 'boardUrl is set but no key: the board stays local')
}

/** A short label for where this session runs: "cloud", or the host name. */
async function detectMachine($: EngineInterface): Promise<string> {
  const named = ((await $.env.get('CC_BOARD_MACHINE')) ?? '').trim()
  if (named !== '') return named
  if ((await $.env.get('CLAUDE_CODE_REMOTE_SDK_URL')) !== undefined) return 'cloud'
  try {
    const host = await $.process.run(['hostname', '-s'], { timeoutMs: 3000 })
    return host.exitCode === 0 ? host.stdout.trim() : 'local'
  } catch {
    return 'local'
  }
}

function remoteFailed($: EngineInterface, what: string, status: number | string): void {
  remoteFailures += 1
  log($, `shared board ${what} failed: ${status}`)
  if (remoteFailures === 1) $.ui.toast(`shared board: ${what} failed (${status}), see the debug log`)
}

/** Writes this session's row, a little after the last local write, and only when it changed. */
function schedulePush($: EngineInterface, snapshot: BoardSession, atOnce: boolean): void {
  if (!isRemoteConfigured()) return
  pendingPush = snapshot
  pushTimer?.cancel()
  if (atOnce) {
    void pushRemote($)
  } else {
    pushTimer = $.clock.after(REMOTE_PUSH_MS, () => pushRemote($))
  }
}

async function pushRemote($: EngineInterface): Promise<void> {
  if (!isRemoteConfigured() || pendingPush === undefined) return
  const body = upsertBody(pendingPush)
  if (body === lastPushed) return
  try {
    const response = await $.http.fetch(tableUrl(boardUrl), { method: 'POST', headers: upsertHeaders(boardKey), body })
    if (response.ok) {
      lastPushed = body
      remoteFailures = 0
    } else {
      remoteFailed($, 'write', response.status)
    }
  } catch (error) {
    remoteFailed($, 'write', String(error))
  }
}

async function pullRemote($: EngineInterface): Promise<void> {
  if (!isRemoteConfigured()) return
  try {
    const response = await $.http.fetch(readUrl(boardUrl), { headers: sharedHeaders(boardKey) })
    if (!response.ok) {
      remoteFailed($, 'read', response.status)
      return
    }
    remoteFailures = 0
    remoteSessions.clear()
    for (const session of parseRows(response.text)) remoteSessions.set(session.sessionId, session)
    await publishBoard($, true)
  } catch (error) {
    remoteFailed($, 'read', String(error))
  }
}

/**
 * Deletes the named sessions' rows, and every row older than the stale line,
 * which reaches rows a capped read never returned. False when a request failed.
 */
async function deleteRemote($: EngineInterface, sessionIds: readonly string[], beforeIso: string): Promise<boolean> {
  if (!isRemoteConfigured()) return true
  const urls = [deleteBeforeUrl(boardUrl, beforeIso)]
  if (sessionIds.length > 0) urls.push(deleteUrl(boardUrl, sessionIds))
  try {
    for (const url of urls) {
      const response = await $.http.fetch(url, { method: 'DELETE', headers: sharedHeaders(boardKey) })
      if (!response.ok) {
        remoteFailed($, 'prune', response.status)
        return false
      }
    }
    for (const id of sessionIds) remoteSessions.delete(id)
    return true
  } catch (error) {
    remoteFailed($, 'prune', String(error))
    return false
  }
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

/**
 * The summary: an in-progress or pending task wins. Otherwise, with Haiku on,
 * the last Haiku sentence stays until a new one is made (at most one call per
 * HAIKU_GAP_MS, and only when the prompt changed); the raw prompt shows only
 * before the first call. With Haiku off, the prompt's first line is used.
 */
async function refreshSummary($: EngineInterface, mayCallModel: boolean): Promise<void> {
  const list = await read($, checklist)
  const cheap = cheapSummary(list.items, lastPrompt)
  let text = cheap.text

  if (!cheap.fromTask && useHaiku) {
    if (mayCallModel && lastPrompt !== '' && haikuPrompt !== lastPrompt) {
      const now = await $.clock.now()
      if (now - haikuAt > HAIKU_GAP_MS) {
        haikuAt = now
        haikuPrompt = lastPrompt
        const fresh = await askHaiku($)
        if (fresh !== '') haikuText = fresh
      }
    }
    if (haikuText !== '') text = haikuText
  }
  await update($, summary, () => text)
}

async function applyTask($: EngineInterface, event: TaskEvent): Promise<void> {
  let kept: ChecklistItem | undefined
  await update($, checklist, (list: Checklist) => {
    const result = applyTaskEvent(list, event)
    kept = result.keptDone
    return result.list
  })
  if (kept !== undefined) queueChange($, { kind: 'kept-done', item: kept })
  await refreshSummary($, false)
  await writeBoardFile($)
}

async function askHaiku($: EngineInterface): Promise<string> {
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system:
        'You write a one-line status for a board of coding sessions. Answer with one plain phrase of at most twelve words that says what the session is working on, starting with a verb ending in -ing, such as "Fixing the login crash on iOS". No quotes, no preamble, no mention of the user or the assistant. The excerpts may be cut short; never remark on that.',
      prompt: `Latest request:\n${clip(lastPrompt, 1500)}\n\nEnd of the latest reply:\n${tail(lastAnswer, 1500)}`,
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
  haikuText = ''
  haikuPrompt = ''
  haikuAt = 0
}

/**
 * Fills the checklist at startup. A resumed or restarted session keeps its
 * id, so its own board file comes back first, ticks included. With no file
 * (a session that predates the mod), the transcript's last TodoWrite and any
 * MANUAL: lines seed it. Claude already knows all of this, so nothing is queued.
 */
async function restoreChecklist($: EngineInterface): Promise<'file' | 'transcript' | 'none'> {
  if (boardDir !== '' && sessionId !== '') {
    try {
      const path = fileFor(boardDir, sessionId)
      if (await $.fs.exists(path)) {
        const saved = parse(await $.fs.read(path))
        if (saved !== undefined) {
          // The file wins (ticks, manual steps, summary), topped up with any task
          // the transcript knows and the file does not, as after an upgrade.
          const nextId = Math.max(0, ...saved.items.map(item => item.id)) + 1
          const list = reconcile({ items: saved.items, nextId }, await replayTranscript($))
          await update($, checklist, () => list)
          await update($, summary, () => saved.summary)
          return 'file'
        }
      }
    } catch (error) {
      log($, `restore from board file failed: ${String(error)}`)
    }
  }

  try {
    const messages = await $.session.messages()
    if ('deny' in messages) return 'none'
    const list = seedFromTranscript(messages)
    const lastUser = [...messages].reverse().find(message => message.role === 'user' && cleanPrompt(message.text) !== '')
    lastPrompt = cleanPrompt(lastUser?.text ?? '')
    if (list.items.length === 0 && lastPrompt === '') return 'none'
    await update($, checklist, () => list)
    await refreshSummary($, false)
    return 'transcript'
  } catch (error) {
    log($, `seed from transcript failed: ${String(error)}`)
    return 'none'
  }
}

/** The checklist the transcript implies, or an empty one when it cannot be read. */
async function replayTranscript($: EngineInterface): Promise<Checklist> {
  try {
    const messages = await $.session.messages()
    return 'deny' in messages ? EMPTY_CHECKLIST : seedFromTranscript(messages)
  } catch (error) {
    log($, `transcript replay failed: ${String(error)}`)
    return EMPTY_CHECKLIST
  }
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
  await pullRemote($)
  const now = await $.clock.now()
  const merged = mergeSessions([...sessions.values()], [...remoteSessions.values()])
  const stale = merged.filter(
    session => session.sessionId !== sessionId && (session.endedAt !== undefined || isStale(session, now)),
  )
  if (stale.length === 0) return 'cc-board: nothing to prune.'
  const answer = await $.ui
    .ask(`Remove ${stale.length} stale or ended session(s) from the board?`, ['Remove', 'Keep'])
    .catch(() => 'Keep')
  if (answer !== 'Remove') return 'cc-board: kept everything.'

  const localPaths = stale
    .map(session => `${session.sessionId}.json`)
    .filter(name => sessions.has(name))
    .map(name => `${boardDir}/${name}`)
  if (localPaths.length > 0) {
    const removed = await $.process.run(['rm', '-f', ...localPaths], { timeoutMs: 5000 })
    if (removed.exitCode !== 0) return `cc-board: rm failed: ${removed.stderr}`
  }
  const remoteIds = stale.map(session => session.sessionId).filter(id => remoteSessions.has(id))
  const remoteOk = await deleteRemote($, remoteIds, new Date(now - STALE_AFTER_MS).toISOString())
  await refreshBoard($)
  const where = isRemoteConfigured() ? ` (${remoteIds.length} from the shared board${remoteOk ? '' : ', which failed'})` : ''
  return `cc-board: removed ${stale.length} session(s)${where}.`
}

/** The last `max` characters of a text on one line, with a leading ellipsis when cut. */
function tail(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `…${oneLine.slice(oneLine.length - max + 1)}`
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
  pluginOptions = options

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try {
      await bindSession($)
      const home = await $.env.get('HOME')
      boardDir = home === undefined || home === '' ? '' : `${home}/.claude/board`
      if (boardDir === '') log($, 'HOME is unset, so no board file is written')
      machine = await detectMachine($)
      await configureRemote($)
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
    if (isRemoteConfigured()) {
      $.clock.every(REMOTE_POLL_MS, () => pullRemote($))
      void pullRemote($)
    }
    const restored = await restoreChecklist($)
    if (restored !== 'none') log($, `checklist restored from ${restored}`)
    await writeBoardFile($)
    return next(e)
  })

  // /clear, /resume and /branch start a new session id without a session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    try {
      cwd = await $.session.cwd()
      await bindSession($)
      if (e.source !== 'clear') await restoreChecklist($)
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

  // The Task tools, which newer builds use in place of TodoWrite. The call runs
  // first, so a created task's id is known and a refused update changes nothing.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined) {
      try {
        const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
        if (typeof task?.id === 'string') await applyTask($, { kind: 'created', taskId: task.id, subject: e.subject })
      } catch (error) {
        log($, `TaskCreate failed: ${String(error)}`)
      }
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined) {
      try {
        const ok = (ran.result as { success?: unknown } | undefined)?.success !== false
        if (ok) {
          const event: TaskEvent = { kind: 'updated', taskId: e.taskId }
          if (e.status !== undefined) event.status = e.status
          if (e.subject !== undefined) event.subject = e.subject
          await applyTask($, event)
        }
      } catch (error) {
        log($, `TaskUpdate failed: ${String(error)}`)
      }
    }
    return ran
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

  // Only what a person typed feeds the summary: notifications, scheduled
  // triggers and other sessions' messages are not what this session works on.
  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const isTyped = e.isMeta !== true && e.command === undefined && (kind === 'composer' || kind === 'bridge' || kind === 'sdk')
    if (isTyped) {
      // A typed prompt that is nothing but markup is still the person's request.
      const typed = cleanPrompt(e.text) || (e.text.split('\n').find(line => line.trim() !== '') ?? '').trim()
      if (typed !== '') lastPrompt = typed
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
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
    const merged = mergeSessions([...sessions.values()], [...remoteSessions.values()])
    return { text: fullBoardText(merged, sessionId, now, machine) }
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
        {list.items.length === 0 && <Text dimColor>No tasks yet. /manual {'<text>'} adds a step of your own.</Text>}
        {list.items.map(item => (
          <Button
            key={`item-${item.id}`}
            plain
            dimColor={item.status === 'completed'}
            label={itemLabel(item)}
            onPress={() => void toggleItem($, item.id)}
          />
        ))}
        {list.items.length > 0 && <Text dimColor>Click an item to tick it, or /done {'<id>'}.</Text>}
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
            {boardLine(session, session.sessionId === sessionId, now, machine)}
          </Text>
        ))}
      </Box>
    )
  })
}
