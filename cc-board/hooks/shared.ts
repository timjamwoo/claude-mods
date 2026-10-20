// Pure helpers for the shared board in a Supabase table: one row per session
// in `cc_board`, reached through the project's REST API. No engine access.
import type { BoardSession } from '../types'
import { parseValue } from './board'

export const TABLE = 'cc_board'

export function tableUrl(projectUrl: string): string {
  return `${projectUrl.replace(/\/+$/, '')}/rest/v1/${TABLE}`
}

/** The query that reads every row's document. */
export function readUrl(projectUrl: string): string {
  return `${tableUrl(projectUrl)}?select=payload`
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
