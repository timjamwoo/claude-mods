// Pure helpers for the shared board in a Supabase table: one row per session
// in `cc_board`, reached through the project's REST API. No engine access.
import type { BoardSession } from '../types'
import { clip, parseValue } from './board'
import { openItems } from './checklist'

export const TABLE = 'cc_board'

export function tableUrl(projectUrl: string): string {
  return `${projectUrl.replace(/\/+$/, '')}/rest/v1/${TABLE}`
}

/** How many sessions one read brings back, newest first. Older rows are stale by then and prune removes them by time. */
export const READ_LIMIT = 500

/** The query that reads the newest rows' documents, or with `sinceIso`, only the rows written after that moment. */
export function readUrl(projectUrl: string, sinceIso?: string): string {
  const since = sinceIso === undefined ? '' : `&updated_at=gt.${encodeURIComponent(sinceIso)}`
  return `${tableUrl(projectUrl)}?select=payload&order=updated_at.desc&limit=${READ_LIMIT}${since}`
}

/**
 * The row other sessions need: open items only, each clipped, since the board
 * shows other sessions' open work and nothing else. Keeps the table small and
 * every read cheap; the local file keeps the whole list.
 */
export function slimSession(session: BoardSession): BoardSession {
  return { ...session, items: openItems(session.items).map(item => ({ ...item, text: clip(item.text, 100) })) }
}

/** The query that deletes every row last updated before `beforeIso`, whether a read returned it or not. */
export function deleteBeforeUrl(projectUrl: string, beforeIso: string): string {
  return `${tableUrl(projectUrl)}?updated_at=lt.${encodeURIComponent(beforeIso)}`
}

/** The query that deletes the named sessions' rows. */
export function deleteUrl(projectUrl: string, sessionIds: readonly string[]): string {
  const list = sessionIds.map(id => `"${id.replace(/"/g, '')}"`).join(',')
  return `${tableUrl(projectUrl)}?session_id=in.(${encodeURIComponent(list)})`
}

export function sharedHeaders(key: string): Record<string, string> {
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    accept: 'application/json',
  }
}

/** Headers for an upsert: a row that exists is replaced, nothing is echoed back. */
export function upsertHeaders(key: string): Record<string, string> {
  return { ...sharedHeaders(key), prefer: 'resolution=merge-duplicates,return=minimal' }
}

/** The body of an upsert of this session's row. */
export function upsertBody(session: BoardSession): string {
  return JSON.stringify([{ session_id: session.sessionId, payload: session, updated_at: session.updatedAt }])
}

/** The sessions a read answered. A row whose payload is not a board session is skipped. */
export function parseRows(text: string): BoardSession[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const sessions: BoardSession[] = []
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue
    const session = parseValue((row as { payload?: unknown }).payload)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}
