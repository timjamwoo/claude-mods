// Pure board logic: the file shape, the stale rule and the text the band and
// /board print. No engine access.
import type { BoardSession, ChecklistItem, ItemStatus } from '../types'
import { openItems } from './checklist'

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export function fileFor(dir: string, sessionId: string): string {
  return `${dir}/${sessionId}.json`
}

export function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
}

export function serialize(session: BoardSession): string {
  return JSON.stringify(session, null, 2) + '\n'
}

const STATUSES: readonly ItemStatus[] = ['pending', 'in_progress', 'completed']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseItem(value: unknown): ChecklistItem | undefined {
  if (!isRecord(value)) return undefined
  const { id, text, source, status, ticked, taskId } = value
  if (typeof id !== 'number' || typeof text !== 'string') return undefined
  if (source !== 'todo' && source !== 'manual') return undefined
  if (!STATUSES.includes(status as ItemStatus)) return undefined
  const item: ChecklistItem = { id, text, source, status: status as ItemStatus, ticked: ticked === true }
  if (typeof taskId === 'string' && taskId !== '') item.taskId = taskId
  return item
}

/**
 * Reads one board file. Returns undefined for anything that is not a board
 * session, so a malformed file is skipped instead of breaking the board.
 */
export function parse(text: string): BoardSession | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const { sessionId, project, cwd, summary, items, updatedAt, endedAt, machine } = raw
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  if (typeof project !== 'string' || typeof cwd !== 'string') return undefined
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) return undefined

  const session: BoardSession = {
    sessionId,
    project,
    cwd,
    summary: typeof summary === 'string' ? summary : '',
    items: Array.isArray(items) ? items.map(parseItem).filter((item): item is ChecklistItem => item !== undefined) : [],
    updatedAt,
  }
  if (typeof endedAt === 'string') session.endedAt = endedAt
  if (typeof machine === 'string' && machine !== '') session.machine = machine
  return session
}

/**
 * Local files and the shared gist, one entry per session id: when both hold
 * a session, the newer `updatedAt` wins.
 */
export function mergeSessions(local: readonly BoardSession[], remote: readonly BoardSession[]): BoardSession[] {
  const byId = new Map<string, BoardSession>()
  for (const session of [...remote, ...local]) {
    const known = byId.get(session.sessionId)
    if (known === undefined || Date.parse(session.updatedAt) >= Date.parse(known.updatedAt)) byId.set(session.sessionId, session)
  }
  return [...byId.values()]
}

export function isStale(session: BoardSession, nowMs: number): boolean {
  const updated = Date.parse(session.updatedAt)
  return Number.isNaN(updated) || nowMs - updated > STALE_AFTER_MS
}

/** A session that still shows on the live board: not ended, not stale. */
export function isLive(session: BoardSession, nowMs: number): boolean {
  return session.endedAt === undefined && !isStale(session, nowMs)
}

/**
 * A prompt as a person wrote it: the tagged blocks Claude Code injects
 * (`<task-notification>`, `<artifact-view-context ...>` and the like) and
 * any line that is only a tag are dropped.
 */
export function cleanPrompt(text: string): string {
  const withoutBlocks = text.replace(/<([a-zA-Z][\w-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g, '\n')
  return withoutBlocks
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !/^<[^>]*>$/.test(line))
    .join('\n')
}

/**
 * The cheap summary: the in-progress task first, then the first pending one,
 * then the start of the last prompt. `fromTask` says whether the task list
 * gave an answer, so the caller knows when a model call might help.
 */
export function cheapSummary(
  items: readonly ChecklistItem[],
  lastPrompt: string,
): { text: string; fromTask: boolean } {
  const tasks = items.filter(item => item.source === 'todo')
  const active = tasks.find(item => item.status === 'in_progress') ?? tasks.find(item => item.status === 'pending')
  if (active !== undefined) return { text: clip(active.text, 100), fromTask: true }
  const firstLine = cleanPrompt(lastPrompt).split('\n')[0] ?? ''
  return { text: clip(firstLine, 100), fromTask: false }
}

function age(session: BoardSession, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(session.updatedAt))
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * One band line: a marker, the project, the summary and the open count. A
 * session on another machine than `homeMachine` is tagged with its machine.
 */
export function boardLine(session: BoardSession, isCurrent: boolean, nowMs: number, homeMachine?: string): string {
  const open = openItems(session.items).length
  const marker = isCurrent ? '▶' : ' '
  const summary = session.summary === '' ? '—' : session.summary
  const where = session.machine !== undefined && session.machine !== homeMachine ? ` · @${session.machine}` : ''
  const stale = isStale(session, nowMs) ? ` · stale ${age(session, nowMs)}` : ''
  return `${marker} ${session.project} · ${summary} · ${open} open${where}${stale}`
}

/** Current session first, then the rest by most recent update. */
export function sortSessions(sessions: readonly BoardSession[], currentId: string): BoardSession[] {
  return [...sessions].sort((a, b) => {
    if (a.sessionId === currentId) return -1
    if (b.sessionId === currentId) return 1
    return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  })
}

function mark(item: ChecklistItem): string {
  if (item.status === 'completed') return '[x]'
  if (item.status === 'in_progress') return '[>]'
  return '[ ]'
}

/** What /board prints: every session, its open items and how to resume it. */
export function fullBoardText(sessions: readonly BoardSession[], currentId: string, nowMs: number, homeMachine?: string): string {
  if (sessions.length === 0) return 'cc-board: no sessions on the board yet.'
  const lines: string[] = [`cc-board · ${sessions.length} session(s)`, '']
  for (const session of sortSessions(sessions, currentId)) {
    const flags: string[] = []
    if (session.sessionId === currentId) flags.push('this session')
    if (session.endedAt !== undefined) flags.push('ended')
    else if (isStale(session, nowMs)) flags.push(`stale, ${age(session, nowMs)}`)
    const suffix = flags.length > 0 ? `  (${flags.join(', ')})` : ''
    lines.push(boardLine(session, session.sessionId === currentId, nowMs, homeMachine).trimStart() + suffix)
    for (const item of openItems(session.items)) {
      const source = item.source === 'manual' ? ' (manual)' : ''
      lines.push(`    ${mark(item)} #${item.id} ${item.text}${source}`)
    }
    lines.push(`    cwd: ${session.cwd}`)
    const elsewhere = session.machine !== undefined && session.machine !== homeMachine ? `  (on ${session.machine})` : ''
    lines.push(`    resume: cd ${session.cwd} && claude --resume ${session.sessionId}${elsewhere}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
