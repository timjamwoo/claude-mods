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
import type { EngineInterface, PluginOptions, Register, RenderSurface, Timer } from 'claude-code'

import type { BoardSession, Checklist, ChecklistItem } from '../types'
import {
  EMPTY_CHECKLIST,
  addFollowUp,
  addManual,
  applyTaskEvent,
  candidatesHandled,
  cueExcerpts,
  describeChanges,
  hasLooseEndCue,
  markHandled,
  mergeTodos,
  openItems,
  parseHandledIds,
  parseItemId,
  parseFollowUpLines,
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
  displayName,
  fileFor,
  fullBoardText,
  isLive,
  isStale,
  mergeSessions,
  parse,
  serialize,
  sortSessions,
  sourceTag,
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
// Whether the pane lists completed items too. Off by default, so a long session stays short.
const showDone = atom({ plugin: 'cc-board', key: 'showDone' } as const, false)

// ---- Module state (a hot reload resets it; session.start refills it) ------

let useHaiku = true
let useFollowUps = true
let useAutoDone = true
// Whether the sessions are also drawn in the band above the prompt.
let showBand = false
let pluginOptions: PluginOptions = {}

let sessionId = ''
let cwd = ''
let project = ''
// The session's title, as the Desktop app lists it; '' until a classic hook carries one.
let title = ''
let machine = ''
let tty = ''
// A cloud session's claude.ai/code page, '' elsewhere.
let sessionUrl = ''
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
    if (title !== '') snapshot.title = title
    if (endedAt !== undefined) snapshot.endedAt = endedAt
    if (machine !== '') snapshot.machine = machine
    if (tty !== '') snapshot.tty = tty
    if (sessionUrl !== '') snapshot.url = sessionUrl

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

/** The terminal this session runs in, as /dev/ttysNNN, or '' when it has none (the desktop app, a cloud session). */
async function detectTty($: EngineInterface): Promise<string> {
  try {
    const found = await $.process.run(['sh', '-c', 'ps -o tty= -p $PPID'], { timeoutMs: 3000 })
    const name = found.stdout.trim()
    if (found.exitCode !== 0 || name === '' || name === '?' || name === '??') return ''
    return name.startsWith('/dev/') ? name : `/dev/${name}`
  } catch {
    return ''
  }
}

/**
 * Brings the terminal tab of a session on this machine to the front, through
 * Terminal.app then iTerm2. Resolves false when neither holds that tty.
 */
async function raiseTerminal($: EngineInterface, target: string): Promise<boolean> {
  const scripts = [
    `tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if tty of t is "${target}" then
            set selected tab of w to t
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end tell
    return "none"`,
    `tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if tty of s is "${target}" then
              select t
              select s
              activate
              return "ok"
            end if
          end repeat
        end repeat
      end repeat
    end tell
    return "none"`,
  ]
  for (const script of scripts) {
    try {
      const ran = await $.process.run(['osascript', '-e', script], { timeoutMs: 8000 })
      if (ran.exitCode === 0 && ran.stdout.trim() === 'ok') return true
    } catch (error) {
      log($, `osascript failed: ${String(error)}`)
    }
  }
  return false
}

/** Hands a URL to the system opener, so a claude.ai/code page lands in the browser or the Desktop app. */
async function openUrl($: EngineInterface, url: string): Promise<boolean> {
  for (const opener of ['open', 'xdg-open']) {
    try {
      const ran = await $.process.run([opener, url], { timeoutMs: 8000 })
      if (ran.exitCode === 0) return true
    } catch (error) {
      log($, `${opener} failed: ${String(error)}`)
    }
  }
  return false
}

/** What a click on a board line does: raise that session's terminal, open its page, or copy how to get back to it. */
async function switchToSession($: EngineInterface, target: BoardSession, surface: RenderSurface): Promise<void> {
  if (target.sessionId === sessionId) {
    $.ui.toast('that is this session')
    return
  }
  if (target.tty !== undefined && target.machine === machine && (await raiseTerminal($, target.tty))) return
  if (target.url !== undefined && (await openUrl($, target.url))) {
    $.ui.toast(`opened ${displayName(target)} in your browser`)
    return
  }
  const command = `cd ${target.cwd} && claude --resume ${target.sessionId}`
  const copied = await $.ui.copy({ text: command, surface }).catch(() => ({ isCopied: false as const, reason: 'failed' }))
  const where = target.machine !== undefined && target.machine !== machine ? ` (it runs on ${target.machine})` : ''
  $.ui.toast(copied.isCopied ? `resume command copied${where}` : `resume with: ${command}`)
}

/** A cloud session's claude.ai/code page, from the id the cloud sets in the environment; '' for a local session. */
async function detectSessionUrl($: EngineInterface): Promise<string> {
  const remoteId = ((await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')) ?? '').trim()
  const match = /^cse_([A-Za-z0-9]+)$/.exec(remoteId)
  return match === null ? '' : `https://claude.ai/code/session_${match[1]}`
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

// ---- Loose ends -------------------------------------------------------------

/**
 * Asks Haiku which loose ends `text` mentions (things to do later, by hand,
 * or not yet done), skipping what the checklist already holds. Resolves the
 * new lines, or none.
 */
async function extractFollowUps($: EngineInterface, text: string): Promise<string[]> {
  const list = await read($, checklist)
  const open = list.items.filter(item => item.status !== 'completed').map(item => `- ${item.text}`).join('\n')
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system:
        'You keep a checklist for a developer so small things said in passing are not forgotten. Read the exchange and list only concrete actions a person still has to do: something to do by hand or outside this conversation (a portal, a key, a certificate, a store listing, a release, a config), something deferred or skipped for now, or something asked for and not done. Skip what the assistant says it will do next, skip advice and hypotheticals, skip anything finished, and skip anything already on the checklist. One per line, imperative, at most twelve words, at most three lines, no numbering, no commentary. If there is nothing, reply NONE.',
      prompt: `Already on the checklist:\n${open === '' ? '(nothing)' : open}\n\nExchange:\n${cueExcerpts(text)}`,
      maxTokens: 160,
      effort: 'low',
      timeoutMs: 10000,
    })
    if (!reply.isAnswered) {
      log($, `loose-end scan skipped: ${reply.reason}`)
      return []
    }
    return parseFollowUpLines(reply.text)
  } catch (error) {
    log($, `loose-end scan failed: ${String(error)}`)
    return []
  }
}

const SCAN_CHUNK_MESSAGES = 16
const SCAN_MAX_CALLS = 8

/**
 * Reads a whole conversation for loose ends, newest first, in chunks of
 * messages, with at most SCAN_MAX_CALLS model calls. Chunks with no cue
 * phrase cost nothing. Resolves how many loose ends were new.
 */
async function scanTranscript($: EngineInterface, messages: readonly { role: 'user' | 'assistant'; text: string }[]): Promise<number> {
  if (!useFollowUps) return 0
  let found = 0
  let calls = 0
  for (let end = messages.length; end > 0 && calls < SCAN_MAX_CALLS; end -= SCAN_CHUNK_MESSAGES) {
    const chunk = messages.slice(Math.max(0, end - SCAN_CHUNK_MESSAGES), end)
    const text = chunk.map(message => `${message.role === 'user' ? 'User' : 'Claude'}: ${cleanPrompt(message.text)}`).join('\n\n')
    if (!hasLooseEndCue(text)) continue
    calls += 1
    found += await surfaceFollowUps($, text)
  }
  if (found > 0) await writeBoardFile($)
  return found
}

/**
 * Ticks off the manual steps and loose ends that an exchange shows were done,
 * whoever did them. Only items sharing words with the exchange are put to
 * Haiku, so most turns cost nothing. Resolves how many were marked done.
 */
async function tickHandled($: EngineInterface, text: string): Promise<number> {
  if (!useAutoDone) return 0
  const list = await read($, checklist)
  const candidates = candidatesHandled(list.items, text)
  if (candidates.length === 0) return 0
  let ids: number[] = []
  try {
    const reply = await $.model.complete({
      model: 'haiku',
      system:
        'You keep a checklist for a developer. Read the exchange and decide which checklist items it shows as finished: the assistant did the work in this exchange, or the user says they did it. An item that is only mentioned, planned, started, or advised about is not finished. Answer with the numbers of the finished items, one per line, or NONE.',
      prompt: `Checklist:\n${candidates.map(item => `#${item.id} ${item.text}`).join('\n')}\n\nExchange:\n${clip(text, 6000)}`,
      maxTokens: 60,
      effort: 'low',
      timeoutMs: 8000,
    })
    if (!reply.isAnswered) {
      log($, `handled check skipped: ${reply.reason}`)
      return 0
    }
    ids = parseHandledIds(reply.text, candidates)
  } catch (error) {
    log($, `handled check failed: ${String(error)}`)
    return 0
  }
  if (ids.length === 0) return 0
  let done: ChecklistItem[] = []
  await update($, checklist, (list: Checklist) => {
    const result = markHandled(list, ids)
    done = result.items
    return result.list
  })
  for (const item of done) {
    queueChange($, { kind: 'auto-done', item })
    $.ui.toast(`#${item.id} done: ${clip(item.text, 60)}`)
  }
  return done.length
}

/** Adds the loose ends found in `text` to the checklist and tells Claude. Resolves how many were new. */
async function surfaceFollowUps($: EngineInterface, text: string): Promise<number> {
  if (!useFollowUps || !hasLooseEndCue(text)) return 0
  let count = 0
  for (const line of await extractFollowUps($, text)) {
    let added: ChecklistItem | undefined
    await update($, checklist, (list: Checklist) => {
      const result = addFollowUp(list, line)
      added = result.added ? result.item : undefined
      return result.list
    })
    if (added === undefined) continue
    count += 1
    queueChange($, { kind: 'followup-added', item: added })
    $.ui.toast(`loose end #${added.id}: ${clip(added.text, 60)}`)
  }
  return count
}

async function bindSession($: EngineInterface): Promise<void> {
  sessionId = await $.session.id()
  const repo = await $.session.repo().catch(() => null)
  project = basename(repo?.root ?? cwd)
  title = ''
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
          const replayed = await replayTranscript($)
          const list = reconcile({ items: saved.items, nextId }, replayed.list)
          await update($, checklist, () => list)
          await update($, summary, () => saved.summary)
          if (lastPrompt === '') lastPrompt = replayed.lastPrompt
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
    // Loose ends mentioned before the mod loaded, anywhere in the conversation.
    await scanTranscript($, messages)
    return 'transcript'
  } catch (error) {
    log($, `seed from transcript failed: ${String(error)}`)
    return 'none'
  }
}

