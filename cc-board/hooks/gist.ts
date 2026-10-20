// Pure helpers for the shared board in a GitHub gist: one secret gist, one
// file per session named <session-id>.json. No engine access.
import type { BoardSession } from '../types'
import { parse } from './board'

export const GIST_API = 'https://api.github.com/gists'

export function gistUrl(gistId: string): string {
  return `${GIST_API}/${encodeURIComponent(gistId)}`
}

export function gistFileName(sessionId: string): string {
  return `${sessionId}.json`
}

export function gistHeaders(token: string, etag?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cc-board',
  }
  if (etag !== undefined && etag !== '') headers['if-none-match'] = etag
  return headers
}

/** The body of a PATCH that writes or, with null, deletes the named files. Other files are untouched. */
export function gistPatchBody(files: Record<string, string | null>): string {
  const entries: Record<string, { content: string } | null> = {}
  for (const [name, content] of Object.entries(files)) entries[name] = content === null ? null : { content }
  return JSON.stringify({ files: entries })
}

/**
 * The sessions a gist holds, read from a GET's body. A file that is not a
 * board session, or that GitHub truncated, is skipped.
 */
export function parseGistFiles(text: string): BoardSession[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  const files = (raw as { files?: unknown }).files
  if (typeof files !== 'object' || files === null) return []

  const sessions: BoardSession[] = []
  for (const file of Object.values(files as Record<string, unknown>)) {
    if (typeof file !== 'object' || file === null) continue
    const { content, truncated } = file as { content?: unknown; truncated?: unknown }
    if (truncated === true || typeof content !== 'string') continue
    const session = parse(content)
    if (session !== undefined) sessions.push(session)
  }
  return sessions
}
