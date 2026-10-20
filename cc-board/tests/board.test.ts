import { describe, expect, test } from 'claude-code/testing'

import type { BoardSession } from '../types'
import { basename, boardLine, cheapSummary, cleanPrompt, fullBoardText, isLive, isStale, parse, serialize } from '../hooks/board'

const NOW = Date.parse('2026-10-20T12:00:00Z')

const session: BoardSession = {
  sessionId: 'sess-a',
  project: 'my-app',
  cwd: '/Users/me/src/my-app',
  summary: 'Fixing the login crash',
  items: [
    { id: 1, text: 'Fix login', source: 'todo', status: 'in_progress', ticked: false },
    { id: 2, text: 'Rotate key', source: 'manual', status: 'completed', ticked: true },
  ],
  updatedAt: '2026-10-20T11:30:00Z',
}

describe('board files', () => {
  test('serialize then parse gives the same session back', async () => {
    expect(parse(serialize(session))).toEqual(session)
    const ended = { ...session, endedAt: '2026-10-20T11:45:00Z' }
    expect(parse(serialize(ended))).toEqual(ended)
  })

  test('malformed files are skipped, not thrown', async () => {
    expect(parse('')).toBe(undefined)
    expect(parse('{ not json')).toBe(undefined)
    expect(parse('[]')).toBe(undefined)
    expect(parse('{"sessionId":"x"}')).toBe(undefined)
    expect(parse('{"sessionId":"x","project":"p","cwd":"/","updatedAt":"yesterday"}')).toBe(undefined)
  })

  test('bad items inside a good file are dropped', async () => {
    const text = JSON.stringify({ ...session, items: [session.items[0], { id: 'no' }, null, { id: 9, text: 't', source: 'x', status: 'pending' }] })
    expect(parse(text)?.items).toEqual([session.items[0]])
  })

  test('a session is stale after 24 hours without an update', async () => {
    expect(isStale(session, NOW)).toBe(false)
    expect(isStale(session, NOW + 25 * 60 * 60 * 1000)).toBe(true)
    expect(isLive({ ...session, endedAt: '2026-10-20T11:45:00Z' }, NOW)).toBe(false)
  })
})

describe('summary and lines', () => {
  test('the in-progress todo wins, then a pending todo, then the prompt', async () => {
    expect(cheapSummary(session.items, 'please fix things')).toEqual({ text: 'Fix login', fromTask: true })
    const pending = [{ id: 1, text: 'Add tests', source: 'todo' as const, status: 'pending' as const, ticked: false }]
    expect(cheapSummary(pending, 'x').text).toBe('Add tests')
    expect(cheapSummary([], '\n  Rotate the signing key\nmore detail')).toEqual({
      text: 'Rotate the signing key',
      fromTask: false,
    })
  })

  test('injected tags are dropped from a prompt before it is summarized', async () => {
    const prompt = '<artifact-view-context artifact="6e2f">\nsome context\n</artifact-view-context>\n<task-notification>\nok and what about the claude prompt update?'
    expect(cleanPrompt(prompt)).toBe('ok and what about the claude prompt update?')
    expect(cleanPrompt('<task-notification>\n<status>done</status>\n</task-notification>')).toBe('')
    expect(cheapSummary([], prompt).text).toBe('ok and what about the claude prompt update?')
  })

  test('the band line marks the current session and counts open items', async () => {
    expect(boardLine(session, true, NOW)).toBe('▶ my-app · Fixing the login crash · 1 open')
    expect(boardLine({ ...session, summary: '' }, false, NOW)).toBe('  my-app · — · 1 open')
    const old = { ...session, updatedAt: '2026-10-17T11:30:00Z' }
    expect(boardLine(old, false, NOW)).toBe('  my-app · Fixing the login crash · 1 open · stale 3d')
  })

  test('the full board lists open items and the resume command', async () => {
    const text = fullBoardText([session], 'sess-a', NOW)
    expect(text).toContain('[>] #1 Fix login')
    expect(text).not.toContain('#2 Rotate key')
    expect(text).toContain('claude --resume sess-a')
    expect(text).toContain('(this session)')
    expect(fullBoardText([], 'sess-a', NOW)).toContain('no sessions')
  })

  test('basename handles trailing slashes', async () => {
    expect(basename('/Users/me/src/my-app/')).toBe('my-app')
    expect(basename('my-app')).toBe('my-app')
  })
})