/** The checklist the transcript implies and the last prompt a person typed, or empty when it cannot be read. */
async function replayTranscript($: EngineInterface): Promise<{ list: Checklist; lastPrompt: string }> {
  try {
    const messages = await $.session.messages()
    if ('deny' in messages) return { list: EMPTY_CHECKLIST, lastPrompt: '' }
    const lastUser = [...messages].reverse().find(message => message.role === 'user' && cleanPrompt(message.text) !== '')
    return { list: seedFromTranscript(messages), lastPrompt: cleanPrompt(lastUser?.text ?? '') }
  } catch (error) {
    log($, `transcript replay failed: ${String(error)}`)
    return { list: EMPTY_CHECKLIST, lastPrompt: '' }
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
    description: 'Print the board of all sessions; “prune” removes stale ones, “scan” reads this chat for loose ends',
    argumentHint: '[prune|scan]',
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
  if (stale.length === 0 && !isRemoteConfigured()) return 'cc-board: nothing to prune.'
  // With a shared board, rows older than the stale line may sit behind the read's cap, unseen.
  const question =
    stale.length > 0
      ? `Remove ${stale.length} stale or ended session(s) from the board?`
      : 'Nothing stale is listed. Sweep the shared board for rows older than 24 hours anyway?'
  const answer = await $.ui.ask(question, [stale.length > 0 ? 'Remove' : 'Sweep', 'Keep']).catch(() => 'Keep')
  if (answer === 'Keep') return 'cc-board: kept everything.'
  const before = new Date(now - STALE_AFTER_MS).toISOString()
  if (stale.length === 0) {
    const swept = await deleteRemote($, [], before)
    await refreshBoard($)
    return swept ? 'cc-board: swept the shared board of rows older than 24 hours.' : 'cc-board: the sweep failed, see the debug log.'
  }

  const localPaths = stale
    .map(session => `${session.sessionId}.json`)
    .filter(name => sessions.has(name))
    .map(name => `${boardDir}/${name}`)
  if (localPaths.length > 0) {
    const removed = await $.process.run(['rm', '-f', ...localPaths], { timeoutMs: 5000 })
    if (removed.exitCode !== 0) return `cc-board: rm failed: ${removed.stderr}`
  }
  const remoteIds = stale.map(session => session.sessionId).filter(id => remoteSessions.has(id))
  const remoteOk = await deleteRemote($, remoteIds, before)
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
  return `${itemMark(item)} #${item.id} ${item.text}${sourceTag(item)}`
}

// ---- Hooks ----------------------------------------------------------------

/** Records a changed session title and rewrites the board file so the other sessions see it. */
async function noteTitle($: EngineInterface, fresh: string | undefined): Promise<void> {
  const next = (fresh ?? '').trim()
  if (next === title) return
  title = next
  await writeBoardFile($)
}

/** The sessions the pane and the band list: every one not ended, this one first. */
async function liveSessions($: EngineInterface): Promise<{ rows: BoardSession[]; now: number }> {
  const all = await read($, board)
  const now = await $.clock.now()
  return { rows: sortSessions(all, sessionId).filter(session => session.endedAt === undefined), now }
}

export const register: Register = (on, options) => {
  useHaiku = options.haikuSummary !== false
  useFollowUps = options.followUps !== false
  useAutoDone = options.autoDone !== false
  showBand = options.band === true
  pluginOptions = options

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    try {
      await bindSession($)
      const home = await $.env.get('HOME')
      boardDir = home === undefined || home === '' ? '' : `${home}/.claude/board`
      if (boardDir === '') log($, 'HOME is unset, so no board file is written')
      machine = await detectMachine($)
      tty = await detectTty($)
      sessionUrl = await detectSessionUrl($)
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

  // /clear, /resume and /branch start a new session id without a session.start, so the session is
  // rebound first; only then is the title the event carries written, under the right session id.
  on('classic.SessionStart', async ($, e, next) => {
    try {
      if (e.source === 'clear' || e.source === 'resume' || e.source === 'fork') {
        cwd = await $.session.cwd()
        await bindSession($)
        if (e.source !== 'clear') await restoreChecklist($)
      }
      title = (e.session_title ?? '').trim()
      await writeBoardFile($)
    } catch (error) {
      log($, `rebind failed: ${String(error)}`)
    }
    return next(e)
  })

  // The title rides on every prompt too, so a /rename shows on the next one.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteTitle($, e.session_title)
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
      if (e.reason === 'answer' && e.answer.trim() !== '') {
        const exchange = `User: ${clip(lastPrompt, 2000)}\n\nClaude: ${e.answer}`
        await tickHandled($, exchange)
        await surfaceFollowUps($, exchange)
      }
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
    if (e.args.trim() === 'done') {
      const shown = await update($, showDone, (value: boolean) => !value)
      void $.ui.open({ id: PANE, title: 'cc-board' })
      return { text: shown ? 'cc-board: completed items shown.' : 'cc-board: completed items hidden.' }
    }
    if (e.args.trim() === 'scan') {
      if (!useFollowUps) return { text: 'cc-board: loose-end scans are off (followUps).' }
      try {
        const messages = await $.session.messages()
        if ('deny' in messages) return { text: 'cc-board: the transcript could not be read.' }
        const found = await scanTranscript($, messages)
        void $.ui.open({ id: PANE, title: 'cc-board' })
        return { text: found === 0 ? 'cc-board: no new loose ends in this chat.' : `cc-board: ${found} loose end(s) added from this chat.` }
      } catch (error) {
        return { text: `cc-board: scan failed: ${String(error)}` }
      }
    }
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
    const doneCount = list.items.length - open
    const showingDone = await read($, showDone)
    const shown = showingDone ? list.items : openItems(list.items)
    const { rows, now } = await liveSessions($)

    return (
      <Box flexDirection="column">
        {rows.map(session => (
          <Button
            key={`session-${session.sessionId}`}
            plain
            dimColor={isStale(session, now)}
            label={boardLine(session, session.sessionId === sessionId, now, machine)}
            onPress={press => void switchToSession($, session, press.surface)}
          />
        ))}
        {rows.length > 0 && <Text> </Text>}
        <Text bold>
          {title === '' ? project : title} · {open} open
        </Text>
        {current !== '' && (
          <Text dimColor wrap="truncate-end">
            {current}
          </Text>
        )}
        {list.items.length === 0 && <Text dimColor>No tasks yet. /manual {'<text>'} adds a step of your own.</Text>}
        {shown.map(item => (
          <Button
            key={`item-${item.id}`}
            plain
            dimColor={item.status === 'completed'}
            label={itemLabel(item)}
            onPress={() => void toggleItem($, item.id)}
          />
        ))}
        {doneCount > 0 && (
          <Button
            key="toggle-done"
            plain
            dimColor
            label={showingDone ? `hide ${doneCount} done` : `show ${doneCount} done`}
            onPress={() => void update($, showDone, (value: boolean) => !value)}
          />
        )}
        {list.items.length > 0 && <Text dimColor>Click an item to tick it, or /done {'<id>'}.</Text>}
      </Box>
    )
  })

  // The band is off unless asked for: the pane lists the sessions, and the band takes rows from every prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!showBand || e.props.hasSurvey) return next(e)
    const { rows, now } = await liveSessions($)
    if (rows.length === 0) return next(e)

    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rows.map(session => (
          <Button
            key={`session-${session.sessionId}`}
            plain
            dimColor={isStale(session, now)}
            label={boardLine(session, session.sessionId === sessionId, now, machine)}
            onPress={press => void switchToSession($, session, press.surface)}
          />
        ))}
      </Box>
    )
  })
}
